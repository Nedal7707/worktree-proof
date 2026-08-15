import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';

import { normalizeLane, normalizeLanes, normalizeLaneId, normalizeFileScope, scopesOverlap } from './scope.js';

const REGISTRY_VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_ATTEMPTS = 40;
const DEFAULT_LOCK_DELAY_MS = 10;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export class LeaseError extends Error {
  constructor(message, code = 'ERR_LEASE') {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
  }
}

export class RegistryStateError extends LeaseError {
  constructor(message, code = 'ERR_MALFORMED_REGISTRY') {
    super(message, code);
    this.name = 'RegistryStateError';
  }
}

function currentTime(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  if (!Number.isFinite(value) || value < 0) {
    throw new LeaseError('clock must return a non-negative finite millisecond timestamp', 'ERR_INVALID_CLOCK');
  }
  return Math.trunc(value);
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value || CONTROL_CHARS.test(value)) {
    throw new RegistryStateError(`${label} must be an ISO timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new RegistryStateError(`${label} must be a canonical ISO timestamp`);
  }
  return ms;
}

function token(value, label, { normalize = true } = {}) {
  if (typeof value !== 'string') {
    throw new LeaseError(`${label} must be a string`, 'ERR_INVALID_LEASE_INPUT');
  }
  const result = normalize ? value.normalize('NFC').trim() : value;
  if (!result || CONTROL_CHARS.test(result)) {
    throw new LeaseError(`${label} must be non-empty and contain no control characters`, 'ERR_INVALID_LEASE_INPUT');
  }
  return result;
}

function stateSkeleton() {
  return { version: REGISTRY_VERSION, leases: [] };
}

function registryToken(value, label) {
  try {
    return token(value, label, { normalize: false });
  } catch (error) {
    throw new RegistryStateError(error.message, 'ERR_MALFORMED_REGISTRY');
  }
}

function registryLaneId(value, label) {
  try {
    return normalizeLaneId(value);
  } catch (error) {
    throw new RegistryStateError(`${label} is invalid: ${error.message}`, 'ERR_MALFORMED_REGISTRY');
  }
}

function registryFileScope(value, label) {
  try {
    return normalizeFileScope(value);
  } catch (error) {
    throw new RegistryStateError(`${label} is invalid: ${error.message}`, 'ERR_MALFORMED_REGISTRY');
  }
}

function validateLeaseEntry(entry, index, now, { allowStale = false } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new RegistryStateError(`registry lease ${index} must be an object`);
  }
  const leaseId = registryToken(entry.leaseId, `registry lease ${index}.leaseId`);
  const laneId = registryLaneId(entry.laneId, `registry lease ${index}.laneId`);
  const fileScope = registryFileScope(entry.fileScope, `registry lease ${index}.fileScope`);
  const owner = registryToken(entry.owner, `registry lease ${index}.owner`);
  const session = registryToken(entry.session, `registry lease ${index}.session`);
  const timestampMs = timestamp(entry.timestamp, `registry lease ${index}.timestamp`);
  if (!Number.isSafeInteger(entry.ttlMs) || entry.ttlMs <= 0) {
    throw new RegistryStateError(`registry lease ${index}.ttlMs must be a positive integer`);
  }
  const expiresAtMs = timestamp(entry.expiresAt, `registry lease ${index}.expiresAt`);
  if (expiresAtMs !== timestampMs + entry.ttlMs) {
    throw new RegistryStateError(`registry lease ${index}.expiresAt does not match timestamp + ttlMs`);
  }
  if (entry.status !== 'active' && entry.status !== 'released') {
    throw new RegistryStateError(`registry lease ${index}.status must be active or released`);
  }
  if (typeof entry.active !== 'boolean' || entry.active !== (entry.status === 'active')) {
    throw new RegistryStateError(`registry lease ${index}.active must match status`);
  }
  if (!allowStale && entry.status === 'active' && expiresAtMs <= now) {
    throw new RegistryStateError(
      `registry lease ${JSON.stringify(leaseId)} is stale (expired at ${entry.expiresAt})`,
      'ERR_STALE_REGISTRY',
    );
  }
  if (entry.releasedAt !== undefined) {
    timestamp(entry.releasedAt, `registry lease ${index}.releasedAt`);
  }
  return {
    ...entry,
    leaseId,
    laneId,
    fileScope,
    owner,
    session,
    timestamp: new Date(timestampMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function validateRegistry(value, now, { allowStale = false, checkConflicts = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RegistryStateError('registry root must be an object');
  }
  if (value.version !== REGISTRY_VERSION) {
    throw new RegistryStateError(`registry version must be ${REGISTRY_VERSION}`);
  }
  if (!Array.isArray(value.leases)) {
    throw new RegistryStateError('registry leases must be an array');
  }
  const leases = value.leases.map((entry, index) => validateLeaseEntry(entry, index, now, { allowStale }));
  if (!checkConflicts) return { ...value, version: REGISTRY_VERSION, leases };
  const active = leases.filter((entry) => entry.status === 'active');
  const seenIds = new Set();
  for (const lease of active) {
    if (seenIds.has(lease.leaseId)) {
      throw new RegistryStateError(`duplicate active leaseId ${JSON.stringify(lease.leaseId)}`);
    }
    seenIds.add(lease.leaseId);
  }
  try {
    // normalizeLanes checks duplicate IDs and overlapping file scopes among
    // active leases while allowing historical released entries to remain.
    normalizeLanes(active.map(({ laneId, fileScope }) => ({ laneId, fileScope })));
  } catch (error) {
    throw new RegistryStateError(`active registry leases conflict: ${error.message}`, 'ERR_CONFLICTING_REGISTRY');
  }
  return { ...value, version: REGISTRY_VERSION, leases };
}

async function ensureParent(registryPath) {
  await mkdir(dirname(registryPath), { recursive: true });
}

function lockPath(registryPath) {
  return `${registryPath}.lock`;
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * True when a lock acquisition failed because a concurrent owner is still
 * mid-flight.  Windows can surface EPERM/EACCES (instead of EEXIST) when a
 * concurrent owner's rm/rmdir has not fully landed; all three codes mean
 * "transient busy, retry within bound" rather than a real error.
 */
export function isTransientLockBusy(error) {
  return error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EACCES';
}

/** Acquire an exclusive directory lock with bounded retries. */
export async function acquireRegistryLock(registryPath, {
  attempts = DEFAULT_LOCK_ATTEMPTS,
  delayMs = DEFAULT_LOCK_DELAY_MS,
} = {}) {
  const target = resolve(registryPath);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new LeaseError('lock attempts must be a positive integer', 'ERR_INVALID_LOCK_OPTIONS');
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new LeaseError('lock delayMs must be a non-negative integer', 'ERR_INVALID_LOCK_OPTIONS');
  }
  await ensureParent(target);
  const canonicalParent = await realpath(dirname(target));
  const directory = lockPath(join(canonicalParent, basename(target)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mkdir(directory, { recursive: false });
      return { path: directory, attempts: attempt };
    } catch (error) {
      // On Windows, a concurrent owner's rmdir can still be mid-flight when
      // this mkdir lands, surfacing EPERM/EACCES instead of EEXIST. Treat
      // those as transient busy conditions bounded by the same attempts.
      const busy = isTransientLockBusy(error);
      if (!busy) {
        throw new LeaseError(`unable to acquire registry lock: ${error.message}`, 'ERR_LOCK_ACQUIRE');
      }
      if (attempt === attempts) {
        throw new LeaseError(
          `registry lock is busy after ${attempts} attempts: ${directory}`,
          'ERR_LOCK_TIMEOUT',
        );
      }
      if (delayMs > 0) {
        await wait(delayMs);
      }
    }
  }
  throw new LeaseError('registry lock acquisition failed', 'ERR_LOCK_ACQUIRE');
}

export async function releaseRegistryLock(lock) {
  if (!lock || typeof lock.path !== 'string') {
    throw new LeaseError('invalid registry lock handle', 'ERR_LOCK_RELEASE');
  }
  try {
    await rmdir(lock.path);
  } catch (error) {
    throw new LeaseError(`unable to release registry lock ${lock.path}: ${error.message}`, 'ERR_LOCK_RELEASE');
  }
}

export async function withRegistryLock(registryPath, operation, options = {}) {
  if (typeof operation !== 'function') {
    throw new LeaseError('lock operation must be a function', 'ERR_INVALID_LOCK_OPERATION');
  }
  const lock = await acquireRegistryLock(registryPath, options);
  let operationResult;
  let operationError;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await releaseRegistryLock(lock);
  } catch (releaseError) {
    if (operationError) {
      operationError.lockReleaseError = releaseError;
      throw operationError;
    }
    throw releaseError;
  }
  if (operationError) throw operationError;
  return operationResult;
}

async function readRegistryFile(registryPath, now, options = {}) {
  let raw;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return stateSkeleton();
    }
    throw new RegistryStateError(`unable to read registry: ${error.message}`, 'ERR_REGISTRY_READ');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RegistryStateError(`registry JSON is malformed: ${error.message}`);
  }
  return validateRegistry(parsed, now, options);
}

/**
 * Read a registry for stale-state inspection.  Structural validation remains
 * strict, but expired active leases are intentionally retained so a caller can
 * make an explicit, confirmed recovery decision.  Conflict checks are deferred
 * to the selector, which can fail closed with an actionable ambiguity code.
 */
function readRegistryForInspection(registryPath, now) {
  return readRegistryFile(registryPath, now, { allowStale: true, checkConflicts: false });
}

async function writeRegistryFile(registryPath, state) {
  await ensureParent(registryPath);
  const temporary = join(
    dirname(registryPath),
    `.${basename(registryPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const content = `${JSON.stringify(state, null, 2)}\n`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(temporary, registryPath);
    } catch (error) {
      // Windows refuses to rename over an existing file.  The directory lock
      // makes this fallback safe from other registry writers.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') {
        throw error;
      }
      await rm(registryPath, { force: true });
      await rename(temporary, registryPath);
    }
  } catch (error) {
    throw new LeaseError(`unable to write registry: ${error.message}`, 'ERR_REGISTRY_WRITE');
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function registryPathValue(registryPath) {
  if (typeof registryPath !== 'string' || !registryPath.trim()) {
    throw new LeaseError('registryPath must be a non-empty string', 'ERR_INVALID_REGISTRY_PATH');
  }
  return resolve(registryPath);
}

function lockOptions(options = {}) {
  return {
    attempts: options.lockAttempts ?? options.attempts ?? DEFAULT_LOCK_ATTEMPTS,
    delayMs: options.lockDelayMs ?? options.delayMs ?? DEFAULT_LOCK_DELAY_MS,
  };
}

function selectSingleExpired(state, laneId, now) {
  let normalizedLaneId;
  try {
    normalizedLaneId = normalizeLaneId(laneId);
  } catch (error) {
    throw new LeaseError(`laneId is invalid: ${error.message}`, 'ERR_INVALID_LEASE_INPUT');
  }
  const active = state.leases.filter((entry) => entry.status === 'active');
  const candidates = active.filter((entry) => (
    entry.laneId === normalizedLaneId
    && timestamp(entry.expiresAt, 'lease expiresAt') <= now
  ));
  if (candidates.length > 1) {
    throw new LeaseError('expired lease selector is ambiguous', 'ERR_RECOVERY_AMBIGUOUS');
  }
  const matching = active.filter((entry) => entry.laneId === normalizedLaneId);
  if (candidates.length === 0 && matching.some((entry) => timestamp(entry.expiresAt, 'lease expiresAt') > now)) {
    throw new LeaseError('lease has not expired', 'ERR_LEASE_NOT_EXPIRED');
  }
  if (candidates.length === 0) throw new LeaseError('expired lease was not found', 'ERR_LEASE_NOT_FOUND');

  const target = candidates[0];
  const conflicts = active.filter((entry) => (
    entry !== target
    && (entry.laneId === normalizedLaneId || scopesOverlap(entry.fileScope, target.fileScope))
  ));
  if (conflicts.length > 0) {
    if (conflicts.some((entry) => (
      entry.laneId === normalizedLaneId
      && timestamp(entry.expiresAt, 'lease expiresAt') > now
    ))) {
      throw new LeaseError('lease has not expired', 'ERR_LEASE_NOT_EXPIRED');
    }
    throw new LeaseError('expired lease selector is ambiguous', 'ERR_RECOVERY_AMBIGUOUS');
  }
  return target;
}

function replaceLease(state, target, released) {
  return {
    ...state,
    leases: state.leases.map((entry) => (entry === target ? released : entry)),
  };
}

function leaseInput(input, now, defaultTtlMs, idFactory) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LeaseError('lease input must be an object', 'ERR_INVALID_LEASE_INPUT');
  }
  const normalized = normalizeLane(input);
  const owner = token(input.owner, 'owner');
  const session = token(input.session, 'session');
  const ttlMs = input.ttlMs ?? defaultTtlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new LeaseError('ttlMs must be a positive integer', 'ERR_INVALID_LEASE_INPUT');
  }
  const leaseId = token(input.leaseId ?? idFactory(), 'leaseId');
  const timestampValue = new Date(now).toISOString();
  return {
    leaseId,
    laneId: normalized.laneId,
    fileScope: normalized.fileScope,
    owner,
    session,
    timestamp: timestampValue,
    ttlMs,
    expiresAt: new Date(now + ttlMs).toISOString(),
    status: 'active',
    active: true,
  };
}

