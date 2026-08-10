#!/usr/bin/env node

import { main } from '../src/cli.js';

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = Number.isInteger(code) ? code : 1;
} catch (error) {
  // Keep the executable deterministic and quiet about arbitrary runtime data.
  process.stderr.write(`error: ${error?.message || 'operation failed'}\n`);
  process.exitCode = 1;
}

