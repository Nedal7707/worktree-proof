/**
 * Explicit, local Codex/Claude handoff messages.
 *
 * This is a file-backed protocol, not a relay: WorktreeProof never launches an
 * assistant, polls a service, shares credentials, or executes a message.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeFileScope, normalizeLaneId } from './scope.js';
import { releaseLease, reserveLease } from './leases.js';

export const BRIDGE_MESSAGE_TYPES = Object.freeze(['task', 'status', 'result', 'question', 'cancel']);
export const BRIDGE_STATUSES = Object.freeze(['pending', 'claimed', 'completed', 'failed', 'cancelled']);
export const BRIDGE_MAX_MESSAGE_BYTES = 16 * 1024;
export const BRIDGE_MAX_MESSAGES = 1000;
export const BRIDGE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const BRIDGE_DEFAULT_CLAIM_MS = 30 * 60 * 1000;
export const BRIDGE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BRIDGE_MAX_CLAIM_MS = 24 * 60 * 60 * 1000;

const AGENT_ID = /^[a-z][a-z0-9._-]{0,31}$/u;
const MESSAGE_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SECRET = /(?:bearer\s+|-----BEGIN [^-]+ PRIVATE KEY-----|(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|auth|cookie|credential)\s*[:=]|\b(?:sk|gh[pousr]|xox[baprs])[-_][a-z0-9-]{12,})/iu;
const COMMAND_OR_NETWORK = /(?:https?:\/\/|\b(?:curl|wget|Invoke-WebRequest|powershell|pwsh|cmd(?:\.exe)?|node\s+-e|python\s+-c)\b|[;&|`]|\$\()/iu;

export class BridgeValidationError extends TypeError {
  constructor(message, code = 'ERR_INVALID_BRIDGE_MESSAGE') {
    super(message);
    this.name = 'BridgeValidationError';
    this.code = code;
  }
}

export class BridgeError extends Error {
  constructor(message, code = 'ERR_BRIDGE') {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function bridgeRoot(value) {
  const root = value?.bridgeRoot ?? value?.stateDir ?? value?.root ?? value;
  return path.resolve(typeof root === 'string' && root.trim() ? root : path.join(process.cwd(), '.worktree-proof', 'bridge'));
}

function requireSafeText(value, field, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new BridgeValidationError(`${field} must be a non-empty trimmed string`, 'ERR_INVALID_BRIDGE_FIELD');
  }
  if (value.length > max || CONTROL.test(value) || SECRET.test(value) || COMMAND_OR_NETWORK.test(value)) {
    throw new BridgeValidationError(`${field} contains unsafe content`, 'ERR_UNSAFE_BRIDGE_CONTENT');
  }
  return value;
}

export function normalizeAgentId(value, field = 'agent') {
  if (typeof value !== 'string') throw new BridgeValidationError(`${field} must be a string`, 'ERR_INVALID_AGENT_ID');
  const normalized = value.trim().toLowerCase();
  if (!AGENT_ID.test(normalized)) throw new BridgeValidationError(`${field} is not a safe agent identifier`, 'ERR_INVALID_AGENT_ID');
  return normalized;
}

function normalizeMessageId(value) {
  if (typeof value !== 'string' || !MESSAGE_ID.test(value)) throw new BridgeValidationError('messageId is invalid', 'ERR_INVALID_MESSAGE_ID');
  return value;
}

function normalizeTimestamp(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new BridgeValidationError(`${field} must be an ISO timestamp`, 'ERR_INVALID_BRIDGE_TIME');
  return new Date(parsed).toISOString();
}

function boundedDuration(value, fallback, field, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new BridgeValidationError(`${field} must be a positive integer no greater than ${maximum}`, 'ERR_INVALID_BRIDGE_TIME');
  }
  return number;
}

function normalizeCapabilities(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new BridgeValidationError('capabilities must be a bounded array', 'ERR_INVALID_BRIDGE_FIELD');
  return [...new Set(value.map((item) => {
    if (typeof item !== 'string' || !TOKEN.test(item.trim().toLowerCase())) throw new BridgeValidationError('capability is invalid', 'ERR_INVALID_BRIDGE_FIELD');
    return item.trim().toLowerCase();
  }))].sort();
}

function normalizeRelativeRef(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw new BridgeValidationError(`${field} must be a relative path`, 'ERR_INVALID_BRIDGE_PATH');
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new BridgeValidationError(`${field} contains traversal`, 'ERR_INVALID_BRIDGE_PATH');
  }
  return normalized;
}

function normalizeResult(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeValidationError('result must be an object', 'ERR_INVALID_BRIDGE_RESULT');
  const keys = Object.keys(value);
  if (keys.some((key) => !['summary', 'evidence', 'receiptRef'].includes(key))) throw new BridgeValidationError('result contains unsupported fields', 'ERR_INVALID_BRIDGE_RESULT');
  const result = {};
  if (value.summary !== undefined) result.summary = requireSafeText(value.summary, 'result.summary', 2000);
  if (value.evidence !== undefined) {
    if (!Array.isArray(value.evidence) || value.evidence.length > 32) throw new BridgeValidationError('result.evidence must be bounded', 'ERR_INVALID_BRIDGE_RESULT');
    result.evidence = value.evidence.map((item) => requireSafeText(item, 'result.evidence', 500));
  }
  if (value.receiptRef !== undefined) result.receiptRef = normalizeRelativeRef(value.receiptRef, 'result.receiptRef');
  return result;
}

/** Validate and normalize a message without mutating the caller's object. */
export function validateBridgeMessage(input, { allowLifecycle = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeValidationError('message must be an object');
  const allowed = new Set(['messageId', 'sender', 'recipient', 'type', 'summary', 'laneId', 'fileScope', 'capabilities', 'replyTo', 'createdAt', 'expiresAt', 'status', 'claimedBy', 'claimedAt', 'completedAt', 'result', 'ackAt', 'idempotencyKey', 'reclaimedFrom']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new BridgeValidationError('message contains unsupported fields', 'ERR_UNSAFE_BRIDGE_CONTENT');
  const type = requireSafeText(input.type, 'type', 32).toLowerCase();
  if (!BRIDGE_MESSAGE_TYPES.includes(type)) throw new BridgeValidationError(`unknown message type: ${type}`, 'ERR_INVALID_BRIDGE_TYPE');
  const message = {
    messageId: normalizeMessageId(input.messageId),
    sender: normalizeAgentId(input.sender, 'sender'),
    recipient: normalizeAgentId(input.recipient, 'recipient'),
    type,
    summary: requireSafeText(input.summary, 'summary'),
    capabilities: normalizeCapabilities(input.capabilities),
    createdAt: normalizeTimestamp(input.createdAt, 'createdAt'),
    expiresAt: normalizeTimestamp(input.expiresAt, 'expiresAt'),
  };
  if (Date.parse(message.expiresAt) <= Date.parse(message.createdAt)) throw new BridgeValidationError('expiresAt must be after createdAt', 'ERR_INVALID_BRIDGE_TIME');
  if (input.laneId !== undefined) message.laneId = normalizeLaneId(input.laneId);
  if (input.fileScope !== undefined) message.fileScope = normalizeFileScope(input.fileScope);
  if (type === 'task' && !message.fileScope) throw new BridgeValidationError('task messages require fileScope', 'ERR_TASK_SCOPE_REQUIRED');
  if (input.replyTo !== undefined) message.replyTo = normalizeMessageId(input.replyTo);
  if (input.idempotencyKey !== undefined) message.idempotencyKey = requireSafeText(input.idempotencyKey, 'idempotencyKey', 128);
  if (input.status !== undefined) {
    if (!allowLifecycle || !BRIDGE_STATUSES.includes(input.status)) throw new BridgeValidationError('invalid message status', 'ERR_INVALID_BRIDGE_STATUS');
    message.status = input.status;
  } else message.status = 'pending';
  if (input.claimedBy !== undefined) message.claimedBy = normalizeAgentId(input.claimedBy, 'claimedBy');
  if (input.claimedAt !== undefined) message.claimedAt = normalizeTimestamp(input.claimedAt, 'claimedAt');
  if (input.completedAt !== undefined) message.completedAt = normalizeTimestamp(input.completedAt, 'completedAt');
  if (input.ackAt !== undefined) message.ackAt = normalizeTimestamp(input.ackAt, 'ackAt');
  if (input.result !== undefined) message.result = normalizeResult(input.result);
  if (input.reclaimedFrom !== undefined) message.reclaimedFrom = normalizeAgentId(input.reclaimedFrom, 'reclaimedFrom');
  if (message.status === 'claimed' && !message.claimedBy) throw new BridgeValidationError('claimed messages require claimedBy', 'ERR_INVALID_BRIDGE_STATUS');
  if (['completed', 'failed', 'cancelled'].includes(message.status) && !message.completedAt) throw new BridgeValidationError('terminal messages require completedAt', 'ERR_INVALID_BRIDGE_STATUS');
  return message;
}

async function withBridgeLock(root, operation, options = {}) {
  const lock = path.join(root, '.lock');
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 12;
  const delayMs = Number.isInteger(options.delayMs) && options.delayMs >= 0 ? options.delayMs : 15;
  const staleMs = Number.isInteger(options.staleMs) && options.staleMs > 0 ? options.staleMs : 30_000;
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await mkdir(lock);
      try {
        return await operation();
      } finally {
        await rm(lock, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > staleMs) await rm(lock, { recursive: true, force: true });
      } catch {
        // A concurrent owner may have released the lock; retry within bound.
      }
      if (attempt === attempts - 1) throw new BridgeError('bridge lock is busy', 'ERR_BRIDGE_LOCK');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new BridgeError('bridge lock is busy', 'ERR_BRIDGE_LOCK');
}

async function messageFiles(root) {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /^msg-[a-z0-9._-]+\.json$/u.test(entry.name)).map((entry) => entry.name).sort();
}

async function readMessage(root, messageId) {
  const file = path.join(root, `msg-${normalizeMessageId(messageId)}.json`);
  try {
    return validateBridgeMessage(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new BridgeError('bridge message was not found', 'ERR_BRIDGE_NOT_FOUND');
    if (error instanceof BridgeValidationError) throw error;
    throw new BridgeError('bridge message is invalid', 'ERR_BRIDGE_CORRUPT');
  }
}

async function writeMessage(root, message) {
  const normalized = validateBridgeMessage(message);
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > BRIDGE_MAX_MESSAGE_BYTES) throw new BridgeValidationError('bridge message is too large', 'ERR_BRIDGE_MESSAGE_TOO_LARGE');
  const destination = path.join(root, `msg-${normalized.messageId}.json`);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new BridgeError(`unable to write bridge message: ${error.message}`, 'ERR_BRIDGE_WRITE');
  }
  return normalized;
}

