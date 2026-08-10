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
    const artifact = { ...manifest, files: [{ path: '../placeholder', content: 'do not overwrite' }] };
    await assert.rejects(
      () => planLocalMigration({ home, clients: ['codex'], artifact }),
      (error) => error instanceof MigrationSafetyError && error.code === 'ERR_PATH_ESCAPE',
    );
    await assert.rejects(access(target));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
