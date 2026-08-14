# Helper Policy — Internal Lane Codification

**Status:** Canonical policy for CW-4. This document codifies the helper policy
derived from the global Vector AGENTS.md and owner decisions. It is not a
feature of any single host product and does not change any installed Codex
configuration. It applies to internal helper lanes only and is verified by
`spec-audit.mjs`.

## §1 Ceiling vs effective pool

The owner'"'"'s requested ceiling is 20 concurrent internal helper lanes. The
effective pool size is always 0–20 and is determined exclusively by the
intersection of two constraints: genuinely independent non-overlapping lane
scopes and live resource availability. A lane is only genuinely independent
when its relative `fileScope` shares no files, functions, mutable database
objects, or external resources with any other active lane. Live resources
include native internal-helper availability, CPU/RAM/disk headroom, commit age
warnings, and Windows Event 2004 signals. The effective pool is the minimum of
the independent-lane count and the resource gate; it is never the requested
ceiling by default. No slot is filled merely because it exists.

## §2 Lane selection

Every new BUILD dispatch must carry a unique normalized `laneId` and a
non-empty relative `fileScope`. The router rejects duplicate IDs, overlapping
scopes, nested or sidebar overflow lanes, and any active lanes above the
resource-selected capacity. Multiple valid active managed lanes are permitted
only when their IDs and scopes are strictly unique. Unknown, stale,
out-of-scope, and rescue sidecars remain terminal blockers; cleanup or adopt
may resume the existing branch to recover them. Existing sidecars using the
legacy `lane` field remain readable, while new sidecars write canonical
`laneId`. CLI dispatch carries `--lane-id`, `--file-scope`, and optional
active sidecars; no nested/sidebar overflow or user-visible tasks are created.

## §3 Compact briefs and terminal-first allocation

Each lane receives a self-contained prompt that describes one closed outcome,
its named terminal gates, the fixed `terminalTotal`, the authoritative baseline
SHA, and the allowed relative file scope. The brief does not contain open-ended
research, vague "investigate" language, or multi-outcome bundles. Allocation
is terminal-first: a lane is only created when its same-session terminal
capacity — merge to `origin/main`, required deploy/wire, redacted live evidence,
and activity-log row — is paired and named. Dirty/rescue recovery is always
first priority; then existing terminal integration/deploy work, ready-to-apply
patches, audits, and generic cleanup. While any actionable old/no-PR/dirty/
unmerged backlog exists, allocation is 100% terminal integration/cleanup and 0%
build. Only after the backlog reaches zero does the exact 50/50 build versus
integrate-wire-deploy split apply. Backfill targets the highest nonempty
priority; a branch or PR is never created unless its same-session terminal
capacity is paired and named.

## §4 No forced utilization

An idle slot is acceptable and expected when no genuinely independent item
exists. Spawning a lane solely to occupy capacity is a workflow violation.
Helpers are the default for every genuinely separable subtask, but "separable"
means strictly non-overlapping scope and an independent terminal gate. If the
remaining work shares files, database objects, or external resources with an
active lane, it is not separable and must wait for that lane to close.
Backfilling a returned slot is mandatory only when an independent item exists;
it is forbidden when none does. The router enforces this by checking the
active lane inventory and the live checklist for unchecked items with disjoint
scope before any dispatch.

## §5 No sidebar / user-visible task overflow

All helper work runs through internal managed lanes (`luna_max`, Terra
fallback, or the inherited model). No user-visible Codex sidebar tasks, chat
forks, or external task creations are used as overflow or backfill. The
effective internal helper limit is the authoritative ceiling; exceeding it by
creating sidebar tasks is a violation. If the effective internal pool is full,
the work waits for a slot to return rather than spilling to a user-visible
surface. Lane output is a PR, a ready-to-apply patch, or evidence returned to
the manager; it never becomes a separate Codex task in the sidebar.

## §6 Activity is not progress

