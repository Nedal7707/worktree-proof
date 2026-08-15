import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

let evalResult;

before(() => {
  const child = spawnSync(process.execPath, [join(REPO_ROOT, 'evals', 'run.js')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(child.status, 0, `eval harness exited ${child.status}: ${child.stderr}`);
  evalResult = JSON.parse(child.stdout);
});

test('eval harness emits a schema-conformant result', () => {
  assert.equal(evalResult.schemaVersion, '1');
  assert.equal(typeof evalResult.seed, 'string');
  assert.ok(evalResult.seed.length > 0);
  assert.ok(Array.isArray(evalResult.results));
  assert.ok(evalResult.results.length > 0);
  assert.deepEqual(Object.keys(evalResult).sort(), ['results', 'schemaVersion', 'seed']);
  for (const entry of evalResult.results) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.passed, 'boolean');
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'passed']);
  }
});

test('every seeded eval check passes', () => {
  const failed = evalResult.results.filter((entry) => !entry.passed);
  assert.deepEqual(failed, []);
});