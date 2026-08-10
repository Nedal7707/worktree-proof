/**
 * Public WorktreeProof API.
 *
 * Keep the command-line entry point (`bin/worktree-proof.js`) separate from the
 * reusable primitives so embedders can import validation, planning, leases,
 * evidence, and process helpers without triggering process I/O.
 */

export * from './cli.js';
export * from './scope.js';
export * from './planner.js';
export * from './leases.js';
export * from './evidence.js';
export * from './runner.js';
export * from './adapters.js';
export * from './manifest.js';
export * from './migration.js';
export * from './bridge.js';
export * from './init.js';
export * from './resources.js';
export * from './tasks.js';
export * from './tools.js';
export * from './protocol/index.js';
export {
  GitCommandError,
  runGit,
  isPathContained,
  assertContainedRealPath,
  discoverGitRepository,
  findGitRepository,
  discoverRepository,
  resolveCanonicalRef,
  getGitStatus,
} from './git.js';
export {
  WorktreeOperationError,
  inspectWorktreeStatus,
  createLaneWorktree,
  createLaneWorktreeAsync,
  removeLaneWorktree,
  cleanupManagedWorktrees,
  cleanupWorktrees,
  createWorktree,
  removeWorktree,
  runLaneCommand,
} from './worktree.js';
