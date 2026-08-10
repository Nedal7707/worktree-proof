---
name: worktree-proof
description: Coordinate bounded coding-agent lanes with explicit scopes, reservations, run records, and closure receipts. Use when parallel work needs conflict checks, auditable handoffs, stale-lane cleanup, or deterministic validation.
---

# WorktreeProof

Use WorktreeProof to make parallel work explicit and terminally auditable. Keep the lane identifier, relative file scope, command outcome, and closure evidence together.

## Workflow

1. Inspect project instructions and run `worktree-proof doctor`.
2. Describe one bounded objective with `worktree-proof plan`.
3. Reserve a unique lane and non-overlapping relative scope with `worktree-proof reserve`.
4. Run only reviewed commands through `worktree-proof run`; keep credentials out of arguments and output.
5. Use `worktree-proof status` to expose active, released, and awaiting-closure lanes.
6. Attach checks and redacted evidence with `worktree-proof close`. A branch or commit is not a closure.
7. Use `worktree-proof release` for abandoned work and `worktree-proof cleanup --dry-run` before removing stale state.
8. Finish with `worktree-proof validate` and preserve the resulting receipt.

## Scope discipline

- Normalize scopes relative to the project root and reject traversal.
- Treat a file and its parent directory as overlapping; reject both while active.
- Keep one objective per lane and never infer ownership from a plan alone.
- Prefer JSON output for automation and human-readable output for review.

## Failure handling

If a reservation conflicts, a receipt is malformed, or state is stale, stop the lane and report the precise reason. Do not force cleanup, rewrite another lane's receipt, or claim completion without validation evidence.

Read the project's architecture and threat-model notes when a command or receipt format changes. Keep this skill concise; load only the referenced document needed for the current decision.
