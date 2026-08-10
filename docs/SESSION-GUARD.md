# Session guard and interruption recovery

WorktreeProof treats desktop crash risk as a bounded coordination problem, not
as something a script can eliminate. `worktree-proof resources scan` reports
host signals and `worktree-proof resources plan` returns a read-only session
guard plus cleanup inventory.

The guard recommends one parent/integrator, a queue with backpressure, a
default request of 8 (with deliberate requests accepted up to 24), and RAM/disk
reserve. The host/runtime ceiling and measured safe capacity may lower that
number or reduce it to zero. It refuses a new lane recommendation when measured
capacity is exhausted. Recovery points
to stale lease revalidation and rescue-worktree preservation after an
interruption. It does not change OS settings, kill processes, run a daemon,
delete files, or depend on private host APIs.

Optional manual diagnostics are intentionally owner-controlled:

- Compact a long assistant context before starting another major task.
- Restart the assistant between major tasks when context or memory is high.
- Ignore large build directories during inspection where the host supports it.
- Use a host's safe mode to isolate optional plugins, hooks, or MCP servers.
- Treat `.heapsnapshot` files as sensitive; they may contain conversations or
  credentials. Do not share them with WorktreeProof or commit them.

These practices reduce risk and improve recovery; they do not prevent all
crashes or guarantee that a process, plugin, or provider is safe.
