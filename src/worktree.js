import fs from 'node:fs';
import path from 'node:path';

import { executeArgv } from './runner.js';
import {
  assertContainedRealPath,
  discoverGitRepository,
  isPathContained,
  runGit,
} from './git.js';

export class WorktreeOperationError extends Error {
  constructor(message, rescue) {
    super(message);
    this.name = 'WorktreeOperationError';
    this.rescue = rescue;
  }
}

function laneSegment(lane) {
  if (typeof lane !== 'string' || lane.length === 0) throw new TypeError('lane must be a non-empty string');
  if (lane === '.' || lane === '..' || lane.includes('/') || lane.includes('\\') || lane.includes(':')) {
    throw new Error('lane must be a single path-safe segment');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lane)) throw new Error('lane contains unsupported characters');
  return lane;
}

function branchName(branch, lane) {
  const value = branch ?? `worktree-proof/${lane}`;
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || value.includes('..')) {
    throw new Error('branch must be a valid non-empty git branch name');
  }
  if (value.includes('\\') || value.includes('\0')) throw new Error('branch contains unsupported characters');
  return value;
}

function boundedError(error) {
  if (!error) return undefined;
  return { name: error.name ?? 'Error', code: error.code, message: String(error.message ?? error) };
}

function rescueRecord(input, reason, status, error) {
  return {
    lane: input?.lane,
    branch: input?.branch,
    path: input?.path,
    worktreeRoot: input?.worktreeRoot,
    reason,
    status,
    error: boundedError(error),
    rescued: true,
  };
}

function gitOptions(config, cwd) {
  return {
    cwd,
    gitBin: config.gitBin ?? config.git,
    spawnSync: config.spawnSync,
    env: config.env,
    timeoutMs: config.gitTimeoutMs,
    maxBuffer: config.maxBuffer,
  };
}

function gitCall(config, args, cwd, extra = {}) {
  const runner = config.gitRunner ?? runGit;
  return runner(args, { ...gitOptions(config, cwd), ...extra, cwd });
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink?.() || (Number.isInteger(stats.attributes) && (stats.attributes & 0x400) !== 0)) {
    throw new Error('worktree root cannot be a symlink or reparse point');
  }
}

