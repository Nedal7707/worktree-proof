/**
 * Stable WorktreeProof protocol identifiers and transport limits.
 *
 * These values are deliberately data-only. Importing the protocol package must
 * never inspect the environment, filesystem, network, process, or a client
 * runtime.
 */

export const PROTOCOL = 'worktreeproof';
export const PROTOCOL_VERSION = '1.0';
export const SCHEMA_VERSION = '1';

export const MAX_MESSAGE_BYTES = 16_384;
export const MAX_BATCH_ITEMS = 100;

export const PROTOCOL_LIMITS = Object.freeze({
  maxMessageBytes: MAX_MESSAGE_BYTES,
  maxBatchItems: MAX_BATCH_ITEMS,
});

// A missing request id is represented by a deterministic value rather than a
// timestamp or random UUID. Callers that need correlation should provide an
// explicit safe id.
export const DEFAULT_REQUEST_ID = 'req-0';
