import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpError,
  createLineDecoder,
  parseJsonRpcLine,
} from '../src/mcp/framing.js';

test('line decoder handles fragmented UTF-8, multiple lines, and CRLF', () => {
  const messages = [];
  const errors = [];
  const decoder = createLineDecoder({
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  });

  const payload = Buffer.from(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"x":"€"}}\r\n'
      + '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    'utf8',
  );
  decoder.write(payload.subarray(0, 13));
  decoder.write(payload.subarray(13, 45));
  decoder.write(payload.subarray(45));
  decoder.end();

  assert.deepEqual(errors, []);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].params.x, '€');
  assert.equal(messages[1].method, 'notifications/initialized');
});

test('line decoder reports malformed JSON-RPC and bounded oversize input without growing forever', () => {
  const errors = [];
  const messages = [];
  const decoder = createLineDecoder({
    maxBytes: 64,
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  });

  decoder.write(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"x"}\n', 'utf8'));
  decoder.write(Buffer.from('x'.repeat(100), 'utf8'));
  decoder.write(Buffer.from('\n', 'utf8'));
  decoder.write(Buffer.from('{"jsonrpc":"2.0","id":2,"method":7}\n', 'utf8'));
  decoder.end();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].message, 'message too large');
  assert.equal(errors[1].message, 'invalid request');
});

test('line decoder rejects invalid UTF-8, invalid ids, and non-object messages deterministically', () => {
  const errors = [];
  const decoder = createLineDecoder({ onMessage: () => {}, onError: (error) => errors.push(error) });
  decoder.write(Buffer.from([0xc3, 0x28, 0x0a]));
  decoder.write(Buffer.from('[1,2]\n', 'utf8'));
  decoder.write(Buffer.from('{"jsonrpc":"2.0","id":null,"method":"x"}\n', 'utf8'));
  decoder.end();

  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => error instanceof McpError));
  assert.ok(errors.every((error) => error.code === -32700 || error.code === -32600));
});

test('incomplete EOF is discarded cleanly and parser is strict', () => {
  const errors = [];
  const decoder = createLineDecoder({ onMessage: () => {}, onError: (error) => errors.push(error) });
  decoder.write(Buffer.from('{"jsonrpc":"2.0","id":3,"method":"x"', 'utf8'));
  assert.doesNotThrow(() => decoder.end());
  assert.deepEqual(errors, []);

  assert.throws(
    () => parseJsonRpcLine('{"jsonrpc":"2.0","id":{},"method":"x"}'),
    (error) => error instanceof McpError && error.code === -32600,
  );
});

test('boundedText-style UTF-8 framing never exceeds the byte limit at a multibyte boundary', async () => {
  const { sanitizeJson } = await import('../src/mcp/tools.js');
  for (const maxStringBytes of [1, 2, 3, 4, 5, 6, 7]) {
    const value = sanitizeJson('€€€€', { maxStringBytes });
    assert.ok(Buffer.byteLength(value, 'utf8') <= maxStringBytes, `limit ${maxStringBytes}`);
  }
});
