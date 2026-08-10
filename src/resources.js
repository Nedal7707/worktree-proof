/**
 * Bounded, read-only resource diagnostics for WorktreeProof.
 *
 * The module intentionally uses only Node.js built-ins.  Probes are injected
 * through `scanResources` options so callers can test platform-specific
 * branches without changing host state or reading file contents.
 */

import * as nodeOs from 'node:os';
import * as nodeProcess from 'node:process';
import nodePath from 'node:path';
import { promises as nodeFs } from 'node:fs';

const BYTES_PER_GIB = 1024 ** 3;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 4096;
const PROFILE_NAMES = ['low-resource', 'balanced', 'fast', 'ci'];
// A request is not a promise. The host/runtime ceiling and measured resource
// capacity remain authoritative and may reduce the effective value to zero.
export const DEFAULT_REQUESTED_CONCURRENCY = 8;
export const MAX_REQUESTED_CONCURRENCY = 24;
export const POLICY_GOAL_CONCURRENCY = MAX_REQUESTED_CONCURRENCY;
// Backward-compatible name from the v0.1 preview. It now means the package's
// maximum accepted request, not a universal machine or runtime capacity.
export const PUBLIC_MAX_CONCURRENCY = MAX_REQUESTED_CONCURRENCY;

const DIRECTORY_GROUPS = Object.freeze({
  worktree: new Set(['worktree', 'worktrees', '.worktree', '.worktrees', '_worktrees']),
  build: new Set(['build', 'dist', 'out', 'target', 'coverage', 'artifacts', '.next']),
  cache: new Set(['cache', '.cache', 'caches', 'tmp-cache', 'npm-cache']),
});

/**
 * Stable defaults used by profile selection.  Returned profiles are cloned so
 * callers cannot mutate this module's policy.
 */
export const RESOURCE_PROFILES = Object.freeze({
  'low-resource': Object.freeze({
    name: 'low-resource',
    maxConcurrency: 1,
    memoryPerWorkerBytes: 256 * 1024 ** 2,
    cacheMode: 'minimal',
    artifactPolicy: 'stream-and-discard',
    diskReserveRatio: 0.2,
    cpuUtilization: 0.5,
  }),
  balanced: Object.freeze({
    name: 'balanced',
    maxConcurrency: 4,
    memoryPerWorkerBytes: 512 * 1024 ** 2,
    cacheMode: 'bounded',
    artifactPolicy: 'retain-required',
    diskReserveRatio: 0.1,
    cpuUtilization: 0.75,
  }),
  fast: Object.freeze({
    name: 'fast',
    maxConcurrency: MAX_REQUESTED_CONCURRENCY,
    memoryPerWorkerBytes: 768 * 1024 ** 2,
    cacheMode: 'reuse-with-cap',
    artifactPolicy: 'retain-required',
    diskReserveRatio: 0.05,
    cpuUtilization: 1,
  }),
  ci: Object.freeze({
    name: 'ci',
    maxConcurrency: 8,
    memoryPerWorkerBytes: 512 * 1024 ** 2,
    cacheMode: 'deterministic-bounded',
    artifactPolicy: 'retain-evidence-only',
    diskReserveRatio: 0.15,
    cpuUtilization: 0.8,
  }),
});

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function clampRatio(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(1, number));
}

function valueFrom(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function invokeMaybe(source, key) {
  try {
    const value = source?.[key];
    return typeof value === 'function' ? value.call(source) : value;
  } catch {
    return undefined;
  }
}

function sourceLabel(explicit, fallback) {
  return explicit ? 'injected' : fallback;
}

function normalizePlatform(options, osImpl) {
  const osPlatform = typeof osImpl?.platform === 'function' ? invokeMaybe(osImpl, 'platform') : osImpl?.platform;
  return String(options.platform ?? osPlatform ?? nodeProcess.platform);
}

function normalizeLoadAverage(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => finiteNumber(item));
  }
  if (value && typeof value === 'object') {
    return [value.oneMinute ?? value.one ?? value.load1m, value.fiveMinute ?? value.five ?? value.load5m, value.fifteenMinute ?? value.fifteen ?? value.load15m]
      .map((item) => finiteNumber(item));
  }
  const number = finiteNumber(value);
  return number === null ? [] : [number];
}

function collectCpu(options, osImpl) {
  const explicit = options.cpu ?? options.cpuMetrics;
  let logicalCount = finiteNumber(valueFrom(explicit, ['logicalCount', 'logical', 'count']));
  let source = explicit ? 'injected' : 'os';
  if (logicalCount === null) {
    try {
      const cpus = invokeMaybe(osImpl, 'cpus');
      logicalCount = Array.isArray(cpus) ? cpus.length : null;
    } catch {
      logicalCount = null;
    }
  }
  if (!Number.isInteger(logicalCount) || logicalCount <= 0) logicalCount = null;

  let rawLoad = valueFrom(explicit, ['loadAverage', 'load', 'loadavg']);
  if (rawLoad === undefined) rawLoad = invokeMaybe(osImpl, 'loadavg');
  const loadAverage = normalizeLoadAverage(rawLoad);
  const platform = normalizePlatform(options, osImpl).toLowerCase();
  // Windows commonly reports [0, 0, 0] from os.loadavg(). Treat that as an
  // unavailable signal rather than evidence that the host is idle.
  if (!explicit && platform === 'win32' && loadAverage.length > 0 && loadAverage.every((item) => item === 0)) {
    loadAverage.length = 0;
  }
  const load = loadAverage[0] ?? null;
  const normalizedLoad = load !== null && logicalCount ? load / logicalCount : null;
  const available = logicalCount !== null || loadAverage.some((item) => item !== null);
  if (explicit) source = 'injected';
  return {
    logicalCount,
    logicalCpus: logicalCount,
    load,
    loadAverage,
    load1m: loadAverage[0] ?? null,
    load5m: loadAverage[1] ?? null,
    load15m: loadAverage[2] ?? null,
    normalizedLoad,
    loadAvailable: load !== null,
    available,
    source: available ? source : 'unavailable',
  };
}

