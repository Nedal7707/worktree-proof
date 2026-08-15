---
description: Enable Ultra mode for this task — parent keeps maximum reasoning and ALWAYS delegates proactively to up to 20 internal helper lanes in parallel (native Codex Ultra behavior). Also activates /goal and /plan workflow modes for the task.
agent: build
---
ULTRA MODE IS NOW ACTIVE for this task.

Activate the WorktreeProof Ultra swarm exactly like native Codex Ultra:

1. PARENT: Keep maximum reasoning at all times. You are the accountable
   decision-maker and dispatcher. You reason, decompose, decide, and review.
   You do NOT perform implementation by hand.
2. PROACTIVE DELEGATION: Spawn internal helpers on EVERY task without being
   asked. Never run inline because no one asked; never wait for a delegation
   request. Up to 20 parallel internal helper lanes.
3. BATCH-DISPATCH: At the start, select EVERY genuinely independent,
   non-overlapping open item and dispatch them all at once, before any
   completes. Never finish one lane and then look for the next — that is a
   queue, not a swarm.
4. BACKFILL: The moment a lane returns, dispatch the next independent item
   into that slot in the same turn. Idle slots are the failure, busy ones are
   not.
5. LANES: One closed file/function/test/resource scope per lane; never share
   file areas, branches, DB objects, or external resources between lanes.
   Each lane returns a PR, a ready-to-apply patch, or evidence.
6. FREE ROUTER: Lane work dispatches at standard speed through the free model
   router (opencode/aihubmix/zenmux/nvidia free tiers + Token-Free Gateway at
   127.0.0.1:3456 with free Claude/GPT/DeepSeek/Gemini/GLM/Kimi models — all
   part of the internal helper free pool). Never Fast mode. NVIDIA: one
   attempt per model then drop.
7. EFFECTIVE POOL: 0-20 = intersection of genuinely independent non-overlapping
   scopes and live resource availability (host cap may be lower, e.g. 12;
   RAM/CPU/disk warnings reduce it further). Idle slot is acceptable ONLY when
   no independent item exists; never spawn to occupy capacity; never sidebar/
   user-visible overflow; never recursive trees.
8. WORKFLOW MODES: Run this task through /goal and /plan — set one immutable
   goal (goal_set), create a fixed plan (plan_create), reserve lanes
   (wp_reserve), execute with evidence (task_done + wp_close receipts),
   review (review_gate/review_summary). Report terminalClosed/terminalTotal,
   FORECAST_UNAVAILABLE unless authorized.
9. PERSISTENCE: Keep working until the task reaches its terminal end — do not
   stop at the first milestone, first post, or first merge. Every step of the
   task (including posting announcements, publishing, and follow-ups) is part
   of the same task until the fixed goal is closed with terminal evidence.
   ONE SEPARATE GOAL PER TASK: each distinct task gets its own immutable
   goal_set + plan (never reuse or merge goals across tasks). When posting,
   the posting objective is its own goal/plan lane that closes only when the
   public URL is captured.
10. HELPER RULES: Helpers never become authority gates, approvers, blockers,
    supervisors, or owner-facing voices. One correction round; then you take
    over or open a fresh lane.
11. BOUNDARIES: passwords/OTP/CAPTCHA/passkeys and billing/account security
    and live trade execution are OWNER-ONLY. Credentials are names-only.
    Stop at login pages; never enter credentials.

Task: $ARGUMENTS
