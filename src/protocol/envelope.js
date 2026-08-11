import {
  DEFAULT_REQUEST_ID,
  MAX_BATCH_ITEMS,
  MAX_MESSAGE_BYTES,
  PROTOCOL,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from './constants.js';
import { normalizePublicError, ProtocolError } from './errors.js';
import { types as utilTypes } from 'node:util';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const PRIVATE_REQUEST_ID = /(authorization|credential|owner|password|private|secret|session|token)/i;
const COMMAND_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const SENSITIVE_KEY = /(authorization|access.?key|api.?key|cookie|credential|passwd|password|private.?key|refresh.?token|secret|session|stack|token|owner)/i;
const SENSITIVE_WARNING = /(authorization|access.?key|api.?key|cookie|credential|passwd|password|private.?key|refresh.?token|secret|session|stack|token|owner)/i;
const MAX_WARNING_LENGTH = 512;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function dataDescriptor(value, key, code = 'ERR_INVALID_RESULT') {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new ProtocolError(undefined, code);
  }
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new ProtocolError(undefined, code);
  }
  return descriptor.value;
}

function optionalDataDescriptor(value, key, code = 'ERR_INVALID_ENVELOPE') {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new ProtocolError(undefined, code);
  }
  if (!descriptor) return undefined;
  if (!('value' in descriptor) || !descriptor.enumerable) throw new ProtocolError(undefined, code);
  return descriptor.value;
}

function ownEnumerableKeys(value, code = 'ERR_INVALID_RESULT') {
  if (utilTypes.isProxy(value)) throw new ProtocolError(undefined, code);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new ProtocolError(undefined, code);
  }
  for (const key of keys) {
    if (typeof key !== 'string') throw new ProtocolError(undefined, code);
    // Symbols and accessors are not representable in the protocol. Rejecting
    // them avoids invoking untrusted getters or silently dropping hidden data.
    if (key !== 'length' || !Array.isArray(value)) dataDescriptor(value, key, code);
  }
  return keys.filter((key) => typeof key === 'string');
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
  if (utilTypes.isProxy(value)) throw new ProtocolError(undefined, 'ERR_INVALID_RESULT');
  if (Array.isArray(value)) {
    if (value.length > MAX_BATCH_ITEMS) throw new ProtocolError(undefined, 'ERR_BATCH_TOO_LARGE');
    const keys = ownEnumerableKeys(value);
    for (const keyName of keys) {
      if (keyName !== 'length' && !/^\d+$/u.test(keyName)) {
        throw new ProtocolError(undefined, 'ERR_INVALID_RESULT');
      }
    }
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const keyName = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, keyName);
      output.push(descriptor ? normalizeValue(descriptor.value, '', depth + 1) : null);
    }
    return output;
  }
  if (!isPlainObject(value)) throw new ProtocolError(undefined, 'ERR_INVALID_RESULT');
  const output = {};
  for (const keyName of ownEnumerableKeys(value).sort()) {
    Object.defineProperty(output, keyName, {
      value: normalizeValue(dataDescriptor(value, keyName), keyName, depth + 1),
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
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > MAX_BATCH_ITEMS) {
    throw new ProtocolError(undefined, 'ERR_BATCH_TOO_LARGE');
  }
  const keys = ownEnumerableKeys(value, 'ERR_INVALID_WARNING');
  for (const key of keys) {
    if (key !== 'length' && !/^\d+$/u.test(key)) throw new ProtocolError(undefined, 'ERR_INVALID_WARNING');
  }
  const warnings = [];
  for (let index = 0; index < value.length; index += 1) {
    const warning = dataDescriptor(value, String(index), 'ERR_INVALID_WARNING');
    const normalized = normalizeString(warning, 'ERR_INVALID_WARNING', MAX_WARNING_LENGTH);
    warnings.push(SENSITIVE_WARNING.test(normalized) ? '[redacted]' : normalized);
  }
  return warnings.sort();
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
  const ok = dataDescriptor(input, 'ok', 'ERR_INVALID_ENVELOPE');
  if (typeof ok !== 'boolean') throw new ProtocolError(undefined, 'ERR_INVALID_ENVELOPE');
  const command = optionalDataDescriptor(input, 'command');
  const requestId = optionalDataDescriptor(input, 'requestId');
  const result = optionalDataDescriptor(input, 'result');
  const error = optionalDataDescriptor(input, 'error');
  const warnings = optionalDataDescriptor(input, 'warnings');
  const extensions = optionalDataDescriptor(input, 'extensions');

  const envelope = {
    ok,
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    command: normalizeCommand(command),
    requestId: normalizeRequestId(requestId),
  };
  if (ok) envelope.result = normalizeValue(result ?? {}, 'result');
  else envelope.error = normalizePublicError(error);
  envelope.warnings = normalizeWarnings(warnings);
  if (extensions !== undefined) {
    if (!isPlainObject(extensions)) throw new ProtocolError(undefined, 'ERR_INVALID_ENVELOPE');
    envelope.extensions = normalizeValue(extensions, 'extensions');
  }

  // Serialize before freezing to enforce the same bound consumers will see.
  serialize(envelope);
  return deepFreeze(envelope);
}

export function serializeEnvelope(envelope) {
  return serialize(normalizeValue(envelope));
}
