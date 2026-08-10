import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Error raised when a git command cannot be completed successfully.
 *
 * The error intentionally carries only command metadata and bounded output.
 * Environment variables and other process state are never copied into it.
 */
export class GitCommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GitCommandError';
    this.code = details.code ?? null;
    this.signal = details.signal ?? null;
    this.args = Array.isArray(details.args) ? [...details.args] : [];
    this.cwd = details.cwd ? path.resolve(details.cwd) : undefined;
    this.stdout = sanitizeOutput(details.stdout);
    this.stderr = sanitizeOutput(details.stderr);
  }
}

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;

function sanitizeOutput(value, limit = DEFAULT_OUTPUT_LIMIT) {
  const text = value == null ? '' : String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output truncated]`;
}

function normalizeResult(result, args, cwd, outputLimit = DEFAULT_OUTPUT_LIMIT) {
  const stdout = sanitizeOutput(result?.stdout, outputLimit);
  const stderr = sanitizeOutput(result?.stderr, outputLimit);
  const status = Number.isInteger(result?.status) ? result.status : null;
  const signal = result?.signal ?? null;
  return {
    ok: status === 0 && !signal && !result?.error,
    status,
    code: status,
    signal,
    stdout,
    stderr,
    args: [...args],
    cwd: cwd ? path.resolve(cwd) : undefined,
    error: result?.error ? { code: result.error.code ?? 'GIT_SPAWN_ERROR', message: String(result.error.message ?? result.error) } : undefined,
  };
}

/**
 * Run git without a shell. A synchronous runner keeps the core runtime
 * dependency-free while still accepting a spawnSync implementation in tests.
 */
export function runGit(args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('git args must be an array of strings');
  }
  const cwd = options.cwd ? path.resolve(options.cwd) : undefined;
  const gitBin = options.gitBin ?? options.git ?? 'git';
  const spawnSyncImpl = options.spawnSync ?? nodeSpawnSync;
  let raw;
  try {
    raw = spawnSyncImpl(gitBin, args, {
      cwd,
      env: options.env,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer ?? DEFAULT_OUTPUT_LIMIT,
      input: options.input,
    });
  } catch (error) {
    raw = { error };
  }
  const result = normalizeResult(raw, args, cwd, options.maxBuffer ?? DEFAULT_OUTPUT_LIMIT);
  if (!result.ok && options.throwOnError !== false) {
    throw new GitCommandError(`git ${args.join(' ')} failed`, result);
  }
  return result;
}

function readText(result, label) {
  if (!result.ok) throw new GitCommandError(`Unable to read ${label}`, result);
  return result.stdout.trim();
}

function invokeGit(args, options = {}, cwd = options.cwd, extra = {}) {
  const runner = options.gitRunner ?? runGit;
  return runner(args, { ...options, ...extra, cwd });
}

/**
 * Return true if target is the root itself or is a descendant of root.
 * Both paths are resolved first and comparison is case-insensitive on
 * Windows, where the filesystem is normally case-insensitive.
 */
export function isPathContained(root, target) {
  if (!root || !target) return false;
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const relative = path.relative(rootResolved, targetResolved);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function hasReparseLikeFlag(stats) {
  // Node reports junctions and symbolic links as symbolic links on current
  // Windows versions. A reparse point flag is also represented by the high
  // file attribute bits when available; checking it is harmless elsewhere.
  if (stats.isSymbolicLink?.()) return true;
  const attributes = stats.attributes;
  return Number.isInteger(attributes) && (attributes & 0x400) !== 0;
}

function canonicalRealPath(target) {
  const resolver = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;
  return resolver(target);
}

/**
 * Validate that a path remains physically inside a root. Every existing path
 * segment is inspected, not just the final realpath, so a junction/reparse
 * point cannot be used to escape between checks. Missing descendants are
 * allowed when `allowMissing` is true (the existing parent is still checked).
 */
export function assertContainedRealPath(root, target, options = {}) {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  if (!isPathContained(rootResolved, targetResolved)) {
    throw new Error(`path escapes managed root: ${targetResolved}`);
  }

  const rootExisting = nearestExistingAncestor(rootResolved);
  const rootReal = canonicalRealPath(rootExisting);
  if (hasReparseLikeFlag(fs.lstatSync(rootExisting))) {
    // A symlinked existing root/ancestor is not a safe containment boundary.
    // Comparing path strings is insufficient on Windows because an 8.3 short
    // name and its long name can identify the same directory.
    throw new Error('managed root is a symlink or reparse point');
  }

  let cursor = rootResolved;
  const relativeSegments = path.relative(rootResolved, targetResolved).split(path.sep).filter(Boolean);
  // Check the root itself and each existing descendant segment for links.
  if (fs.existsSync(rootResolved)) {
    const rootStats = fs.lstatSync(rootResolved);
    if (hasReparseLikeFlag(rootStats)) throw new Error('managed root is a symlink or reparse point');
  } else if (!options.allowMissing) {
    throw new Error(`path does not exist: ${rootResolved}`);
  }
  for (const part of relativeSegments) {
    cursor = path.join(cursor, part);
    try {
      const stats = fs.lstatSync(cursor);
      if (hasReparseLikeFlag(stats)) throw new Error(`path contains symlink or reparse point: ${cursor}`);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        if (!options.allowMissing) throw new Error(`path does not exist: ${cursor}`);
        break;
      }
      throw error;
    }
  }

  const existing = nearestExistingAncestor(targetResolved);
  const existingReal = canonicalRealPath(existing);
  if (!isPathContained(rootReal, existingReal)) {
    throw new Error(`realpath escapes managed root: ${targetResolved}`);
  }
  if (fs.existsSync(targetResolved)) {
    const targetReal = canonicalRealPath(targetResolved);
    if (!isPathContained(rootReal, targetReal)) {
      throw new Error(`realpath escapes managed root: ${targetResolved}`);
    }
  }
  return { root: rootReal, target: targetResolved, existing: existingReal };
}

/**
 * Discover the repository root and git common directory from any descendant.
 * `canonicalRef` is intentionally configurable so callers can use `HEAD`, a
 * local branch, or a fetched remote ref without this module assuming one.
 */
export function discoverGitRepository(startPath = process.cwd(), options = {}) {
  const cwd = path.resolve(startPath);
  const root = readText(invokeGit(['rev-parse', '--show-toplevel'], options, cwd), 'repository root');
  const repoRoot = path.resolve(root);
  let commonResult = invokeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], options, cwd, { throwOnError: false });
  if (!commonResult.ok) commonResult = invokeGit(['rev-parse', '--git-common-dir'], options, cwd);
  const commonDirText = readText(commonResult, 'git common directory');
  const commonDir = path.resolve(cwd, commonDirText);
  // The common dir may be outside the worktree for linked worktrees, but it
  // must still be a real directory and not a link to an unexpected location.
  const repoReal = canonicalRealPath(repoRoot);
  const commonReal = canonicalRealPath(commonDir);
  const canonicalRef = options.canonicalRef ?? 'HEAD';
  const canonicalCommit = readText(invokeGit(['rev-parse', '--verify', `${canonicalRef}^{commit}`], options, repoRoot), 'canonical ref');
  return {
    root: repoRoot,
    repoRoot,
    realRoot: repoReal,
    commonDir,
    realCommonDir: commonReal,
    canonicalRef,
    canonicalCommit,
  };
}

export const findGitRepository = discoverGitRepository;
export const discoverRepository = discoverGitRepository;

export function resolveCanonicalRef(repoRoot, canonicalRef = 'HEAD', options = {}) {
  return readText(invokeGit(['rev-parse', '--verify', `${canonicalRef}^{commit}`], options, repoRoot), 'canonical ref');
}

export function getGitStatus(worktreePath, options = {}) {
  return invokeGit(['status', '--porcelain=v1', '--untracked-files=all'], options, worktreePath, {
    throwOnError: options.throwOnError ?? false,
  });
}
