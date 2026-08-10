import {
  McpError,
  createLineDecoder,
  isJsonRpcNotification,
  jsonRpcError,
} from './framing.js';
import {
  DEFAULT_TOOL_LIMITS,
  McpToolError,
  createMcpToolRegistry,
} from './tools.js';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SERVER_INFO = Object.freeze({ name: 'worktree-proof', version: '0.1.0' });
export const DEFAULT_MCP_LIMITS = Object.freeze({
  maxMessageBytes: 16 * 1024,
  maxInputBytes: 16 * 1024,
  maxOutputBytes: 16 * 1024,
  maxQueuedMessages: 64,
  maxStringBytes: DEFAULT_TOOL_LIMITS.maxStringBytes,
  maxDepth: DEFAULT_TOOL_LIMITS.maxDepth,
  maxItems: DEFAULT_TOOL_LIMITS.maxItems,
});

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasId(message) {
  return plainObject(message) && Object.prototype.hasOwnProperty.call(message, 'id');
}

function idValue(message) {
  return hasId(message) ? message.id : null;
}

function validRequest(message) {
  if (!plainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method || message.method.length > 128) return false;
  if (hasId(message)) {
    if (message.id === null) return false;
    if (typeof message.id === 'string') {
      if (!message.id || message.id.length > 128 || /[\u0000-\u001f\u007f]/u.test(message.id)) return false;
    } else if (typeof message.id === 'number') {
      if (!Number.isFinite(message.id) || Math.abs(message.id) > Number.MAX_SAFE_INTEGER) return false;
    } else return false;
  }
  if (Object.prototype.hasOwnProperty.call(message, 'params') && (message.params === null || typeof message.params !== 'object')) return false;
  return true;
}

function errorFor(error) {
  if (error instanceof McpError) return error;
  if (error instanceof McpToolError) {
    if (error.code === 'ERR_TOOL_NOT_FOUND') return new McpError(-32601, 'method not found');
    if (error.code === 'ERR_INVALID_PARAMS' || error.code === 'ERR_CONFIRM_REQUIRED') return new McpError(-32602, 'invalid params');
    if (error.code === 'ERR_CANCELLED') return new McpError(-32800, 'request cancelled');
    return new McpError(-32603, 'internal error');
  }
  return new McpError(-32603, 'internal error');
}

function responseOrNull(message, response) {
  return isJsonRpcNotification(message) ? null : response;
}

function contextFrom(value = {}) {
  const source = value?.context ?? value;
  if (source && source.__mcpContext === true) return source;
  const limits = { ...DEFAULT_MCP_LIMITS, ...(source?.limits ?? {}) };
  const context = {
    __mcpContext: true,
    core: source?.core ?? {},
    limits,
    enableLeaseMutation: source?.enableLeaseMutation === true || source?.allowLeaseMutation === true,
    signal: source?.signal,
    state: source?.state ?? { initialized: false, initializedNotification: false, closed: false },
  };
  context.tools = source?.tools?.call && source?.tools?.list
    ? source.tools
    : createMcpToolRegistry({ core: context.core, limits, enableLeaseMutation: context.enableLeaseMutation });
  return context;
}

/**
 * Handle one already-decoded JSON-RPC message. Notifications execute through
 * the same validation path but intentionally return no response.
 */
export async function handleMcpMessage(message, context = {}) {
  const ctx = contextFrom(context);
  const notification = isJsonRpcNotification(message);
  const id = idValue(message);
  if (!validRequest(message)) return responseOrNull(message, jsonRpcError(id, -32600, 'invalid request'));

  const method = message.method;
  const params = message.params;

  if (method === 'initialize') {
    if (!plainObject(params)
      || params.protocolVersion !== MCP_PROTOCOL_VERSION
      || !plainObject(params.capabilities)
      || !plainObject(params.clientInfo)
      || typeof params.clientInfo.name !== 'string'
      || typeof params.clientInfo.version !== 'string') {
      return responseOrNull(message, jsonRpcError(id, -32602, 'invalid params'));
    }
    ctx.state.initialized = true;
    return responseOrNull(message, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...MCP_SERVER_INFO },
      },
    });
  }

  if (method === 'notifications/initialized') {
    ctx.state.initializedNotification = true;
    return null;
  }

  if (!ctx.state.initialized) return responseOrNull(message, jsonRpcError(id, -32002, 'server not initialized'));
  if (ctx.signal?.aborted) return responseOrNull(message, jsonRpcError(id, -32800, 'request cancelled'));

  if (method === 'tools/list') {
    if (params !== undefined && !plainObject(params)) return responseOrNull(message, jsonRpcError(id, -32602, 'invalid params'));
    return responseOrNull(message, { jsonrpc: '2.0', id, result: { tools: ctx.tools.list() } });
  }

  if (method === 'tools/call') {
    if (!plainObject(params) || typeof params.name !== 'string' || !params.name || (params.arguments !== undefined && !plainObject(params.arguments))) {
      return responseOrNull(message, jsonRpcError(id, -32602, 'invalid params'));
    }
    try {
      const result = await ctx.tools.call(params.name, params.arguments ?? {}, ctx);
      return responseOrNull(message, { jsonrpc: '2.0', id, result });
    } catch (error) {
      const mapped = errorFor(error);
      return responseOrNull(message, jsonRpcError(id, mapped.code, mapped.message));
    }
  }

  return responseOrNull(message, jsonRpcError(id, -32601, 'method not found'));
}

