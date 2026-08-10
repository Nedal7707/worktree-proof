import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EvidenceValidationError,
  assertClosureReceipt,
  isJsonSafe,
  validateClosureReceipt,
  validateClosureReceipts,
} from '../src/evidence.js';

test('accepts merged closure receipts with required and optional evidence', () => {
  const receipt = validateClosureReceipt({
    laneId: 'lane-a',
    outcome: 'merged',
    canonicalRef: 'origin/main',
    mergeSha: 'abc1234',
    tests: { passed: 12, command: 'node --test' },
    deploy: { release: 'r-1', verified: true },
    evidence: ['ci://run/1'],
  });
  assert.equal(receipt.outcome, 'merged');
  assert.equal(receipt.canonicalRef, 'origin/main');
  assert.deepEqual(receipt.tests, { passed: 12, command: 'node --test' });
  assertClosureReceipt(receipt);
});

test('accepts status alias and abandoned closure receipts', () => {
  const receipt = validateClosureReceipt({
    status: 'abandoned',
    reason: 'superseded',
    branchDeleted: true,
    worktreeClean: true,
  });
  assert.equal(receipt.status, 'abandoned');
  assert.equal(receipt.outcome, 'abandoned');
  assert.equal(assertClosureReceipt(receipt), true);
});

test('rejects incomplete or contradictory closure outcomes', () => {
  assert.throws(
    () => validateClosureReceipt({ outcome: 'merged', canonicalRef: 'origin/main', mergeSha: 'abc' }),
    (error) => error.code === 'ERR_MISSING_TEST_EVIDENCE',
  );
  assert.throws(
    () => validateClosureReceipt({ outcome: 'merged', canonicalRef: ' origin/main', mergeSha: 'abc', tests: [] }),
    (error) => error.code === 'ERR_INVALID_CLOSURE_FIELD',
  );
  assert.throws(
    () => validateClosureReceipt({ outcome: 'abandoned', branchDeleted: true, worktreeClean: false }),
    (error) => error.code === 'ERR_MISSING_ABANDONMENT_PROOF',
  );
  assert.throws(
    () => validateClosureReceipt({ outcome: 'merged', status: 'abandoned', canonicalRef: 'main', mergeSha: 'x', tests: [] }),
    (error) => error.code === 'ERR_CONFLICTING_OUTCOME',
  );
  assert.throws(
    () => validateClosureReceipt({ outcome: 'abandoned', branchDeleted: true, worktreeClean: true, tests: [] }),
    (error) => error.code === 'ERR_CONFLICTING_OUTCOME',
  );
});

test('rejects values that cannot be represented safely as JSON', () => {
  const cyclic = { outcome: 'merged', canonicalRef: 'main', mergeSha: 'x', tests: {} };
  cyclic.evidence = cyclic;
  assert.equal(isJsonSafe(cyclic), false);
  assert.throws(() => validateClosureReceipt(cyclic), EvidenceValidationError);
  assert.equal(isJsonSafe({ value: Number.NaN }), false);
  assert.equal(isJsonSafe({ value: Infinity }), false);
  assert.equal(isJsonSafe({ value: undefined }), false);
  assert.equal(isJsonSafe({ value: 1n }), false);
  assert.equal(isJsonSafe(new Date()), false);
  assert.equal(isJsonSafe(new Map()), false);
  assert.throws(
    () => validateClosureReceipt({ outcome: 'merged', canonicalRef: 'main', mergeSha: 'x', tests: undefined }),
    (error) => error.code === 'ERR_NON_JSON_RECEIPT',
  );
});

test('validates a batch and returns independent JSON-safe copies', () => {
  const input = [
    { outcome: 'merged', canonicalRef: 'main', mergeSha: 'a', tests: ['ok'] },
    { outcome: 'abandoned', branchDeleted: true, worktreeClean: true },
  ];
  const output = validateClosureReceipts(input);
  assert.deepEqual(output.map((item) => item.outcome), ['merged', 'abandoned']);
  assert.notEqual(output[0], input[0]);
  input[0].tests.push('changed');
  assert.deepEqual(output[0].tests, ['ok']);
});
