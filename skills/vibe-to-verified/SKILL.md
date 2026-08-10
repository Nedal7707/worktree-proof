---
name: vibe-to-verified
description: Turn an early product idea into a bounded, testable, previewable change with rollback and closure evidence. Use when a non-expert needs help moving from a rough request to scoped lanes, checks, a safe preview, and a terminal handoff.
---

# Vibe to Verified

Translate a rough idea into a small change that can be inspected, tested, previewed, reversed, and closed. Keep the language plain, state assumptions, and avoid inventing framework or service details.

## Shape the idea

1. State the desired outcome in one sentence and name the intended audience.
2. Record constraints: repository or artifact, runtime, data sensitivity, deadline, and what must not change.
3. Turn the outcome into observable acceptance checks. Write how a user, test, or operator will know each check passed.
4. List non-goals and unknowns. Resolve only the unknowns that could change scope or safety; label the rest as unverified.

## Split safe lanes

1. Inspect the repository instructions, current branch, and existing test/preview commands before editing.
2. Create one lane per genuinely independent unit. Give each lane a unique identifier and one non-empty relative file or resource scope.
3. Reject overlapping or nested scopes. Keep shared configuration, schema, integration, deployment, and release work serial unless the project proves it is safe to split.
4. Give every build lane a named integration target and a terminal outcome: merged and wired with evidence, or explicitly abandoned and cleaned up.
5. Keep the coordinator responsible for scope and conflict decisions; return implementation work and evidence to that coordinator.

## Match the existing stack

1. Detect the project language, package manager, framework, and supported runtime from authoritative files.
2. Reuse the project's conventions and the least powerful available tool. Do not rewrite a project to fit a recipe.
3. Tag tool needs by capability (`inspect`, `edit`, `test`, `preview`, `browser`, `deploy`, `external-write`, or `destructive`) and fall back when a capability is unavailable.

## Build checks before polish

1. Derive a focused check from every acceptance criterion.
2. Start with deterministic unit or contract checks, then add integration or UI checks only where behavior crosses a boundary.
3. Exercise failure paths, input limits, and redaction rules. Keep credentials and private data out of arguments, fixtures, screenshots, and logs.
4. Run the narrowest useful checks after each bounded change, then the project's broader check before closure. Report passes, failures, and skipped checks separately.

## Preview and rollback

1. Preview locally or in a disposable/staging environment using the project's documented command. Verify the actual route, command, or artifact, not only a build result.
2. Capture minimal, redacted evidence: URL or artifact name, command, timestamp if useful, and observed result. Treat repository state as source evidence, not production proof.
3. Write the rollback before a consequential change. Prefer a reversible patch, feature flag, backup, or restore point; name the trigger and exact safe action.
4. For data or deployment changes, verify the rollback path in a non-production target when practical. Never guess at a destructive restore command.
5. Ask for confirmation immediately before a consequential external action when the tool or project policy requires it; do not treat a preview as authorization.

## Close the lane

1. Inspect the final diff for scope drift, accidental files, and secret values.
2. Attach acceptance checks, test commands and outcomes, preview evidence, rollback instructions, and known limits to the closure record.
3. State whether the change is proposed, committed, merged, deployed, or verified live. A branch, commit, or passing local command alone is not closure.
4. Mark unresolved checks as unverified and give one next bounded action. Do not inflate confidence with benchmark, adoption, or platform-capability claims.

## Handoff shape

Return:

- outcome and scope;
- lanes and integration target;
- checks run with pass/fail/skipped status;
- preview and rollback evidence;
- changed files and remaining risk;
- terminal state and the next action.
