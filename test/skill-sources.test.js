import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('optional skill manifest records the pinned upstream without enabling it', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'integrations/skill-sources.json'), 'utf8'));
  assert.equal(manifest.$schema, '../schemas/skill-source.schema.json');
  // Now 3 sources: delegate-skills (upstream) + 2 local opencode plugins
  assert.equal(manifest.sources.length, 3);
  
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
  
  const computerPlugin = manifest.sources.find(s => s.id === 'opencode-plugin-computer-use');
  assert.ok(computerPlugin, 'opencode-plugin-computer-use should exist');
  assert.equal(computerPlugin.provenance.kind, 'local');
  assert.equal(computerPlugin.policy.vendored, true);
  assert.equal(computerPlugin.policy.execute, true);
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

