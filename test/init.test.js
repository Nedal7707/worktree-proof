import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  InitSafetyError,
  applyInitPlan,
  buildInitPlan,
  inspectProject,
  recommendPreset,
} from '../src/init.js';

async function tempProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('inspectProject detects common stacks without reading lockfiles or secrets', async (t) => {
  const root = await tempProject(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'sample-app',
    scripts: { test: 'node --test' },
    dependencies: { react: '^19.0.0' },
  }));
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "sample"\n');
  await writeFile(path.join(root, 'package-lock.json'), '{"token":"lockfile-secret"}');
  await writeFile(path.join(root, '.env'), 'API_TOKEN=do-not-read\n');
  await mkdir(path.join(root, '.agents', 'skills'), { recursive: true });

  const project = await inspectProject(root);

  assert.equal(project.root, root);
  assert.ok(project.stack.languages.includes('javascript'));
  assert.ok(project.stack.languages.includes('python'));
  assert.ok(project.stack.frameworks.includes('react'));
  assert.ok(project.tools.agentSkills);
  assert.ok(project.files.lockfiles.includes('package-lock.json'));
  assert.doesNotMatch(JSON.stringify(project), /lockfile-secret|do-not-read/);
});

test('recommendPreset returns deterministic targets from project and tool inventory', async (t) => {
  const root = await tempProject(t);
  const project = await inspectProject(root);
  const recommendation = recommendPreset(project, { codex: true, claude: true, vscode: true, ci: true });

  assert.equal(recommendation.preset, 'project-onboarding');
  assert.deepEqual(recommendation.targets, ['agent-skills', 'claude-code', 'generic-prompt', 'vscode', 'ci']);
  assert.ok(Array.isArray(recommendation.reasons));
});

test('buildInitPlan is dry-run by default and applyInitPlan does not write in dry-run mode', async (t) => {
  const root = await tempProject(t);
  const plan = await buildInitPlan({ repo: root, targets: ['generic-prompt'] });

  assert.equal(plan.dryRun, true);
  assert.ok(plan.writes.some((entry) => entry.path === 'WORKTREE_PROOF_PROMPT.md'));
  const result = await applyInitPlan(plan);
  assert.equal(result.dryRun, true);
  await assert.rejects(access(path.join(root, 'WORKTREE_PROOF_PROMPT.md')));
});

test('applyInitPlan requires explicit confirmation and refuses collisions', async (t) => {
  const root = await tempProject(t);
  const plan = await buildInitPlan({ repo: root, targets: ['generic-prompt'] });

  await assert.rejects(
    () => applyInitPlan(plan, { dryRun: false }),
    (error) => error instanceof InitSafetyError && error.code === 'ERR_CONFIRM_REQUIRED',
  );
  await writeFile(path.join(root, 'WORKTREE_PROOF_PROMPT.md'), 'owner content');
  await assert.rejects(
    () => applyInitPlan(plan, { dryRun: false, confirm: true }),
    (error) => error instanceof InitSafetyError && error.code === 'ERR_COLLISION',
  );
  assert.equal(await readFile(path.join(root, 'WORKTREE_PROOF_PROMPT.md'), 'utf8'), 'owner content');
});

test('applyInitPlan refuses path traversal and absolute paths', async (t) => {
  const root = await tempProject(t);
  const base = { version: 1, root, writes: [{ path: '../escape.txt', content: 'nope', mode: 'create' }] };
  await assert.rejects(
    () => applyInitPlan(base, { dryRun: false, confirm: true }),
    (error) => error instanceof InitSafetyError && error.code === 'ERR_PATH_ESCAPE',
  );
  const absolute = { ...base, writes: [{ path: path.join(root, 'absolute.txt'), content: 'nope', mode: 'create' }] };
  await assert.rejects(
    () => applyInitPlan(absolute, { dryRun: false, confirm: true }),
    (error) => error instanceof InitSafetyError && error.code === 'ERR_ABSOLUTE_PATH',
  );
});

test('applyInitPlan refuses symlink escapes before creating a file', async (t) => {
  const root = await tempProject(t);
  const outside = await tempProject(t);
  try {
    await symlink(outside, path.join(root, 'linked'), 'junction');
  } catch {
    t.skip('symlink creation is unavailable in this environment');
    return;
  }
  const plan = { version: 1, root, writes: [{ path: 'linked/escape.txt', content: 'nope', mode: 'create' }] };
  await assert.rejects(
    () => applyInitPlan(plan, { dryRun: false, confirm: true }),
    (error) => error instanceof InitSafetyError && error.code === 'ERR_SYMLINK_ESCAPE',
  );
  await assert.rejects(access(path.join(outside, 'escape.txt')));
});

test('buildInitPlan rejects secret-bearing context before it can be captured', async (t) => {
  const root = await tempProject(t);
  await assert.rejects(
    () => buildInitPlan({ repo: root, targets: ['generic-prompt'], context: { API_TOKEN: 'super-secret-value' } }),
    (error) => error instanceof InitSafetyError && error.code === 'ERR_SECRET_INPUT',
  );
});
