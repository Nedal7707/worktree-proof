# Failure classes

WorktreeProof treats coordination failures as observable states, not as reasons to
guess. The machine-readable catalogue lives in
[`lessons/failure-classes.json`](../lessons/failure-classes.json) and is shaped
by [`schemas/failure-class.schema.json`](../schemas/failure-class.schema.json).
Each lesson has a symptom, an invariant, a mechanical control, a recovery path,
and a testable acceptance statement.

Use a lesson when planning a lane, reviewing a receipt, or writing a regression
test. Keep the invariant stable, make the control executable, and do not mark a
lane closed until its acceptance statement is satisfied.

## Silent wait or deadlock

**Symptom:** A lane stays idle while it waits for a reply, approval, or event
that may never arrive; no new artifact or bounded next action appears.

**Invariant:** A lane must not depend on an unbounded human or system response
to make progress.

**Mechanical control:** Set an explicit wait deadline and one blocker record;
when the deadline is reached, stop and return a resumable handoff instead of
polling.

**Recovery:** Record what was checked, mark the blocker, release the scope, and
resume only when a fresh bounded action is available.

**Testable acceptance:** A harness that withholds a reply observes a blocker and
a released scope without an unbounded wait loop.

## Repeated identical tool retries

**Symptom:** The same command or request is issued again after the same failure
without changing its input, environment, or diagnosis.

**Invariant:** Each retry must be justified by a changed condition or a newly
learned fact; a retry budget is finite.

**Mechanical control:** Classify the failure, record the attempted input, and
stop when the configured retry budget is exhausted or no meaningful change is
possible.

**Recovery:** Preserve the first useful error, correct the actual input once,
then switch to a different bounded path or report the blocker.

**Testable acceptance:** A simulated repeated failure produces a finite attempt
record and no further identical call after the retry budget is reached.

## Wrong workspace or target

**Symptom:** Commands inspect or change a different checkout, branch, project
root, or revision than the task names.

**Invariant:** Every read and write must be anchored to an explicitly verified
target before mutation begins.

**Mechanical control:** Record the current directory, repository identity,
branch, and target revision at start; reject writes when any check disagrees.

**Recovery:** Stop writes, preserve any uncommitted rescue data, compare the
intended and actual targets, and continue only from the verified target.

**Testable acceptance:** A test substitutes a different directory or revision
and proves the operation fails before changing a file.

## Overlapping file lanes

**Symptom:** Two active lanes claim the same file, a parent directory and its
child, or equivalent paths written in different forms.

**Invariant:** Active lanes must hav˜ém¢Gß≤⁄Óù∆≠y–and preserved before any
destructive operation.

**Mechanical control:** Check cleanliness, create a patch or other rescue
artifact, and fail closed if preservation cannot be verified before proceeding.

**Recovery:** Restore from the rescue artifact, verify the recovered diff, and
let the scope owner reclaim the lane before further mutation.

**Testable acceptance:** A test injects dirty files and proves a destructive
operation is blocked unless a valid rescue artifact exists.

## Unbounded token or tool spend

**Symptom:** One item consumes increasing calls, tokens, or time without
producing a committed artifact or a clear next command.

**Invariant:** Each item has a finite budget and a stop condition tied to
observable progress.

**Mechanical control:** Record the start, budget, and produced artifact; stop at
the configured limit or after repeated no-progress results and emit a blocker.

**Recovery:** Summarize progress and the blocker, preserve useful artifacts,
and split a fresh bounded follow-up instead of extending the same loop.

**Testable acceptance:** A simulated no-progress sequence stops at its
configured budget and emits no extra calls after the stop condition.

## Unsafe credential or login handling

**Symptom:** A command prints, persists, or requests secret values, or attempts
to automate a security challenge outside the approved path.

**Invariant:** Secret values stay out of source, arguments, logs, receipts, and
screenshots; human challenges fail closed.

**Mechanical control:** Use secret references and redaction, rely on the
service's own sign-in controls, and refuse to enter passwords, one-time codes,
captchas, or passkeys.

**Recovery:** Stop exposure, rotate or revoke the affected credential through an
owner-controlled channel, scrub artifacts, and resume without secret values.

**Testable acceptance:** A test supplies a sentinel secret and confirms outputs
and receipts contain only redacted placeholders while a challenge path stops.

## Missing terminal evidence

**Symptom:** Work is called done from a plan, branch, commit, passing local
test, or status note alone.

**Invariant:** Closure requires a target revision, relevant checks, redacted
evidence, and a merge or deployment outcome, or explicit abandonment proof.

**Mechanical control:** Require a machine-readable receipt listing the target,
checks, evidence, and disposition; keep intermediate artifacts open.

**Recovery:** Reopen the lane, collect the missing proof, or record an explicit
abandon, delete, and clean result.

**Testable acceptance:** A validator rejects closure that lacks a terminal
target, check result, redacted evidence, or abandonment proof.

## Applying the catalogue

Use these classes as a small, public vocabulary. Add a regression test for the
mechanical control that prevents the failure, keep recovery finite, and report
the exact evidence needed for closure. Do not include secret values or private
identifiers in lessons, receipts, or reports.
