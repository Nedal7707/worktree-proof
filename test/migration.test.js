import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyLocalMigration,
  createIntegrationManifest,
  MigrationSafetyError,
  planLocalMigration,
  rollbackLocalMigration,
} from '../src/index.js';
import { runCli } from '../src/cli.js';

async function tempHome() {
  return mkdtemp(path.join(os.tmpdir(), 'worktree-proof-migration-'));
}

test('migration planning is read-only and apply defaults to a preview', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: ['scope.validate'], scope: ['src/'] });
    const plan = await planLocalMigration({ home, clients: ['codex', 'claude'], artifact: manifest });
    assert.equal(plan.preview, true);
    assert.equal(plan.writes.length, 2);
    const preview = await applyLocalMigration(plan);
    assert.equal(preview.preview, true);
    await assert.rejects(access(path.join(home, '.codex', 'worktree-proof.manifest.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('confirmed migration backs up and rollback restores byte-identical content', async () => {
  const home = await tempHome();
  try {
    const first = createIntegrationManifest({ client: 'any-cli', capabilities: ['scope.validate'], scope: ['src/'] });
    const firstPlan = await planLocalMigration({ home, clients: ['codex'], artifact: first });
    const firstReceipt = await applyLocalMigration(firstPlan, { confirm: true });
    assert.equal(firstReceipt.confirmed, true);
    const target = path.join(home, '.codex', 'worktree-proof.manifest.json');
    const before = await readFile(target);

    const second = createIntegrationManifest({ client: 'any-cli', capabilities: ['receipt.validate'], scope: ['test/'] });
    const secondPlan = await planLocalMigration({ home, clients: ['codex'], artifact: second });
    const secondReceipt = await applyLocalMigration(secondPlan, { confirm: true });
    assert.notDeepEqual(await readFile(target), before);
    await rollbackLocalMigration(secondReceipt);
    assert.deepEqual(await readFile(target), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('unowned collisions and unsafe paths are rejected before writing', async () => {
  const home = await tempHome();
  try {
    const target = path.join(home, '.codex');
    await writeFile(path.join(home, 'placeholder'), 'keep', 'utf8');
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['.'] });
    const artifact = { manifest, files: [{ path: '../placeholder', content: 'do not overwrite' }] };
    await assert.rejects(
      () => planLocalMigration({ home, clients: ['codex'], artifact }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_PATH_ESCAPE',
    );
    await assert.rejects(access(target));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('forged and incomplete plans are rejected before any mutation', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    for (const forged of [
      { ...plan, protocol: 'other' },
      { ...plan, protocolVersion: '0.1' },
      { ...plan, preview: false },
      { ...plan, artifact: { ...plan.artifact, manifestHash: '0'.repeat(64) } },
      { ...plan, unknown: true },
      { ...plan, planHash: '0'.repeat(64) },
      { ...plan, writes: [] },
    ]) {
      await assert.rejects(
        () => applyLocalMigration(forged, { confirm: true }),
        (error) => error instanceof MigrationSafetyError,
      );
    }
    await assert.rejects(access(path.join(home, '.codex', 'worktree-proof.manifest.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('ownership markers bind protocol, target, content, and manifest', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const receipt = await applyLocalMigration(plan, { confirm: true });
    const target = path.join(home, '.codex', 'worktree-proof.manifest.json');
    const marker = `${target}.worktree-proof-owner`;
    await writeFile(marker, 'worktree-proof-owned:v1\npath=.codex/worktree-proof.manifest.json\n', 'utf8');
    const replacement = createIntegrationManifest({ client: 'any-cli', capabilities: ['scope.validate'], scope: ['src'] });
    await assert.rejects(
      () => planLocalMigration({ home, clients: ['codex'], artifact: replacement }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_OWNER_MARKER',
    );
    // The malformed marker intentionally leaves the installation unrollbackable
    // until an owner restores the marker bytes from the receipt.
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('rollback refuses forged receipts, backup escapes, and current-byte drift', async () => {
  const home = await tempHome();
  const outside = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const receipt = await applyLocalMigration(plan, { confirm: true });
    await writeFile(path.join(outside, 'secret.bin'), 'outside', 'utf8');
    await assert.rejects(
      () => rollbackLocalMigration({ ...receipt, backups: [{ ...receipt.backups[0], backupPath: path.join(outside, 'secret.bin') }] }),
      (error) => error instanceof MigrationSafetyError,
    );
    await writeFile(path.join(home, '.codex', 'worktree-proof.manifest.json'), 'drift', 'utf8');
    await assert.rejects(
      () => rollbackLocalMigration(receipt),
      (error) => error instanceof MigrationSafetyError,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('path validation rejects relative, traversal, reserved, drive-relative, and ADS forms', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    await assert.rejects(() => planLocalMigration({ home: 'C:relative-home', clients: ['codex'], artifact: manifest }), MigrationSafetyError);
    for (const filePath of ['C:relative', 'safe:stream', 'CON', 'NUL', 'PRN', 'COM1', 'LPT1', '../escape']) {
      await assert.rejects(
        () => planLocalMigration({ home, clients: ['codex'], artifact: { manifest, files: [{ path: filePath, content: 'safe' }] } }),
        MigrationSafetyError,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('automatic rollback failure returns recovery-required evidence', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    await assert.rejects(
      () => applyLocalMigration(plan, {
        confirm: true,
        hooks: { write: async () => { throw new Error('injected write failure'); }, rollback: async () => { throw new Error('injected rollback failure'); } },
      }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_RECOVERY_REQUIRED' && typeof error.recoveryReceipt === 'string',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('CLI migration errors and results never expose absolute private paths', async () => {
  const home = await tempHome();
  try {
    const output = [];
    const error = [];
    const missing = path.join(home, 'private-artifact.json');
    const result = await runCli(['migrate', 'preview', '--home', home, '--artifact', missing], {
      repo: home,
      io: { stdout: (value) => output.push(value), stderr: (value) => error.push(value) },
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(error.join('\n'), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
