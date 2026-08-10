import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BRIDGE_MAX_TTL_MS,
  ackBridgeMessage,
  claimBridgeMessage,
  completeBridgeMessage,
  listBridgeInbox,
  sendBridgeMessage,
  validateBridgeMessage,
} from '../src/bridge.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-proof-bridge-'));
  return { root, bridgeRoot: path.join(root, '.worktree-proof', 'bridge') };
}

test('Codex and Claude exchange an idempotent local task and redacted result', async () => {
  const { root, bridgeRoot } = await fixture();
  try {
    const task = await sendBridgeMessage(bridgeRoot, {
      sender: 'codex',
      recipient: 'claude',
      type: 'task',
      summary: 'Review the public documentation scope',
      laneId: 'docs-review',
      fileScope: 'docs/',
      capabilities: ['inspect', 'test'],
      idempotencyKey: 'docs-review-v1',
      now: '2026-08-10T00:00:00.000Z',
    });
    const duplicate = await sendBridgeMessage(bridgeRoot, {
      sender: 'codex',
      recipient: 'claude',
      type: 'task',
      summary: 'Review the public documentation scope',
      laneId: 'docs-review',
      fileScope: 'docs/',
      capabilities: ['test', 'inspect'],
      idempotencyKey: 'docs-review-v1',
      now: '2026-08-10T00:01:00.000Z',
    });
    assert.equal(duplicate.messageId, task.messageId);

    const inbox = await listBridgeInbox(bridgeRoot, { recipient: 'claude' });
    assert.equal(inbox.length, 1);
    assert.deepEqual(inbox[0].capabilities, ['inspect', 'test']);

    const claimed = await claimBridgeMessage(bridgeRoot, {
      messageId: task.messageId,
      receiver: 'claude',
      claimMs: 60_000,
      now: '2026-08-10T00:02:00.000Z',
    });
    assert.equal(claimed.status, 'claimed');
    await ackBridgeMessage(bridgeRoot, { messageId: task.messageId, actor: 'codex', now: '2026-08-10T00:03:00.000Z' });
    const completed = await completeBridgeMessage(bridgeRoot, {
      messageId: task.messageId,
      actor: 'claude',
      status: 'completed',
      now: '2026-08-10T00:04:00.000Z',
      result: {
        summary: 'Documentation review completed',
        evidence: ['Focused checks passed'],
        receiptRef: '.worktree-proof/closures/docs-review.json',
      },
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result.summary, 'Documentation review completed');

    const registry = JSON.parse(await readFile(path.join(root, '.worktree-proof', 'leases.json'), 'utf8'));
    assert.equal(registry.leases.at(-1).status, 'released');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bridge rejects secrets, commands, network payloads, unsafe scopes, and unbounded durations', async () => {
  const { root, bridgeRoot } = await fixture();
  try {
    await assert.rejects(Ûm-¢G§²ÚîÆ­yÕrsal)|unsafe|relative/i,
    );
    await assert.rejects(
      sendBridgeMessage(bridgeRoot, { sender: 'codex', recipient: 'claude', type: 'status', summary: 'Too long', ttlMs: BRIDGE_MAX_TTL_MS + 1 }),
      /ttlMs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only one receiver can claim a message and non-participants cannot acknowledge it', async () => {
  const { root, bridgeRoot } = await fixture();
  try {
    const task = await sendBridgeMessage(bridgeRoot, {
      sender: 'codex',
      recipient: 'claude',
      type: 'task',
      summary: 'Inspect a bounded source scope',
      fileScope: 'src/bridge.js',
    });
    const attempts = await Promise.allSettled([
      claimBridgeMessage(bridgeRoot, { messageId: task.messageId, receiver: 'claude' }),
      claimBridgeMessage(bridgeRoot, { messageId: task.messageId, receiver: 'claude' }),
    ]);
    assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((entry) => entry.status === 'rejected').length, 1);
    await assert.rejects(
      ackBridgeMessage(bridgeRoot, { messageId: task.messageId, actor: 'other' }),
      /participant/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('temporary files are ignored but a committed malformed message fails closed', async () => {
  const { root, bridgeRoot } = await fixture();
  try {
    await mkdir(bridgeRoot, { recursive: true });
    await writeFile(path.join(bridgeRoot, 'msg-partial.json.tmp'), '{');
    assert.deepEqual(await listBridgeInbox(bridgeRoot), []);
    await writeFile(path.join(bridgeRoot, 'msg-corrupt.json'), '{');
    await assert.rejects(listBridgeInbox(bridgeRoot), /invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validator does not accept hidden or executable fields', () => {
  const base = {
    messageId: 'message-1',
    sender: 'codex',
    recipient: 'claude',
    type: 'status',
    summary: 'Bounded status only',
    createdAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-11T00:00:00.000Z',
    status: 'pending',
  };
  assert.equal(validateBridgeMessage(base).summary, 'Bounded status only');
  assert.throws(() => validateBridgeMessage({ ...base, prompt: 'private context' }), /unsupported fields/);
  assert.throws(() => validateBridgeMessage({ ...base, command: ['node', '--version'] }), /unsupported fields/);
});

test('bridge schema mirrors the closed public message contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/bridge-message.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('messageId'));
  assert.deepEqual(schema.properties.type.enum, ['task', 'status', 'result', 'question', 'cancel']);
  assert.deepEqual(schema.properties.status.enum, ['pending', 'claimed', 'completed', 'failed', 'cancelled']);
});