function resolveRepository(config) {
  const supplied = config.repository ?? config.repo;
  if (config.repoRoot || config.root || supplied?.repoRoot || supplied?.root) {
    const repoRoot = fs.realpathSync(path.resolve(config.repoRoot ?? config.root ?? supplied.repoRoot ?? supplied.root));
    let commonDir;
    if (config.commonDir ?? supplied?.commonDir) {
      commonDir = path.resolve(config.commonDir ?? supplied.commonDir);
    } else {
      let commonResult = gitCall(config, ['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot, { throwOnError: false });
      if (!commonResult.ok) commonResult = gitCall(config, ['rev-parse', '--git-common-dir'], repoRoot);
      commonDir = path.resolve(repoRoot, commonResult.stdout.trim());
    }
    commonDir = fs.realpathSync(commonDir);
    const canonicalRef = config.canonicalRef ?? supplied?.canonicalRef ?? 'HEAD';
    const canonicalCommit = config.canonicalCommit ?? supplied?.canonicalCommit ?? gitCall(config, ['rev-parse', '--verify', `${canonicalRef}^{commit}`], repoRoot).stdout.trim();
    return { repoRoot, commonDir, canonicalRef, canonicalCommit };
  }
  const discovered = discoverGitRepository(config.startPath ?? process.cwd(), { ...gitOptions(config), canonicalRef: config.canonicalRef });
  return { repoRoot: discovered.repoRoot, commonDir: discovered.commonDir, canonicalRef: discovered.canonicalRef, canonicalCommit: discovered.canonicalCommit };
}

function resolveRoot(repoRoot, config) {
  const root = path.resolve(config.worktreeRoot ?? path.join(repoRoot, '.worktree-proof-worktrees'));
  ensureDirectory(root);
  const canonicalRoot = fs.realpathSync(root);
  assertContainedRealPath(canonicalRoot, canonicalRoot, { allowMissing: false });
  return canonicalRoot;
}

function sameResolvedPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function branchExists(repoRoot, branch, config) {
  return gitCall(config, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot, { throwOnError: false }).ok;
}

function managedPath(record, root) {
  if (!record?.path || !record?.lane) throw new TypeError('managed lane record requires lane and path');
  const expectedPath = path.resolve(root, laneSegment(record.lane));
  const actualPath = path.resolve(record.path);
  if (!sameResolvedPath(expectedPath, actualPath)) throw new Error('managed worktree path does not match its lane');
  return expectedPath;
}

function inspectTopLevel(worktreePath, config) {
  const top = gitCall(config, ['rev-parse', '--show-toplevel'], worktreePath, { throwOnError: false });
  return top.ok ? fs.realpathSync(path.resolve(top.stdout.trim())) : undefined;
}

/**
 * Inspect branch, HEAD, and porcelain status. This function never mutates the
 * worktree and reports failures instead of masking them as a clean state.
 */
export function inspectWorktreeStatus(worktreePath, options = {}) {
  const statusResult = gitCall(options, ['status', '--porcelain=v1', '--untracked-files=all'], worktreePath, { throwOnError: false });
  const branchResult = gitCall(options, ['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath, { throwOnError: false });
  const headResult = gitCall(options, ['rev-parse', '--verify', 'HEAD'], worktreePath, { throwOnError: false });
  const branch = branchResult.ok ? branchResult.stdout.trim() : undefined;
  const head = headResult.ok ? headResult.stdout.trim() : undefined;
  const output = statusResult.stdout ?? '';
  const entries = output.split(/\r?\n/).filter(Boolean);
  const ok = statusResult.ok && branchResult.ok && headResult.ok;
  return {
    ok,
    path: path.resolve(worktreePath),
    branch,
    head,
    clean: ok && entries.length === 0,
    dirty: !ok || entries.length > 0,
    entries,
    statusCode: statusResult.code,
    error: ok ? undefined : boundedError(new Error([statusResult.stderr, branchResult.stderr, headResult.stderr].filter(Boolean).join('\n') || 'unable to inspect worktree status')),
  };
}

/**
 * Create a dedicated branch worktree for one named lane. The worktree root and
 * candidate path are checked before and after git creates the checkout.
 */
export function createLaneWorktree(config = {}) {
  const lane = laneSegment(config.lane ?? config.name ?? config.laneId);
  const branch = branchName(config.branch ?? config.branchName, lane);
  const repository = resolveRepository(config);
  const root = resolveRoot(repository.repoRoot, config);
  const worktreePath = path.resolve(root, lane);
  assertContainedRealPath(root, worktreePath, { allowMissing: true });
  if (fs.existsSync(worktreePath)) throw new Error(`lane worktree already exists: ${lane}`);
  const record = {
    managed: true,
    lane,
    branch,
    path: worktreePath,
    worktreeRoot: root,
    repoRoot: repository.repoRoot,
    commonDir: repository.commonDir,
    canonicalRef: repository.canonicalRef,
    canonicalCommit: repository.canonicalCommit,
    baseCommit: repository.canonicalCommit,
  };
  try {
    const args = branchExists(repository.repoRoot, branch, config)
      ? ['worktree', 'add', worktreePath, branch]
      : ['worktree', 'add', '-b', branch, worktreePath, repository.canonicalRef];
    const added = gitCall(config, args, repository.repoRoot);
    if (!added.ok) throw new Error(added.stderr || 'git worktree add failed');
    assertContainedRealPath(root, worktreePath, { allowMissing: false });
    const status = inspectWorktreeStatus(worktreePath, config);
    const top = inspectTopLevel(worktreePath, config);
    if (!status.ok || status.branch !== branch || !sameResolvedPath(top, worktreePath)) {
      throw new Error('created worktree failed branch/path/status validation');
    }
    return { ...record, head: status.head, status, rescue: undefined };
  } catch (error) {
    const status = fs.existsSync(worktreePath) ? inspectWorktreeStatus(worktreePath, config) : undefined;
    const rescue = rescueRecord(record, 'create-failed', status, error);
    const wrapped = new WorktreeOperationError(`unable to create lane worktree ${lane}`, rescue);
    wrapped.cause = error;
    throw wrapped;
  }
}

export async function createLaneWorktreeAsync(config = {}) {
  return createLaneWorktree(config);
}

async function leaseIsActive(record, options) {
  const predicate = options.activeLeasePredicate ?? options.isLeaseActive;
  if (typeof predicate !== 'function') return false;
  return Boolean(await predicate(record));
}

function validateForRemoval(record, options, status) {
  const root = path.resolve(options.worktreeRoot ?? record.worktreeRoot);
  const worktreePath = managedPath(record, root);
  assertContainedRealPath(root, worktreePath, { allowMissing: false });
  const top = inspectTopLevel(worktreePath, options);
  if (top !== worktreePath) throw new Error('worktree top-level path changed');
  if (status.branch !== record.branch) throw new Error('worktree branch changed');
  if (record.head && status.head !== record.head) throw new Error('worktree HEAD changed');
  return { root, worktreePath };
}

/**
 * Remove one managed lane only when all final checks are clean. No `--force`
 * flag is ever used. Dirty, failed, changed, and active-lease worktrees are
 * returned as rescue/protection records and intentionally left in place.
 */
export async function removeLaneWorktree(record, options = {}) {
  if (!record?.managed) return { removed: false, rescued: rescueRecord(record, 'unmanaged-lane') };
  try {
    if (await leaseIsActive(record, options)) return { removed: false, protected: true, reason: 'active-lease', lane: record.lane, path: record.path };
  } catch (error) {
    return { removed: false, rescued: rescueRecord(record, 'lease-check-failed', undefined, error) };
  }
  let root;
  let worktreePath;
  let status;
  try {
    root = path.resolve(options.worktreeRoot ?? record.worktreeRoot);
    worktreePath = managedPath(record, root);
    assertContainedRealPath(root, worktreePath, { allowMissing: false });
    status = inspectWorktreeStatus(worktreePath, options);
    validateForRemoval(record, options, status);
    if (!status.clean) return { removed: false, rescued: rescueRecord(record, 'dirty-or-status-failed', status) };

    // Re-check every removal precondition immediately before invoking git.
    if (await leaseIsActive(record, options)) return { removed: false, protected: true, reason: 'active-lease', lane: record.lane, path: worktreePath };
    assertContainedRealPath(root, worktreePath, { allowMissing: false });
    const finalStatus = inspectWorktreeStatus(worktreePath, options);
    validateForRemoval(record, options, finalStatus);
    if (!finalStatus.clean) return { removed: false, rescued: rescueRecord(record, 'became-dirty', finalStatus) };
    const removed = gitCall(options, ['worktree', 'remove', worktreePath], record.repoRoot);
    if (!removed.ok || fs.existsSync(worktreePath)) {
      return { removed: false, rescued: rescueRecord(record, 'remove-failed', finalStatus, new Error(removed.stderr || 'git worktree remove failed')) };
    }
    return { removed: true, lane: record.lane, branch: record.branch, path: worktreePath, status: finalStatus };
  } catch (error) {
    const rescue = rescueRecord({ ...record, path: worktreePath ?? record.path, worktreeRoot: root ?? record.worktreeRoot }, 'validation-failed', status, error);
    return { removed: false, rescued: rescue };
  }
}

/**
 * Clean exactly the records supplied by the caller. Omitting `lanes` is an
 * explicit no-op; this function never discovers or sweeps global worktrees.
 */
export async function cleanupManagedWorktrees(options = {}) {
  const lanes = options.lanes ?? options.managedLanes;
  if (!Array.isArray(lanes)) throw new TypeError('cleanup requires an explicit lanes array');
  const results = [];
  for (const lane of lanes) results.push(await removeLaneWorktree(lane, options));
  return {
    results,
    removed: results.filter((result) => result.removed),
    protected: results.filter((result) => result.protected),
    rescues: results.map((result) => result.rescued).filter(Boolean),
  };
}

export const cleanupWorktrees = cleanupManagedWorktrees;
export const createWorktree = createLaneWorktree;
export const removeWorktree = removeLaneWorktree;
export { assertContainedRealPath, isPathContained };

/** Execute a lane command and inspect status even when execution fails. */
export async function runLaneCommand(record, argv, options = {}) {
  const worktreePath = record?.path;
  if (!record?.managed || !worktreePath) throw new TypeError('managed lane record is required');
  const root = path.resolve(options.worktreeRoot ?? record.worktreeRoot);
  assertContainedRealPath(root, worktreePath, { allowMissing: false });
  let execution;
  let executionError;
  try {
    const execute = options.executeArgv ?? executeArgv;
    execution = await execute(argv, { ...options, cwd: worktreePath, shell: false });
  } catch (error) {
    executionError = boundedError(error);
  }
  const status = inspectWorktreeStatus(worktreePath, options);
  return { execution, executionError, status, lane: record.lane, branch: record.branch, path: worktreePath };
}
