# Cross-agent compatibility

WorktreeProof gives different coding assistants one vendor-neutral local
protocol. Codex/Agent Skills and Claude Code adapters generate instructions for
the same project state; neither adapter invokes the other, starts a relay,
requires authentication, or assumes hidden reasoning.

## Shared protocol

Both surfaces use the same `.worktree-proof/` directory and the same schemas:

- `laneId` is a normalized, stable identifier.
- `fileScope` is a relative POSIX scope; overlapping active scopes are rejected.
- `leases.json` records the owner/session, lease ID, TTL, and active/released
  status. A stale or malformed registry fails closed.
- Resource budgets come from the read-only `resources scan`/`resources plan`
  diagnostics. The default request is 8, deliberate requests may be up to 24,
  and the host/runtime plus RAM/disk/CPU gates may lower the effective value to
  zero.
- A terminal closure is a JSON receipt validated by
  `schemas/closure-receipt.schema.json`; it contains checks, evidence, and a
  merged or explicitly abandoned outcome.

Codex output is a concise Agent Skill/`AGENTS.md` surface. Claude output is a
concise `CLAUDE.md`/skill surface. They point at the same paths and field names
without invoking one another. The explicit file-backed bridge supports one-shot
messages, but there is no promise of real-time native messaging, synchronized
context, or universal vendor support.

## Safe handoff

Each assistant should report its lane ID, relative scope, commands, redacted
evidence, resource recommendation, and closure state. Keep credentials,
cookies, tokens, private paths, and heap snapshots out of prompts, fixtures,
logs, and receipts. A password, OTP/2FA, CAPTCHA, passkey, or device approval
always remains a human action.

## Compatibility checklist

1. Skill frontmatter contains only `name` and `description`.
2. Skill names use lowercase letters, digits, and hyphens and match folders.
3. Codex and Claude examples reference the same `.worktree-proof` state and
   JSON schema files.
4. Probes are read-only and shell-disabled; no adapter installs or auth.
5. Resource cleanup is a non-mutating recommendation requiring review.
6. A fresh assistant can substitute a capability-equivalent tool and state what
   remains unverified.

The fixture in `test/adapter-protocol.test.js` asserts the shared paths and
field names for both generated surfaces without launching either assistant.

Use the explicit [bridge](BRIDGE.md) for bounded task/status/result handoffs
and [task awareness](TASK-AWARENESS.md) for redacted host snapshots. Neither
feature invokes the other assistant, transfers hidden context, or infers a
mode the host did not report.
