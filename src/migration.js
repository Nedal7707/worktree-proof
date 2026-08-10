/**
 * Reversible local workflow migration.
 *
 * Planning is read-only. Applying a plan is opt-in, backs up every existing
 * byte before an atomic replacement, and writes only targets carrying a
 * WorktreeProof ownership marker. No client process is launched.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  open,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { containsSecretLikeValue } from './text-safety.js';
import { canonicalJson, createIntegrationManifest, validateIntegrationManifest } from './manifest.js';

export const MIGRATION_VERSION = 1;
export const OWNER_MARKER = 'worktree-proof-owned:v1';

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/;
const CLIENT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SENSITIVE_PATH = /(?:^|[\\/._-])(?:\.env(?:\.|$)|env|secret|secrets|credential|credentials|password|passwd|token|tokens|cookie|cookies|auth|authorization|private[-_.]?key|api[-_.]?key)(?:$|[\\/._-])/i;
const LOCK_PATH = /(?:^|[\\/._-])(?:lock|locks|package-lock|yarn-lock|pnpm-lock)(?:$|[\\/._-])/i;
const DESTRUCTIVE_MODE = /^(?:delete|remove|destroy|truncate|overwrite)$/i;

export class MigrationSafetyError extends Error {
  constructor(message, code = 'ERR_MIGRATION') {
    super(message);
    this.name = 'MigrationSafetyError';
    this.code = code;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicClientId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MigrationSafetyError('client must be a non-empty identifier', 'ERR_INVALID_CLIENT');
  }
  const id = value.trim().toLowerCase();
  if (!CLIENT_ID.test(id) || id.length > 80 || containsSecretLikeValue(id)) {
    throw new MigrationSafetyError('client must be a public identifier', 'ERR_INVALID_CLIENT');
  }
  return id;
}

function clientSpecs(clients) {
  const values = clients === undefined || clients === null
    ? ['codex', 'claude']
    : (typeof clients === 'string' ? clients.split(',') : clients);
  if (!Array.isArray(values) || values.length === 0 || values.length > 20) {
    throw new MigrationSafetyError('clients must contain one to twenty identifiers', 'ERR_INVALID_CLIENTS');
  }
  const seen = new Set();
  return values.map((value) => {
    const spec = typeof value === 'string' ? { name: value } : value;
    if (!object(spec)) throw new MigrationSafetyError('client specification must be an object or id', 'ERR_INVALID_CLIENT');
    const name = publicClientId(spec.name ?? spec.client ?? spec.id);
    if (seen.has(name)) throw new MigrationSafetyError('clients must be unique', 'ERR_DUPLICATE_CLIENT');
    seen.add(name);
    const root = spec.root ?? spec.rootPath ?? spec.directory;
    if (root !== undefined && (typeof root !== 'string' || !root.trim())) {
      throw new MigrationSafetyError('client root must be a relative path', 'ERR_INVALID_CLIENT_ROOT');
    }
    if (root && (isAbsolute(root) || ABSOLUTE_PATH.test(root) || root.replaceAll('\\', '/').split('/').includes('..'))) {
      throw new MigrationSafetyError('client root must stay under home', 'ERR_PATH_ESCAPE');
    }
    const defaultRoot = name === 'codex' ? '.codex' : name === 'claude' ? '.claude' : `.${name}`;
    return Object.freeze({
      name,
      root: normalizeRelative(root ?? defaultRoot, 'client root'),
      files: spec.files ?? spec.paths,
    });
  });
}

function normalizeRelative(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim()) throw new MigrationSafetyError(`${label} must be non-empty`, 'ERR_INVALID_PATH');
  let normalized = value.trim().replaceAll('\\', '/');
  if (ABSOLUTE_PATH.test(normalized) || normalized.startsWith('//')) {
    throw new MigrationSafetyError(`${label} must be relative`, 'ERR_ABSOLUTE_PATH');
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..' || part.includes('\0'))) {
    throw new MigrationSafetyError(`${label} escapes its root`, 'ERR_PATH_ESCAPE');
  }
  normalized = parts.join('/');
  if (!normalized) throw new MigrationSafetyError(`${label} must be non-empty`, 'ERR_INVALID_PATH');
  return normalized;
}

function inspectablePath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (SENSITIVE_PATH.test(normalized)) throw new MigrationSafetyError('sensitive paths are not migration targets', 'ERR_SENSITIVE_PATH');
  if (LOCK_PATH.test(normalized)) throw new MigrationSafetyError('lock paths are not migration targets', 'ERR_LOCK_PATH');
  return normalized;
}

function resolveHome(home) {
  if (typeof home !== 'string' || !home.trim()) throw new MigrationSafetyError('home is required', 'ERR_HOME_REQUIRED');
  const root = resolve(home);
  if (!isAbsolute(root)) throw new MigrationSafetyError('home must be explicit', 'ERR_INVALID_HOME');
  return root;
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

async function rejectReparseComponents(root, relativePath, { allowMissingLeaf = true } = {}) {
  let current = root;
  const parts = relativePath.replaceAll('\\', '/').split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new MigrationSafetyError('symlink or reparse point in migration path', 'ERR_SYMLINK_ESCAPE');
      }
      if (index < parts.length - 1 && !stats.isDirectory()) {
        throw new MigrationSafetyError('migration parent is not a directory', 'ERR_PATH_COLLISION');
      }
    } catch (error) {
      if (error instanceof MigrationSafetyError) throw error;
      if (error?.code === 'ENOENT' && (allowMissingLeaf || index < parts.length - 1)) return;
      throw new MigrationSafetyError('migration path is not accessible', 'ERR_PATH_ACCESS');
    }
  }
}

function ensureInside(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MigrationSafetyError('migration path escapes home', 'ERR_PATH_ESCAPE');
  }
}

function ownershipText(text) {
  if (typeof text !== 'string') return false;
  return text.includes(OWNER_MARKER)
    || /worktreeproof[- ]owned/i.test(text)
    || /worktree-proof[- ]owned/i.test(text);
}

function markerPath(relativePath) {
  return `${relativePath}.worktree-proof-owner`;
}

function markerContent(relativePath, manifestHash) {
  return `${OWNER_MARKER}\npath=${relativePath}\nmanifest=${manifestHash}\n`;
}

function contentHash(content) {
  return createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')).digest('hex');
}

function jsonArtifactManifest(artifact) {
  if (object(artifact?.manifest)) return validateIntegrationManifest(artifact.manifest);
  if (object(artifact) && artifact.protocol === 'worktreeproof') return validateIntegrationManifest(artifact);
  if (object(artifact) && object(artifact.integrationManifest)) return validateIntegrationManifest(artifact.integrationManifest);
  return createIntegrationManifest({ client: 'generic', capabilities: [], scope: ['.'] });
}

async function normalizeArtifact(artifact) {
  let value = artifact;
  if (typeof artifact === 'string') {
    const trimmed = artifact.trim();
    if (trimmed.startsWith('{')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        throw new MigrationSafetyError('artifact JSON is invalid', 'ERR_INVALID_ARTIFACT');
      }
    } else {
      try {
        value = JSON.parse(await readFile(resolve(trimmed), 'utf8'));
      } catch {
        throw new MigrationSafetyError('artifact file is not readable JSON', 'ERR_INVALID_ARTIFACT');
      }
    }
  }
  if (!object(value)) throw new MigrationSafetyError('artifact must be an object', 'ERR_INVALID_ARTIFACT');
  if (value.destructive === true || value.delete === true || value.remove === true || DESTRUCTIVE_MODE.test(String(value.mode ?? ''))) {
    throw new MigrationSafetyError('destructive migration entries are refused', 'ERR_DESTRUCTIVE_CHANGE');
  }
  const manifest = jsonArtifactManifest(value);
  const sourceFiles = value.files ?? value.entries;
  const files = [];
  if (Array.isArray(sourceFiles)) {
    for (const entry of sourceFiles) {
      if (!object(entry) || typeof entry.path !== 'string' || typeof entry.content !== 'string') {
        throw new MigrationSafetyError('artifact files require path and text content', 'ERR_INVALID_ARTIFACT');
      }
      if (DESTRUCTIVE_MODE.test(String(entry.mode ?? ''))) throw new MigrationSafetyError('destructive migration entries are refused', 'ERR_DESTRUCTIVE_CHANGE');
      files.push({ path: entry.path, content: entry.content, clients: entry.clients ?? entry.targets ?? (entry.client ? [entry.client] : undefined) });
    }
  } else if (object(sourceFiles)) {
    for (const [path, content] of Object.entries(sourceFiles)) {
      if (typeof content !== 'string') throw new MigrationSafetyError('artifact file content must be text', 'ERR_INVALID_ARTIFACT');
      files.push({ path, content });
    }
  }
  if (files.length === 0) {
    const path = typeof value.path === 'string' ? value.path : 'worktree-proof.manifest.json';
    const content = typeof value.content === 'string' ? value.content : `${JSON.stringify(manifest, null, 2)}\n`;
    files.push({ path, content });
  }
  for (const file of files) {
    if (containsSecretLikeValue(file.content)) throw new MigrationSafetyError('artifact contains secret-like content', 'ERR_SECRET_INPUT');
  }
  return { manifest, files };
}

function targetsForFile(file, client) {
  const requested = file.clients;
  if (requested !== undefined) {
    const list = typeof requested === 'string' ? requested.split(',') : requested;
    if (!Array.isArray(list) || !list.some((entry) => publicClientId(typeof entry === 'string' ? entry : entry?.name ?? entry?.client) === client.name)) return false;
  }
  return true;
}

function clientRelativePath(client, filePath) {
  const normalized = inspectablePath(filePath);
  // Explicit client roots in artifact paths are respected, not duplicated.
  if (normalized === client.root || normalized.startsWith(`${client.root}/`)) return normalized;
  return inspectablePath(`${client.root}/${normalized}`);
}

async function inspectTarget(home, relativePath, content, manifestHash) {
  const absolutePath = resolve(home, relativePath);
  ensureInside(home, absolutePath);
  await rejectReparseComponents(home, relativePath);
  const marker = markerPath(relativePath);
  await rejectReparseComponents(home, marker);
  const markerAbsolute = resolve(home, marker);
  let existing = false;
  let mode = 'create';
  let existingHash;
  let existingOwned = false;
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) throw new MigrationSafetyError('target is a symlink or reparse point', 'ERR_SYMLINK_ESCAPE');
    if (!stats.isFile()) throw new MigrationSafetyError('target collision is not a regular file', 'ERR_PATH_COLLISION');
    existing = true;
    const previous = await readFile(absolutePath);
    existingHash = contentHash(previous);
    existingOwned = ownershipText(previous.toString('utf8')) || await pathExists(markerAbsolute);
    if (!existingOwned) throw new MigrationSafetyError('unowned target collision refused', 'ERR_UNOWNED_COLLISION');
    mode = 'replace';
  } catch (error) {
    if (error instanceof MigrationSafetyError) throw error;
    if (error?.code !== 'ENOENT') throw new MigrationSafetyError('target cannot be inspected', 'ERR_PATH_ACCESS');
  }
  return {
    path: relativePath,
    absolutePath,
    markerPath: marker,
    markerAbsolute,
    content,
    contentHash: contentHash(content),
    manifestHash,
    mode,
    existing,
    existingHash,
    existingOwned,
  };
}

/** Build a read-only migration plan for explicit client roots under home. */
export async function planLocalMigration({ home, clients, artifact } = {}) {
  const root = resolveHome(home);
  const specs = clientSpecs(clients);
  if (!(await pathExists(root))) throw new MigrationSafetyError('home does not exist', 'ERR_HOME_NOT_FOUND');
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new MigrationSafetyError('home must be a regular directory', 'ERR_INVALID_HOME');
  const normalizedArtifact = await normalizeArtifact(artifact);
  const writes = [];
  const seen = new Set();
  for (const client of specs) {
    for (const file of normalizedArtifact.files) {
      if (!targetsForFile(file, client)) continue;
      const target = clientRelativePath(client, file.path);
      if (seen.has(target)) throw new MigrationSafetyError('migration targets collide', 'ERR_PLAN_COLLISION');
      seen.add(target);
      const inspected = await inspectTarget(root, target, file.content, normalizedArtifact.manifest.manifestHash);
      writes.push(Object.freeze({
        path: inspected.path,
        content: inspected.content,
        contentHash: inspected.contentHash,
        markerPath: inspected.markerPath,
        markerContent: markerContent(inspected.path, inspected.manifestHash),
        mode: inspected.mode,
        existing: inspected.existing,
        existingHash: inspected.existingHash,
        owner: OWNER_MARKER,
      }));
    }
  }
  if (writes.length === 0) throw new MigrationSafetyError('migration artifact produced no targets', 'ERR_EMPTY_PLAN');
  const body = {
    version: MIGRATION_VERSION,
    protocol: 'worktreeproof',
    protocolVersion: '1.0',
    home: root,
    clients: specs.map((client) => client.name),
    artifact: {
      manifestHash: normalizedArtifact.manifest.manifestHash,
      files: normalizedArtifact.files.map((file) => ({ path: file.path, contentHash: contentHash(file.content) })),
    },
    writes,
    preview: true,
    rollback: { strategy: 'byte-identical-backups', owner: OWNER_MARKER },
  };
  return Object.freeze(body);
}

