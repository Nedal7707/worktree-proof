import { tool } from "@opencode-ai/plugin";

// WorktreeProof Complete Workflow enforcement.
// Injects the workflow + tool/skill mandate into every agent session's system
// prompt, and exposes read-only tools to inspect the available surface.

const MANDATE = `
## WorktreeProof Complete Workflow (MANDATORY — every session, no exceptions)

You MUST follow the WorktreeProof complete workflow for substantive work:

1. REHYDRATE: read the current owner request, goal (goal_show), plan (plan_show),
   checklist, branch/worktree state, and origin/main before any mutation.
2. CONTRACT: if no goal exists, call goal_set with one outcome, named terminal
   gates, fixed denominator, scope, baseline SHA, deadline or none. Freeze it.
3. PLAN: call plan_create with non-overlapping tasks; each task has a named
   acceptance condition and concrete scope.
4. RESERVE: call wp_reserve (preview with --dry-run first, then reserve).
5. EXECUTE with the right tool, never the wrong one:
   - Browser/web tasks -> chrome_* tools ONLY (chrome_navigate, chrome_click,
     chrome_fill, chrome_extract, chrome_screenshot, chrome_wait, chrome_tabs).
     CHROME RULE: use ONLY the user's NORMAL Chrome profile (the one logged
     into all accounts, launched via scripts/launch-chrome-cdp.mjs on port
     9222). NEVER use a dedicated automation profile, a fresh profile, a
     guest/incognito window, or any logged-out Chrome instance. If the normal
     Chrome is not running on 9222, run the launcher first — do not fall back
     to another browser profile.
   - Visible desktop tasks -> computer_* tools ONLY (computer_screenshot,
     computer_mouse_*, computer_keyboard_*, computer_window_*).
   - Lane/command execution -> wp_run (argv only, never a shell string).
   - Diagnostics -> wp_doctor, wp_status, wp_validate, wp_cleanup.
   - Knowledge/document work -> load the matching skill (Superpowers for
     planning/TDD/debugging; Anthropic official docx/pdf/pptx/xlsx/webapp-testing;
     Vercel official react/web-design/writing; WorktreeProof skills for guardrails).
6. EVIDENCE: every task closes with task_done + explicit terminal evidence;
   lanes close with wp_close + a receipt. No evidence = not done.
7. REVIEW: run review_gate then review_summary. Report terminalClosed/terminalTotal
   only. FORECAST_UNAVAILABLE unless the owner explicitly requested a forecast.
8. MERGE: one PR per gate; CI green; activity-log row; delete superseded refs.

Boundaries (never crossed): passwords/OTP/CAPTCHA/passkeys and billing/account
security and live trade execution are OWNER-ONLY. Credentials are names-only in
all outputs. Stop at login pages; never enter credentials.

TOKEN EFFICIENCY (MANDATORY): use as few input and output tokens as possible.
1. Never restate or paraphrase the workflow/instructions; reference them once.
2. Reuse cached context: keep the instruction prefix byte-identical, append
   volatile context (files, diffs, task state) AFTER the stable prefix, and
   prefer the same model/key for consecutive calls to maximize prompt-cache
   hits. A cached large prefix costs almost nothing; an uncached one is full
   price.
3. Read only the files, lines, and sections needed; use targeted grep/glob
   instead of whole-file reads; pass small task briefs, never whole histories.
4. Output only terminal evidence and concise summaries (short, structured,
   no restating); no filler, no repeated tables, no verbose commentary.
5. Truncate/redact tool output to what the next step needs; never echo full
   outputs back.
6. Prefer compact JSON (schemaVersion/ids/values) over prose status blocks.

SKILL ROUTING (MANDATORY — load the matching skill for the task):
- Web UI change / UI verification -> ui-review-loop FIRST (recorded evidence
  rounds), ui-proof-loop for short visual rounds; agent-browser/Playwright/
  Chrome skills for browser automation.
- Frontend/React/Next.js/Vercel -> react-best-practices, nextjs, shadcn,
  vercel-*, web-perf, frontend-ui-engineering, web-design-guidelines.
- Data visualization -> visualization-strategy-and-critique, d3/threejs/canvas
  data-visualization skills, statistical-and-uncertainty-visualization.
- Backend/cloud -> cloudflare (workers, wrangler, durable-objects, ai-gateway),
  supabase (+ postgres best practices), render-*, temporal-developer,
  vercel-functions/queues/storage, stripe-best-practices, payments.
- Mobile -> expo-* suite (api-routes, dev-client, deployment, upgrades),
  ios-* suite (debugger, performance, memgraph, simulator), android-*
  (emulator-qa, performance), build-ios-apps/build-macos-apps/build-web-apps.
- CI/CD & DevOps -> github (gh-address-comments, gh-fix-ci, workflows),
  circleci, deployments-cicd, test-triage.
- Security -> codex-security suite (deep-security-scan, security-scan,
  threat-model, attack-path-analysis, fix-finding, triage-finding,
  track-findings, security-diff-scan), security-and-hardening,
  best-practice-guard.
- AI/ML -> ai-sdk, agents-sdk, building-ai-agent-on-cloudflare, llm-trainer,
  vision-trainer, hugging-face-cli, transformers.js, gradio.
- Data & knowledge -> notion-* (knowledge-capture, research-documentation,
  spec-to-implementation, meeting-intelligence), google-drive/docs/sheets/
  slides, gmail-inbox-triage, papers, datasets.
- Docs/writing -> writing-guidelines, docs-guard, documentation-and-adrs.
- Testing -> test-driven-development, test-guard, frontend-testing-debugging,
  browser-testing-with-devtools.
- Agent skills/methodology -> superpowers-* (brainstorming, writing-plans,
  executing-plans, subagent-driven-development, systematic-debugging,
  verification-before-completion), using-superpowers, and delegate-skills
  (opencode-delegate, vibe-delegate, codex-delegate, claude-delegate) when
  delegation is the right move.
- Skill creation -> skill-creator, writing-skills.
If a matching skill exists, load it before doing the work. Never re-invent a
skill the library already covers.

Failure rules: 3 strikes on the same error -> stop retrying; 40 tool calls with
zero terminal closures -> freeze, report one blocker, end the turn; never wait
silently on a reply that may never come.

Ultra routing: parent keeps maximum reasoning; lane work dispatches at standard
speed through the free model router (opencode/aihubmix/zenmux/nvidia free
tiers, plus the local Token-Free Gateway at 127.0.0.1:3456 exposing free
Claude/GPT/DeepSeek/Gemini/GLM/Kimi models — all part of the internal helper
free pool); never Fast mode; NVIDIA one attempt per model then drop; helpers
never become authority gates.

PARALLEL DISPATCH (MANDATORY — native Codex Ultra behavior): the parent keeps
Ultra/maximum reasoning at all times and ALWAYS delegates proactively, exactly
like native Codex Ultra. Use up to 20 internal helper lanes in parallel.
1. Never run inline because no one asked and never wait for a delegation
   request — proactive delegation is the default on EVERY task.
2. Batch-dispatch at session start: select EVERY genuinely independent,
   non-overlapping open item and dispatch them all at once, before any
   completes. Never finish one lane and then look for the next — that is a
   queue, not a swarm.
3. Backfill immediately: the moment a lane returns, dispatch the next
   independent item into that slot in the same turn. Idle slots are the
   failure, busy ones are not.
4. Effective pool is 0-20 = intersection of genuinely independent non-
   overlapping lane scopes and live resource availability (host cap may be
   lower, e.g. 12; RAM/CPU/disk and Event-2004 warnings reduce it further).
5. One closed file/function/test/resource scope per lane; never share a file
   area, branch, database object, or external resource between lanes. Each
   lane returns a PR, a ready-to-apply patch, or evidence.
6. An idle slot is acceptable ONLY when no genuinely independent item exists;
   spawning solely to occupy capacity is a violation. Never create sidebar or
   user-visible tasks as overflow; never spawn a recursive tree to evade a
   slot limit.
`;

