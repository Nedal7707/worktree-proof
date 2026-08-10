# WorktreeProof L99 Design Specification

Status: Approved architecture; implementation and release evidence are pending
Version target: L99
Repository baseline: `origin/main` at `afdb3e604541ecd185c6e86ed18bca38875d5bc4`

## 1. Objective

L99 evolves WorktreeProof into a modular, standards-first interoperability
toolkit while preserving its deterministic, local, zero-runtime-dependency
core. It serves developers and coding-agent operators who need inspectable
scope ownership, safe recovery, evidence-backed closure, and portable
integration without surrendering credentials, hidden context, or model
control.

L99 succeeds when the same versioned local protocol can be used through:

- the existing local CLI and JavaScript API;
- portable Agent Skills;
- an optional MCP server over standard input/output;
- generic prompt and manifest exports;
- capability negotiation;
- thin, tested Codex and Claude adapters; and
- documented protocol-compatible clients that pass conformance tests.

Compatibility is demonstrated per tested client and version. WorktreeProof
does not claim universal support, identical behavior across agents, benchmark
superiority, guaranteed popularity, or guaranteed correctness.

## 2. Approved assumptions

1. The deterministic local core remains the source of truth for scope,
   leases, worktrees, receipts, redaction, and recovery.
2. Runtime dependencies for the core package remain zero. Optional integration
   surfaces must not weaken or replace the core.
3. Interoperability uses published schemas and capability negotiation rather
   than private model features or vendor-specific hidden state.
4. The MCP transport is optional, local, and stdio-only in L99. It is not an
   always-on daemon and does not open a network listener.
5. Codex and Claude adapters are thin translations over the same protocol.
   They never launch one another or override model or reasoning settings.
6. Public helper concurrency is resource-aware and configurable. The current
   development device may force one worker; that observation is not a public
   default or a product-wide capacity claim.
7. Popularity and community uptake are unguaranteed. Launch activity reports
   only verifiable facts.

## 3. Design principles

- **Local first:** protocol state and evidence remain local unless a user
  explicitly exports an artifact.
- **Standards first:** prefer JSON Schema, JSON Lines, MCP stdio, CycloneDX,
  npm provenance, and GitHub attestations over proprietary glue.
- **Deterministic core:** equivalent inputs and state produce stable outputs,
  ordering, exit codes, and evidence envelopes.
- **Capability before action:** negotiate supported operations before invoking
  them; unavailable capability is a normal result.
- **Explicit authority:** consequential mutations require an explicit user or
  caller action at the point of execution.
- **Minimum disclosure:** share summaries, references, and redacted evidence;
  never forward hidden reasoning or ambient conversation context.
- **Recoverable state:** interruption, stale leases, dirty worktrees, and
  partial writes must have bounded, testable recovery paths.
- **Honest claims:** distinguish a local result, conformance result, packaged
  artifact, published release, live installation, and community announcement.

## 4. Architecture

### 4.1 Component model

```text
Agent Skills       Codex adapter       Claude adapter       Generic clients
      \                  |                   |                     /
       \---------- capability negotiation + versioned protocol --/
                                  |
                  CLI JSON / JavaScript API / MCP stdio
                                  |
             deterministic zero-dependency local core
                                  |
       scopes · leases · worktrees · recovery · receipts · redaction
                                  |
                  versioned local JSON state and evidence
```

The adapters and transports are edge modules. They do not own state or invent
semantics. Every edge calls the same core functions and emits the same
versioned result envelope.

### 4.2 Core modules

The core owns:

- lane identifier and relative scope normalization;
- overlap detection and atomic lease lifecycle;
- worktree containment, dirty-state protection, and rescue records;
- closure receipt validation and atomic persistence;
- redaction and bounded error reporting;
- resource-aware concurrency recommendations;
- deterministic ordering and versioned serialization; and
- recovery classification after interrupted writes or stale ownership.

Core modules may use Node.js built-ins. A new third-party runtime dependency is
not permitted for L99 core functionality.

### 4.3 Optional interoperability modules

Optional modules provide:

- Agent Skill documents using canonical `SKILL.md` structure;
- an MCP stdio server that exposes a bounded subset of core operations;
- stable JSON and JSON Lines CLI modes;
- generic prompt and manifest export;
- capability negotiation and conformance metadata;
- Codex and Claude adapters; and
- client conformance fixtures.

Optional modules must be import-safe: importing the package performs no file
write, process spawn, network call, credential lookup, or background work.