async function atomicWrite(file, data, { replace = false } = {}) {
  const parent = dirname(file);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${file.split(/[\\/]/).at(-1)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!replace && await pathExists(file)) throw new MigrationSafetyError('refusing to overwrite an existing backup', 'ERR_BACKUP_COLLISION');
    await rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function backupEntry(root, backupRoot, write, index) {
  const target = resolve(root, write.path);
  const targetMarker = resolve(root, write.markerPath);
  const run = join(backupRoot, `run-${new Date().toISOString().replaceAll(/[^0-9]/g, '')}-${randomUUID()}`);
  const bytes = await readFile(target);
  const entryPath = join(run, `entry-${String(index).padStart(4, '0')}.bin`);
  await atomicWrite(entryPath, bytes);
  const verified = await readFile(entryPath);
  const hash = contentHash(verified);
  if (hash !== contentHash(bytes)) throw new MigrationSafetyError('backup byte verification failed', 'ERR_BACKUP_VERIFY');
  const markerExists = await pathExists(targetMarker);
  let markerBackup;
  if (markerExists) {
    const markerBytes = await readFile(targetMarker);
    markerBackup = join(run, `entry-${String(index).padStart(4, '0')}.owner`);
    await atomicWrite(markerBackup, markerBytes);
    if (contentHash(await readFile(markerBackup)) !== contentHash(markerBytes)) throw new MigrationSafetyError('backup marker verification failed', 'ERR_BACKUP_VERIFY');
  }
  return { path: write.path, markerPath: write.markerPath, existed: true, backupPath: entryPath, markerBackupPath: markerBackup, sha256: hash, markerExisted: markerExists };
}

async function verifyPlanWrite(root, write) {
  const relativePath = inspectablePath(write.path);
  const marker = inspectablePath(write.markerPath);
  ensureInside(root, resolve(root, relativePath));
  ensureInside(root, resolve(root, marker));
  if (relativePath !== write.path || marker !== write.markerPath || write.owner !== OWNER_MARKER || typeof write.content !== 'string') {
    throw new MigrationSafetyError('migration plan is invalid', 'ERR_INVALID_PLAN');
  }
  if (contentHash(write.content) !== write.contentHash) throw new MigrationSafetyError('migration content hash changed', 'ERR_PLAN_CHANGED');
  if (typeof write.markerContent !== 'string' || !write.markerContent.includes(OWNER_MARKER) || containsSecretLikeValue(write.markerContent)) {
    throw new MigrationSafetyError('migration ownership marker is invalid', 'ERR_INVALID_PLAN');
  }
  await rejectReparseComponents(root, relativePath);
  await rejectReparseComponents(root, marker);
}

/** Apply an explicit plan. Without confirm:true this is a read-only preview. */
export async function applyLocalMigration(plan, { confirm = false, backupRoot } = {}) {
  if (!object(plan) || !Array.isArray(plan.writes) || typeof plan.home !== 'string') {
    throw new MigrationSafetyError('migration plan is invalid', 'ERR_INVALID_PLAN');
  }
  const root = resolveHome(plan.home);
  for (const write of plan.writes) await verifyPlanWrite(root, write);
  if (confirm !== true) {
    return Object.freeze({ ok: true, preview: true, confirmed: false, planned: plan.writes.map((write) => write.path), writes: plan.writes.length });
  }
  const destination = resolve(backupRoot ?? join(root, '.worktree-proof', 'backups'));
  ensureInside(resolve(destination, '..'), destination);
  if (SENSITIVE_PATH.test(relative(root, destination)) || LOCK_PATH.test(relative(root, destination))) {
    throw new MigrationSafetyError('backup path is not safe', 'ERR_SENSITIVE_PATH');
  }
  await rejectReparseComponents(root, relative(root, destination));
  const backups = [];
  const written = [];
  const created = [];
  try {
    for (let index = 0; index < plan.writes.length; index += 1) {
      const write = plan.writes[index];
      const target = resolve(root, write.path);
      const marker = resolve(root, write.markerPath);
      let exists = false;
      try {
        const stats = await lstat(target);
        if (stats.isSymbolicLink() || !stats.isFile()) throw new MigrationSafetyError('target changed to an unsafe path', 'ERR_SYMLINK_ESCAPE');
        exists = true;
      } catch (error) {
        if (error instanceof MigrationSafetyError) throw error;
        if (error?.code !== 'ENOENT') throw new MigrationSafetyError('target changed during migration', 'ERR_PATH_ACCESS');
      }
      if (exists) {
        const current = await readFile(target);
        const currentHash = contentHash(current);
        if (currentHash !== write.existingHash || (!write.existing && currentHash !== write.contentHash)) {
          throw new MigrationSafetyError('target changed since planning', 'ERR_PLAN_CHANGED');
        }
        const owned = ownershipText(current.toString('utf8')) || await pathExists(marker);
        if (!owned) throw new MigrationSafetyError('unowned target collision refused', 'ERR_UNOWNED_COLLISION');
        backups.push(await backupEntry(root, destination, write, index));
      } else if (write.existing) {
        throw new MigrationSafetyError('planned target disappeared', 'ERR_PLAN_CHANGED');
      }
      await atomicWrite(target, Buffer.from(write.content, 'utf8'), { replace: exists });
      await atomicWrite(marker, Buffer.from(write.markerContent, 'utf8'), { replace: await pathExists(marker) });
      written.push(write.path);
      if (!exists) created.push({ path: write.path, markerPath: write.markerPath });
    }
  } catch (error) {
    const partial = { home: root, backups, created };
    await rollbackLocalMigration(partial).catch(() => {});
    if (error instanceof MigrationSafetyError) throw error;
    throw new MigrationSafetyError('migration write failed', 'ERR_WRITE_FAILED');
  }
  const receipt = {
    ok: true,
    preview: false,
    confirmed: true,
    home: root,
    written,
    created,
    backups,
    backupRoot: destination,
    rollback: { strategy: 'byte-identical-backups', owner: OWNER_MARKER },
  };
  return Object.freeze(receipt);
}

/** Restore an apply receipt to its byte-identical pre-migration state. */
export async function rollbackLocalMigration(receipt) {
  if (!object(receipt) || typeof receipt.home !== 'string' || !Array.isArray(receipt.backups)) {
    throw new MigrationSafetyError('rollback receipt is invalid', 'ERR_INVALID_ROLLBACK');
  }
  const root = resolveHome(receipt.home);
  const restored = [];
  for (const created of [...(receipt.created ?? [])].reverse()) {
    const target = inspectablePath(created.path);
    const marker = inspectablePath(created.markerPath);
    const targetAbsolute = resolve(root, target);
    const markerAbsolute = resolve(root, marker);
    if (await pathExists(targetAbsolute)) {
      const content = await readFile(targetAbsolute, 'utf8').catch(() => '');
      if (!ownershipText(content) && !(await pathExists(markerAbsolute))) {
        throw new MigrationSafetyError('refusing to remove an unowned rollback target', 'ERR_UNOWNED_COLLISION');
      }
    }
    await rm(targetAbsolute, { force: true });
    await rm(markerAbsolute, { force: true });
    restored.push(target);
  }
  for (const backup of [...receipt.backups].reverse()) {
    const target = inspectablePath(backup.path);
    const marker = inspectablePath(backup.markerPath);
      await verifyPlanWrite(root, {
      path: target,
      markerPath: marker,
      owner: OWNER_MARKER,
      content: '',
      contentHash: contentHash(''),
      markerContent: OWNER_MARKER,
    }).catch((error) => {
      if (error.code !== 'ERR_PLAN_CHANGED') throw error;
    });
    const targetAbsolute = resolve(root, target);
    const markerAbsolute = resolve(root, marker);
    if (backup.existed) {
      const bytes = await readFile(backup.backupPath);
      if (contentHash(bytes) !== backup.sha256) throw new MigrationSafetyError('backup is not byte-verifiable', 'ERR_BACKUP_VERIFY');
      await atomicWrite(targetAbsolute, bytes, { replace: true });
      if (backup.markerExisted && backup.markerBackupPath) {
        await atomicWrite(markerAbsolute, await readFile(backup.markerBackupPath), { replace: true });
      } else {
        await rm(markerAbsolute, { force: true });
      }
    } else {
      await rm(targetAbsolute, { force: true });
      await rm(markerAbsolute, { force: true });
    }
    restored.push(target);
  }
  return Object.freeze({ ok: true, restored });
}

export function migrationPlanJson(plan) {
  if (!object(plan)) throw new MigrationSafetyError('migration plan is invalid', 'ERR_INVALID_PLAN');
  return canonicalJson(plan);
}
