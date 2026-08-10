import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupManagedWorktrees,
  createLaneWorktree,
  inspectWorktreeStatus,
  removeLaneWorktree,
  runLaneCommand,
} from '../src/worktree.js';
import { runGit } from '../src/git.js';

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-proof-worktree-'));
  runGit(['init', '-b', 'main'], { cwd: root });
  runGit(['config', 'user.email', 'worktree-proof@example.invalid'], { cwd: root });
  runGit(['config', 'user.name', 'WorktreeProof Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'worktree-proof\n');
  runGit(['add', 'README.md'], { cwd: root });
  runGit(['commit', '-m', 'initial'], { cwd: root });
  return root;
}

function cleanUp(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('creates and removes a clean branch worktree without force', async (t) => {
  const root = repository();
  t.after(() => cleanUp(root));
  const worktreeRoot = path.join(root, '.managed');
  const calls = [];
  const gitRunner = (args, options) => {
    calls.push([...args]);
    return runGit(args, options);
  };
  const record = createLaneWorktree({ repoRoot: root, worktreeRoot, lane: 'clean', canonicalRef: 'HEAD', gitRunner });
  assert.equal(record.status.clean, true);
  const removed = await removeLaneWorktree(record, { gitRunner });
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(record.path), false);
  assert.equal(calls.some((args) => args.includes('--force')), false);
  assert.equal(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove'), true);
});

test('preserves dirty worktrees as rescue records', async (t) => {
  const root = repository();
  t.after(() => cleanUp(root));
  const record = createLaneWorktree({ repoRoot: root, worktreeRoot: path.join(root, '.managed'), lane: 'dirty' });
  fs.writeFileSync(path.join(record.path, 'dirty.txt'), 'keep me');
  const result = await removeLaneWorktree(record);
  assert.equal(result.removed, false);
  assert.equal(result.rescued.rescued, true);
  assert.match(result.rescued.reason, /dirty/);
  assert.equal(fs.existsSync(record.path), true);
  const cleanup = await cleanupManagedWorktrees({ lanes: [record] });
  assert.equal(cleanup.rescues.length, 1);
});

test('protects a worktree with an active lease predicate', async (t) => {
  const root = repository();
  t.after(() => cleanUp(root));
  const record = createLaneWorktree({ repoRoot: root, worktreeRoot: path.join(root, '.managed'), lane: 'leased' });
  const result = await removeLaneWorktree(record, { activeLeasePredicate: () => true });
  assert.equal(result.protected, true);
  assert.equal(fs.existsSync(record.path), true);
});

test('runLaneCommand always returns post-command status', async (t) => {
  const root = repository();
  t.after(() => cleanUp(root));
  const record = createLaneWorktree({ repoRoot: root, worktreeRoot: path.join(root, '.managed'), lane: 'run' });
  const result = await runLaneCommand(record, [process.execPath, '-e', 'process.exit(3)'], { timeoutMs: 1000 });
  assert.equal(result.execution.ok, false);
  assert.equal(result.status.ok, true);
  assert.equal(result.status.clean, true);
});

test('status exposes branch and HEAD for final revalidation', (t) => {
  const root = repository();
  t.after(() => cleanUp(root));
  const record = createLaneWorktree({ repoRoot: root, worktreeRoot: path.join(root, '.managed'), lane: 'inspect' });
  const status = inspectWorktreeStatus(record.path);
  assert.equal(status.branch, record.branch);
  assert.equal(status.head, record.head);
});

