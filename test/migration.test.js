import assert from 'node:assert/strict';
import { access, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

function rehashPlan(plan, patch = {}) {
  const body = { ...plan, ...patch };
  delete body.planHash;
  return { ...body, planHash: sha256(canonicalJson(body)) };
}

function rehashReceipt(receipt, patch = {}) {
  const body = { ...receipt, ...patch };
  delete body.receiptHash;
  return { ...body, receiptHash: sha256(canonicalJson(body)) };
}

test('custom client roots remain closed in the plan and apply to those roots', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: [{ name: 'codex', root: './custom-codex' }], artifact: manifest });
    assert.deepEqual(plan.clients, [{ name: 'codex', root: 'custom-codex' }]);
    assert.equal(plan.writes[0].path, 'custom-codex/worktree-proof.manifest.json');
    await applyLocalMigration(plan, { confirm: true });
    assert.equal((await readFile(path.join(home, 'custom-codex', 'worktree-proof.manifest.json'), 'utf8')).length > 0, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('migration schema mirrors the closed client-root and artifact-filter plan contract', async () => {
  const schema = JSON.parse(await readFile(path.resolve('schemas/migration-plan.schema.json'), 'utf8'));
  const clientSchema = schema.properties.clients.items;
  const fileSchema = schema.properties.artifact.properties.files.items;
  assert.equal(clientSchema.additionalProperties, false);
  assert.deepEqual([...clientSchema.required].sort(), ['name', 'root']);
  assert.equal(fileSchema.additionalProperties, false);
  assert.deepEqual([...fileSchema.required].sort(), ['clients', 'contentHash', 'path']);
  assert.equal(fileSchema.properties.clients.oneOf[0].type, 'null');
  assert.equal(fileSchema.properties.clients.oneOf[1].maxItems, 20);
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: [{ name: 'codex', root: './custom' }], artifact: { manifest, files: [{ path: 'filtered.txt', content: 'safe', clients: ['codex'] }] } });
    await assert.rejects(
      () => applyLocalMigration(rehashPlan(plan, { clients: ['codex'] }), { confirm: true }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_PLAN',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('per-file client filters are retained and apply only to selected roots', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const artifact = {
      manifest,
      files: [
        { path: 'shared.txt', content: 'shared' },
        { path: 'codex-only.txt', content: 'codex', clients: ['codex'] },
      ],
    };
    const plan = await planLocalMigration({ home, clients: ['codex', 'claude'], artifact });
    assert.deepEqual(plan.artifact.files.map((file) => file.clients), [['codex'], null]);
    assert.deepEqual(plan.writes.map((write) => write.path), ['.claude/shared.txt', '.codex/codex-only.txt', '.codex/shared.txt']);
    await applyLocalMigration(plan, { confirm: true });
    await access(path.join(home, '.codex', 'codex-only.txt'));
    await assert.rejects(access(path.join(home, '.claude', 'codex-only.txt')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('forged self-consistent root redirects fail before any target write', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: [{ name: 'codex', root: '.codex' }], artifact: manifest });
    const forgedMarker = JSON.parse(plan.writes[0].markerContent);
    forgedMarker.path = '.redirected/worktree-proof.manifest.json';
    const forgedMarkerContent = `${canonicalJson(forgedMarker)}\n`;
    const forged = rehashPlan(plan, {
      writes: plan.writes.map((write) => ({ ...write, path: '.redirected/worktree-proof.manifest.json', markerPath: '.redirected/worktree-proof.manifest.json.worktree-proof-owner', markerContent: forgedMarkerContent, markerHash: sha256(forgedMarkerContent) })),
    });
    await assert.rejects(
      () => applyLocalMigration(forged, { confirm: true }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_PLAN',
    );
    await assert.rejects(access(path.join(home, '.redirected', 'worktree-proof.manifest.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('plan and receipt hard bounds reject oversized clients, artifacts, writes, and backups', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    await assert.rejects(
      () => planLocalMigration({ home, clients: Array.from({ length: 21 }, (_, index) => `client-${index}`), artifact: manifest }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_CLIENTS',
    );
    await assert.rejects(
      () => planLocalMigration({ home, clients: ['codex'], artifact: { manifest, files: Array.from({ length: 101 }, (_, index) => ({ path: `file-${index}.txt`, content: 'safe' })) } }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_ARTIFACT_LIMIT',
    );
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const receipt = await applyLocalMigration(plan, { confirm: true });
    const entries = Array.from({ length: 101 }, (_, index) => ({ ...receipt.backups[0], path: `.codex/oversized-${index}.txt`, markerPath: `.codex/oversized-${index}.txt.worktree-proof-owner`, existed: false, backupPath: null, markerBackupPath: null, sha256: null, markerSha256: null }));
    await assert.rejects(
      () => rollbackLocalMigration(rehashReceipt(receipt, { written: entries.map((entry) => entry.path), backups: entries })),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_ROLLBACK',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('deterministic journal collisions preserve arbitrary or stale bytes', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const backupRoot = path.join(home, '.worktree-proof', 'backups');
    await (await import('node:fs/promises')).mkdir(backupRoot, { recursive: true });
    const journalPath = path.join(backupRoot, `migration-${plan.planHash}.journal.json`);
    const stale = Buffer.from('{"status":"stale","owner":"not-worktree-proof"}\n', 'utf8');
    await writeFile(journalPath, stale);
    await assert.rejects(
      () => applyLocalMigration(plan, { confirm: true }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_JOURNAL_COLLISION',
    );
    assert.deepEqual(await readFile(journalPath), stale);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('forward-slash UNC and device spellings are refused for all migration roots', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    for (const unsafe of ['//server/share', '//?/C:/device', '//./pipe/device']) {
      await assert.rejects(() => planLocalMigration({ home: unsafe, clients: ['codex'], artifact: manifest }), (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_HOME');
      await assert.rejects(() => planLocalMigration({ home, clients: [{ name: 'codex', root: unsafe }], artifact: manifest }), (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_PATH');
    }
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    await assert.rejects(() => applyLocalMigration(plan, { confirm: true, backupRoot: '//server/share' }), (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_BACKUP_ROOT');
    const receipt = await applyLocalMigration(plan, { confirm: true });
    for (const unsafe of ['//server/share', '//?/C:/device', '//./pipe/device']) {
      await assert.rejects(() => rollbackLocalMigration(rehashReceipt(receipt, { backupRoot: unsafe })), (error) => error instanceof MigrationSafetyError && error.code === 'ERR_INVALID_ROLLBACK');
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('rollback acquires the migration lock and refuses contention', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    const receipt = await applyLocalMigration(plan, { confirm: true });
    const lock = await open(path.join(receipt.backupRoot, '.migration.lock'), 'wx', 0o600);
    await lock.writeFile('worktree-proof-owned:v1\n');
    await lock.close();
    await assert.rejects(() => rollbackLocalMigration(receipt), (error) => error instanceof MigrationSafetyError && error.code === 'ERR_MIGRATION_LOCK');
    await rm(path.join(receipt.backupRoot, '.migration.lock'), { force: true });
    assert.equal((await rollbackLocalMigration(receipt)).ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('durable recovery failures return only the journal-persisted recovery id', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    let failure;
    await assert.rejects(
      () => applyLocalMigration(plan, {
        confirm: true,
        hooks: {
          marker: async () => { throw new Error('marker write'); },
          rollback: async () => { throw new Error('rollback write'); },
          persistRecovery: async () => { throw new Error('recovery durability'); },
        },
      }),
      (error) => { failure = error; return error instanceof MigrationSafetyError && error.code === 'ERR_RECOVERY_REQUIRED'; },
    );
    assert.match(failure.recoveryReceipt, /^recovery-[a-f0-9]{64}$/u);
    assert.doesNotMatch(failure.recoveryReceipt, /^unpersisted-/u);
    const journal = JSON.parse(await readFile(path.join(home, '.worktree-proof', 'backups', `migration-${plan.planHash}.journal.json`), 'utf8'));
    assert.equal(journal.recoveryId, failure.recoveryReceipt);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('interrupted marker restore preserves existing target bytes and resumes idempotently', async () => {
  const home = await tempHome();
  try {
    const first = createIntegrationManifest({ client: 'any-cli', capabilities: ['first'], scope: ['src'] });
    const firstPlan = await planLocalMigration({ home, clients: ['codex'], artifact: first });
    await applyLocalMigration(firstPlan, { confirm: true });
    const target = path.join(home, '.codex', 'worktree-proof.manifest.json');
    const before = await readFile(target);
    const second = createIntegrationManifest({ client: 'any-cli', capabilities: ['second'], scope: ['test'] });
    const secondPlan = await planLocalMigration({ home, clients: ['codex'], artifact: second });
    const receipt = await applyLocalMigration(secondPlan, { confirm: true });
    let fail = true;
    await assert.rejects(() => rollbackLocalMigration(receipt, { hooks: { restoreMarker: async () => { if (fail) throw new Error('marker restore'); } } }), MigrationSafetyError);
    assert.deepEqual(await readFile(target), before);
    fail = false;
    assert.equal((await rollbackLocalMigration(receipt)).ok, true);
    assert.deepEqual(await readFile(target), before);
    assert.equal((await rollbackLocalMigration(receipt)).ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('explicit recover/resume API completes an interrupted apply without self-deadlocking', async () => {
  const home = await tempHome();
  try {
    const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: [], scope: ['src'] });
    const plan = await planLocalMigration({ home, clients: ['codex'], artifact: manifest });
    let failure;
    await assert.rejects(() => applyLocalMigration(plan, {
      confirm: true,
      hooks: { marker: async () => { throw new Error('marker write'); }, rollback: async () => { throw new Error('rollback write'); } },
    }), (error) => { failure = error; return error instanceof MigrationSafetyError && error.code === 'ERR_RECOVERY_REQUIRED'; });
    const migration = await import('../src/index.js');
    const resume = migration.resumeLocalMigration ?? migration.recoverLocalMigration;
    assert.equal(typeof resume, 'function');
    assert.equal((await resume(failure.recoveryReceipt, { backupRoot: path.join(home, '.worktree-proof', 'backups') })).ok, true);
    await assert.rejects(access(path.join(home, '.codex', 'worktree-proof.manifest.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
