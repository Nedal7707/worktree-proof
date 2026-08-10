# Threat model

WorktreeProof protects coordination records and reduces accidental overlap. It is not a sandbox and cannot make an arbitrary command safe.

## Assets

- Lane ownership and scope records.
- Closure receipts and validation evidence.
- User-selected command arguments and captured output.
- Project files reachable by the selected command.

## Trust boundaries

The user chooses commands and may edit local files. The CLI, its state directory, repository content, and other agents should be treated as potentially stale or untrusted until validated. A receipt is evidence of what was recorded, not proof that an external system behaved correctly.

## Main threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Overlapping or duplicate lanes | Canonicalize scopes, reject overlap, and require unique lane identifiers. |
| Path traversal | Resolve paths against the project root and reject escapes before reading or writing. |
| Receipt tampering | Include schema/version metadata, validate required fields, and make mutation history inspectable. |
| Stale reservations blocking work | Expose status and cleanup preview; require explicit, auditable release or cleanup. |
| Command injection | Pass command arguments without an implicit shell; show the command before execution where practical. |
| Secret leakage | Avoid automatic environment dumps, redact known sensitive fields, and document that users must not put secrets in arguments. |
| Malicious project content | Treat configuration and hooks as data until the user explicitly chooses to run them. |
| Supply-chain drift | Keep runtime dependencies at zero in 0.1.0 and review future additions. |
| Cross-agent prompt or credential forwarding | Bridge messages accept only bounded summaries, scopes, capability tags, and redacted evidence; executable, network, secret-looking, and arbitrary fields are rejected. |
| Cross-task privacy leakage | Hash raw task IDs and discard titles, summaries, paths, prompts, and task contents. Never infer an unreported mode. |
| Desktop resource exhaustion | Default to a bounded request, honor explicit host/runtime and CPU/RAM/disk gates, subtract active reservations, and queue rather than create overflow sessions. |

## Non-goals

WorktreeProof does not provide OS-level isolation, identity proof, authorization for a team, conflict-free merging, or a guarantee that a command is correct. Use operating-system permissions and a separate sandbox when those properties are required.
