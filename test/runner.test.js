import test from 'node:test';
import assert from 'node:assert/strict';

import { executeArgv, executeArgvSync } from '../src/runner.js';

test('executes argv without a shell and sanitizes output', async () => {
  const result = await executeArgv([
    process.execPath,
    '-e',
    "process.stdout.write('ok\\x1b[31m!\\x1b[0m')",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'ok!');
  assert.equal(result.argv[0], process.execPath);
});

test('enforces a timeout and returns a bounded result', async () => {
  const result = await executeArgv([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 50, killGraceMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, 'ETIMEDOUT');
});

test('sync runner uses shell=false and returns sanitized status', () => {
  let observed;
  const result = executeArgvSync([process.execPath, '-e', 'process.stdout.write("sync")'], {
    spawnSync(command, args, options) {
      observed = { command, args, options };
      return { status: 0, stdout: 'sync', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'sync');
  assert.equal(observed.options.shell, false);
});