function collectMemory(options, osImpl) {
  const explicit = options.memory ?? options.ram ?? options.systemMemory ?? options.memoryMetrics;
  let totalBytes = nonNegativeNumber(valueFrom(explicit, ['totalBytes', 'total', 'totalmem']));
  let freeBytes = nonNegativeNumber(valueFrom(explicit, ['freeBytes', 'free', 'freemem', 'availableBytes', 'available']));
  let pressureRatio = clampRatio(valueFrom(explicit, ['pressureRatio', 'pressure', 'usedRatio']));

  if (totalBytes === null) totalBytes = nonNegativeNumber(invokeMaybe(osImpl, 'totalmem'));
  if (freeBytes === null) freeBytes = nonNegativeNumber(invokeMaybe(osImpl, 'freemem'));
  if (pressureRatio === null && totalBytes !== null && totalBytes > 0 && freeBytes !== null) {
    pressureRatio = clampRatio((totalBytes - freeBytes) / totalBytes);
  }
  const usedBytes = totalBytes !== null && freeBytes !== null ? Math.max(0, totalBytes - freeBytes) : null;
  const freeRatio = totalBytes !== null && totalBytes > 0 && freeBytes !== null ? clampRatio(freeBytes / totalBytes) : null;
  const available = totalBytes !== null || freeBytes !== null || pressureRatio !== null;
  return {
    totalBytes,
    total: totalBytes,
    freeBytes,
    free: freeBytes,
    availableBytes: freeBytes,
    usedBytes,
    pressureRatio,
    freeRatio,
    available,
    source: available ? sourceLabel(explicit, 'os') : 'unavailable',
  };
}

function collectNodeMemory(options) {
  const explicit = options.nodeMemory ?? options.node ?? options.processMemory ?? options.processMemoryUsage ?? options.memoryUsage;
  let raw = explicit;
  if (typeof raw === 'function') {
    try {
      raw = raw();
    } catch {
      raw = undefined;
    }
  }
  if (raw === undefined) {
    try {
      raw = nodeProcess.memoryUsage();
    } catch {
      raw = undefined;
    }
  }
  const rssBytes = nonNegativeNumber(valueFrom(raw, ['rssBytes', 'rss']));
  const heapTotalBytes = nonNegativeNumber(valueFrom(raw, ['heapTotalBytes', 'heapTotal']));
  const heapUsedBytes = nonNegativeNumber(valueFrom(raw, ['heapUsedBytes', 'heapUsed']));
  const externalBytes = nonNegativeNumber(valueFrom(raw, ['externalBytes', 'external']));
  const arrayBuffersBytes = nonNegativeNumber(valueFrom(raw, ['arrayBuffersBytes', 'arrayBuffers']));
  const heapPressureRatio = heapTotalBytes !== null && heapTotalBytes > 0 && heapUsedBytes !== null
    ? clampRatio(heapUsedBytes / heapTotalBytes)
    : null;
  const available = [rssBytes, heapTotalBytes, heapUsedBytes, externalBytes, arrayBuffersBytes].some((item) => item !== null);
  return {
    rssBytes,
    rss: rssBytes,
    heapTotalBytes,
    heapTotal: heapTotalBytes,
    heapUsedBytes,
    heapUsed: heapUsedBytes,
    externalBytes,
    arrayBuffersBytes,
    heapPressureRatio,
    available,
    source: available ? (explicit ? 'injected' : 'process') : 'unavailable',
  };
}

function normalizeDiskValues(raw) {
  if (!raw || typeof raw !== 'object') return {};
  let totalBytes = nonNegativeNumber(valueFrom(raw, ['totalBytes', 'total', 'capacityBytes', 'capacity']));
  let freeBytes = nonNegativeNumber(valueFrom(raw, ['freeBytes', 'free', 'availableBytes', 'available']));
  if (totalBytes === null && finiteNumber(raw.blocks) !== null) {
    const unit = finiteNumber(raw.frsize) ?? finiteNumber(raw.bsize) ?? 1;
    totalBytes = nonNegativeNumber(raw.blocks * unit);
  }
  if (freeBytes === null && finiteNumber(raw.bavail) !== null) {
    const unit = finiteNumber(raw.frsize) ?? finiteNumber(raw.bsize) ?? 1;
    freeBytes = nonNegativeNumber(raw.bavail * unit);
  }
  if (freeBytes === null && finiteNumber(raw.bfree) !== null) {
    const unit = finiteNumber(raw.frsize) ?? finiteNumber(raw.bsize) ?? 1;
    freeBytes = nonNegativeNumber(raw.bfree * unit);
  }
  const pressureRatio = clampRatio(valueFrom(raw, ['pressureRatio', 'pressure', 'usedRatio']))
    ?? (totalBytes !== null && totalBytes > 0 && freeBytes !== null ? clampRatio((totalBytes - freeBytes) / totalBytes) : null);
  return { totalBytes, freeBytes, pressureRatio };
}

