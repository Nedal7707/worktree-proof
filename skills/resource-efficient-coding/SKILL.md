---
name: resource-efficient-coding
description: Choose bounded CPU, RAM, disk, concurrency, cache, and artifact practices from measured host resources. Use when planning or reviewing parallel coding work, CI jobs, builds, cleanup inventories, or evidence collection where resource pressure and safe recovery matter.
---

# Resource-efficient coding

Use measured, bounded diagnostics before starting parallel work. Prefer the
smallest safe job shape that satisfies the acceptance check, and preserve a
recovery path for every artifact.

## Establish the budget

1. Run the read-only resource scan for the target repository. Capture logical
   CPU count/load, system RAM and pressure, Node/process heap, repository-volume
   free space, bounded footprint categories, and current concurrency.
2. Record traversal limits and unavailable or blocked probes. Treat missing
   measurements as uncertainty; choose a conservative profile rather than
   inventing capacity.
3. Select `low-resource`, `balanced`, `fast`, or `ci` explicitly when the lane
   needs reproducibility. Let automatic selection choose conservatively only
   when the request permits it.

## Bound work

- Derive worker count from logical CPU, current active lanes, RAM per worker,
  and disk reserve. A recommendation of zero means wait for capacity; never
  replace it with an unbounded retry loop.
- Keep the public request at 8 unless a user explicitly selects another value;
  accept at most 24 as a request. The host/runtime ceiling, live measurements,
  and other-task reservations may only reduce the effective count.
- Cap job fan-out and queue depth. Keep CPU-heavy jobs near the measured safe
  CPU cap; use modest oversubscription only for genuinely I/O-bound work.
- Use bounded traversal (`maxDepth` and `maxEntries`) for footprint checks.
  Do not sweep a filesystem broadly, follow links, or open file contents.
- Stop or downgrade when RAM pressure is high, disk free space is low, or a
  probe is blocked. Emit the reason in evidence.

## Manage caches and artifacts

- Prefer deterministic, size-capped caches and retain only artifacts needed for
  the review or closure receipt.
- Classify build and cache outputs as generally rebuildable, but treat worktree
  data as conditional until uncommitted changes are ruled out.
- Use `planProjectCleanup` only to inventory project-scoped candidates. Every
  candidate must remain `safeToDelete: false` and require a later explicit
  confirmation plus a fresh containment/symlink check. Never add deletion
  commands to a diagnostic or cleanup plan.
- Keep secrets, credentials, cookies, tokens, and private file contents out of
  scans, fixtures, logs, screenshots, and evidence.

## Report evidence

Return the scan timestamp, selected profile, worker recommendation, measured
ratios/sizes, traversal bounds, warnings, and the command or test that consumed
the result. Distinguish local measurements from live production proof. State
what was unavailable or unverified, and include a reversible next action rather
than claiming a cleanup or capacity change happened.
