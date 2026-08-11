#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = join(REPO_ROOT, 'bin', 'worktree-proof.js');
const DEFAULT_ITERATIONS = 3;
const MAX_ITERATIONS = 25;
const OPERATIONS = [
  'doctor',
  'plan',
  'reserve',
  'run',
  'status',
  'close',
  'release',
  'validate',
  'cleanup',
];

function iterationsFromArgv(argv) {
  const index = argv.indexOf('--iterations');
  if (index === -1) return DEFAULT_ITERATIONS;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ITERATIONS) {
    throw new Error(`--iterations must be an integer from 1 through ${MAX_ITERATIONS}`);
  }
  return value;
}

function runCli(repo, args) {
  const started = performance.now();
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  if (child.error) throw new Error(`CLI failed to start: ${child.error.message}`);
  const stdout = String(child.stdout ?? '').trim();
  const stderr = String(child.stderr ?? '').trim();
  if (child.status !== 0) {
    throw new Error(`CLI exited ${child.status}: ${stderr || stdout || 'no output'}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`CLI did not emit JSON: ${error.message}`);
  }
  if (envelope.ok !== true) {
    throw new Error(`CLI returned an unsuccessful envelope: ${stdout}`);
  }
  return { elapsedMs, result: envelope.result };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(3))
    : sorted[middle];
}

function summarize(samples) {
  return {
    samples: samples.length,
    minMs: Number(Math.min(...samples).toFixed(3)),
    medianMs: median(samples),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

async function runIteration(index, samples) {
  const repo = await mkdtemp(join(tmpdir(), `worktree-proof-benchmark-${index}-`));
  const laneId = `docs-benchmark-${index}`;
  const record = (name, result) => {
    samples[name].push(result.elapsedMs);
    return result.result;
  };
  try {
    record('doctor', runCli(repo, ['doctor', '--repo', repo, '--json']));
    record('plan', runCli(repo, [
      'plan', laneId, '--scope', 'docs/benchmarks/', '--repo', repo, '--json',
    ]));
    record('reserve', runCli(repo, [
      'reserve', laneId, '--scope', 'docs/benchmarks/', '--repo', repo, '--json',
    ]));
    const run = record('run', runCli(repo, [
      'run', laneId, '--repo', repo, '--json', '--', 'node', '--version',
    ]));
    if (run?.ok !== true || run?.status !== 0) {
      throw new Error('run did not report a successful node --version invocation');
    }
    const status = record('status', runCli(repo, ['status', '--repo', repo, '--json']));
    if (!Array.isArray(status?.active) || status.active.length !== 1) {
      throw new Error('status did not report the reserved lane');
    }

    const receiptPath = join(repo, 'receipt.json');
    await writeFile(receiptPath, `${JSON.stringify({
      schemaVersion: '1',
      laneId,
      outcome: 'abandoned',
      closedAt: '2026-01-01T12:00:00Z',
      branchDeleted: true,
      worktreeClean: true,
      reason: 'Disposable benchmark lane; no merge was attempted.',
    })}\n`, 'utf8');
    record('close', runCli(repo, [
      'close', laneId, '--receipt', receiptPath, '--repo', repo, '--json',
    ]));
    record('release', runCli(repo, ['release', laneId, '--repo', repo, '--json']));
    const validation = record('validate', runCli(repo, [
      'validate', '.', '--repo', repo, '--json',
    ]));
    if (validation?.valid !== true || validation.receipts !== 1) {
      throw new Error('validate did not accept the generated closure receipt');
    }
    const cleanup = record('cleanup', runCli(repo, [
      'cleanup', '--dry-run', '--repo', repo, '--json',
    ]));
    if (cleanup?.planned !== true || cleanup?.submitted !== false) {
      throw new Error('cleanup --dry-run was not preview-only');
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function main() {
  const iterations = iterationsFromArgv(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  const samples = Object.fromEntries(OPERATIONS.map((name) => [name, []]));
  for (let index = 1; index <= iterations; index += 1) {
    await runIteration(index, samples);
  }
  console.log(JSON.stringify({
    benchmark: 'worktree-proof-local-flow',
    packageVersion: packageJson.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    iterations,
    operations: Object.fromEntries(OPERATIONS.map((name) => [name, summarize(samples[name])])),
    assertions: {
      everyCommandReturnedOkJson: true,
      closureReceiptValidated: true,
      cleanupWasPreviewOnly: true,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(`benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
