# Changelog

## [0.3.3] - 2026-08-15

### Fixed

- MCP `initialize` handshake now advertises the current package version instead of a stale `0.2.0` literal; the version now comes from a single `src/version.js` source shared with the CLI.
- Registry and bridge lock acquisition treats Windows `EPERM`/`EACCES` as transient busy conditions bounded by the same retry attempts.

### Added

- CLI benchmark harness (`npm run benchmark`) timing the core lane lifecycle with correctness assertions, plus benchmark/eval result schemas.

### Changed

- Deduplicated the MCP safety helpers (`plainObject`, `DANGEROUS_KEYS`), the lease registry reader, and `canonicalRealPath`; removed a dead recipe-path check and an unused scopes map. No behavior change.

## [0.3.0] - 2026-08-12

### Added

- Worktree Proof Workflow V3 specification (WORKFLOW_SPEC.md) with immutable task contracts, fixed terminal ledgers, right-target/baseline/identity checks, wrong-task rejection, breaker and blocked-auto-wake circuits, recovery receipts, exact cleanup, and crash recovery.
- Helper Policy codification (HELPER_POLICY.md) with ceiling vs effective pool, lane selection, compact briefs, terminal-first allocation, no forced utilization, no sidebar overflow, activity-is-not-progress rule, model/reasoning/speed rules, no authority gates, resource gating, and backfill discipline.
- Spec audit script (scripts/spec-audit.mjs) verifying §§1–10 presence in both documents.

### Changed

- Generalized locally proven anti-burn workflow into public WorktreeProof product with conservative defaults and curated upstream skill references.



All notable changes to WorktreeProof are documented here.

## [0.2.0] - 2026-08-11

### Changed

- Updated package, CLI, MCP server, site, and documentation metadata to 0.2.0.
- Documented the tagged 0.2.0 GitHub installation path and release-integrity checks.

## [0.1.0] - 2026-08-10

### Added

- Initial public package metadata and CLI contract.
- Conflict-safe lane reservations and closure-receipt documentation.
- Architecture, threat-model, privacy, provenance, maintenance, and demo notes.
- Three concise Agent Skills for lane work, OSS maintenance, and safe delegation.
