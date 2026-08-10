# Architecture

WorktreeProof is a small, local-first CLI. The command layer writes structured records; validators read those records without needing a service account or a network connection.

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

## Command boundaries

`doctor` checks prerequisites. `plan` describes intent. `reserve` and `release` mutate active ownership. `run` executes a command selected by the user. `status` reads state. `close` records terminal evidence. `bridge` performs explicit local message lifecycle steps. `tasks inspect` sanitizes a supplied snapshot. `cleanup` removes only records proven stale or disposable. `validate` checks consistency without mutating state.

Each mutating command should be atomic from the caller's perspective: write a temporary record, validate it, then replace the target. A failed validation must leave the previous record intact.

## Scope matching

Normalize paths relative to the project root, reject traversal outside that root, and compare path components rather than string prefixes. A file and its containing directory overlap; sibling directories do not. Unknown or malformed scopes fail closed.

## Extension points

Keep storage and command output deterministic enough for tests. Prefer JSON output for automation and human-readable output for interactive use. New integrations should be optional adapters with explicit, documented boundaries rather than hidden network calls.
