---
description: Disable Ultra mode for this task — run inline without the helper swarm. The /goal and /plan workflow modes stay available but no proactive delegation, no parallel lanes, no spawned helpers.
agent: build
---
ULTRA MODE IS DISABLED for this task (explicit No:ultra / /no-ultra).

Run this task INLINE with maximum reasoning, WITHOUT proactive delegation:

1. PARENT ONLY: You perform the work directly in this session. Do NOT spawn
   internal helpers, do NOT batch-dispatch lanes, do NOT backfill slots, and
   do NOT create parallel worker tasks for this task. Plain Max-style inline
   execution.
2. WORKFLOW MODES: /goal and /plan remain available if the owner invokes them,
   but no lane swarm is created. If you do use goal_set/plan_create, close
   tasks with explicit evidence (task_done) and report
   terminalClosed/terminalTotal with FORECAST_UNAVAILABLE. ONE SEPARATE GOAL
   PER TASK: each distinct task gets its own immutable goal + plan (never
   merge goals across tasks); posting objectives close only when the public
   URL is captured.
3. PERSISTENCE: Keep working until the task reaches its terminal end — do not
   stop at the first post, first merge, or first milestone. Posting,
   publishing, and follow-ups are part of the same task until the fixed goal
   closes with terminal evidence.
3. RESOURCES: You may use the installed tools directly — chrome_* for the
   user's normal logged-in Chrome via the Chrome Bridge extension relay
   (endpoint http://127.0.0.1:9333; 9222 is Token-Free Gateway only, never an
   automation target), computer_* for desktop work,
   wp_* for lane diagnostics, and the 286 installed skills routed by task.
4. TOKEN EFFICIENCY: minimize input/output tokens; cache-first with
   byte-identical prefixes; read only needed sections; short structured
   terminal evidence only; never restate instructions or echo full outputs.
5. BOUNDARIES: passwords/OTP/CAPTCHA/passkeys and billing/account security
   and live trade execution are OWNER-ONLY. Credentials are names-only.
   Stop at login pages; never enter credentials.
6. This opt-out applies ONLY to this task. The next task defaults back to
   Ultra unless the owner says otherwise.

Task: $ARGUMENTS
