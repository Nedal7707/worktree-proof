# Any-stack recipes

These recipes describe the shape of a safe delivery, not a required framework or vendor. Substitute the commands and tools that the repository actually exposes. Keep the capability tags (`inspect`, `edit`, `test`, `preview`, `browser`, `deploy`, `external-write`, `destructive`) with the lane so a different tool can satisfy the same step.

## Recipe anatomy

Every recipe should name:

- **Outcome:** the observable behavior or artifact.
- **Inputs:** repository, runtime, data sensitivity, and constraints.
- **Lane:** unique ID plus one non-overlapping relative file/resource scope.
- **Checks:** deterministic tests and at least one failure or limit case.
- **Preview:** local, disposable, or staging target and what was observed.
- **Rollback:** trigger, reversible action, and backup/restore point when needed.
- **Closure:** redacted evidence, terminal state, known limits, and one next action.

## Idea to prototype

1. Inspect the project entry points, supported runtime, and existing test/preview commands (`inspect`).
2. Write one outcome, acceptance checks, and non-goals.
3. Split independent work into lanes; keep shared config and integration serial.
4. Implement the smallest slice (`edit`) and add focused checks (`test`).
5. Run a disposable preview (`preview`) and inspect the actual surface.
6. Record a reversible patch or feature-flag rollback.
7. Close only after the diff, checks, preview, rollback, and limits are recorded.

## Web or UI change

1. Identify the route, state inputs, accessibility expectation, and supported browsers without assuming a specific UI framework.
2. Add a component or route check and an unhappy path (`test`).
3. Start the documented local or staging server (`preview`, optionally `browser`). Verify the route and the important interaction, not just compilation.
4. Capture a redacted screenshot or observation only if it helps reproduce the result.
5. Roll back by reverting the bounded change or disabling the flag; preserve a prior known-good artifact for a deployment.
6. State whether the observation is local, staging, or live. Do not call a screenshot adoption or benchmark proof.

## API or data change

1. Define the request/response or record contract and validation limits before editing (`inspect`).
2. Add contract and error-path checks (`test`); use fixtures with synthetic or redacted data.
3. Preview against a disposable or staging target (`preview`), keeping migrations and shared schema work serial.
4. Back up or snapshot before a destructive migration (`destructive`) and document the exact restore action.
5. Ask confirmation immediately before a consequential production mutation (`external-write`); a dry run is not authorization.
6. Record the migration/object name, release or migration identifier, evidence, and any unverified production proof.

## CLI or automation change

1. List arguments, exit codes, idempotence expectations, and filesystem scope (`inspect`).
2. Add deterministic happy-path, invalid-input, and rerun checks (`test`).
3. Offer a dry-run or preview mode (`preview`) before applying a remote or destructive action.
4. Keep secrets out of arguments and output (`secrets-sensitive`); redact captured logs.
5. Make rollback a restore, inverse command, or safe cleanup with a bounded target (`destructive` when applicable).
6. Close with the exact command, outcome, target, and terminal evidence rather than a statement that the script “should work.”

## Documentation or content change

1. Identify the authoritative page and reader goal (`inspect`).
2. Add a runnable example that uses placeholders, not real credentials (`edit`).
3. Check links, formatting, and any referenced command (`test`).
4. Preview the rendered page if the project has a preview surface (`preview`).
5. Note what was checked and what depends on an external service remaining available.

## Substitution rule

When a named tool is unavailable, substitute another tool with the same capability tag and equal or lower side-effect risk. Re-check its authentication, authorization, and evidence limits. If no equivalent exists, stop at a read-only result and report the missing capability; never pretend the recipe ran.
