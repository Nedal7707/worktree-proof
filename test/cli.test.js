import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EXIT_CODES,
  parseArgs,
  runCli,
} from '../src/cli.js';

function capture() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: (line) => out.push(String(line)),
      stderr: (line) => err.push(String(line)),
    },
    out,
    err,
  };
}

test('help is clear and exits successfully', async () => {
  const stream = capture();
  const result = await runCli(['--help'], { io: stream.io });

  assert.equal(result.code, EXIT_CODES.OK);
  assert.match(stream.out.join('\n'), /worktree-proof/);
  assert.match(stream.out.join('\n'), /doctor/);
  assert.equal(stream.err.length, 0);
});

test('version is available as a command and an option', async () => {
  const command = capture();
  const option = capture();
  const first = await runCli(['version'], { io: command.io });
  const second = await runCli(['--version'], { io: option.io });

  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.match(command.out[0], /^worktree-proof \d+\.\d+\.\d+$/);
  assert.equal(command.out[0], option.out[0]);
});

test('unknown options fail deterministically', async () => {
  const stream = capture();
  const result = await runCli(['status', '--not-a-real-option'], { io: stream.io });

  assert.equal(result.code, EXIT_CODES.USAGE);
  assert.match(stream.err[0], /unknown option/);
});

test('parser preserves argv only after the run separator', () => {
  const parsed = parseArgs(['run', '--repo', '.', '--', 'node', '-e', 'console.log(1)']);

  assert.equal(parsed.command, 'run');
  assert.deepEqual(parsed.passthrough, ['node', '-e', 'console.log(1)']);
  assert.equal(parsed.options.repo, '.');
});

test('run passes an argv array and never a shell string', async () => {
  const stream = capture();
  let received;
  const result = await runCli(
    ['run', '--', 'node', '--version'],
    {
      io: stream.io,
      deps: {
        runner: {
          executeArgv: async (payload) => {
            received = payload;
            return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0 };
          },
        },
      },
    },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(received, ['node', '--version']);
  assert.ok(Array.isArray(received));
  assert.equal(typeof received, 'object');
});

