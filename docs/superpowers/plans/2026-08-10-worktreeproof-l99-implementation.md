# WorktreeProof L99 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship WorktreeProof v0.2.0 as a zero-runtime-dependency, standards-first guardrail stack with a stable protocol, MCP stdio, portable agent integrations, reproducible evaluations, supply-chain evidence, and verified Codex/Claude installation.

**Architecture:** Keep the existing deterministic local core authoritative. Add versioned edge modules for protocol envelopes, capability negotiation, manifests, adapters, and MCP stdio; every edge calls existing core APIs and shares schemas, redaction, and explicit mutation controls. Release in four terminal PRs, then publish one reviewed tag and migrate local Codex/Claude configuration from verified backups.

**Tech Stack:** Node.js 20+ ESM and built-ins, JSON Schema 2020-12 documents, MCP 2025-11-25 stdio/Tools, Agent Skills specification, Node test runner, GitHub Actions, CycloneDX JSON, npm provenance, GitHub artifact attestations.

## Global Constraints

- Release version is `0.2.0`; protocol name is `worktreeproof`; protocol version is `1.0`; schema version is `1`.
- Preserve every documented v0.1 CLI/API behavior unless a regression test proves an intentional compatible extension.
- Runtime dependency count remains exactly zero; imports perform no writes, process launches, network calls, credential reads, or background work.
- MCP uses newline-delimited UTF-8 JSON-RPC over stdio only, writes only MCP messages to stdout, opens no listener, and exits when stdin closes.
- Agent Skills conform to https://agentskills.io/specification. MCP behavior conforms to revision `2025-11-25` Tools and stdio transport.
- No edge launches another agent, chooses a model, changes reasoning, forwards hidden context, reads credentials, creates an always-on daemon, or executes a shell command string.
- Mutation is explicit, schema-validated, path-contained, and confirmation-gated. Dirty or ambiguous state fails closed and remains recoverable.
- Machine output is deterministic JSON, bounded, redacted, and versioned. Unsupported capabilities return stable public error codes.
- Windows and Linux are first-class. Current local execution uses one worker because of measured RAM/disk pressure; public capacity remains configurable and resource-limited.
- Every implementation task follows red-green-refactor. A branch, commit, or PR is intermediate; each subsystem checkpoint ends merged on `origin/main` with public checks.

## File Responsibility Map

