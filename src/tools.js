/**
 * Safe, declarative tool inventory helpers.
 *
 * The registry intentionally has a very small execution surface: a manifest
 * may name an executable and one of a few version/help flags.  Detection never
 * invokes a shell, reads process state, or runs an installer.  This makes the
 * module useful to a CLI, a desktop app, or a browser-side planning service
 * without turning user supplied data into an execution primitive.
 */

import { readFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('../catalog/tools.json', import.meta.url));

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
export const MAX_PROBE_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_SCAN_CONCURRENCY = 4;

const MANIFEST_KEYS = new Set([
  'id',
  'name',
  'description',
  'categories',
  'capabilities',
  'tags',
  'command',
  'probes',
  'source',
]);
const PROBE_KEYS = new Set(['args', 'timeoutMs']);
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;
const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,63}$/u;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9+._/-]{0,63}$/u;
const SAFE_PROBE_ARGS = new Set([
  '--version',
  '-V',
  '-v',
  'version',
  '-version',
  '/version',
  '--help',
  '-h',
  'help',
  '/?',
]);
const AVAILABILITY_VALUES = new Set(['available', 'unavailable', 'unknown', 'timed-out']);

/** Raised when a manifest would be unsafe or does not match the contract. */
export class ToolManifestValidationError extends TypeError {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolManifestValidationError';
    this.code = details.code ?? 'ERR_INVALID_TOOL_MANIFEST';
    this.path = details.path;
  }
}

/** Raised when a catalog cannot be read or contains invalid entries. */
export class ToolCatalogError extends TypeError {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolCatalogError';
    this.code = details.code ?? 'ERR_INVALID_TOOL_CATALOG';
    this.path = details.path;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ToolManifestValidationError('manifest must not contain symbol properties', {
      code: 'ERR_UNSAFE_TOOL_MANIFEST',
    });
  }
  return Object.keys(value);
}

function requiredText(value, field, maxLength = 160) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new ToolManifestValidationError(`${field} must be a non-empty trimmed string`, {
      path: field,
      code: 'ERR_INVALID_TOOL_FIELD',
    });
  }
  if (value.length > maxLength) {
    throw new ToolManifestValidationError(`${field} is too long`, {
      path: field,
      code: 'ERR_INVALID_TOOL_FIELD',
    });
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ToolManifestValidationError(`${field} contains a control character`, {
      path: field,
      code: 'ERR_UNSAFE_TOOL_MANIFEST',
    });
  }
  return value;
}

function tokenList(value, field, { required = false } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolManifestValidationError(`${field} must be a non-empty array`, {
      path: field,
      code: 'ERR_INVALID_TOOL_FIELD',
    });
  }
  if (value.length > 32) {
    throw new ToolManifestValidationError(`${field} contains too many values`, {
      path: field,
      code: 'ERR_INVALID_TOOL_FIELD',
    });
  }
  const values = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const token = requiredText(value[index], `${field}[${index}]`, 64).toLowerCase();
    if (!TOKEN_PATTERN.test(token)) {
      throw new ToolManifestValidationError(`${field}[${index}] contains unsupported characters`, {
        path: `${field}[${index}]`,
        code: 'ERR_UNSAFE_TOOL_MANIFEST',
      });
    }
    if (seen.has(token)) {
      throw new ToolManifestValidationError(`${field} contains duplicate values`, {
        path: field,
        code: 'ERR_INVALID_TOOL_FIELD',
      });
    }
    seen.add(token);
    values.push(token);
  }
  return values;
}

function timeoutValue(value, path) {
  if (value === undefined) return DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PROBE_TIMEOUT_MS) {
    throw new ToolManifestValidationError(`${path} must be an integer between 1 and ${MAX_PROBE_TIMEOUT_MS}`, {
      path,
      code: 'ERR_INVALID_PROBE_TIMEOUT',
    });
  }
  return value;
}

