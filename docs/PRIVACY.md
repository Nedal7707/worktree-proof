# Privacy

WorktreeProof is local-first. In 0.1.0 it has no built-in telemetry, hosted account, or background uploader. State and receipts are written where the user runs the CLI.

Commands can observe files and environment variables needed by the command the user selected. A run may capture output or an error message. Keep credentials, personal data, and protected logs out of command arguments, receipts, and issue reports.

## Retention

The user controls the state directory and can inspect or remove records with `status`, `validate`, and `cleanup`. Removing a record may reduce the evidence available for a later audit, so preview cleanup first.

## Sharing

Share only the minimum redacted receipt needed to explain a change. Remove usernames, hostnames, absolute paths, tokens, and command output that is not necessary for reproduction.

## Future changes

Any network feature or telemetry would require an explicit opt-in, documentation of data fields and retention, and a review of the threat model before release.
