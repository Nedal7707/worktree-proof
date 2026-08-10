import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  MCP_PROTOCOL_VERSION,
  DEFAULT_MCP_LIMITS,
  createMcpServer,
  handleMcpMessage,
} from '../src/mcp/server.js';
import { listMcpTools, sanitizeJson } from '../src/mcp/tools.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, 'bin', 'worktree-proof-mcp.js');

function readLine(stream) {
  const state = stream.__mcpReadState ?? { buffer: '', pending: [] };
  stream.__mcpReadState = state;
  if (state.buffer.includes('\n')) {
    const newline = state.buffer.indexOf('\n');
    const line = state.buffer.slice(0, newline).replace(/\r$/u, '');
    state.buffer = state.buffer.slice(newline + 1);
    return Promise.resolve(JSON.parse(line));
  }
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      state.buffer += chunk.toString('utf8');
      const newline = state.buffer.indexOf('\n');
      if (newline < 0) return;
      stream.off('data', onData);
      const line = state.buffer.slice(0, newline).replace(/\r$/u, '');
      state.buffer = state.buffer.slice(newline + 1);
      resolve(JSON.parse(line));
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

function rpc(id, method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`;
}

async function spawnMcp(args = []) {
  const child = spawn(process.execPath, [bin, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  return child;
}

test('MCP subprocess initializes, lists deterministic read-only tools, and calls capabilities', async () => {
  const child = await spawnMcp();
  child.stdin.write(rpc(1, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1' },
  }));
  const initialized = await readLine(child.stdout);
  assert.equal(initialized.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initialized.result.capabilities.tools.listChanged, false);
  assert.equal(initialized.result.serverInfo.name, 'worktree-proof');

  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write(rpc(2, 'tools/list', {}));
  const listed = await readLine(child.stdout);
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'worktreeproof_capabilities',
    'worktreeproof_status',
    'worktreeproof_validate_receipt',
    'worktreeproof_validate_scope',
  ]);
  assert.ok(listed.result.tools.every((tool) => tool.inputSchema.additionalProperties === false));

  child.stdin.write(rpc(3, 'tools/call', { name: 'worktreeproof_capabilities', arguments: {} }));
  const called = await readLine(child.stdout);
  assert.equal(called.id, 3);
  assert.equal(called.result.isError, false);
  assert.equal(called.result.content[0].type, 'text');

  child.stdin.end();
  assert.equal((await once(child, 'close'))[0], 0);
});

test('pre-initialize, unknown method/tool, malformed params, and mutation confirmation fail safely', async () => {
  const server = createMcpServer({ core: {} });
  let response = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, server.context);
  assert.equal(response.error.code, -32002);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'wrong', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, server.context);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'nope' }, server.context);
  assert.equal(response.error.code, -32601);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'worktreeproof_nope', arguments: {} } }, server.context);
  assert.equal(response.error.code, -32601);

  const enabled = createMcpServer({
    enableLeaseMutation: true,
    core: { reserveLease: async () => ({ ok: true, owner: 'private-owner' }) },
  });
  await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, enabled.context);
  await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, enabled.context);
  const tools = listMcpTools({ enableLeaseMutation: true });
  assert.ok(tools.some((tool) => tool.name === 'worktreeproof_reserve_lease'));
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'worktreeproof_reserve_lease', arguments: { laneId: 'x', fileScope: 'src', confirm: false } } }, enabled.context);
  assert.equal(response.error.code, -32602);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'worktreeproof_reserve_lease', arguments: { laneId: 'x', fileScope: 'src', confirm: true } } }, enabled.context);
  assert.equal(response.result.isError, false);
});

test('injected results are redacted, bounded, and JSON-safe', async () => {
  const server = createMcpServer({
    limits: { maxOutputBytes: 512 },
    core: {
      status: async () => ({ owner: 'WTP_OWNER_SENTINEL', session: 'WTP_SESSION_SENTINEL', path: 'C:\\private\\secret', stack: 'WTP_STACK_SENTINEL', token: 'WTP_TOKEN_SENTINEL', safe: 'ok', giant: 'x'.repeat(10000) }),
    },
  });
  await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, server.context);
  await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context);
  const response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worktreeproof_status', arguments: {} } }, server.context);
  const serialized = JSON.stringify(response);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 512);
  assert.doesNotMatch(serialized, /WTP_OWNER_SENTINEL|WTP_SESSION_SENTINEL|WTP_STACK_SENTINEL|WTP_TOKEN_SENTINEL|private\\secret/);
  assert.match(response.result.content[0].text, /redacted|truncated|safe/);
});

test('direct tool calls reject non-JSON-safe nested values with bounded deterministic errors', async () => {
  const server = createMcpServer({
    core: {
      validateReceipt: async (receipt) => ({ accepted: true, echo: receipt }),
    },
  });
  await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } },
  }, server.context);
  await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context);

  const cycle = {};
  cycle.self = cycle;
  class PrivateValue { constructor() { this.secret = 'WTP_JSON_UNSAFE_SENTINEL'; } }
  const invalidValues = [
    undefined,
    () => 'WTP_JSON_UNSAFE_SENTINEL',
    Symbol('WTP_JSON_UNSAFE_SENTINEL'),
    1n,
    new Date(),
    new Map([['secret', 'WTP_JSON_UNSAFE_SENTINEL']]),
    new PrivateValue(),
    cycle,
    Object.create({ inherited: 'WTP_JSON_UNSAFE_SENTINEL' }),
  ];

  for (const value of invalidValues) {
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'unsafe',
      method: 'tools/call',
      params: { name: 'worktreeproof_validate_receipt', arguments: { receipt: { nested: value } } },
    }, server.context);
    assert.deepEqual(response.error, { code: -32600, message: 'invalid request' });
    assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') < 512);
    assert.doesNotMatch(JSON.stringify(response), /WTP_JSON_UNSAFE_SENTINEL/);
  }

  const polluted = { receipt: { kind: 'ordinary' } };
  Object.defineProperty(polluted, '__proto__', { enumerable: true, value: 'WTP_JSON_UNSAFE_SENTINEL' });
  const unknown = await handleMcpMessage({
    jsonrpc: '2.0', id: 'unknown', method: 'tools/call',
    params: { name: 'worktreeproof_validate_receipt', arguments: polluted },
  }, server.context);
  assert.deepEqual(unknown.error, { code: -32600, message: 'invalid request' });
  assert.doesNotMatch(JSON.stringify(unknown), /WTP_JSON_UNSAFE_SENTINEL/);

  const ordinary = await handleMcpMessage({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'worktreeproof_validate_receipt', arguments: { receipt: { kind: 'ordinary', nested: { value: 1 } } } },
  }, server.context);
  assert.equal(ordinary.result.isError, false);
  assert.equal(ordinary.result.structuredContent.accepted, true);
});

test('MCP import is side-effect free and does not expose arbitrary command tools', async () => {
  const source = await readFile(new URL('../src/mcp/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process|exec|spawn|fetch|net|http/iu);
  for (const relative of ['src/mcp/framing.js', 'src/mcp/tools.js', 'src/mcp/server.js', 'src/mcp/index.js', 'bin/worktree-proof-mcp.js']) {
    const text = await readFile(path.join(root, relative), 'utf8');
    assert.doesNotMatch(text, /(?:^|\n)\s*import[^\n]*(?:child_process|(?:node:)?(?:net|http)|fetch|exec|spawn|shell|private)/iu, relative);
  }
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import './src/mcp/index.js';"], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
});

test('notifications never receive responses, while malformed JSON receives one parse error', async () => {
  const child = await spawnMcp();
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'unknown/method' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: { bad: true } })}\n`);
  child.stdin.write('{"jsonrpc":"2.0"\n');
  const parseError = await readLine(child.stdout);
  assert.equal(parseError.id, null);
  assert.equal(parseError.error.code, -32700);
  child.stdin.end();
  assert.equal((await once(child, 'close'))[0], 0);
});

