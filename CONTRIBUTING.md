# Contributing to WorktreeProof

Thank you for helping improve WorktreeProof. Small, reviewable changes are easier to validate than broad rewrites.

## Before opening a change

1. Read the relevant architecture and threat-model notes.
2. Describe one user-visible goal and keep the diff scoped to it.
3. Do not include credentials, tokens, sensitive logs, or generated local state.
4. Add or update tests and documentation when behavior changes.

## Local checks

Use Node.js 20 or newer and run:

```sh
npm install
npm run check
```

For CLI changes, run the reproducible demo in [docs/DEMO.md](docs/DEMO.md) and include the command result in the pull request description without copying sensitive output.

## Lanes and receipts

When parallelizing work, reserve a distinct file scope, record the lane identifier, and close it with a validation receipt. Never claim completion from a branch or commit alone; a closed receipt should state what was checked and what remains.

## Pull requests

Explain the motivation, behavior change, tests, documentation impact, and any compatibility concern. Keep commits focused. Maintainers may request a smaller scope or a follow-up change when that makes review safer.

## Conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security-sensitive reports belong in the process described by [SECURITY.md](SECURITY.md), not in a public issue.
