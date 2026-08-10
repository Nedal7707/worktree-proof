import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ScopeValidationError,
  normalizeFileScope,
  normalizeLaneId,
  normalizeLanes,
  scopesOverlap,
} from '../src/scope.js';
import { planCapacity, PlannerValidationError } from '../src/planner.js';

test('normalizes lane IDs and relative POSIX scopes deterministically', () => {
  assert.equal(normalizeLaneId('  build-api  '), 'build-api');
  assert.equal(normalizeFileScope('./src\\api.js/'), 'src/api.js');
  assert.equal(normalizeFileScope('src//api.js'), 'src/api.js');
  assert.equal(scopesOverlap('src', 'src/api.js'), true);
  assert.equal(scopesOverlap('src/api', 'src/apiary'), false);
});

test('rejects unsafe scopes and invalid identities', () => {
  for (const value of ['', '.', './', '../src', 'src/../test', '/tmp/x', 'C:/tmp/x', '\\\\server\\share']) {
    assert.throws(() => normalizeFileScope(value), ScopeValidationError);
  }
  for (const value of ['', 'bad id', 'a/b', '../x', '-starts-ok?']) {
    assert.throws(() => normalizeLaneId(value), ScopeValidationError);
  }
});

test('rejects duplicate lane IDs and overlapping scopes', () => {
  assert.throws(
    () => normalizeLanes([
      { laneId: 'same', fileScope: 'src/a.js' },
      { laneId: 'same', fileScope: 'src/b.js' },
    ]),
    (error) => error.code === 'ERR_DUPLICATE_LANE_ID',
  );
  assert.throws(
    () => normalizeLanes([
      { laneId: 'parent', fileScope: 'src' },
      { laneId: 'child', fileScope: 'src/lib' },
    ]),
    (error) => error.code === 'ERR_OVERLAPPING_SCOPE',
  );
});

test('planner gives terminal backlog deterministic priority', () => {
  const result = planCapacity({
    lanes: [
      { laneId: 'z-build', fileScope: 'src/z.js', priority: 99 },
      { laneId: 'a-terminal', fileScope: 'src/a.js', priority: 0, requirements: { cpu: 1 } },
      { laneId: 'b-terminal', fileScope: 'src/b.js', priority: 0, requirements: { cpu: 1 } },
    ],
    backlog: [{ laneId: 'b-terminal', terminal: true }, { laneId: 'a-terminal', terminal: true }],
    capacity: { maxConcurrent: 2, pools: { cpu: 2 } },
  });

  assert.deepEqual(result.selected.map((lane) => lane.laneId), ['a-terminal', 'b-terminal']);
  assert.deepEqual(result.terminalBacklog, ['a-terminal', 'b-terminal']);
  assert.deepEqual(result.deferred.map(({ lane }) => lane.laneId), ['z-build']);
  assert.match(result.deferred[0].reasons.join('; '), /capacity exhausted/);
});

test('planner uses generic resource names and reports unavailable pools', () => {
  const result = planCapacity({
    lanes: [
      { laneId: 'one', fileScope: 'one.js', requirements: { alpha: 1 } },
      { laneId: 'two', fileScope: 'two.js', requirements: { beta: 1 } },
    ],
    capacity: { maxConcurrent: 2, pools: { alpha: 1 } },
  });
  assert.deepEqual(result.selected.map((lane) => lane.laneId), ['one']);
  assert.equal(result.deferred[0].lane.laneId, 'two');
  assert.match(result.deferred[0].reasons[0], /beta/);
  assert.doesNotMatch(JSON.stringify(result), /provider|model/i);
});

test('planner rejects invalid capacity and duplicate backlog entries', () => {
  assert.throws(
    () => planCapacity({ lanes: [{ laneId: 'a', fileScope: 'a.js' }], capacity: -1 }),
    PlannerValidationError,
  );
  assert.throws(
    () => planCapacity({
      lanes: [{ laneId: 'a', fileScope: 'a.js' }],
      backlog: [{ laneId: 'a' }, { laneId: 'a' }],
    }),
    (error) => error.code === 'ERR_DUPLICATE_BACKLOG',
  );
});
