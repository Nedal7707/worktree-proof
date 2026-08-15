import {
  McpError,
  createLineDecoder,
  isJsonRpcNotification,
  jsonRpcError,
} from './framing.js';
import { types as utilTypes } from 'node:util';
import {
  DEFAULT_TOOL_LIMITS,
  DANGEROUS_KEYS,
  HARD_TOOL_LIMITS,
  McpToolError,
  assertJsonSafe,
  createMcpToolRegistry,
  plainObject,
} from './tools.js';
import { VERSION } from '../version.js';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SERVER_INFO = Object.freeze({ name: 'worktree-proof', version: VERSION });
export const DEFAULT_MCP_LIMITS = Object.freeze({
  maxMessageBytes: 16 * 1024,
  maxInputBytes: 16 * 1024,
  maxOutputBytes: 16 * 1024,
  maxQueuedMessages: 64,
  maxInFlight: 16,
  maxPendingOutputBytes: 128 * 1024,
  maxPendingOutputMessages: 64,
  maxDiagnosticBytes: 8 * 1024,
  maxDiagnosticMessages: 32,
  maxStringBytes: DEFAULT_TOOL_LIMITS.maxStringBytes,
  maxDepth: DEFAULT_TOOL_LIMITS.maxDepth,
  maxItems: DEFAULT_TOOL_LIMITS.maxItems,
  maxNodes: DEFAULT_TOOL_LIMITS.maxNodes,
});
export const HARD_MCP_LIMITS = Object.freeze({
  maxMessageBytes: 64 * 1024,
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 64 * 1024,
  maxQueuedMessages: 256,
  maxInFlight: 32,
  maxPendingOutputBytes: 256 * 1024,
  maxPendingOutputMessages: 256,
  maxDiagnosticBytes: 16 * 1024,
  maxDiagnosticMessages: 64,
  maxStringBytes: HARD_TOOL_LIMITS.maxStringBytes,
  maxDepth: HARD_TOOL_LIMITS.maxDepth,
  maxItems: HARD_TOOL_LIMITS.maxItems,
  maxNodes: HARD_TOOL_LIMITS.maxNodes,
});

function ownDescriptors(value, maxItems = DEFAULT_TOOL_LIMITS.maxItems) {
  try {
    if (utilTypes.isProxy(value)) throw new Error('proxy');
    const keys = Reflect.ownKeys(value);
    const array = Array.isArray(value);
    let items = 0;
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('symbols');
      if (!(array && key === 'length') && ++items > maxItems) throw new Error('too many items');
    }
    const descriptors = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || (!descriptor.enumerable && !(array && key === 'length'))) throw new Error('unsafe descriptor');
      descriptors[key] = descriptor;
    }
    return descriptors;
  } catch {
    throw new McpError(-32600, 'invalid request');
  }
}

function safeId(message, maxItems) {
  try {
    const descriptor = ownDescriptors(message, maxItems).id;
    if (!descriptor || !('value' in descriptor)) return undefined;
    const id = descriptor.value;
    if (id === null) return null;
    if (typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(id)) return id;
    if (typeof id === 'number' && Number.isFinite(id) && Math.abs(id) <= Number.MAX_SAFE_INTEGER) return id;
    return null;
  } catch {
    return null;
  }
}

function hasOwnId(message, maxItems) {
  try {
    const descriptors = ownDescriptors(message, maxItems);
    return Object.prototype.hasOwnProperty.call(descriptors, 'id');
  } catch {
    return true;
  }
}

function notificationCandidate(message, maxItems) {
  return plainObject(message) && !hasOwnId(message, maxItems);
}

function normalizeLimits(options = {}) {
  const limits = { ...DEFAULT_MCP_LIMITS, ...options };
  if (!Object.prototype.hasOwnProperty.call(options, 'maxInputBytes')) limits.maxInputBytes = Math.min(limits.maxInputBytes, limits.maxMessageBytes);
  for (const key of Object.keys(HARD_MCP_LIMITS)) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > HARD_MCP_LIMITS[key]) throw new RangeError(`${key} is outside the bounded range`);
  }
  if (limits.maxInputBytes > limits.maxMessageBytes) throw new RangeError('maxInputBytes cannot exceed maxMessageBytes');
  return limits;
}

