import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LeaseError,
  LeaseRegistry,
  RegistryStateError,
  inspectLeaseRegistry,
  recoverExpiredLease,
  withRegistryLock,
} from '../src/leases.js';

const NOW = Date.parse('2032-05-18T03:33:22.000Z');

async function temporaryRegistry(t) {
  const directory = await mkdtemp(join(tmpdir(), 'worktree-proof-leases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'registry.json');
}

async function expiredRegistry(t, laneId) {
  const registryPath = await temporaryRegistry(t);
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    leases: [{
      leaseId: `lease-${laneId}`,
      laneId,
      fileScope: `src/${laneId}.js`,
      owner: 'owner-private',
      session: 'session-private',
      timestamp: '2032-05-18T03:33:20.000Z',
      ttlMs: 1_000,
      expiresAt: '2032-05-18T03:33:21.000Z',
      status: 'active',
      active: true,
    }],
  }), 'utf8');
  return registryPath;
}

test('reserves and releases a lease with owner/session, timestamp, TTL, and status', async (t) => {
  const registryPath = await temporaryRegistry(t);
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const registry = new LeaseRegistry(registryPath, {
    clock: () => now,
    ttlMs: 30_000,
    idFactory: () => 'lease-1',
  });

  const lease = await registry.reserve({
    laneId: 'lane-a',
    fileScope: 'src/a.js',
    owner: 'worker-a',
    session: 'session-a',
  });
  assert.deepEqual(
    {
      leaseId: lease.leaseId,
      laneId: lease.laneId,
      fileScope: lease.fileScope,
      owner: lease.owner,
      session: lease.session,
      timestamp: lease.timestamp,
      ttlMs: lease.ttlMs,
      expiresAt: lease.expiresAt,
      status: lease.status,
      active: lease.active,
    },
    {
      leaseId: 'lease-1',
      laneId: 'lane-a',
      fileScope: 'src/a.js',
      owner: 'worker-a',
      session: 'session-a',
      timestamp: '2026-01-01T00:00:00.000Z',
      ttlMs: 30_000,
      expiresAt: '2026-01-01T00:00:30.000Z',
      status: 'active',
      active: true,
    },
  );

  now += 1_000;
  const released = await registry.release({ leaseId: 'lease-1', owner: 'worker-a', session: 'session-a' });
  assert.equal(released.status, 'released');
  assert.equal(released.active, false);
  assert.equal((await registry.active()).length, 0);
  assert.equal((await registry.list()).length, 1);
});

test('rejects duplicate lanes and overlapping active scopes', async (t) => {
  const registryPath = await temporaryRegistry(t);
  const registry = new LeaseRegistry(registryPath, {
    clock: () => 1_700_000_000_000,
    idFactory: (() => { let n = 0; return () => `lease-${++n}`; })(),
  });
  await registry.reserve({ laneId: 'a', fileScope: 'src', owner: 'owner', session: 'one' });
  await assert.rejects(
    registry.reserve({ laneId: 'a', fileScope: 'other.js', owner: 'owner', session: 'two' }),
    (error) => error.code === 'ERR_LEASE_CONFLICT',
  );
  await assert.rejects(
    registry.reserve({ laneId: 'b', fileScope: 'src/lib', owner: 'owner', session: 'two' }),
    (error) => error.code === 'ERR_LEASE_CONFLICT',
  );
});

test('malformed and stale registry entries fail closed', async (t) => {
  const registryPath = await temporaryRegistry(t);
  const registry = new LeaseRegistry(registryPath, { clock: () => 2_000_000_000_000 });

  await writeFile(registryPath, '{not-json', 'utf8');
  await assert.rejects(registry.read(), (error) => error instanceof RegistryStateError && error.code === 'ERR_MALFORMED_REGISTRY');

  await writeFile(registryPath, JSON.stringify({ version: 1, leases: [{ status: 'active' }] }), 'utf8');
  await assert.rejects(registry.read(), (error) => error instanceof RegistryStateError);

  const expiredTimestamp = '2032-05-18T03:33:20.000Z';
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    leases: [{
      leaseId: 'stale',
      laneId: 'stale-lane',
      fileScope: 'stale.js',
      owner: 'owner',
      session: 'session',
      timestamp: expiredTimestamp,
      ttlMs: 1_000,
      expiresAt: '2032-05-18T03:33:21.000Z',
      status: 'active',
      active: true,
    }],
  }), 'utf8');
  await assert.rejects(registry.reserve({ laneId: 'new', fileScope: 'new.js', owner: 'o', session: 's' }), (error) => error.code === 'ERR_STALE_REGISTRY');
});