async function collectDisk(options, repoPath, fsImpl) {
  const explicit = options.disk ?? options.diskMetrics ?? options.diskUsage;
  let raw;
  let source = explicit ? 'injected' : 'statfs';
  if (typeof explicit === 'function') {
    try {
      raw = await explicit(repoPath);
    } catch {
      raw = undefined;
    }
  } else if (explicit && typeof explicit === 'object') {
    raw = explicit;
  }
  if (raw === undefined) {
    const statfs = fsImpl?.statfs;
    if (typeof statfs === 'function') {
      try {
        raw = await statfs.call(fsImpl, repoPath);
      } catch {
        raw = undefined;
      }
    }
  }
  const values = normalizeDiskValues(raw);
  const available = values.totalBytes !== null || values.freeBytes !== null || values.pressureRatio !== null;
  const volumeRoot = typeof options.volumeRoot === 'string' && options.volumeRoot.trim() ? nodePath.resolve(options.volumeRoot) : nodePath.parse(repoPath).root;
  return {
    path: repoPath,
    volumeRoot,
    totalBytes: values.totalBytes,
    total: values.totalBytes,
    freeBytes: values.freeBytes,
    free: values.freeBytes,
    availableBytes: values.freeBytes,
    usedBytes: values.totalBytes !== null && values.freeBytes !== null ? Math.max(0, values.totalBytes - values.freeBytes) : null,
    pressureRatio: values.pressureRatio,
    freeRatio: values.totalBytes !== null && values.totalBytes > 0 && values.freeBytes !== null ? clampRatio(values.freeBytes / values.totalBytes) : null,
    available,
    source: available ? source : 'unavailable',
  };
}

function emptyMetric(pathValue, limits) {
  return {
    path: pathValue,
    present: false,
    bytes: 0,
    files: 0,
    directories: 0,
    entries: 0,
    scannedEntries: 0,
    status: 'ok',
    bounded: true,
    maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries,
    truncated: false,
    blockedPaths: [],
    unreadablePaths: [],
    escapingPaths: [],
    symlinkPaths: [],
    errors: [],
  };
}

function classifyRelative(relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  const lower = segments.map((segment) => segment.toLowerCase());
  if (lower.length === 0) return 'repo';
  if ((lower[0] === '.git' && lower[1] === 'worktrees') || lower.some((segment) => DIRECTORY_GROUPS.worktree.has(segment))) return 'worktree';
  if (lower[0] === '.git' || lower.includes('.git')) return 'git';
  if (lower.some((segment) => DIRECTORY_GROUPS.build.has(segment))) return 'build';
  if (lower.some((segment) => DIRECTORY_GROUPS.cache.has(segment))) return 'cache';
  return 'repo';
}

function markBlocked(metric, kind, candidate, error) {
  metric.status = 'blocked';
  const bucket = kind === 'symlink' ? 'symlinkPaths' : kind === 'escape' ? 'escapingPaths' : 'unreadablePaths';
  if (!metric[bucket].includes(candidate)) metric[bucket].push(candidate);
  if (error) metric.errors.push({ code: error.code ?? 'EIO', message: String(error.message ?? error) });
}

function setPartial(metric) {
  metric.truncated = true;
  if (metric.status === 'ok') metric.status = 'partial';
}

function isContained(root, candidate) {
  const relative = nodePath.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}

function statIsSymbolicLink(stat, dirent) {
  return Boolean(dirent?.isSymbolicLink?.() || stat?.isSymbolicLink?.() || stat?.type === 'symlink' || stat?.symbolicLink === true);
}

function statIsDirectory(stat, dirent) {
  return Boolean(dirent?.isDirectory?.() || stat?.isDirectory?.() || stat?.type === 'directory' || stat?.directory === true);
}

function statIsFile(stat, dirent) {
  return Boolean(dirent?.isFile?.() || stat?.isFile?.() || stat?.type === 'file' || stat?.file === true || (!statIsDirectory(stat, dirent) && !statIsSymbolicLink(stat, dirent) && finiteNumber(stat?.size) !== null));
}

