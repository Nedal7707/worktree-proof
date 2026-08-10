import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_BATCH_ITEMS,
  MAX_MESSAGE_BYTES,
  PROTOCOL,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  ProtocolError,
  createEnvelope,
  listCapabilities,
  negotiateCapabilities,
} from '../src/protocol/index.js';

test('protocol envelopes and capabilities are stable and sorted', () => {
  const envelope = createEnvelope({
    ok: true,
    command: 'capabilities',
    requestId: 'req-1',
    result: listCapabilities(),
  });
  assert.equal(envelope.protocol, 'worktreeproof');
  assert.equal(envelope.protocolVersion, '1.0');
  assert.deepEqual(
    envelope.result.map(({ id }) => id),
    [...envelope.result.map(({ id }) => id)].sort(),
  );
  assert.ok(Object.isFrozen(envelope));
});

test('capability records and negotiation are immutable, bounded, and stable', () => {
  const capabilities = listCapabilities();
  assert.ok(Object.isFrozen(capabilities));
  assert.ok(capabilities.every((capability) => Object.isFrozen(capability)));
  assert.deepEqual(capabilities.map(({ id }) => id), [
    'lease.reserve',
    'receipt.validate',
    'scope.validate',
  ]);
  assert.deepEqual(PROTOCOL_LIMITS, {
    maxMessageBytes: MAX_MESSAGE_BYTES,
    maxBatchItems: MAX_BATCH_ITEMS,
  });

  const negotiated = negotiateCapabilities({
    protocolVersion: PROTOCOL_VERSION,
    requested: ['scope.validate', 'not-supported', 'scope.validate'],
  });
  assert.equal(negotiated.protocol, PROTOCOL);
  assert.equal(negotiated.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(negotiated.capabilities.map(({ id }) => id), ['scope.validate']);
  assert.deepEqual(negotiated.unsupported, ['not-supported']);
  assert.ok(Object.isFrozen(negotiated));
  assert.ok(Object.isFrozen(negotiated.capabilities));
});

test('unknown protocol versions fail closed with a stable public error', () => {
  assert.throws(
    () => negotiateCapabilities({ protocolVersion: '9.0' }),
    (error) => error instanceof ProtocolError
      && error.code === 'ERR_PROTOCOL_VERSION'
      && error.message === 'unsupported protocol version',
  );
});

test('envelopes redact protected fields and reject oversized batches/messages', () => {
  const envelope = createEnvelope({
    ok: true,
    command: 'status',
    result: {
      owner: 'owner-private',
      session: 'session-private',
      token: 'token-private',
      nested: { stack: 'stack-private', value: 'safe' },
    },
  });
  assert.equal(envelope.result.owner, '[redacted]');
  assert.equal(envelope.result.session, '[redacted]');
  assert.equal(envelope.result.token, '[redacted]');
  assert.equal(envelope.result.nested.stack, '[redacted]');
  assert.doesNotMatch(JSON.stringify(envelope), /owner-private|session-private|token-private|stack-private/);

  assert.throws(
    () => createEnvelope({ ok: true, command: 'status', result: Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => 1) }),
    (error) => error.code === 'ERR_BATCH_TOO_LARGE',
  );
  assert.throws(
    () => createEnvelope({ ok: true, command: 'status', result: 'x'.repeat(MAX_MESSAGE_BYTES) }),
    (error) => error.code === 'ERR_MESSAGE_TOO_LARGE',
  );
  assert.throws(
    () => createEnvelope({ ok: true, command: 'status', requestId: 'session-private' }),
    (error) => error.code === 'ERR_INVALID_REQUEST_ID',
  );
});

test('warning values are redacted, bounded, and deterministic', () => {
  const warnings = [
    'safe warning',
    'owner-private',
    'session-private',
    'stack-private',
    'secret-private',
  ];
  const first = createEnvelope({ ok: true, command: 'status', warnings });
  const second = createEnvelope({ ok: true, command: 'status', warnings: [...warnings].reverse() });
  assert.deepEqual(first.warnings, second.warnings);
  assert.equal(first.warnings.filter((warning) => warning === '[redacted]').length, 4);
  assert.doesNotMatch(JSON.stringify(first), /owner-private|session-private|stack-private|secret-private/);
  assert.ok(first.warnings.every((warning) => warning.length <= 512));
});

test('protocol schemas are closed with explicit extension points', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const [name, required] of [
    ['protocol-request.schema.json', ['protocol', 'protocolVersion', 'schemaVersion', 'command', 'requestId']],
    ['protocol-response.schema.json', ['ok', 'protocol', 'protocolVersion', 'schemaVersion', 'command', 'requestId', 'warnings']],
    ['capabilities.schema.json', ['protocol', 'protocolVersion', 'schemaVersion', 'capabilities', 'limits']],
  ]) {
    const schema = JSON.parse(await readFile(path.join(root, 'schemas', name), 'utf8'));
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    for (const field of required) assert.ok(schema.required.includes(field), `${name} missing ${field}`);
    assert.equal(schema.properties.extensions.$ref, '#/$defs/extensions');
    assert.equal(schema.$defs.extensions.additionalProperties, true);
  }
});