test('expired leases are inspectable and recoverable only with confirmation', async (t) => {
  const registryPath = await expiredRegistry(t, 'blocked');
  const report = await inspectLeaseRegistry(registryPath, { clock: () => NOW });
  assert.deepEqual(report.stale.map(({ laneId }) => laneId), ['blocked']);
  await assert.rejects(
    recoverExpiredLease(
      registryPath,
      { laneId: 'blocked', reason: 'terminal work merged', confirm: false },
      { clock: () => NOW },
    ),
    (error) => error.code === 'ERR_CONFIRM_REQUIRED',
  );
  const lease = await recoverExpiredLease(
    registryPath,
    { laneId: 'blocked', reason: 'terminal work merged', confirm: true },
    { clock: () => NOW },
  );
  assert.equal(lease.status, 'released');
  assert.equal((await inspectLeaseRegistry(registryPath, { clock: () => NOW })).stale.length, 0);
});

test('recovery fails closed for duplicate, overlapping, or non-expired active state', async (t) => {
  const registryPath = await temporaryRegistry(t);
  const lease = (overrides = {}) => ({
    leaseId: 'lease-a',
    laneId: 'blocked',
    fileScope: 'src/blocked.js',
    owner: 'owner',
    session: 'session',
    timestamp: '2032-05-18T03:33:20.000Z',
    ttlMs: 1_000,
    expiresAt: '2032-05-18T03:33:21.000Z',
    status: 'active',
    active: true,
    ...overrides,
  });
  await writeFile(registryPath, JSON.stringify({ version: 1, leases: [
    lease(),
    lease({ leaseId: 'lease-b', fileScope: 'src/other.js' }),
  ] }), 'utf8');
  await assert.rejects(
    recoverExpiredLease(registryPath, { laneId: 'blocked', reason: 'merged', confirm: true }, { clock: () => NOW }),
    (error) => error.code === 'ERR_RECOVERY_AMBIGUOUS',
  );

  await writeFile(registryPath, JSON.stringify({ version: 1, leases: [
    lease({ fileScope: 'src/blocked' }),
    lease({ leaseId: 'lease-b', laneId: 'other', fileScope: 'src/blocked/child.js' }),
  ] }), 'utf8');
  await assert.rejects(
    recoverExpiredLease(registryPath, { laneId: 'blocked', reason: 'merged', confirm: true }, { clock: () => NOW }),
    (error) => error.code === 'ERR_RECOVERY_AMBIGUOUS',
  );

  await writeFile(registryPath, JSON.stringify({ version: 1, leases: [
    lease({ expiresAt: '2032-05-18T03:33:30.000Z', timestamp: '2032-05-18T03:33:20.000Z', ttlMs: 10_000 }),
  ] }), 'utf8');
  await assert.rejects(
    recoverExpiredLease(registryPath, { laneId: 'blocked', reason: 'merged', confirm: true }, { clock: () => NOW }),
    (error) => error.code === 'ERR_LEASE_NOT_EXPIRED',
  );
});

test('inspect and recovery fail closed on malformed registries without mutation', async (t) => {
  const registryPath = await temporaryRegistry(t);
  const malformed = '{not-json';
  await writeFile(registryPath, malformed, 'utf8');
  await assert.rejects(
    inspectLeaseRegistry(registryPath, { clock: () => NOW }),
    (error) => error.code === 'ERR_MALFORMED_REGISTRY',
  );
  await assert.rejects(
    recoverExpiredLease(registryPath, { laneId: 'blocked', reason: 'merged', confirm: true }, { clock: () => NOW }),
    (error) => error.code === 'ERR_MALFORMED_REGISTRY',
  );
  assert.equal(await readFile(registryPath, 'utf8'), malformed);

  const structurallyMalformed = JSON.stringify({ version: 1, leases: [{ status: 'active' }] });
  await writeFile(registryPath, structurallyMalformed, 'utf8');
  await assert.rejects(
    inspectLeaseRegistry(registryPath, { clock: () => NOW }),
    (error) => error.code === 'ERR_MALFORMED_REGISTRY',
  );
  await assert.rejects(
    recoverExpiredLease(registryPath, { laneId: 'blocked', reason: 'merged', confirm: true }, { clock: () => NOW }),
    (error) => error.code === 'ERR_MALFORMED_REGISTRY',
  );
  assert.equal(await readFile(registryPath, 'utf8'), structurallyMalformed);
});

