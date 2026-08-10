# Token Efficiency

Use context as a bounded evidence budget. A task brief should make the next
decision possible without reproducing a repository, a transcript, or hidden
reasoning.

## Minimum brief

Include:

- objective, non-goals, owner boundaries, and relative scope;
- acceptance checks and the exact test or preview command;
- the smallest relevant rule/spec excerpts, source paths, tests, and errors;
- a source ledger with revision or timestamp and authority;
- assumptions, conflicts, omissions, and budget used/remaining.

Read in this order: applicable rules, current specification, changed source,
focused tests, then the smallest error or runtime trace needed to reproduce the
problem. Prefer line ranges, structured records, and links over full-file dumps.

## Freshness and privacy

Prefer the current authoritative source, then the newest compatible evidence. If
sources disagree, preserve the disagreement and name the decision rule; never
silently blend stale instructions into a current brief. Remove credentials,
tokens, cookies, personal data, private URLs, and unnecessary request bodies.
Summaries must contain facts and evidence limits, not hidden chain-of-thought or
private scratch reasoning.

## Stop conditions

Stop and hand off when the budget is exhausted, an authority is missing, a
bounded correction still reproduces the same error, or the request would expand
scope. Return one next action and label everything else `unverified`.

See [`token-efficient-context`](../skills/token-efficient-context/SKILL.md) for
the reusable brief workflow.