export class LeaseRegistry {
  constructor(registryPath, {
    clock = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    idFactory = randomUUID,
    lockAttempts = DEFAULT_LOCK_ATTEMPTS,
    lockDelayMs = DEFAULT_LOCK_DELAY_MS,
  } = {}) {
    if (typeof registryPath !== 'string' || !registryPath.trim()) {
      throw new LeaseError('registryPath must be a non-empty string', 'ERR_INVALID_REGISTRY_PATH');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new LeaseError('default ttlMs must be a positive integer', 'ERR_INVALID_LEASE_INPUT');
    }
    if (typeof clock !== 'function' || typeof idFactory !== 'function') {
      throw new LeaseError('clock and idFactory must be functions', 'ERR_INVALID_LEASE_OPTIONS');
    }
    this.registryPath = resolve(registryPath);
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.idFactory = idFactory;
    this.lockOptions = { attempts: lockAttempts, delayMs: lockDelayMs };
  }

  async read() {
    return withRegistryLock(this.registryPath, async () => (
      readRegistryFile(this.registryPath, currentTime(this.clock))
    ), this.lockOptions);
  }

  async list() {
    const state = await this.read();
    return state.leases;
  }

  async active() {
    const state = await this.read();
    return state.leases.filter((lease) => lease.status === 'active');
  }