async function scanFootprint(repoPath, options, fsImpl) {
  const limits = {
    maxDepth: positiveInteger(options.maxDepth ?? options.limits?.maxDepth ?? options.traversal?.maxDepth, DEFAULT_MAX_DEPTH),
    maxEntries: positiveInteger(options.maxEntries ?? options.limits?.maxEntries ?? options.traversal?.maxEntries, DEFAULT_MAX_ENTRIES),
  };
  const categories = {};
  for (const name of ['repo', 'git', 'worktree', 'build', 'cache']) categories[name] = emptyMetric(repoPath, limits);
  categories.repo.path = repoPath;
  categories.git.path = nodePath.join(repoPath, '.git');
  categories.worktree.path = nodePath.join(repoPath, '.git', 'worktrees');
  categories.build.path = nodePath.join(repoPath, 'build');
  categories.cache.path = nodePath.join(repoPath, '.cache');

  const global = {
    path: repoPath,
    bytes: 0,
    files: 0,
    directories: 0,
    entries: 0,
    scannedEntries: 0,
    status: 'ok',
    bounded: true,
    maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries,
    truncated: false,
    blockedPaths: [],
    unreadablePaths: [],
    escapingPaths: [],
    symlinkPaths: [],
    errors: [],
  };

  const lstat = fsImpl?.lstat;
  const readdir = fsImpl?.readdir;
  if (typeof lstat !== 'function' || typeof readdir !== 'function') {
    global.status = 'unavailable';
    global.errors.push({ code: 'ERR_FS_PROBE_UNAVAILABLE', message: 'lstat and readdir are required for footprint diagnostics' });
    for (const metric of Object.values(categories)) metric.status = 'unavailable';
    return { ...global, totalBytes: global.bytes, repoBytes: global.bytes, categories, repo: categories.repo, git: categories.git, worktree: categories.worktree, worktrees: categories.worktree, build: categories.build, builds: categories.build, cache: categories.cache, caches: categories.cache };
  }

  const root = nodePath.resolve(repoPath);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    global.status = 'blocked';
    markBlocked(global, 'unreadable', root, error);
    for (const metric of Object.values(categories)) {
      metric.status = 'blocked';
      markBlocked(metric, 'unreadable', root, error);
    }
    return { ...global, totalBytes: global.bytes, repoBytes: global.bytes, categories, repo: categories.repo, git: categories.git, worktree: categories.worktree, worktrees: categories.worktree, build: categories.build, builds: categories.build, cache: categories.cache, caches: categories.cache };
  }
  if (statIsSymbolicLink(rootStat)) {
    global.status = 'blocked';
    markBlocked(global, 'symlink', root);
    for (const metric of Object.values(categories)) {
      metric.status = 'blocked';
      markBlocked(metric, 'symlink', root);
    }
    return { ...global, totalBytes: global.bytes, repoBytes: global.bytes, categories, repo: categories.repo, git: categories.git, worktree: categories.worktree, worktrees: categories.worktree, build: categories.build, builds: categories.build, cache: categories.cache, caches: categories.cache };
  }
  if (!statIsDirectory(rootStat)) {
    global.status = 'blocked';
    markBlocked(global, 'unreadable', root, { code: 'ENOTDIR', message: 'repoPath is not a directory' });
    for (const metric of Object.values(categories)) metric.status = 'blocked';
    return { ...global, totalBytes: global.bytes, repoBytes: global.bytes, categories, repo: categories.repo, git: categories.git, worktree: categories.worktree, worktrees: categories.worktree, build: categories.build, builds: categories.build, cache: categories.cache, caches: categories.cache };
  }

  const queue = [{ path: root, depth: 0, category: 'repo' }];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
      if (!Array.isArray(entries)) throw Object.assign(new Error('readdir did not return an array'), { code: 'ERR_INVALID_READDIR' });
    } catch (error) {
      markBlocked(global, 'unreadable', current.path, error);
      markBlocked(categories[current.category], 'unreadable', current.path, error);
      continue;
    }
    for (const entry of entries) {
      if (global.scannedEntries >= limits.maxEntries) {
        global.truncated = true;
        setPartial(global);
        setPartial(categories[current.category]);
        break;
      }
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof name !== 'string' || !name || name === '.' || name === '..') {
        markBlocked(global, 'unreadable', current.path, { code: 'ERR_INVALID_ENTRY', message: 'directory entry has no safe name' });
        markBlocked(categories[current.category], 'unreadable', current.path, { code: 'ERR_INVALID_ENTRY', message: 'directory entry has no safe name' });
        continue;
      }
      const candidate = nodePath.resolve(current.path, name);
      if (!isContained(root, candidate)) {
        markBlocked(global, 'escape', candidate, { code: 'ERR_PATH_ESCAPE', message: 'entry escaped the repository root' });
        markBlocked(categories[current.category], 'escape', candidate, { code: 'ERR_PATH_ESCAPE', message: 'entry escaped the repository root' });
        continue;
      }
      global.scannedEntries += 1;
      global.entries += 1;
      let stat;
      try {
        stat = await lstat(candidate);
      } catch (error) {
        markBlocked(global, 'unreadable', candidate, error);
        markBlocked(categories[current.category], 'unreadable', candidate, error);
        continue;
      }
      const relative = nodePath.relative(root, candidate);
      const categoryName = classifyRelative(relative);
      const metric = categories[categoryName] ?? categories.repo;
      if (statIsSymbolicLink(stat, entry)) {
        markBlocked(global, 'symlink', candidate);
        markBlocked(metric, 'symlink', candidate);
        continue;
      }
      metric.present = true;
      metric.entries += 1;
      if (statIsDirectory(stat, entry)) {
        global.directories += 1;
        metric.directories += 1;
        if (current.depth >= limits.maxDepth) {
          setPartial(global);
          setPartial(metric);
          continue;
        }
        queue.push({ path: candidate, depth: current.depth + 1, category: categoryName });
      } else if (statIsFile(stat, entry)) {
        const size = nonNegativeNumber(stat.size) ?? 0;
        global.files += 1;
        global.bytes += size;
        global.scannedEntries += 0;
        metric.files += 1;
        metric.bytes += size;
      } else {
        markBlocked(global, 'unreadable', candidate, { code: 'ERR_UNKNOWN_FILE_TYPE', message: 'entry type could not be determined' });
        markBlocked(metric, 'unreadable', candidate, { code: 'ERR_UNKNOWN_FILE_TYPE', message: 'entry type could not be determined' });
      }
    }
  }
  // Every metric uses the global traversal count for a transparent bound.  A
  // category's own count remains useful for inventory and is not an excuse to
  // walk past the repository limit.
  for (const metric of Object.values(categories)) {
    metric.scannedEntries = global.scannedEntries;
    if (global.truncated && metric.status === 'ok') metric.status = 'partial';
    if (global.status === 'blocked' && metric.status === 'ok') metric.status = 'blocked';
  }
  return { ...global, totalBytes: global.bytes, repoBytes: global.bytes, categories, repo: categories.repo, git: categories.git, worktree: categories.worktree, worktrees: categories.worktree, build: categories.build, builds: categories.build, cache: categories.cache, caches: categories.cache };
}

