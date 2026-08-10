# Vibe coder's guide: from idea to verified change

You do not need to know the framework, package manager, or perfect technical vocabulary to start. Describe the outcome you want, then make the work small enough to inspect and undo. “Verified” means that the requested behavior has named checks and evidence; it does not mean that every environment or future use case is proven.

## A friendly path

1. **Say what should be different.** Name the user, the desired result, and a short example of success. Add constraints such as privacy, runtime, deadline, and non-goals.
2. **Look before changing.** Read the repository instructions and identify the existing entry point, test command, preview command, and supported stack. Keep unfamiliar pieces as assumptions until checked.
3. **Make small lanes.** Give each independent unit a unique lane ID and a non-overlapping relative file or resource scope. Keep shared configuration, schemas, deployment, and integration serial unless their independence is proven.
4. **Write acceptance checks.** Convert each success example into a check that can pass or fail. Include at least one unhappy path and an input or privacy limit.
5. **Build the smallest useful slice.** Follow the existing stack. Use capability tags to choose tools (`inspect`, `edit`, `test`, `preview`, `browser`, `deploy`, `external-write`, or `destructive`) instead of choosing by brand name.
6. **Preview safely.** Run the documented local or staging preview and inspect the actual route, command, or artifact. Redact URLs, logs, screenshots, and receipts. A local build is not proof of a production deployment.
7. **Prepare rollback.** Before a write, name a reversible patch, feature flag, backup, or restore point; define what failure triggers it and who may approve a consequential external action.
8. **Close with evidence.** Record changed files, lane scope, checks and outcomes, preview evidence, rollback steps, and known limits. Say clearly whether the work is proposed, committed, merged, deployed, or verified live.

## Keep the vocabulary honest

- **Available** means the current session exposes a tool; it does not mean that the tool is authenticated or authorized.
- **Tested** means a named check ran and returned an outcome. List skipped checks.
- **Previewed** means a disposable or staging observation was made.
- **Live proof** means evidence came from the target service or runtime, not only from repository files.
- **Closed** means the lane reached its terminal integration outcome or was explicitly abandoned and cleaned up. A branch, commit, plan, or passing local command alone is not closure.

Do not promise a private model mode, native Ultra behavior, benchmark result, broad adoption, or universal vendor support. State what was observed in this project and session.

## A small handoff template

```text
Outcome: <one-sentence result>
Scope: <lane ID and relative files/resources>
Checks: <command — pass/fail/skipped>
Preview: <target and redacted observation>
Rollback: <trigger and reversible action>
Limits: <what remains unverified>
Terminal state: <merged/deployed/live-proof or abandoned/cleaned>
Next action: <one bounded step>
```

For a more detailed, stack-neutral sequence, see [RECIPES.md](RECIPES.md). For choosing tools safely, see [TOOL-ECOSYSTEM.md](TOOL-ECOSYSTEM.md).