  async reserve(input) {
    return withRegistryLock(this.registryPath, async () => {
      const now = currentTime(this.clock);
      const state = await readRegistryFile(this.registryPath, now);
      const lease = leaseInput(input, now, this.ttlMs, this.idFactory);
      const active = state.leases.filter((entry) => entry.status === 'active');
      for (const existing of active) {
        if (existing.leaseId === lease.leaseId || existing.laneId === lease.laneId) {
          throw new LeaseError(`lane ${JSON.stringify(lease.laneId)} already has an active lease`, 'ERR_LEASE_CONFLICT');
        }
        if (scopesOverlap(existing.fileScope, lease.fileScope)) {
          throw new LeaseError(
            `fileScope ${JSON.stringify(lease.fileScope)} overlaps active lease ${JSON.stringify(existing.fileScope)}`,
            'ERR_LEASE_CONFLICT',
          );
        }
      }
      const next = { ...state, leases: [...state.leases, lease] };
      await writeRegistryFile(this.registryPath, next);
      return lease;
    }, this.lockOptions);
  }

  async release(selector) {
    return withRegistryLock(this.registryPath, async () => {
      const now = currentTime(this.clock);
      const state = await readRegistryFile(this.registryPath, now);
      const query = typeof selector === 'string' ? { leaseId: selector } : selector;
      if (!query || typeof query !== 'object' || Array.isArray(query)) {
        throw new LeaseError('release selector must be a leaseId or object', 'ERR_INVALID_RELEASE');
      }
      const matches = state.leases.filter((entry) => (
        entry.status === 'active'
        && (query.leaseId === undefined || entry.leaseId === query.leaseId)
        && (query.laneId === undefined || entry.laneId === query.laneId)
      ));
      if (matches.length === 0) {
        throw new LeaseError('active lease was not found', 'ERR_LEASE_NOT_FOUND');
      }
      if (matches.length > 1) {
        throw new LeaseError('release selector is ambiguous', 'ERR_RELEASE_AMBIGUOUS');
      }
      const target = matches[0];
      for (const field of ['owner', 'session']) {
        if (query[field] !== undefined && query[field] !== target[field]) {
          throw new LeaseError(`release ${field} does not match lease owner`, 'ERR_RELEASE_FORBIDDEN');
        }
      }
      let reason;
      if (query.reason !== undefined) {
        if (typeof query.reason !== 'string' || !query.reason.trim() || query.reason !== query.reason.trim()) {
          throw new LeaseError('release reason must be a non-empty trimmed string', 'ERR_INVALID_RELEASE');
        }
        reason = query.reason;
      }
      const releasedAt = new Date(now).toISOString();
      const released = {
        ...target,
        status: 'released',
        active: false,
        releasedAt,
        updatedAt: releasedAt,
        ...(reason === undefined ? {} : { reason }),
      };
      const next = {
        ...state,
        leases: state.leases.map((entry) => entry.leaseId === target.leaseId ? released : entry),
      };
      await writeRegistryFile(this.registryPath, next);
      return released;
    }, this.lockOptions);
  }
}

