#!/usr/bin/env node

import { createMcpServer } from '../src/mcp/server.js';
import { listCapabilities } from '../src/protocol/index.js';
import { normalizeFileScope } from '../src/scope.js';

const VALUE_OPTIONS = new Map([
  ['--max-message-bytes', 'maxMessageBytes'],
  ['--max-input-bytes', 'maxInputBytes'],
  ['--max-output-bytes', 'maxOutputBytes'],
  ['--max-queued-messages', 'maxQueuedMessages'],
]);

function usageError(message) {
  const error = new Error(message);
  error.code = 2;
  return error;
}

function parseArgs(argv) {
  const options = { enableLeaseMutation: false, limits: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--enable-lease-mutation') {
      options.enableLeaseMutation = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    const key = VALUE_OPTIONS.get(token.split('=', 1)[0]);
    if (!key) throw usageError('unknown option');
    const inline = token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined;
    const value = inline ?? argv[++index];
    if (value === undefined || !/^[0-9]+$/u.test(value)) throw usageError('invalid numeric option');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw usageError('invalid numeric option');
    options.limits[key] = number;
  }
  return options;
}

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stderr.write('worktree-proof-mcp [--enable-lease-mutation] [--max-message-bytes N] [--max-output-bytes N]\n');
    process.exitCode = 0;
  } else {
    const server = createMcpServer({
      input: process.stdin,
      output: process.stdout,
      error: process.stderr,
      signal: controller.signal,
      core: {
        capabilities: () => ({ protocolVersion: '2025-11-25', capabilities: listCapabilities() }),
        validateScope: (value) => normalizeFileScope(value),
      },
      limits: options.limits,
      enableLeaseMutation: options.enableLeaseMutation,
    });
    await server.run();
  }
} catch (error) {
  process.stderr.write(`${error?.code === 2 ? 'usage error' : 'mcp transport error'}\n`);
  process.exitCode = error?.code === 2 ? 2 : 1;
}