test('transport oversize and incomplete UTF-8 fail closed without stdout responses', async () => {
  const child = await spawnMcp(['--max-message-bytes', '32']);
  child.stdin.write('x'.repeat(100));
  child.stdin.write(Buffer.from([0xc3]));
  child.stdin.end();
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
});

test('initialize negotiates the supported version and requires initialized notification before tools', async () => {
  const server = createMcpServer({ core: {} });
  let response = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, server.context);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, server.context);
  assert.equal(response.error.code, -32002);
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context), null);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, server.context);
  assert.ok(Array.isArray(response.result.tools));
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'notifications/initialized' }, server.context);
  assert.equal(response.error.code, -32600);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'worktreeproof_capabilities', arguments: {} } }, server.context);
  assert.equal(response.id, 5);
});

test('adapter failures are successful JSON-RPC tool errors and structuredContent is object-only', async () => {
  const server = createMcpServer({ core: {
    status: async () => { throw new Error('C:\\private\\stack WTP_TOKEN_SENTINEL'); },
    capabilities: async () => 'primitive',
    validateScope: async () => ['array'],
  } });
  await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, server.context);
  await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context);
  await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context);
  let response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worktreeproof_status', arguments: {} } }, server.context);
  assert.equal(response.result.isError, true);
  assert.equal(response.error, undefined);
  assert.doesNotMatch(JSON.stringify(response), /private|stack|WTP_TOKEN_SENTINEL/iu);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'worktreeproof_capabilities', arguments: {} } }, server.context);
  assert.equal(response.result.structuredContent, undefined);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'worktreeproof_validate_scope', arguments: { fileScope: 'src' } } }, server.context);
  assert.equal(response.result.structuredContent, undefined);
});

