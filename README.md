# WorktreeProof

[![CI](https://github.com/Nedal7707/worktree-proof/actions/workflows/ci.yml/badge.svg)](https://github.com/Nedal7707/worktree-proof/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Nedal7707/worktree-proof/actions/workflows/codeql.yml/badge.svg)](https://github.com/Nedal7707/worktree-proof/actions/workflows/codeql.yml)
[![Dependency Review](https://github.com/Nedal7707/worktree-proof/actions/workflows/dependency-review.yml/badge.svg)](https://github.com/Nedal7707/worktree-proof/actions/workflows/dependency-review.yml)
[![Release Integrity](https://github.com/Nedal7707/worktree-proof/actions/workflows/release-integrity.yml/badge.svg)](https://github.com/Nedal7707/worktree-proof/actions/workflows/release-integrity.yml)
[![npm version](https://img.shields.io/npm/v/worktree-proof.svg?color=CB3837&logo=npm)](https://www.npmjs.com/package/worktree-proof)
[![License](https://img.shields.io/github/license/Nedal7707/worktree-proof.svg?color=blue)](LICENSE)
[![Node](https://img.shields.io/node/v/worktree-proof.svg?logo=node.js)](package.json)

**Vibe fast. Ship with proof.**

WorktreeProof is an open-source toolkit for **scoped, evidence-backed AI coding-agent work**. It gives agents a beginning (plan), a safe working surface (reserve), bounded checks (run), and a verifiable end (close with a receipt). Local-first, model-agnostic, zero runtime dependencies.

## Five-minute quick start

```sh
git clone https://github.com/Nedal7707/worktree-proof.git
cd worktree-proof
npm ci
node bin/worktree-proof.js doctor --json
node bin/worktree-proof.js plan docs-refresh --scope docs/ --json
node bin/worktree-proof.js reserve docs-refresh --scope docs/ --json
node bin/worktree-proof.js run docs-refresh --json -- node --version
node bin/worktree-proof.js status --json
```

`close` consumes an explicit JSON receipt; it never invents terminal evidence. For a complete, disposable run that closes an abandoned demo lane, see [the reproducible demo](docs/DEMO.md).

The 0.4.0 tag can also be installed globally from GitHub:

```sh
npm install --global github:Nedal7707/worktree-proof#v0.4.0
worktree-proof --version
```

## Codex / Claude Code installation

Use the portable Agent Skill:

- **Codex:** Open the [WorktreeProof Stack skill](https://github.com/Nedal7707/worktree-proof/tree/main/skills/worktree-proof-stack) — Codex will ask to confirm.
- **Claude Code:** Copy `skills/worktree-proof-stack` into your `.claude/skills/` directory.

Both clients use the same `.worktree-proof/` state and schemas; neither client invokes the other.

## OpenCode Plugins (vendored in `integrations/`)

Three OpenCode plugins are included for agent automation:

```bash
# Install all into the current user's OpenCode global config
npm run opencode:plugins:install

# Restart OpenCode after installation.
```

### Chrome Use (`opencode-plugin-chrome-use`)
Drive the user's normal Chrome via the Chrome Bridge extension relay
(`chrome_connect` endpoint `http://127.0.0.1:9333` — extension ID
`epppjbfmmabiphlgeokdichnhhklabep`; the 9222 debug-port "Chrome portal" is
retired for browser automation and port 9222 is Token-Free Gateway only).
These are agent tools, not slash commands:
```bash
chrome_connect
chrome_navigate
chrome_click
chrome_fill
chrome_screenshot
chrome_extract
chrome_wait
```

### Computer Use (`opencode-plugin-computer-use`)
Human-like OS automation (Windows/macOS/Linux via nut-js). These are agent tools:
```bash
computer_screenshot
computer_mouse_click
computer_keyboard_type
computer_keyboard_press
computer_window_focus
computer_wait
```

### Goal/Plan Modes (`opencode-plugin-goal-plan`)
Structured agent workflow:
```bash
/goal Add user auth
/plan JWT login, role guards, tests pass
/task start task-1
/task done task-1
/review
```

State persists in `.opencode/goal-plan.json`.

## What it verifies

- **Lane IDs & file scopes** — normalized and checked for overlap
- **Reservations** — serialized with bounded leases and stale-state detection
- **Commands** — executed without an implicit shell; output bounded and redacted
- **Closure receipts** — JSON-safe, validate terminal evidence
- **Tool probes** — declarative, probe-only; no installers or arbitrary shell
- **Resource scans** — read-only; conservative concurrency/cleanup recommendations
- **Codex↔Claude bridge** — bounded local task/status/result handoffs; non-overlapping scopes; never forwards hidden context
- **Task awareness** — hashes host IDs, discards private content, reports mode only when explicitly provided

## A small workflow

```sh
worktree-proof tools list
worktree-proof tools scan --json
worktree-proof tools recommend --goal testing --goal javascript
worktree-proof resources scan --json
worktree-proof resources plan --allowed-root .cache --allowed-root build
worktree-proof recipes list
worktree-proof recipes show docs
worktree-proof init preview --target generic-prompt
worktree-proof bridge inbox --agent codex --json
worktree-proof tasks inspect --input host-snapshot.json --json
```

`init apply` requires `--confirm`, refuses collisions and path escapes, and never overwrites an existing file. `resources plan` is an inventory only. The public helper request defaults to 8 and supports an explicit request up to 24, but the host/runtime ceiling and CPU/RAM/disk safety can reduce the effective value to zero.

## Architecture at a glance

The CLI keeps plans, leases, run records, and closure receipts under the project's `.worktree-proof/` directory. Scope normalization and lease checks are local and deterministic; no coordinator or account is required. A command selected by the user runs as an argv array, then a bounded/redacted run record can be inspected with `status`. `close` validates a caller-supplied receipt against [the closure schema](schemas/closure-receipt.schema.json), and `validate` checks the resulting state without mutating it. The bridge, task awareness, manifests, and MCP stdio surface are optional adapters around this same local state. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for boundaries and [THREAT-MODEL.md](docs/THREAT-MODEL.md) for what the checks do not prove.

## Project contents

- `skills/` — concise, portable Agent Skills
- `recipes/` — bounded examples for common maintenance work
- `catalog/` — declarative tool manifests
- `schemas/` — lane, receipt, recipe, resource, and skill-source contracts
- `benchmarks/` — no-dependency, local benchmark harness with reproducibility notes in `docs/benchmarks/`
- `evals/` — seeded, fail-closed scenario harness for the CLI guarantees
- `site/` — static, tracker-free overview at [nedal7707.github.io/worktree-proof](https://nedal7707.github.io/worktree-proof/)
- `docs/` — deep docs: architecture, threat model, cross-agent compatibility, bridge, task awareness, release checklist, privacy, benchmarks
- `integrations/` — vendored OpenCode plugins:
  - `opencode-plugin-chrome-use` — CDP-based Chrome automation (navigate, click, fill, screenshot, extract, wait, tabs, evaluate)
  - `opencode-plugin-computer-use` — OS automation via nut-js (screenshot, mouse, keyboard, key combos, window management)
  - `opencode-plugin-goal-plan` — Goal/Plan workflow modes (`/goal:set`, `/plan:create`, `/task:next`, `/review:gate`)

## Privacy, security, and limits

State stays in the project directory; no telemetry or runtime dependency. Do not put credentials in command arguments, environment dumps, receipts, or issue reports. Read [SECURITY.md](SECURITY.md) and [docs/PRIVACY.md](docs/PRIVACY.md) before using integrations. WorktreeProof does not authenticate users, replace code review, prove an external deployment, or guarantee that an AI-generated change is safe.

For crash-risk reduction, `resources scan` and `resources plan` provide bounded diagnostics, backpressure recommendations, and recovery-oriented cleanup inventory. They do not change OS settings, kill processes, delete files, run a daemon, or promise to prevent crashes. If you inspect a crash dump or `.heapsnapshot`, treat it as potentially containing conversations or credentials and keep it private; this project never uploads or shares it.

## Support, governance, and roadmap

- [SUPPORT.md](SUPPORT.md) — what belongs in a public issue; how to provide a redacted reproduction
- [GOVERNANCE.md](GOVERNANCE.md) — maintainer decision process; [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to participation
- [ROADMAP.md](ROADMAP.md) — intentionally small, evidence-gated next steps (a plan, not a promise)
- [docs/benchmarks/README.md](docs/benchmarks/README.md) — local benchmark runs; numbers are machine-specific, not vendor comparisons

## Contributing

Run `npm test`, `npm run check`, and the release checklist before proposing a focused change. See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/CROSS-AGENT-COMPATIBILITY.md](docs/CROSS-AGENT-COMPATIBILITY.md), [docs/BRIDGE.md](docs/BRIDGE.md), [docs/TASK-AWARENESS.md](docs/TASK-AWARENESS.md), and [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md).

WorktreeProof is an unofficial community project and is not affiliated with, endorsed by, or sponsored by any vendor. It is released under the [Apache License 2.0](LICENSE).

## Release notes

### 0.4.0 — 2026-08-15
- Evals harness: 9 seeded fail-closed checks (all pass); `evals/run.js` + `test/evals.test.js` + `test/benchmarks.test.js`
- Benchmark dedup: removed stale `docs/benchmarks/run.mjs`; single runner at `benchmarks/run.js`
- Package scripts: added `npm run eval` and `npm run benchmark`
- CI green: Node 20/22 × ubuntu/windows, Publish static site, CodeQL
- Clean-install verified: fresh `npm install worktree-proof@0.4.0` on Node 20/22/24 → full lifecycle `plan→reserve→run→close→release→validate` → `valid:true, receipts:1`
- SBOM + SHA256SUMS + release manifest + provenance per release

### 0.3.3 — 2026-08-14
- Worktree Proof Workflow V3 installed (CW-3/CW-4): immutable task contracts, SAFE-3 circuit breaker, fixed terminal ledger, exact cleanup, crash recovery rehydration
- Spec audit: `WORKFLOW_SPEC.md` + `HELPER_POLICY.md` verified with `scripts/spec-audit.mjs` (§§1–10 present)
- `safe-parallel-delegation` skill codified with lane ID, file scope, capacity, allocation rules

### 0.1.0–0.3.2 — 2026-08-10 to 2026-08-14
- Core CLI: plan, reserve, run, close, release, validate, doctor, status, init, tools, resources, recipes, bridge, tasks
- Local-first worktrees, bounded leases, closure receipts, resource scans
- Agent Skills, Codex/Claude bridge, MCP stdio surface
- GitHub Actions: CI, CodeQL, Dependency Review, Pages, Release Integrity
- npm publishing with provenance, SBOM, checksums
