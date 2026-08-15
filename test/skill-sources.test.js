import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('optional skill manifest records the pinned upstream without enabling it', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'integrations/skill-sources.json'), 'utf8'));
  assert.equal(manifest.$schema, '../schemas/skill-source.schema.json');
  // 13 sources: 7 upstream skill libraries + 5 local opencode plugins +
  // 1 local complete-workflow skill
  assert.equal(manifest.sources.length, 13);

  // Verify upstream skill libraries are pinned and never auto-installed
  for (const id of ['delegate-skills', 'superpowers', 'anthropic-official-skills', 'vercel-official-skills', 'openai-codex-official', 'planning-with-files', 'claude-mem']) {
    const source = manifest.sources.find(s => s.id === id);
    assert.ok(source, `${id} should exist`);
    assert.equal(source.provenance.kind, 'upstream');
    assert.equal(source.policy.vendored, false);
    assert.equal(source.policy.autoInstall, false);
    assert.equal(source.policy.execute, false);
    assert.ok(source.upstreamRef && /^[0-9a-f]{40}$/.test(source.upstreamRef), `${id} must pin a commit SHA`);
  }
  
  // Find delegate-skills source
  const delegateSource = manifest.sources.find(s => s.id === 'delegate-skills');
  assert.ok(delegateSource, 'delegate-skills source should exist');
  assert.equal(delegateSource.repository, 'amElnagdy/delegate-skills');
  assert.equal(delegateSource.url, 'https://github.com/amElnagdy/delegate-skills');
  assert.equal(delegateSource.license, 'MIT');
  assert.equal(delegateSource.upstreamRef, 'f9f2528525b820e7fd24724f87d6821c0e272947');
  assert.match(delegateSource.purpose, /optional/i);
  assert.equal(delegateSource.provenance.kind, 'upstream');
  assert.match(delegateSource.install.list, /^npx skills add .* --list$/);
  assert.match(delegateSource.install.selective, /^npx skills add .* --skill <skill-name>$/);
  assert.deepEqual(delegateSource.policy, {
    vendored: false,
    autoInstall: false,
    authenticate: false,
    execute: false,
  });
  
  // Verify local opencode plugins
  const chromePlugin = manifest.sources.find(s => s.id === 'opencode-plugin-chrome-use');
  assert.ok(chromePlugin, 'opencode-plugin-chrome-use should exist');
  assert.equal(chromePlugin.provenance.kind, 'local');
  assert.equal(chromePlugin.policy.vendored, true);
  assert.equal(chromePlugin.policy.execute, true);
  assert.equal(chromePlugin.policy.autoInstall, false);
  
  const computerPlugin = manifest.sources.find(s => s.id === 'opencode-plugin-computer-use');
  assert.ok(computerPlugin, 'opencode-plugin-computer-use should exist');
  assert.equal(computerPlugin.provenance.kind, 'local');
  assert.equal(computerPlugin.policy.vendored, true);
  assert.equal(computerPlugin.policy.execute, true);
  assert.equal(computerPlugin.policy.autoInstall, false);
  
  const goalPlanPlugin = manifest.sources.find(s => s.id === 'opencode-plugin-goal-plan');
  assert.ok(goalPlanPlugin, 'opencode-plugin-goal-plan should exist');
  assert.equal(goalPlanPlugin.provenance.kind, 'local');
  assert.equal(goalPlanPlugin.policy.vendored, true);
  assert.equal(goalPlanPlugin.policy.execute, true);
  assert.equal(goalPlanPlugin.policy.autoInstall, false);

  const wpPlugin = manifest.sources.find(s => s.id === 'opencode-plugin-worktree-proof');
  assert.ok(wpPlugin, 'opencode-plugin-worktree-proof should exist');
  assert.equal(wpPlugin.provenance.kind, 'local');
  assert.equal(wpPlugin.policy.vendored, true);
  assert.equal(wpPlugin.policy.execute, true);
  assert.equal(wpPlugin.policy.autoInstall, false);

  const enforcementPlugin = manifest.sources.find(s => s.id === 'opencode-plugin-workflow-enforcement');
  assert.ok(enforcementPlugin, 'opencode-plugin-workflow-enforcement should exist');
  assert.equal(enforcementPlugin.provenance.kind, 'local');
  assert.equal(enforcementPlugin.policy.vendored, true);
  assert.equal(enforcementPlugin.policy.execute, true);

  const completeWorkflowSkill = manifest.sources.find(s => s.id === 'complete-workflow-skill');
  assert.ok(completeWorkflowSkill, 'complete-workflow-skill should exist');
  assert.equal(completeWorkflowSkill.provenance.kind, 'local');
  assert.equal(completeWorkflowSkill.policy.vendored, true);
});

test('optional library documentation distinguishes upstream provenance and policy', async () => {
  const doc = await readFile(path.join(projectRoot, 'docs/OPTIONAL-SKILL-LIBRARIES.md'), 'utf8');
  for (const required of [
    'amElnagdy/delegate-skills',
    'MIT',
    'f9f2528525b820e7fd24724f87d6821c0e272947',
    'https://github.com/amElnagdy/delegate-skills',
    'npx skills add',
    '--list',
    '--skill <skill-name>',
    'must not vendor',
    'auto-install',
    'authenticate',
    'execute',
  ]) {
    assert.ok(doc.includes(required), `documentation should include ${required}`);
  }
  assert.match(doc, /upstream.*authorship|authored.*upstream/i);
});

test('skill source schema is valid JSON and matches the manifest contract', async () => {
  const schema = JSON.parse(await readFile(path.join(projectRoot, 'schemas/skill-source.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.required, ['$schema', 'sources']);
  assert.deepEqual(schema.$defs.source.required, [
    'id',
    'repository',
    'url',
    'license',
    'upstreamRef',
    'purpose',
    'provenance',
    'install',
    'policy',
  ]);
  assert.deepEqual(schema.$defs.source.properties.policy.properties, {
    vendored: { const: false },
    autoInstall: { const: false },
    authenticate: { const: false },
    execute: { const: false },
  });
});
