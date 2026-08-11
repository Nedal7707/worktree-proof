# Roadmap

This is an evidence-gated roadmap for an unofficial community project. It lists
areas to investigate, not delivery dates, guaranteed features, or adoption
targets. A proposed item is not complete until a focused change, tests, and a
reviewable terminal record exist.

## Current focus (0.1.x)

- Keep the local CLI, JSON schemas, and closure receipts deterministic and
  inspectable.
- Improve cross-platform examples and redacted recovery guidance.
- Keep the Codex/Claude adapters and MCP stdio surface optional, bounded, and
  explicit about their local-only limits.
- Publish reproducible local benchmarks without presenting machine-specific
  timings as product comparisons.

## Later, only with evidence

- Evaluate additional client adapters after a public contract and fixture exist.
- Consider richer receipt/reporting views if they have a clear consumer and do
  not retain secrets or hidden context.
- Revisit network or telemetry features only after an opt-in data-flow design,
  retention policy, threat-model update, and an explicit rollback plan.

## Out of scope for this roadmap

WorktreeProof does not promise a hosted coordination service, a security
sandbox, autonomous merging, universal vendor support, guaranteed correctness,
or a live-trading/payment workflow. Those would be materially different
products and are not implied by the current repository.