function inputAndRoot(rootOrInput, maybeInput) {
  if (typeof rootOrInput === 'string') return { root: bridgeRoot(rootOrInput), input: maybeInput ?? {} };
  const source = rootOrInput ?? {};
  const { bridgeRoot: _bridgeRoot, stateDir: _stateDir, root: _root, ...input } = source;
  return { root: bridgeRoot(source), input };
}

/** Atomically enqueue one bounded, idempotent message. */
export async function sendBridgeMessage(rootOrInput, maybeInput) {
  const { root, input } = inputAndRoot(rootOrInput, maybeInput);
  const sender = normalizeAgentId(input.sender, 'sender');
  const recipient = normalizeAgentId(input.recipient, 'recipient');
  const now = new Date(input.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new BridgeValidationError('now is invalid', 'ERR_INVALID_BRIDGE_TIME');
  const createdAt = now.toISOString();
  const ttlMs = boundedDuration(input.ttlMs, BRIDGE_DEFAULT_TTL_MS, 'ttlMs', BRIDGE_MAX_TTL_MS);
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const idempotencyKey = input.idempotencyKey === undefined ? undefined : requireSafeText(input.idempotencyKey, 'idempotencyKey', 128);
  return withBridgeLock(root, async () => {
    const files = await messageFiles(root);
    for (const file of files) {
      const existing = await readMessage(root, file.slice(4, -5));
      if (idempotencyKey && existing.idempotencyKey === idempotencyKey && existing.sender === sender && existing.recipient === recipient) return existing;
    }
    if (files.length >= BRIDGE_MAX_MESSAGES) throw new BridgeError('bridge message limit reached', 'ERR_BRIDGE_CAPACITY');
    const { now: _now, ttlMs: _ttlMs, ...messageInput } = input;
    const message = validateBridgeMessage({
      ...messageInput,
      messageId: input.messageId ?? randomUUID().replaceAll('-', ''),
      sender,
      recipient,
      createdAt,
      expiresAt,
      status: 'pending',
      idempotencyKey,
    });
    return writeMessage(root, message);
  });
}

/** List messages in deterministic order; temporary/partial files are ignored. */
export async function listBridgeInbox(rootOrOptions, maybeOptions = {}) {
  const options = typeof rootOrOptions === 'string' ? maybeOptions : rootOrOptions ?? {};
  const root = bridgeRoot(rootOrOptions);
  const files = await messageFiles(root);
  const messages = [];
  for (const file of files) {
    // Temporary files are excluded by messageFiles. A committed malformed
    // message is a visible blocker rather than silently disappearing.
    messages.push(await readMessage(root, file.slice(4, -5)));
  }
  const recipient = options.recipient ? normalizeAgentId(options.recipient, 'recipient') : undefined;
  const status = options.status;
  return messages.filter((message) => (!recipient || message.recipient === recipient) && (!status || message.status === status))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId));
}

