import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_TARGETS, renderAdapter } from '../src/adapters.js';

const context = {
  project: {
    root: 'C:\\work\\sample',
    stack: { languages: ['javascript'], frameworks: ['node'], packageManagers: ['npm'] },
  },
  preset: 'project-onboarding',
};

test('all supported adapters render non-secret, host-neutral files', () => {
  for (const target of ADAPTER_TARGETS) {
    const rendered = renderAdapter(target, context);
    assert.equal(rendered.target, target);
    assert.ok(Array.isArray(rendered.files));
    assert.ok(rendered.files.length > 0);
    for (const file of rendered.files) {
      assert.equal(pathIsRelative(file.path), true);
      assert.equal(typeof file.content, 'string');
      assert.doesNotMatch(file.content, /super-secret|API_TOKEN=/i);
      assert.doesNotMatch(file.content, /install\s+(?:npm|pip|brew)|curl\s+https?:/i);
    }
  }
});

test('adapter aliases render the same target without claiming unavailable capabilities', () => {
  const codex = renderAdapter('codex', context);
  const skills = renderAdapter('agent-skills', context);
  assert.deepEqual(codex.files, skills.files);
  const codexSkill = codex.files.find((file) => file.path.endsWith('/SKILL.md'));
  assert.match(codexSkill.content, /^---\nname: worktree-proof\ndescription: .+\n---\n/);
  const claudeSkill = renderAdapter('claude', context).files.find((file) => file.path.endsWith('/SKILL.md'));
  assert.match(claudeSkill.content, /^---\nname: worktree-proof\ndescription: .+\n---\n/);
  assert.match(renderAdapter('ci', context).files[0].content, /workflow|CI|continuous integration/i);
  assert.match(renderAdapter('vscode', context).files[0].content, /tasks|WorktreeProof/i);
});

test('unknown adapter target fails closed', () => {
  assert.throws(
    () => renderAdapter('not-a-host', context),
    (error) => error?.code === 'ERR_UNKNOWN_ADAPTER',
  );
});

function pathIsRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value);
}
