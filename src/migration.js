/**
 * Preview-first, reversible local workflow migration.
 *
 * The plan, ownership marker, and rollback receipt are closed canonical
 * contracts. Files are touched only after those contracts and every path have
 * been validated. No client process, network, or ambient configuration is
 * consulted.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { containsSecretLikeValue } from './text-safety.js';
import { canonicalJson, createIntegrationManifest, sha256, validateIntegrationManifest } from './manifest.js';

export const MIGRATION_VERSION = 1;
export const OWNER_MARKER = 'worktree-proof-owned:v1';
export const MIGRATION_KIND = 'worktree-proof-migration-receipt';
export const RECEIPT_VERSION = 1;

const PROTOCOL = 'worktreeproof';
const PROTOCOL_VERSION = '1.0';
const ABSOLUTE_POSIX = /^\//u;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const DRIVE_RELATIVE = /^[A-Za-z]:[^\\/]/u;
// Treat both slash styles as UNC/device paths.  On Windows, `path.resolve`
// would otherwise turn a forward-slash UNC/device spelling into an ordinary
// local path before the safety checks see it.
const UNC_PATH = /^(?:\\\\|\/\/)/u;
const DEVICE_PATH = /^(?:\\\\|\/\/)[?.](?:\\|\/)/u;
const CLIENT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_INVALID = /[<>:"|?*]/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const SENSITIVE_PATH = /(?:^|[\\/._-])(?:\.env(?:\.|$)|env|secret|secrets|credential|credentials|password|passwd|token|tokens|cookie|cookies|auth|authorization|private[-_.]?key|api[-_.]?key)(?:$|[\\/._-])/iu;
const LOCK_PATH = /(?:^|[\\/._-])(?:lock|locks|package-lock|yarn-lock|pnpm-lock)(?:$|[\\/._-])/iu;
const DESTRUCTIVE_MODE = /^(?:delete|remove|destroy|truncate|overwrite)$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_CLIENTS = 20;
const MAX_ARTIFACT_FILES = 100;
const MAX_WRITES = 100;
const JOURNAL_KIND = 'worktree-proof-migration-journal';
const LOCK_KIND = 'worktree-proof-migration-lock';
const CLAIM_KIND = 'worktree-proof-migration-claim';
const LOCK_VERSION = 1;
const JOURNAL_KEYS = Object.freeze(['backupRoot', 'entries', 'home', 'journalPath', 'kind', 'owner', 'planHash', 'recoveryId', 'status', 'version']);
const JOURNAL_ENTRY_KEYS = Object.freeze(['appliedContentHash', 'appliedMarkerHash', 'backupPath', 'existed', 'markerBackupPath', 'markerPath', 'path', 'preContentHash', 'preMarkerHash', 'state']);
const JOURNAL_STATES = new Set(['planned', 'backed-up', 'target-written', 'applied', 'pending', 'target-restoring', 'target-restored', 'marker-restoring', 'marker-restored', 'restored']);
const JOURNAL_STATUSES = new Set(['applying', 'applied', 'rolling-back', 'restored', 'rolled-back']);
const LOCK_KEYS = Object.freeze(['backupRoot', 'journalPath', 'kind', 'owner', 'ownerNonce', 'planHash', 'recoveryId', 'state', 'version']);
const CLAIM_KEYS = Object.freeze(['backupRoot', 'claimantNonce', 'journalPath', 'kind', 'lockOwnerNonce', 'owner', 'planHash', 'recoveryId', 'version']);

const PLAN_KEYS = Object.freeze(['artifact', 'clients', 'home', 'planHash', 'preview', 'protocol', 'protocolVersion', 'rollback', 'version', 'writes']);
const PLAN_BODY_KEYS = Object.freeze(PLAN_KEYS.filter((key) => key !== 'planHash'));
const ARTIFACT_KEYS = Object.freeze(['files', 'manifestHash']);
const CLIENT_KEYS = Object.freeze(['name', 'root']);
const ARTIFACT_FILE_KEYS = Object.freeze(['clients', 'contentHash', 'path']);
const WRITE_KEYS = Object.freeze(['content', 'contentHash', 'existing', 'existingHash', 'markerContent', 'markerHash', 'markerPath', 'mode', 'owner', 'path']);
const ROLLBACK_KEYS = Object.freeze(['owner', 'strategy']);
const RECEIPT_KEYS = Object.freeze(['backupRoot', 'backups', 'confirmed', 'home', 'journalPath', 'kind', 'planHash', 'preview', 'receiptHash', 'receiptVersion', 'written']);
const RECEIPT_BODY_KEYS = Object.freeze(RECEIPT_KEYS.filter((key) => key !== 'receiptHash'));
const BACKUP_KEYS = Object.freeze(['appliedContentHash', 'appliedMarkerHash', 'backupPath', 'existed', 'markerBackupPath', 'markerPath', 'markerSha256', 'path', 'sha256']);

export class MigrationSafetyError extends Error {
  constructor(message, code = 'ERR_MIGRATION', recoveryReceipt) {
    super(message);
    this.name = 'MigrationSafetyError';
    this.code = code;
    if (typeof recoveryReceipt === 'string') this.recoveryReceipt = recoveryReceipt;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactKeys(value, allowed, required = allowed, code = 'ERR_INVALID_PLAN') {
  if (!object(value)) throw new MigrationSafetyError('migration contract must be an object', code);
  const keys = Object.keys(value).sort();
  const accepted = [...allowed].sort();
  if (keys.length !== accepted.length || keys.some((key, index) => key !== accepted[index])) {
    throw new MigrationSafetyError('migration contract contains unknown fields', code);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new MigrationSafetyError('migration contract is incomplete', code);
  }
}

function hash(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex');
}

function assertHash(value, code = 'ERR_INVALID_PLAN') {
  if (typeof value !== 'string' || !HASH.test(value)) throw new MigrationSafetyError('migration hash is invalid', code);
  return value;
}

function isPortableAbsolute(value) {
  return typeof value === 'string' && (ABSOLUTE_POSIX.test(value) || DRIVE_ABSOLUTE.test(value) || UNC_PATH.test(value));
}

function rejectUnsupportedAbsolute(value, code = 'ERR_INVALID_PATH') {
  if (typeof value !== 'string' || !value.trim()) throw new MigrationSafetyError('path is required', code);
  const text = value.trim();
  if (DEVICE_PATH.test(text) || DRIVE_RELATIVE.test(text)) throw new MigrationSafetyError('device or drive-relative paths are refused', code);
  return text;
}

function resolveHome(home) {
  const text = rejectUnsupportedAbsolute(home, 'ERR_INVALID_HOME');
  if (!isPortableAbsolute(text) || DEVICE_PATH.test(text) || UNC_PATH.test(text)) {
    throw new MigrationSafetyError('home must be an explicit local absolute path', 'ERR_INVALID_HOME');
  }
  const root = resolve(text);
  if (!isAbsolute(root) || dirname(root) === root && root.length <= 3) {
    throw new MigrationSafetyError('home must be an explicit local directory', 'ERR_INVALID_HOME');
  }
  return root;
}

function normalizeRelative(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim()) throw new MigrationSafetyError(`${label} is required`, 'ERR_INVALID_PATH');
  let normalized = value.trim().replaceAll('\\', '/');
  if (CONTROL.test(normalized) || DEVICE_PATH.test(normalized) || UNC_PATH.test(normalized)) {
    throw new MigrationSafetyError(`${label} contains an unsupported UNC or device path`, 'ERR_INVALID_PATH');
  }
  if (normalized.startsWith('/') || DRIVE_ABSOLUTE.test(normalized) || DRIVE_RELATIVE.test(normalized)) {
    throw new MigrationSafetyError(`${label} must be relative`, 'ERR_PATH_ESCAPE');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) throw new MigrationSafetyError(`${label} is empty`, 'ERR_INVALID_PATH');
  for (const part of parts) {
    if (part === '..') throw new MigrationSafetyError(`${label} escapes its root`, 'ERR_PATH_ESCAPE');
    if (part === '.') continue;
    if (CONTROL.test(part) || WINDOWS_INVALID.test(part) || WINDOWS_RESERVED.test(part) || /[ .]$/u.test(part)) {
      throw new MigrationSafetyError(`${label} contains an invalid Windows segment`, 'ERR_INVALID_PATH');
    }
  }
  normalized = parts.filter((part) => part !== '.').join('/');
  if (!normalized) throw new MigrationSafetyError(`${label} is empty`, 'ERR_INVALID_PATH');
  if (SENSITIVE_PATH.test(normalized)) throw new MigrationSafetyError('sensitive migration paths are refused', 'ERR_SENSITIVE_PATH');
  if (LOCK_PATH.test(normalized)) throw new MigrationSafetyError('lock migration paths are refused', 'ERR_LOCK_PATH');
  return normalized;
}

function ensureInside(root, candidate, { allowRoot = false } = {}) {
  const rel = relative(root, candidate);
  if ((!allowRoot && rel === '') || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MigrationSafetyError('migration path escapes its root', 'ERR_PATH_ESCAPE');
  }
}

async function pathExists(file) {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function rejectReparseAbsolute(absolutePath, { allowMissing = true } = {}) {
  const text = resolve(absolutePath);
  const parsed = parse(text);
  const tail = relative(parsed.root, text).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const part of tail) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new MigrationSafetyError('symlink or reparse point in migration path', 'ERR_SYMLINK_ESCAPE');
    } catch (error) {
      if (error instanceof MigrationSafetyError) throw error;
      if (error?.code === 'ENOENT' && allowMissing) return;
      throw new MigrationSafetyError('migration path is not accessible', 'ERR_PATH_ACCESS');
    }
  }
}

/**
 * Revalidate the parent and final path boundary immediately before a file
 * operation.  This is deliberately a user-space boundary: it closes the
 * symlink/reparse and parent-swap window we can observe, but it cannot make a
 * Windows/POSIX rename an openat-style primitive against an OS-level attacker.
 */