function fixedDiagnostic(error) {
  if (error?.code === 'ERR_INPUT') return 'mcp input closed';
  if (error?.code === 'ERR_OUTPUT') return 'mcp output closed';
  return 'mcp transport error';
}

/** Create one bounded stdio server. Construction performs no I/O. */
export function createMcpServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostic = options.error ?? process.stderr;
  const limits = { ...DEFAULT_MCP_LIMITS, ...(options.limits ?? {}) };
  const state = { initialized: false, initializedNotification: false, closed: false };
  const context = contextFrom({
    core: options.core,
    limits,
    signal: options.signal,
    state,
    enableLeaseMutation: options.enableLeaseMutation === true || options.allowLeaseMutation === true,
  });

  let started = false;
  let inputEnded = false;
  let processing = false;
  let queue = [];
  let resolveRun;
  let runPromise;

  const safeError = (error) => {
    if (!diagnostic || typeof diagnostic.write !== 'function') return;
    try {
      diagnostic.write(`${fixedDiagnostic(error)}\n`);
    } catch {
      // stderr is best effort and must never crash protocol handling.
    }
  };

  const writeResponse = (response) => {
    if (!response || state.closed || !output || typeof output.write !== 'function') return;
    let line;
    try { line = JSON.stringify(response); } catch { line = JSON.stringify(jsonRpcError(response.id, -32603, 'internal error')); }
    const encoded = `${line}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > limits.maxOutputBytes) {
      line = JSON.stringify(jsonRpcError(response.id, -32603, 'response too large'));
    }
    const bounded = `${line}\n`;
    if (Buffer.byteLength(bounded, 'utf8') > limits.maxOutputBytes) return;
    try {
      output.write(bounded);
    } catch (error) {
      safeError(Object.assign(new Error(), { code: 'ERR_OUTPUT', cause: error }));
      close();
    }
  };

  const drain = async () => {
    if (processing) return;
    processing = true;
    try {
      while (!state.closed && queue.length > 0) {
        const message = queue.shift();
        try {
          const response = await handleMcpMessage(message, context);
          if (response) writeResponse(response);
        } catch {
          if (!isJsonRpcNotification(message)) writeResponse(jsonRpcError(idValue(message), -32603, 'internal error'));
        }
      }
    } finally {
      processing = false;
      if (inputEnded && queue.length === 0 && resolveRun) {
        const resolve = resolveRun;
        resolveRun = undefined;
        resolve();
      }
    }
  };

  let decoder;
  const enqueue = (message) => {
    if (state.closed) return;
    if (queue.length >= limits.maxQueuedMessages) {
      if (!isJsonRpcNotification(message)) writeResponse(jsonRpcError(idValue(message), -32600, 'server busy'));
      return;
    }
    queue.push(message);
    void drain();
  };

  const onData = (chunk) => {
    try { decoder.write(chunk); } catch (error) { safeError(error); close(); }
  };
  const onEnd = () => {
    inputEnded = true;
    if (!processing && queue.length === 0 && resolveRun) {
      const resolve = resolveRun;
      resolveRun = undefined;
      resolve();
    }
  };
  const onInputError = (error) => { safeError(error); close(); };
  const onOutputError = (error) => { safeError(Object.assign(new Error(), { code: 'ERR_OUTPUT', cause: error })); close(); };

  const start = () => {
    if (started || state.closed) return server;
    started = true;
    decoder = createLineDecoder({ maxBytes: limits.maxMessageBytes, onMessage: enqueue, onError: (error) => writeResponse(jsonRpcError(null, error.code, error.message)), onEnd });
    if (typeof input?.on === 'function') {
      input.on('data', onData);
      input.once?.('end', onEnd);
      input.once?.('close', onEnd);
      input.once?.('error', onInputError);
    }
    if (typeof output?.once === 'function') output.once('error', onOutputError);
    if (options.signal?.aborted) close();
    else if (options.signal?.addEventListener) options.signal.addEventListener('abort', close, { once: true });
    return server;
  };

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    queue = [];
    try { decoder?.end(); } catch { /* closed input */ }
    if (typeof input?.off === 'function') {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.off('error', onInputError);
    }
    if (typeof output?.off === 'function') output.off('error', onOutputError);
    if (resolveRun) {
      const resolve = resolveRun;
      resolveRun = undefined;
      resolve();
    }
  };

  const run = () => {
    start();
    if (!runPromise) {
      runPromise = new Promise((resolve) => {
        resolveRun = resolve;
        if (inputEnded || state.closed) {
          resolveRun = undefined;
          resolve();
        }
      });
    }
    return runPromise;
  };

  const server = {
    context,
    start,
    run,
    close,
    handleMcpMessage: (message) => handleMcpMessage(message, context),
  };
  return Object.freeze(server);
}
