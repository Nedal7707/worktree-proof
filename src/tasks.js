/**
 * Privacy-safe cross-task awareness.
 *
 * Callers inject a one-shot host snapshot. WorktreeProof never lists threads,
 * polls a host, opens another task, or infers a model/mode from titles or text.
 */

import { createHash } from 'node:crypto';

const CONTROL = /[\u0000-\u001f\u007f]/u;
const TASK_STATUSES = Object.freeze(['active', 'idle', 'not-loaded', 'unknown']);
const REPORTED_MODES = Object.freeze(['ultra', 'xhigh', 'max', 'high', 'medium', 'low', 'standard', 'other', 'unknown']);
const MAX_TASKS = 256;
const MAX_RESERVATION = 24;

export class TaskAwarenessError extends TypeError {
  constructor(message, code = 'ERR_INVALID_TASK_SNAPSHOT') {
    super(message);
    this.name = 'TaskAwarenessError';
    this.code = code;
  }
}

function rawTaskId(task) {
  const value = task?.taskId ?? task?.threadId ?? task?.id;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || CONTROL.test(value)) {
    throw new TaskAwarenessError('task id must be a bounded string', 'ERR_INVALID_TASK_ID');
  }
  return value.trim();
}

function publicTaskId(value, namespace) {
  return createHash('sha256').update(`${namespace}\0${value}`).digest('hex').slice(0, 16);
}

function statusOf(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replaceAll('_', '-') : 'unknown';
  const aliases = { running: 'active', pending: 'active', notloaded: 'not-loaded', stopped: 'idle' };
  const status = aliases[normalized] ?? normalized;
  return TASK_STATUSES.includes(status) ? status : 'unknown';
}

function modeOf(task) {
  // Only explicitly reported fields are accepted. Titles, summaries, model
  // names, and task text are deliberately ignored.
  const value = task?.reportedMode ?? task?.reported_mode;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replaceAll('_', '-') : 'unknown';
  return REPORTED_MODES.includes(normalized) ? normalized : normalized ? 'other' : 'unknown';
}

function timestampOf(value) {
  if (value === undefined || value === null || value === '') return null;
  const numericSeconds = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const parsed = numericSeconds === null ? Date.parse(value) : numericSeconds * 1000;
  if (!Number.isFinite(parsed)) throw new TaskAwarenessError('updatedAt must be a timestamp', 'ERR_INVALID_TASK_TIME');
  return new Date(parsed).toISOString();
}

function reservationOf(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > MAX_RESERVATION) {
    throw new TaskAwarenessError(`resource reservation must be an integer from 0 to ${MAX_RESERVATION}`, 'ERR_INVALID_TASK_RESERVATION');
  }
  return number;
}

/**
 * Return a deterministic, redacted task inventory suitable for a resource
 * guard. Unknown host fields are discarded rather than copied through.
 */
export function sanitizeTaskSnapshot(input, options = {}) {
  const source = Array.isArray(input) ? { tasks: input } : input;
  if (!source || typeof source !== 'object' || !Array.isArray(source.tasks)) {
    throw new TaskAwarenessError('task snapshot must contain a tasks array');
  }
  if (source.tasks.length > MAX_TASKS) throw new TaskAwarenessError(`task snapshot exceeds ${MAX_TASKS} tasks`, 'ERR_TASK_SNAPSHOT_TOO_LARGE');
  const namespace = typeof options.namespace === 'string' && options.namespace.trim()
    ? options.namespace.trim()
    : 'worktree-proof-local';
  if (namespace.length > 128 || CONTROL.test(namespace)) throw new TaskAwarenessError('namespace is invalid');
  const currentRaw = options.currentTaskId ?? source.currentTaskId;
  const currentTaskId = currentRaw === undefined || currentRaw === null
    ? null
    : publicTaskId(String(currentRaw), namespace);
  const seen = new Set();
  const tasks = source.tasks.map((task) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new TaskAwarenessError('task entry must be an object');
    const taskId = publicTaskId(rawTaskId(task), namespace);
    if (seen.has(taskId)) throw new TaskAwarenessError('task snapshot contains a duplicate id', 'ERR_DUPLICATE_TASK_ID');
    seen.add(taskId);
    return {
      taskId,
      status: statusOf(task.status),
      reportedMode: modeOf(task),
      resourceReservation: reservationOf(task.resourceReservation ?? task.reservation),
      updatedAt: timestampOf(task.updatedAt),
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const active = tasks.filter((task) => task.status === 'active');
  const otherActiveReservations = active
    .filter((task) => task.taskId !== currentTaskId)
    .reduce((total, task) => total + task.resourceReservation, 0);
  return {
    schemaVersion: '1.0',
    source: 'host-injected',
    currentTaskId,
    tasks,
    activeCount: active.length,
    otherActiveReservations,
    modeVisibility: tasks.some((task) => task.reportedMode !== 'unknown') ? 'partial-or-reported' : 'unknown',
    warnings: [
      'Modes are host-reported only and are never inferred.',
      'Task titles, summaries, paths, prompts, and contents are discarded.',
    ],
  };
}

export const sanitizeTasks = sanitizeTaskSnapshot;

export default {
  sanitizeTaskSnapshot,
};
