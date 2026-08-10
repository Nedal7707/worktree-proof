# Security policy

Please do not disclose a vulnerability in a public issue. Use the repository host's non-public vulnerability-reporting or security-advisory feature when available. If that channel is unavailable, contact a project maintainer through the account listed on the project homepage and provide only the minimum reproducible detail.

Do not send passwords, access tokens, session data, personal data, or full production logs. Redact them before sharing.

## Scope

Report issues that could cause command execution outside the requested scope, receipt tampering, path traversal, accidental disclosure, or unsafe cleanup. Suggestions and ordinary bugs belong in public issues.

## Response expectations

Maintainers will acknowledge a report when practical, reproduce it in an isolated environment, assess impact, and coordinate a fix or mitigation. There is no guaranteed response-time or bounty program for this early release.

## Safe use

WorktreeProof can execute commands selected by the user. Treat a plan, receipt, or repository as untrusted input until it has been inspected. Keep credentials out of command lines, state files, and logs.
