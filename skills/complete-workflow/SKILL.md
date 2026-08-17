---
name: complete-workflow
description: Use in EVERY session before substantive work. Enforces the WorktreeProof L99 complete workflow — goal/contract, plan, reserve, run, evidence, review, merge, release — with the Chrome/Computer/WorktreeProof plugins and the curated skill stack. Triggers on any task, session start, multi-step work, release, or launch.
license: Apache-2.0
metadata:
  workflow: complete-workflow-v1
  evidence: terminal-only
---

# Complete Workflow (no gaps, no mistakes)

Follow `docs/COMPLETE-WORKFLOW.md` exactly. The loop is:

```
GOAL → CONTRACT → PLAN → RESERVE → RUN → EVIDENCE → REVIEW → MERGE → RELEASE → LAUNCH
```

## Mandatory, every session

1. **Rehydrate first.** Read the current owner request, task contract
   (`goal_show`), ledger (`plan_show`), checklist, branch/worktree state, and
   `origin/main` before any mutation. Summaries alone are never authority.
2. **Contract.** If no goal exists, call `goal_set` with one outcome, named
   terminal gates, fixed denominator, scope, baseline SHA, deadline or `none`.
   Freeze before the first mutation.
3. **Plan.** Call `plan_create` with non-overlapping tasks; each task has a
   named acceptance condition and concrete scope.
4. **Reserve.** Call `wp_reserve` (preview with `--dry-run`, then reserve).
5. **Execute with the right tool:**
   - Browser/web → `chrome_*` tools via the Chrome Bridge extension relay
     ONLY (`chrome_connect` endpoint `http://127.0.0.1:9333`; extension ID
     `epppjbfmmabiphlgeokdichnhhklabep` in the user's normal no-port Chrome).
     The 9222 debug-port "Chrome portal" is retired for browser automation;
     port 9222 is Token-Free Gateway only (never automate, never kill). Never
     a dedicated automation profile, a fresh/guest window, or a logged-out
     Chrome. If the relay is not reachable on 9333, ask the owner to open
     Chrome; never fall back to another profile or port.
   - Visible desktop → `computer_*` tools.
   - Lanes/commands → `wp_run` (argv only, no shell).
   - Context/knowledge → the matching skill from the skill map
     (Superpowers for planning/TDD/debugging, Anthropic official for
     docx/pdf/pptx/xlsx and webapp-testing, Vercel official for React/UI
     guidelines, WorktreeProof skills for guardrails).
6. **Evidence.** Close every task with `task_done` + explicit evidence; close
   lanes with `wp_close` + a receipt. No evidence = not done.
7. **Review.** `review_gate` then `review_summary`. Report
   `terminalClosed/terminalTotal` only. `FORECAST_UNAVAILABLE` by default.
8. **Merge & release.** One PR per gate, CI green, activity-log row, cleanup
   superseded refs in-session.

## Boundaries (never cross)

- Passwords, OTPs, CAPTCHAs, passkeys → owner only. Stop at the login page.
- Billing / account security → owner only.
- Live trade execution / moving real money → owner only, permanently.
- Credentials → names-only in code, logs, commits, reports.

## Failure rules

- 3 strikes on the same tool error → stop retrying; fix, skip, or report.
- 40 tool calls with zero terminal closures → freeze, report one blocker, end
  the turn.
- No silent wait for a reply that may never come → one
  `TRUE BLOCKER / OWNER ACTION REQUIRED` line and stop the session.
- No daemons, no schedulers, no background sweeps.

## Ultra / model routing

- Parent keeps maximum reasoning (Ultra). Lane work dispatches at standard
  speed through the free model router (opencode/aihubmix/zenmux/nvidia free
  tiers). Never Fast mode. NVIDIA: one attempt per model, then drop.
- Helpers never become authority gates, approvers, blockers, or owner-facing
  voices.
