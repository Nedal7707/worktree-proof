import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ManifestError,
  createIntegrationManifest,
  renderClientPreview,
  validateIntegrationManifest,
} from '../src/index.js';
import { buildInitPlan } from '../src/init.js';
import { runCli } from '../src/cli.js';

test('all client previews preserve one manifest and never select a model', () => {
  const manifest = createIntegrationManifest({
    client: 'any-cli',
    capabilities: ['scope.validate'],
    scope: ['src/'],
  });
  for (const target of ['generic', 'codex', 'claude']) {
    const preview = renderClientPreview(target, manifest);
    assert.equal(preview.manifestHash, manifest.manifestHash);
    assert.doesNotMatch(JSON.stringify(preview), /model|reasoning|token|cookie|password/i);
  }
});

test('manifest validation is closed before normalization', () => {
  const valid = createIntegrationManifest({ client: 'any-cli', capabilities: ['scope.validate'], scope: ['src/'] });
  assert.throws(
    () => validateIntegrationManifest({ ...valid, protocol: 'other' }),
    (error) => error instanceof ManifestError && error.code === 'ERR_INVALID_PROTOCOL',
  );
  assert.throws(
    () => validateIntegrationManifest({ ...valid, protocolVersion: '9.9' }),
    (error) => error instanceof ManifestError && error.code === 'ERR_INVALID_PROTOCOL_VERSION',
  );
  assert.throws(
    () => validateIntegrationManifest({ ...valid, extra: true }),
    (error) => error instanceof ManifestError && error.code === 'ERR_UNKNOWN_MANIFEST_FIELD',
  );
  assert.throws(
    () => validateIntegrationManifest({ ...valid, manifestHash: 'not-a-hash' }),
    (error) => error instanceof ManifestError && error.code === 'ERR_INVALID_MANIFEST_HASH',
  );
});

test('public client fixtures are exact, explicit verification records', async () => {
  const root = path.resolve('examples', 'client-fixtures');
  for (const target of ['generic', 'codex', 'claude']) {
    const fixture = JSON.parse(await readFile(path.join(root, `${target}.json`), 'utf8'));
    assert.equal(fixture.target, target);
    assert.equal(fixture.verification?.status, 'public-fixture');
    assert.equal(fixture.verification?.invokesClient, false);
    const manifest = validateIntegrationManifest(fixture.manifest);
    assert.equal(fixture.manifestHash, manifest.manifestHash);
    assert.equal(fixture.manifestHash, fixture.verification.manifestHash);
    const preview = renderClientPreview(target, manifest);
    assert.equal(preview.manifestHash, fixture.manifestHash);
    assert.ok(!Object.hasOwn(preview, 'fixture'));
  }
});

test('manifest template remains runtime/schema closed and hash-valid', async () => {
  const template = JSON.parse(await readFile(path.resolve('templates', 'worktree-proof.manifest.json'), 'utf8'));
  const schema = JSON.parse(await readFile(path.resolve('schemas', 'integration-manifest.schema.json'), 'utf8'));
  assert.deepEqual(Object.keys(template).sort(), ['capabilities', 'client', 'manifestHash', 'protocol', 'protocolVersion', 'scope']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(template).sort());
  assert.deepEqual(validateIntegrationManifest(template), template);
});

test('init routes public manifest output through the portable preview adapter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-init-route-'));
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: ['scope.validate'], scope: ['src'] });
    const plan = await buildInitPlan({ repo: root, targets: ['agent-skills'], manifest });
    assert.equal(plan.manifest.manifestHash, manifest.manifestHash);
    assert.equal(plan.previews[0].target, 'codex');
    assert.equal(plan.previews[0].manifestHash, manifest.manifestHash);
    assert.ok(plan.writes.some((write) => write.path === '.worktree-proof/worktree-proof.manifest.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI init loads and validates an explicit manifest before planning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-cli-init-manifest-'));
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: ['scope.validate'], scope: ['src'] });
    await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
    let captured;
    const output = [];
    const result = await runCli(['init', 'preview', '--repo', root, '--manifest', 'manifest.json', '--json'], {
      repo: root,
      io: { stdout: (value) => output.push(value), stderr: () => {} },
      deps: {
        init: {
          buildInitPlan: async (options) => { captured = options; return { dryRun: true, writes: [] }; },
          applyInitPlan: async () => ({ dryRun: true }),
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(captured.manifest.manifestHash, manifest.manifestHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
