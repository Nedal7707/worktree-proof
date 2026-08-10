import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertContainedRealPath,
  discoverGitRepository,
  isPathContained,
  runGit,
} from '../src/git.js';

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-proof-git-'));
}

function initializeRepository() {
  const root = temporaryDirectory();
  runGit(['init', '-b', 'main'], { cwd: root });
  runGit(['config', 'user.email', 'worktree-proof@example.invalid'], { cwd: root });
  runGit(['config', 'user.name', 'WorktreeProof Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'worktree-proof\n');
  runGit(['add', 'README.md'], { cwd: root });
  runGit(['commit', '-m', 'initial'], { cwd: root });
  return root;
}

test('discovers repository root, common directory, and configurable canonical ref', (t) => {
  const root = initializeRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  const discovered = discoverGitRepository(nested, { canonicalRef: 'HEAD' });
  assert.equal(discovered.repoRoot, root);
  assert.equal(path.basename(discovered.commonDir), '.git');
  assert.match(discovered.canonicalCommit, /^[0-9a-f]{40}$/);
});

test('containment rejects traversal and realpath escapes', (t) => {
  const root = temporaryDirectory();
  const outside = temporaryDirectory();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  assert.equal(isPathContained(root, path.join(root, 'lane')), true);
  assert.equal(isPathContained(root, path.join(root, '..', path.basename(outside))), false);
  assert.throws(() => assertContainedRealPath(root, outside), /escapes/);
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    // Symlink creation can be disabled on a developer Windows host. The
    // ordinary path escape above still exercises the containment guarantee.
    return;
  }
  assert.throws(() => assertContainedRealPath(root, path.join(link, 'file'), { allowMissing: true }), /symlink|reparse|escapes/);
});