function collectConcurrency(options) {
  const explicit = options.concurrency ?? options.currentConcurrency ?? options.activeConcurrency ?? options.activeLanes;
  let current = null;
  let source = 'unknown';
  if (typeof explicit === 'function') {
    try {
      return collectConcurrency({ ...options, concurrency: explicit() });
    } catch {
      return { current: null, active: null, available: false, source: 'unavailable' };
    }
  }
  if (typeof explicit === 'number') {
    current = Number.isFinite(explicit) && explicit >= 0 ? Math.floor(explicit) : null;
    source = current === null ? 'unavailable' : 'injected';
  } else if (Array.isArray(explicit)) {
    current = explicit.length;
    source = 'injected';
  } else if (explicit && typeof explicit === 'object') {
    const value = finiteNumber(valueFrom(explicit, ['current', 'active', 'running', 'count']));
    current = value !== null && value >= 0 ? Math.floor(value) : null;
    source = current === null ? 'unavailable' : 'injected';
  }
  if (current === null) {
    const envValue = nodeProcess.env.WORKTREE_PROOF_ACTIVE_LANES ?? nodeProcess.env.WORKTREE_PROOF_CONCURRENCY;
    const parsed = Number(envValue);
    if (envValue !== undefined && Number.isFinite(parsed) && parsed >= 0) {
      current = Math.floor(parsed);
      source = 'environment';
    }
  }
  return {
    current,
    active: current,
    available: current !== null,
    source: current === null ? 'unavailable' : source,
  };
}

function asScanObject(scan) {
  return scan && typeof scan === 'object' ? scan : {};
}

function profileName(requested) {
  let value = requested;
  if (value && typeof value === 'object') value = value.name ?? value.profile ?? value.mode;
  if (value === undefined || value === null || value === '' || value === 'auto') return null;
  const normalized = String(value).trim().toLowerCase().replaceAll('_', '-');
  const aliases = {
    low: 'low-resource',
    lowmemory: 'low-resource',
    'low-memory': 'low-resource',
    standard: 'balanced',
    quick: 'fast',
    continuous: 'ci',
  };
  return aliases[normalized] ?? normalized;
}

function automaticProfileName(scan) {
  const cpuLoad = finiteNumber(scan?.cpu?.normalizedLoad);
  const ramPressure = clampRatio(scan?.memory?.pressureRatio ?? scan?.ram?.pressureRatio);
  const diskPressure = clampRatio(scan?.disk?.pressureRatio);
  const lowRam = (scan?.memory?.freeBytes !== null && scan?.memory?.freeBytes !== undefined && scan.memory.freeBytes < BYTES_PER_GIB)
    || (ramPressure !== null && ramPressure >= 0.9);
  const lowDisk = diskPressure !== null && diskPressure >= 0.9;
  if (lowRam || lowDisk) return 'low-resource';
  if (cpuLoad !== null && cpuLoad > 1.25) return 'balanced';
  if (cpuLoad !== null && cpuLoad < 0.5 && (ramPressure === null || ramPressure < 0.7)) return 'fast';
  return 'balanced';
}

/**
 * Select a bounded execution profile.  Unknown explicit names fail closed
 * with a TypeError rather than silently opting into a more aggressive mode.
 */
export function chooseResourceProfile(scan, requested) {
  const normalizedScan = asScanObject(scan);
  const explicitName = profileName(requested);
  const name = explicitName ?? automaticProfileName(normalizedScan);
  if (!PROFILE_NAMES.includes(name)) throw new TypeError(`unknown resource profile: ${name}`);
  const base = RESOURCE_PROFILES[name];
  const recommended = recommendConcurrency(normalizedScan, {
    profile: name,
    kind: name === 'fast' ? 'cpu' : name === 'ci' ? 'ci' : 'balanced',
    requested: DEFAULT_REQUESTED_CONCURRENCY,
    max: base.maxConcurrency,
    memoryPerWorkerBytes: base.memoryPerWorkerBytes,
    utilization: base.cpuUtilization,
  });
  return {
    ...base,
    profile: name,
    maxWorkers: Math.min(base.maxConcurrency, MAX_REQUESTED_CONCURRENCY),
    concurrency: recommended,
    requested: explicitName ?? 'auto',
    selectedBy: explicitName ? 'requested' : 'detected',
    rationale: explicitName ? `requested ${name}` : `selected from observed CPU, memory, and disk pressure`,
    limits: {
      maxConcurrency: Math.min(base.maxConcurrency, MAX_REQUESTED_CONCURRENCY),
      memoryPerWorkerBytes: base.memoryPerWorkerBytes,
      diskReserveRatio: base.diskReserveRatio,
    },
  };
}