function normalizeProbe(probe, index) {
  if (!isPlainObject(probe)) {
    throw new ToolManifestValidationError(`probes[${index}] must be an object`, {
      path: `probes[${index}]`,
      code: 'ERR_INVALID_TOOL_PROBE',
    });
  }
  for (const key of ownKeys(probe)) {
    if (!PROBE_KEYS.has(key)) {
      throw new ToolManifestValidationError(`probes[${index}] contains unsupported field ${key}`, {
        path: `probes[${index}]`,
        code: 'ERR_UNSAFE_TOOL_MANIFEST',
      });
    }
  }
  if (!Array.isArray(probe.args) || probe.args.length < 1 || probe.args.length > 2) {
    throw new ToolManifestValidationError(`probes[${index}].args must contain one or two safe flags`, {
      path: `probes[${index}].args`,
      code: 'ERR_INVALID_TOOL_PROBE',
    });
  }
  const args = probe.args.map((arg, argIndex) => {
    if (typeof arg !== 'string' || arg.length === 0 || arg !== arg.trim() || !SAFE_PROBE_ARGS.has(arg)) {
      throw new ToolManifestValidationError(`probes[${index}].args[${argIndex}] is not a permitted version/help flag`, {
        path: `probes[${index}].args[${argIndex}]`,
        code: 'ERR_UNSAFE_TOOL_PROBE',
      });
    }
    return arg;
  });
  return Object.freeze({
    args: Object.freeze(args),
    timeoutMs: timeoutValue(probe.timeoutMs, `probes[${index}].timeoutMs`),
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/**
 * Validate and normalize a declarative tool manifest.
 *
 * Validation throws a ToolManifestValidationError rather than silently
 * dropping unsafe fields.  The returned object is a frozen, JSON-like clone.
 */
export function validateToolManifest(manifest) {
  if (!isPlainObject(manifest)) {
    throw new ToolManifestValidationError('tool manifest must be a plain object', {
      code: 'ERR_INVALID_TOOL_MANIFEST',
    });
  }
  for (const key of ownKeys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) {
      throw new ToolManifestValidationError(`manifest contains unsupported field ${key}`, {
        path: key,
        code: 'ERR_UNSAFE_TOOL_MANIFEST',
      });
    }
  }

  const id = requiredText(manifest.id, 'id', 64).toLowerCase();
  if (!ID_PATTERN.test(id)) {
    throw new ToolManifestValidationError('id contains unsupported characters', {
      path: 'id',
      code: 'ERR_UNSAFE_TOOL_MANIFEST',
    });
  }
  const name = requiredText(manifest.name, 'name', 120);
  const description = manifest.description === undefined
    ? undefined
    : requiredText(manifest.description, 'description', 400);
  const categories = tokenList(manifest.categories, 'categories', { required: true });
  const capabilities = tokenList(manifest.capabilities, 'capabilities', { required: true });
  const tags = tokenList(manifest.tags, 'tags');
  const command = requiredText(manifest.command, 'command', 64);
  if (!COMMAND_PATTERN.test(command) || command.includes('/') || command.includes('\\')) {
    throw new ToolManifestValidationError('command must be an executable name, not a path or shell expression', {
      path: 'command',
      code: 'ERR_UNSAFE_TOOL_MANIFEST',
    });
  }
  if (!Array.isArray(manifest.probes) || manifest.probes.length < 1 || manifest.probes.length > 4) {
    throw new ToolManifestValidationError('probes must contain one to four entries', {
      path: 'probes',
      code: 'ERR_INVALID_TOOL_PROBE',
    });
  }
  const probes = manifest.probes.map(normalizeProbe);
  const source = manifest.source === undefined ? undefined : requiredText(manifest.source, 'source', 32).toLowerCase();
  if (source !== undefined && source !== 'builtin' && source !== 'custom') {
    throw new ToolManifestValidationError('source must be "builtin" or "custom"', {
      path: 'source',
      code: 'ERR_INVALID_TOOL_FIELD',
    });
  }

  const normalized = {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    categories: Object.freeze(categories),
    capabilities: Object.freeze(capabilities),
    ...(tags.length === 0 ? {} : { tags: Object.freeze(tags) }),
    command,
    probes: Object.freeze(probes),
    ...(source === undefined ? {} : { source }),
  };
  return deepFreeze(normalized);
}

function readJsonFile(filePath, label) {
  try {
    const text = readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    throw new ToolCatalogError(`unable to read ${label}`, {
      code: 'ERR_TOOL_CATALOG_READ',
      path: filePath,
      cause: error,
    });
  }
}

function catalogEntries(value, label) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value) && Array.isArray(value.tools)) return value.tools;
  throw new ToolCatalogError(`${label} must be an array or an object with a tools array`, {
    code: 'ERR_INVALID_TOOL_CATALOG',
  });
}

