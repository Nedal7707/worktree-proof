# Worktree Proof Workflow V3

**Status:** Canonical draft for CW-3. This document defines a workflow product in
its own workspace; it is not a feature of any single host product and does not
change any installed Codex configuration. CW-7 may install it later only after
the workspace has been reviewed and verified.

## §1 Purpose and scope

The Worktree Proof Workflow is an anti-burn control plane for agent-driven
engineering work. It keeps an agent attached to one bounded outcome, makes
terminal evidence measurable, and stops safely when the task is wrong, the
workspace is unsafe, or a breaker has fired. The workflow applies at dispatch,
execution, recovery, integration, and cleanup; it is deliberately independent
of the product being built.

This is workflow infrastructure, not a product feature. It must not leak into
the application domain, infer business state, or become an authorization gate
for a live product. Its clean-architecture shape is intentionally small: a
pure contract/ledger/breaker domain sits inside, adapters read Git and task
messages, and the outer lifecycle adapter performs worktree and ref cleanup.
The dependency direction points inward, so the proof rules can be tested
without a repository, browser, provider, or network.

For example, a task that says “document the release checklist” is complete only
when the named documentation gate and its verifier gate close. Merely asking an
agent to research the checklist, making a branch, or opening a draft PR does not
turn this workflow into a product capability and does not count as completion.

## §2 Immutable task contract

Every lane starts from one immutable task contract. The contract records a
unique `taskId` and `threadId`, one concrete outcome, a fixed list of named
terminal gates, the fixed `terminalTotal` denominator, the authoritative
baseline SHA, the allowed relative file scope, and the original deadline (or
the explicit value `none`). The contract also records the repository identity
and branch identity used by the right-target check. A contract is frozen before
the first mutation; changing its outcome, denominator, baseline, scope, or
deadline requires a new versioned contract and a new task identity.

An illustrative contract is:

```json
{
  "taskId": "cw3-spec-20260812",
  "threadId": "thread-7f4d",
  "outcome": "Draft and verify the V3 workflow specification",
  "terminalGates": [
    {"id": "CW3-SPEC", "acceptance": "WORKFLOW_SPEC.md contains §§1–10"},
    {"id": "CW3-AUDIT", "acceptance": "spec-audit.mjs exits 0"}
  ],
  "terminalTotal": 2,
  "baselineSha": "<frozen-origin-main-sha>",
  "allowedScope": ["docs/WORKFLOW_SPEC.md", "scripts/spec-audit.mjs"],
  "deadline": "none",
  "repoIdentity": "owner/worktree-proof",
  "branch": "main"
}
```

The example is illustrative rather than a permission to use that repository;
the runtime contract always supplies the actual right target. A caller cannot
silently add a gate after work begins, move the task to another thread, or
replace the baseline with the SHA that happens to be checked out. A contract
that is absent, incomplete, duplicated, or internally inconsistent is rejected
before a lane is created.

## §3 Fixed terminal ledger

Progress is a fixed ledger expressed only as
`terminal_closed / terminal_total`. Each denominator is established by the
contract and each numerator advances only when the corresponding named gate has
terminal evidence. Research, plans, context gathering, tests that are not a
named acceptance gate, commits, branches, PRs, drafts, inventories, and
commentary are useful work but are zero terminal progress. They cannot be used
to inflate a percentage or to replace a missing production/deployment gate.

For the example contract, the ledger begins as
`0/2 [CW3-SPEC, CW3-AUDIT]`. Writing the spec with the required sections closes
`CW3-SPEC` and produces `1/2`; a successful verifier run closes `CW3-AUDIT` and
produces `2/2`. A passing unit test that is not named in the contract remains
`0/2`. Gate IDs are stable, unique, and referenced by their evidence, so a
recovery cannot claim a different gate using a caller-supplied label.

The ledger is not a subjective work percentage and never combines unrelated
ledgers such as security, release, first-use, or polish. If no terminal gate
can be named, the contract is invalid rather than “complete by default.”

## §4 Right-target, baseline, and identity checks

Before any mutation, the workflow verifies the absolute current working
directory, the registered worktree root, the current branch, the remote
repository identity, and the exact `origin/main` SHA. The checked-out baseline
must match the contract's authoritative baseline SHA (or a contract-approved
ancestor rule); a local commit or a similarly named clone is never evidence.
The task and thread identities are checked at the same boundary. All checks
fail closed and record a redacted reason before a file, ref, database object,
or external service is changed.

For example, a lane whose contract names
`/path/to/worktree-proof-workflow` must reject a process running in
`/path/to/another-host-product`, even if both contain a file named
`WORKFLOW_SPEC.md`. Likewise, a branch that points at a different remote or an
`origin/main` SHA that differs from the frozen baseline is a target mismatch,
not an invitation to update the contract.

## §5 Wrong-task rejection

Steering, recovery, and lifecycle messages carry the destination `taskId` and
`threadId`. A message is accepted only when both match the immutable active
contract and its scope is allowed. A steer to a non-matching task, a stale
thread, or a sibling lane is ignored and logged as a wrong-task event; it does
not mutate files, counters, breakers, receipts, branch state, or the terminal
ledger. The sender is not allowed to make a mismatch look harmless by omitting
an identity field.

For example, while task `cw3-spec-20260812` is active, a message addressed to
`cw2-router-fix` is recorded as `WRONG_TASK_REJECTED` and discarded. A matching
message may still be rejected later if its requested path is outside
`allowedScope`; identity matching is necessary but not sufficient.