export async function reserveLease(registryPath, input, options = {}) {
  return new LeaseRegistry(registryPath, options).reserve(input);
}

export async function releaseLease(registryPath, selector, options = {}) {
  return new LeaseRegistry(registryPath, options).release(selector);
}

/** Inspect all leases while retaining expired active entries in `stale`. */
export async function inspectLeaseRegistry(registryPath, options = {}) {
  const target = registryPathValue(registryPath);
  const now = currentTime(options.clock ?? Date.now);
  return withRegistryLock(target, async () => {
    const state = await readRegistryForInspection(target, now);
    const stale = state.leases.filter((entry) => (
      entry.status === 'active' && timestamp(entry.expiresAt, 'lease expiresAt') <= now
    ));
    return { version: state.version, leases: state.leases, stale };
  }, lockOptions(options));
}

/** Release exactly one expired lease after an explicit confirmation. */
export async function recoverExpiredLease(registryPath, input, options = {}) {
  if (input?.confirm !== true) {
    throw new LeaseError('confirmation required', 'ERR_CONFIRM_REQUIRED');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LeaseError('recovery input must be an object', 'ERR_INVALID_LEASE_INPUT');
  }
  const reason = token(input.reason, 'reason');
  const targetPath = registryPathValue(registryPath);
  return withRegistryLock(targetPath, async () => {
    const now = currentTime(options.clock ?? Date.now);
    const state = await readRegistryForInspection(targetPath, now);
    const target = selectSingleExpired(state, input.laneId, now);
    const releasedAt = new Date(now).toISOString();
    const released = {
      ...target,
      active: false,
      status: 'released',
      releasedAt,
      updatedAt: releasedAt,
      reason,
    };
    await writeRegistryFile(targetPath, replaceLease(state, target, released));
    return released;
  }, lockOptions(options));
}

export const registryVersion = REGISTRY_VERSION;
