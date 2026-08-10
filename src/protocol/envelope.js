import {
  DEFAULT_REQUEST_ID,
  MAX_BATCH_ITEMS,
  MAX_MESSAGE_BYTES,
  PROTOCOL,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from './constants.js';
import { normalizePublicError, ProtocolError } from './errors.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const PRIVATE_REQUEST_ID = /(authorization|credential|owner|password|private|secret|session|token)/i;
const COMMAND_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const SENSITIVE_KEY = /(authorization|access.?key|api.?key|cookie|credential|passwd|password|private.?key|refresh.?token|secret|session|stack|token|owner)/i;
const MAX_WARNING_LENGTH = 512;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeRequestId(value) {
  const requestId = value === undefined || value === null || value === ''
    ? DEFAULT_REQUEST_ID
    : value;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId) || PRIVATE_REQUEST_ID.test(requestId)) {
    throw new ProtocolError(undefined, 'ERR_INVALID_REQUEST_ID');
  }
  return requestId;
}

function normalizeCommand(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !COMMAND_PATTERN.test(value)) {
    throw new ProtocolError(undefined, 'ERR_INVALID_COMMAND');
  }
  return value;
}

function normalizeString(value, code, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ProtocolError(undefined, code);
  }
  return value;
}

/**
 * Clone JSON-compatible values with sorted object keys and bounded arrays.
 * Sensitive field names are redacted before serialization. A clone is used so
 * freezing the envelope never mutates caller-owned objects.
 */
function normalizeValue(value, key = '', depth = 0) {
  if (depth > 64) throw new ProtocolError(undefined, 'ERR_INVALID_RESULT');
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProtocolError(undefined, 'ERR_INVALID_RESULT');
    return value;
  }
  if (typeof value === 'undefined') return null;
  if (Array.isArray(value)) {
    if (value.length > MAX_BATCH_ITEMS) throw new ProtocolError(undefined, 'ERR_BATCH_TOO_LARGE');
    return value.map((item) => normalizeValue(item, '', depth + 1));
  }
  if (!isPlainObject(value)) throw new ProtocolError(undefined, 'ERR_INVALID_RESULT');
  const output = {};
  for (const keyName of Object.keys(value).sort()) {
    Object.defineProperty(output, keyName, {
      value: normalizeValue(value[keyName], keyName, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeWarnings(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_BATCH_ITEMS) {
    throw new ProtocolError(undefined, 'ERR_BATCH_TOO_LARGE');
  }
  return value
    .map((warning) => normalizeString(warning, 'ERR_INVALID_WARNING', MAX_WARNING_LENGTH))
    .sort();
}

function serialize(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new ProtocolError(undefined, 'ERR_INVALID_ENVELOPE');
  }
  if (byteLength(text) > MAX_MESSAGE_BYTES) {
    throw new ProtocolError(undefined, 'ERR_MESSAGE_TOO_LARGE');
  }
  return text;
}

export { deepFreeze, normalizeRequestId, normalizeValue, serialize };

/**
 * Build an immutable, deterministic response envelope. Existing v0.1 fields
 * (`ok`, `command`, and `result`/`error`) remain present; protocol metadata is
 * additive for older JSON consumers.
 */
export function createEnvelope(input = {}) {
  if (!isPlainObject(input)) throw new ProtocolError(undefined, 'ERR_INVALID_ENVELOPE');
  if (typeof input.ok !== 'boolean') throw new ProtocolError(undefined, 'ERR_INVALID_ENVELOPE');

  const envelope = {
    ok: input.ok,
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    command: normalizeCommand(input.command),
    requestId: normalizeRequestId(input.requestId),
  };
  if (input.ok) envelope.result = normalizeValue(input.result ?? {}, 'result');
  else envelope.error = normalizePublicError(input.error);
  envelope.warnings = normalizeWarnings(input.warnings);

  // Serialize before freezing to enforce the same bound consumers will see.
  serialize(envelope);
  return deepFreeze(envelope);
}

export function serializeEnvelope(envelope) {
  return serialize(normalizeValue(envelope));
}
