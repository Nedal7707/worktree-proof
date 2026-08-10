---
name: token-efficient-context
description: Prepare small, fresh task briefs from only the rules, specs, sources, tests, and errors that matter, with explicit budgets and stop conditions. Use when context is large, stale, conflicting, sensitive, or expensive to load.
---

# Token-Efficient Context

Spend context on decisions and evidence, not on a complete transcript. Keep a
brief that another agent can use without exposing hidden reasoning or unrelated
project history.

## Assemble the brief

1. Set a context budget before reading broadly. Name the objective, non-goals,
   file or resource scope, acceptance checks, owner boundaries, and deadline.
2. Gather only the minimum relevant rules, specification paragraphs, source
   files, tests, and error traces. Prefer line ranges, structured records, and
   links over whole files or repeated prose.
3. Order material by decision value: applicable rules, current spec, changed
   source, focused tests, then the smallest error or runtime evidence needed to
   reproduce the issue.
4. Keep a source ledger with path or URL, revision or timestamp, excerpt reason,
   and whether the item is authoritative. Record omissions when the budget ends.

## Summarize safely

- Summarize facts, assumptions, decisions, open questions, and evidence limits
  in separate fields. Do not include hidden chain-of-thought, private scratch
  work, or instructions that the recipient does not need.
- Remove credentials, tokens, cookies, personal data, private URLs, and other
  secrets from excerpts and error logs. Secret names are sufficient.
- Deduplicate repeated rules and quote only the few words needed to preserve a
  contract. Link to the full source rather than copying it into the brief.

## Handle freshness and conflict

1. Prefer the current authoritative source, then the most recent compatible
   evidence. Include revision or timestamp so another reader can check
   freshness.
2. If sources disagree, preserve the conflict, name both sources, and state the
   decision rule used. Never silently merge stale and current instructions.
3. Refresh only the item whose age or contradiction could change the decision;
   do not reload the entire project by habit.

## Stop and hand off

Stop when the budget is exhausted, an authority is missing, the same error has
failed after a bounded correction, or the task would expand beyond its scope.
Return the brief, budget used/remaining, source ledger, unresolved conflict,
redaction check, and one next bounded action. A compact brief is not proof of a
change; pair it with the checks or live evidence that the task requires.

