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

Failure rules: 3 strikes on the same error -> stop retrying; 40 tool calls with
zero terminal closures -> freeze, report one blocker, end the turn; never wait
silently on a reply that may never come.

Ultra routing: parent keeps maximum reasoning; lane work dispatches at standard
speed through the free model router; never Fast mode; NVIDIA one attempt per
model then drop; helpers never become authority gates.
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
      const { join } = await import("node:path");
      const root = context.worktree || context.directory;
      let state = { goal: null, plan: null, tasks: [] };
      try {
        state = JSON.parse(await readFile(join(root, ".opencode", "goal-plan.json"), "utf8"));
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
