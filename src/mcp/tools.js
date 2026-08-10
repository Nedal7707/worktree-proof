/**
 * The intentionally small MCP tool allowlist. This module only calls adapters
 * supplied by the embedding application; it never imports a private core,
 * touches the filesystem, starts a process, or reads environment state.
 */

export const DEFAULT_TOOL_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024,
  maxOutputBytes: 16 * 1024,
  maxStringBytes: 4 * 1024,
  maxDepth: 8,
  maxItems: 128,
});

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const SENSITIVE_KEY = /(?:owner|session|path|stack|token|secret|password|credential|cookie|authorization|auth|prompt|private|home|cwd)/iu;
const SENSITIVE_VALUE = /(?:WTP_[A-Z0-9_]*(?:SECRET|TOKEN|OWNER|SESSION|STACK)|owner(?:[-_ ]private)?|session(?:[-_ ]private)?|stack(?:[-_ ]private)?|secret|token|password|credential|api[_-]?key|bearer\s+[a-z0-9._-]+|eyJ[a-zA-Z0-9_-]{8,})/iu;
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
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return `${Buffer.from(value, 'utf8').subarray(0, Math.max(0, maxBytes - 1)).toString('utf8')}…`;
}

function redactString(value, key) {
  if (SENSITIVE_KEY.test(key ?? '') || SENSITIVE_VALUE.test(value) || ABSOLUTE_PATH.test(value)) return '[redacted]';
  return value;
}

function isJsonSafeInput(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > DEFAULT_TOOL_LIMITS.maxDepth || seen.has(value)) return false;
  if (!Array.isArray(value) && !plainObject(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  const safe = values.every((item) => isJsonSafeInput(item, seen, depth + 1));
  seen.delete(value);
  return safe;
}

/**
 * Convert arbitrary adapter output into bounded JSON-safe data. Object keys
 * are sorted to make serialized responses reproducible. Cycles, unsupported
 * values, depth, item, and string limits are represented by stable markers.
 */
export function sanitizeJson(value, options = {}, state = undefined, key = '') {
  const limits = { ...DEFAULT_TOOL_LIMITS, ...options };
  const current = state ?? { seen: new WeakSet() };
  if (value === null) return null;
  if (typeof value === 'string') return boundedText(redactString(value, key), limits.maxStringBytes);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return '[redacted]';
  if (typeof value !== 'object') return '[redacted]';
  if (current.seen.has(value)) return '[truncated]';
  if (current.depth >= limits.maxDepth) return '[truncated]';
  current.seen.add(value);

  let result;
  const nextState = { seen: current.seen, depth: (current.depth ?? 0) + 1 };
  if (Array.isArray(value)) {
    result = value.slice(0, limits.maxItems).map((item) => sanitizeJson(item, limits, nextState, ''));
    if (value.length > limits.maxItems) result.push('[truncated]');
  } else if (plainObject(value)) {
    result = {};
    for (const property of Object.keys(value).sort().slice(0, limits.maxItems)) {
      if (SENSITIVE_KEY.test(property)) result[property] = '[redacted]';
      else result[property] = sanitizeJson(value[property], limits, nextState, property);
    }
    if (Object.keys(value).length > limits.maxItems) result._truncated = true;
  } else {
    result = '[redacted]';
  }
  current.seen.delete(value);
  return result;
}

export function safeStringify(value, options = {}) {
  const limits = { ...DEFAULT_TOOL_LIMITS, ...options };
  const safe = sanitizeJson(value, limits);
  let text;
  try {
    text = JSON.stringify(safe);
  } catch {
    text = JSON.stringify({ redacted: true });
  }
  if (Buffer.byteLength(text, 'utf8') <= limits.maxOutputBytes) return text;
  return JSON.stringify({ truncated: true });
}

function validateJsonInput(value, limits) {
  if (!plainObject(value)) throw new McpToolError('arguments must be an object', 'ERR_INVALID_PARAMS');
  if (!isJsonSafeInput(value)) throw new McpToolError('arguments must be JSON-safe', 'ERR_INVALID_PARAMS');
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new McpToolError('arguments must be JSON-safe', 'ERR_INVALID_PARAMS'); }
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxInputBytes) {
    throw new McpToolError('arguments too large', 'ERR_INVALID_PARAMS');
  }
  return value;
}

function schema(properties, required = []) {
  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    additionalProperties: false,
  });
}

const TOOLS = Object.freeze([
  Object.freeze({
    name: 'worktreeproof_capabilities',
    description: 'Return bounded WorktreeProof capabilities.',
    inputSchema: schema({}),
  }),
  Object.freeze({
    name: 'worktreeproof_status',
    description: 'Return a redacted, bounded local status summary.',
    inputSchema: schema({}),
  }),
  Object.freeze({
    name: 'worktreeproof_validate_receipt',
    description: 'Validate one closure receipt through the injected core adapter.',
    inputSchema: schema({ receipt: Object.freeze({ type: 'object' }) }, ['receipt']),
  }),
  Object.freeze({
    name: 'worktreeproof_validate_scope',
    description: 'Validate a relative lane scope through the injected core adapter.',
    inputSchema: schema({
      laneId: Object.freeze({ type: 'string', maxLength: 128 }),
      fileScope: Object.freeze({ type: 'string', maxLength: 512 }),
    }, ['fileScope']),
  }),
]);

