# WorktreeProof

**Vibe fast. Ship with proof.**

WorktreeProof provides **evidence-backed guardrails for AI coding agents.** It helps
you describe a small change, reserve a non-overlapping scope, run reviewed
commands, and keep a redacted receipt of what was checked. It is local-first,
model-agnostic, and intentionally does not claim guaranteed security,
correctness, adoption, or autonomous merging.

## Five-minute quick start

Use Node.js 20 or newer. The most reproducible path is a source checkout; the
commands below invoke the checked-in CLI directly:

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

`close` consumes an explicit JSON receipt; it never invents terminal evidence.
For a complete, disposable run that closes an abandoned demo lane, see
[the reproducible demo](docs/DEMO.md). Every mutating action is explicit:
`--dry-run` previews state changes and `init` is preview-only unless
`--apply --confirm` are supplied. Commands pass argv with `shell:false`;
WorktreeProof is not a security sandbox.

The 0.3.4 tag can also be installed globally from GitHub when a PATH command is
more convenient (verify the installed version before using it):

```sh
npm install --global github:Nedal7707/worktree-proof#v0.3.4
worktree-proof --version
```

## Codex installation link

To use the WorktreeProof Agent Skill with Codex, open the
[WorktreeProof Stack skill](https://github.com/Nedal7707/worktree-proof/tree/main/skills/worktree-proof-stack).
Codex will ask you to confirm installation; opening the link alone does not
install anything.

The same portable skill can be placed in Claude Code's skills directory. Both
clients use the same `.worktree-proof/` state and schemas; neither client is
invoked by the other.

## What it verifies

- Lane IDs and relative file scopes are normalized and checked for overlap.
- Reservations are serialized with bounded leases and stale-state detection.
- Commands are executed without an implicit shell and output is bounded/redacted.
- Closure receipts are JSON-safe and validate their terminal evidence.
- Tool probes are declarative and probe-only; no installers or arbitrary shell.
- Resource scans are read-only and produce conservative concurrency/cleanup
  recommendations. Cleanup plans never delete files.
- The Codex↔Claude bridge stores bounded local task/status/result handoffs and
  reserves non-overlapping task scopes; it never forwards hidden context.
- Task awareness hashes host-provided IDs, discards private task content, and
  reports a mode only when the host explicitly provides it.

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

`init apply` requires `--confirm`, refuses collisions and path escapes, and
never overwrites an existing file. `resources plan` is an inventory only.
The public helper request defaults to 8 and supports an explicit request up to
24, but the host/runtime ceiling and CPU/RAM/disk safety can reduce the
effective value to zero.

## Architecture at a glance

The CLI keeps plans, leases, run records, and closure receipts under the
project's `.worktree-proof/` directory. Scope normalization and lease checks
are local and deterministic; no coordinator or account is required. A command
selected by the user runs as an argv array, then a bounded/redacted run record
can be inspected with `status`. `close` validates a caller-supplied receipt
against [the closure schema](schemas/closure-receipt.schema.json), and
`validate` checks the resulting state without mutating it. The bridge, task
awareness, manifests, and MCP stdio surface are optional adapters around this
same local state. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for boundaries
and [THREAT-MODEL.md](docs/THREAT-MODEL.md) for what the checks do not prove.

## Project contents

- `skills/` — concise, portable Agent Skills.
- `recipes/` — bounded examples for common maintenance work.
- `catalog/` — declarative tool manifests.
- `schemas/` — lane, receipt, recipe, resource, and skill-source contracts.
- `docs/benchmarks/` — a no-dependency, local benchmark harness and its
  reproducibility notes.
- `site/` — a static, tracker-free overview.

## Privacy, security, and limits

State stays in the project directory and there is no telemetry or runtime
dependency. Do not put credentials in command arguments, environment dumps,
receipts, or issue reports. Read [SECURITY.md](SECURITY.md) and
[docs/PRIVACY.md](docs/PRIVACY.md) before using integrations. WorktreeProof
does not authenticate users, replace code review, prove an external deployment,
or guarantee that an AI-generated change is safe.

For crash-risk reduction, `resources scan` and `resources plan` provide bounded
diagnostics, backpressure recommendations, and recovery-oriented cleanup
inventory. They do not change OS settings, kill processes, delete files, run a
daemon, or promise to prevent crashes. If you inspect a crash dump or
`.heapsnapshot`, treat it as potentially containing conversations or
credentials and keep it private; this project never uploads or shares it.

## Support, governance, and roadmap

- [SUPPORT.md](SUPPORT.md) explains what belongs in a public issue and how to
  provide a redacted reproduction.
- [GOVERNANCE.md](GOVERNANCE.md) describes the maintainer decision process;
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to participation.
- [ROADMAP.md](ROADMAP.md) lists the intentionally small, evidence-gated next
  steps. It is a plan, not a promise of dates or adoption.
- [docs/benchmarks/README.md](docs/benchmarks/README.md) describes how to run
  the local benchmark. Its numbers are machine- and runtime-specific and are
  not a vendor or security comparison.

## Contributing

Run `npm test`, `npm run check`, and the release checklist before proposing a
focused change. See [CONTRIBUTING.md](CONTRIBUTING.md),
[docs/CROSS-AGENT-COMPATIBILITY.md](docs/CROSS-AGENT-COMPATIBILITY.md),
[docs/BRIDGE.md](docs/BRIDGE.md),
[docs/TASK-AWARENESS.md](docs/TASK-AWARENESS.md), and
[docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md).

WorktreeProof is an unofficial community project and is not affiliated with,
endorsed by, or sponsored by any vendor. It is released under the
[Apache License 2.0](LICENSE).
