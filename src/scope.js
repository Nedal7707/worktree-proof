/**
 * Lane identity and scope validation.
 *
 * A lane's fileScope is intentionally treated as a POSIX path regardless of
 * the host operating system.  This keeps comparisons deterministic when the
 * registry is shared by Windows and Unix workers.
 */

export class ScopeValidationError extends TypeError {
  constructor(message, code = 'ERR_SCOPE_VALIDATION') {
    super(message);
    this.name = 'ScopeValidationError';
    this.code = code;
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const LANE_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const MAX_LANE_ID_LENGTH = 128;
const MAX_SCOPE_LENGTH = 1024;

function requireString(value, label, code) {
  if (typeof value !== 'string') {
    throw new ScopeValidationError(`${label} must be a string`, code);
  }
  const normalized = value.normalize('NFC').trim();
  if (!normalized || CONTROL_CHARS.test(normalized)) {
    throw new ScopeValidationError(`${label} must be non-empty and contain no control characters`, code);
  }
  return normalized;
}

/** Normalize and validate a lane identifier. */
export function normalizeLaneId(value) {
  const normalized = requireString(value, 'laneId', 'ERR_INVALID_LANE_ID').toLowerCase();
  if (normalized.length > MAX_LANE_ID_LENGTH) {
    throw new ScopeValidationError(`laneId must be at most ${MAX_LANE_ID_LENGTH} characters`, 'ERR_INVALID_LANE_ID');
  }
  if (!LANE_ID.test(normalized)) {
    throw new ScopeValidationError(
      `laneId ${JSON.stringify(normalized)} must contain only letters, numbers, '.', '_' or '-'`,
      'ERR_INVALID_LANE_ID',
    );
  }
  return normalized;
}

/**
 * Normalize a scope into a canonical, relative POSIX path.
 *
 * Backslashes are accepted as input convenience and converted to POSIX
 * separators.  Absolute paths, drive/UNC prefixes, parent traversal and an
 * empty result are rejected rather than silently sandboxed.
 */
export function normalizeFileScope(value) {
  const raw = requireString(value, 'fileScope', 'ERR_INVALID_FILE_SCOPE');
  const slashPath = raw.replaceAll('\\', '/');

  if (slashPath.startsWith('/') || /^[A-Za-z]:/u.test(slashPath)) {
    throw new ScopeValidationError(
      `fileScope ${JSON.stringify(raw)} must be a relative POSIX path`,
      'ERR_INVALID_FILE_SCOPE',
    );
  }

  const segments = slashPath.split('/');
  const canonical = [];
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new ScopeValidationError(
        `fileScope ${JSON.stringify(raw)} contains parent traversal`,
        'ERR_PARENT_TRAVERSAL',
      );
    }
    if (CONTROL_CHARS.test(segment)) {
      throw new ScopeValidationError(
        `fileScope ${JSON.stringify(raw)} contains a control character`,
        'ERR_INVALID_FILE_SCOPE',
      );
    }
    canonical.push(segment);
  }

  if (canonical.length === 0) {
    throw new ScopeValidationError('fileScope must not be empty', 'ERR_EMPTY_FILE_SCOPE');
  }
  const normalized = canonical.join('/');
  if (normalized.length > MAX_SCOPE_LENGTH) {
    throw new ScopeValidationError(`fileScope must be at most ${MAX_SCOPE_LENGTH} characters`, 'ERR_INVALID_FILE_SCOPE');
  }
  return normalized;
}

/** Normalize one lane descriptor while preserving additional JSON-safe metadata. */
export function normalizeLane(lane) {
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
    throw new ScopeValidationError('lane must be an object', 'ERR_INVALID_LANE');
  }
  const laneId = normalizeLaneId(lane.laneId);
  const fileScope = normalizeFileScope(lane.fileScope);
  return { ...lane, laneId, fileScope };
}

/** True when either scope is the other scope or a descendant of it. */
export function scopesOverlap(left, right) {
  const a = normalizeFileScope(left);
  const b = normalizeFileScope(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Normalize a lane list and enforce unique IDs and non-overlapping scopes.
 * The input order is retained; callers that need scheduling order can sort
 * using their own policy without changing identity semantics.
 */
export function normalizeLanes(lanes) {
  if (!Array.isArray(lanes)) {
    throw new ScopeValidationError('lanes must be an array', 'ERR_INVALID_LANES');
  }
  const normalized = [];
  const ids = new Map();

  for (const lane of lanes) {
    const item = normalizeLane(lane);
    if (ids.has(item.laneId)) {
      throw new ScopeValidationError(
        `duplicate laneId ${JSON.stringify(item.laneId)}`,
        'ERR_DUPLICATE_LANE_ID',
      );
    }
    ids.set(item.laneId, true);

    for (const prior of normalized) {
      if (scopesOverlap(prior.fileScope, item.fileScope)) {
        throw new ScopeValidationError(
          `fileScope ${JSON.stringify(item.fileScope)} overlaps ${JSON.stringify(prior.fileScope)}`,
          'ERR_OVERLAPPING_SCOPE',
        );
      }
    }
    normalized.push(item);
  }
  return normalized;
}

export function assertUniqueLanes(lanes) {
  normalizeLanes(lanes);
  return true;
}
