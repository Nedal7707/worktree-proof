/** Bounded, injected MCP tool allowlist. No private state, process, or I/O. */

import { types as utilTypes } from 'node:util';

export const DEFAULT_TOOL_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024,
  maxOutputBytes: 16 * 1024,
  maxStringBytes: 4 * 1024,
  maxDepth: 8,
  maxItems: 128,
  maxNodes: 2048,
});
export const HARD_TOOL_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxDepth: 16,
  maxItems: 256,
  maxNodes: 4096,
});

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_WORDS = new Set([
  'apikey', 'token', 'secret', 'password', 'passphrase', 'credential',
  'authorization', 'auth', 'cookie', 'session', 'owner', 'stack', 'path',
  'private', 'privatekey', 'home', 'cwd',
]);
const SENSITIVE_VALUE = /(?:WTP_[A-Z0-9_]*(?:SECRET|TOKEN|OWNER|SESSION|STACK)|\bBearer\s+[A-Za-z0-9._~+/=-]+|(?:^|\s)(?:sk|ghp|gho|ghs|ghr|xox[baprs]-)[A-Za-z0-9_-]+|\bAKIA[0-9A-Z]{12,}\b|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{8,})/iu;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

export class McpToolError extends Error {
  constructor(message, code = 'ERR_TOOL') {
    super(String(message).slice(0, 160));
    this.name = 'McpToolError';
    this.code = code;
  }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function effectiveLimits(options = {}) {
  const limits = { ...DEFAULT_TOOL_LIMITS, ...options };
  for (const key of Object.keys(HARD_TOOL_LIMITS)) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > HARD_TOOL_LIMITS[key]) {
      throw new RangeError(`${key} is outside the bounded range`);
    }
  }
  return limits;
}

function normalizedKey(key) {
  return String(key).replaceAll('_', '').replaceAll('-', '').toLowerCase();
}

function sensitiveKey(key) {
  const normalized = normalizedKey(key);
  return [...SENSITIVE_WORDS].some((word) => normalized === word || normalized.includes(word));
}

function redactString(value, key = '') {
  if (sensitiveKey(key) || SENSITIVE_VALUE.test(value) || ABSOLUTE_PATH.test(value)) return '[redacted]';
  return value;
}

/** Ensure a string's complete UTF-8 representation stays within maxBytes. */
export function boundedText(value, maxBytes) {
  if (maxBytes < 1) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '…';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes < markerBytes) return '?'.repeat(maxBytes);
  let prefix = Buffer.from(value, 'utf8').subarray(0, maxBytes - markerBytes).toString('utf8');
  while (prefix && Buffer.byteLength(prefix, 'utf8') + markerBytes > maxBytes) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}

function descriptors(value, maxItems = DEFAULT_TOOL_LIMITS.maxItems) {
  try {
    if (utilTypes.isProxy(value)) throw new McpToolError('proxy is not JSON-safe', 'ERR_INVALID_PARAMS');
    const keys = Reflect.ownKeys(value);
    const array = Array.isArray(value);
    let items = 0;
    for (const key of keys) {
      if (typeof key !== 'string') throw new McpToolError('symbols are not JSON-safe', 'ERR_INVALID_PARAMS');
      if (!(array && key === 'length') && ++items > maxItems) throw new McpToolError('value has too many items', 'ERR_INVALID_PARAMS');
    }
    const own = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || (!descriptor.enumerable && !(array && key === 'length'))) throw new McpToolError('accessor or non-enumerable value is not JSON-safe', 'ERR_INVALID_PARAMS');
      own[key] = descriptor;
    }
    return own;
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    throw new McpToolError('value is not JSON-safe', 'ERR_INVALID_PARAMS');
  }
}

function validateNode(value, limits, state, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > limits.maxStringBytes) throw new McpToolError('string is too large', 'ERR_INVALID_PARAMS');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new McpToolError('number is not JSON-safe', 'ERR_INVALID_PARAMS');
    return;
  }
  if (typeof value !== 'object' || depth > limits.maxDepth) throw new McpToolError('value is not JSON-safe', 'ERR_INVALID_PARAMS');
  if (state.seen.has(value)) throw new McpToolError('cyclic value is not JSON-safe', 'ERR_INVALID_PARAMS');
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) throw new McpToolError('value is too large', 'ERR_INVALID_PARAMS');
  state.seen.add(value);
  let own;
  try {
    if (!Array.isArray(value) && !plainObject(value)) throw new McpToolError('value is not a plain object', 'ERR_INVALID_PARAMS');
    own = descriptors(value, limits.maxItems);
    const keys = Object.keys(own).filter((key) => !(Array.isArray(value) && key === 'length'));
    if (keys.length > limits.maxItems) throw new McpToolError('value has too many items', 'ERR_INVALID_PARAMS');
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) throw new McpToolError('dangerous key is not allowed', 'ERR_INVALID_PARAMS');
      const descriptor = own[key];
      if (!descriptor || !('value' in descriptor)) throw new McpToolError('accessor is not JSON-safe', 'ERR_INVALID_PARAMS');
      validateNode(descriptor.value, limits, state, depth + 1);
    }
  } finally {
    state.seen.delete(value);
  }
}

