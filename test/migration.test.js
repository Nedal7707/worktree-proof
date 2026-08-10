import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyLocalMigration,
  canonicalJson,
  createIntegrationManifest,
  MigrationSafetyError,
  planLocalMigration,
  rollbackLocalMigration,
  sha256,
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

function forgePlan(plan, writes) {
  const body = { ...plan, writes };
  delete body.planHash;
  return { ...body, planHash: sha256(canonicalJson(body)) };
}

test('self-consistent forged plans cannot add writes outside regenerated artifact outputs', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const original = plan.writes[0];
    const contentHash = original.contentHash;
    const markerObject = {
      contentHash,
      manifestHash: plan.artifact.manifestHash,
      owner: 'worktree-proof-owned:v1',
      path: '.codex/evil.txt',
      protocol: 'worktreeproof',
      protocolVersion: '1.0',
    };
    const forgedWrite = {
      ...original,
      path: '.codex/evil.txt',
      markerPath: '.codex/evil.txt.worktree-proof-owner',
      markerContent: `${canonicalJson(markerObject)}\n`,
      markerHash: sha256(`${canonicalJson(markerObject)}\n`),
      mode: 'create',
      existing: false,
      existingHash: null,
    };
    await assert.rejects(
      () => applyLocalMigration(forgePlan(plan, [...plan.writes, forgedWrite]), { confirm: true }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_PLAN',
    );
    await assert.rejects(access(path.join(home, '.codex', 'evil.txt')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('noncanonical ownership marker bytes are refused', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const write = plan.writes[0];
    const markerObject = JSON.parse(write.markerContent);
    const noncanonical = `${JSON.stringify({ protocolVersion: markerObject.protocolVersion, protocol: markerObject.protocol, path: markerObject.path, owner: markerObject.owner, manifestHash: markerObject.manifestHash, contentHash: markerObject.contentHash })}\n`;
    const forgedWrite = { ...write, markerContent: noncanonical, markerHash: sha256(noncanonical) };
    await assert.rejects(
      () => applyLocalMigration(forgePlan(plan, [forgedWrite]), { confirm: true }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_OWNER_MARKER',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('legitimate ./safe artifact paths normalize to safe', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: { manifest, files: [{ path: './safe', content: 'safe' }] } });
    assert.equal(plan.writes[0].path, '.codex/safe');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('apply persists an fsynced migration journal before mutation and rollback is idempotent', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const receipt = await applyLocalMigration(plan, { confirm: true });
    const backupFiles = await readdir(receipt.backupRoot, { recursive: true });
    assert.ok(backupFiles.some((entry) => entry.toString().includes('journal')));
    const first = await rollbackLocalMigration(receipt);
    assert.equal(first.ok, true);
    const second = await rollbackLocalMigration(receipt);
    assert.equal(second.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('rollback marker restore failure is resumable on retry', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const receipt = await applyLocalMigration(plan, { confirm: true });
    let fail = true;
    await assert.rejects(
      () => rollbackLocalMigration(receipt, { hooks: { restoreMarker: async () => { if (fail) throw new Error('marker restore'); } } }),
      MigrationSafetyError,
    );
    fail = false;
    assert.equal((await rollbackLocalMigration(receipt)).ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('pre-rename parent swap is rejected without an out-of-root write', async () => {
  const home = await tempHome();
  const outside = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const parent = path.join(home, '.codex');
    let swapped = false;
    await assert.rejects(
      () => applyLocalMigration(plan, {
        confirm: true,
        hooks: { beforeRename: async () => { if (!swapped) { swapped = true; await rm(parent, { recursive: true, force: true }); await symlink(outside, parent, 'junction'); } } },
      }),
      MigrationSafetyError,
    );
    await assert.rejects(access(path.join(outside, 'worktree-proof.manifest.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
