import { tool } from "@opencode-ai/plugin";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-session goal state. The goal file is scoped by the session ID and lives
// in the OS temp directory — it is NEVER a project file, is never committed,
// and never leaks across sessions. When a host does not provide a session ID
// (fallback), a process-unique id is used so the state still dies with the
// agent process.
function sessionId(context) {
  return context.sessionID || `proc-${process.pid}`;
}

async function statePath(context) {
  const folder = join(tmpdir(), "wtp-goal-plan");
  await mkdir(folder, { recursive: true });
  return join(folder, `${sessionId(context)}.json`);
}

async function load(context) {
  try { return JSON.parse(await readFile(await statePath(context), "utf8")); }
  catch { return { version: 1, goal: null, plan: null, tasks: [] }; }
}

async function save(context, state) { await writeFile(await statePath(context), JSON.stringify(state, null, 2)); return state; }
function result(title, value) { return { title, output: typeof value === "string" ? value : JSON.stringify(value, null, 2) }; }
function now() { return new Date().toISOString(); }

const goalPlanTools = {
  goal_set: tool({
    description: "Set one concrete WorktreeProof goal. Keep outcome, terminal gates, denominator, scope, baseline, and deadline fixed after setting.",
    args: { objective: tool.schema.string().min(1), criteria: tool.schema.array(tool.schema.string()).optional(), deadline: tool.schema.string().optional(), scope: tool.schema.string().optional(), baseline: tool.schema.string().optional() },
    async execute(args, context) {
      const state = await load(context);
      state.goal = { objective: args.objective, criteria: args.criteria || [], deadline: args.deadline || "none", scope: args.scope || "unspecified", baseline: args.baseline || "unspecified", createdAt: now() };
      state.plan = null;
      state.tasks = [];
      await save(context, state);
      return result("Goal set", state.goal);
    },
  }),
  goal_show: tool({ description: "Show the current WorktreeProof goal, fixed ledger, and plan status.", args: {}, async execute(_, context) { return result("Goal", await load(context)); } }),
  goal_clear: tool({ description: "Clear the current local goal and plan state.", args: {}, async execute(_, context) { await save(context, { version: 1, goal: null, plan: null, tasks: [] }); return result("Goal cleared", { cleared: true }); } }),
  plan_create: tool({
    description: "Create a fixed task plan from the current goal. Each task must have a terminal acceptance gate.",
    args: { tasks: tool.schema.array(tool.schema.object({ id: tool.schema.string(), title: tool.schema.string(), scope: tool.schema.string().optional(), acceptance: tool.schema.string().optional() })).optional() },
    async execute(args, context) {
      const state = await load(context);
      if (!state.goal) throw new Error("Set a goal before creating a plan");
      const supplied = args.tasks || [];
      const source = supplied.length ? supplied : state.goal.criteria.map((criterion, index) => ({ id: `task-${index + 1}`, title: criterion, acceptance: criterion }));
      state.plan = { createdAt: now(), goalObjective: state.goal.objective, terminalTotal: source.length };
      state.tasks = source.map((task) => ({ ...task, status: "pending", evidence: null, startedAt: null, completedAt: null }));
      await save(context, state);
      return result("Plan created", { plan: state.plan, tasks: state.tasks });
    },
  }),
  plan_show: tool({ description: "Show the fixed plan and terminal-only task ledger.", args: {}, async execute(_, context) { const state = await load(context); return result("Plan", { plan: state.plan, tasks: state.tasks, closed: state.tasks.filter((task) => task.status === "done").length, total: state.tasks.length }); } }),
  plan_update: tool({
    description: "Update a task status. A task is terminally closed only when status is done and evidence is supplied.",
    args: { taskId: tool.schema.string(), status: tool.schema.enum(["pending", "in_progress", "done", "blocked"]), evidence: tool.schema.string().optional() },
    async execute(args, context) {
      const state = await load(context);
      const task = state.tasks.find((item) => item.id === args.taskId);
      if (!task) throw new Error(`Unknown task: ${args.taskId}`);
      if (args.status === "done" && !args.evidence) throw new Error("done requires terminal evidence");
      task.status = args.status;
      if (args.evidence) task.evidence = args.evidence;
      if (args.status === "in_progress" && !task.startedAt) task.startedAt = now();
      if (args.status === "done") task.completedAt = now();
      await save(context, state);
      return result("Task updated", task);
    },
  }),
  task_next: tool({ description: "Return the next pending task in the fixed plan.", args: {}, async execute(_, context) { const state = await load(context); return result("Next task", state.tasks.find((task) => task.status === "pending") || { task: null, message: "No pending task" }); } }),
  task_start: tool({ description: "Mark a fixed-plan task in progress.", args: { taskId: tool.schema.string() }, async execute(args, context) { return goalPlanTools.plan_update.execute({ taskId: args.taskId, status: "in_progress" }, context); } }),
  task_done: tool({ description: "Close a fixed-plan task with explicit terminal evidence.", args: { taskId: tool.schema.string(), evidence: tool.schema.string().min(1) }, async execute(args, context) { return goalPlanTools.plan_update.execute({ taskId: args.taskId, status: "done", evidence: args.evidence }, context); } }),
  review_gate: tool({
    description: "Evaluate whether every named plan task has terminal evidence.",
    args: {},
    async execute(_, context) {
      const state = await load(context);
      const results = state.tasks.map((task) => ({ id: task.id, status: task.status, evidence: task.evidence, passed: task.status === "done" && Boolean(task.evidence) }));
      return result("Review gate", { goal: state.goal?.objective || null, terminalClosed: results.filter((item) => item.passed).length, terminalTotal: results.length, results, ready: results.length > 0 && results.every((item) => item.passed) });
    },
  }),
  review_summary: tool({ description: "Summarize the current goal and terminal-only progress without inventing an ETA.", args: {}, async execute(_, context) { const state = await load(context); const closed = state.tasks.filter((task) => task.status === "done" && task.evidence).length; return result("Review summary", { objective: state.goal?.objective || null, terminalClosed: closed, terminalTotal: state.tasks.length, forecast: "FORECAST_UNAVAILABLE", tasks: state.tasks }); } }),
};

export const GoalPlanPlugin = async () => ({
  tool: goalPlanTools,
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push("WorktreeProof integration policy: use chrome_* tools for Chrome/browser work via the Chrome Bridge extension relay ONLY (chrome_connect endpoint http://127.0.0.1:9333; extension ID epppjbfmmabiphlgeokdichnhhklabep in the user's normal no-port Chrome; the 9222 debug-port Chrome portal is retired for browser automation and port 9222 is Token-Free Gateway only — never automate, never kill) and computer_* tools for visible desktop work. Do not enter passwords, OTPs, passkeys, CAPTCHAs, or other credentials. For substantive work, set one goal with goal_set, create a fixed plan with plan_create, and close tasks only with explicit evidence using task_done; report terminalClosed/terminalTotal and never invent an ETA. TOKEN EFFICIENCY: minimize input/output tokens — reuse cached context with byte-identical prefixes, read only needed sections, output short structured terminal evidence only, never restate instructions or echo full outputs.");
  },
});