export function assertJsonSafe(value, options = {}) {
  const limits = effectiveLimits(options);
  validateNode(value, limits, { seen: new WeakSet(), nodes: 0 }, 0);
  return true;
}

function sanitizeNode(value, limits, state, key = '', depth = 0) {
  if (value === null) return null;
  if (typeof value === 'string') return boundedText(redactString(value, key), limits.maxStringBytes);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[redacted]';
  if (typeof value !== 'object' || depth > limits.maxDepth || state.seen.has(value)) return '[truncated]';
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) return '[truncated]';
  state.seen.add(value);
  let result;
  try {
    if (Array.isArray(value)) {
      const own = descriptors(value, limits.maxItems);
      const keys = Object.keys(own).filter((item) => item !== 'length').sort((a, b) => Number(a) - Number(b)).slice(0, limits.maxItems);
      result = keys.map((item) => DANGEROUS_KEYS.has(item) ? '[redacted]' : own[item] && 'value' in own[item] ? sanitizeNode(own[item].value, limits, state, '', depth + 1) : '[redacted]');
      if (Object.keys(own).filter((item) => item !== 'length').length > limits.maxItems) result.push('[truncated]');
    } else if (plainObject(value)) {
      const own = descriptors(value, limits.maxItems);
      result = {};
      const keys = Object.keys(own).sort();
      for (const property of keys.slice(0, limits.maxItems)) {
        if (DANGEROUS_KEYS.has(property)) continue;
        if (sensitiveKey(property)) result[property] = '[redacted]';
        else {
          const descriptor = own[property];
          result[property] = descriptor && 'value' in descriptor ? sanitizeNode(descriptor.value, limits, state, property, depth + 1) : '[redacted]';
        }
      }
      if (keys.length > limits.maxItems) result._truncated = true;
    } else result = '[redacted]';
  } catch {
    result = '[redacted]';
  } finally {
    state.seen.delete(value);
  }
  return result;
}

export function sanitizeJson(value, options = {}) {
  const limits = effectiveLimits(options);
  return sanitizeNode(value, limits, { seen: new WeakSet(), nodes: 0 });
}

export function safeStringify(value, options = {}) {
  const limits = effectiveLimits(options);
  let text;
  try { text = JSON.stringify(sanitizeJson(value, limits)); }
  catch { text = '{"redacted":true}'; }
  if (Buffer.byteLength(text, 'utf8') <= limits.maxOutputBytes) return text;
  return '{"truncated":true}';
}

function schema(properties, required = []) {
  return Object.freeze({ type: 'object', properties: Object.freeze(properties), required: Object.freeze(required), additionalProperties: false });
}

const TOOLS = Object.freeze([
  Object.freeze({ name: 'worktreeproof_capabilities', description: 'Return bounded WorktreeProof capabilities.', inputSchema: schema({}) }),
  Object.freeze({ name: 'worktreeproof_status', description: 'Return a redacted, bounded local status summary.', inputSchema: schema({}) }),
  Object.freeze({ name: 'worktreeproof_validate_receipt', description: 'Validate one closure receipt through the injected core adapter.', inputSchema: schema({ receipt: Object.freeze({ type: 'object' }) }, ['receipt']) }),
  Object.freeze({ name: 'worktreeproof_validate_scope', description: 'Validate a relative lane scope through the injected core adapter.', inputSchema: schema({ laneId: Object.freeze({ type: 'string', maxLength: 128 }), fileScope: Object.freeze({ type: 'string', maxLength: 512 }) }, ['fileScope']) }),
]);
const LEASE_TOOL = Object.freeze({ name: 'worktreeproof_reserve_lease', description: 'Explicitly reserve one lane after literal confirmation.', inputSchema: schema({ laneId: Object.freeze({ type: 'string', maxLength: 128 }), fileScope: Object.freeze({ type: 'string', maxLength: 512 }), ttlMs: Object.freeze({ type: 'integer', minimum: 1, maximum: 7_776_000_000 }), confirm: Object.freeze({ type: 'boolean', const: true }) }, ['laneId', 'fileScope', 'confirm']) });

