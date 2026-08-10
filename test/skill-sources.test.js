import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('optional skill manifest records the pinned upstream without enabling it', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'integrations/skill-sources.json'), 'utf8'));
  assert.equal(manifest.$schema, '../schemas/skill-source.schema.json');
  assert.equal(manifest.sources.length, 1);
  const source = manifest.sources[0];
  assert.equal(source.repository, 'amElnagdy/delegate-skills');
  assert.equal(source.url, 'https://github.com/amElnagdy/delegate-skills');
  assert.equal(source.license, 'MIT');
  assert.equal(source.upstreamRef, 'f9f2528525b820e7fd24724f87d6821c0e272947');
  assert.match(source.purpose, /optional/i);
  assert.equal(source.provenance.kind, 'upstream');
  assert.match(source.install.list, /^npx skills add .* --list$/);
  assert.match(source.install.selective, /^npx skills add .* --skill <skill-name>$/);
  assert.deepEqual(source.policy, {
    vendored: false,
    autoInstall: false,
    authenticate: false,
    execute: false,
  });
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

