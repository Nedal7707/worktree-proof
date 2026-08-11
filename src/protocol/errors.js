import { types as utilTypes } from 'node:util';

const PUBLIC_MESSAGES = Object.freeze({
  ERR_PROTOCOL: 'protocol operation failed',
  ERR_INVALID_REQUEST: 'invalid protocol request',
  ERR_INVALID_ENVELOPE: 'invalid protocol envelope',
  ERR_PROTOCOL_VERSION: 'unsupported protocol version',
  ERR_INVALID_REQUEST_ID: 'invalid request id',
  ERR_INVALID_COMMAND: 'invalid command',
  ERR_INVALID_CAPABILITY: 'invalid capability',
  ERR_UNSUPPORTED_CAPABILITY: 'unsupported capability',
  ERR_MESSAGE_TOO_LARGE: 'protocol message exceeds maximum size',
  ERR_BATCH_TOO_LARGE: 'protocol batch exceeds maximum item count',
  ERR_INVALID_WARNING: 'invalid protocol warning',
  ERR_INVALID_RESULT: 'invalid protocol result',
});

const PUBLIC_CODE = /^ERR_[A-Z0-9_]{1,64}$/;

/**
 * Error with a stable, public code. The message is always selected from a
 * bounded allow-list so stack traces, paths, credentials, and private
 * metadata cannot cross the protocol boundary.
 */
export class ProtocolError extends TypeError {
  constructor(message = undefined, code = 'ERR_PROTOCOL') {
    const normalizedCode = normalizeErrorCode(code);
    super(PUBLIC_MESSAGES[normalizedCode] ?? PUBLIC_MESSAGES.ERR_PROTOCOL);
    this.name = 'ProtocolError';
    this.code = normalizedCode;
  }
}

export function normalizeErrorCode(code) {
  if (typeof code === 'string' && PUBLIC_CODE.test(code)) return code;
  return 'ERR_PROTOCOL';
}

/**
 * Convert arbitrary failures into the only error shape that is public on the
 * wire. Unknown failures intentionally collapse to ERR_PROTOCOL.
 */
export function normalizePublicError(error) {
  let candidate;
  if (error && typeof error === 'object' && !utilTypes.isProxy(error)) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      candidate = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch {
      candidate = undefined;
    }
  }
  const code = normalizeErrorCode(candidate);
  return Object.freeze({
    code,
    message: PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES.ERR_PROTOCOL,
  });
}

export function publicErrorMessage(code) {
  const normalizedCode = normalizeErrorCode(code);
  return PUBLIC_MESSAGES[normalizedCode] ?? PUBLIC_MESSAGES.ERR_PROTOCOL;
}

export const PUBLIC_ERROR_CODES = Object.freeze(Object.keys(PUBLIC_MESSAGES));