test('cancellation aborts an in-flight adapter and close resolves without waiting', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  let seenSignal;
  const server = createMcpServer({
    input,
    output,
    signal: controller.signal,
    core: {
      status: async (_args, context) => new Promise((resolve) => {
        seenSignal = context.signal;
        context.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
      }),
    },
  });
  const running = server.run();
  input.write(`${rpc(1, 'initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } })}`);
  await new Promise((resolve) => setImmediate(resolve));
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write(rpc(2, 'tools/call', { name: 'worktreeproof_status', arguments: {} }));
  for (let attempt = 0; attempt < 50 && !seenSignal; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(seenSignal);
  input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2,"reason":"fixture"}}\n');
  for (let attempt = 0; attempt < 50 && !seenSignal.aborted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(seenSignal.aborted, true);
  controller.abort();
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('server hung')), 250))]);
});

test('cancellation control preempts a saturated queue without duplicate responses', async () => {
  const input = new PassThrough();
  let outputText = '';
  const output = new Writable({ write(chunk, _encoding, callback) { outputText += chunk.toString('utf8'); callback(); } });
  const server = createMcpServer({
    input,
    output,
    limits: { maxInFlight: 1 },
    core: {
      status: async (_args, context) => {
        context.signal.addEventListener('abort', () => {}, { once: true });
        return new Promise(() => {});
      },
    },
  });
  const running = server.run();
  input.write(rpc(1, 'initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } }));
  for (let attempt = 0; attempt < 50 && !outputText.includes('"id":1'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write(rpc(2, 'tools/call', { name: 'worktreeproof_status', arguments: {} }));
  let aborted = false;
  for (let attempt = 0; attempt < 50 && !aborted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    aborted = [...server.context.inFlight.values()].some((call) => call.controller.signal.aborted);
  }
  assert.equal(aborted, false);
  input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}\n');
  for (let attempt = 0; attempt < 100 && !aborted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    aborted = [...server.context.inFlight.values()].some((call) => call.controller.signal.aborted);
  }
  assert.equal(aborted, true);
  input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":999}}\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const responses = outputText.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((value) => value.id === 2);
  assert.ok(responses.length <= 1);
  if (responses.length === 1) assert.deepEqual(responses[0].error, { code: -32800, message: 'request cancelled' });
  server.close();
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('server hung')), 250))]);

  const finished = createMcpServer({ core: { status: async () => ({ ok: true }) } });
  await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, finished.context);
  await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, finished.context);
  await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'worktreeproof_status', arguments: {} } }, finished.context);
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }, finished.context), null);
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } }, finished.context), null);
});

test('idless initialize is a silent invalid lifecycle notification and does not negotiate state', async () => {
  const server = createMcpServer({ core: {} });
  const params = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } };
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'initialize', params }, server.context), null);
  assert.equal(server.context.state.initialized, false);
  assert.equal(server.context.state.initializedNotification, false);
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context), null);
  let response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, server.context);
  assert.equal(response.error.code, -32002);

  response = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params }, server.context);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(server.context.state.initialized, true);
  assert.equal(server.context.state.initializedNotification, false);
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'initialize', params }, server.context), null);
  assert.equal(server.context.state.initializedNotification, false);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'initialize', params }, server.context);
  assert.equal(response.error.code, -32600);
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context), null);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, server.context);
  assert.ok(Array.isArray(response.result.tools));
});