async function revalidateBoundary(root, relativePath, { allowMissing = true } = {}) {
  const normalized = normalizeRelative(relativePath);
  const absolute = resolve(root, normalized);
  ensureInside(root, absolute);
  await rejectReparseComponents(root, normalized);
  let rootReal;
  try {
    rootReal = await realpath(root);
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) return;
    throw new MigrationSafetyError('migration root is not accessible', 'ERR_PATH_ACCESS');
  }
  const parent = dirname(absolute);
  try {
    const parentReal = await realpath(parent);
    ensureInside(rootReal, parentReal, { allowRoot: true });
  } catch (error) {
    if (error instanceof MigrationSafetyError) throw error;
    if (error?.code === 'ENOENT' && allowMissing) return;
    throw new MigrationSafetyError('migration parent is not accessible', 'ERR_PATH_ACCESS');
  }
  if (!allowMissing) {
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new MigrationSafetyError('migration target is not a regular file', 'ERR_PATH_COLLISION');
      const finalReal = await realpath(absolute);
      ensureInside(rootReal, finalReal);
    } catch (error) {
      if (error instanceof MigrationSafetyError) throw error;
      if (error?.code === 'ENOENT') throw new MigrationSafetyError('migration target is missing', 'ERR_PATH_ACCESS');
      throw new MigrationSafetyError('migration target is not accessible', 'ERR_PATH_ACCESS');
    }
  }
}

async function rejectReparseComponents(root, relativePath) {
  const normalized = normalizeRelative(relativePath);
  const parts = normalized.split('/');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new MigrationSafetyError('symlink or reparse point in migration path', 'ERR_SYMLINK_ESCAPE');
    } catch (error) {
      if (error instanceof MigrationSafetyError) throw error;
      if (error?.code === 'ENOENT') return;
      throw new MigrationSafetyError('migration path is not accessible', 'ERR_PATH_ACCESS');
    }
  }
}

function publicClientId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new MigrationSafetyError('client must be a non-empty identifier', 'ERR_INVALID_CLIENT');
  const id = value.trim().toLowerCase();
  if (!CLIENT_ID.test(id) || id.length > 80 || containsSecretLikeValue(id)) throw new MigrationSafetyError('client must be a public identifier', 'ERR_INVALID_CLIENT');
  return id;
}

