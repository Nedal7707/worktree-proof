# Maintenance use cases

The project is intentionally small enough for ordinary maintainers to inspect end to end.

## Routine work

- **Issue triage:** plan a bounded investigation, reserve documentation or test scope, and close with a receipt that links the reproduced behavior.
- **Dependency review:** run the CI checks, review changes on pull requests, and record why a dependency is needed before adding it.
- **Release preparation:** validate schemas and skills, run the demo, update the changelog, and close a release lane with exact command output redacted.
- **Documentation upkeep:** reserve one docs scope, check links and examples, and close only after a rendered/readable review.
- **Security response:** use the non-public reporting process, reproduce in an isolated checkout, and keep sensitive details out of public receipts.

## Progressive disclosure

Start with the README and relevant command help. Read [ARCHITECTURE.md](ARCHITECTURE.md) for state boundaries, [THREAT-MODEL.md](THREAT-MODEL.md) for safety decisions, and [PRIVACY.md](PRIVACY.md) when output or retention is involved. Do not load unrelated project material just to increase context.

## Maintenance rule

Keep one objective per lane, make checks reproducible, and distinguish a pending branch or plan from a terminal closure receipt. If evidence is missing, report the lane as open rather than inferring success.