function customManifestEntries(customManifests) {
  if (customManifests === undefined || customManifests === null) return [];
  if (Array.isArray(customManifests)) return customManifests;
  if (isPlainObject(customManifests) && typeof customManifests.id === 'string') return [customManifests];
  if (isPlainObject(customManifests)) return catalogEntries(customManifests, 'custom manifests');
  throw new ToolCatalogError('customManifests must be an array or a catalog object', {
    code: 'ERR_INVALID_CUSTOM_MANIFESTS',
  });
}

/**
 * Load the built-in catalog, optionally appending validated custom manifests.
 *
 * The return value is an Array for convenient iteration and also exposes a
 * non-enumerable `tools` self-reference and `version` value for callers that
 * prefer an object-shaped catalog.
 */
export function loadToolCatalog(options = {}) {
  if (Array.isArray(options)) options = { customManifests: options };
  if (!isPlainObject(options)) throw new TypeError('catalog options must be an object');
  let raw;
  if (options.catalog !== undefined) raw = options.catalog;
  else raw = readJsonFile(options.catalogPath ?? DEFAULT_CATALOG_PATH, 'tool catalog');
  const entries = catalogEntries(raw, 'tool catalog');
  const builtins = entries.map((entry, index) => {
    try {
      const normalized = validateToolManifest(entry);
      return normalized.source ? normalized : validateToolManifest({ ...normalized, source: 'builtin' });
    } catch (error) {
      throw new ToolCatalogError(`invalid catalog entry at index ${index}`, {
        code: 'ERR_INVALID_TOOL_CATALOG_ENTRY',
        cause: error,
      });
    }
  });

  const customs = customManifestEntries(
    options.customManifests ?? options.custom ?? options.manifests,
  ).map((entry, index) => {
    try {
      const normalized = validateToolManifest(entry);
      return validateToolManifest({ ...normalized, source: 'custom' });
    } catch (error) {
      throw new ToolCatalogError(`invalid custom manifest at index ${index}`, {
        code: 'ERR_INVALID_CUSTOM_MANIFEST',
        cause: error,
      });
    }
  });

  const byId = new Map();
  for (const manifest of [...builtins, ...customs]) {
    if (byId.has(manifest.id)) {
      throw new ToolCatalogError(`duplicate tool id ${manifest.id}`, {
        code: 'ERR_DUPLICATE_TOOL_ID',
      });
    }
    byId.set(manifest.id, manifest);
  }
  const output = [...byId.values()];
  const version = isPlainObject(raw) && raw.version !== undefined ? raw.version : 1;
  Object.defineProperties(output, {
    tools: { value: output, enumerable: false },
    version: { value: version, enumerable: false },
    byId: { value: byId, enumerable: false },
  });
  return Object.freeze(output);
}

function asCatalogArray(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (isPlainObject(catalog) && Array.isArray(catalog.tools)) return catalog.tools;
  return [];
}

function findManifest(tool, catalog) {
  if (isPlainObject(tool)) return validateToolManifest(tool);
  if (typeof tool !== 'string' || tool.trim().length === 0) return undefined;
  const id = tool.trim().toLowerCase();
  return asCatalogArray(catalog).find((entry) => entry.id === id);
}

