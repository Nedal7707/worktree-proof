import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { normalizeLaneId } from './scope.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const MAX_DEPTH = 128;

export class EvidenceValidationError extends TypeError {
  constructor(message, code = 'ERR_INVALID_CLOSURE_RECEIPT') {
    super(message);
    this.name = 'EvidenceValidationError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Return whether a value can be represented without loss as strict JSON. */
export function isJsonSafe(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    // JSON.stringify escapes control characters in strings, so they remain
    // JSON-safe even though identity fields below deliberately reject them.
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let safe = false;
  if (Array.isArray(value)) {
    safe = true;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || !isJsonSafe(value[index], seen, depth + 1)) {
        safe = false;
        break;
      }
    }
  } else if (isPlainObject(value)) {
    safe = true;
    for (const key of Object.keys(value)) {
      if (!isJsonSafe(value[key], seen, depth + 1)) {
        safe = false;
        break;
      }
    }
  }
  seen.delete(value);
  return safe;
}

function cloneJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = cloneJson(item);
  return output;
}

function requiredText(receipt, field) {
  if (typeof receipt[field] !== 'string' || !receipt[field].trim() || receipt[field] !== receipt[field].trim()) {
    throw new EvidenceValidationError(`${field} must be a non-empty trimmed string`, 'ERR_INVALID_CLOSURE_FIELD');
  }
  if (CONTROL_CHARS.test(receipt[field])) {
    throw new EvidenceValidationError(`${field} contains a control character`, 'ERR_INVALID_CLOSURE_FIELD');
  }
}

function outcomeOf(receipt) {
  const outcome = receipt.outcome;
  const status = receipt.status;
  if (outcome !== undefined && status !== undefined && outcome !== status) {
    throw new EvidenceValidationError('outcome and status disagree', 'ERR_CONFLICTING_OUTCOME');
  }
  const value = outcome ?? status;
  if (value !== 'merged' && value !== 'abandoned') {
    throw new EvidenceValidationError('outcome must be "merged" or "abandoned"', 'ERR_INVALID_OUTCOME');
  }
  return value;
}

/**
 * Validate and clone a terminal lane closure receipt.
 *
 * Merged receipts require canonicalRef, mergeSha and tests.  Abandoned
 * receipts require both branchDeleted and worktreeClean to be explicit true.
 * Optional deploy/evidence fields are accepted only when they are JSON-safe.
 */
export function validateClosureReceipt(receipt) {
  if (!isPlainObject(receipt)) {
    throw new EvidenceValidationError('closure receipt must be a plain object');
  }
  if (!isJsonSafe(receipt)) {
    throw new EvidenceValidationError('closure receipt must contain only JSON-safe values', 'ERR_NON_JSON_RECEIPT');
  }
  const outcome = outcomeOf(receipt);
  const normalized = cloneJson(receipt);
  if (normalized.outcome === undefined) normalized.outcome = outcome;

  if (outcome === 'merged') {
    requiredText(normalized, 'canonicalRef');
    requiredText(normalized, 'mergeSha');
    if (!Object.prototype.hasOwnProperty.call(normalized, 'tests') || normalized.tests === undefined || normalized.tests === null) {
      throw new EvidenceValidationError('merged receipt requires tests', 'ERR_MISSING_TEST_EVIDENCE');
    }
    if (normalized.branchDeleted !== undefined || normalized.worktreeClean !== undefined) {
      throw new EvidenceValidationError('merged receipt must not include abandoned-only fields', 'ERR_CONFLICTING_OUTCOME');
    }
  } else {
    if (normalized.branchDeleted !== true || normalized.worktreeClean !== true) {
      throw new EvidenceValidationError(
        'abandoned receipt requires branchDeleted=true and worktreeClean=true',
        'ERR_MISSING_ABANDONMENT_PROOF',
      );
    }
    for (const field of ['canonicalRef', 'mergeSha', 'tests']) {
      if (normalized[field] !== undefined) {
        throw new EvidenceValidationError('abandoned receipt must not include merged-only fields', 'ERR_CONFLICTING_OUTCOME');
      }
    }
  }

  for (const field of ['deploy', 'evidence']) {
    if (normalized[field] !== undefined && !isJsonSafe(normalized[field])) {
      throw new EvidenceValidationError(`${field} must be JSON-safe`, 'ERR_NON_JSON_EVIDENCE');
    }
  }
  return normalized;
}

export function assertClosureReceipt(receipt) {
  validateClosureReceipt(receipt);
  return true;
}

export function validateClosureReceipts(receipts) {
  if (!Array.isArray(receipts)) {
    throw new EvidenceValidationError('closure receipts must be an array', 'ERR_INVALID_RECEIPTS');
  }
  return receipts.map(validateClosureReceipt);
}

/**
 * Validate and atomically persist one closure receipt.
 *
 * The evidence module intentionally owns the write boundary so CLI adapters
 * and embedders use the same validation before any file is replaced.  The
 * destination is supplied by the caller; no network or implicit discovery is
 * performed.
 */
export async function writeClosureReceipt(filePath, receipt, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new EvidenceValidationError('closure receipt path is required', 'ERR_INVALID_CLOSURE_PATH');
  }
  const normalized = validateClosureReceipt(receipt);
  const destination = resolve(filePath);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    const wrapped = new EvidenceValidationError(`unable to write closure receipt: ${error.message}`, 'ERR_CLOSURE_WRITE');
    wrapped.cause = error;
    throw wrapped;
  }
  return { path: destination, receipt: normalized, written: true, replaced: options.replace !== false };
}

/**
 * Close one lane from a validated receipt.  The payload shape mirrors the CLI
 * command adapter and is deliberately explicit about the repository and
 * closure store.  A missing receipt is an error: a close operation must never
 * invent terminal evidence.
 */
export async function closeLane(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EvidenceValidationError('close payload must be an object', 'ERR_INVALID_CLOSE_PAYLOAD');
  }
  const receipt = payload.receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new EvidenceValidationError('close requires a JSON receipt', 'ERR_MISSING_CLOSURE_RECEIPT');
  }
  const normalized = validateClosureReceipt(receipt);
  if (typeof normalized.laneId !== 'string' || !normalized.laneId.trim()) {
    throw new EvidenceValidationError('closure receipt requires laneId', 'ERR_INVALID_CLOSURE_FIELD');
  }
  if (typeof normalized.closedAt !== 'string' || !normalized.closedAt.trim()) {
    throw new EvidenceValidationError('closure receipt requires closedAt', 'ERR_INVALID_CLOSURE_FIELD');
  }
  let laneId;
  try {
    laneId = normalizeLaneId(normalized.laneId);
  } catch (error) {
    const wrapped = new EvidenceValidationError(`invalid closure laneId: ${error.message}`, 'ERR_INVALID_CLOSURE_FIELD');
    wrapped.cause = error;
    throw wrapped;
  }

  const config = payload.config && typeof payload.config === 'object' ? payload.config : {};
  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const repository = typeof payload.repo === 'string' && payload.repo.trim() ? payload.repo : process.cwd();
  const store = options.closureStore ?? config.closureStore ?? '.worktree-proof/closures';
  const storePath = resolve(repository, store);
  const destination = options.output
    ? resolve(repository, options.output)
    : `${storePath}/${laneId}.json`;
  const result = await writeClosureReceipt(destination, { ...normalized, laneId }, { replace: true });
  return {
    closed: true,
    laneId,
    outcome: result.receipt.outcome,
    path: result.path,
    receipt: result.receipt,
  };
}
