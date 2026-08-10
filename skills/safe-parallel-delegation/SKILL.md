---
name: safe-parallel-delegation
description: Design safe, model-agnostic parallel work with unique lane identifiers, non-overlapping scopes, and terminal receipts. Use when splitting coding, review, test, or documentation work across independent execution surfaces.
---

# Safe Parallel Delegation

Split work only when the lanes are genuinely independent. Keep the coordinator responsible for decomposition, conflict decisions, and final synthesis; each executor receives one closed scope and one terminal outcome.

This skill does not activate, emulate, or imply an unexposed native Ultra flag. It is model-agnostic and works with whatever execution surfaces are actually available.

## Dispatch

1. Read the current task and list the smallest useful independent units.
2. Give every unit a unique normalized lane identifier and a non-empty relative file or resource scope.
3. Reject duplicate, nested, or overlapping scopes before dispatch.
4. Pair build work with a named integration target; never treat a branch, patch, or review comment as terminal delivery.
5. Keep shared files, mutable records, external resources, and hidden state out of parallel lanes.

## Execute and integrate

Capture command results and redacted evidence per lane. When a lane returns, inspect its diff and validation result, then integrate or explicitly abandon it before reusing the scope. Backfill only with a new non-overlapping unit.

## Failure rules

If a scope cannot be proven independent, keep it serial. If a dispatch fails, record the failure, correct the actual input once, and avoid retry loops. If evidence is incomplete, leave the lane open or abandon it explicitly; never infer closure.

Read the project's architecture and threat-model notes when dispatching commands that mutate state or capture output. Keep the skill concise and load only the relevant reference.
