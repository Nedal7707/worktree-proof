import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  MCP_PROTOCOL_VERSION,
  createMcpServer,
  handleMcpMessage,
} from '../src/mcp/server.js';
import { listMcpTools } from '../src/mcp/tools.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, 'bin', 'worktree-proof-mcp.js');

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let text = '';
    const onData = (chunk) => {
      text += chunk.toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      stream.off('data', onData);
      resolve(JSON.parse(text.slice(0, newline).replace(/\r$/u, '')));
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

  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.end();
  assert.equal((await once(child, 'close'))[0], 0);
});

test('pre-initialize, unknown method/tool, malformed params, and mutation confirmation fail safely', async () => {
  const server = createMcpServer({ core: {} });
  let response = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, server.context);
  assert.equal(response.error.code, -32002);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'wrong' } }, server.context);
  assert.equal(response.error.code, -32602);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, server.context);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'nope' }, server.context);
  assert.equal(response.error.code, -32601);
  response = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'worktreeproof_nope', arguments: {} } }, server.context);
  assert.equal(response.error.code, -32601);

  const enabled = createMcpServer({
    enableLeaseMutation: true,
    core: { reserveLease: async () => ({ ok: true, owner: 'private-owner' }) },
  });
  await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, enabled.context);
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
    assert.deepEqual(response.error, { code: -32602, message: 'invalid params' });
    assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') < 512);
    assert.doesNotMatch(JSON.stringify(response), /WTP_JSON_UNSAFE_SENTINEL/);
  }

  const polluted = { receipt: { kind: 'ordinary' } };
  Object.defineProperty(polluted, '__proto__', { enumerable: true, value: 'WTP_JSON_UNSAFE_SENTINEL' });
  const unknown = await handleMcpMessage({
    jsonrpc: '2.0', id: 'unknown', method: 'tools/call',
    params: { name: 'worktreeproof_validate_receipt', arguments: polluted },
  }, server.context);
  assert.deepEqual(unknown.error, { code: -32602, message: 'invalid params' });
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
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import './src/mcp/index.js';"], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
});