function workloadSettings(workload) {
  if (typeof workload === 'string') return { kind: workload };
  if (!workload || typeof workload !== 'object') return {};
  return workload;
}

function concurrencyLimit(value, fallback, field, { allowZero = true } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(number) || number < minimum || number > MAX_REQUESTED_CONCURRENCY) {
    throw new TypeError(`${field} must be an integer from ${minimum} to ${MAX_REQUESTED_CONCURRENCY}`);
  }
  return number;
}

function reservationCount(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1024) {
    throw new TypeError('other task reservations must be an integer from 0 to 1024');
  }
  return number;
}

/**
 * Recommend an integer number of *additional* safe workers.  Returning zero
 * when the current lane count already consumes the safe cap is intentional:
 * callers can wait for capacity without oversubscribing the host.
 */
export function recommendConcurrency(scan, workload = {}) {
  const normalizedScan = asScanObject(scan);
  const settings = workloadSettings(workload);
  const profile = RESOURCE_PROFILES[profileName(settings.profile) ?? automaticProfileName(normalizedScan)] ?? RESOURCE_PROFILES.balanced;
  const logicalCount = Math.max(1, Math.floor(finiteNumber(normalizedScan?.cpu?.logicalCount) ?? 1));
  const normalizedLoad = finiteNumber(normalizedScan?.cpu?.normalizedLoad);
  const loadFactor = normalizedLoad === null ? 1 : Math.max(0.25, Math.min(1.5, 1 - Math.max(0, normalizedLoad - 0.5) * 0.5));
  const utilization = finiteNumber(settings.utilization) !== null ? Math.max(0.1, Math.min(1, settings.utilization)) : profile.cpuUtilization;
  let cap = Math.max(1, Math.floor(logicalCount * utilization * loadFactor));
  cap = Math.min(cap, profile.maxConcurrency);

  const kind = String(settings.kind ?? settings.type ?? 'balanced').toLowerCase();
  if (kind === 'io' || kind === 'io-bound' || kind === 'network') cap = Math.min(profile.maxConcurrency, Math.max(cap, logicalCount));
  if (kind === 'ci' || profile.name === 'ci') cap = Math.min(cap, 4);
  if (kind === 'memory' || kind === 'memory-bound') cap = Math.min(cap, 2);
  const ramPressure = clampRatio(normalizedScan?.memory?.pressureRatio ?? normalizedScan?.ram?.pressureRatio);
  const diskPressure = clampRatio(normalizedScan?.disk?.pressureRatio);
  const memoryPerWorker = nonNegativeNumber(settings.memoryPerWorkerBytes ?? settings.memoryPerWorker ?? profile.memoryPerWorkerBytes);
  const freeBytes = nonNegativeNumber(normalizedScan?.memory?.freeBytes ?? normalizedScan?.ram?.freeBytes);
  const requested = concurrencyLimit(
    settings.requested ?? settings.parallelism ?? settings.workers,
    DEFAULT_REQUESTED_CONCURRENCY,
    'requested concurrency',
  );
  cap = Math.min(cap, requested);
  const maximum = concurrencyLimit(
    settings.configuredMax ?? settings.max,
    MAX_REQUESTED_CONCURRENCY,
    'configured maximum',
  );
  cap = Math.min(cap, maximum, MAX_REQUESTED_CONCURRENCY);
  const hostCeilingRaw = settings.hostCeiling ?? settings.runtimeCeiling ?? settings.hostMax;
  const hostCeiling = hostCeilingRaw === undefined || hostCeilingRaw === null || hostCeilingRaw === ''
    ? null
    : concurrencyLimit(hostCeilingRaw, null, 'host ceiling');
  if (hostCeiling !== null) cap = Math.min(cap, hostCeiling);
  const minimum = finiteNumber(settings.min);
  if (minimum !== null && minimum >= 0) cap = Math.max(cap, Math.floor(minimum));

  // Apply host safety caps after caller preferences. A requested minimum may
  // never override measured RAM, disk, or memory-per-worker limits.
  if (ramPressure !== null && ramPressure >= 0.9) cap = Math.min(cap, 1);
  else if (ramPressure !== null && ramPressure >= 0.8) cap = Math.min(cap, 2);
  if (diskPressure !== null && diskPressure >= 0.95) cap = Math.min(cap, 1);
  if (memoryPerWorker !== null && memoryPerWorker > 0 && freeBytes !== null) cap = Math.min(cap, Math.floor(freeBytes / memoryPerWorker));

  const current = finiteNumber(normalizedScan?.concurrency?.current ?? normalizedScan?.concurrency?.active);
  if (current !== null && current >= 0) cap -= Math.floor(current);
  return Math.min(MAX_REQUESTED_CONCURRENCY, Math.max(0, Math.floor(cap)));
}

