/** Bounded, dependency-free JSON-RPC line framing for MCP stdio. */

export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_MESSAGE_BYTES_HARD = 64 * 1024;
export const MAX_METHOD_LENGTH = 128;
export const MAX_ID_LENGTH = 128;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const REQUEST_KEYS = new Set(['jsonrpc', 'id', 'method', 'params']);

/** Stable public protocol/transport error with bounded diagnostics. */
export class McpError extends Error {
  constructor(code, message, data, { transport = false } = {}) {
    super(String(message).slice(0, 160));
    this.name = 'McpError';
    this.code = Number.isInteger(code) ? code : -32603;
    this.transport = transport === true;
    if (data !== undefined) this.data = data;
  }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function validId(value) {
  if (typeof value === 'string') return value.length > 0 && value.length <= MAX_ID_LENGTH && !CONTROL_CHARS.test(value);
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function validMethod(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_METHOD_LENGTH && !CONTROL_CHARS.test(value);
}

/** Parse JSON only, retaining an object for server-side notification routing. */
export function parseRawJsonLine(line, { maxBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  if (typeof line !== 'string' || !Number.isInteger(maxBytes) || maxBytes < 1) throw new McpError(-32700, 'parse error');
  if (Buffer.byteLength(line, 'utf8') > maxBytes) throw new McpError(-32600, 'message too large', undefined, { transport: true });
  try {
    return JSON.parse(line);
  } catch {
    throw new McpError(-32700, 'parse error');
  }
}

/** Parse and strictly validate one request/notification for direct callers. */
export function parseJsonRpcLine(line, { maxBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  const value = parseRawJsonLine(line, { maxBytes });
  if (!plainObject(value) || value.jsonrpc !== '2.0' || !validMethod(value.method)) throw new McpError(-32600, 'invalid request');
  if (Object.prototype.hasOwnProperty.call(value, 'id') && !validId(value.id)) throw new McpError(-32600, 'invalid request');
  if (Object.prototype.hasOwnProperty.call(value, 'params')) {
    if (value.params === null || typeof value.params !== 'object' || (!plainObject(value.params) && !Array.isArray(value.params))) {
      throw new McpError(-32600, 'invalid request');
    }
  }
  if (Object.keys(value).some((key) => !REQUEST_KEYS.has(key))) throw new McpError(-32600, 'invalid request');
  return value;
}

function callError(onError, error) {
  if (typeof onError !== 'function') return;
  try { onError(error instanceof McpError ? error : new McpError(-32700, 'parse error')); } catch { /* diagnostics are best effort */ }
}

/**
 * Decode bounded newline-delimited UTF-8. By default lines are strictly
 * validated for backwards compatibility; the MCP server sets validate:false
 * so it can distinguish a malformed notification from a parseable request
 * object that carries no id.
 */
export function createLineDecoder({
  maxBytes = DEFAULT_MAX_MESSAGE_BYTES,
  onMessage,
  onError,
  onEnd,
  validate = true,
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MESSAGE_BYTES_HARD) throw new RangeError('maxBytes is outside the bounded range');
  if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function');
  let decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  let bufferedBytes = 0;
  let discarding = false;
  let ended = false;

  const reset = () => { buffered = ''; bufferedBytes = 0; discarding = false; };
  const discard = (error) => { buffered = ''; bufferedBytes = 0; discarding = true; callError(onError, error); };
  const emit = () => {
    let line = buffered;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    buffered = '';
    bufferedBytes = 0;
    try {
      const message = validate ? parseJsonRpcLine(line, { maxBytes }) : parseRawJsonLine(line, { maxBytes });
      try { onMessage(message); } catch (error) { callError(onError, error); }
    } catch (error) { callError(onError, error); }
  };
  const consume = (text) => {
    let start = 0;
    while (start <= text.length) {
      const newline = text.indexOf('\n', start);
      const segment = newline < 0 ? text.slice(start) : text.slice(start, newline);
      const segmentBytes = Buffer.byteLength(segment, 'utf8');
      if (!discarding) {
        if (bufferedBytes + segmentBytes > maxBytes) discard(new McpError(-32600, 'message too large', undefined, { transport: true }));
        else { buffered += segment; bufferedBytes += segmentBytes; }
      }
      if (newline < 0) break;
      if (discarding) reset();
      else emit();
      start = newline + 1;
      if (start === text.length) break;
    }
  };
  const write = (chunk) => {
    if (ended) return false;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : null;
    if (!bytes) throw new TypeError('chunk must be a string, Buffer, or Uint8Array');
    let text;
    try { text = decoder.decode(bytes, { stream: true }); }
    catch {
      decoder = new TextDecoder('utf-8', { fatal: true });
      reset();
      callError(onError, new McpError(-32700, 'invalid UTF-8', undefined, { transport: true }));
      const newline = bytes.lastIndexOf(0x0a);
      if (newline >= 0 && newline + 1 < bytes.length) {
        try { consume(decoder.decode(bytes.subarray(newline + 1), { stream: true })); }
        catch { decoder = new TextDecoder('utf-8', { fatal: true }); reset(); callError(onError, new McpError(-32700, 'invalid UTF-8', undefined, { transport: true })); }
      }
      return false;
    }
    consume(text);
    return true;
  };
  const end = () => {
    if (ended) return;
    ended = true;
    try {
      const text = decoder.decode();
      if (text) consume(text);
    } catch {
      reset();
      callError(onError, new McpError(-32700, 'incomplete UTF-8', undefined, { transport: true }));
    }
    reset();
    try { onEnd?.(); } catch { /* lifecycle callbacks are best effort */ }
  };
  write.write = write;
  write.push = write;
  write.end = end;
  write.flush = end;
  return Object.freeze(write);
}

export function jsonRpcError(id, code, message, data) {
  const response = { jsonrpc: '2.0', id: id ?? null, error: { code, message: String(message).slice(0, 160) } };
  if (data !== undefined) response.error.data = data;
  return response;
}

export function isJsonRpcNotification(message) {
  try { return plainObject(message) && !Object.prototype.hasOwnProperty.call(message, 'id'); }
  catch { return false; }
}
