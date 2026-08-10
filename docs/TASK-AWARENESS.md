# Privacy-safe task awareness

`worktree-proof tasks inspect --input snapshot.json --json` sanitizes a
one-shot host-provided task inventory. WorktreeProof never lists threads by
itself, polls a host, reads another task, or changes another task.

The output keeps only:

- a deterministic hashed task ID;
- normalized active, idle, not-loaded, or unknown status;
- a mode only when the host explicitly reports it;
- a bounded resource reservation;
- the last-updated timestamp.

Titles, summaries, working directories, prompts, task contents, credentials,
and raw IDs are discarded. If the host does not expose Ultra or another mode,
the result is `unknown`; names and text are never used to infer it.

The public resource policy requests 8 helpers by default and accepts an
explicit request up to 24. Requested capacity is not available capacity. The
effective number remains the lower of the request, configured maximum,
explicit host/runtime ceiling (when reported), measured CPU/RAM/disk-safe
capacity, and capacity left after other active task reservations. It may be
zero. WorktreeProof never creates sidebar tasks as overflow.

This repository defines the generic contract only. It does not change a host's
thread limit or any user's private configuration.