function pathMatchesRoot(candidate, root) {
  const resolvedCandidate = nodePath.resolve(candidate);
  const resolvedRoot = nodePath.resolve(root);
  return isContained(resolvedRoot, resolvedCandidate);
}

function cleanupCandidates(scan) {
  const footprint = scan?.footprint ?? {};
  const categories = footprint.categories ?? footprint;
  return ['cache', 'build', 'worktree'].map((category) => ({ category, metric: categories[category] })).filter((item) => item.metric && typeof item.metric.path === 'string' && item.metric.present !== false);
}

/**
 * Build a non-mutating, project-scoped cleanup inventory.  This function does
 * not return shell commands and cannot delete anything; a later explicitly
 * confirmed executor must re-check each path before acting.
 */
export function planProjectCleanup(scan, options = {}) {
  const normalizedScan = asScanObject(scan);
  const repoPath = typeof normalizedScan.repoPath === 'string' ? nodePath.resolve(normalizedScan.repoPath) : null;
  const rawRoots = options?.allowedRoots;
  const roots = Array.isArray(rawRoots) ? rawRoots : typeof rawRoots === 'string' ? [rawRoots] : [];
  const errors = [];
  const allowedRoots = [];
  if (!repoPath) errors.push({ code: 'ERR_REPO_PATH_REQUIRED', message: 'scan.repoPath is required' });
  if (roots.length === 0) errors.push({ code: 'ERR_ALLOWED_ROOTS_REQUIRED', message: 'allowedRoots must name project paths' });
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) {
      errors.push({ code: 'ERR_INVALID_ALLOWED_ROOT', message: 'allowedRoots entries must be non-empty strings' });
      continue;
    }
    const resolved = repoPath ? nodePath.resolve(repoPath, root) : nodePath.resolve(root);
    if (repoPath && !pathMatchesRoot(resolved, repoPath)) {
      errors.push({ code: 'ERR_PATH_ESCAPE', message: 'allowed root escaped repoPath' });
      continue;
    }
    allowedRoots.push(resolved);
  }

  const items = [];
  if (errors.length === 0) {
    for (const { category, metric } of cleanupCandidates(normalizedScan)) {
      const candidatePath = nodePath.resolve(metric.path);
      if (!repoPath || !pathMatchesRoot(candidatePath, repoPath) || !allowedRoots.some((root) => pathMatchesRoot(candidatePath, root))) continue;
      const status = metric.status ?? 'unknown';
      if (status === 'blocked' || metric.symlinkPaths?.length || metric.escapingPaths?.length) {
        errors.push({ code: 'ERR_BLOCKED_CLEANUP_PATH', message: `${category} path is unreadable, escaping, or symlinked` });
        continue;
      }
      const recoverability = category === 'worktree' ? 'conditional' : 'rebuildable';
      items.push({
        category,
        path: candidatePath,
        bytes: nonNegativeNumber(metric.bytes) ?? 0,
        files: Number.isInteger(metric.files) ? metric.files : 0,
        status,
        action: 'review-and-remove-later',
        safeToDelete: false,
        requiresConfirmation: true,
        recoverability,
        recoverable: recoverability === 'rebuildable',
        recoverabilityNote: category === 'worktree'
          ? 'May contain uncommitted work; preserve or archive before any deletion.'
          : 'Can normally be recreated by a clean install/build, subject to project policy.',
      });
    }
  }
  const candidateBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  return {
    schemaVersion: '1.0',
    generatedAt: normalizedScan.scannedAt ?? new Date().toISOString(),
    repoPath,
    allowedRoots,
    items,
    summary: { candidateCount: items.length, candidateBytes, totalBytes: candidateBytes, recoverableCount: items.filter((item) => item.recoverability === 'rebuildable').length },
    mutating: false,
    commands: [],
    executionRequired: true,
    requiresExplicitConfirmation: true,
    blocked: errors.length > 0,
    errors,
  };
}

/**
 * Produce a read-only interruption/crash-risk guard recommendation. It keeps
 * one parent/integrator, applies bounded backpressure, and identifies stale
 * leases/worktrees for later recovery without mutating or deleting anything.
 */
export function planSessionGuard(scan, workload = {}) {
  const normalizedScan = asScanObject(scan);
  const requestedCount = concurrencyLimit(
    workload.requested ?? workload.lanes ?? workload.newLanes,
    DEFAULT_REQUESTED_CONCURRENCY,
    'requested concurrency',
  );
  const hostCeilingRaw = workload.hostCeiling ?? workload.runtimeCeiling ?? workload.hostMax;
  const hostCeiling = hostCeilingRaw === undefined || hostCeilingRaw === null || hostCeilingRaw === ''
    ? null
    : concurrencyLimit(hostCeilingRaw, null, 'host ceiling');
  const otherTaskReservations = reservationCount(workload.otherTaskReservations);
  const current = finiteNumber(normalizedScan?.concurrency?.current ?? normalizedScan?.concurrency?.active) ?? 0;
  const safeCapacity = recommendConcurrency(normalizedScan, {
    ...workload,
    requested: requestedCount,
    ...(hostCeiling === null ? {} : { hostCeiling }),
  });
  // recommendConcurrency already subtracts current local concurrency. Only
  // explicit reservations from other tasks are deducted here.
  const available = Math.max(0, safeCapacity - otherTaskReservations);
  return {
    schemaVersion: '1.0',
    mutating: false,
    parentCount: 1,
    requestedTarget: DEFAULT_REQUESTED_CONCURRENCY,
    configuredRequestMaximum: MAX_REQUESTED_CONCURRENCY,
    hostCeiling,
    hostCeilingStatus: hostCeiling === null ? 'unknown' : 'reported',
    safeCapacity,
    currentConcurrency: Math.floor(current),
    otherTaskReservations,
    availableCapacity: available,
    queue: 'bounded-backpressure',
    reserveRamAndDisk: true,
    acceptNewLanes: requestedCount <= available,
    requestedNewLanes: requestedCount,
    recovery: ['revalidate stale leases', 'preserve rescue worktrees before reuse'],
    blockedReasons: requestedCount > available ? ['resource pressure or no safe capacity'] : [],
    warnings: [
      'Risk reduction only; this does not prevent all crashes.',
      'No daemon, process killing, OS setting changes, or automatic cleanup is performed.',
    ],
  };
}