- `src/leases.js`, `src/cli.js`: safe stale-lease inspection/recovery and command routing.
- `src/protocol/*`: public versions, errors, envelopes, capabilities, deterministic serialization.
- `src/manifest.js`, `src/adapters.js`, `src/migration.js`: generic manifests, client previews, reversible local migration plans.
- `src/mcp/*`, `bin/worktree-proof-mcp.js`: bounded MCP JSON-RPC framing, lifecycle, and tool allowlist.
- `schemas/*`: closed machine contracts for protocol, capabilities, manifests, migration, and evidence.
- `evals/*`, `benchmarks/*`: disposable real-Git scenarios and seeded non-competitive measurements.
- `scripts/*`, `.github/workflows/*`: package inventory, SBOM, checksums, security controls, attestations, and release.
- `docs/*`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`: public behavior, support, roadmap, decisions, and contribution surfaces.

---

### Task 1: Supported stale-lease recovery

**Files:**
- Modify: `src/leases.js`
- Modify: `src/cli.js`
- Modify: `src/index.js`
- Modify: `package.json`
- Test: `test/leases.test.js`
- Test: `test/cli.test.js`

**Interfaces:**
- Produces: `inspectLeaseRegistry(registryPath, options) -> Promise<{version, leases, stale}>`.
- Produces: `recoverExpiredLease(registryPath, {laneId, reason, confirm}, options) -> Promise<Lease>`.
- Produces: `worktree-proof leases inspect|recover <laneId> --reason <text> --confirm`.

- [ ] **Step 1: Write the failing API test**

```js
test('expired leases are inspectable and recoverable only with confirmation', async (t) => {
  const path = await expiredRegistry(t, 'blocked');
  const report = await inspectLeaseRegistry(path, { clock: () => NOW });
  assert.deepEqual(report.stale.map(({ laneId }) => laneId), ['blocked']);
  await assert.rejects(
    recoverExpiredLease(path, { laneId: 'blocked', reason: 'terminal work merged', confirm: false }, { clock: () => NOW }),
    (error) => error.code === 'ERR_CONFIRM_REQUIRED',
  );
  const lease = await recoverExpiredLease(
    path,
    { laneId: 'blocked', reason: 'terminal work merged', confirm: true },
    { clock: () => NOW },
  );
  assert.equal(lease.status, 'released');
  assert.equal((await inspectLeaseRegistry(path, { clock: () => NOW })).stale.length, 0);
});
```

- [ ] **Step 2: Run the red test**

Run: `node --test test/leases.test.js --test-name-pattern="expired leases are inspectable"`
Expected: FAIL because `inspectLeaseRegistry` is not exported.

- [ ] **Step 3: Implement the minimal recovery path**

```js
export async function recoverExpiredLease(registryPath, input, options = {}) {
  if (input?.confirm !== true) throw new LeaseError('confirmation required', 'ERR_CONFIRM_REQUIRED');
  return withRegistryLock(registryPath, async () => {
    const now = currentTime(options.clock ?? Date.now);
    const state = await readRegistryForInspection(registryPath, now);
    const target = selectSingleExpired(state, input.laneId, now);
    const releasedAt = new Date(now).toISOString();
    const released = { ...target, active: false, status: 'released', releasedAt, updatedAt: releasedAt, reason: token(input.reason, 'reason') };
    await writeRegistryFile(registryPath, replaceLease(state, released));
    return released;
  }, options);
}
```

- [ ] **Step 4: Add CLI refusal/redaction tests and route `leases inspect|recover`**

Run: `node --test test/leases.test.js test/cli.test.js`
Expected: PASS; output redacts session and owner fields, and recovery without `--confirm` exits `1`.

- [ ] **Step 5: Verify and commit**

Run: `npm run check`
Commit: `fix: add explicit stale lease recovery`

---

### Task 2: Protocol, schemas, capabilities, CLI, and public exports

**Files:**
- Create: `src/protocol/constants.js`
- Create: `src/protocol/errors.js`
- Create: `src/protocol/envelope.js`
- Create: `src/protocol/capabilities.js`
- Create: `src/protocol/index.js`
- Create: `schemas/protocol-request.schema.json`
- Create: `schemas/protocol-response.schema.json`
- Create: `schemas/capabilities.schema.json`
- Modify: `src/cli.js`
- Modify: `src/index.js`
- Modify: `package.json`
- Test: `test/protocol.test.js`
- Test: `test/cli.test.js`

**Interfaces:**
- Produces: `createEnvelope({ok, command, requestId, result, warnings, error})`.
- Produces: `listCapabilities() -> ReadonlyArray<{id, version, mutating}>`.
- Produces: `negotiateCapabilities({protocolVersion, requested})`.
- Produces: `worktree-proof capabilities --protocol-version 1.0 --json`.

- [ ] **Step 1: Write the failing deterministic-envelope test**

```js
test('protocol envelopes and capabilities are stable and sorted', () => {
  const envelope = createEnvelope({ ok: true, command: 'capabilities', requestId: 'req-1', result: listCapabilities() });
  assert.equal(envelope.protocol, 'worktreeproof');
  assert.equal(envelope.protocolVersion, '1.0');
  assert.deepEqual(envelope.result.map(({ id }) => id), [...envelope.result.map(({ id }) => id)].sort());
  assert.ok(Object.isFrozen(envelope));
});
```

- [ ] **Step 2: Run the red test**

Run: `node --test test/protocol.test.js`
Expected: FAIL with module-not-found for `src/protocol/index.js`.

- [ ] **Step 3: Implement versions, errors, canonical envelopes, and negotiation**

```js
export const PROTOCOL = 'worktreeproof';
export const PROTOCOL_VERSION = '1.0';
export const SCHEMA_VERSION = '1';
export function createEnvelope(input) {
  return deepFreeze({ ok: input.ok, protocol: PROTOCOL, protocolVersion: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION, command: input.command, requestId: normalizeRequestId(input.requestId), ...(input.ok ? { result: input.result ?? {} } : { error: normalizePublicError(input.error) }), warnings: [...(input.warnings ?? [])] });
}
```

- [ ] **Step 4: Add closed schemas, CLI exit-code tests, and package subpath exports**

Run: `node --test test/protocol.test.js test/cli.test.js`
Expected: PASS; JSON stdout is one document, usage errors exit `2`, operational refusals exit `1`.

- [ ] **Step 5: Terminal checkpoint A**

Run: `npm run check && npm pack --dry-run`
Commit: `feat: add WorktreeProof protocol and capabilities`
Open a ready PR containing Tasks 1–2, require CI/CodeQL/dependency review, merge it, fetch, and record `git rev-parse origin/main` plus public check URLs.

---

### Task 3: Generic manifests, portable skills, and client preview adapters

**Files:**
- Create: `src/manifest.js`
- Create: `src/migration.js`
- Create: `schemas/integration-manifest.schema.json`
- Create: `schemas/migration-plan.schema.json`
- Create: `templates/worktree-proof.manifest.json`
- Create: `skills/protocol-client/SKILL.md`
- Create: `skills/protocol-client/agents/openai.yaml`
- Modify: `src/adapters.js`
- Modify: `src/init.js`
- Modify: `src/index.js`
- Modify: `src/cli.js`
- Test: `test/interop.test.js`
- Test: `test/migration.test.js`
- Test: `test/skill-structure.test.js`

**Interfaces:**
- Produces: `createIntegrationManifest({client, capabilities, scope})`.
- Produces: `renderClientPreview('generic'|'codex'|'claude', manifest)`.
- Produces: `planLocalMigration({home, clients, artifact})`; plans only, never writes.
- Produces: `applyLocalMigration(plan, {confirm, backupRoot})`; writes only WorktreeProof-owned targets after backup.

- [ ] **Step 1: Write the failing vendor-neutral adapter test**

```js
test('all client previews preserve one manifest and never select a model', () => {
  const manifest = createIntegrationManifest({ client: 'any-cli', capabilities: ['scope.validate'], scope: ['src/'] });
  for (const target of ['generic', 'codex', 'claude']) {
    const preview = renderClientPreview(target, manifest);
    assert.equal(preview.manifestHash, manifest.manifestHash);
    assert.doesNotMatch(JSON.stringify(preview), /model|reasoning|token|cookie|password/i);
  }
});
```

- [ ] **Step 2: Run the red test**

Run: `node --test test/interop.test.js`
Expected: FAIL because `createIntegrationManifest` is absent.

- [ ] **Step 3: Implement canonical manifests and preview-only adapters**

```js
export function createIntegrationManifest(input) {
  const body = canonicalize({ protocol: 'worktreeproof', protocolVersion: '1.0', client: normalizeClient(input.client), capabilities: sortedCapabilities(input.capabilities), scope: normalizeScopes(input.scope) });
  return Object.freeze({ ...body, manifestHash: sha256(canonicalJson(body)) });
}
```

- [ ] **Step 4: Implement reversible migration planning with ownership markers**

Run: `node --test test/interop.test.js test/migration.test.js test/skill-structure.test.js`
Expected: PASS; unowned collisions refuse, preview is default, apply requires confirmation, and rollback restores byte-identical backups.

- [ ] **Step 5: Verify and commit**

Run: `npm run check`
Commit: `feat: add portable client manifests and adapters`

---

### Task 4: MCP 2025-11-25 stdio server

**Files:**
- Create: `src/mcp/framing.js`
- Create: `src/mcp/tools.js`
- Create: `src/mcp/server.js`
- Create: `src/mcp/index.js`
- Create: `bin/worktree-proof-mcp.js`
- Modify: `src/index.js`
- Modify: `package.json`
- Test: `test/mcp-framing.test.js`
- Test: `test/mcp-server.test.js`

**Interfaces:**
- Produces: `createMcpServer({input, output, error, core, limits, signal})`.
- Produces: `handleMcpMessage(message, context)` for `initialize`, `notifications/initialized`, `tools/list`, and allowlisted `tools/call`.
- Produces bin: `worktree-proof-mcp`.

- [ ] **Step 1: Write the failing subprocess test**

```js
test('MCP stdio initializes, lists read-only tools, and emits only JSON-RPC', async () => {
  const child = spawn(process.execPath, ['bin/worktree-proof-mcp.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\n');
  const reply = JSON.parse(await readLine(child.stdout));
  assert.equal(reply.result.protocolVersion, '2025-11-25');
  assert.equal(reply.result.capabilities.tools.listChanged, false);
  child.stdin.end();
  assert.equal(await exitCode(child), 0);
});
```

- [ ] **Step 2: Run the red test**

Run: `node --test test/mcp-framing.test.js test/mcp-server.test.js`
Expected: FAIL because the MCP bin is missing.

- [ ] **Step 3: Implement bounded newline framing and lifecycle**

```js
export function createLineDecoder({ maxBytes = 16_384, onMessage }) {
  let buffered = '';
  return (chunk) => {
    buffered += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffered) > maxBytes) throw new McpError(-32600, 'message too large');
    for (const line of takeCompleteLines(() => buffered, (next) => { buffered = next; })) onMessage(parseJsonRpc(line));
  };
}
```

- [ ] **Step 4: Add tool allowlist and explicit mutation confirmation**

Expose `worktreeproof_capabilities`, `worktreeproof_validate_scope`, `worktreeproof_status`, and `worktreeproof_validate_receipt`. A mutating lease tool is listed only when explicitly enabled and still requires `confirm: true`.

Run: `node --test test/mcp-framing.test.js test/mcp-server.test.js`
Expected: PASS for fragmented input, multiple lines, oversize refusal, malformed JSON-RPC, cancellation, closed stdin, redacted stderr, and no arbitrary command tool.

- [ ] **Step 5: Terminal checkpoint B**

Run: `npm run check && npm pack --dry-run`
Commit: `feat: add bounded MCP stdio interoperability`
Open a ready PR containing Tasks 3–4, merge only with all public checks green, fetch, and prove protocol/client/MCP files from `origin/main`.

---

### Task 5: Real-repository evaluations and deterministic benchmarks

**Files:**
- Create: `evals/run.js`
- Create: `evals/scenarios.js`
- Create: `evals/fixtures.js`
- Create: `benchmarks/run.js`
- Create: `schemas/eval-result.schema.json`
- Create: `schemas/benchmark-result.schema.json`
- Modify: `package.json`
- Test: `test/evals.test.js`
- Test: `test/benchmarks.test.js`

**Interfaces:**
- Produces: `runEvaluations({seed, platform, scenarios, tempRoot}) -> Promise<EvalReport>`.
- Produces: `runBenchmarks({seed, warmup, iterations, output}) -> Promise<BenchmarkReport>`.

- [ ] **Step 1: Write the failing hermetic-eval test**

```js
test('real Git evaluations are seeded, disposable, and redact sentinels', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'wtp-eval-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const report = await runEvaluations({ seed: 'l99', scenarios: ['lock-race', 'dirty-rescue', 'privacy'], tempRoot });
  assert.deepEqual(report.results.map(({ id }) => id), ['dirty-rescue', 'lock-race', 'privacy']);
  assert.doesNotMatch(JSON.stringify(report), /WTP_SECRET_SENTINEL/);
  assert.ok(report.results.every(({ repositoryRemoved }) => repositoryRemoved));
});
```

- [ ] **Step 2: Run the red test**

Run: `node --test test/evals.test.js test/benchmarks.test.js`
Expected: FAIL because `evals/run.js` is absent.

- [ ] **Step 3: Implement disposable real-Git scenarios**

Scenarios: concurrent reserve/recover race; interrupted atomic write; dirty and rescue worktree; stale/malformed/future state; traversal/symlink plus Windows junction/reparse refusal; privacy sentinel across CLI/API/MCP/adapters; injected CPU/RAM/disk backpressure; bounded output and timeout. Skip only an OS-inapplicable primitive and record the exact reason.

```js
export async function runEvaluations(options) {
  const selected = [...options.scenarios].sort();
  const results = [];
  for (const id of selected) results.push(await runScenario(id, createDisposableGitFixture(options)));
  return freezeReport({ schemaVersion: '1', seed: options.seed, results });
}
```

- [ ] **Step 4: Implement non-competitive benchmarks**

Run: `node --test test/evals.test.js test/benchmarks.test.js && npm run evals -- --seed l99 && npm run benchmark -- --seed l99`
Expected: PASS; JSON records seed, OS, Node, iterations, elapsed time, observable resources, and contains no competitor ranking.

- [ ] **Step 5: Verify and commit**

Run: `npm run check`
Commit: `test: add reproducible recovery and resource evaluations`

---

### Task 6: Supply chain, packaging, documentation, and community readiness

**Files:**
- Create: `scripts/package-inventory.js`
- Create: `scripts/generate-sbom.js`
- Create: `scripts/checksums.js`
- Create: `.github/workflows/scorecard.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`
- Create: `.github/ISSUE_TEMPLATE/feature.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `SUPPORT.md`
- Create: `ROADMAP.md`
- Create: `docs/INTEROPERABILITY.md`
- Create: `docs/MCP.md`
- Create: `docs/EVALUATIONS.md`
- Create: `docs/LAUNCH-POLICY.md`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CONTRIBUTING.md`
- Modify: `GOVERNANCE.md`
- Modify: `docs/RELEASE-CHECKLIST.md`
- Modify: `package.json`
- Test: `test/package-integrity.test.js`
- Test: `test/community-surfaces.test.js`

**Interfaces:**
- Produces: `npm run package:inventory`, `npm run sbom`, and `npm run checksums -- <artifacts...>`.
- Produces: release artifacts `worktree-proof-0.2.0.tgz`, `bom.cdx.json`, and `SHA256SUMS` from one tag commit.

- [ ] **Step 1: Write the failing package-integrity test**

```js
test('packed release is allowlisted, dependency-free, and side-effect free', async () => {
  const inventory = await inspectPack({ dryRun: true });
  assert.equal(inventory.runtimeDependencies, 0);
  assert.equal(inventory.lifecycleScripts.length, 0);
  assert.deepEqual(inventory.unexpectedFiles, []);
  assert.doesNotMatch(inventory.files.join('\n'), /(^|\/)(test|\.worktree-proof|node_modules|\.env)(\/|$)/);
});
```

- [ ] **Step 2: Run the red test**

Run: `node --test test/package-integrity.test.js test/community-surfaces.test.js`
Expected: FAIL because the inventory and community surfaces are missing.

- [ ] **Step 3: Implement deterministic inventory, CycloneDX, and checksums**

```js
export function createBom(pkg, files) {
  return canonicalize({ bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${deterministicUuid(pkg.name, pkg.version)}`, version: 1, metadata: { component: { type: 'application', name: pkg.name, version: pkg.version } }, components: [], properties: [{ name: 'worktreeproof:files-sha256', value: hashInventory(files) }] });
}
```

- [ ] **Step 4: Add pinned least-privilege security/release workflows and honest docs**

Scorecard uploads SARIF; existing CodeQL/dependency review remain required; secret scanning and push protection are documented as repository settings; release workflow builds once, packs, tests the tarball, creates SBOM/checksums, attests artifacts, and publishes npm with provenance only from a protected tag/environment. No install or postinstall script is added.

Run: `npm run check && npm run sbom && npm pack --dry-run`
Expected: PASS; templates contain no engagement request, guarantee, or vendor affiliation claim.

- [ ] **Step 5: Terminal checkpoint C**

Commit: `chore: harden WorktreeProof release and community surfaces`
Open a ready PR containing Tasks 5–6, require CI/CodeQL/dependency review/Scorecard/package checks, merge, fetch, and record public workflow URLs plus `origin/main` SHA. This closes L99-02 and L99-03 only when their complete evidence is present.

---

### Task 7: Publish v0.2.0 and migrate local Codex, Claude, and MCP

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Create: `scripts/release-preflight.js`
- Test: `test/release-preflight.test.js`
- Create: `docs/releases/v0.2.0.md`
- Create: `evidence/v0.2.0-release.json`
- Create: `evidence/v0.2.0-local-install.json`

**Interfaces:**
- Consumes: exact reviewed `origin/main` commit and release workflow from Task 6.
- Produces: `npm run release:preflight`, Git tag `v0.2.0`, npm package, GitHub release, SBOM, checksums, attestations, and redacted install evidence.

- [ ] **Step 1: Write and run the release preflight as a failing gate**

```js
assert.equal(pkg.version, '0.2.0');
assert.equal(head, originMain);
assert.equal(gitStatus, '');
assert.equal(openReleaseBlockers.length, 0);
assert.equal(packageInventory.unexpectedFiles.length, 0);
```

Run: `npm run release:preflight -- --version 0.2.0`
Expected before version files are updated: FAIL with `ERR_VERSION_MISMATCH`.

- [ ] **Step 2: Update version/release notes and run clean-checkout proof**

Run: `npm ci && npm run check && npm run test:conformance && npm run evals -- --seed l99 && npm run benchmark -- --seed l99 && npm run sbom && npm pack --dry-run`
Expected: PASS from a clean checkout with zero audit vulnerabilities.

- [ ] **Step 3: Terminal checkpoint D and publish**

Commit: `release: prepare WorktreeProof v0.2.0`
Open and merge the release PR, prove `origin/main`, create signed/annotated tag `v0.2.0`, trigger the protected release workflow, and verify registry/release downloads against SHA-256, SBOM, provenance, and GitHub attestations. If npm requires owner login or trusted-publisher setup, stop at that exact login page without handling credentials.

- [ ] **Step 4: Test exact artifacts in clean temporary homes**

Install from npm and the downloaded GitHub tarball. Run CLI/API/capabilities, Codex fixture, Claude fixture, and MCP initialize/tools/list/tools/call. Record client versions and OS; do not claim support beyond those fixtures.

- [ ] **Step 5: Reversibly update the owner's local workflow**

Inventory current WorktreeProof-owned Codex/Claude files and MCP entries, create byte-verifiable backups, preview the migration, apply with confirmation, replace only stale WorktreeProof-owned entries, preserve unrelated configuration/private repositories, rerun both client fixtures and MCP smoke, and retain the rollback manifest. This closes L99-04 and L99-05 only after public and local evidence both pass.

---

### Task 8: Specifically authorized, rule-compliant launch

**Files:**
- Create: `docs/launch/v0.2.0-messages.md`
- Create: `evidence/v0.2.0-launch.json`
- Modify: `README.md` only if a verified public link changed.

**Interfaces:**
- Consumes: verified v0.2.0 release URL, documentation, limitations, and exact approved destinations.
- Produces: destination-specific messages and redacted posting receipts.

- [ ] **Step 1: Write the launch-policy test before messages**

```js
test('launch drafts disclose affiliation and avoid manipulation', async () => {
  for (const message of await loadLaunchMessages()) {
    assert.match(message.body, /I built|maintainer/i);
    assert.match(message.body, /Apache-2\.0/);
    assert.doesNotMatch(message.body, /upvote|star this|best|perfect|guarantee|users love/i);
    assert.ok(message.releaseUrl.endsWith('/releases/tag/v0.2.0'));
  }
});
```

- [ ] **Step 2: Run the red test**

Run: `node --test test/community-surfaces.test.js --test-name-pattern="launch drafts"`
Expected: FAIL until destination-specific drafts exist.

- [ ] **Step 3: Research exact current rules and draft separately**

Use only primary community rule pages. Each draft names what was built, tested capabilities, Apache-2.0 license, local-first privacy boundaries, limitations, and release link. Do not copy one message across destinations.

- [ ] **Step 4: Obtain action-time destination authorization and post once**

Post only to specifically authorized relevant developer communities through logged-in owner accounts. Do not request votes/stars, repeat posts, manufacture engagement, or expose private data. Capture public URLs and timestamps only.

- [ ] **Step 5: Final terminal proof**

Run fresh `npm run check`, verify tag/release/npm/Pages/security checks/local installs, verify each public announcement, and record the immutable ledger as `6/6`. Commit documentation/evidence with subject `docs: record WorktreeProof v0.2.0 launch evidence`, merge it to `origin/main`, and prove the final SHA. Popularity remains an observed metric, never an acceptance claim.

## Gate Coverage

| Gate | Tasks | Terminal evidence |
|---|---|---|
| L99-02 implementation/conformance | 1–5 | Checkpoints A–C on `origin/main`; protocol, MCP, client, crash/recovery/privacy/resource tests green |
| L99-03 supply chain/readiness | 5–6 | SBOM, inventory, Scorecard, CodeQL, dependency review, secret controls, docs/templates green on `origin/main` |
| L99-04 release/live proof | 7 | tag, npm, GitHub artifacts, checksums, provenance, attestations, live registry/release metadata |
| L99-05 local installation | 3–4, 7 | backed-up reversible Codex/Claude migration and exact-release MCP/CLI/API smoke evidence |
| L99-06 authorized launch | 8 | approved destination-specific public links and redacted receipts |

## Self-Review Record

- Spec coverage: every approved architecture, privacy, recovery, evaluation, packaging, migration, release, and launch requirement maps to a task above.
- Placeholder scan: clean; every production step has a concrete interface, test, command, and acceptance result.
- Signature consistency: protocol `1.0`, MCP `2025-11-25`, release `0.2.0`, manifest hash, migration plan, and evidence fields retain one spelling throughout.
- Scope discipline: no hosted service, network transport, arbitrary shell tool, agent launcher, credential bridge, model control, adoption promise, or unrelated private repository work is introduced.

## Execution Choice

Use subagent-driven execution with one fresh bounded worker at a time on the current low-resource machine; CI supplies the cross-platform matrix. The owner has already approved this execution mode and the eight-task scope, so implementation proceeds without another architecture prompt.
