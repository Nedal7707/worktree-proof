/**
 * Bounded JSON-RPC newline framing for the optional MCP stdio transport.
 *
 * This module intentionally knows nothing about WorktreeProof state or I/O
 * side effects. It only decodes complete UTF-8 lines and validates the public
 * JSON-RPC request shape.
 */

export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_METHOD_LENGTH = 128;
export const MAX_ID_LENGTH = 128;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** A stable, public protocol error with no unbounded diagnostic payload. */
export class McpError extends Error {
  constructor(code, message, data) {
    super(String(message).slice(0, 160));
    this.name = 'McpError';
    this.code = Number.isInteger(code) ? code : -32603;
    if (data !== undefined) this.data = data;
  }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validId(value) {
  if (typeof value === 'string') {
    return value.length > 0 && value.length <= MAX_ID_LENGTH && !CONTROL_CHARS.test(value);
  }
  // JSON-RPC permits numbers, but not null, NaN, Infinity, or values that
  // cannot be represented deterministically by JSON.stringify.
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function validMethod(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_METHOD_LENGTH
    && !CONTROL_CHARS.test(value);
}

/**
 * Parse and validate one newline-delimited JSON-RPC request or notification.
 * Responses, batches, and extension envelopes are intentionally rejected.
 */
export function parseJsonRpcLine(line, { maxBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  if (typeof line !== 'string') throw new McpError(-32700, 'parse error');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new McpError(-32600, 'invalid request');
  if (Buffer.byteLength(line, 'utf8') > maxBytes) throw new McpError(-32600, 'message too large');

  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new McpError(-32700, 'parse error');
  }
  if (!plainObject(value) || value.jsonrpc !== '2.0' || !validMethod(value.method)) {
    throw new McpError(-32600, 'invalid request');
  }

  if (Object.prototype.hasOwnProperty.call(value, 'id') && !validId(value.id)) {
    throw new McpError(-32600, 'invalid request');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'params')) {
    const params = value.params;
    if (params === null || (typeof params !== 'object') || (!plainObject(params) && !Array.isArray(params))) {
      throw new McpError(-32600, 'invalid request');
    }
  }
  const allowed = new Set(['jsonrpc', 'id', 'method', 'params']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new McpError(-32600, 'invalid request');
  }
  return value;
}

function callError(onError, error) {
  if (typeof onError !== 'function') return;
  try {
    onError(error instanceof McpError ? error : new McpError(-32700, 'parse error'));
  } catch {
    // A diagnostic callback must never break the input stream.
  }
}

/**
 * Create a bounded decoder. `write` accepts strings, Buffers, and Uint8Arrays;
 * `end` discards an incomplete trailing line and flushes UTF-8 state. An
 * oversize or malformed line is reported once and discarded through its next
 * newline so later valid messages remain processable.
 */
export function createLineDecoder({
  maxBytes = DEFAULT_MAX_MESSAGE_BYTES,
  onMessage,
  onError,
  onEnd,
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');
  if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function');

  let decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  let bufferedBytes = 0;
  let discarding = false;
  let ended = false;

  const resetLine = () => {
    buffered = '';
    bufferedBytes = 0;
    discarding = false;
  };

  const discardLine = (error) => {
    buffered = '';
    bufferedBytes = 0;
    discarding = true;
    callError(onError, error);
  };

  const emitLine = () => {
    let line = buffered;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    buffered = '';
    bufferedBytes = 0;
    try {
      const message = parseJsonRpcLine(line, { maxBytes });
      try {
        onMessage(message);
      } catch (error) {
        callError(onError, error);
      }
    } catch (error) {
      callError(onError, error);
    }
  };

  const consumeText = (text) => {
    let start = 0;
    while (start <= text.length) {
      const newline = text.indexOf('\n', start);
      const segment = newline < 0 ? text.slice(start) : text.slice(start, newline);
      const segmentBytes = Buffer.byteLength(segment, 'utf8');

      if (!discarding) {
        if (bufferedBytes + segmentBytes > maxBytes) {
          discardLine(new McpError(-32600, 'message too large'));
        } else {
          buffered += segment;
          bufferedBytes += segmentBytes;
        }
      }

      if (newline < 0) break;
      if (discarding) {
        resetLine();
      } else {
        emitLine();
      }
      start = newline + 1;
      if (start === text.length) break;
    }
  };

  const write = (chunk) => {
    if (ended) return false;
    let bytes;
    if (typeof chunk === 'string') bytes = Buffer.from(chunk, 'utf8');
    else if (Buffer.isBuffer(chunk)) bytes = chunk;
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
    else throw new TypeError('chunk must be a string, Buffer, or Uint8Array');

    let text;
    try {
      text = decoder.decode(bytes, { stream: true });
    } catch {
      decoder = new TextDecoder('utf-8', { fatal: true });
      // A fatal decoder has consumed an unknown number of bytes. Drop this
      // malformed line and restart at the next line. If this chunk also
      // carries complete lines after a newline, retain only that safe suffix.
      resetLine();
      callError(onError, new McpError(-32700, 'invalid UTF-8'));
      const newline = bytes.lastIndexOf(0x0a);
      if (newline >= 0 && newline + 1 < bytes.length) {
        try {
          text = decoder.decode(bytes.subarray(newline + 1), { stream: true });
          consumeText(text);
        } catch {
          decoder = new TextDecoder('utf-8', { fatal: true });
          resetLine();
          callError(onError, new McpError(-32700, 'invalid UTF-8'));
        }
      }
      return false;
    }
    consumeText(text);
    return true;
  };

  const end = () => {
    if (ended) return;
    ended = true;
    try {
      const text = decoder.decode();
      if (text) consumeText(text);
    } catch {
      callError(onError, new McpError(-32700, 'invalid UTF-8'));
    }
    // A partial trailing request cannot be safely associated with an id. It is
    // intentionally discarded and the transport may close cleanly.
    buffered = '';
    bufferedBytes = 0;
    if (typeof onEnd === 'function') {
      try { onEnd(); } catch { /* lifecycle callbacks are best effort */ }
    }
  };

  // The callable shape mirrors the small helper in the implementation plan,
  // while named methods make stream integrations and tests self-documenting.
  write.write = write;
  write.push = write;
  write.end = end;
  write.flush = end;
  return Object.freeze(write);
}

export function jsonRpcError(id, code, message, data) {
  const response = { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  if (data !== undefined) response.error.data = data;
  return response;
}

export function isJsonRpcNotification(message) {
  return plainObject(message) && !Object.prototype.hasOwnProperty.call(message, 'id');
}
