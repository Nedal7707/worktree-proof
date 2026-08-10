import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import {
  chooseResourceProfile,
  DEFAULT_REQUESTED_CONCURRENCY,
  MAX_REQUESTED_CONCURRENCY,
  planProjectCleanup,
  planSessionGuard,
  PUBLIC_MAX_CONCURRENCY,
  recommendConcurrency,
  scanResources,
  summarizeResources,
} from '../src/resources.js';

const bytes = (gib) => gib * 1024 ** 3;

function mockedOs({ platform = 'linux', logicalCount = 4, load = [0.5, 0.4, 0.3], total = bytes(8), free = bytes(4) } = {}) {
  return {
    platform,
    cpus: () => Array.from({ length: logicalCount }, () => ({})),
    loadavg: () => load,
    totalmem: () => total,
    freemem: () => free,
  };
}

async function makeFixture() {
  const root = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'worktree-proof-resource-'));
  await mkdir(nodePath.join(root, '.cache'), { recursive: true });
  await mkdir(nodePath.join(root, 'build'), { recursive: true });
  await mkdir(nodePath.join(root, '.git', 'worktrees'), { recursive: true });
  await writeFile(nodePath.join(root, 'README.txt'), 'fixture');
  await writeFile(nodePath.join(root, '.cache', 'cache.bin'), 'cache');
  await writeFile(nodePath.join(root, 'build', 'artifact.bin'), 'artifact');
  return root;
}

test('scans mocked Linux metrics and reports bounded footprint categories', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanResources({
      repoPath: root,
      os: mockedOs(),
      nodeMemory: { rss: bytes(1), heapTotal: 1000, heapUsed: 500, external: 20 },
      disk: { totalBytes: bytes(100), freeBytes: bytes(80) },
      concurrency: 2,
      maxDepth: 5,
      maxEntries: 100,
      now: '2026-08-10T00:00:00.000Z',
    });
    assert.equal(scan.platform, 'linux');
    assert.equal(scan.cpu.logicalCount, 4);
    assert.equal(scan.cpu.load, 0.5);
    assert.equal(scan.memory.totalBytes, bytes(8));
    assert.equal(scan.memory.pressureRatio, 0.5);
    assert.equal(scan.node.heapPressureRatio, 0.5);
    assert.equal(scan.disk.freeBytes, bytes(80));
    assert.equal(scan.concurrency.current, 2);
    assert.equal(scan.footprint.status, 'ok');
    assert.ok(scan.footprint.cache.bytes >= Buffer.byteLength('cache'));
    assert.ok(scan.footprint.build.bytes >= Buffer.byteLength('artifact'));
    assert.match(summarizeResources(scan), /CPU 4 logical/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mocked Windows low RAM and disk select low-resource and constrain workers', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanResources({
      repoPath: root,
      os: mockedOs({ platform: 'win32', logicalCount: 16, load: [0.1, 0.1, 0.1], total: bytes(4), free: bytes(0.25) }),
      disk: { totalBytes: bytes(1), freeBytes: bytes(0.05) },
      nodeMemory: { heapTotal: 100, heapUsed: 10 },
      concurrency: 0,
      maxEntries: 100,
    });
    assert.equal(scan.platform, 'win32');
    assert.equal(chooseResourceProfile(scan).name, 'low-resource');
    assert.equal(recommendConcurrency(scan, { kind: 'cpu', memoryPerWorkerBytes: bytes(1) }), 0);
    assert.equal(recommendConcurrency(scan, { kind: 'cpu', memoryPerWorkerBytes: bytes(0.1) }), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows zero load averages are unavailable and recommendations stay capped', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanResources({
      repoPath: root,
      os: mockedOs({ platform: 'win32', logicalCount: 32, load: [0, 0, 0], total: bytes(64), free: bytes(32) }),
      disk: { totalBytes: bytes(100), freeBytes: bytes(90) },
      maxEntries: 100,
    });
    assert.equal(scan.cpu.loadAvailable, false);
    assert.equal(scan.cpu.normalizedLoad, null);
    assert.ok(recommendConcurrency(scan, { kind: 'io', min: 100 }) <= PUBLIC_MAX_CONCURRENCY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RAM and disk safety caps override a caller minimum', () => {
  const scan = {
    cpu: { logicalCount: 32, normalizedLoad: 0.1 },
    memory: { freeBytes: bytes(0.5), pressureRatio: 0.96 },
    disk: { pressureRatio: 0.99 },
    concurrency: { current: 0 },
  };
  assert.equal(recommendConcurrency(scan, { min: 100, memoryPerWorkerBytes: bytes(1) }), 0);
});