const cloneSchema = (value) => JSON.parse(JSON.stringify(value));
export function listMcpTools({ enableLeaseMutation = false } = {}) {
  const source = enableLeaseMutation ? [...TOOLS, LEASE_TOOL] : [...TOOLS];
  return source.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((tool) => ({ ...tool, inputSchema: cloneSchema(tool.inputSchema) }));
}

function adapter(core, names) {
  for (const name of names) if (typeof core?.[name] === 'function') return core[name].bind(core);
  for (const candidate of [core?.scope, core?.evidence, core?.leases, core?.status, core?.capabilities]) {
    for (const name of names) if (typeof candidate?.[name] === 'function') return candidate[name].bind(candidate);
  }
  return undefined;
}

function checkKeys(args, tool, limits) {
  assertJsonSafe(args, limits);
  let encoded;
  try { encoded = JSON.stringify(args); } catch { throw new McpToolError('arguments must be JSON-safe', 'ERR_INVALID_PARAMS'); }
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxInputBytes) throw new McpToolError('arguments too large', 'ERR_INVALID_PARAMS');
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  for (const key of Object.keys(args)) if (!allowed.has(key) || DANGEROUS_KEYS.has(key)) throw new McpToolError('unknown argument', 'ERR_INVALID_PARAMS');
  for (const required of tool.inputSchema.required) if (!(required in args)) throw new McpToolError('missing argument', 'ERR_INVALID_PARAMS');
  for (const [key, value] of Object.entries(args)) {
    const definition = tool.inputSchema.properties[key];
    if (definition.type === 'string' && (typeof value !== 'string' || value.length === 0 || value.length > definition.maxLength || CONTROL_CHARS.test(value))) throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    if (definition.type === 'object' && !plainObject(value)) throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    if (definition.type === 'integer' && (!Number.isInteger(value) || value < 1 || value > definition.maximum)) throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    if (definition.type === 'boolean' && typeof value !== 'boolean') throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
  }
  return args;
}

async function invoke(fn, args, context) {
  if (!fn) throw new McpToolError('adapter unavailable', 'ERR_UNAVAILABLE');
  if (context?.signal?.aborted) throw new McpToolError('request cancelled', 'ERR_CANCELLED');
  return fn(args, context);
}

async function invokeNamed(fn, name, args, context) {
  try { return await invoke(fn, args, context); }
  catch (error) {
    if (name === 'worktreeproof_validate_scope' && typeof args.fileScope === 'string') return invoke(fn, args.fileScope, context);
    if (name === 'worktreeproof_validate_receipt' && plainObject(args.receipt)) return invoke(fn, args.receipt, context);
    throw error;
  }
}

function resultEnvelope(value, limits, isError = false) {
  const text = safeStringify(value, limits);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { redacted: true }; }
  const result = { isError, content: [{ type: 'text', text }] };
  if (plainObject(parsed)) result.structuredContent = parsed;
  return result;
}

export function createMcpToolRegistry({ core = {}, limits = {}, enableLeaseMutation = false } = {}) {
  const effective = effectiveLimits(limits);
  const tools = listMcpTools({ enableLeaseMutation });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const methods = {
    worktreeproof_capabilities: ['capabilities', 'getCapabilities', 'worktreeproofCapabilities'],
    worktreeproof_status: ['status', 'getStatus', 'inspectStatus'],
    worktreeproof_validate_scope: ['validateScope', 'validate_scope'],
    worktreeproof_validate_receipt: ['validateReceipt', 'validateClosureReceipt', 'validate_receipt'],
    worktreeproof_reserve_lease: ['reserveLease', 'reserve_lease', 'reserve'],
  };
  return Object.freeze({
    list: () => listMcpTools({ enableLeaseMutation }),
    async call(name, rawArgs = {}, context = {}) {
      const tool = byName.get(name);
      if (!tool) throw new McpToolError('tool not found', 'ERR_TOOL_NOT_FOUND');
      const args = checkKeys(rawArgs, tool, effective);
      if (name === 'worktreeproof_reserve_lease' && args.confirm !== true) throw new McpToolError('confirm must be true', 'ERR_CONFIRM_REQUIRED');
      let value;
      const fn = adapter(core, methods[name]);
      if (name === 'worktreeproof_capabilities' && !fn) value = { supported: true, protocolVersion: '2025-11-25', tools: tools.map(({ name: item }) => item) };
      else if (name === 'worktreeproof_status' && !fn) value = { supported: false, reason: 'status adapter unavailable' };
      else {
        try { value = await invokeNamed(fn, name, args, context); }
        catch (error) {
          if (error instanceof McpToolError && error.code === 'ERR_CANCELLED') throw error;
          return resultEnvelope({ error: 'tool execution failed' }, effective, true);
        }
      }
      return resultEnvelope(value, effective, false);
    },
  });
}
