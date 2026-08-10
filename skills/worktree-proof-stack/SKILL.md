---
name: worktree-proof-stack
description: Move bounded coding-agent work from an initial idea to verified terminal closure with target checks, non-overlapping scopes, safe execution, and redacted evidence. Use when planning, delegating, running, integrating, or closing work that must remain auditable.
---

# WorktreeProof Stack

Use this stack to move from a useful first idea to a verified, terminally closed
result. Follow the vibe-to-verified path: keep the objective bounded, make
ownership explicit, and treat every claim as pending until its evidence is
present.

## Orient and bound

1. Read the applicable project instructions and identify the one objective to
   advance.
2. Verify the current working directory, repository identity, branch, and
   target revision before the first write.
3. State the relative file or resource boundary, the integration target, and
   the terminal outcome required for closure.
4. Set finite time, tool, and retry budgets. Record a blocker instead of waiting
   for an unbounded reply or extending a no-progress loop.

## Prove independence

1. Split work only into genuinely independent units.
2. Give each unit a unique normalized lane identifier and one non-empty,
   relative scope.
3. Reject duplicate, parent-child, traversal, and normalized-equivalent scopes
   before any lane starts.
4. Keep shared files, mutable records, external resources, and hidden state out
   of concurrent lanes. Give each build lane a named integration action.
5. Keep one accountable coordinator for decisions. Executors return artifacts and
   evidence; they do not approve, block, or supervise one another.

## Reserve and execute safely

1. Reserve the lane and scope atomically. If reservation fails, report the
   precise conflict and re-scope rather than forcing it.
2. Review every command before running it. Pass arguments as an argument list,
   avoid implicit shells, and keep credentials out of arguments and output.
3. Use secret references and redaction. Never print, persist, or request secret
   values, and stop at a password, one-time code, captcha, passkey, or other
   human security challenge.
4. Capture command start and end, exit status, changed files, and redacted
   output. Stop on the configured budget or when the same failure returns without
   a meaningful change.
5. Detect dirty state before a destructive operation. Create and verify a rescue
   artifact, or fail closed without overwriting the work.

## Use the CLI path

Use the smallest command that records the current state and leaves a useful
receipt:

1. Run `worktree-proof doctor` and `worktree-proof plan` to inspect prerequisites and
   describe the bounded objective.
2. Run `worktree-proof reserve` with the normalized lane identifier and relative
   scope; use `worktree-proof status` to inspect active ownership.
3. Run reviewed commands through `worktree-proof run`, then inspect the captured
   result and changed files.
4. Run `worktree-proof close` with checks and redacted evidence, or use
   `worktree-proof release` for explicit abandonment.
5. Run `worktree-proof validate` and `worktree-proof cleanup --dry-run` before reusing a
   scope or reporting terminal closure.

When Codex and Claude share a repository, use `worktree-proof bridge` for
explicit task/status/result handoffs. The receiver must inspect and claim the
message; the command never starts another assistant. Use `worktree-proof tasks
inspect` only with a one-shot host snapshot. Treat mode as `unknown` unless the
host explicitly reports it, and never copy titles, summaries, prompts, paths,
or hidden context into shared state.

## Integrate and verify

1. Compare the requested change with the actual diff and keep the commit or
   change summary accurate.
2. Verify the named integration target rather than a convenient local checkout.
   Distinguish pending, landed, and verified states in every report.
3. Treat branches and worktrees as temporary surfaces. Merge and clean them, or
   explicitly abandon, delete, and record them before reusing the scope.
4. Require a terminal receipt containing the target revision, relevant checks,
   redacted evidence, and merge or deployment outcome. If the work is abandoned,
   include the cleanup proof instead.
5. Run the acceptance checks from the matching failure lesson and preserve the
   receipt where the project expects it.

## Close or recover

1. Close only after the terminal receipt validates and the target evidence is
   available.
2. If evidence is missing, leave the lane open and name the next bounded check;
   do not infer completion from a plan, branch, commit, or local test alone.
3. If a blocker appears, record what was tried, release the scope when safe, and
   return a concise resumable handoff. Never poll for an owner, helper, or
   scheduled event.
4. On recovery, preserve artifacts, correct the actual cause once, and start a
   fresh bounded action. Avoid retrying the same failed tool call unchanged.

## Minimal closure checklist

- [ ] Objective, target, lane identifier, and relative scope are recorded.
- [ ] Scope overlap and target identity checks passed before mutation.
- [ ] Commands, budgets, retries, and credential handling stayed bounded and
      redacted.
- [ ] Dirty work was preserved before any destructive action.
- [ ] Diff, integration target, and status claim agree.
- [ ] Terminal receipt contains checks, evidence, and disposition, or explicit
      abandonment and cleanup proof.

Read [`docs/FAILURE-CLASSES.md`](../../docs/FAILURE-CLASSES.md) when a failure
looks familiar, and use the matching machine-readable lesson to write or update
a regression test.
