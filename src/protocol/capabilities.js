import {
  MAX_BATCH_ITEMS,
  PROTOCOL,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from './constants.js';
import { ProtocolError } from './errors.js';
import { deepFreeze } from './envelope.js';

const CAPABILITY_DEFINITIONS = [
  { id: 'lease.reserve', version: '1', mutating: true },
  { id: 'receipt.validate', version: '1', mutating: false },
  { id: 'scope.validate', version: '1', mutating: false },
].sort((left, right) => left.id.localeCompare(right.id));

const CAPABILITIES = deepFreeze(CAPABILITY_DEFINITIONS.map((item) => ({ ...item })));
const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((item) => [item.id, item]));
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/;

function validateProtocolVersion(protocolVersion) {
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(undefined, 'ERR_PROTOCOL_VERSION');
  }
}

function normalizeRequested(requested) {
  if (requested === undefined || requested === null) return undefined;
  if (!Array.isArray(requested) || requested.length > MAX_BATCH_ITEMS) {
    throw new ProtocolError(undefined, 'ERR_BATCH_TOO_LARGE');
  }
  const normalized = [];
  const seen = new Set();
  for (const value of requested) {
    if (typeof value !== 'string' || !CAPABILITY_ID.test(value) || value.length > 128) {
      throw new ProtocolError(undefined, 'ERR_INVALID_CAPABILITY');
    }
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized.sort();
}

/** Return immutable capability records in stable id order. */
export function listCapabilities() {
  return CAPABILITIES;
}

/**
 * Negotiate a requested capability set for one supported protocol version.
 * Unknown capability ids are ordinary, deterministic negotiation results (not
 * thrown failures); callers can branch on `unsupported` without guessing.
 */
export function negotiateCapabilities({ protocolVersion, requested } = {}) {
  validateProtocolVersion(protocolVersion);
  const normalized = normalizeRequested(requested);
  const requestedIds = normalized ?? CAPABILITIES.map(({ id }) => id);
  const capabilities = requestedIds
    .filter((id) => CAPABILITY_BY_ID.has(id))
    .map((id) => CAPABILITY_BY_ID.get(id));
  const unsupported = requestedIds.filter((id) => !CAPABILITY_BY_ID.has(id));
  return deepFreeze({
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    capabilities,
    unsupported,
    limits: PROTOCOL_LIMITS,
  });
}

export function hasCapability(id) {
  return typeof id === 'string' && CAPABILITY_BY_ID.has(id);
}