function clientSpecs(clients) {
  const values = clients === undefined || clients === null ? ['codex', 'claude'] : (typeof clients === 'string' ? clients.split(',') : clients);
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_CLIENTS) throw new MigrationSafetyError('clients must contain one to twenty identifiers', 'ERR_INVALID_CLIENTS');
  const seen = new Set();
  const roots = [];
  const specs = values.map((entry) => {
    const spec = typeof entry === 'string' ? { name: entry } : entry;
    if (!object(spec)) throw new MigrationSafetyError('client specification is invalid', 'ERR_INVALID_CLIENT');
    const name = publicClientId(spec.name ?? spec.client ?? spec.id);
    if (seen.has(name)) throw new MigrationSafetyError('clients must be unique', 'ERR_DUPLICATE_CLIENT');
    seen.add(name);
    const root = spec.root ?? spec.rootPath ?? spec.directory ?? (name === 'codex' ? '.codex' : name === 'claude' ? '.claude' : `.${name}`);
    const normalizedRoot = normalizeRelative(root, 'client root');
    if (roots.some((candidate) => candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`) || normalizedRoot.startsWith(`${candidate}/`))) {
      throw new MigrationSafetyError('client roots overlap', 'ERR_CLIENT_ROOT_COLLISION');
    }
    roots.push(normalizedRoot);
    return Object.freeze({ name, root: normalizedRoot });
  });
  return specs.sort((left, right) => left.name.localeCompare(right.name) || left.root.localeCompare(right.root));
}

function normalizeClientFilter(value) {
  if (value === undefined || value === null) return null;
  const values = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_CLIENTS) {
    throw new MigrationSafetyError('artifact client filter is invalid', 'ERR_INVALID_CLIENT_FILTER');
  }
  const result = values.map((entry) => publicClientId(typeof entry === 'string' ? entry : entry?.name ?? entry?.client ?? entry?.id));
  if (new Set(result).size !== result.length) throw new MigrationSafetyError('artifact client filter contains duplicates', 'ERR_DUPLICATE_CLIENT_FILTER');
  return result.sort((left, right) => left.localeCompare(right));
}

function markerPath(pathValue) {
  return `${pathValue}.worktree-proof-owner`;
}

function markerValue({ path: pathValue, contentHash, manifestHash }) {
  return {
    contentHash,
    manifestHash,
    owner: OWNER_MARKER,
    path: pathValue,
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
  };
}

function markerText(value) {
  return `${canonicalJson(value)}\n`;
}

function parseMarker(text, expected) {
  if (typeof text !== 'string' || !text.endsWith('\n')) throw new MigrationSafetyError('ownership marker is malformed', 'ERR_INVALID_OWNER_MARKER');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MigrationSafetyError('ownership marker is malformed', 'ERR_INVALID_OWNER_MARKER');
  }
  exactKeys(value, ['contentHash', 'manifestHash', 'owner', 'path', 'protocol', 'protocolVersion'], undefined, 'ERR_INVALID_OWNER_MARKER');
  if (value.owner !== OWNER_MARKER || value.protocol !== PROTOCOL || value.protocolVersion !== PROTOCOL_VERSION || value.path !== expected.path || value.contentHash !== expected.contentHash || !HASH.test(value.manifestHash) || (expected.manifestHash !== undefined && value.manifestHash !== expected.manifestHash)) {
    throw new MigrationSafetyError('ownership marker is not bound to its target', 'ERR_INVALID_OWNER_MARKER');
  }
  if (text !== markerText(value)) throw new MigrationSafetyError('ownership marker is not canonical', 'ERR_INVALID_OWNER_MARKER');
  return value;
}

function artifactManifest(value) {
  if (object(value?.manifest)) return validateIntegrationManifest(value.manifest);
  if (object(value?.integrationManifest)) return validateIntegrationManifest(value.integrationManifest);
  if (object(value) && value.protocol === PROTOCOL) return validateIntegrationManifest(value);
  return createIntegrationManifest({ client: 'generic', capabilities: [], scope: ['.'] });
}

async function normalizeArtifact(artifact) {
  let value = artifact;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{')) {
      try { value = JSON.parse(text); } catch { throw new MigrationSafetyError('artifact JSON is invalid', 'ERR_INVALID_ARTIFACT'); }
    } else {
      try { value = JSON.parse(await readFile(resolve(text), 'utf8')); } catch { throw new MigrationSafetyError('artifact file is not readable', 'ERR_INVALID_ARTIFACT'); }
    }
  }
  if (!object(value)) throw new MigrationSafetyError('artifact must be an object', 'ERR_INVALID_ARTIFACT');
  if (value.destructive === true || value.delete === true || value.remove === true || DESTRUCTIVE_MODE.test(String(value.mode ?? ''))) throw new MigrationSafetyError('destructive migration entries are refused', 'ERR_DESTRUCTIVE_CHANGE');
  const manifest = artifactManifest(value);
  const sourceFiles = value.files ?? value.entries;
  const files = [];
  if (Array.isArray(sourceFiles)) {
    for (const entry of sourceFiles) {
      if (!object(entry) || typeof entry.path !== 'string' || typeof entry.content !== 'string') throw new MigrationSafetyError('artifact files require path and text content', 'ERR_INVALID_ARTIFACT');
      if (DESTRUCTIVE_MODE.test(String(entry.mode ?? ''))) throw new MigrationSafetyError('destructive migration entries are refused', 'ERR_DESTRUCTIVE_CHANGE');
      files.push({ path: entry.path, content: entry.content, clients: normalizeClientFilter(entry.clients ?? entry.targets ?? (entry.client ? [entry.client] : undefined)) });
    }
  } else if (object(sourceFiles)) {
    for (const [pathValue, content] of Object.entries(sourceFiles)) {
      if (typeof content !== 'string') throw new MigrationSafetyError('artifact file content must be text', 'ERR_INVALID_ARTIFACT');
      files.push({ path: pathValue, content, clients: null });
    }
  }
  if (files.length === 0) {
    const pathValue = typeof value.path === 'string' ? value.path : 'worktree-proof.manifest.json';
    const content = typeof value.content === 'string' ? value.content : `${JSON.stringify(manifest, null, 2)}\n`;
    files.push({ path: pathValue, content, clients: null });
  }
  if (files.length > MAX_ARTIFACT_FILES) throw new MigrationSafetyError('artifact files exceed the hard bound', 'ERR_ARTIFACT_LIMIT');
  for (const file of files) if (containsSecretLikeValue(file.content)) throw new MigrationSafetyError('artifact contains secret-like content', 'ERR_SECRET_INPUT');
  return { manifest, files };
}

function appliesToClient(file, client) {
  if (file.clients === null || file.clients === undefined) return true;
  return file.clients.includes(client.name);
}

function targetPath(client, source) {
  const normalized = normalizeRelative(source, 'artifact path');
  return normalizeRelative(normalized === client.root || normalized.startsWith(`${client.root}/`) ? normalized : `${client.root}/${normalized}`);
}

async function inspectTarget(home, pathValue, content, manifestHash) {
  const target = resolve(home, pathValue);
  const ownerPath = markerPath(pathValue);
  const ownerAbsolute = resolve(home, ownerPath);
  ensureInside(home, target);
  ensureInside(home, ownerAbsolute);
  await rejectReparseComponents(home, pathValue);
  await rejectReparseComponents(home, ownerPath);
  const contentHash = hash(content);
  const exists = await pathExists(target);
  const ownerExists = await pathExists(ownerAbsolute);
  if (!exists && ownerExists) throw new MigrationSafetyError('orphan ownership marker refused', 'ERR_INVALID_OWNER_MARKER');
  let existingHash = null;
  let mode = 'create';
  if (exists) {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new MigrationSafetyError('target collision is not a regular file', 'ERR_PATH_COLLISION');
    const bytes = await readFile(target);
    existingHash = hash(bytes);
    if (!ownerExists) throw new MigrationSafetyError('unowned target collision refused', 'ERR_UNOWNED_COLLISION');
    parseMarker(await readFile(ownerAbsolute, 'utf8'), { path: pathValue, contentHash: existingHash });
    mode = 'replace';
  }
  const marker = markerValue({ path: pathValue, contentHash, manifestHash });
  return {
    path: pathValue,
    content,
    contentHash,
    existing: exists,
    existingHash,
    markerPath: ownerPath,
    markerContent: markerText(marker),
    markerHash: hash(markerText(marker)),
    mode,
    owner: OWNER_MARKER,
  };
}

function planHash(body) {
  const withoutHash = { ...body };
  delete withoutHash.planHash;
  return sha256(canonicalJson(withoutHash));
}

function assertManifestHash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new MigrationSafetyError('manifest hash is invalid', 'ERR_INVALID_PLAN');
}

function canonicalPlanTargets(plan) {
  const targets = new Map();
  for (const client of plan.clients) {
    for (const file of plan.artifact.files) {
      if (file.clients !== null && !file.clients.includes(client.name)) continue;
      const pathValue = targetPath(client, file.path);
      if (targets.has(pathValue)) throw new MigrationSafetyError('migration targets collide', 'ERR_PLAN_COLLISION');
      targets.set(pathValue, { contentHash: file.contentHash, client: client.name, artifactPath: file.path });
    }
  }
  return targets;
}

function validatePlan(plan) {
  exactKeys(plan, PLAN_KEYS, PLAN_KEYS, 'ERR_INVALID_PLAN');
  if (plan.version !== MIGRATION_VERSION || plan.protocol !== PROTOCOL || plan.protocolVersion !== PROTOCOL_VERSION || plan.preview !== true) throw new MigrationSafetyError('migration plan protocol is invalid', 'ERR_INVALID_PLAN');
  const home = resolveHome(plan.home);
  if (!Array.isArray(plan.clients) || plan.clients.length === 0 || plan.clients.length > MAX_CLIENTS) throw new MigrationSafetyError('migration plan clients are invalid', 'ERR_INVALID_PLAN');
  const clientNames = new Set();
  const clientRoots = [];
  for (const client of plan.clients) {
    exactKeys(client, CLIENT_KEYS, CLIENT_KEYS, 'ERR_INVALID_PLAN');
    const name = publicClientId(client.name);
    const root = normalizeRelative(client.root, 'client root');
    if (name !== client.name || root !== client.root || clientNames.has(name)) throw new MigrationSafetyError('migration plan clients are not canonical', 'ERR_INVALID_PLAN');
    if (clientRoots.some((candidate) => candidate === root || candidate.startsWith(`${root}/`) || root.startsWith(`${candidate}/`))) throw new MigrationSafetyError('migration plan client roots overlap', 'ERR_INVALID_PLAN');
    clientNames.add(name);
    clientRoots.push(root);
  }
  const sortedClients = plan.clients.slice().sort((left, right) => left.name.localeCompare(right.name) || left.root.localeCompare(right.root));
  if (sortedClients.some((client, index) => client.name !== plan.clients[index].name || client.root !== plan.clients[index].root)) throw new MigrationSafetyError('migration plan clients are not sorted', 'ERR_INVALID_PLAN');
  exactKeys(plan.artifact, ARTIFACT_KEYS, ARTIFACT_KEYS, 'ERR_INVALID_PLAN');
  assertManifestHash(plan.artifact.manifestHash);
  if (!Array.isArray(plan.artifact.files) || plan.artifact.files.length === 0 || plan.artifact.files.length > MAX_ARTIFACT_FILES) throw new MigrationSafetyError('migration artifact files are invalid', 'ERR_INVALID_PLAN');
  const artifactEntries = new Set();
  for (const file of plan.artifact.files) {
    exactKeys(file, ARTIFACT_FILE_KEYS, ARTIFACT_FILE_KEYS, 'ERR_INVALID_PLAN');
    const pathValue = normalizeRelative(file.path, 'artifact path');
    if (pathValue !== file.path) throw new MigrationSafetyError('migration artifact path is not canonical', 'ERR_INVALID_PLAN');
    if (file.clients !== null) {
      if (!Array.isArray(file.clients) || file.clients.length === 0 || file.clients.length > MAX_CLIENTS) throw new MigrationSafetyError('migration artifact client filter is invalid', 'ERR_INVALID_PLAN');
      const filters = file.clients.map((entry) => publicClientId(entry));
      if (new Set(filters).size !== filters.length || filters.some((entry, index) => entry !== file.clients[index])) throw new MigrationSafetyError('migration artifact client filter is not canonical', 'ERR_INVALID_PLAN');
      if (filters.some((entry) => !clientNames.has(entry))) throw new MigrationSafetyError('migration artifact client filter references an undeclared client', 'ERR_INVALID_CLIENT_FILTER');
    }
    assertHash(file.contentHash);
    const key = `${file.path}\u0000${file.clients === null ? '' : file.clients.join(',')}`;
    if (artifactEntries.has(key)) throw new MigrationSafetyError('migration artifact entries collide', 'ERR_INVALID_PLAN');
    artifactEntries.add(key);
  }
  const sortedArtifacts = plan.artifact.files.slice().sort((left, right) => left.path.localeCompare(right.path) || (left.clients ?? []).join(',').localeCompare((right.clients ?? []).join(',')));
  if (sortedArtifacts.some((file, index) => file.path !== plan.artifact.files[index].path || JSON.stringify(file.clients) !== JSON.stringify(plan.artifact.files[index].clients))) throw new MigrationSafetyError('migration artifact files are not sorted', 'ERR_INVALID_PLAN');
  exactKeys(plan.rollback, ROLLBACK_KEYS, ROLLBACK_KEYS, 'ERR_INVALID_PLAN');
  if (plan.rollback.owner !== OWNER_MARKER || plan.rollback.strategy !== 'byte-identical-backups') throw new MigrationSafetyError('migration rollback contract is invalid', 'ERR_INVALID_PLAN');
  if (!Array.isArray(plan.writes) || plan.writes.length === 0 || plan.writes.length > MAX_WRITES) throw new MigrationSafetyError('migration plan writes are invalid', 'ERR_INVALID_PLAN');
  const expectedTargets = canonicalPlanTargets(plan);
  const sortedTargets = plan.writes.map((write) => write.path).slice().sort((left, right) => left.localeCompare(right));
  if (sortedTargets.join('\u0000') !== plan.writes.map((write) => write.path).join('\u0000') || expectedTargets.size !== plan.writes.length) throw new MigrationSafetyError('migration writes are not canonical artifact outputs', 'ERR_INVALID_PLAN');
  const paths = new Set();
  for (const write of plan.writes) {
    exactKeys(write, WRITE_KEYS, WRITE_KEYS, 'ERR_INVALID_PLAN');
    const pathValue = normalizeRelative(write.path, 'migration path');
    const ownerPath = normalizeRelative(write.markerPath, 'ownership marker path');
    if (pathValue !== write.path || ownerPath !== write.markerPath || ownerPath !== markerPath(pathValue)) throw new MigrationSafetyError('migration path is not canonical', 'ERR_INVALID_PLAN');
    if (paths.has(pathValue)) throw new MigrationSafetyError('migration targets collide', 'ERR_INVALID_PLAN');
    const expected = expectedTargets.get(pathValue);
    if (!expected) throw new MigrationSafetyError('migration target is outside canonical client outputs', 'ERR_INVALID_PLAN');
    paths.add(pathValue);
    if (typeof write.content !== 'string' || containsSecretLikeValue(write.content)) throw new MigrationSafetyError('migration content is unsafe', 'ERR_SECRET_INPUT');
    assertHash(write.contentHash);
    if (hash(write.content) !== write.contentHash) throw new MigrationSafetyError('migration content hash changed', 'ERR_PLAN_CHANGED');
    if (expected.contentHash !== write.contentHash) throw new MigrationSafetyError('migration write does not match its canonical artifact output', 'ERR_INVALID_PLAN');
    if (write.existing !== (write.mode === 'replace') || (write.mode !== 'create' && write.mode !== 'replace')) throw new MigrationSafetyError('migration write mode is invalid', 'ERR_INVALID_PLAN');
    if (write.owner !== OWNER_MARKER) throw new MigrationSafetyError('migration write owner is invalid', 'ERR_INVALID_PLAN');
    if (write.existingHash !== null) assertHash(write.existingHash);
    if ((write.mode === 'create' && write.existingHash !== null) || (write.mode === 'replace' && write.existingHash === null)) throw new MigrationSafetyError('migration write pre-state is invalid', 'ERR_INVALID_PLAN');
    assertHash(write.markerHash);
    if (hash(write.markerContent) !== write.markerHash) throw new MigrationSafetyError('ownership marker hash changed', 'ERR_PLAN_CHANGED');
    parseMarker(write.markerContent, { path: pathValue, contentHash: write.contentHash, manifestHash: plan.artifact.manifestHash });
  }
  if (planHash(plan) !== plan.planHash) throw new MigrationSafetyError('migration plan hash is invalid', 'ERR_PLAN_CHANGED');
  return { home, plan };
}

async function atomicWrite(file, data, { replace = false, root, relativePath, hooks } = {}) {
  const parent = dirname(file);
  if (root && relativePath) {
    ensureInside(root, resolve(root, relativePath));
    await rejectReparseComponents(root, relativePath);
    await revalidateBoundary(root, relativePath, { allowMissing: true });
  } else {
    await rejectReparseAbsolute(parent);
  }
  await mkdir(parent, { recursive: true });
  if (root && relativePath) await revalidateBoundary(root, relativePath, { allowMissing: true });
  const temporary = join(parent, `.${parse(file).base}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!replace && await pathExists(file)) throw new MigrationSafetyError('refusing to overwrite a backup', 'ERR_BACKUP_COLLISION');
    await callHook(hooks, 'beforeRename', file);
    if (root && relativePath) {
      await revalidateBoundary(root, relativePath, { allowMissing: true });
    } else {
      await rejectReparseAbsolute(parent, { allowMissing: false });
    }
    await rename(temporary, file);
    if (root && relativePath) {
      await revalidateBoundary(root, relativePath, { allowMissing: false });
    } else {
      await rejectReparseAbsolute(file, { allowMissing: false });
    }
    const written = await readFile(file);
    if (hash(written) !== hash(data)) {
      const error = new MigrationSafetyError('migration write identity changed after rename', 'ERR_WRITE_VERIFY');
      error.mutated = true;
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// Lock and claim records are protocol files rather than migration targets;
// their canonical names intentionally contain the reserved `lock` segment.
// Keep their write primitive separate so target-path validation cannot reject
// the very lock needed to protect recovery.
async function atomicProtocolWrite(file, data, root) {
  const destination = resolve(file);
  const rootPath = resolve(root);
  ensureInside(rootPath, destination);
  const parent = dirname(destination);
  await rejectReparseAbsolute(rootPath, { allowMissing: false });
  await mkdir(parent, { recursive: true });
  await rejectReparseAbsolute(parent, { allowMissing: false });
  const temporary = join(parent, `.${parse(destination).base}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rejectReparseAbsolute(parent, { allowMissing: false });
    await rename(temporary, destination);
    await rejectReparseAbsolute(destination, { allowMissing: false });
    const verify = await readFile(destination);
    if (!verify.equals(Buffer.from(data))) throw new MigrationSafetyError('protocol record changed after rename', 'ERR_MIGRATION_LOCK');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function safeRead(file, { root, relativePath, encoding } = {}) {
  if (root && relativePath) {
    ensureInside(root, resolve(root, relativePath));
    await rejectReparseComponents(root, relativePath);
    await revalidateBoundary(root, relativePath, { allowMissing: false });
  } else {
    await rejectReparseAbsolute(dirname(file));
  }
  const value = await readFile(file, encoding);
  if (root && relativePath) {
    await revalidateBoundary(root, relativePath, { allowMissing: false });
  } else {
    await rejectReparseAbsolute(file, { allowMissing: false });
  }
  return value;
}

async function backupBytes(backupRoot, index, bytes, hooks) {
  const run = join(backupRoot, `run-${new Date().toISOString().replaceAll(/[^0-9]/gu, '')}-${randomUUID()}`);
  const backupPath = join(run, `entry-${String(index).padStart(4, '0')}.bin`);
  const relativePath = relative(backupRoot, backupPath);
  await atomicWrite(backupPath, bytes, { hooks, root: backupRoot, relativePath });
  const verify = await safeRead(backupPath, { root: backupRoot, relativePath });
  if (hash(verify) !== hash(bytes)) throw new MigrationSafetyError('backup byte verification failed', 'ERR_BACKUP_VERIFY');
  return backupPath;
}

function recoveryIdFor(planHash) {
  return `recovery-${planHash}`;
}

function lockBody(lock) {
  return {
    version: LOCK_VERSION,
    kind: LOCK_KIND,
    owner: OWNER_MARKER,
    state: lock.state,
    backupRoot: lock.backupRoot,
    journalPath: lock.journalPath,
    planHash: lock.planHash,
    recoveryId: lock.recoveryId,
    ownerNonce: lock.ownerNonce,
  };
}

function validateLockRecord(record, { expected } = {}) {
  exactKeys(record, LOCK_KEYS, LOCK_KEYS, 'ERR_MIGRATION_LOCK');
  if (record.version !== LOCK_VERSION || record.kind !== LOCK_KIND || record.owner !== OWNER_MARKER || !['active', 'recoverable'].includes(record.state)) {
    throw new MigrationSafetyError('migration lock ownership or state is invalid', 'ERR_MIGRATION_LOCK');
  }
  const backupRootText = rejectUnsupportedAbsolute(record.backupRoot, 'ERR_MIGRATION_LOCK');
  if (!isPortableAbsolute(backupRootText) || DEVICE_PATH.test(backupRootText) || UNC_PATH.test(backupRootText)) throw new MigrationSafetyError('migration lock backup root is invalid', 'ERR_MIGRATION_LOCK');
  const backupRoot = resolve(backupRootText);
  if (dirname(backupRoot) === backupRoot || backupRoot !== resolve(backupRootText)) throw new MigrationSafetyError('migration lock backup root is not canonical', 'ERR_MIGRATION_LOCK');
  if (typeof record.journalPath !== 'string') throw new MigrationSafetyError('migration lock journal path is invalid', 'ERR_MIGRATION_LOCK');
  const journalPath = validateBackupPath(backupRoot, backupRoot, record.journalPath, 'ERR_MIGRATION_LOCK');
  assertHash(record.planHash, 'ERR_MIGRATION_LOCK');
  if (record.recoveryId !== recoveryIdFor(record.planHash)) throw new MigrationSafetyError('migration lock recovery id is invalid', 'ERR_MIGRATION_LOCK');
  if (typeof record.ownerNonce !== 'string' || !/^[0-9a-f-]{16,}$/iu.test(record.ownerNonce) || CONTROL.test(record.ownerNonce)) throw new MigrationSafetyError('migration lock owner nonce is invalid', 'ERR_MIGRATION_LOCK');
  if (expected) {
    if ((expected.backupRoot !== undefined && expected.backupRoot !== backupRoot)
      || (expected.journalPath !== undefined && expected.journalPath !== journalPath)
      || (expected.planHash !== undefined && expected.planHash !== record.planHash)
      || (expected.recoveryId !== undefined && expected.recoveryId !== record.recoveryId)
      || (expected.ownerNonce !== undefined && expected.ownerNonce !== record.ownerNonce)
      || (expected.state !== undefined && expected.state !== record.state)) {
      throw new MigrationSafetyError('migration lock does not match recovery journal', 'ERR_MIGRATION_LOCK');
    }
  }
  return { ...record, backupRoot, journalPath };
}

async function readCanonicalLock(lockPath, expected = {}) {
  const backupRoot = expected.backupRoot ?? dirname(lockPath);
  let raw;
  try {
    ensureInside(backupRoot, resolve(lockPath));
    await rejectReparseAbsolute(lockPath, { allowMissing: false });
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new MigrationSafetyError('migration lock is missing', 'ERR_MIGRATION_LOCK');
    throw new MigrationSafetyError('migration lock is unreadable', 'ERR_MIGRATION_LOCK');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new MigrationSafetyError('migration lock is malformed', 'ERR_MIGRATION_LOCK'); }
  const validated = validateLockRecord(parsed, expected);
  if (raw !== `${canonicalJson(parsed)}\n`) throw new MigrationSafetyError('migration lock is not canonical', 'ERR_MIGRATION_LOCK');
  return validated;
}

function claimBody(claim) {
  return {
    version: LOCK_VERSION,
    kind: CLAIM_KIND,
    owner: OWNER_MARKER,
    backupRoot: claim.backupRoot,
    journalPath: claim.journalPath,
    planHash: claim.planHash,
    recoveryId: claim.recoveryId,
    lockOwnerNonce: claim.lockOwnerNonce,
    claimantNonce: claim.claimantNonce,
  };
}

function validateClaimRecord(record, { expected } = {}) {
  exactKeys(record, CLAIM_KEYS, CLAIM_KEYS, 'ERR_MIGRATION_LOCK');
  if (record.version !== LOCK_VERSION || record.kind !== CLAIM_KIND || record.owner !== OWNER_MARKER) throw new MigrationSafetyError('migration recovery claim is invalid', 'ERR_MIGRATION_LOCK');
  const backupRootText = rejectUnsupportedAbsolute(record.backupRoot, 'ERR_MIGRATION_LOCK');
  if (!isPortableAbsolute(backupRootText) || DEVICE_PATH.test(backupRootText) || UNC_PATH.test(backupRootText)) throw new MigrationSafetyError('migration recovery claim root is invalid', 'ERR_MIGRATION_LOCK');
  const backupRoot = resolve(backupRootText);
  const journalPath = validateBackupPath(backupRoot, backupRoot, record.journalPath, 'ERR_MIGRATION_LOCK');
  assertHash(record.planHash, 'ERR_MIGRATION_LOCK');
  if (record.recoveryId !== recoveryIdFor(record.planHash)) throw new MigrationSafetyError('migration recovery claim id is invalid', 'ERR_MIGRATION_LOCK');
  for (const [name, value] of [['lockOwnerNonce', record.lockOwnerNonce], ['claimantNonce', record.claimantNonce]]) {
    if (typeof value !== 'string' || !/^[0-9a-f-]{16,}$/iu.test(value) || CONTROL.test(value)) throw new MigrationSafetyError(`migration recovery claim ${name} is invalid`, 'ERR_MIGRATION_LOCK');
  }
  if (expected && (expected.backupRoot !== undefined && expected.backupRoot !== backupRoot
    || expected.journalPath !== undefined && expected.journalPath !== journalPath
    || expected.planHash !== undefined && expected.planHash !== record.planHash
    || expected.recoveryId !== undefined && expected.recoveryId !== record.recoveryId
    || expected.lockOwnerNonce !== undefined && expected.lockOwnerNonce !== record.lockOwnerNonce
    || expected.claimantNonce !== undefined && expected.claimantNonce !== record.claimantNonce)) {
    throw new MigrationSafetyError('migration recovery claim does not match lock', 'ERR_MIGRATION_LOCK');
  }
  return { ...record, backupRoot, journalPath };
}

async function readCanonicalClaim(claimPath, expected = {}) {
  const backupRoot = expected.backupRoot ?? dirname(claimPath);
  let raw;
  try {
    raw = await safeRead(claimPath, { root: backupRoot, relativePath: relative(backupRoot, claimPath), encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new MigrationSafetyError('migration recovery claim is missing', 'ERR_MIGRATION_LOCK');
    throw new MigrationSafetyError('migration recovery claim is unreadable', 'ERR_MIGRATION_LOCK');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new MigrationSafetyError('migration recovery claim is malformed', 'ERR_MIGRATION_LOCK'); }
  const validated = validateClaimRecord(parsed, expected);
  if (raw !== `${canonicalJson(parsed)}\n`) throw new MigrationSafetyError('migration recovery claim is not canonical', 'ERR_MIGRATION_LOCK');
  return validated;
}

function journalBody(journal) {
  return {
    version: 1,
    kind: JOURNAL_KIND,
    owner: OWNER_MARKER,
    status: journal.status,
    home: journal.home,
    backupRoot: journal.backupRoot,
    journalPath: journal.journalPath,
    planHash: journal.planHash,
    recoveryId: journal.recoveryId,
    entries: journal.entries.map((entry) => ({
      path: entry.path,
      markerPath: entry.markerPath,
      existed: entry.existed,
      state: entry.state,
      backupPath: entry.backupPath,
      markerBackupPath: entry.markerBackupPath,
      preContentHash: entry.sha256,
      preMarkerHash: entry.markerSha256,
      appliedContentHash: entry.appliedContentHash,
      appliedMarkerHash: entry.appliedMarkerHash,
    })),
  };
}

function validateJournalRecord(record, { expected } = {}) {
  exactKeys(record, JOURNAL_KEYS, JOURNAL_KEYS, 'ERR_INVALID_JOURNAL');
  if (record.version !== 1 || record.kind !== JOURNAL_KIND || record.owner !== OWNER_MARKER || !JOURNAL_STATUSES.has(record.status)) throw new MigrationSafetyError('migration journal ownership or state is invalid', 'ERR_INVALID_JOURNAL');
  const home = resolveHome(record.home);
  const backupRootText = rejectUnsupportedAbsolute(record.backupRoot, 'ERR_INVALID_JOURNAL');
  if (!isPortableAbsolute(backupRootText) || DEVICE_PATH.test(backupRootText) || UNC_PATH.test(backupRootText)) throw new MigrationSafetyError('migration journal backup root is invalid', 'ERR_INVALID_JOURNAL');
  const backupRoot = resolve(backupRootText);
  if (dirname(backupRoot) === backupRoot) throw new MigrationSafetyError('migration journal backup root is too broad', 'ERR_INVALID_JOURNAL');
  if (home !== resolve(record.home) || backupRoot !== resolve(backupRootText)) throw new MigrationSafetyError('migration journal paths are not canonical', 'ERR_INVALID_JOURNAL');
  assertHash(record.planHash, 'ERR_INVALID_JOURNAL');
  if (typeof record.recoveryId !== 'string' || record.recoveryId !== recoveryIdFor(record.planHash)) throw new MigrationSafetyError('migration journal recovery id is invalid', 'ERR_INVALID_JOURNAL');
  const journalPath = validateBackupPath(home, backupRoot, record.journalPath, 'ERR_INVALID_JOURNAL');
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > MAX_WRITES) throw new MigrationSafetyError('migration journal entries exceed the hard bound', 'ERR_INVALID_JOURNAL');
  const paths = new Set();
  for (const entry of record.entries) {
    exactKeys(entry, JOURNAL_ENTRY_KEYS, JOURNAL_ENTRY_KEYS, 'ERR_INVALID_JOURNAL');
    const pathValue = normalizeRelative(entry.path, 'journal path');
    const marker = normalizeRelative(entry.markerPath, 'journal marker path');
    if (pathValue !== entry.path || marker !== entry.markerPath || marker !== markerPath(pathValue) || paths.has(pathValue)) throw new MigrationSafetyError('migration journal targets are not canonical', 'ERR_INVALID_JOURNAL');
    if (typeof entry.existed !== 'boolean' || !JOURNAL_STATES.has(entry.state)) throw new MigrationSafetyError('migration journal entry state is invalid', 'ERR_INVALID_JOURNAL');
    for (const value of [entry.preContentHash, entry.preMarkerHash, entry.appliedContentHash, entry.appliedMarkerHash]) {
      if (value !== null) assertHash(value, 'ERR_INVALID_JOURNAL');
    }
    for (const value of [entry.backupPath, entry.markerBackupPath]) {
      if (value !== null) validateBackupPath(home, backupRoot, value, 'ERR_INVALID_JOURNAL');
    }
    if (entry.existed && entry.preContentHash === null) throw new MigrationSafetyError('migration journal existing target is missing pre-state hashes', 'ERR_INVALID_JOURNAL');
    paths.add(pathValue);
  }
  const sorted = record.entries.slice().sort((left, right) => left.path.localeCompare(right.path));
  if (sorted.some((entry, index) => entry.path !== record.entries[index].path)) throw new MigrationSafetyError('migration journal entries are not sorted', 'ERR_INVALID_JOURNAL');
  if (expected) {
    if ((expected.home !== undefined && expected.home !== home) || (expected.backupRoot !== undefined && expected.backupRoot !== backupRoot) || (expected.journalPath !== undefined && expected.journalPath !== journalPath) || (expected.planHash !== undefined && expected.planHash !== record.planHash) || (expected.recoveryId !== undefined && expected.recoveryId !== record.recoveryId)) throw new MigrationSafetyError('migration journal collision', 'ERR_JOURNAL_COLLISION');
    if (expected.entries && (expected.entries.length !== record.entries.length || expected.entries.some((entry, index) => entry.path !== record.entries[index].path || entry.markerPath !== record.entries[index].markerPath || entry.existed !== record.entries[index].existed || entry.appliedContentHash !== record.entries[index].appliedContentHash || entry.appliedMarkerHash !== record.entries[index].appliedMarkerHash))) throw new MigrationSafetyError('migration journal collision', 'ERR_JOURNAL_COLLISION');
  }
  return { ...record, home, backupRoot, journalPath };
}

async function readCanonicalJournal(journalPath, expected) {
  let raw;
  try {
    raw = await safeRead(journalPath, { root: expected.backupRoot, relativePath: relative(expected.backupRoot, journalPath), encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new MigrationSafetyError('migration journal is missing', 'ERR_JOURNAL_MISSING');
    throw new MigrationSafetyError('migration journal is unreadable', 'ERR_INVALID_JOURNAL');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new MigrationSafetyError('migration journal is malformed', 'ERR_INVALID_JOURNAL'); }
  const validated = validateJournalRecord(parsed, { expected });
  if (raw !== `${canonicalJson(parsed)}\n`) throw new MigrationSafetyError('migration journal is not canonical', 'ERR_INVALID_JOURNAL');
  return validated;
}

function assertJournalCompatible(existing, current) {
  if (existing.home !== current.home || existing.backupRoot !== current.backupRoot || existing.journalPath !== current.journalPath || existing.planHash !== current.planHash || existing.recoveryId !== current.recoveryId || existing.entries.length !== current.entries.length) throw new MigrationSafetyError('migration journal collision', 'ERR_JOURNAL_COLLISION');
  for (let index = 0; index < current.entries.length; index += 1) {
    const left = existing.entries[index];
    const right = current.entries[index];
    if (left.path !== right.path || left.markerPath !== right.markerPath || left.existed !== right.existed || left.appliedContentHash !== right.appliedContentHash || left.appliedMarkerHash !== right.appliedMarkerHash) throw new MigrationSafetyError('migration journal collision', 'ERR_JOURNAL_COLLISION');
  }
}

function publicRecoveryJournal(journal, original, rollbackError, recoveryId) {
  return {
    version: 1,
    recoveryId,
    status: 'recovery-required',
    journalPath: journal.journalPath,
    backupRoot: journal.backupRoot,
    code: original?.code ?? 'ERR_WRITE_FAILED',
    rollbackCode: rollbackError?.code ?? 'ERR_RECOVERY_REQUIRED',
    entries: journal.entries.map((entry) => ({ path: entry.path, markerPath: entry.markerPath, existed: entry.existed, backupPath: entry.backupPath, markerBackupPath: entry.markerBackupPath, preContentHash: entry.sha256, preMarkerHash: entry.markerSha256, appliedContentHash: entry.appliedContentHash, appliedMarkerHash: entry.appliedMarkerHash, state: entry.state })),
  };
}

async function persistRecovery(backupRoot, journal, original, rollbackError, hooks) {
  const recoveryId = journal.recoveryId;
  const record = publicRecoveryJournal(journal, original, rollbackError, recoveryId);
  const text = canonicalJson(record);
  const pathValue = join(backupRoot, `recovery-${recoveryId}.json`);
  await callHook(hooks, 'persistRecovery', record);
  const relativePath = relative(backupRoot, pathValue);
  if (await pathExists(pathValue)) {
    const existing = await safeRead(pathValue, { root: backupRoot, relativePath, encoding: 'utf8' });
    if (existing !== `${text}\n`) throw new MigrationSafetyError('recovery record collision', 'ERR_RECOVERY_COLLISION');
    return recoveryId;
  }
  await atomicWrite(pathValue, `${text}\n`, { root: backupRoot, relativePath, hooks });
  return recoveryId;
}

async function callHook(hooks, name, ...args) {
  if (typeof hooks?.[name] === 'function') await hooks[name](...args);
}

async function acquireMigrationLock(backupRoot, metadata = {}) {
  await rejectReparseAbsolute(backupRoot);
  await mkdir(backupRoot, { recursive: true });
  await rejectReparseAbsolute(backupRoot, { allowMissing: false });
  const lockPath = join(backupRoot, '.migration.lock');
  const planHashValue = metadata.planHash;
  const journalPath = metadata.journalPath ?? join(backupRoot, `migration-${planHashValue}.journal.json`);
  assertHash(planHashValue, 'ERR_MIGRATION_LOCK');
  const lock = {
    version: LOCK_VERSION,
    kind: LOCK_KIND,
    owner: OWNER_MARKER,
    state: 'active',
    backupRoot: resolve(backupRoot),
    journalPath: resolve(journalPath),
    planHash: planHashValue,
    recoveryId: recoveryIdFor(planHashValue),
    ownerNonce: randomUUID(),
  };
  validateLockRecord(lock);
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(lockBody(lock))}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rejectReparseAbsolute(lockPath, { allowMissing: false });
    return lockPath;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'EEXIST') throw new MigrationSafetyError('another migration is active', 'ERR_MIGRATION_LOCK');
    throw error;
  }
}

async function persistLockState(lockPath, state, expected = {}) {
  const current = await readCanonicalLock(lockPath, expected);
  const next = { ...current, state };
  validateLockRecord(next, { ...expected, ownerNonce: current.ownerNonce });
  await atomicProtocolWrite(lockPath, `${canonicalJson(lockBody(next))}\n`, current.backupRoot);
  return next;
}

async function createRecoveryClaim(lockPath, expected) {
  const lock = await readCanonicalLock(lockPath, expected);
  if (lock.state !== 'recoverable') throw new MigrationSafetyError('migration lock is not recoverable', 'ERR_MIGRATION_LOCK');
  const claimPath = join(lock.backupRoot, '.migration.claim');
  const claim = {
    version: LOCK_VERSION,
    kind: CLAIM_KIND,
    owner: OWNER_MARKER,
    backupRoot: lock.backupRoot,
    journalPath: lock.journalPath,
    planHash: lock.planHash,
    recoveryId: lock.recoveryId,
    lockOwnerNonce: lock.ownerNonce,
    claimantNonce: randomUUID(),
  };
  validateClaimRecord(claim);
  let handle;
  try {
    handle = await open(claimPath, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(claimBody(claim))}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rejectReparseAbsolute(claimPath, { allowMissing: false });
    return { lock, claimPath, claim };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'EEXIST') throw new MigrationSafetyError('another recovery claimant is active', 'ERR_MIGRATION_LOCK');
    throw error;
  }
}

async function releaseRecoveryClaim(claimPath, expected = {}) {
  if (!claimPath) return;
  const claim = await readCanonicalClaim(claimPath, expected);
  await rejectReparseAbsolute(claimPath, { allowMissing: false });
  await rm(claimPath, { force: true });
  return claim;
}

async function releaseMigrationLock(lockPath, expected = {}) {
  if (!lockPath) return;
  let lock;
  try {
    lock = await readCanonicalLock(lockPath, expected);
  } catch (error) {
    if (error?.code === 'ERR_MIGRATION_LOCK' && !(await pathExists(lockPath))) return;
    throw error;
  }
  await rejectReparseAbsolute(lockPath, { allowMissing: false });
  await rm(lockPath, { force: true });
  return lock;
}

async function persistJournal(journal, { createOnly = false, hooks } = {}) {
  const body = journalBody(journal);
  validateJournalRecord(body);
  await callHook(hooks, 'persistJournal', body);
  const exists = await pathExists(journal.journalPath);
  if (exists) {
    if (createOnly) throw new MigrationSafetyError('migration journal collision', 'ERR_JOURNAL_COLLISION');
    let existing;
    try {
      existing = await readCanonicalJournal(journal.journalPath, body);
    } catch (error) {
      if (error instanceof MigrationSafetyError && (error.code === 'ERR_INVALID_JOURNAL' || error.code === 'ERR_JOURNAL_MISSING')) {
        throw new MigrationSafetyError('migration journal collision', 'ERR_JOURNAL_COLLISION');
      }
      throw error;
    }
    assertJournalCompatible(existing, body);
  } else if (!createOnly) {
    throw new MigrationSafetyError('migration journal is missing', 'ERR_JOURNAL_MISSING');
  }
  const relativePath = relative(journal.backupRoot, journal.journalPath);
  await atomicWrite(journal.journalPath, `${canonicalJson(body)}\n`, { replace: !createOnly, root: journal.backupRoot, relativePath, hooks });
}

function receiptBody(receipt) {
  const body = { ...receipt };
  delete body.receiptHash;
  return body;
}

function receiptHash(receipt) {
  return sha256(canonicalJson(receiptBody(receipt)));
}

function validateBackupPath(root, backupRoot, file, code = 'ERR_INVALID_ROLLBACK') {
  if (typeof file !== 'string' || !isPortableAbsolute(file) || DEVICE_PATH.test(file) || UNC_PATH.test(file)) throw new MigrationSafetyError('backup path is invalid', code);
  const absolute = resolve(file);
  ensureInside(backupRoot, absolute);
  const normalized = normalizeRelative(relative(backupRoot, absolute), 'backup path');
  if (normalized !== relative(backupRoot, absolute).replaceAll('\\', '/')) throw new MigrationSafetyError('backup path is not canonical', code);
  return absolute;
}

function validateReceipt(receipt) {
  exactKeys(receipt, RECEIPT_KEYS, RECEIPT_KEYS, 'ERR_INVALID_ROLLBACK');
  if (receipt.kind !== MIGRATION_KIND || receipt.receiptVersion !== RECEIPT_VERSION) throw new MigrationSafetyError('rollback receipt version is invalid', 'ERR_INVALID_ROLLBACK');
  if (receipt.preview !== false || receipt.confirmed !== true) throw new MigrationSafetyError('rollback receipt confirmation is invalid', 'ERR_INVALID_ROLLBACK');
  const home = resolveHome(receipt.home);
  const backupRootText = rejectUnsupportedAbsolute(receipt.backupRoot, 'ERR_INVALID_ROLLBACK');
  if (!isPortableAbsolute(backupRootText) || DEVICE_PATH.test(backupRootText) || UNC_PATH.test(backupRootText)) throw new MigrationSafetyError('rollback backup root is invalid', 'ERR_INVALID_ROLLBACK');
  const backupRoot = resolve(backupRootText);
  if (dirname(backupRoot) === backupRoot) throw new MigrationSafetyError('rollback backup root is too broad', 'ERR_INVALID_ROLLBACK');
  assertHash(receipt.planHash, 'ERR_INVALID_ROLLBACK');
  if (typeof receipt.journalPath !== 'string') throw new MigrationSafetyError('rollback journal path is invalid', 'ERR_INVALID_ROLLBACK');
  const journalAbsolute = resolve(rejectUnsupportedAbsolute(receipt.journalPath, 'ERR_INVALID_ROLLBACK'));
  if (dirname(journalAbsolute) !== backupRoot) throw new MigrationSafetyError('rollback receipt root is not bound to its journal', 'ERR_RECEIPT_INTEGRITY');
  const journalPath = validateBackupPath(home, backupRoot, receipt.journalPath, 'ERR_INVALID_ROLLBACK');
  if (!Array.isArray(receipt.written) || receipt.written.length === 0 || receipt.written.length > MAX_WRITES || new Set(receipt.written).size !== receipt.written.length) throw new MigrationSafetyError('rollback written paths are invalid', 'ERR_INVALID_ROLLBACK');
  if (receipt.written.some((value, index, values) => normalizeRelative(value, 'rollback path') !== value || (index > 0 && values[index - 1].localeCompare(value) >= 0))) throw new MigrationSafetyError('rollback written paths are not canonical', 'ERR_INVALID_ROLLBACK');
  if (!Array.isArray(receipt.backups) || receipt.backups.length === 0 || receipt.backups.length > MAX_WRITES || receipt.backups.length !== receipt.written.length) throw new MigrationSafetyError('rollback entries are incomplete', 'ERR_INVALID_ROLLBACK');
  for (const pathValue of receipt.written) {
    const normalized = normalizeRelative(pathValue, 'rollback path');
    ensureInside(home, resolve(home, normalized));
  }
  for (const entry of receipt.backups) {
    exactKeys(entry, BACKUP_KEYS, BACKUP_KEYS, 'ERR_INVALID_ROLLBACK');
    const pathValue = normalizeRelative(entry.path, 'rollback path');
    const ownerPath = normalizeRelative(entry.markerPath, 'rollback marker path');
    if (ownerPath !== markerPath(pathValue)) throw new MigrationSafetyError('rollback marker path is unbound', 'ERR_INVALID_ROLLBACK');
    ensureInside(home, resolve(home, pathValue));
    ensureInside(home, resolve(home, ownerPath));
    if (typeof entry.existed !== 'boolean') throw new MigrationSafetyError('rollback entry state is invalid', 'ERR_INVALID_ROLLBACK');
    for (const value of [entry.appliedContentHash, entry.appliedMarkerHash]) assertHash(value, 'ERR_INVALID_ROLLBACK');
    if (entry.existed) {
      assertHash(entry.sha256, 'ERR_INVALID_ROLLBACK');
      assertHash(entry.markerSha256, 'ERR_INVALID_ROLLBACK');
      validateBackupPath(home, backupRoot, entry.backupPath);
      validateBackupPath(home, backupRoot, entry.markerBackupPath);
    } else if (entry.backupPath !== null || entry.markerBackupPath !== null || entry.sha256 !== null || entry.markerSha256 !== null) {
      throw new MigrationSafetyError('created rollback entries must not contain backups', 'ERR_INVALID_ROLLBACK');
    }
  }
  if (receipt.backups.some((entry, index) => entry.path !== receipt.written[index])) throw new MigrationSafetyError('rollback entries are not bound to written paths', 'ERR_INVALID_ROLLBACK');
  if (receiptHash(receipt) !== receipt.receiptHash) throw new MigrationSafetyError('rollback receipt hash is invalid', 'ERR_INVALID_ROLLBACK');
  return { home, backupRoot, journalPath, receipt };
}

async function currentHash(root, relativePath, encoding) {
  try {
    if (!(await pathExists(resolve(root, relativePath)))) return null;
    const value = await safeRead(resolve(root, relativePath), { root, relativePath, encoding });
    return hash(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function journalFromReceipt(validated, entries, status) {
  const updates = new Map(entries.map((entry) => [entry.path, entry]));
  const sourceEntries = validated.journal?.entries ?? entries;
  return {
    home: validated.home,
    backupRoot: validated.backupRoot,
    planHash: validated.receipt.planHash,
    journalPath: validated.journalPath,
    recoveryId: recoveryIdFor(validated.receipt.planHash),
    status,
    entries: sourceEntries.map((source) => {
      const entry = updates.get(source.path) ?? source;
      return {
      path: entry.path,
      markerPath: entry.markerPath,
      existed: entry.existed,
      backupPath: entry.backupPath,
      markerBackupPath: entry.markerBackupPath,
      sha256: entry.sha256 ?? entry.preContentHash ?? null,
      markerSha256: entry.markerSha256 ?? entry.preMarkerHash ?? null,
      appliedContentHash: entry.appliedContentHash,
      appliedMarkerHash: entry.appliedMarkerHash,
      state: entry.state,
      };
    }),
  };
}

async function persistRestoreProgress(validated, entries, status, hooks) {
  await persistJournal(journalFromReceipt(validated, entries, status), { hooks });
}

async function safeRemove(root, relativePath, expectedHash, encoding) {
  const absolute = resolve(root, relativePath);
  if (!(await pathExists(absolute))) return;
  await revalidateBoundary(root, relativePath, { allowMissing: false });
  const bytes = await safeRead(absolute, { root, relativePath, encoding });
  if (hash(bytes) !== expectedHash) throw new MigrationSafetyError('current migration bytes drifted', 'ERR_ROLLBACK_DRIFT');
  await rm(absolute, { force: false });
  if (await pathExists(absolute)) throw new MigrationSafetyError('migration removal did not complete', 'ERR_RECOVERY_REQUIRED');
}

async function restoreReceipt(validated, { hooks, lockHeld = false } = {}) {
  const journal = await readCanonicalJournal(validated.journalPath, {
    home: validated.home,
    backupRoot: validated.backupRoot,
    journalPath: validated.journalPath,
    planHash: validated.receipt.planHash,
    recoveryId: recoveryIdFor(validated.receipt.planHash),
  });
  validated.journal = journal;
  const expectedReceipt = buildReceiptFromJournal(journal);
  if (canonicalJson(validated.receipt) !== canonicalJson(expectedReceipt)) {
    throw new MigrationSafetyError('rollback receipt is not an exact view of the durable journal', 'ERR_RECEIPT_INTEGRITY');
  }
  for (const receiptEntry of validated.receipt.backups) {
    const journalEntry = journal.entries.find((entry) => entry.path === receiptEntry.path && entry.markerPath === receiptEntry.markerPath);
    if (!journalEntry || journalEntry.existed !== receiptEntry.existed || journalEntry.appliedContentHash !== receiptEntry.appliedContentHash || journalEntry.appliedMarkerHash !== receiptEntry.appliedMarkerHash) throw new MigrationSafetyError('rollback receipt is not bound to the durable journal', 'ERR_INVALID_ROLLBACK');
  }
  let hookError;
  try {
    await callHook(hooks, 'rollback', validated.receipt);
  } catch (error) {
    hookError = error;
  }
  const progress = validated.receipt.backups.map((entry) => ({ ...entry, state: 'pending' }));
  await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
  for (const entry of [...progress].reverse()) {
    const target = resolve(validated.home, entry.path);
    const marker = resolve(validated.home, entry.markerPath);
    const targetHash = await currentHash(validated.home, entry.path);
    const markerHash = await currentHash(validated.home, entry.markerPath, 'utf8');
    const targetNeedsRestore = entry.existed
      ? targetHash === entry.appliedContentHash
      : targetHash === entry.appliedContentHash;
    const targetAlreadyRestored = entry.existed ? targetHash === entry.sha256 : targetHash === null;
    const markerNeedsRestore = markerHash === entry.appliedMarkerHash;
    const markerAlreadyRestored = entry.existed ? markerHash === entry.markerSha256 : markerHash === null;
    if (!targetNeedsRestore && !targetAlreadyRestored) throw new MigrationSafetyError('current target bytes drifted', 'ERR_ROLLBACK_DRIFT');
    if (!markerNeedsRestore && !markerAlreadyRestored) throw new MigrationSafetyError('current ownership marker drifted', 'ERR_ROLLBACK_DRIFT');
    if (entry.existed) {
      const backupPath = validateBackupPath(validated.home, validated.backupRoot, entry.backupPath);
      const markerBackupPath = validateBackupPath(validated.home, validated.backupRoot, entry.markerBackupPath);
      await rejectReparseAbsolute(backupPath, { allowMissing: false });
      await rejectReparseAbsolute(markerBackupPath, { allowMissing: false });
      const bytes = await safeRead(backupPath);
      const markerBytes = await safeRead(markerBackupPath);
      if (hash(bytes) !== entry.sha256 || hash(markerBytes) !== entry.markerSha256) throw new MigrationSafetyError('backup byte verification failed', 'ERR_BACKUP_VERIFY');
      if (targetNeedsRestore) {
        entry.state = 'target-restoring';
        await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
        try {
          await callHook(hooks, 'restoreTarget', entry);
        } catch {
          throw new MigrationSafetyError('target restore failed', 'ERR_RECOVERY_REQUIRED');
        }
        await atomicWrite(target, bytes, { replace: true, root: validated.home, relativePath: entry.path, hooks });
        entry.state = 'target-restored';
        await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
      }
      if (markerNeedsRestore) {
        entry.state = 'marker-restoring';
        await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
        try {
          await callHook(hooks, 'restoreMarker', entry);
        } catch {
          throw new MigrationSafetyError('marker restore failed', 'ERR_RECOVERY_REQUIRED');
        }
        await atomicWrite(marker, markerBytes, { replace: true, root: validated.home, relativePath: entry.markerPath, hooks });
        entry.state = 'marker-restored';
        await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
      }
    } else {
      if (targetNeedsRestore) {
        entry.state = 'target-restoring';
        await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
        try {
          await callHook(hooks, 'restoreTarget', entry);
        } catch {
          throw new MigrationSafetyError('target restore failed', 'ERR_RECOVERY_REQUIRED');
        }
        await safeRemove(validated.home, entry.path, entry.appliedContentHash);
        entry.state = 'target-restored';
        await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
      }
      if (markerNeedsRestore) {
        entry.state = 'marker-restoring';
        await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
        try {
          await callHook(hooks, 'restoreMarker', entry);
        } catch {
          throw new MigrationSafetyError('marker restore failed', 'ERR_RECOVERY_REQUIRED');
        }
        await safeRemove(validated.home, entry.markerPath, entry.appliedMarkerHash, 'utf8');
        entry.state = 'marker-restored';
        await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
      }
    }
    entry.state = 'restored';
    await persistRestoreProgress(validated, progress, 'rolling-back', hooks);
  }
  await persistRestoreProgress(validated, progress, 'restored', hooks);
  if (hookError) throw new MigrationSafetyError('rollback hook failed', 'ERR_RECOVERY_REQUIRED');
  return Object.freeze({ ok: true, restored: validated.receipt.written });
}

/** Build a deterministic read-only migration plan. */
export async function planLocalMigration({ home, clients, artifact } = {}) {
  const root = resolveHome(home);
  await rejectReparseAbsolute(root, { allowMissing: false });
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new MigrationSafetyError('home must be a regular directory', 'ERR_INVALID_HOME');
  const specs = clientSpecs(clients);
  const normalizedArtifact = await normalizeArtifact(artifact);
  const writes = [];
  const seen = new Set();
  for (const client of specs) {
    for (const file of normalizedArtifact.files) {
      if (!appliesToClient(file, client)) continue;
      const target = targetPath(client, file.path);
      if (seen.has(target)) throw new MigrationSafetyError('migration targets collide', 'ERR_PLAN_COLLISION');
      seen.add(target);
      writes.push(await inspectTarget(root, target, file.content, normalizedArtifact.manifest.manifestHash));
    }
  }
  if (writes.length === 0) throw new MigrationSafetyError('migration artifact produced no targets', 'ERR_EMPTY_PLAN');
  writes.sort((left, right) => left.path.localeCompare(right.path));
  const body = {
    version: MIGRATION_VERSION,
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    home: root,
    // Keep the validated root with the client identity.  A plan must be
    // self-contained; apply must never regenerate a default `.codex`/`.claude`
    // root from a bare client name.
    clients: specs.map((client) => ({ name: client.name, root: client.root })),
    artifact: {
      manifestHash: normalizedArtifact.manifest.manifestHash,
      files: normalizedArtifact.files.map((file) => ({
        path: normalizeRelative(file.path, 'artifact path'),
        clients: file.clients === null ? null : [...file.clients],
        contentHash: hash(file.content),
      })).sort((left, right) => left.path.localeCompare(right.path) || (left.clients ?? []).join(',').localeCompare((right.clients ?? []).join(','))),
    },
    writes,
    preview: true,
    rollback: { strategy: 'byte-identical-backups', owner: OWNER_MARKER },
  };
  return deepFreeze({ ...body, planHash: planHash(body) });
}

/** Apply a plan only with confirm:true; otherwise return a read-only preview. */
export async function applyLocalMigration(plan, options = {}) {
  if (!object(options)) throw new MigrationSafetyError('migration options are invalid', 'ERR_INVALID_OPTIONS');
  const validatedPlan = validatePlan(plan);
  const { home } = validatedPlan;
  await rejectReparseAbsolute(home, { allowMissing: false });
  if (options.confirm !== true) return Object.freeze({ ok: true, preview: true, confirmed: false, planned: plan.writes.map((write) => write.path), writes: plan.writes.length });
  const backupRootText = options.backupRoot ?? join(home, '.worktree-proof', 'backups');
  rejectUnsupportedAbsolute(backupRootText, 'ERR_INVALID_BACKUP_ROOT');
  if (!isPortableAbsolute(backupRootText) || DEVICE_PATH.test(backupRootText) || UNC_PATH.test(backupRootText)) throw new MigrationSafetyError('backup root must be an explicit local absolute path', 'ERR_INVALID_BACKUP_ROOT');
  const backupRoot = resolve(backupRootText);
  if (dirname(backupRoot) === backupRoot) throw new MigrationSafetyError('backup root is too broad', 'ERR_INVALID_BACKUP_ROOT');
  await rejectReparseAbsolute(backupRoot);
  const hooks = object(options.hooks) ? options.hooks : {};
  const journalPath = join(backupRoot, `migration-${plan.planHash}.journal.json`);
  const lockPath = await acquireMigrationLock(backupRoot, { planHash: plan.planHash, journalPath });
  const journal = {
    home,
    backupRoot,
    planHash: plan.planHash,
    journalPath,
    recoveryId: recoveryIdFor(plan.planHash),
    status: 'applying',
    entries: plan.writes.map((write) => ({
      path: write.path,
      markerPath: write.markerPath,
      existed: write.existing,
      backupPath: null,
      markerBackupPath: null,
      sha256: write.existingHash,
      markerSha256: null,
      appliedContentHash: write.contentHash,
      appliedMarkerHash: write.markerHash,
      state: 'planned',
    })),
  };
  let keepLock = false;
  let journalDurable = false;
  let targetMutated = false;
  try {
    await persistJournal(journal, { createOnly: true, hooks });
    journalDurable = true;
    for (let index = 0; index < plan.writes.length; index += 1) {
      const write = plan.writes[index];
      const journalEntry = journal.entries[index];
      const target = resolve(home, write.path);
      const marker = resolve(home, write.markerPath);
      ensureInside(home, target);
      ensureInside(home, marker);
      await rejectReparseComponents(home, write.path);
      await rejectReparseComponents(home, write.markerPath);
      const exists = await pathExists(target);
      if (exists !== write.existing) throw new MigrationSafetyError('target changed since planning', 'ERR_PLAN_CHANGED');
      if (exists) {
        const oldBytes = await safeRead(target, { root: home, relativePath: write.path });
        const oldHash = hash(oldBytes);
        if (oldHash !== write.existingHash) throw new MigrationSafetyError('target bytes changed since planning', 'ERR_PLAN_CHANGED');
        const oldMarker = await safeRead(marker, { root: home, relativePath: write.markerPath, encoding: 'utf8' });
        parseMarker(oldMarker, { path: write.path, contentHash: oldHash });
        journalEntry.sha256 = oldHash;
        journalEntry.markerSha256 = hash(oldMarker);
        journalEntry.backupPath = await backupBytes(backupRoot, index, oldBytes, hooks);
        journalEntry.markerBackupPath = await backupBytes(backupRoot, index + plan.writes.length, Buffer.from(oldMarker, 'utf8'), hooks);
      }
      journalEntry.state = 'backed-up';
      await persistJournal(journal, { hooks });
      await callHook(hooks, 'write', write.path, write);
      targetMutated = true;
      await atomicWrite(target, Buffer.from(write.content, 'utf8'), { replace: exists, root: home, relativePath: write.path, hooks });
      journalEntry.state = 'target-written';
      await persistJournal(journal, { hooks });
      await callHook(hooks, 'marker', write.path, write);
      targetMutated = true;
      await atomicWrite(marker, Buffer.from(write.markerContent, 'utf8'), { replace: exists, root: home, relativePath: write.markerPath, hooks });
      journalEntry.state = 'applied';
      await persistJournal(journal, { hooks });
    }
    journal.status = 'applied';
    await persistJournal(journal, { hooks });
  } catch (error) {
    if (!journalDurable) {
      if (error instanceof MigrationSafetyError && error.code === 'ERR_JOURNAL_COLLISION') throw error;
      throw new MigrationSafetyError('migration journal could not be durably persisted', 'ERR_JOURNAL_DURABILITY');
    }
    let rollbackError;
    try {
      const temporary = buildReceiptFromJournal(journal);
      if (targetMutated && temporary.backups.length > 0) await restoreReceipt(validateReceipt(temporary), { hooks, lockHeld: true });
      // Preserve the existing rollback hook contract even when a write hook
      // fails before the first target mutation.  A failed rollback hook still
      // produces a durable, resumable recovery id.
      await callHook(hooks, 'rollback', temporary);
      journal.status = 'rolled-back';
      await persistJournal(journal, { hooks });
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError) {
      keepLock = true;
      await persistLockState(lockPath, 'recoverable', {
        backupRoot,
        journalPath: journal.journalPath,
        planHash: journal.planHash,
        recoveryId: journal.recoveryId,
      });
      let recovery;
      try {
        recovery = await persistRecovery(backupRoot, journal, error, rollbackError, hooks);
      } catch {
        // The deterministic recovery id is already persisted in the journal
        // that was fsynced before the first target mutation.  Never return an
        // identifier whose durable record was not written.
        recovery = journal.recoveryId;
      }
      const recoveryError = new MigrationSafetyError('migration recovery is required', 'ERR_RECOVERY_REQUIRED', recovery);
      recoveryError.journalPath = journal.journalPath;
      throw recoveryError;
    }
    if (!targetMutated) {
      if (error instanceof MigrationSafetyError) throw error;
      throw new MigrationSafetyError('migration write failed before target mutation', 'ERR_WRITE_FAILED');
    }
    if (error instanceof MigrationSafetyError) throw error;
    throw new MigrationSafetyError('migration write failed', 'ERR_WRITE_FAILED');
  } finally {
    if (!keepLock) await releaseMigrationLock(lockPath);
  }
  return deepFreeze(buildReceiptFromJournal(journal));
}

function buildReceiptFromJournal(journal) {
  const body = {
    kind: MIGRATION_KIND,
    receiptVersion: RECEIPT_VERSION,
    preview: false,
    confirmed: true,
    home: journal.home,
    backupRoot: journal.backupRoot,
    journalPath: journal.journalPath,
    planHash: journal.planHash,
    backups: journal.entries.filter((entry) => entry.state !== 'planned').map((entry) => ({
      path: entry.path,
      markerPath: entry.markerPath,
      existed: entry.existed,
      backupPath: entry.backupPath,
      markerBackupPath: entry.markerBackupPath,
      sha256: entry.sha256 ?? entry.preContentHash ?? null,
      markerSha256: entry.markerSha256 ?? entry.preMarkerHash ?? null,
      appliedContentHash: entry.appliedContentHash,
      appliedMarkerHash: entry.appliedMarkerHash,
    })),
    written: journal.entries.filter((entry) => entry.state !== 'planned').map((entry) => entry.path),
  };
  return { ...body, receiptHash: receiptHash(body) };
}

/** Restore one validated apply receipt; forged receipts are rejected before I/O. */
export async function rollbackLocalMigration(receipt, options = {}) {
  const validated = validateReceipt(receipt);
  await rejectReparseAbsolute(validated.home, { allowMissing: false });
  await rejectReparseAbsolute(validated.backupRoot);
  const lockPath = join(validated.backupRoot, '.migration.lock');
  const lockExpected = {
    backupRoot: validated.backupRoot,
    journalPath: validated.journalPath,
    planHash: validated.receipt.planHash,
    recoveryId: recoveryIdFor(validated.receipt.planHash),
  };
  let lock;
  let claimPath;
  let lockOwnerNonce;
  try {
    lock = await acquireMigrationLock(validated.backupRoot, lockExpected);
    const active = await readCanonicalLock(lock, lockExpected);
    lockOwnerNonce = active.ownerNonce;
  } catch (error) {
    if (error?.code !== 'ERR_MIGRATION_LOCK') throw error;
    const adopted = await createRecoveryClaim(lockPath, lockExpected);
    lock = lockPath;
    claimPath = adopted.claimPath;
    lockOwnerNonce = adopted.lock.ownerNonce;
  }
  try {
    const result = await restoreReceipt(validated, { hooks: object(options.hooks) ? options.hooks : {}, lockHeld: true });
    if (claimPath) await releaseRecoveryClaim(claimPath, { ...lockExpected, lockOwnerNonce });
    await releaseMigrationLock(lock, { ...lockExpected, ownerNonce: lockOwnerNonce });
    if (options.cleanupRecovery === true) await cleanupRecoveryArtifacts(validated, options.recoveryId ?? recoveryIdFor(validated.receipt.planHash));
    return result;
  } catch (error) {
    // Keep a canonical durable lock in recoverable state.  The next process
    // must claim that exact lock/journal pair before resuming; no process-local
    // map is treated as authority.
    try {
      await persistLockState(lock, 'recoverable', { ...lockExpected, ownerNonce: lockOwnerNonce });
    } catch {
      // Preserve the original recovery error.  A malformed/missing lock remains
      // fail-closed and cannot be silently replaced by a new claimant.
    }
    if (error instanceof MigrationSafetyError && !error.recoveryReceipt) error.recoveryReceipt = recoveryIdFor(validated.receipt.planHash);
    throw error;
  }
}

async function cleanupRecoveryArtifacts(validated, recoveryId) {
  const journal = await readCanonicalJournal(validated.journalPath, {
    home: validated.home,
    backupRoot: validated.backupRoot,
    journalPath: validated.journalPath,
    planHash: validated.receipt.planHash,
    recoveryId,
  });
  if (!['restored', 'rolled-back'].includes(journal.status)) throw new MigrationSafetyError('recovery journal is not terminal', 'ERR_RECOVERY_REQUIRED');
  const journalBytes = await safeRead(validated.journalPath, { root: validated.backupRoot, relativePath: relative(validated.backupRoot, validated.journalPath) });
  if (canonicalJson(JSON.parse(journalBytes.toString('utf8'))) !== canonicalJson(journal)) throw new MigrationSafetyError('recovery journal changed before cleanup', 'ERR_RECEIPT_INTEGRITY');
  await rm(validated.journalPath, { force: false });
  const recoveryPath = join(validated.backupRoot, `recovery-${recoveryId}.json`);
  if (await pathExists(recoveryPath)) {
    const recoveryBytes = await safeRead(recoveryPath, { root: validated.backupRoot, relativePath: relative(validated.backupRoot, recoveryPath), encoding: 'utf8' });
    let record;
    try { record = JSON.parse(recoveryBytes); } catch { throw new MigrationSafetyError('recovery record is malformed', 'ERR_RECEIPT_INTEGRITY'); }
    if (record.recoveryId !== recoveryId || recoveryBytes !== `${canonicalJson(record)}\n`) throw new MigrationSafetyError('recovery record ownership changed before cleanup', 'ERR_RECEIPT_INTEGRITY');
    await rm(recoveryPath, { force: false });
  }
}

/**
 * Resume rollback from a deterministic recovery id or a validated receipt.
 * Recovery ids are intentionally scoped by an explicit backupRoot so a bare
 * identifier can never select an ambient or attacker-controlled directory.
 */
export async function resumeLocalMigration(recovery, options = {}) {
  let receipt = recovery;
  if (typeof recovery === 'string') {
    if (!/^recovery-[a-f0-9]{64}$/u.test(recovery)) throw new MigrationSafetyError('recovery id is invalid', 'ERR_INVALID_RECOVERY');
    const backupRootText = options.backupRoot;
    if (typeof backupRootText !== 'string') throw new MigrationSafetyError('recovery backup root is required', 'ERR_INVALID_RECOVERY');
    const backupRoot = resolve(rejectUnsupportedAbsolute(backupRootText, 'ERR_INVALID_RECOVERY'));
    if (!isPortableAbsolute(backupRootText) || DEVICE_PATH.test(backupRootText) || UNC_PATH.test(backupRootText)) throw new MigrationSafetyError('recovery backup root is invalid', 'ERR_INVALID_RECOVERY');
    const journalPath = join(backupRoot, `migration-${recovery.slice('recovery-'.length)}.journal.json`);
    const journal = await readCanonicalJournal(journalPath, { backupRoot, journalPath, planHash: recovery.slice('recovery-'.length), recoveryId: recovery });
    receipt = buildReceiptFromJournal(journal);
  }
  return rollbackLocalMigration(receipt, { ...options, cleanupRecovery: true, recoveryId: recovery });
}

export const recoverLocalMigration = resumeLocalMigration;

export function migrationPlanJson(plan) {
  validatePlan(plan);
  return canonicalJson(plan);
}
