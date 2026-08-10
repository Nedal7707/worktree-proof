/**
 * Portable WorktreeProof integration manifests.
 *
 * A manifest is a small, public data contract.  It contains capability and
 * relative-scope declarations only; it never carries credentials, hidden
 * context, scheduling directives, or client implementation details.
 */

import { createHash } from 'node:crypto';
import { containsSecretLikeValue } from './text-safety.js';

export const MANIFEST_PROTOCOL = 'worktreeproof';
export const MANIFEST_PROTOCOL_VERSION = '1.0';
export const MANIFEST_HASH_ALGORITHM = 'sha256';

const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/;
const CLIENT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/;
const PRIVATE_IDENTIFIER = /(?:secret|token|password|passwd|cookie|credential|authorization|private[-_.]?key|api[-_.]?key)/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MANIFEST_KEYS = Object.freeze(['capabilities', 'client', 'manifestHash', 'protocol', 'protocolVersion', 'scope']);
const INPUT_KEYS = Object.freeze(['capabilities', 'client', 'manifestHash', 'protocol', 'protocolVersion', 'scope']);

export class ManifestError extends TypeError {
  constructor(message, code = 'ERR_INVALID_MANIFEST') {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

/** Recursively sort object keys while preserving array order. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) output[key] = canonicalize(value[key]);
    }
    return output;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ManifestError('manifest values must be finite', 'ERR_INVALID_MANIFEST');
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new ManifestError('manifest values must be JSON-compatible', 'ERR_INVALID_MANIFEST');
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value), 'utf8').digest('hex');
}

function normalizeClient(client) {
  if (typeof client !== 'string' || !client.trim()) {
    throw new ManifestError('client must be a non-empty identifier', 'ERR_INVALID_CLIENT');
  }
  const normalized = client.trim().toLowerCase();
  if (!CLIENT_ID.test(normalized) || normalized.length > 80 || PRIVATE_IDENTIFIER.test(normalized) || containsSecretLikeValue(normalized)) {
    throw new ManifestError('client must be a public identifier', 'ERR_INVALID_CLIENT');
  }
  return normalized;
}

function assertObject(value, message = 'manifest must be an object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError(message, 'ERR_INVALID_MANIFEST');
  }
}

function assertKnownKeys(value, allowed, code = 'ERR_UNKNOWN_MANIFEST_FIELD') {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ManifestError('manifest contains an unknown field', code);
  }
}

function assertProtocol(protocol, protocolVersion) {
  if (protocol !== undefined && protocol !== MANIFEST_PROTOCOL) {
    throw new ManifestError('manifest protocol is unsupported', 'ERR_INVALID_PROTOCOL');
  }
  if (protocolVersion !== undefined && protocolVersion !== MANIFEST_PROTOCOL_VERSION) {
    throw new ManifestError('manifest protocol version is unsupported', 'ERR_INVALID_PROTOCOL_VERSION');
  }
}

function capabilityId(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id.trim().toLowerCase();
  return '';
}

function normalizeCapabilities(capabilities) {
  if (capabilities === undefined || capabilities === null) return [];
  const values = Array.isArray(capabilities)
    ? capabilities
    : (capabilities && Array.isArray(capabilities.capabilities) ? capabilities.capabilities : undefined);
  if (!values) throw new ManifestError('capabilities must be an array of at most 100 ids', 'ERR_INVALID_CAPABILITIES');
  if (!Array.isArray(values) || values.length > 100) {
    throw new ManifestError('capabilities must be an array of at most 100 ids', 'ERR_INVALID_CAPABILITIES');
  }
  const normalized = new Set();
  for (const value of values) {
    const id = capabilityId(value);
    if (!CAPABILITY_ID.test(id) || id.length > 128 || containsSecretLikeValue(id)) {
      throw new ManifestError('capabilities must contain public ids', 'ERR_INVALID_CAPABILITIES');
    }
    normalized.add(id);
  }
  return [...normalized].sort();
}

function normalizeScope(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ManifestError('scope entries must be relative paths', 'ERR_INVALID_SCOPE');
  }
  let scope = value.trim().replaceAll('\\', '/');
  if (ABSOLUTE_PATH.test(scope) || scope.startsWith('//')) {
    throw new ManifestError('scope entries must be relative paths', 'ERR_ABSOLUTE_SCOPE');
  }
  const parts = scope.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..' || CONTROL_CHARACTERS.test(part))) {
    throw new ManifestError('scope entries cannot escape the repository', 'ERR_PATH_ESCAPE');
  }
  scope = parts.join('/');
  if (!scope) scope = '.';
  if (containsSecretLikeValue(scope)) {
    throw new ManifestError('scope entries must not contain secret-like values', 'ERR_SECRET_INPUT');
  }
  return scope;
}

export function normalizeScopes(scope) {
  const values = typeof scope === 'string' ? [scope] : scope;
  if (!Array.isArray(values) || values.length > 100) {
    throw new ManifestError('scope must be an array of at most 100 relative paths', 'ERR_INVALID_SCOPE');
  }
  return [...new Set(values.map(normalizeScope))].sort();
}

function assertManifestHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ManifestError('manifest hash is invalid', 'ERR_INVALID_MANIFEST_HASH');
  }
}

/** Create a deterministic, immutable public integration manifest. */
export function createIntegrationManifest(input = {}) {
  assertObject(input, 'manifest input must be an object');
  assertKnownKeys(input, INPUT_KEYS);
  assertProtocol(input.protocol, input.protocolVersion);
  const { client, capabilities, scope } = input;
  const body = canonicalize({
    protocol: MANIFEST_PROTOCOL,
    protocolVersion: MANIFEST_PROTOCOL_VERSION,
    client: normalizeClient(client),
    capabilities: normalizeCapabilities(capabilities),
    scope: normalizeScopes(scope ?? ['.']),
  });
  const manifestHash = sha256(canonicalJson(body));
  if (input.manifestHash !== undefined) {
    assertManifestHash(input.manifestHash);
    if (input.manifestHash !== manifestHash) {
      throw new ManifestError('manifest hash does not match canonical content', 'ERR_INVALID_MANIFEST_HASH');
    }
  }
  return deepFreeze({ ...body, manifestHash });
}

function normalizeManifest(manifest) {
  assertObject(manifest);
  assertKnownKeys(manifest, MANIFEST_KEYS);
  if (!Object.hasOwn(manifest, 'protocol') || !Object.hasOwn(manifest, 'protocolVersion')) {
    throw new ManifestError('manifest protocol fields are required', 'ERR_INVALID_MANIFEST');
  }
  assertProtocol(manifest.protocol, manifest.protocolVersion);
  for (const key of MANIFEST_KEYS) {
    if (!Object.hasOwn(manifest, key)) throw new ManifestError('manifest is incomplete', 'ERR_INVALID_MANIFEST');
  }
  assertManifestHash(manifest.manifestHash);
  return createIntegrationManifest(manifest);
}

const PREVIEW_INSTRUCTIONS = Object.freeze([
  'Read the public manifest before starting a bounded local workflow.',
  'Use only the declared capabilities and relative scope.',
  'Report unavailable operations instead of simulating them.',
  'Request explicit confirmation before a mutating operation.',
  'Return terminal evidence without private context or credentials.',
]);

/**
 * Render a reviewable client-specific preview.  This is deliberately a pure
 * formatter: it never imports, launches, schedules, or configures a client.
 */
export function renderClientPreview(target, manifest) {
  if (!['generic', 'codex', 'claude'].includes(target)) {
    throw new ManifestError('preview target must be generic, codex, or claude', 'ERR_UNKNOWN_PREVIEW_TARGET');
  }
  const normalized = normalizeManifest(manifest);
  const preview = {
    target,
    protocol: normalized.protocol,
    protocolVersion: normalized.protocolVersion,
    client: normalized.client,
    capabilities: [...normalized.capabilities],
    scope: [...normalized.scope],
    manifestHash: normalized.manifestHash,
    manifest: normalized,
    verification: { status: 'unverified', invokesClient: false, manifestHash: normalized.manifestHash },
    instructions: [...PREVIEW_INSTRUCTIONS],
  };
  return deepFreeze(preview);
}

export function validateIntegrationManifest(manifest) {
  return normalizeManifest(manifest);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