function errorFor(error) {
  if (error instanceof McpError) return error;
  if (error instanceof McpToolError) {
    if (error.code === 'ERR_TOOL_NOT_FOUND') return new McpError(-32601, 'method not found');
    if (error.code === 'ERR_INVALID_PARAMS' || error.code === 'ERR_CONFIRM_REQUIRED') return new McpError(-32602, 'invalid params');
    if (error.code === 'ERR_CANCELLED') return new McpError(-32800, 'request cancelled');
  }
  return new McpError(-32603, 'internal error');
}

function mapKey(id) { return `${typeof id}:${String(id)}`; }

function validateMessage(message, context) {
  const notification = notificationCandidate(message, context.limits.maxItems);
  const id = safeId(message, context.limits.maxItems);
  try {
    assertJsonSafe(message, context.limits);
  } catch {
    return { ok: false, notification, id };
  }
  if (!plainObject(message)) return { ok: false, notification: false, id };
  let descriptors;
  try { descriptors = ownDescriptors(message, context.limits.maxItems); } catch { return { ok: false, notification, id }; }
  const keys = Object.keys(descriptors);
  const jsonrpc = descriptors.jsonrpc?.value;
  const method = descriptors.method?.value;
  const params = descriptors.params?.value;
  if (jsonrpc !== '2.0' || typeof method !== 'string' || !method || method.length > 128 || keys.some((key) => DANGEROUS_KEYS.has(key))) {
    return { ok: false, notification, id };
  }
  if (Object.prototype.hasOwnProperty.call(descriptors, 'id')) {
    const idDescriptor = descriptors.id;
    if (!idDescriptor || !('value' in idDescriptor) || id === null || (typeof id !== 'string' && typeof id !== 'number')) return { ok: false, notification, id };
  }
  try {
    if (Buffer.byteLength(JSON.stringify(message), 'utf8') > context.limits.maxInputBytes) return { ok: false, notification, id };
  } catch {
    return { ok: false, notification, id };
  }
  if (Object.prototype.hasOwnProperty.call(descriptors, 'params') && (params === null || typeof params !== 'object' || (!plainObject(params) && !Array.isArray(params)))) {
    return { ok: false, notification, id };
  }
  return { ok: true, notification, id, method, params };
}

function makeCallContext(ctx, id, sequence) {
  const controller = new AbortController();
  const parent = ctx.signal;
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener?.('abort', abort, { once: true });
  return { controller, sequence, context: { ...ctx, signal: controller.signal, requestId: id }, cleanup: () => parent?.removeEventListener?.('abort', abort) };
}

function callWithAbort(call, invoke) {
  let operation;
  try { operation = Promise.resolve().then(invoke); }
  catch (error) { operation = Promise.reject(error); }
  operation.catch(() => {});
  const signal = call.controller.signal;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new McpToolError('request cancelled', 'ERR_CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal.aborted) onAbort();
  });
}