function displayBytes(value) {
  const number = nonNegativeNumber(value);
  if (number === null) return 'unavailable';
  if (number < 1024) return `${number} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KiB`;
  if (number < BYTES_PER_GIB) return `${(number / 1024 ** 2).toFixed(1)} MiB`;
  return `${(number / BYTES_PER_GIB).toFixed(2)} GiB`;
}

function displayNumber(value) {
  return finiteNumber(value) === null ? 'unavailable' : String(value);
}

/** Return a short, deterministic human-readable resource summary. */
export function summarizeResources(scan) {
  const normalizedScan = asScanObject(scan);
  const cpu = normalizedScan.cpu ?? {};
  const memory = normalizedScan.memory ?? normalizedScan.ram ?? {};
  const nodeMemory = normalizedScan.node ?? normalizedScan.process ?? {};
  const disk = normalizedScan.disk ?? {};
  const footprint = normalizedScan.footprint ?? {};
  const categories = footprint.categories ?? footprint;
  const parts = [
    `CPU ${displayNumber(cpu.logicalCount)} logical / load ${displayNumber(cpu.load)}`,
    `RAM free ${displayBytes(memory.freeBytes)} of ${displayBytes(memory.totalBytes)} (pressure ${memory.pressureRatio === null || memory.pressureRatio === undefined ? 'unavailable' : `${Math.round(memory.pressureRatio * 100)}%`})`,
    `Node heap ${displayBytes(nodeMemory.heapUsedBytes)} / ${displayBytes(nodeMemory.heapTotalBytes)}`,
    `disk free ${displayBytes(disk.freeBytes)} of ${displayBytes(disk.totalBytes)}`,
    `footprint ${displayBytes(footprint.bytes ?? categories.repo?.bytes)} (git ${displayBytes(categories.git?.bytes)}, worktree ${displayBytes(categories.worktree?.bytes)}, build ${displayBytes(categories.build?.bytes)}, cache ${displayBytes(categories.cache?.bytes)})`,
    `concurrency ${displayNumber(normalizedScan.concurrency?.current ?? normalizedScan.concurrency?.active)}`,
  ];
  return parts.join('; ');
}

/**
 * Collect all supported diagnostics.  Probe failures are represented as
 * unavailable/blocked fields so a caller can choose a conservative profile;
 * they are never converted into a broad fallback scan.
 */
export async function scanResources(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('scanResources options must be an object');
  const osImpl = options.os ?? nodeOs;
  const fsImpl = { ...nodeFs, ...(options.fs ?? {}) };
  const repoPath = nodePath.resolve(options.repoPath ?? options.rootDir ?? options.projectRoot ?? options.cwd ?? nodeProcess.cwd());
  const platform = normalizePlatform(options, osImpl);
  const [disk, footprint] = await Promise.all([
    collectDisk(options, repoPath, fsImpl),
    scanFootprint(repoPath, options, fsImpl),
  ]);
  const cpu = collectCpu(options, osImpl);
  const memory = collectMemory(options, osImpl);
  const nodeMemory = collectNodeMemory(options);
  const concurrency = collectConcurrency(options);
  const warnings = [];
  if (!cpu.available) warnings.push('CPU metrics unavailable');
  if (!memory.available) warnings.push('system memory metrics unavailable');
  if (!disk.available) warnings.push('disk metrics unavailable');
  if (footprint.status !== 'ok') warnings.push(`footprint scan ${footprint.status}`);
  return {
    schemaVersion: '1.0',
    scannedAt: typeof options.now === 'function' ? String(options.now()) : typeof options.now === 'string' ? options.now : new Date().toISOString(),
    platform,
    repoPath,
    cpu,
    memory,
    ram: memory,
    node: nodeMemory,
    process: nodeMemory,
    disk,
    footprint,
    concurrency,
    limits: { maxDepth: footprint.maxDepth, maxEntries: footprint.maxEntries },
    warnings,
  };
}

export default {
  RESOURCE_PROFILES,
  DEFAULT_REQUESTED_CONCURRENCY,
  MAX_REQUESTED_CONCURRENCY,
  POLICY_GOAL_CONCURRENCY,
  PUBLIC_MAX_CONCURRENCY,
  scanResources,
  chooseResourceProfile,
  recommendConcurrency,
  planProjectCleanup,
  planSessionGuard,
  summarizeResources,
};