const workflowTools = {
  workflow_show: tool({
    description: "Show the WorktreeProof complete workflow mandate in effect for this session.",
    args: {},
    async execute() {
      return { title: "WorktreeProof complete workflow", output: MANDATE.trim() };
    },
  }),
  workflow_audit: tool({
    description: "Return the no-gap audit checklist for the current goal/plan state.",
    args: {},
    async execute(_, context) {
      const { readFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const sessionId = context.sessionID || `proc-${process.pid}`;
      let state = { goal: null, plan: null, tasks: [] };
      try {
        state = JSON.parse(await readFile(join(tmpdir(), "wtp-goal-plan", `${sessionId}.json`), "utf8"));
      } catch {
        /* no goal state yet */
      }
      const closed = state.tasks.filter((t) => t.status === "done" && t.evidence).length;
      const total = state.tasks.length;
      return {
        title: "WorktreeProof workflow audit",
        output: JSON.stringify(
          {
            goal: state.goal?.objective || null,
            planExists: Boolean(state.plan),
            terminalClosed: closed,
            terminalTotal: total,
            allClosedWithEvidence: total > 0 && closed === total,
            checklist: [
              "one immutable contract exists",
              "plan exists with named gates",
              "every done task has terminal evidence",
              "review_gate ready",
              "merge landed on origin/main",
              "activity-log row exists",
              "no credentials in outputs",
              "forecast unavailable unless authorized",
            ],
          },
          null,
          2,
        ),
      };
    },
  }),
};

export const WorkflowEnforcementPlugin = async ({ client }) => {
  await client.app.log({ body: { service: "worktreeproof-enforcement", level: "info", message: "Workflow enforcement loaded" } }).catch(() => {});
  return {
    tool: workflowTools,
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(MANDATE.trim());
    },
  };
};