/** Handle one parsed JSON value. Notifications never produce a response. */
export async function handleMcpMessage(message, context = {}, metadata = {}) {
  const ctx = context?.__mcpContext === true ? context : contextFrom(context);
  const checked = validateMessage(message, ctx);
  if (!checked.ok) return checked.notification ? null : jsonRpcError(checked.id, -32600, 'invalid request');
  const { notification, id, method, params } = checked;

  if (method === 'initialize') {
    if (notification) return null;
    if (ctx.state.initialized || !plainObject(params) || typeof params.protocolVersion !== 'string' || !plainObject(params.capabilities) || !plainObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
      return notification ? null : jsonRpcError(id, -32600, 'invalid request');
    }
    ctx.state.initialized = true;
    return notification ? null : { jsonrpc: '2.0', id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { ...MCP_SERVER_INFO } } };
  }

  if (method === 'notifications/initialized') {
    if (!notification || !ctx.state.initialized || ctx.state.initializedNotification) return notification ? null : jsonRpcError(id, -32600, 'invalid request');
    ctx.state.initializedNotification = true;
    return null;
  }

  if (!ctx.state.initialized || !ctx.state.initializedNotification) return notification ? null : jsonRpcError(id, -32002, 'server not initialized');
  if (ctx.signal?.aborted) return notification ? null : jsonRpcError(id, -32800, 'request cancelled');

  if (method === 'notifications/cancelled') {
    if (!notification || !plainObject(params) || (typeof params.requestId !== 'string' && typeof params.requestId !== 'number')) return notification ? null : jsonRpcError(id, -32600, 'invalid request');
    const target = ctx.inFlight.get(mapKey(params.requestId));
    target?.controller.abort();
    return null;
  }

  if (method === 'tools/list') {
    if (params !== undefined && !plainObject(params)) return notification ? null : jsonRpcError(id, -32602, 'invalid params');
    return notification ? null : { jsonrpc: '2.0', id, result: { tools: ctx.tools.list() } };
  }

  if (method === 'tools/call') {
    if (!plainObject(params) || typeof params.name !== 'string' || !params.name || (params.arguments !== undefined && !plainObject(params.arguments))) return notification ? null : jsonRpcError(id, -32602, 'invalid params');
    if (notification) {
      try { await ctx.tools.call(params.name, params.arguments ?? {}, makeCallContext(ctx, undefined).context); } catch { /* notification errors are intentionally silent */ }
      return null;
    }
    if (ctx.inFlight.has(mapKey(id))) return jsonRpcError(id, -32600, 'invalid request');
    const call = makeCallContext(ctx, id, metadata.sequence);
    ctx.inFlight.set(mapKey(id), call);
    try {
      const result = await callWithAbort(call, () => ctx.tools.call(params.name, params.arguments ?? {}, call.context));
      if (call.controller.signal.aborted || ctx.closed) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (call.controller.signal.aborted || ctx.closed) return null;
      const mapped = errorFor(error);
      return jsonRpcError(id, mapped.code, mapped.message);
    } finally {
      call.cleanup();
      ctx.inFlight.delete(mapKey(id));
    }
  }
  return notification ? null : jsonRpcError(id, -32601, 'method not found');
}

function contextFrom(value = {}) {
  const source = value?.context ?? value;
  if (source?.__mcpContext === true) return source;
  const limits = normalizeLimits(source?.limits ?? {});
  const state = source?.state ?? { initialized: false, initializedNotification: false, closed: false };
  const context = { __mcpContext: true, core: source?.core ?? {}, limits, enableLeaseMutation: source?.enableLeaseMutation === true || source?.allowLeaseMutation === true, signal: source?.signal, state, closed: state.closed === true, inFlight: source?.inFlight ?? new Map() };
  context.tools = source?.tools?.call && source?.tools?.list ? source.tools : createMcpToolRegistry({ core: context.core, limits, enableLeaseMutation: context.enableLeaseMutation });
  return context;
}

function fixedDiagnostic(error) {
  if (error?.transport === true) return 'mcp transport input rejected';
  if (error?.code === 'ERR_INPUT') return 'mcp input closed';
  if (error?.code === 'ERR_OUTPUT') return 'mcp output closed';
  return 'mcp transport error';
}

