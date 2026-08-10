import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sanitizeTaskSnapshot, TaskAwarenessError } from '../src/tasks.js';

test('task awareness hashes ids and discards private task content', () => {
  const snapshot = sanitizeTaskSnapshot({
    currentTaskId: 'current-private-id',
    tasks: [
      {
        id: 'current-private-id',
        status: 'active',
        updatedAt: 1786330000,
        resourceReservation: 2,
        title: 'Private project title',
        summary: 'Private task summary',
        cwd: 'C:\\private\\path',
      },
      {
        id: 'other-private-id',
        status: 'active',
        reportedMode: 'ultra',
        updatedAt: '2026-08-10T00:00:00.000Z',
        resourceReservation: 4,
        prompt: 'Do not expose this prompt',
      },
    ],
  }, { namespace: 'fixture' });

  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.activeCount, 2);
  assert.equal(snapshot.otherActiveReservations, 4);
  assert.equal(snapshot.modeVisibility, 'partial-or-reported');
  assert.doesNotMatch(serialized, /current-private-id|other-private-id|Private project|private\\path|Do not expose/);
  assert.ok(snapshot.tasks.every((task) => /^[a-f0-9]{16}$/.test(task.taskId)));
});

test('mode is unknown when the host does not explicitly report it', () => {
  const snapshot = sanitizeTaskSnapshot([
    { id: 'one', status: 'running', title: 'Ultra task', summary: 'max reasoning' },
  ]);
  assert.equal(snapshot.tasks[0].status, 'active');
  assert.equal(snapshot.tasks[0].reportedMode, 'unknown');
  assert.equal(snapshot.modeVisibility, 'unknown');
});

test('task awareness rejects duplicate ids, bad reservations, and oversized snapshots', () => {
  assert.throws(
    () => sanitizeTaskSnapshot([{ id: 'same' }, { id: 'same' }]),
    (error) => error instanceof TaskAwarenessError && error.code === 'ERR_DUPLICATE_TASK_ID',
  );
  assert.throws(
    () => sanitizeTaskSnapshot([{ id: 'one', resourceReservation: 25 }]),
    /resource reservation/,
  );
  assert.throws(
    () => sanitizeTaskSnapshot({ tasks: Array.from({ length: 257 }, (_, index) => ({ id: `task-${index}` })) }),
    /exceeds/,
  );
});

test('task-awareness schema excludes raw task content fields', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/task-awareness.schema.json', import.meta.url), 'utf8'));
  const taskProperties = schema.properties.tasks.items.properties;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(taskProperties).sort(), ['reportedMode', 'resourceReservation', 'status', 'taskId', 'updatedAt']);
  for (const privateField of ['title', 'summary', 'cwd', 'prompt', 'threadId']) assert.equal(privateField in taskProperties, false);
});