## §6 Breakers and blocked-auto-wake

Breakers are deterministic, per-task state and are evaluated before an action
and again after it. A repeated ordinary failure of the same class reaches a
three-strike stop; the third strike closes the lane for that class and prevents
an automatic retry. A repetition breaker detects the same operation signature
(target, command, and relevant arguments) being attempted without new evidence
and stops the lane instead of grinding the same path. A tool-call breaker stops
at 40 calls for one item when no terminal gate has closed. A token ceiling of
approximately one million tokens per item and an explicit wall-time ceiling
per gate are hard stops, not estimates; the ledger remains unchanged when a
breaker fires.

When a gate is blocked on a human action or an unavailable external state, the
workflow emits one concise owner blocker line containing the action and reason,
marks the lane blocked, and stops. It does not poll, sleep, schedule a wake, or
wait for a reply that might never arrive. A later, explicit resume must pass
rehydration and receipt validation; “blocked” is not permission for an auto-wake
loop.

The V3 correctness baseline is deliberately stricter than permissive legacy
routers. An absent, empty, or incomplete recovery receipt is rejected, even if
the counters appear safe. Caller-supplied `reasonCodes` and `version` are not
trusted: the runtime recomputes both from canonical breaker state and the V3
schema before accepting a receipt. This prevents a caller from bypassing a
counter or declaring a healthy version after a breaker has fired.

## §7 Recovery receipts

A recovery receipt is a closed JSON record proving that the last known breaker
state was healthy and that the lane may be rehydrated. Its schema includes the
literal protocol marker `SAFE-WORKFLOW-V3`, task and thread identities,
repository/branch/baseline identity, serialized breaker counters, the fixed
ledger, a canonical state digest, and an issuance timestamp. The validator
requires every field, rejects unknown identity substitutions, recomputes
`reasonCodes` and `version` from the canonical state, and then compares the
recomputed values with the serialized record. A receipt is not an instruction
to skip right-target or baseline checks.

Receipt serialization is round-trip safe: values recorded as serialized trips
remain trips as trips after parse and re-serialization, with their order,
cardinality, and numeric values preserved. No lossy coercion, implicit reset,
or “helpful” default can turn a trip history into a healthy state. A malformed,
missing, empty, truncated, schema-incomplete, or checksum-mismatched receipt
fails closed and requires a fresh bounded lane or an explicit recovery-preserve
path.

For example, a valid receipt can be adopted only when its task/thread IDs,
worktree identity, baseline SHA, and ledger digest all match the current
contract. During recovery the workflow repeats those identity and baseline
checks; it never treats the receipt as a bypass. A receipt claiming
`reasonCodes: []` while its counters show three identical failures is rejected
because the validator recomputes the reason code. A receipt with a caller
version such as `SAFE-WORKFLOW-V2` is likewise rejected even when all other
fields look safe.

## §8 Exact cleanup

Cleanup is part of terminal lane closure. The exact registered worktree root is
validated, committed or intentionally abandoned changes are handled, and the
worktree is pruned in the same session. Superseded branches and refs are deleted
after the merge or abandonment decision; they are not left as a second source
of truth. A dirty checkout is never removed with `--force`: it is preserved for
bounded rescue, reported, and recovered or explicitly abandoned before a later
cleanup attempt.

There is one narrow recovery-preserve exception. An explicit
`--preserve-recovery --adopt-existing true` operation may run one bounded
cleanup/recovery command against an already registered, identity-validated
worktree. It may not create a new branch, spawn another lane, expand scope, or
turn a malformed receipt into a clean state. After rescue, the same exact-root
prune and superseded-ref deletion rules apply.

## §9 Crash recovery

After a process crash, restart, or context compaction, the lane performs
rehydration before any mutation. It re-reads the current owner request, the
immutable task contract, the fixed terminal ledger, the canonical checklist,
the registered branch/worktree state, and `origin/main`; it then validates the
recovery receipt against those sources. Summaries, chat history, cached plans,
and memory are useful hints but are never authority. If any source is missing,
stale, mismatched, or unreadable, recovery fails closed and emits one bounded
blocker rather than guessing.

For example, after a laptop restart the lane cannot resume from a note saying
“the spec gate was done.” It must prove the named gate from the contract and
re-read the file and baseline. If the branch was deleted or `origin/main`
advanced beyond the frozen identity, the lane records the mismatch and waits
for a new versioned contract instead of mutating a newly created branch.

## §10 Best-practice references

These references shape the implementation and its review gates; they are
principles, not additional mutable policy files:

- **Clean-code guard:** keep contracts, breakers, and adapters small, explicit,
  and testable; avoid clever defaults that hide unsafe state.
- **Code-review-and-quality:** review the diff against the contract and named
  gates, with evidence attached to each acceptance decision.
- **Debugging-and-error-recovery:** classify failures, preserve the first useful
  evidence, and stop after bounded retries instead of looping on symptoms.
- **CI/CD and automation:** make preflight, verifier, cleanup, and deployment
  steps deterministic and reproducible, with fail-closed status propagation.
- **Context engineering:** rehydrate only authoritative sources after a crash,
  keep the task context bounded, and never confuse summaries with state.
- **Deprecation and migration:** version contract/schema changes explicitly,
  preserve a compatibility window where needed, and remove superseded refs and
  behavior deliberately rather than silently widening scope.

Together these practices enforce the clean-architecture dependency rule: the
workflow's proof domain remains independent of Git, shells, browsers, and
providers, while adapters make every external observation explicit and
auditable.