Progress is measured exclusively as `terminal_closed / terminal_total` with
named gate IDs and concrete terminal evidence. Helper activity — spawns,
reasoning tokens, tool calls, test runs, commits, branches, PRs, plans,
commentary, and wall-clock time — are all zero terminal progress. A checklist
item or percentage advances only after its same-session terminal closure:
merge to `origin/main` plus any required deploy/wire and redacted live evidence,
or explicit abandonment with branch deletion and clean worktree recovery.
Audits, plans, inventories, cleanup-only review, branches, commits, PRs,
manifests, and ready patches are 0 progress by themselves. No percentage is
invented or reported without fresh terminal measurement.

## §7 Model/reasoning/speed rules

Model, reasoning effort, and speed tier are never overridden before a Codex
restart. The selected parent effort is preserved. Helpers run at standard
default speed only; no `service_tier = "fast"` or equivalent override is set
by instruction. Luna Max (`gpt-5.6-luna` at Max reasoning) is the default
parallel executor through the custom `luna_max` agent when delegation is
active. Terra (`gpt-5.6-terra`) is the substantive fallback when Luna is
unavailable or a lane needs stronger all-rounder reasoning. NVIDIA models
(`nvidia/z-ai-glm-5.2`, `nvidia/deepseek-ai-deepseek-v4-pro`,
`nvidia/nvidia-nemotron-3-ultra-550b-a55b`, `nvidia/minimaxai-minimax-m3`)
are extra capacity only: each exact model receives at most one dispatch per
session; on first failure (slow, unavailable, rate-limited, erroring, or
unusable output) that exact model is dropped for the session and the lane
immediately moves to an exposed Terra surface; if none is callable, the
inherited model is used. Never retry, cool down, re-check, poll, sleep,
schedule, or sweep for NVIDIA availability. Full-history forks inherit the
parent model; no helper identity or selector is invented.

## §8 No authority gates

Helpers never become authority gates, approvers, blockers, supervisors, or
owner-facing voices. Accountability remains wholly with the manager (Sol).
Each lane receives one closed independent subtask and returns its output to
the manager. One correction round is permitted: if the output is unusable, the
manager may return it once with a concrete correction. After one correction
round, the lane output returns to the manager or a fresh Terra lane is opened
without delaying other work. Helpers never approve, block, poll, wait on one
another, or spawn a recursive tree solely to evade an internal slot limit.
Sol reviews evidence and decides; Sol does not perform implementation typing,
test-suite execution, conflict resolution, PR creation, merge, deployment,
cleanup, or production mutation by hand — a Luna lane executes those acts.

## §9 Resource gating

Before a new build worktree, native internal-helper availability is explicitly
verified and dirty/rescue recovery is completed. A restart resumes dirty work
first. CPU/RAM/disk pressure, commit age warnings, and Windows Event 2004
signals reduce the effective helper count; unavailable native internal helpers
block spawning rather than being retried. A loopback OpenCodex relay is never
a dispatch prerequisite. Superseded refs and worktrees are deleted in the same
session after a merge/abandon decision. The inactive worktree sweep is
cleanup-only and does not dispatch helpers. SAFE-3 is enforced at the lifecycle
entry point: every normal `npm run agent:worktree -- ...` call must include a
current, valid `--circuit-breaker-json` receipt. Missing, malformed, or tripped
state fails closed before branch/worktree creation. The only tripped-state
exception is the explicit `--preserve-recovery --adopt-existing true`
integrate/cleanup path, which may run one bounded recovery command against an
already-registered worktree and may not create, spawn, backfill, or expand
scope.

## §10 Backfill discipline

Backfill discipline operates on a strict priority queue: dirty/rescue recovery
is first; then existing terminal integration/deploy work, ready-to-apply
patches, audits, and generic cleanup. When a lane returns, the returned slot
is backfilled immediately if and only if an independent item exists at the
highest nonempty priority. If no independent item exists, the slot remains
idle — this is correct and expected. Backfilling when no independent item
exists is a workflow violation. The router enforces this by checking the
active lane inventory and the live checklist for unchecked items with disjoint
scope before any dispatch. Multiple valid active managed lanes are allowed
only when their IDs and scopes are unique; the router rejects duplicate IDs,
overlapping scopes, nested/sidebar overflow, and active lanes above the
resource-selected capacity.
