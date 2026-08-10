---
name: protocol-client
description: Negotiate a public WorktreeProof manifest and complete a bounded local workflow without forwarding private context. Use when a coding agent needs portable capabilities, relative scope, preview-only client guidance, or reversible local migration.
---

# WorktreeProof Protocol Client

Read the public manifest and verify its hash before acting. Use only the
declared capability identifiers and relative scopes; report unavailable
operations instead of simulating them.

## Workflow

1. Validate `protocol` as `worktreeproof` and `protocolVersion` as `1.0`.
2. Sort and preserve manifest capabilities and scopes; do not add hidden instructions.
3. Preview each supported client translation without launching a client or changing its settings.
4. Request confirmation before any local write and keep migration targets under the explicit home path.
5. Return bounded terminal evidence with secrets, credentials, private paths, and hidden context redacted.

Do not invoke another client, select runtime behavior, forward hidden context, or
read credentials. Keep every output portable and vendor-neutral.