/** Create one bounded stdio server; construction itself performs no I/O. */
export function createMcpServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostic = options.error ?? process.stderr;
  const limits = normalizeLimits(options.limits ?? {});
  const state = { initialized: false, initializedNotification: false, closed: false };
  const context = contextFrom({ core: options.core, limits, signal: options.signal, state, inFlight: new Map(), enableLeaseMutation: options.enableLeaseMutation === true || options.allowLeaseMutation === true });

  let started = false;
  let inputEnded = false;
  let processCount = 0;
  let sequence = 0;
  let nextWrite = 0;
  let pendingResponses = new Map();
  let queue = [];
  let outputQueue = [];
  let outputBytes = 0;
  let outputBlocked = false;
  let diagnosticsBytes = 0;
  let diagnosticsMessages = 0;
  let diagnosticsTruncated = false;
  let decoder;
  let resolveRun;
  let runPromise;
  let shutdownTimer;

  const maybeCloseAfterDrain = () => {
    if (!inputEnded || processCount !== 0 || queue.length !== 0 || state.closed) return;
    if (outputQueue.length === 0 && !outputBlocked) { close(); return; }
    if (!shutdownTimer) shutdownTimer = setTimeout(() => close(), 100);
  };

  const writeDiagnostic = (error) => {
    const text = fixedDiagnostic(error);
    if (!diagnostic || typeof diagnostic.write !== 'function' || diagnosticsTruncated) return;
    const bytes = Buffer.byteLength(`${text}\n`, 'utf8');
    if (diagnosticsMessages < limits.maxDiagnosticMessages && diagnosticsBytes + bytes <= limits.maxDiagnosticBytes) {
      try { diagnostic.write(`${text}\n`); diagnosticsBytes += bytes; diagnosticsMessages += 1; } catch { /* closed stderr */ }
      return;
    }
    diagnosticsTruncated = true;
    const marker = 'mcp diagnostics truncated\n';
    if (diagnosticsBytes + Buffer.byteLength(marker, 'utf8') <= limits.maxDiagnosticBytes) {
      try { diagnostic.write(marker); } catch { /* closed stderr */ }
    }
  };

  const flushOutput = () => {
    if (state.closed || outputBlocked || !output || typeof output.write !== 'function') return;
    while (outputQueue.length > 0 && !outputBlocked) {
      const entry = outputQueue.shift();
      outputBytes -= entry.bytes;
      try {
        const accepted = output.write(entry.line);
        if (accepted === false) {
          outputBlocked = true;
          output.once?.('drain', () => { outputBlocked = false; flushOutput(); maybeCloseAfterDrain(); });
        }
      } catch (error) { writeDiagnostic(Object.assign(new Error(), { code: 'ERR_OUTPUT', cause: error })); close(); }
    }
  };

  const enqueueOutput = (response) => {
    if (!response || state.closed) return;
    let line;
    try { line = `${JSON.stringify(response)}\n`; } catch { line = `${JSON.stringify(jsonRpcError(response.id, -32603, 'internal error'))}\n`; }
    if (Buffer.byteLength(line, 'utf8') > limits.maxOutputBytes) line = `${JSON.stringify(jsonRpcError(response.id, -32603, 'response too large'))}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > limits.maxOutputBytes || outputQueue.length >= limits.maxPendingOutputMessages || outputBytes + bytes > limits.maxPendingOutputBytes) {
      writeDiagnostic(new McpError(-32603, 'output queue bounded'));
      close();
      return;
    }
    outputQueue.push({ line, bytes });
    outputBytes += bytes;
    flushOutput();
  };

  const flushOrdered = () => {
    while (pendingResponses.has(nextWrite)) {
      const response = pendingResponses.get(nextWrite);
      pendingResponses.delete(nextWrite);
      nextWrite += 1;
      if (response) enqueueOutput(response);
    }
  };

  const finishIfIdle = () => { maybeCloseAfterDrain(); };

  const processEntry = async (entry) => {
    try { pendingResponses.set(entry.sequence, await handleMcpMessage(entry.message, context, { sequence: entry.sequence })); }
    catch { pendingResponses.set(entry.sequence, isJsonRpcNotification(entry.message) ? null : jsonRpcError(safeId(entry.message, limits.maxItems), -32603, 'internal error')); }
    finally {
      processCount -= 1;
      flushOrdered();
      if (queue.length > 0 && !state.closed) void startQueued();
      finishIfIdle();
    }
  };

  const startQueued = async () => {
    while (!state.closed && processCount < limits.maxInFlight && queue.length > 0) {
      const entry = queue.shift();
      processCount += 1;
      void processEntry(entry);
    }
  };

  const cancellationRequestId = (message) => {
    try {
      if (!plainObject(message)) return undefined;
      const descriptors = ownDescriptors(message, limits.maxItems);
      if (Object.prototype.hasOwnProperty.call(descriptors, 'id') || descriptors.method?.value !== 'notifications/cancelled') return undefined;
      const params = descriptors.params?.value;
      if (!plainObject(params)) return undefined;
      const requestId = ownDescriptors(params, limits.maxItems).requestId?.value;
      if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(requestId)) return requestId;
      if (typeof requestId === 'number' && Number.isFinite(requestId) && Math.abs(requestId) <= Number.MAX_SAFE_INTEGER) return requestId;
      return undefined;
    } catch { return undefined; }
  };

  const enqueue = (message) => {
    if (state.closed) return;
    const cancellationId = cancellationRequestId(message);
    if (cancellationId !== undefined) {
      // Cancellation notifications are lifecycle control messages. Validate
      // and route them immediately so a saturated work queue cannot starve the
      // abort path. They consume no response sequence and never reply.
      void handleMcpMessage(message, context).catch((error) => writeDiagnostic(error));
      return;
    }
    if (queue.length + processCount >= limits.maxQueuedMessages) {
      if (!notificationCandidate(message, limits.maxItems)) enqueueOutput(jsonRpcError(safeId(message, limits.maxItems), -32600, 'server busy'));
      return;
    }
    queue.push({ message, sequence: sequence++ });
    void startQueued();
  };

  const onData = (chunk) => { try { decoder.write(chunk); } catch (error) { writeDiagnostic(error); close(); } };
  const onEnd = () => { inputEnded = true; try { decoder.end(); } catch (error) { writeDiagnostic(error); } if (processCount === 0 && queue.length === 0) maybeCloseAfterDrain(); else if (!shutdownTimer) shutdownTimer = setTimeout(() => close(), 250); };
  const onInputError = (error) => { writeDiagnostic(Object.assign(new Error(), { code: 'ERR_INPUT', cause: error })); close(); };
  const onOutputError = (error) => { writeDiagnostic(Object.assign(new Error(), { code: 'ERR_OUTPUT', cause: error })); close(); };

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    context.closed = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    for (const call of context.inFlight.values()) call.controller.abort();
    queue = [];
    pendingResponses.clear();
    outputQueue = [];
    outputBytes = 0;
    try { input.pause?.(); } catch { /* best effort */ }
    try { decoder?.end(); } catch { /* best effort */ }
    if (typeof input?.off === 'function') { input.off('data', onData); input.off('end', onEnd); input.off('close', onEnd); input.off('error', onInputError); }
    if (typeof output?.off === 'function') output.off('error', onOutputError);
    if (resolveRun) { const resolve = resolveRun; resolveRun = undefined; resolve(); }
  };

  const start = () => {
    if (started || state.closed) return server;
    started = true;
    decoder = createLineDecoder({ maxBytes: limits.maxMessageBytes, validate: false, onMessage: enqueue, onError: (error) => error.transport ? writeDiagnostic(error) : enqueueOutput(jsonRpcError(null, error.code, error.message)), onEnd });
    if (typeof input?.on === 'function') { input.on('data', onData); input.once?.('end', onEnd); input.once?.('close', onEnd); input.once?.('error', onInputError); }
    output.once?.('error', onOutputError);
    if (options.signal?.aborted) close();
    else options.signal?.addEventListener?.('abort', close, { once: true });
    if (input?.readableEnded) onEnd();
    return server;
  };
  const run = () => {
    start();
    if (!runPromise) runPromise = new Promise((resolve) => { resolveRun = resolve; if (state.closed) { resolveRun = undefined; resolve(); } });
    return runPromise;
  };
  const server = { context, start, run, close, handleMcpMessage: (message) => handleMcpMessage(message, context) };
  return Object.freeze(server);
}