test('huge directories are bounded without reading file contents', async () => {
  const root = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'worktree-proof-resource-huge-'));
  try {
    await mkdir(nodePath.join(root, 'cache'), { recursive: true });
    for (let index = 0; index < 30; index += 1) await writeFile(nodePath.join(root, 'cache', `item-${index}.txt`), `item-${index}`);
    const scan = await scanResources({
      repoPath: root,
      os: mockedOs(),
      disk: { totalBytes: 10_000, freeBytes: 9_000 },
      maxEntries: 5,
      maxDepth: 10,
    });
    assert.equal(scan.footprint.bounded, true);
    assert.equal(scan.footprint.truncated, true);
    assert.equal(scan.footprint.status, 'partial');
    assert.ok(scan.footprint.scannedEntries <= 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('path escape and symlink entries fail closed', async (t) => {
  const root = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'worktree-proof-resource-escape-'));
  try {
    const escapeFs = {
      lstat: async (candidate) => candidate === root ? { isDirectory: () => true } : (() => { throw Object.assign(new Error('outside'), { code: 'ENOENT' }); })(),
      readdir: async () => [nodePath.join('..', 'outside')],
      statfs: async () => ({ blocks: 10, bavail: 5, bsize: 1 }),
    };
    const escaped = await scanResources({ repoPath: root, fs: escapeFs, os: mockedOs(), maxEntries: 10 });
    assert.equal(escaped.footprint.status, 'blocked');
    assert.ok(escaped.footprint.escapingPaths.length > 0);

    const target = nodePath.join(root, 'target.txt');
    const link = nodePath.join(root, 'link.txt');
    await writeFile(target, 'do not read');
    try {
      await (await import('node:fs/promises')).symlink(target, link);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.diagnostic('symlink creation unavailable; escape branch still verified');
        return;
      }
      throw error;
    }
    const symlinkScan = await scanResources({ repoPath: root, os: mockedOs(), disk: { totalBytes: 100, freeBytes: 80 }, maxEntries: 50 });
    assert.equal(symlinkScan.footprint.status, 'blocked');
    assert.ok(symlinkScan.footprint.symlinkPaths.some((item) => item.endsWith('link.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup is an explicit, non-mutating project inventory', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanResources({ repoPath: root, os: mockedOs(), disk: { totalBytes: 100, freeBytes: 80 }, maxEntries: 100 });
    const before = await readFile(nodePath.join(root, 'README.txt'), 'utf8');
    const plan = planProjectCleanup(scan, { allowedRoots: ['.cache', 'build', '.git/worktrees'] });
    assert.equal(plan.mutating, false);
    assert.equal(plan.executionRequired, true);
    assert.equal(plan.requiresExplicitConfirmation, true);
    assert.deepEqual(plan.commands, []);
    assert.ok(plan.items.some((item) => item.category === 'cache'));
    assert.ok(plan.items.every((item) => item.safeToDelete === false && item.requiresConfirmation === true));
    assert.equal(await readFile(nodePath.join(root, 'README.txt'), 'utf8'), before);
    await assert.rejects(() => Promise.resolve(planProjectCleanup(scan, { allowedRoots: [nodePath.join('..', 'outside')] })).then((result) => result.blocked ? Promise.reject(new Error('blocked')) : result), /blocked/);
    await stat(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session guard keeps the public default at 8 while host and resource ceilings stay authoritative', () => {
  const guard = planSessionGuard({
    cpu: { logicalCount: 32, normalizedLoad: 0.1 },
    memory: { freeBytes: bytes(64), pressureRatio: 0.2 },
    disk: { pressureRatio: 0.1 },
    concurrency: { current: 0 },
  }, { profile: 'fast', kind: 'io', hostCeiling: 24 });
  assert.equal(guard.parentCount, 1);
  assert.equal(guard.mutating, false);
  assert.equal(guard.requestedTarget, DEFAULT_REQUESTED_CONCURRENCY);
  assert.equal(guard.configuredRequestMaximum, MAX_REQUESTED_CONCURRENCY);
  assert.equal(guard.safeCapacity, 8);
  assert.equal(guard.acceptNewLanes, true);
  assert.equal(guard.queue, 'bounded-backpressure');
});

test('a deliberate per-user opt-in can request 20 without changing the default', () => {
  const guard = planSessionGuard({
    cpu: { logicalCount: 32, normalizedLoad: 0.1 },
    memory: { freeBytes: bytes(64), pressureRatio: 0.2 },
    disk: { pressureRatio: 0.1 },
    concurrency: { current: 0 },
  }, { profile: 'fast', kind: 'io', requested: 20, hostCeiling: 24 });
  assert.equal(DEFAULT_REQUESTED_CONCURRENCY, 8);
  assert.equal(guard.requestedNewLanes, 20);
  assert.equal(guard.safeCapacity, 20);
  assert.equal(guard.acceptNewLanes, true);
});

test('requested 24 is capped by host 16 and other task reservations', () => {
  const scan = {
    cpu: { logicalCount: 32, normalizedLoad: 0.1 },
    memory: { freeBytes: bytes(64), pressureRatio: 0.2 },
    disk: { pressureRatio: 0.1 },
    concurrency: { current: 0 },
  };
  assert.equal(recommendConcurrency(scan, { profile: 'fast', kind: 'io', requested: 24, hostCeiling: 16 }), 16);
  const guard = planSessionGuard(scan, {
    profile: 'fast',
    kind: 'io',
    requested: 24,
    hostCeiling: 16,
    otherTaskReservations: 3,
  });
  assert.equal(guard.hostCeilingStatus, 'reported');
  assert.equal(guard.availableCapacity, 13);
  assert.equal(guard.acceptNewLanes, false);
});

test('unknown host ceiling is reported without inventing a runtime limit', () => {
  const guard = planSessionGuard({
    cpu: { logicalCount: 32, normalizedLoad: 0.1 },
    memory: { freeBytes: bytes(64), pressureRatio: 0.2 },
    disk: { pressureRatio: 0.1 },
    concurrency: { current: 0 },
  }, { profile: 'fast', kind: 'io', requested: 24 });
  assert.equal(guard.hostCeiling, null);
  assert.equal(guard.hostCeilingStatus, 'unknown');
  assert.equal(guard.safeCapacity, 24);
});
