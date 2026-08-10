import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAdapter } from '../src/adapters.js';

const context = {
  project: { root: 'C:\\workspace\\demo', stack: { languages: ['javascript'] } },
  preset: 'project-onboarding',
};

test('Codex and Claude adapters share the WorktreeProof protocol without invoking each other', () => {
  const codex = renderAdapter('agent-skills', context);
  const claude = renderAdapter('claude-code', context);
  const codexText = codex.files.map((file) => file.content).join('\n');
  const claudeText = claude.files.map((file) => file.content).join('\n');
  for (const text of [codexText, claudeText]) {
    assert.match(text, /\.worktree-proof\//);
    assert.match(text, /laneId/);
    assert.match(text, /fileScope/);
    assert.match(text, /resource-budget/);
    assert.match(text, /closure-receipt\.schema\.json/);
    assert.doesNotMatch(text, /(?:invoke|launch)\s+(?:Claude|Codex)|https?:\/\//i);
  }
  assert.ok(codex.files.some((file) => file.path.includes('.agents/skills')));
  assert.ok(claude.files.some((file) => file.path === 'CLAUDE.md'));
  assert.notDeepEqual(codex.files.map((file) => file.path), claude.files.map((file) => file.path));
});
