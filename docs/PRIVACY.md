# Privacy and recovery

WorktreeProof is local-first. In 0.2.0 it has no built-in telemetry, hosted
account, or background uploader. State and receipts are written where the user
runs the CLI. A local-first default is a data-flow property, not a promise that
an arbitrary command or integration is safe.

## What can be observed

The CLI itself reads the repository path, its `.worktree-proof/` records, and
the explicit options needed for the selected command. `run` starts the argv
chosen by the user; that child process can read files, environment variables,
network services, or anything else permitted by the operating system. A run
record may retain bounded status/error metadata. The CLI does not make a
credential-safe sandbox around that child.

| Data | Default location | Why it exists | Sharing guidance |
| --- | --- | --- | --- |
| Plans and leases | `.worktree-proof/plans/`, `leases.json` | Scope and ownership checks | Keep local unless the records are redacted |
| Run records | `.worktree-proof/runs/` | Exit status and bounded output metadata | Remove paths, usernames, and command output before sharing |
| Closure receipts | `.worktree-proof/closures/` | Terminal checks and disposition | Share only the minimum synthetic or redacted evidence |
| Bridge/task records | `.worktree-proof/bridge/` and explicit input snapshots | Bounded handoffs and host-provided task awareness | Never include hidden context, cookies, tokens, or private paths |

The optional MCP and client-manifest adapters are local/stdin-stdout surfaces
in 0.2.0. They do not add a hosted transport. Read adapter source and
configuration before enabling any future integration.

## Secrets and personal data

Never place passwords, access tokens, cookies, session data, private keys,
personal data, protected logs, or full environment dumps in command arguments,
fixtures, receipts, prompts, or issue reports. URLs and absolute paths can also
identify private systems; redact them when sharing evidence. If a selected
child command needs a secret, use the service's normal secret mechanism and
check what the command writes before retaining a run record.

## Retention and recovery

The user controls the state directory. `status` and `validate` inspect it;
`cleanup --dry-run` and resource cleanup plans are previews. Deleting a plan,
lease, run record, or receipt can remove the only local evidence for an action,
so copy the project and `.worktree-proof/` directory before a destructive
operation. A backup or source-control snapshot is the recovery authority;
WorktreeProof does not upload, replicate, or reconstruct deleted records.

For a stale lease, inspect it first (`leases inspect <laneId>`), preserve any
dirty worktree or rescue artifact, then use the explicit recovery/release path
after reviewing the result. For a migration or adapter operation, follow that
operation's own backup and rollback contract. A receipt can prove that a local
record passed validation, but it cannot prove an external deployment, a remote
merge, or the behavior of a command after the fact.

## Future changes

Any network feature or telemetry would require an explicit opt-in, documented
data fields and retention, a redaction review, and an updated threat model
before release. Until then, treat repository contents, configuration, and
integration inputs as potentially stale or untrusted.