test('direct and adapter values reject non-enumerable, accessor, symbol, and proxy keys before routing', async () => {
  const server = createMcpServer({ core: {} });
  const throwing = { jsonrpc: '2.0', id: 1, method: 'unknown/method' };
  let getterInvoked = false;
  Object.defineProperty(throwing, 'params', { enumerable: false, get() { getterInvoked = true; throw new Error('getter invoked'); } });
  let response = await handleMcpMessage(throwing, server.context);
  assert.equal(response.error.code, -32600);
  assert.equal(getterInvoked, false);

  const nested = {};
  Object.defineProperty(nested, 'hidden', { enumerable: false, get() { getterInvoked = true; throw new Error('nested getter invoked'); } });
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'unknown/method', params: nested }, server.context);
  assert.equal(response.error.code, -32600);
  assert.equal(getterInvoked, false);

  const symbolParams = { visible: true };
  symbolParams[Symbol('hidden')] = 'secret';
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'unknown/method', params: symbolParams }, server.context);
  assert.equal(response.error.code, -32600);

  const proxied = new Proxy({ jsonrpc: '2.0', id: 4, method: 'unknown/method' }, { ownKeys() { throw new Error('proxy trap'); } });
  response = await handleMcpMessage(proxied, server.context);
  assert.equal(response.error.code, -32600);

  let outputGetterInvoked = false;
  const adapterOutput = { safe: 'ok' };
  Object.defineProperty(adapterOutput, 'hidden', { enumerable: false, get() { outputGetterInvoked = true; throw new Error('adapter getter invoked'); } });
  const sanitized = sanitizeJson(adapterOutput);
  assert.equal(outputGetterInvoked, false);
  assert.doesNotMatch(JSON.stringify(sanitized), /adapter getter invoked/);
});

test('limits are immutable bounded values, backpressure is tolerated, and CLI help names every limit flag', async () => {
  assert.throws(() => createMcpServer({ limits: { maxMessageBytes: Number.MAX_SAFE_INTEGER } }), /limit|maximum|bounded/i);
  assert.equal(DEFAULT_MCP_LIMITS.maxMessageBytes, 16 * 1024);
  const writes = [];
  const output = new Writable({ write(chunk, _encoding, callback) { writes.push(chunk); setImmediate(callback); } });
  const input = new PassThrough();
  const server = createMcpServer({ input, output, limits: { maxOutputBytes: 512 } });
  const running = server.run();
  input.end();
  await running;
  assert.ok(writes.length <= 1);
  const help = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '--help'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(help.code, 0);
  for (const flag of ['--max-message-bytes', '--max-input-bytes', '--max-output-bytes', '--max-queued-messages']) assert.match(help.stderr, new RegExp(flag));
});

test('recursive direct message validation rejects accessors, cycles, dangerous keys, and proxies before routing', async () => {
  const server = createMcpServer({ core: {} });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
  await handleMcpMessage(init, server.context);
  const accessorParams = {};
  Object.defineProperty(accessorParams, 'danger', { enumerable: true, get() { throw new Error('getter invoked'); } });
  const cyclic = {};
  cyclic.loop = cyclic;
  const dangerous = { constructor: { nested: true } };
  const proxied = new Proxy({}, { ownKeys() { throw new Error('proxy trap'); } });
  for (const params of [accessorParams, { cyclic }, dangerous, proxied]) {
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: 'bad', method: 'unknown/method', params }, server.context);
    assert.equal(response.error.code, -32600);
  }
  const ordinary = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'notifications/initialized' }, server.context);
  assert.equal(ordinary.error.code, -32600);
});

test('redaction catches camel/snake auth keys and common bearer/key values without overmatching keyboard', async () => {
  const server = createMcpServer({ core: {
    status: async () => ({ apiKey: 'sk-test-secret', api_key: 'ghp_secret', authorization: 'Bearer abc', cookie: 'xoxb-secret', privateKey: '-----BEGIN PRIVATE KEY-----', keyboard: 'ordinary' }),
  } });
  await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, server.context);
  await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server.context);
  const response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worktreeproof_status', arguments: {} } }, server.context);
  const serialized = JSON.stringify(response);
  for (const secret of ['sk-test-secret', 'ghp_secret', 'Bearer abc', 'xoxb-secret', 'BEGIN PRIVATE KEY']) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(serialized, /keyboard/);
});
