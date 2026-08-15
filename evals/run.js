#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const CLI = join(REPO_ROOT, 'bin', 'worktree-proof.js');
const SEED = 'worktree-proof-evals-v1';

function runCli(repo, args) {
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.error) throw new Error(`CLI failed to start: ${child.error.message}`);
  const stdout = String(child.stdout ?? '').trim();
  const stderr = String(child.stderr ?? '').trim();
  let envelope = null;
  try {
    envelope = stdout ? JSON.parse(stdout) : null;
  } catch {
    envelope = null;
  }
  return { status: child.status, envelope, stdout, stderr };
}

function succeeded(run) {
  return run.status === 0 && run.envelope?.ok === true;
}

function failedClosed(run, expectedErrorCode) {
  return (
    run.status !== 0 &&
    run.envelope?.ok === false &&
    run.envelope?.error?.code === expectedErrorCode
  );
}

const CHECKS = [
  {
    id: 'doctor-reports-missing-repo-truthfully',
    run: ({ repo }) => {
      const result = runCli(repo, ['doctor', '--repo', join(repo, 'missing'), '--json']);
      return succeeded(result) && result.envelope?.result?.git === false;
    },
  },
  {
    id: 'plan-rejects-out-of-scope-path',
    run: ({ repo }) => {
      const outside = join(tmpdir(), 'worktree-proof-outside-scope');
      const result = runCli(repo, [
        'plan', 'eval-oos', '--scope', outside, '--repo', repo, '--json',
      ]);
      return failedClosed(result, 'ERR_INVALID_FILE_SCOPE');
    },
  },
  {
    id: 'duplicate-reserve-rejected',
    run: ({ repo }) => {
      const args = ['reserve', 'eval-dup', '--scope', 'docs/', '--repo', repo, '--json'];
      const first = runCli(repo, args);
      const second = runCli(repo, args);
      return succeeded(first) && failedClosed(second, 'ERR_LEASE_CONFLICT');
    },
  },
  {
    id: 'run-without-reservation-fails-closed',
    run: ({ repo }) => {
      const result = runCli(repo, [
        'run', 'eval-ghost', '--repo', repo, '--json', '--', 'node', '--version',
      ]);
      return failedClosed(result, 'ERR_PROTOCOL');
    },
  },
  {
    id: 'close-without-receipt-fails-closed',
    run: ({ repo }) => {
      const result = runCli(repo, ['close', 'eval-ghost', '--repo', repo, '--json']);
      return failedClosed(result, 'ERR_MISSING_CLOSURE_RECEIPT');
    },
  },
  {
    id: 'release-before-close-fails-closed',
    run: ({ repo }) => {
      const result = runCli(repo, ['release', 'eval-ghost', '--repo', repo, '--json']);
      return failedClosed(result, 'ERR_LEASE_NOT_FOUND');
    },
  },
  {
    id: 'unknown-command-fails-deterministically',
    run: ({ repo }) => {
      const result = runCli(repo, ['frobnicate', '--repo', repo, '--json']);
      return failedClosed(result, 'ERR_INVALID_REQUEST');
    },
  },
  {
    id: 'lane-lifecycle-closure-receipt-validated',
    run: async ({ repo }) => {
      const laneId = 'eval-lifecycle';
      const scope = 'docs/';
      if (!succeeded(runCli(repo, ['plan', laneId, '--scope', scope, '--repo', repo, '--json']))) {
        return false;
      }
      if (!succeeded(runCli(repo, ['reserve', laneId, '--scope', scope, '--repo', repo, '--json']))) {
        return false;
      }
      const run = runCli(repo, [
        'run', laneId, '--repo', repo, '--json', '--', 'node', '--version',
      ]);
      if (!succeeded(run) || run.envelope?.result?.ok !== true || run.envelope?.result?.status !== 0) {
        return false;
      }
      const status = runCli(repo, ['status', '--repo', repo, '--json']);
      if (!succeeded(status) || !Array.isArray(status.envelope?.result?.active) || status.envelope.result.active.length !== 1) {
        return false;
      }
      const receiptPath = join(repo, 'receipt.json');
      await writeFile(receiptPath, `${JSON.stringify({
        schemaVersion: '1',
        laneId,
        outcome: 'abandoned',
        closedAt: '2026-01-01T12:00:00Z',
        branchDeleted: true,
        worktreeClean: true,
        reason: 'Disposable eval lane; no merge was attempted.',
      })}\n`, 'utf8');
      if (!succeeded(runCli(repo, ['close', laneId, '--receipt', receiptPath, '--repo', repo, '--json']))) {
        return false;
      }
      if (!succeeded(runCli(repo, ['release', laneId, '--repo', repo, '--json']))) {
        return false;
      }
      const validation = runCli(repo, ['validate', '.', '--repo', repo, '--json']);
      return (
        succeeded(validation)
        && validation.envelope?.result?.valid === true
        && validation.envelope?.result?.receipts === 1
      );
    },
  },
  {
    id: 'cleanup-dry-run-is-preview-only',
    run: async ({ repo }) => {
      const laneId = 'eval-cleanup';
      const scope = 'docs/';
      if (!succeeded(runCli(repo, ['plan', laneId, '--scope', scope, '--repo', repo, '--json']))) {
        return false;
      }
      if (!succeeded(runCli(repo, ['reserve', laneId, '--scope', scope, '--repo', repo, '--json']))) {
        return false;
      }
      const receiptPath = join(repo, 'receipt.json');
      await writeFile(receiptPath, `${JSON.stringify({
        schemaVersion: '1',
        laneId,
        outcome: 'abandoned',
        closedAt: '2026-01-01T12:00:00Z',
        branchDeleted: true,
        worktreeClean: true,
        reason: 'Disposable eval lane; no merge was attempted.',
      })}\n`, 'utf8');
      if (!succeeded(runCli(repo, ['close', laneId, '--receipt', receiptPath, '--repo', repo, '--json']))) {
        return false;
      }
      const cleanup = runCli(repo, ['cleanup', '--dry-run', '--repo', repo, '--json']);
      return (
        succeeded(cleanup)
        && cleanup.envelope?.result?.planned === true
        && cleanup.envelope?.result?.submitted === false
      );
    },
  },
];

async function main() {
  const results = [];
  let failed = 0;
  for (const check of CHECKS) {
    const repo = await mkdtemp(join(tmpdir(), 'worktree-proof-evals-'));
    let passed;
    try {
      passed = await check.run({ repo });
    } catch (error) {
      console.error(`[eval] ${check.id} threw: ${error.message}`);
      passed = false;
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
    results.push({ id: check.id, passed });
    if (!passed) failed += 1;
    console.error(`[eval] ${check.id}: ${passed ? 'PASS' : 'FAIL'}`);
  }
  console.log(JSON.stringify({ schemaVersion: '1', seed: SEED, results }, null, 2));
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`eval failed: ${error.message}`);
  process.exitCode = 1;
});