/** Claim a task, reserving its scope through the shared lease registry. */
export async function claimBridgeMessage(rootOrInput, maybeInput) {
  const { root, input } = inputAndRoot(rootOrInput, maybeInput);
  const receiver = normalizeAgentId(input.receiver ?? input.agent ?? input.sender, 'receiver');
  const messageId = normalizeMessageId(input.messageId);
  const claimMs = boundedDuration(input.claimMs, BRIDGE_DEFAULT_CLAIM_MS, 'claimMs', BRIDGE_MAX_CLAIM_MS);
  return withBridgeLock(root, async () => {
    let message = await readMessage(root, messageId);
    const now = new Date(input.now ?? Date.now());
    if (message.recipient !== receiver) throw new BridgeError('message recipient does not match claimant', 'ERR_BRIDGE_RECIPIENT');
    if (Date.parse(message.expiresAt) <= now.getTime()) throw new BridgeError('message is expired', 'ERR_BRIDGE_EXPIRED');
    if (message.status === 'claimed') {
      const staleAt = Date.parse(message.claimedAt ?? message.createdAt) + claimMs;
      if (staleAt > now.getTime()) throw new BridgeError('message is already claimed', 'ERR_BRIDGE_ALREADY_CLAIMED');
      message = { ...message, status: 'pending', claimedBy: undefined, claimedAt: undefined, reclaimedFrom: message.claimedBy };
    }
    if (message.status !== 'pending') throw new BridgeError('message is not claimable', 'ERR_BRIDGE_NOT_CLAIMABLE');
    if (message.fileScope) {
      const leasePath = path.join(path.dirname(root), 'leases.json');
      const laneId = message.laneId ?? `bridge-${message.messageId.slice(0, 20)}`;
      await reserveLease(leasePath, {
        laneId,
        fileScope: message.fileScope,
        owner: receiver,
        session: `bridge-${message.messageId.slice(0, 24)}`,
      }, { ttlMs: claimMs });
    }
    return writeMessage(root, { ...message, status: 'claimed', claimedBy: receiver, claimedAt: now.toISOString(), reclaimedFrom: message.reclaimedFrom });
  });
}