const LEASE_TOOL = Object.freeze({
  name: 'worktreeproof_reserve_lease',
  description: 'Explicitly reserve one lane after literal confirmation.',
  inputSchema: schema({
    laneId: Object.freeze({ type: 'string', maxLength: 128 }),
    fileScope: Object.freeze({ type: 'string', maxLength: 512 }),
    ttlMs: Object.freeze({ type: 'integer', minimum: 1, maximum: 7_776_000_000 }),
    confirm: Object.freeze({ type: 'boolean', const: true }),
  }, ['laneId', 'fileScope', 'confirm']),
});

function cloneSchema(schemaValue) {
  return JSON.parse(JSON.stringify(schemaValue));
}

export function listMcpTools({ enableLeaseMutation = false } = {}) {
  const source = enableLeaseMutation ? [...TOOLS, LEASE_TOOL] : [...TOOLS];
  return source
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((tool) => ({ ...tool, inputSchema: cloneSchema(tool.inputSchema) }));
}

function adapter(core, names) {
  for (const name of names) {
    if (typeof core?.[name] === 'function') return core[name].bind(core);
  }
  const nested = [core?.scope, core?.evidence, core?.leases, core?.status, core?.capabilities];
  for (const candidate of nested) {
    for (const name of names) if (typeof candidate?.[name] === 'function') return candidate[name].bind(candidate);
  }
  return undefined;
}

function checkKeys(args, tool) {
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new McpToolError('unknown argument', 'ERR_INVALID_PARAMS');
  for (const required of tool.inputSchema.required) if (!(required in args)) throw new McpToolError('missing argument', 'ERR_INVALID_PARAMS');
  for (const [key, value] of Object.entries(args)) {
    const expected = tool.inputSchema.properties[key].type;
    if (expected === 'string' && (typeof value !== 'string' || value.length === 0 || value.length > tool.inputSchema.properties[key].maxLength || CONTROL_CHARS.test(value))) {
      throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    }
    if (expected === 'object' && !plainObject(value)) throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    if (expected === 'integer' && (!Number.isInteger(value) || value < 1 || value > tool.inputSchema.properties[key].maximum)) throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    if (expected === 'boolean' && typeof value !== 'boolean') throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
  }
  return args;
}

async function callAdapter(fn, args, context) {
  if (!fn) throw new McpToolError('adapter unavailable', 'ERR_UNAVAILABLE');
  if (context?.signal?.aborted) throw new McpToolError('request cancelled', 'ERR_CANCELLED');
  return fn(args, context);
}

async function callNamedAdapter(fn, name, args, context) {
  try {
    return await callAdapter(fn, args, context);
  } catch (error) {
    // Public validators in the existing core historically accept the value
    // directly, while injected integrations generally accept an arguments
    // object. A single bounded fallback preserves both contracts without
    // broadening the tool surface or retrying mutation adapters.
    if (name === 'worktreeproof_validate_scope' && typeof args.fileScope === 'string') {
      return callAdapter(fn, args.fileScope, context);
    }
    if (name === 'worktreeproof_validate_receipt' && plainObject(args.receipt)) {
      return callAdapter(fn, args.receipt, context);
    }
    throw error;
  }
}

function resultEnvelope(value, limits) {
  const safe = sanitizeJson(value, limits);
  const text = safeStringify(safe, limits);
  let structured;
  try { structured = JSON.parse(text); } catch { structured = { redacted: true }; }
  return {
    isError: false,
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/** Build an adapter-backed, allowlisted registry for one server context. */
export function createMcpToolRegistry({ core = {}, limits = {}, enableLeaseMutation = false } = {}) {
  const effectiveLimits = { ...DEFAULT_TOOL_LIMITS, ...limits };
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
      const args = checkKeys(validateJsonInput(rawArgs, effectiveLimits), tool);
      if (name === 'worktreeproof_reserve_lease' && args.confirm !== true) {
        throw new McpToolError('confirm must be true', 'ERR_CONFIRM_REQUIRED');
      }
      let value;
      if (name === 'worktreeproof_capabilities' && !adapter(core, methods[name])) {
        value = { supported: true, protocolVersion: '2025-11-25', tools: tools.map(({ name: toolName }) => toolName) };
      } else if (name === 'worktreeproof_status' && !adapter(core, methods[name])) {
        value = { supported: false, reason: 'status adapter unavailable' };
      } else {
        value = await callNamedAdapter(adapter(core, methods[name]), name, args, context);
      }
      return resultEnvelope(value, effectiveLimits);
    },
  });
}
