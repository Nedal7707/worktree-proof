# Architecture

WorktreeProof is a small, local-first CLI. The command layer writes structured
records; validators read those records without needing a service account or a
network connection. The repository is the source of truth for the command and
schema contracts; this page describes the data flow, not a hosted protocol.

## Core objects

- **Plan** — the intended objective, lane identifiers, and allowed relative scopes.
- **Reservation** — an active claim for one lane and scope. Two active reservations may not overlap.
- **Run record** — command, start/end time, exit status, and redacted output references for a reserved lane.
- **Closure receipt** — evidence, checks, and disposition that make a lane terminally closed or explicitly abandoned.
- **Bridge message** — an explicit, bounded local handoff between named agent
  surfaces. Task messages reserve the same scope registry as ordinary lanes.
- **Task snapshot** — a sanitized, host-injected view containing hashed IDs,
  status, explicitly reported mode, and bounded reservations only.

The exact serialized fields live in `schemas/`. Treat schemas as contracts: add a field only when a command, validator, or report consumes it.

## Local data flow

All default state is rooted at `.worktree-proof/` below the `--repo` path (or
the current directory). A configured state path can move these records, but it
does not make them shared or hosted.

| Stage | Command or module | Writes | Reads / boundary |
| --- | --- | --- | --- |
| Intent | `plan` | A plan JSON record | Lane IDs and normalized relative scopes |
| Ownership | `reserve`, `release`, `leases` | `leases.json` | The local lease registry; overlapping scopes fail closed |
| Execution | `run` | A bounded run record under `runs/` | User-supplied argv; the child is not sandboxed |
| Closure | `close` | A validated receipt under `closures/` | Caller-supplied JSON only; no inferred merge/deploy evidence |
| Inspection | `status`, `validate` | Nothing | Local records; output is sanitized for the CLI envelope |
| Optional adapters | `bridge`, `tasks`, `manifest`, MCP | Explicit adapter records or stdout responses | No implicit account, network, or hidden-context channel |

The state directory is ordinary project data. A user or another process with
filesystem access can alter it; validation proves that a record matches the
local contract, not that an external system or a hostile host is trustworthy.

## Command boundaries

`doctor` checks prerequisites. `plan` describes intent. `reserve` and `release`
mutate active ownership. `run` executes a command selected by the user.
`status` reads state. `close` records terminal evidence supplied in a JSON
receipt and fails when the receipt is missing or invalid. `bridge` performs
explicit local message lifecycle steps. `tasks inspect` sanitizes a supplied
snapshot. `cleanup` delegates only an explicit worktree cleanup plan; resource
cleanup inventory is non-mutating. `validate` checks consistency without
mutating state.

Each mutating command should be atomic from the caller's perspective: write a
temporary record, validate it, then replace the target. A failed validation must
leave the previous record intact. `close` deliberately does not release a
reservation; release is a separate, auditable command so a caller can decide
whether the lane is still owned.

## Scope matching

Normalize paths relative to the project root, reject traversal outside that root, and compare path components rather than string prefixes. A file and its containing directory overlap; sibling directories do not. Unknown or malformed scopes fail closed.

## Extension points

Keep storage and command output deterministic enough for tests. Prefer JSON
output for automation and human-readable output for interactive use. New
integrations should be optional adapters with explicit, documented boundaries
rather than hidden network calls. The MCP surface is stdio-only in 0.3.4; it
does not imply a remote transport or hosted coordination service.

## Recovery model

Before a destructive repository operation, preserve the project and
`.worktree-proof/` state. Use `status` and `validate` to inventory records,
`leases inspect` to understand stale ownership, and the explicit recovery path
only after inspecting its input. A receipt with `outcome: "abandoned"` must
state `branchDeleted: true` and `worktreeClean: true`; a `merged` receipt must
name its canonical reference, merge SHA, and checks. WorktreeProof cannot
restore files or reconstruct a missing receipt on its own, so ordinary file
backups remain the recovery authority.