test('recovery leaves mixed expired-target and live same-lane bytes unchanged', async (t) => {
  const registryPath = await temporaryRegistry(t);
  const mixed = JSON.stringify({ version: 1, leases: [
    {
      leaseId: 'expired-target',
      laneId: 'blocked',
      fileScope: 'src/blocked.js',
      owner: 'owner',
      session: 'session',
      timestamp: '2032-05-18T03:33:20.000Z',
      ttlMs: 1_000,
      expiresAt: '2032-05-18T03:33:21.000Z',
      status: 'active',
      active: true,
    },
    {
      leaseId: 'live-same-lane',
      laneId: 'blocked',
      fileScope: 'src/live.js',
      owner: 'owner',
      session: 'session',
      timestamp: '2032-05-18T03:33:20.000Z',
      ttlMs: 10_000,
      expiresAt: '2032-05-18T03:33:30.000Z',
      status: 'active',
      active: true,
    },
  ] });
  await writeFile(registryPath, mixed, 'utf8');
  await assert.rejects(
    recoverExpiredLease(registryPath, { laneId: 'blocked', reason: 'merged', confirm: true }, { clock: () => NOW }),
    (error) => error.code === 'ERR_LEASE_NOT_EXPIRED',
  );
  assert.equal(await readFile(registryPath, 'utf8'), mixed);
});

test('concurrent reservations serialize through an atomic mkdir lock', async (t) => {
  const registryPath = await temporaryRegistry(t);
  const clock = () => 1_800_000_000_000;
  const first = new LeaseRegistry(registryPath, {
    clock,
    idFactory: () => 'first',
    lockAttempts: 100,
    lockDelayMs: 1,
  });
  const second = new LeaseRegistry(registryPath, {
    clock,
    idFactory: () => 'second',
    lockAttempts: 100,
    lockDelayMs: 1,
  });

  const outcomes = await Promise.allSettled([
    first.reserve({ laneId: 'same', fileScope: 'same.js', owner: 'a', session: 'a' }),
    second.reserve({ laneId: 'same', fileScope: 'same.js', owner: 'b', session: 'b' }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(outcomes.find(({ status }) => status === 'rejected').reason.code, 'ERR_LEASE_CONFLICT');
  assert.equal((await first.active()).length, 1);
});

test('lock contention has a bounded, clear error', async (t) => {
  const registryPath = await temporaryRegistry(t);
  await mkdir(`${registryPath}.lock`);
  await assert.rejects(
    withRegistryLock(registryPath, async () => undefined, { attempts: 1, delayMs: 0 }),
    (error) => error instanceof LeaseError && error.code === 'ERR_LOCK_TIMEOUT' && /busy/.test(error.message),
  );
  await rm(`${registryPath}.lock`, { recursive: true, force: true });
});

test('withRegistryLock never overlaps two critical sections', async (t) => {
  const registryPath = await temporaryRegistry(t);
  let running = 0;
  let maxRunning = 0;
  const critical = () => withRegistryLock(registryPath, async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 15));
    running -= 1;
  }, { attempts: 100, delayMs: 1 });
  await Promise.all([critical(), critical(), critical()]);
  assert.equal(maxRunning, 1);
});

test('registry lock is cleaned after failed operations', async (t) => {
  const registryPath = await temporaryRegistry(t);
  await assert.rejects(
    withRegistryLock(registryPath, async () => { throw new Error('operation failed'); }),
    /operation failed/,
  );
  await assert.doesNotReject(withRegistryLock(registryPath, async () => undefined));
  const raw = await readFile(`${registryPath}.lock`, 'utf8').catch((error) => error);
  assert.equal(raw.code, 'ENOENT');
});
