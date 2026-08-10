# Resource optimization

`src/resources.js` provides read-only diagnostics for choosing bounded WorktreeProof
work. It has no third-party dependencies and supports Node 20+ ESM.

## API

```js
import {
  scanResources,
  chooseResourceProfile,
  recommendConcurrency,
  planProjectCleanup,
  summarizeResources,
} from 'worktree-proof/resources';

const scan = await scanResources({ repoPath: process.cwd() });
const profile = chooseResourceProfile(scan, 'balanced');
const workers = recommendConcurrency(scan, {
  kind: 'cpu',
  memoryPerWorkerBytes: profile.memoryPerWorkerBytes,
  max: profile.maxConcurrency,
});
console.log(summarizeResources(scan));
```

`scanResources` reports logical CPU count and load average, process/Node heap,
system RAM and a pressure ratio, filesystem capacity for the repository volume,
bounded repository footprint categories (`git`, `worktree`, `build`, and
`cache`), and the current active-lane count. The `os`, `fs`, metric objects, and
clock can be injected for deterministic tests; production callers normally use
the host probes.

## Profiles and concurrency

- `low-resource` uses one worker, a small per-worker memory budget, minimal
  cache retention, and a larger disk reserve.
- `balanced` is the default when measurements are ordinary.
- `fast` uses available CPU more aggressively but remains capped by RAM, disk,
  and the profile limit.
- `ci` keeps deterministic, bounded cache/artifact behavior and caps workers
  for predictable evidence collection.

Pass an explicit profile when reproducibility matters. Automatic selection is
conservative: high RAM or disk pressure selects `low-resource`; sustained CPU
pressure selects `balanced`; a lightly loaded host may select `fast`. A current
lane count is subtracted from the recommendation, so zero means “wait for
capacity” rather than “start an unbounded job.”

The public default request is 8 and a user may explicitly request up to 24.
Those numbers are requests, not host promises. An explicit host/runtime
ceiling, live resource capacity, and other active-task reservations can only
reduce the effective result. A caller-provided minimum never overrides RAM or
disk safety.

## Bounded and safe diagnostics

Footprint traversal is limited by `maxDepth` (default 4) and `maxEntries`
(default 4096). It uses `lstat` and `readdir` only, never opens file contents,
follows symbolic links, or scans outside `repoPath`. Unreadable, escaping, or
symlink paths are marked `blocked`; no unsafe size is guessed. Missing host
probes are represented as `unavailable`, which should lead to a conservative
profile.

Diagnostics do not inspect secrets, environment values beyond the optional
non-secret active-lane count, credentials, cookies, or private file contents.
They do not alter OS settings, terminate processes, change scheduling, or
delete anything.

## Cleanup inventory

`planProjectCleanup(scan, { allowedRoots })` is an inventory only. It can list
existing build, cache, and worktree paths that are inside the explicitly named
project roots, their measured bytes, and recoverability:

- build/cache entries are generally `rebuildable`;
- worktrees are `conditional` because they may contain uncommitted work.

Every item has `safeToDelete: false`, `requiresConfirmation: true`, an empty
`commands` array, and `executionRequired: true`. A separate, explicitly
confirmed executor must re-check containment, symlink state, and recoverability
before any mutation. This module intentionally supplies no executor.

## Evidence and trade-offs

Record the scan timestamp, profile, worker recommendation, traversal bounds,
and warnings with a lane closure receipt. Keep evidence redacted: report
counts, ratios, sizes, and statuses, not secrets or file contents. Re-run the
bounded scan after a build or cleanup proposal; repository state alone is not
production proof. Prefer lower concurrency when RAM pressure, disk pressure, or
probe uncertainty is high, and prefer bounded caches/artifacts over deleting
data speculatively.