test('dry-run reserve does not invoke the lease adapter', async () => {
  const stream = capture();
  let called = false;
  const result = await runCli(
    ['reserve', '--lane-id', 'docs-api', '--dry-run'],
    {
      io: stream.io,
      deps: {
        leases: {
          reserveLease: async () => {
            called = true;
            return { leaseId: 'should-not-exist' };
          },
        },
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(called, false);
  assert.match(stream.out[0], /planned/);
});

test('no-submit close is reported without writing a receipt', async () => {
  const stream = capture();
  let called = false;
  const result = await runCli(
    ['close', '--lane-id', 'docs-api', '--no-submit'],
    {
      io: stream.io,
      deps: {
        evidence: {
          closeLane: async () => {
            called = true;
            return { status: 'closed' };
          },
        },
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(called, false);
  assert.match(stream.out[0], /no-submit/);
});

test('JSON output redacts sensitive fields', async () => {
  const stream = capture();
  const result = await runCli(
    ['status', '--json'],
    {
      io: stream.io,
      deps: {
        leases: {
          statusLeases: async () => ({
            status: 'idle',
            accessToken: 'do-not-print',
          }),
        },
      },
    },
  );

  assert.equal(result.code, 0);
  const output = JSON.parse(stream.out[0]);
  assert.equal(output.ok, true);
  assert.equal(output.result.accessToken, '[redacted]');
  assert.doesNotMatch(stream.out[0], /do-not-print/);
});

test('capabilities emits one deterministic protocol envelope', async () => {
  const stream = capture();
  const result = await runCli([
    'capabilities',
    '--protocol-version', '1.0',
    '--request-id', 'req-cli-1',
    '--json',
  ], {
    io: stream.io,
    loadConfig: async () => { throw new Error('capabilities must not load config'); },
  });

  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(stream.err.length, 0);
  assert.equal(stream.out.length, 1);
  const envelope = JSON.parse(stream.out[0]);
  assert.equal(envelope.protocol, 'worktreeproof');
  assert.equal(envelope.protocolVersion, '1.0');
  assert.equal(envelope.requestId, 'req-cli-1');
  assert.deepEqual(envelope.result.capabilities.map(({ id }) => id), [
    'lease.reserve',
    'receipt.validate',
    'scope.validate',
  ]);
  assert.equal(envelope.result.limits.maxMessageBytes, 16_384);
  assert.equal(envelope.result.limits.maxBatchItems, 100);
});

test('capabilities uses stable operational and usage exit codes', async () => {
  const unsupportedVersion = capture();
  const refused = await runCli([
    'capabilities', '--protocol-version', '9.0', '--json',
  ], { io: unsupportedVersion.io });
  assert.equal(refused.code, EXIT_CODES.ERROR);
  const refusalEnvelope = JSON.parse(unsupportedVersion.out[0]);
  assert.equal(refusalEnvelope.ok, false);
  assert.equal(refusalEnvelope.error.code, 'ERR_PROTOCOL_VERSION');
  assert.doesNotMatch(unsupportedVersion.out[0], /stack|session|owner|token/i);

  const missingVersion = capture();
  const usage = await runCli(['capabilities', '--json'], { io: missingVersion.io });
  assert.equal(usage.code, EXIT_CODES.USAGE);
  assert.equal(JSON.parse(missingVersion.out[0]).error.code, 'ERR_INVALID_REQUEST');

  const unsupported = capture();
  const normal = await runCli([
    'capabilities', '--protocol-version', '1.0', '--capabilities', 'scope.validate,unknown', '--json',
  ], { io: unsupported.io });
  assert.equal(normal.code, EXIT_CODES.OK);
  const negotiated = JSON.parse(unsupported.out[0]);
  assert.deepEqual(negotiated.result.unsupported, ['unknown']);
  assert.deepEqual(negotiated.result.capabilities.map(({ id }) => id), ['scope.validate']);
});

test('leases inspect is routed with safe metadata and recovery requires confirmation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-cli-leases-'));
  try {
    const registryDirectory = path.join(root, '.worktree-proof');
    await mkdir(registryDirectory, { recursive: true });
    await writeFile(path.join(registryDirectory, 'leases.json'), JSON.stringify({
      version: 1,
      leases: [{
        leaseId: 'lease-private',
        laneId: 'blocked',
        fileScope: 'src/blocked.js',
        owner: 'owner-private',
        session: 'session-private',
        timestamp: '2020-01-01T00:00:00.000Z',
        ttlMs: 1_000,
        expiresAt: '2020-01-01T00:00:01.000Z',
        status: 'active',
        active: true,
      }],
    }), 'utf8');

    const inspectStream = capture();
    const inspected = await runCli(['leases', 'inspect', 'blocked', '--repo', root, '--json'], {
      io: inspectStream.io,
      deps: {
        leases: {
          inspectLeaseRegistry: async () => ({
            version: 1,
            leases: [{
              leaseId: 'lease-private',
              laneId: 'blocked',
              fileScope: 'src/blocked.js',
              owner: 'owner-private',
              session: 'session-private',
              status: 'active',
              active: true,
            }],
            stale: [{
              leaseId: 'lease-private',
              laneId: 'blocked',
              fileScope: 'src/blocked.js',
              owner: 'owner-private',
              session: 'session-private',
              status: 'active',
              active: true,
            }],
          }),
        },
      },
    });
    assert.equal(inspected.code, EXIT_CODES.OK);
    assert.equal(JSON.parse(inspectStream.out[0]).result.stale[0].laneId, 'blocked');
    assert.doesNotMatch(inspectStream.out[0], /owner-private|session-private|lease-private/);

    const refusalStream = capture();
    const refusal = await runCli(['leases', 'recover', 'blocked', '--repo', root, '--reason', 'merged', '--json'], {
      io: refusalStream.io,
    });
    assert.equal(refusal.code, EXIT_CODES.ERROR);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leases recovery rejects outside registry paths and normalizes lane selectors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-cli-paths-'));
  try {
    const calls = [];
    const deps = { leases: {
      inspectLeaseRegistry: async (registryPath) => {
        calls.push(registryPath);
        return { version: 1, leases: [{ laneId: 'blocked', fileScope: 'src/x.js', owner: 'o', session: 's', leaseId: 'l' }], stale: [] };
      },
      recoverExpiredLease: async (_registryPath, input) => ({ laneId: input.laneId, status: 'released', owner: 'o', session: 's', leaseId: 'l' }),
    } };
    const inspect = capture();
    const inspected = await runCli(['leases', 'inspect', ' BLOCKED ', '--repo', root, '--json'], { io: inspect.io, deps });
    assert.equal(inspected.code, EXIT_CODES.OK);
    assert.equal(JSON.parse(inspect.out[0]).result.leases[0].laneId, 'blocked');
    assert.doesNotMatch(inspect.out[0], /owner|session|leaseId/);
    const recoveredStream = capture();
    const recovered = await runCli(['leases', 'recover', ' BLOCKED ', '--repo', root, '--reason', 'merged', '--confirm', '--json'], {
      io: recoveredStream.io,
      deps,
    });
    assert.equal(recovered.code, EXIT_CODES.OK);
    assert.equal(JSON.parse(recoveredStream.out[0]).result.status, 'released');
    assert.doesNotMatch(recoveredStream.out[0], /owner|session|leaseId/);
    const outside = capture();
    const refused = await runCli(['leases', 'recover', 'blocked', '--repo', root, '--config', path.join(os.tmpdir(), 'outside-config.json'), '--reason', 'merged', '--confirm', '--json'], {
      io: outside.io,
      loadConfig: async () => ({ path: 'outside', config: { leaseStore: path.join(os.tmpdir(), 'outside-registry.json') } }),
      deps,
    });
    assert.equal(refused.code, EXIT_CODES.USAGE);
    assert.equal(calls.length, 1);

    const traversal = capture();
    const traversalResult = await runCli(['leases', 'recover', 'blocked', '--repo', root, '--reason', 'merged', '--confirm', '--json'], {
      io: traversal.io,
      loadConfig: async () => ({ path: 'traversal', config: { leaseStore: path.join(root, '..', 'outside-registry.json') } }),
      deps,
    });
    assert.equal(traversalResult.code, EXIT_CODES.USAGE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leases recovery refuses symlink/reparse registry parents when supported', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-cli-reparse-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-cli-reparse-target-'));
  try {
    const link = path.join(root, 'linked-state');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/reparse creation unavailable: ${error.code ?? error.message}`);
      return;
    }
    const stream = capture();
    const result = await runCli(['leases', 'recover', 'blocked', '--repo', root, '--config', 'config.json', '--reason', 'merged', '--confirm', '--json'], {
      io: stream.io,
      loadConfig: async () => ({ path: 'config', config: { leaseStore: path.join(root, 'linked-state', 'leases.json') } }),
      deps: { leases: { recoverExpiredLease: async () => ({ status: 'released' }) } },
    });
    assert.equal(result.code, EXIT_CODES.USAGE);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('run dry-run reports shape without executing a process', async () => {
  const stream = capture();
  let called = false;
  const result = await runCli(
    ['run', '--dry-run', '--', 'some-program', '--secret-value'],
    {
      io: stream.io,
      deps: {
        runner: {
          executeArgv: async () => {
            called = true;
            return { exitCode: 0 };
          },
        },
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(called, false);
  assert.match(stream.out[0], /planned/);
  assert.doesNotMatch(stream.out[0], /secret-value/);
});

test('tools list is read-only and tools recommend accepts repeated goals', async () => {
  const stream = capture();
  const result = await runCli(['tools', 'recommend', '--goal', 'testing', '--goal', 'javascript', '--json'], {
    io: stream.io,
    deps: {
      tools: {
        loadToolCatalog: () => [{ id: 'node', name: 'Node', categories: ['javascript'], capabilities: ['testing'], tags: ['testing'] }],
        recommendTools: (goals) => goals.map((goal) => ({ id: goal })),
      },
    },
  });
  assert.equal(result.code, EXIT_CODES.OK);
  const output = JSON.parse(stream.out[0]);
  assert.deepEqual(output.result.goals, ['testing', 'javascript']);
});

test('resources plan remains non-mutating and init writes require confirmation', async () => {
  const stream = capture();
  const result = await runCli(['resources', 'plan', '--json'], {
    io: stream.io,
    deps: {
      resources: {
        scanResources: async () => ({ repoPath: '.', scannedAt: 'now', cpu: {}, memory: {}, disk: {}, footprint: {} }),
        planSessionGuard: () => ({ mutating: false, acceptNewLanes: true }),
        planProjectCleanup: () => ({ mutating: false, requiresExplicitConfirmation: true, items: [] }),
      },
    },
  });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(JSON.parse(stream.out[0]).result.cleanup.mutating, false);

  const initStream = capture();
  const init = await runCli(['init', 'apply', '--target', 'generic-prompt'], { io: initStream.io, repo: process.cwd() });
  assert.equal(init.code, EXIT_CODES.USAGE);
  assert.match(initStream.err[0], /requires --confirm/);
});

test('bridge dry-run never sends and a real send uses bounded structured fields', async () => {
  let calls = 0;
  const bridge = {
    sendBridgeMessage: async (_root, message) => {
      calls += 1;
      assert.equal(message.sender, 'codex');
      assert.equal(message.recipient, 'claude');
      assert.equal(message.fileScope, 'docs/');
      assert.deepEqual(message.capabilities, ['test', 'inspect']);
      return { messageId: 'message-1', ...message, status: 'pending' };
    },
  };
  const previewStream = capture();
  const preview = await runCli([
    'bridge', 'send', '--sender', 'codex', '--recipient', 'claude', '--type', 'task',
    '--summary', 'Review docs', '--scope', 'docs/', '--dry-run',
  ], { io: previewStream.io, deps: { bridge } });
  assert.equal(preview.code, EXIT_CODES.OK);
  assert.equal(calls, 0);

  const stream = capture();
  const result = await runCli([
    'bridge', 'send', '--sender', 'codex', '--recipient', 'claude', '--type', 'task',
    '--summary', 'Review docs', '--scope', 'docs/', '--capabilities', 'test,inspect', '--json',
  ], { io: stream.io, deps: { bridge } });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(stream.out[0]).result.message.messageId, 'message-1');
});

test('bridge inbox is read-only and bridge state cannot escape the repository', async () => {
  const stream = capture();
  const result = await runCli(['bridge', 'inbox', '--agent', 'claude', '--json'], {
    io: stream.io,
    deps: { bridge: { listBridgeInbox: async (_root, options) => [{ recipient: options.recipient, status: 'pending' }] } },
  });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(JSON.parse(stream.out[0]).result.messages[0].recipient, 'claude');

  const escape = capture();
  const escaped = await runCli(['bridge', 'inbox', '--agent', 'claude', '--bridge-root', path.join('..', 'outside')], {
    io: escape.io,
    deps: { bridge: { listBridgeInbox: async () => [] } },
  });
  assert.equal(escaped.code, EXIT_CODES.USAGE);
  assert.match(escape.err[0], /inside the repository/);
});

test('tasks inspect accepts only an explicit snapshot and returns sanitized metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-cli-tasks-'));
  try {
    await writeFile(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'private-id', status: 'active' }] }));
    const stream = capture();
    const result = await runCli(['tasks', 'inspect', '--input', 'tasks.json', '--json'], {
      io: stream.io,
      repo: root,
      deps: {
        tasks: {
          sanitizeTaskSnapshot: () => ({ tasks: [{ taskId: 'abcdef0123456789', status: 'active', reportedMode: 'unknown' }] }),
        },
      },
    });
    assert.equal(result.code, EXIT_CODES.OK);
    const output = JSON.parse(stream.out[0]);
    assert.equal(output.result.snapshot.tasks[0].reportedMode, 'unknown');
    assert.doesNotMatch(stream.out[0], /private-id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
