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
const UNC_PATH = /^\\\\/u;
const DEVICE_PATH = /^\\\\[?.]\\/u;
const CLIENT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_INVALID = /[<>:"|?*]/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const SENSITIVE_PATH = /(?:^|[\\/._-])(?:\.env(?:\.|$)|env|secret|secrets|credential|credentials|password|passwd|token|tokens|cookie|cookies|auth|authorization|private[-_.]?key|api[-_.]?key)(?:$|[\\/._-])/iu;
const LOCK_PATH = /(?:^|[\\/._-])(?:lock|locks|package-lock|yarn-lock|pnpm-lock)(?:$|[\\/._-])/iu;
const DESTRUCTIVE_MODE = /^(?:delete|remove|destroy|truncate|overwrite)$/iu;
const HASH = /^[a-f0-9]{64}$/u;

const PLAN_KEYS = Object.freeze(['artifact', 'clients', 'home', 'planHash', 'preview', 'protocol', 'protocolVersion', 'rollback', 'version', 'writes']);
const PLAN_BODY_KEYS = Object.freeze(PLAN_KEYS.filter((key) => key !== 'planHash'));
const ARTIFACT_KEYS = Object.freeze(['files', 'manifestHash']);
const ARTIFACT_FILE_KEYS = Object.freeze(['contentHash', 'path']);
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
  const text = rejectUnsupportedAbsolute(home, 'ERR_HOME_REQUIRED');
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
  if (CONTROL.test(normalized) || normalized.startsWith('/') || normalized.startsWith('//') || DRIVE_ABSOLUTE.test(normalized) || DRIVE_RELATIVE.test(normalized) || DEVICE_PATH.test(normalized)) {
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
  if (!Array.isArray(values) || values.length === 0 || values.length > 20) throw new MigrationSafetyError('clients must contain one to twenty identifiers', 'ERR_INVALID_CLIENTS');
  const seen = new Set();
  const specs = values.map((entry) => {
    const spec = typeof entry === 'string' ? { name: entry } : entry;
    if (!object(spec)) throw new MigrationSafetyError('client specification is invalid', 'ERR_INVALID_CLIENT');
    const name = publicClientId(spec.name ?? spec.client ?? spec.id);
    if (seen.has(name)) throw new MigrationSafetyError('clients must be unique', 'ERR_DUPLICATE_CLIENT');
    seen.add(name);
    const root = spec.root ?? spec.rootPath ?? spec.directory ?? (name === 'codex' ? '.codex' : name === 'claude' ? '.claude' : `.${name}`);
    return Object.freeze({ name, root: normalizeRelative(root, 'client root') });
  });
  return specs.sort((left, right) => left.name.localeCompare(right.name));
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
      files.push({ path: entry.path, content: entry.content, clients: entry.clients ?? entry.targets ?? (entry.client ? [entry.client] : undefined) });
    }
  } else if (object(sourceFiles)) {
    for (const [pathValue, content] of Object.entries(sourceFiles)) {
      if (typeof content !== 'string') throw new MigrationSafetyError('artifact file content must be text', 'ERR_INVALID_ARTIFACT');
      files.push({ path: pathValue, content });
    }
  }
  if (files.length === 0) {
    const pathValue = typeof value.path === 'string' ? value.path : 'worktree-proof.manifest.json';
    const content = typeof value.content === 'string' ? value.content : `${JSON.stringify(manifest, null, 2)}\n`;
    files.push({ path: pathValue, content });
  }
  for (const file of files) if (containsSecretLikeValue(file.content)) throw new MigrationSafetyError('artifact contains secret-like content', 'ERR_SECRET_INPUT');
  return { manifest, files };
}

function appliesToClient(file, client) {
  if (file.clients === undefined) return true;
  const list = typeof file.clients === 'string' ? file.clients.split(',') : file.clients;
  if (!Array.isArray(list)) return false;
  return list.some((entry) => publicClientId(typeof entry === 'string' ? entry : entry?.name ?? entry?.client) === client.name);
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
  const targets = new Set();
  for (const client of plan.clients) {
    const root = client === 'codex' ? '.codex' : client === 'claude' ? '.claude' : `.${client}`;
    for (const file of plan.artifact.files) targets.add(targetPath({ root }, file.path));
  }
  return targets;
}