### 4.4 Process and lifecycle

1. A caller requests protocol metadata and capabilities.
2. The client chooses only capabilities reported as available.
3. The caller submits a bounded operation with an explicit protocol version.
4. The core validates identity, scope, state version, and authority.
5. The core performs the operation or returns a stable refusal.
6. The transport emits a versioned, redacted result envelope.
7. Closure requires terminal evidence or explicit abandonment and recovery.

No transport auto-launches an agent, forwards hidden context, opens an
always-on service, or chooses a model or reasoning level.

## 5. Interfaces and data contracts

### 5.1 Interoperability baselines

L99 pins its standards-facing conformance baseline to:

- the [Agent Skills specification](https://agentskills.io/specification); and
- Model Context Protocol revision `2025-11-25`, specifically the official
  [tool semantics](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  and [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

An application or coding-agent CLI may integrate through the versioned JSON
CLI, an Agent Skill, MCP stdio, or the generic manifest when it implements the
advertised capabilities and passes the public conformance suite. This is an
open protocol-compatibility path, not a claim that every client is tested or
supported. Named tested support remains limited to the client name, client
version, transport, operating system, and fixture recorded in conformance
evidence.

The pinned baselines make evaluation reproducible. They do not imply that the
standards publishers endorse WorktreeProof, and a future standards revision is
not adopted until its compatibility and migration behavior are reviewed.

### 5.2 Protocol versioning

Every machine-readable request and response includes:

```json
{
  "protocol": "worktreeproof",
  "protocolVersion": "1.0",
  "schemaVersion": "1",
  "requestId": "req-safe-identifier"
}
```

Rules:

- major protocol changes are incompatible and require explicit negotiation;
- additive minor changes preserve existing required fields and meanings;
- unknown required versions fail closed with a stable error code;
- unknown optional fields are ignored only where the schema explicitly allows
  extensions; and
- serialized maps and lists use deterministic ordering where order is not
  semantically significant.

### 5.3 Stable CLI JSON envelope

Commands that support automation accept `--json` and an explicit protocol
version. Successful and failed operations use one envelope:

```json
{
  "ok": true,
  "protocol": "worktreeproof",
  "protocolVersion": "1.0",
  "command": "status",
  "requestId": "req-safe-identifier",
  "result": {},
  "warnings": []
}
```

CLI requirements:

- stdout contains exactly one JSON document in JSON mode;
- stderr never contains secret values or uncontrolled child output;
- exit `0` means success, `1` means operational refusal/failure, and `2` means
  invalid usage;
- command arguments remain argv arrays with shell execution disabled;
- JSON output and error codes are covered by compatibility tests; and
- human output may improve without changing the machine contract.

JSON Lines mode is permitted only for explicitly streaming, bounded operations.
Each line must independently validate as an event envelope.

### 5.4 Capability negotiation

Clients call `capabilities` before optional operations. The response contains
protocol versions and bounded, declarative capabilities:

```json
{
  "protocol": "worktreeproof",
  "protocolVersion": "1.0",
  "capabilities": [
    { "id": "scope.validate", "version": "1", "mutating": false },
    { "id": "lease.reserve", "version": "1", "mutating": true },
    { "id": "receipt.validate", "version": "1", "mutating": false }
  ],
  "limits": {
    "maxMessageBytes": 16384,
    "maxBatchItems": 100
  }
}
```

Capability IDs are stable, lowercase tokens. Absence means unsupported. A
client must not infer a capability from its vendor, model, title, or transport.

### 5.5 JavaScript API

The package root exports pure validators and explicit asynchronous operations.
Subpath exports may group `core`, `mcp`, `adapters`, and `protocol` without
requiring consumers to import private source paths.

API conventions:

- options are plain objects;
- paths are explicit and normalized;
- operations return JSON-safe objects;
- cancellation uses `AbortSignal` where applicable;
- time and process implementations are injectable for deterministic tests;
- errors expose stable public codes and bounded messages; and
- no API reads credentials or environment variables unless the documented
  input explicitly names a non-secret configuration variable.

### 5.6 Agent Skills

Each built-in skill:

- has frontmatter containing only `name` and `description`;
- uses vendor-neutral instructions in the body;
- references protocol concepts rather than hidden agent behavior;
- keeps credentials and private context out of prompts and receipts;
- distinguishes read-only checks, explicit mutation, and terminal closure; and
- passes the canonical skill validator and local conformance tests.

### 5.7 MCP stdio server

The optional MCP server communicates only over stdin/stdout. It exposes a small
allowlist such as:

- `worktreeproof_capabilities`;
- `worktreeproof_validate_scope`;
- `worktreeproof_status`;
- `worktreeproof_validate_receipt`; and
- explicitly authorized lease or closure operations.

MCP requirements:

- no TCP/HTTP listener, discovery beacon, daemon, or auto-start;
- no arbitrary command execution tool;
- bounded request and response sizes;
- strict JSON Schema validation;
- stable error mapping;
- stderr diagnostics are redacted;
- lifecycle ends when stdio closes; and
- mutating tools retain the same authority checks as CLI/API calls.

### 5.8 Prompt and manifest export

Generic export produces portable, reviewable files containing:

- protocol and schema version;
- required capabilities;
- allowed relative scope;
- input and output schema references;
- mutation and confirmation boundaries;
- redaction requirements; and
- expected terminal evidence.

Exports contain no credentials, absolute private paths, hidden reasoning,
conversation transcript, or vendor-only control flag.

### 5.9 Codex and Claude adapters

Codex and Claude adapters are thin, independently tested translations. Each:

- reads the same public manifest and schemas;
- maps host-exposed operations to negotiated capability IDs;
- preserves lane IDs, relative scopes, lease semantics, and receipt fields;
- reports unavailable operations without simulation;
- does not launch or invoke another agent;
- does not forward prompts, hidden reasoning, cookies, tokens, or sessions; and
- does not override model selection, reasoning effort, or host scheduling.

Documentation may describe other protocol-compatible clients after they pass
the same public conformance suite. It must not imply universal tested support.

## 6. Project structure

The intended structure is:

```text
src/                  deterministic core and public API
src/protocol/         envelopes, versions, capability negotiation
src/mcp/              optional stdio server and MCP adapters
src/adapters/         thin Codex, Claude, and generic adapters
schemas/              published JSON Schemas
skills/               canonical Agent Skills
test/                 unit, integration, conformance, and recovery tests
evals/                real-repository scenarios and deterministic fixtures
benchmarks/           reproducible, non-competitive measurements
docs/                 architecture, security, release, governance, guides
.github/workflows/    CI, security, attestation, and release workflows
```

Generated package artifacts, SBOMs, checksums, and attestations are produced in
clean release jobs and are not treated as source files.

## 7. Code style

Use ESM, Node.js built-ins, explicit validation, stable error codes, and
dependency injection at nondeterministic boundaries.

```js
export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('request must be an object', 'ERR_INVALID_REQUEST');
  }
  if (input.protocolVersion !== '1.0') {
    throw new ProtocolError('unsupported protocol version', 'ERR_PROTOCOL_VERSION');
  }
  return Object.freeze({ ...input });
}
```

Conventions:

- exported functions use verb-first names;
- public constants use `UPPER_SNAKE_CASE`;
- fields use `camelCase` unless an external standard requires otherwise;
- validators return normalized copies rather than mutating inputs;
- shell command strings are prohibited; use argv arrays with `shell:false`;
- temporary writes use create-only files and atomic rename; and
- comments explain invariants and threat boundaries, not obvious syntax.

## 8. Security and privacy

### 8.1 Protected data

WorktreeProof must not collect, forward, persist, or emit:

- passwords, API keys, tokens, cookies, authorization headers, or private keys;
- hidden reasoning, chain-of-thought, or ambient conversation history;
- credential-manager, browser-session, or authentication state;
- unredacted private paths or protected repository content in public evidence;
- memory dumps or heap snapshots; or
- billing, payment, or live financial action material.

### 8.2 Trust boundaries

Repository content, manifests, receipts, MCP requests, CLI input, adapter
output, and child-process output are untrusted. Every boundary validates size,
type, path containment, supported version, and secret-like content.

### 8.3 Mutation controls

- Read-only validation is the default.
- Mutation requires an explicit operation and documented authority.
- Destructive cleanup revalidates the exact target immediately before action.
- Dirty or ambiguous state fails closed and produces a rescue record.
- Symlinks, junctions, and reparse points cannot escape approved roots.
- Partial or malformed state is quarantined or reported; it is never treated as
  clean, complete, or safe.

### 8.4 Supply-chain controls

L99 release workflows add:

- CycloneDX SBOM generation for source and packaged artifacts;
- GitHub artifact attestations bound to the release workflow and commit;
- npm provenance for the published package;
- OpenSSF Scorecard monitoring;
- CodeQL scanning;
- dependency review on pull requests;
- secret scanning and push protection where available;
- pinned action versions or immutable commit references under release policy;
- package-content allowlist inspection; and
- checksums for GitHub release artifacts.

Security tooling produces evidence, not a guarantee that the project is free of
vulnerabilities.

## 9. Testing and evaluation

### 9.1 Unit and contract tests

Tests cover:

- schema validation and version negotiation;
- deterministic serialization and ordering;
- stable CLI envelopes, exit codes, and redaction;
- capability negotiation and unavailable-capability behavior;
- package-root import with no side effects;
- MCP framing, bounded messages, cancellation, and stdio shutdown;
- Codex, Claude, and generic adapter conformance; and
- zero-runtime-dependency enforcement for the core package.

### 9.2 Real-repository evaluations

Hermetic fixtures are necessary but not sufficient. L99 runs repeatable
evaluations in disposable real Git repositories covering:

- concurrent reservation and lock races;
- process interruption during temporary write, lease update, worktree create,
  command run, and closure persistence;
- dirty worktree recovery without data loss;
- stale lease and rescue-worktree recovery;
- symlink, Windows junction, and reparse-point escapes;
- malformed, truncated, future-version, and duplicate state;
- secret sentinels and privacy redaction across CLI, API, MCP, adapters, logs,
  and receipts;
- CPU, RAM, and disk pressure with resource-aware backpressure;
- bounded output, message count, directory traversal, and timeout limits; and
- package install and execution from a clean environment.

Each evaluation records seed, operating system, Node version, repository
fixture revision, commands, elapsed time, peak resources where observable,
exit codes, and redacted outputs.

### 9.3 Reproducible benchmarks

Benchmarks measure, without superiority claims:

- scope-validation throughput;
- lease contention latency and recovery time;
- worktree create/status/cleanup latency;
- receipt validation and serialization throughput;
- MCP request latency and memory footprint;
- package cold-start time; and
- behavior under bounded CPU, RAM, and disk pressure.

Benchmark requirements:

- fixed public fixtures and seeds;
- warmup and measured iterations recorded separately;
- raw JSON results attached to the release candidate;
- no comparison language such as fastest, best, or superior without an
  independently reviewable study; and
- regression thresholds tied to the project's prior release, not competitors.

### 9.4 Required verification commands

The L99 implementation defines and documents commands equivalent to:

```sh
npm ci
npm run lint
npm test
npm run check
npm run test:conformance
npm run evals
npm run benchmark -- --seed l99
npm run sbom
npm pack --dry-run
```

Release verification also installs the exact tarball into clean temporary
projects and exercises CLI, JavaScript API, Agent Skills, Codex adapter, Claude
adapter, and MCP stdio flows.

## 10. Packaging and release

### 10.1 Artifacts

A versioned L99 release produces:

- an npm package with an exact allowlisted file inventory;
- a GitHub source archive and release notes;
- SHA-256 checksum files;
- CycloneDX SBOMs;
- GitHub artifact attestations;
- npm provenance;
- conformance and evaluation summaries; and
- installation and verification instructions.

The npm package and GitHub release must originate from the same reviewed tag
and commit. Checksums and attestations must match downloaded artifacts.

### 10.2 One-command installation

After publication is verified, documentation may offer a pinned one-command
installation such as:

```sh
npm install --global worktree-proof@latest
```

Before publication, documentation must label that command as a release target,
not as currently available. The release proof installs from both the npm
registry and the GitHub release artifact in clean environments.

### 10.3 Release checks

- package name, version, bin, exports, license, repository URL, and engines are
  correct;
- package import performs no I/O or background work;
- install and postinstall scripts are absent;
- runtime dependency count is zero for the core package;
- tarball contents contain no tests, caches, credentials, private paths,
  generated worktrees, or unrelated artifacts;
- all skills pass canonical validation;
- SBOM, checksums, attestations, and provenance are present and verifiable; and
- release notes state limitations and do not claim adoption or superiority.

### 10.4 Post-release local workflow migration

After the exact release artifact passes L99-04, migrate the current owner's
local Codex and Claude workflows through a bounded, reversible procedure:

1. Record the installed WorktreeProof version and inventory existing Codex,
   Claude, MCP, skill, manifest, and WorktreeProof-owned configuration entries.
2. Back up every file or configuration surface that may change, verify the
   backup is readable, and record a rollback location without exposing private
   content.
3. Detect path and configuration collisions before writing. Classify every
   collision as unrelated user content, current WorktreeProof content, or stale
   WorktreeProof-owned content.
4. Install the exact attested release artifact for both local workflows. Do not
   substitute an unpinned checkout, a different package build, or an artifact
   whose checksum or provenance does not match L99-04.
5. Where the tested client version supports local MCP stdio, configure only the
   tested WorktreeProof stdio command and capability allowlist. Do not open a
   network listener or copy credentials into MCP configuration.
6. Remove or replace only stale files and configuration entries that are
   demonstrably WorktreeProof-owned. Preserve unrelated user configuration,
   user-authored skills, credentials, and every unrelated or private
   repository.
7. Run the fresh Codex, Claude, and MCP acceptance flows, capture redacted
   evidence, and leave unsupported client features explicitly unconfigured.
8. If any acceptance check fails, restore the verified backups, remove only the
   newly installed WorktreeProof-owned entries, confirm the previous workflows
   still operate, and record the rollback result.

Migration is a post-release operation, not part of package installation side
effects. No install, postinstall, adapter, or MCP process may rewrite ambient
Codex or Claude configuration automatically.

## 11. Governance and community launch

### 11.1 Governance surfaces

L99 maintains public, consistent:

- contributing guidance;
- code of conduct;
- governance and maintainer responsibilities;
- security policy and private vulnerability reporting path;
- support and issue-triage guidance;
- changelog and release notes;
- roadmap and decision records; and
- license and third-party provenance notices.

### 11.2 Responsible launch

Community communication is informational and specifically authorized per
channel. Announcements may state the released version, verified capabilities,
license, repository, documentation, and known limitations.

Launch rules:

- no unsolicited bulk posting or repetitive cross-posting;
- no vote, star, upvote, or engagement requests;
- no fabricated users, testimonials, downloads, adoption, or performance;
- no impersonation or undisclosed automation;
- no private data, account detail, or protected community content;
- comply with each community's rules and disclose affiliation; and
- retain evidence of authorization and the exact final message.

Popularity is not an acceptance criterion and is not guaranteed.

## 12. Rollout

### Phase A: protocol foundation

Publish schemas, stable envelopes, capability negotiation, conformance fixtures,
and migration notes while retaining existing core behavior.

### Phase B: optional transports

Add MCP stdio and generic exports behind explicit commands. Verify import
purity, no-network behavior, and stable failures before enabling release paths.

### Phase C: tested adapters

Implement Codex and Claude adapters over shared fixtures. Document only the
versions and surfaces exercised by conformance tests.

### Phase D: hardening and evaluation

Run real-repository crash, race, recovery, path, privacy, and resource-pressure
evaluations. Address every release-blocking regression or roll back the affected
surface.

### Phase E: supply chain and release

Generate SBOMs, attestations, checksums, provenance, packages, and release
notes from the reviewed tag. Verify fresh installs before publication proof is
accepted.

### Phase F: authorized launch

Publish only specifically authorized, rule-compliant announcements after the
versioned release and fresh-install gates pass.

## 13. Rollback strategy

Rollback is versioned and evidence-driven:

- stop publication or announcement immediately when a gate fails;
- preserve the last known-good package and tag;
- yank or deprecate a broken npm version according to registry policy without
  rewriting published history;
- remove compromised release assets and publish a security notice when needed;
- disable an optional adapter or MCP capability through a documented versioned
  change, not a hidden switch;
- retain redacted failure evidence and recovery instructions; and
- require all affected terminal gates to pass again before resuming rollout.

Rollback never deletes dirty user worktrees, alters models, forwards hidden
context, or silently substitutes another client.

## 14. Boundaries

### Always

- validate protocol versions, schemas, inputs, sizes, and relative paths;
- keep the core deterministic and free of runtime dependencies;
- run unit, conformance, recovery, package, and privacy checks;
- redact evidence and distinguish observed from inferred facts;
- require explicit mutation authority; and
- preserve recoverable user state on failure.

### Requires explicit project approval

- adding a runtime dependency;
- changing a public schema's required fields or meaning;
- introducing a network listener or hosted service;
- changing release-signing, attestation, or publication identity;
- expanding adapter support claims; and
- posting a community announcement.

### Never

- auto-launch an agent or create an always-on daemon;
- forward hidden reasoning, ambient prompts, credentials, cookies, or sessions;
- override a model, reasoning setting, or host scheduler;
- execute arbitrary shell command strings from manifests or MCP requests;
- claim universal compatibility, guaranteed safety, guaranteed correctness,
  benchmark superiority, or adoption;
- publish or announce without satisfying the applicable terminal gate; or
- use spam, vote requests, fabricated uptake, or unauthorized accounts.

## 15. Non-goals

L99 does not provide:

- a hosted coordination service or cross-user identity provider;
- real-time chat or hidden-context synchronization between agents;
- an autonomous merge, deployment, or release authority;
- a sandbox for arbitrary commands;
- a replacement for code review, operating-system isolation, or security review;
- automatic agent selection or reasoning control;
- guaranteed prevention of crashes, races, data loss, or vulnerabilities;
- universal client compatibility; or
- guaranteed popularity or community acceptance.

## 16. Immutable terminal gates

The gates are cumulative and immutable for L99. A plan, local branch, passing
subset, draft package, or announcement proposal does not satisfy a gate.

### L99-01 — Design on `origin/main`

Acceptance:

- this approved specification is reviewed and present on `origin/main`;
- the `origin/main` commit is recorded and independently readable; and
- architecture, boundaries, rollout, rollback, and gates are internally
  consistent.

L99-01 remains open until the reviewed specification and its exact commit are
independently proven on `origin/main`.

### L99-02 — Implementation and conformance

Acceptance:

- core, protocol, CLI JSON, capability negotiation, MCP stdio, exports, skills,
  and adapters are implemented as specified;
- all unit, integration, conformance, crash, race, recovery, path, privacy, and
  resource-pressure tests pass from a clean checkout; and
- Codex and Claude claims are limited to tested fixtures and versions.

### L99-03 — Supply chain, packaging, docs, and community readiness

Acceptance:

- CodeQL, dependency review, secret scanning, and Scorecard controls are active;
- CycloneDX SBOMs, package allowlists, checksums, and attestation workflows pass;
- documentation, governance, security, contribution, support, changelog,
  provenance, and launch policy agree with shipped behavior; and
- package dry-run and exact artifact inspection are clean.

### L99-04 — Versioned release and live proof

Acceptance:

- the reviewed version tag points to the accepted commit;
- npm and GitHub release artifacts, checksums, SBOMs, attestations, and
  provenance are published and mutually verifiable;
- registry and release-page metadata are live and correct; and
- no release-blocking security or conformance failure remains open.

### L99-05 — Fresh Codex, Claude, and MCP local installation

Acceptance:

- the exact released artifacts install in clean local environments;
- CLI and JavaScript API smoke tests pass;
- a fresh Codex adapter flow passes its public fixture;
- a fresh Claude adapter flow passes its public fixture;
- the MCP stdio server negotiates capabilities and completes a bounded local
  request;
- the current owner's existing Codex and Claude configuration is inventoried
  and backed up before migration, with readable rollback material;
- the exact attested release artifact is installed for both local workflows;
- the tested local stdio MCP surface is configured only where the recorded
  client version supports it;
- collision review removes or replaces only stale WorktreeProof-owned files or
  configuration entries while preserving unrelated user configuration,
  credentials, user-authored skills, and unrelated or private repositories;
- rollback restores the pre-migration workflows when any fresh-install check
  fails; and
- no flow launches another agent, uses a network listener, accesses credentials,
  forwards hidden context, or changes model/reasoning settings.

### L99-06 — Specifically authorized compliant community announcements

Acceptance:

- L99-01 through L99-05 are complete;
- each channel and final message has specific authorization;
- messages comply with channel rules, disclose affiliation, link the verified
  release, state limitations, and make no adoption or superiority claim; and
- evidence records exactly what was posted and where without protected data.

## 17. Overall acceptance

L99 is complete only when all six terminal gates are satisfied in order and the
evidence remains reproducible from the released commit and artifacts. Any failed
gate stops downstream rollout and invokes the rollback strategy.

This specification is the design input to L99. It does not authorize code,
release, publication, account access, or community posting by itself.

## 18. Standards and supply-chain references

These sources define design and evaluation baselines; listing them does not
imply endorsement, certification, or affiliation.

- [Agent Skills specification](https://agentskills.io/specification)
- [MCP 2025-11-25 tool semantics](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP 2025-11-25 transports and stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [CycloneDX specification overview](https://cyclonedx.org/specification/overview/)
- [GitHub artifact attestations documentation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations)
- [OpenSSF Scorecard](https://scorecard.dev/)
- [CodeQL documentation](https://codeql.github.com/docs/)
- [npm provenance documentation](https://docs.npmjs.com/generating-provenance-statements/)