export async function ackBridgeMessage(rootOrInput, maybeInput) {
  const { root, input } = inputAndRoot(rootOrInput, maybeInput);
  const actor = normalizeAgentId(input.actor ?? input.sender, 'actor');
  return withBridgeLock(root, async () => {
    const message = await readMessage(root, input.messageId);
    if (![message.sender, message.recipient, message.claimedBy].filter(Boolean).includes(actor)) {
      throw new BridgeError('acknowledgement actor is not a participant', 'ERR_BRIDGE_FORBIDDEN');
    }
    return writeMessage(root, { ...message, ackAt: new Date(input.now ?? Date.now()).toISOString() });
  });
}

/** Complete, fail, or cancel a claimed message with bounded evidence only. */
export async function completeBridgeMessage(rootOrInput, maybeInput) {
  const { root, input } = inputAndRoot(rootOrInput, maybeInput);
  const actor = normalizeAgentId(input.actor ?? input.sender, 'actor');
  const status = input.status ?? 'completed';
  if (!['completed', 'failed', 'cancelled'].includes(status)) throw new BridgeValidationError('invalid terminal bridge status', 'ERR_INVALID_BRIDGE_STATUS');
  return withBridgeLock(root, async () => {
    const message = await readMessage(root, input.messageId);
    if (message.status !== 'claimed' || message.claimedBy !== actor) throw new BridgeError('only the current claimant may complete a message', 'ERR_BRIDGE_FORBIDDEN');
    const completed = await writeMessage(root, {
      ...message,
      status,
      completedAt: new Date(input.now ?? Date.now()).toISOString(),
      result: input.result,
    });
    if (message.fileScope) {
      const leasePath = path.join(path.dirname(root), 'leases.json');
      const laneId = message.laneId ?? `bridge-${message.messageId.slice(0, 20)}`;
      await releaseLease(leasePath, {
        laneId,
        owner: actor,
        session: `bridge-${message.messageId.slice(0, 24)}`,
        reason: `bridge ${status}`,
      }).catch((error) => {
        if (error?.code !== 'ERR_LEASE_NOT_FOUND') throw error;
      });
    }
    return completed;
  });
}

export const sendMessage = sendBridgeMessage;
export const inbox = listBridgeInbox;
export const claimMessage = claimBridgeMessage;
export const ackMessage = ackBridgeMessage;
export const completeMessage = completeBridgeMessage;

export default {
  BRIDGE_MESSAGE_TYPES,
  BRIDGE_STATUSES,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_MESSAGES,
  BRIDGE_DEFAULT_TTL_MS,
  BRIDGE_DEFAULT_CLAIM_MS,
  BRIDGE_MAX_TTL_MS,
  BRIDGE_MAX_CLAIM_MS,
  validateBridgeMessage,
  sendBridgeMessage,
  listBridgeInbox,
  claimBridgeMessage,
  ackBridgeMessage,
  completeBridgeMessage,
};