function validatePlan(plan) {
  exactKeys(plan, PLAN_KEYS, PLAN_KEYS, 'ERR_INVALID_PLAN');
  if (plan.version !== MIGRATION_VERSION || plan.protocol !== PROTOCOL || plan.protocolVersion !== PROTOCOL_VERSION || plan.preview !== true) throw new MigrationSafetyError('migration plan protocol is invalid', 'ERR_INVALID_PLAN');
  const home = resolveHome(plan.home);
  if (!Array.isArray(plan.clients) || plan.clients.length === 0 || [...plan.clients].sort().join('\u0000') !== plan.clients.join('\u0000') || new Set(plan.clients).size !== plan.clients.length) throw new MigrationSafetyError('migration plan clients are invalid', 'ERR_INVALID_PLAN');
  plan.clients.forEach(publicClientId);
  exactKeys(plan.artifact, ARTIFACT_KEYS, ARTIFACT_KEYS, 'ERR_INVALID_PLAN');
  assertManifestHash(plan.artifact.manifestHash);
  if (!Array.isArray(plan.artifact.files)) throw new MigrationSafetyError('migration artifact files are invalid', 'ERR_INVALID_PLAN');
  const artifactHashes = new Set();
  for (const file of plan.artifact.files) {
    exactKeys(file, ARTIFACT_FILE_KEYS, ARTIFACT_FILE_KEYS, 'ERR_INVALID_PLAN');
    normalizeRelative(file.path, 'artifact path');
    assertHash(file.contentHash);
    artifactHashes.add(file.contentHash);
  }
  exactKeys(plan.rollback, ROLLBACK_KEYS, ROLLBACK_KEYS, 'ERR_INVALID_PLAN');
  if (plan.rollback.owner !== OWNER_MARKER || plan.rollback.strategy !== 'byte-identical-backups') throw new MigrationSafetyError('migration rollback contract is invalid', 'ERR_INVALID_PLAN');
  if (!Array.isArray(plan.writes) || plan.writes.length === 0 || plan.writes.length > 100) throw new MigrationSafetyError('migration plan writes are invalid', 'ERR_INVALID_PLAN');
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
    if (!expectedTargets.has(pathValue)) throw new MigrationSafetyError('migration target is outside canonical client outputs', 'ERR_INVALID_PLAN');
    paths.add(pathValue);
    if (typeof write.content !== 'string' || containsSecretLikeValue(write.content)) throw new MigrationSafetyError('migration content is unsafe', 'ERR_SECRET_INPUT');
    assertHash(write.contentHash);
    if (hash(write.content) !== write.contentHash) throw new MigrationSafetyError('migration content hash changed', 'ERR_PLAN_CHANGED');
    if (!artifactHashes.has(write.contentHash)) throw new MigrationSafetyError('migration write is not in the artifact', 'ERR_INVALID_PLAN');
    if (write.existing !== (write.mode === 'replace') || (write.mode !== 'create' && write.mode !== 'replace')) throw new MigrationSafetyError('migration write mode is invalid', 'ERR_INVALID_PLAN');
    if (write.existingHash !== null) assertHash(write.existingHash);
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
  } else {
    await rejectReparseAbsolute(parent);
  }
  await mkdir(parent, { recursive: true });
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
      await rejectReparseComponents(root, relativePath);
    } else {
      await rejectReparseAbsolute(parent, { allowMissing: false });
    }
    await rename(temporary, file);
    if (root && relativePath) {
      await rejectReparseComponents(root, relativePath);
    } else {
      await rejectReparseAbsolute(file, { allowMissing: false });
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function safeRead(file, { root, relativePath, encoding } = {}) {
  if (root && relativePath) {
    ensureInside(root, resolve(root, relativePath));
    await rejectReparseComponents(root, relativePath);
  } else {
    await rejectReparseAbsolute(dirname(file));
  }
  const value = await readFile(file, encoding);
  if (root && relativePath) {
    await rejectReparseComponents(root, relativePath);
  } else {
    await rejectReparseAbsolute(file, { allowMissing: false });
  }
  return value;
}

async function backupBytes(backupRoot, index, bytes, hooks) {
  const run = join(backupRoot, `run-${new Date().toISOString().replaceAll(/[^0-9]/gu, '')}-${randomUUID()}`);
  const backupPath = join(run, `entry-${String(index).padStart(4, '0')}.bin`);
  await atomicWrite(backupPath, bytes, { hooks });
  const verify = await safeRead(backupPath);
  if (hash(verify) !== hash(bytes)) throw new MigrationSafetyError('backup byte verification failed', 'ERR_BACKUP_VERIFY');
  return backupPath;
}

function publicRecoveryJournal(journal, original, rollbackError, recoveryId) {
  return {
    version: 1,
    recoveryId,
    status: 'recovery-required',
    code: original?.code ?? 'ERR_WRITE_FAILED',
    rollbackCode: rollbackError?.code ?? 'ERR_RECOVERY_REQUIRED',
    paths: journal.entries.map((entry) => ({ path: entry.path, markerPath: entry.markerPath, existed: entry.existed })),
    hashes: journal.entries.map((entry) => ({ path: entry.path, appliedContentHash: entry.appliedContentHash, appliedMarkerHash: entry.appliedMarkerHash })),
  };
}

async function persistRecovery(backupRoot, journal, original, rollbackError) {
  const recoveryId = randomUUID();
  const record = publicRecoveryJournal(journal, original, rollbackError, recoveryId);
  const text = canonicalJson(record);
  const pathValue = join(backupRoot, `recovery-${recoveryId}.json`);
  await atomicWrite(pathValue, `${text}\n`);
  return recoveryId;
}

async function callHook(hooks, name, ...args) {
  if (typeof hooks?.[name] === 'function') await hooks[name](...args);
}

async function acquireMigrationLock(backupRoot) {
  await mkdir(backupRoot, { recursive: true });
  await rejectReparseAbsolute(backupRoot);
  const lockPath = join(backupRoot, '.migration.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${OWNER_MARKER}\n`, 'utf8');
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

async function releaseMigrationLock(lockPath) {
  if (!lockPath) return;
  await rejectReparseAbsolute(lockPath, { allowMissing: false }).catch(() => {});
  await rm(lockPath, { force: true });
}

async function persistJournal(journal) {
  const body = {
    version: 1,
    status: journal.status,
    home: journal.home,
    backupRoot: journal.backupRoot,
    planHash: journal.planHash,
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
  await atomicWrite(journal.journalPath, `${canonicalJson(body)}\n`, { replace: true });
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
  normalizeRelative(relative(backupRoot, absolute), 'backup path');
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
  const journalPath = validateBackupPath(home, backupRoot, receipt.journalPath, 'ERR_INVALID_ROLLBACK');
  if (!Array.isArray(receipt.written) || new Set(receipt.written).size !== receipt.written.length) throw new MigrationSafetyError('rollback written paths are invalid', 'ERR_INVALID_ROLLBACK');
  if (!Array.isArray(receipt.backups) || receipt.backups.length !== receipt.written.length) throw new MigrationSafetyError('rollback entries are incomplete', 'ERR_INVALID_ROLLBACK');
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
  if (receiptHash(receipt) !== receipt.receiptHash) throw new MigrationSafetyError('rollback receipt hash is invalid', 'ERR_INVALID_ROLLBACK');
  return { home, backupRoot, journalPath, receipt };
}

async function currentHash(root, relativePath, encoding) {
  try {
    const value = await safeRead(resolve(root, relativePath), { root, relativePath, encoding });
    return hash(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function persistRestoreProgress(validated, entries, status) {
  const body = {
    version: 1,
    status,
    home: validated.home,
    backupRoot: validated.backupRoot,
    planHash: validated.receipt.planHash,
    entries: entries.map((entry) => ({ path: entry.path, markerPath: entry.markerPath, state: entry.state })),
  };
  await atomicWrite(validated.journalPath, `${canonicalJson(body)}\n`, { replace: true });
}

async function restoreReceipt(validated, { hooks } = {}) {
  let hookError;
  try {
    await callHook(hooks, 'rollback', validated.receipt);
  } catch (error) {
    hookError = error;
  }
  const progress = validated.receipt.backups.map((entry) => ({ ...entry, state: 'pending' }));
  await persistRestoreProgress(validated, progress, 'rolling-back');
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
        try {
          await callHook(hooks, 'restoreTarget', entry);
        } catch {
          throw new MigrationSafetyError('target restore failed', 'ERR_RECOVERY_REQUIRED');
        }
        await atomicWrite(target, bytes, { replace: true, root: validated.home, relativePath: entry.path, hooks });
      }
      if (markerNeedsRestore) {
        try {
          await callHook(hooks, 'restoreMarker', entry);
        } catch {
          throw new MigrationSafetyError('marker restore failed', 'ERR_RECOVERY_REQUIRED');
        }
        await atomicWrite(marker, markerBytes, { replace: true, root: validated.home, relativePath: entry.markerPath, hooks });
      }
    } else {
      if (targetNeedsRestore) {
        try {
          await callHook(hooks, 'restoreTarget', entry);
        } catch {
          throw new MigrationSafetyError('target restore failed', 'ERR_RECOVERY_REQUIRED');
        }
        await rm(target, { force: true });
      }
      if (markerNeedsRestore) {
        try {
          await callHook(hooks, 'restoreMarker', entry);
        } catch {
          throw new MigrationSafetyError('marker restore failed', 'ERR_RECOVERY_REQUIRED');
        }
        await rm(marker, { force: true });
      }
    }
    entry.state = 'restored';
    await persistRestoreProgress(validated, progress, 'rolling-back');
  }
  await persistRestoreProgress(validated, progress, 'restored');
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
    clients: specs.map((client) => client.name),
    artifact: {
      manifestHash: normalizedArtifact.manifest.manifestHash,
      files: normalizedArtifact.files.map((file) => ({ path: normalizeRelative(file.path, 'artifact path'), contentHash: hash(file.content) })).sort((left, right) => left.path.localeCompare(right.path)),
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
  const lockPath = await acquireMigrationLock(backupRoot);
  const journal = {
    home,
    backupRoot,
    planHash: plan.planHash,
    journalPath: join(backupRoot, `migration-${plan.planHash}.journal.json`),
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
  try {
    await persistJournal(journal);
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
      await persistJournal(journal);
      await callHook(hooks, 'write', write.path, write);
      await atomicWrite(target, Buffer.from(write.content, 'utf8'), { replace: exists, root: home, relativePath: write.path, hooks });
      journalEntry.state = 'target-written';
      await persistJournal(journal);
      await callHook(hooks, 'marker', write.path, write);
      await atomicWrite(marker, Buffer.from(write.markerContent, 'utf8'), { replace: exists, root: home, relativePath: write.markerPath, hooks });
      journalEntry.state = 'applied';
      await persistJournal(journal);
    }
    journal.status = 'applied';
    await persistJournal(journal);
  } catch (error) {
    let rollbackError;
    try {
      const temporary = buildReceiptFromJournal(journal);
      if (temporary.backups.length > 0) await restoreReceipt(validateReceipt(temporary), { hooks });
      journal.status = 'rolled-back';
      await persistJournal(journal);
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError) {
      keepLock = true;
      let recovery;
      try {
        recovery = await persistRecovery(backupRoot, journal, error, rollbackError);
      } catch {
        recovery = `unpersisted-${randomUUID()}`;
      }
      throw new MigrationSafetyError('migration recovery is required', 'ERR_RECOVERY_REQUIRED', recovery);
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
      sha256: entry.sha256,
      markerSha256: entry.markerSha256,
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
  return restoreReceipt(validated, { hooks: object(options.hooks) ? options.hooks : {} });
}

export function migrationPlanJson(plan) {
  validatePlan(plan);
  return canonicalJson(plan);
}
