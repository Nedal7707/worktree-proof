# Codex and Claude bridge

WorktreeProof connects Codex and Claude through explicit files in the same
repository. It is a local handoff protocol, not a network relay and not native
cross-vendor messaging. Neither assistant is launched by the CLI.

## One-shot workflow

```sh
worktree-proof bridge send \
  --sender codex --recipient claude --type task \
  --summary "Review the public documentation" \
  --lane-id docs-review --scope docs/ \
  --capabilities inspect,test

worktree-proof bridge inbox --agent claude --json
worktree-proof bridge claim MESSAGE_ID --agent claude
worktree-proof bridge complete MESSAGE_ID --agent claude \
  --summary "Review completed" \
  --receipt-ref .worktree-proof/closures/docs-review.json
```

The reverse direction uses `--sender claude --recipient codex`. A receiver must
explicitly inspect and claim a message. There is no daemon, polling loop,
automatic agent start, background process, or hidden prompt forwarding.

## Contract

- Messages are bounded JSON files under `.worktree-proof/bridge/`.
- Task messages require a relative `fileScope`; claiming one also reserves that
  scope through the shared lease registry.
- Lifecycle is `pending` → `claimed` → `completed`, `failed`, or `cancelled`.
- Writes use a bounded lock and temporary-file rename; duplicate idempotency
  keys return the existing message.
- A completed task releases its bridge lease. Dirty worktrees and recovery are
  still governed by the normal WorktreeProof lifecycle.
- Temporary files are ignored. A malformed committed message fails closed so a
  broken or tampered handoff cannot silently disappear.

## Privacy and limits

Messages contain a short summary, scope, capability tags, and redacted evidence
only. They reject secret-looking values, URLs, command strings, absolute paths,
path traversal, unbounded durations, arbitrary fields, and executable payloads.
Do not put conversations, hidden reasoning, credentials, cookies, environment
dumps, prompts, or private account data in a message.

WorktreeProof does not prove which model wrote a message, authenticate an agent,
or guarantee delivery. Repository permissions and ordinary code review remain
authoritative.
