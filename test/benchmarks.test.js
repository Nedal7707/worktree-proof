import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const OPERATIONS = [
  'doctor',
  'plan',
  'reserve',
  'run',
  'status',
  'close',
  'release',
  'validate',
  'cleanup',
];

let benchmarkResult;

before(() => {
  const child = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'benchmarks', 'run.js'), '--iterations', '1'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert.equal(child.status, 0, `benchmark harness exited ${child.status}: ${child.stderr}`);
  benchmarkResult = JSON.parse(child.stdout);
});

test('benchmark harness emits a schema-conformant result', () => {
  const result = benchmarkResult;
  assert.equal(typeof result.benchmark, 'string');
  assert.equal(typeof result.packageVersion, 'string');
  assert.match(result.node, /^v\d+\.\d+\.\d+$/);
  assert.equal(typeof result.platform, 'string');
  assert.equal(typeof result.arch, 'string');
  assert.equal(result.iterations, 1);
  assert.deepEqual(Object.keys(result.operations).sort(), [...OPERATIONS].sort());
  for (const op of OPERATIONS) {
    const summary = result.operations[op];
    assert.ok(summary.samples >= 1);
    assert.equal(typeof summary.minMs, 'number');
    assert.equal(typeof summary.medianMs, 'number');
    assert.equal(typeof summary.maxMs, 'number');
  }
  assert.equal(result.assertions.everyCommandReturnedOkJson, true);
  assert.equal(result.assertions.closureReceiptValidated, true);
  assert.equal(result.assertions.cleanupWasPreviewOnly, true);
});