function safeExternalText(value, maxLength = 96) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Remove terminal escapes, paths, URLs, credentials, and common identifiers. */
export function redactProbeOutput(value, maxLength = DEFAULT_MAX_OUTPUT_BYTES) {
  let text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  text = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
  text = text.replace(/\b(?:bearer|token|secret|password|passwd|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]');
  text = text.replace(/https?:\/\/[^\s)\]}>,]+/giu, '[redacted-url]');
  text = text.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/gu, '[redacted-path]');
  text = text.replace(/(^|[\s=(,:])\/(?:[^\s"'<>|]+\/)*[^\s"'<>|]*/gu, '$1[redacted-path]');
  text = text.replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/gu, '[redacted-path]');
  text = text.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, '[redacted-identifier]');
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, '[redacted-identifier]');
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[redacted-identifier]');
  text = text.replace(/\b[0-9a-f]{24,}\b/giu, '[redacted-identifier]');
  text = text.replace(/\s+/gu, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function clampOutputLimit(value) {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_OUTPUT_BYTES) {
    throw new RangeError(`maxOutputBytes must be an integer between 1 and ${MAX_OUTPUT_BYTES}`);
  }
  return value;
}

function clampTimeout(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PROBE_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_PROBE_TIMEOUT_MS}`);
  }
  return value;
}

function probeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ETIMEDOUT') return code;
  return 'SPAWN_ERROR';
}

function killChild(child, signal = 'SIGTERM') {
  if (child && typeof child.kill === 'function') {
    try {
      child.kill(signal);
    } catch {
      // A process may have exited between timeout and kill; there is nothing
      // useful or safe to report from that race.
    }
  }
}

function appendBounded(current, chunk, maxBytes) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  if (!text) return current;
  const currentBytes = Buffer.byteLength(current, 'utf8');
  if (currentBytes >= maxBytes) return current;
  const remaining = maxBytes - currentBytes;
  if (Buffer.byteLength(text, 'utf8') <= remaining) return current + text;
  return current + Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
}

function runProbe(command, probe, options = {}) {
  const timeoutMs = clampTimeout(options.timeoutMs) ?? probe.timeoutMs;
  const maxOutputBytes = clampOutputLimit(options.maxOutputBytes);
  const spawnImpl = options.spawnImpl ?? options.spawn ?? nodeSpawn;
  const spawnOptions = {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  };

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let timer;

    const finish = (details = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const output = redactProbeOutput(`${stdout}${stderr ? `\n${stderr}` : ''}`, maxOutputBytes);
      resolve({
        args: [...probe.args],
        ok: details.code === 0 && !details.signal && !details.error && !details.timedOut,
        exitCode: Number.isInteger(details.code) ? details.code : null,
        signal: details.signal ?? null,
        timedOut: Boolean(details.timedOut),
        output,
        ...(details.error || details.timedOut
          ? { errorCode: details.errorCode ?? (details.timedOut ? 'ETIMEDOUT' : 'SPAWN_ERROR') }
          : {}),
      });
    };

    try {
      // No env, cwd, input, or shell option is supplied by the caller.  The
      // operating system resolves a command name in the normal way, while the
      // manifest controls only the fixed safe flag list.
      child = spawnImpl(command, probe.args, spawnOptions);
    } catch (error) {
      finish({ error, errorCode: probeErrorCode(error) });
      return;
    }

    if (!child || typeof child.on !== 'function') {
      finish({ error: new Error('invalid child process') });
      return;
    }
    if (child.stdout?.on) child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, maxOutputBytes); });
    if (child.stderr?.on) child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk, maxOutputBytes); });
    child.on('error', (error) => finish({ error, errorCode: probeErrorCode(error) }));
    child.on('close', (code, signal) => finish({ code, signal, timedOut }));
    child.on('exit', (code, signal) => finish({ code, signal, timedOut }));

    timer = setTimeout(() => {
      timedOut = true;
      killChild(child, 'SIGTERM');
      // Do not wait for a misbehaving child to emit close.  A short follow-up
      // kill is best effort and does not inspect process state.
      const hardKill = setTimeout(() => killChild(child, 'SIGKILL'), Math.min(100, timeoutMs));
      hardKill.unref?.();
      finish({ timedOut: true, errorCode: 'ETIMEDOUT' });
    }, timeoutMs);
  });
}

function unknownDetection(tool) {
  const id = redactProbeOutput(safeExternalText(tool, 64), 64) || '[unknown]';
  return {
    id,
    name: id,
    categories: [],
    capabilities: [],
    available: false,
    availability: 'unknown',
    reason: 'unknown-tool',
    probes: [],
  };
}

function resultForManifest(manifest, probeResults) {
  const successful = probeResults.find((probe) => probe.ok);
  const timedOut = probeResults.some((probe) => probe.timedOut);
  const attempted = probeResults.length > 0;
  const availability = successful
    ? 'available'
    : timedOut
      ? 'timed-out'
      : attempted
        ? 'unavailable'
        : 'unknown';
  const result = {
    id: manifest.id,
    name: redactProbeOutput(manifest.name, 120),
    categories: manifest.categories.map((category) => redactProbeOutput(category, 64)),
    capabilities: manifest.capabilities.map((capability) => redactProbeOutput(capability, 64)),
    available: availability === 'available',
    availability,
    timedOut: availability === 'timed-out',
    probes: probeResults,
  };
  if (successful?.output) result.version = successful.output.split('\n', 1)[0];
  return Object.freeze(result);
}

/** Detect a named catalog tool or a validated custom manifest. */
export async function detectTool(tool, options = {}) {
  if (!isPlainObject(options)) throw new TypeError('detect options must be an object');
  const catalog = options.catalog
    ?? (isPlainObject(tool)
      ? []
      : loadToolCatalog({
        catalogPath: options.catalogPath,
        customManifests: options.customManifests ?? options.custom ?? options.manifests,
      }));
  const manifest = findManifest(tool, catalog);
  if (!manifest) return unknownDetection(tool);
  const probes = [];
  for (const probe of manifest.probes) {
    const result = await runProbe(manifest.command, probe, options);
    probes.push(result);
    if (result.ok) break;
  }
  return resultForManifest(manifest, probes);
}

function scanEntries(tools, catalog) {
  if (tools === undefined || tools === null) return [...asCatalogArray(catalog)];
  if (typeof tools === 'string' || isPlainObject(tools) && tools.id) return [tools];
  if (Array.isArray(tools)) return tools;
  if (isPlainObject(tools) && Array.isArray(tools.tools)) return [...tools.tools];
  throw new TypeError('tools must be an array, id, manifest, or catalog');
}

/** Detect tools with a small bounded worker pool. */
export async function scanTools(tools, options = {}) {
  if (!isPlainObject(options)) throw new TypeError('scan options must be an object');
  const customOnly = Array.isArray(tools) && tools.every((entry) => isPlainObject(entry));
  const catalog = options.catalog
    ?? (customOnly
      ? []
      : loadToolCatalog({
        catalogPath: options.catalogPath,
        customManifests: options.customManifests ?? options.custom ?? options.manifests,
      }));
  const entries = scanEntries(tools, catalog);
  const concurrency = options.concurrency === undefined ? DEFAULT_SCAN_CONCURRENCY : options.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError('concurrency must be an integer between 1 and 16');
  }
  const results = new Array(entries.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= entries.length) return;
      results[index] = await detectTool(entries[index], { ...options, catalog });
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function inventoryEntries(inventory) {
  if (inventory === undefined || inventory === null) return [];
  if (Array.isArray(inventory)) {
    return inventory.map((entry) => typeof entry === 'string'
      ? { id: entry, available: true, availability: 'available' }
      : entry);
  }
  if (isPlainObject(inventory) && Array.isArray(inventory.tools)) return inventory.tools;
  if (isPlainObject(inventory) && Array.isArray(inventory.available)) {
    return inventory.available.map((id) => ({ id, available: true, availability: 'available' }));
  }
  if (isPlainObject(inventory)) {
    const entries = Object.entries(inventory)
      .filter(([, value]) => value === true || value === false)
      .map(([id, value]) => ({ id, available: value, availability: value ? 'available' : 'unavailable' }));
    if (entries.length > 0) return entries;
  }
  throw new TypeError('inventory must be an array, availability map, or object with a tools array');
}

function normalizeGoalTags(goalTags) {
  const raw = Array.isArray(goalTags) ? goalTags : [goalTags];
  return [...new Set(raw.filter((tag) => typeof tag === 'string').map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function availabilityOf(entry) {
  if (entry?.available === true || entry?.availability === 'available') return 'available';
  if (entry?.availability === 'timed-out' || entry?.availability === 'timeout') return 'timed-out';
  if (entry?.available === false || entry?.availability === 'unavailable') return 'unavailable';
  return 'unknown';
}

function inventoryManifest(entry, catalog) {
  if (!isPlainObject(entry)) return undefined;
  const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : undefined;
  const catalogEntry = id ? asCatalogArray(catalog).find((candidate) => candidate.id === id) : undefined;
  const source = catalogEntry ?? entry;
  if (!source.id) return undefined;
  return {
    id: redactProbeOutput(safeExternalText(source.id, 64), 64),
    name: redactProbeOutput(safeExternalText(source.name ?? source.id, 120), 120),
    categories: Array.isArray(source.categories) ? source.categories.map((item) => redactProbeOutput(safeExternalText(item, 64), 64).toLowerCase()) : [],
    capabilities: Array.isArray(source.capabilities) ? source.capabilities.map((item) => redactProbeOutput(safeExternalText(item, 64), 64).toLowerCase()) : [],
    tags: Array.isArray(source.tags) ? source.tags.map((item) => redactProbeOutput(safeExternalText(item, 64), 64).toLowerCase()) : [],
    availability: availabilityOf(entry),
    available: availabilityOf(entry) === 'available',
    version: source.version ? redactProbeOutput(source.version, 120) : undefined,
  };
}

/**
 * Rank tools by overlap with goal tags and capabilities.  If an inventory is
 * supplied, unavailable tools are excluded; a catalog-only call ranks all
 * declarations because availability has not yet been measured.
 */
export function recommendTools(goalTags, inventory, options = {}) {
  if (!isPlainObject(options)) throw new TypeError('recommendation options must be an object');
  const goals = normalizeGoalTags(goalTags);
  if (goals.length === 0) return [];
  const catalog = options.catalog ?? loadToolCatalog({
    catalogPath: options.catalogPath,
    customManifests: options.customManifests ?? options.custom ?? options.manifests,
  });
  const hasInventory = inventory !== undefined && inventory !== null;
  const entries = hasInventory ? inventoryEntries(inventory) : asCatalogArray(catalog);
  const candidates = [];
  const seen = new Set();
  for (const entry of entries) {
    const availability = availabilityOf(entry);
    if (hasInventory && availability !== 'available' && options.includeUnavailable !== true) continue;
    const manifest = inventoryManifest(entry, catalog);
    if (!manifest || seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    const searchable = new Set([...manifest.categories, ...manifest.capabilities, ...manifest.tags]);
    const matchedTags = goals.filter((goal) => searchable.has(goal));
    const partialMatches = goals.filter((goal) => [...searchable].some((value) => value.includes(goal) || goal.includes(value)));
    const score = matchedTags.length * 4 + Math.max(0, partialMatches.length - matchedTags.length) * 2;
    if (score <= 0) continue;
    candidates.push({
      id: manifest.id,
      name: manifest.name,
      score,
      matchedTags: [...new Set([...matchedTags, ...partialMatches])],
      categories: [...manifest.categories],
      capabilities: [...manifest.capabilities],
      available: manifest.available,
      availability: manifest.availability,
    });
  }
  candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return candidates;
}

/** Produce stable counts and redacted per-tool summaries for UI/reporting. */
export function summarizeInventory(inventory) {
  const entries = inventoryEntries(inventory);
  const catalog = Array.isArray(inventory) && inventory.tools ? inventory : undefined;
  const byId = new Map();
  for (const entry of entries) {
    const normalized = inventoryManifest(entry, catalog);
    if (normalized && !byId.has(normalized.id)) byId.set(normalized.id, normalized);
  }
  const tools = [...byId.values()];
  // Null-prototype maps prevent a custom capability named "__proto__" from
  // mutating the summary object's prototype.
  const byCategory = Object.create(null);
  const byCapability = Object.create(null);
  const counts = { available: 0, unavailable: 0, unknown: 0, timedOut: 0 };
  for (const tool of tools) {
    const availability = tool.availability;
    if (availability === 'available') counts.available += 1;
    else if (availability === 'unavailable') counts.unavailable += 1;
    else if (availability === 'timed-out') { counts.timedOut += 1; counts.unavailable += 1; }
    else counts.unknown += 1;
    for (const category of tool.categories) byCategory[category] = (byCategory[category] ?? 0) + 1;
    for (const capability of tool.capabilities) byCapability[capability] = (byCapability[capability] ?? 0) + 1;
  }
  const listed = tools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    availability: tool.availability,
    available: tool.available,
    categories: [...tool.categories],
    capabilities: [...tool.capabilities],
    ...(tool.version ? { version: tool.version } : {}),
  }));
  return {
    total: tools.length,
    ...counts,
    availableIds: tools.filter((tool) => tool.availability === 'available').map((tool) => tool.id),
    unavailableIds: tools.filter((tool) => tool.availability === 'unavailable' || tool.availability === 'timed-out').map((tool) => tool.id),
    unknownIds: tools.filter((tool) => tool.availability === 'unknown').map((tool) => tool.id),
    byCategory,
    byCapability,
    tools: listed,
  };
}
