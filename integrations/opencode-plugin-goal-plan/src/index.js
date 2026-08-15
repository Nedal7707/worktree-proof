// Goal/Plan Plugin for OpenCode
// Provides /goal, /plan, /task, /review workflow commands

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

// State storage in project .opencode/goal-plan.json
function getStatePath(ctx) {
  const workspace = ctx?.workspace || process.cwd();
  const dir = join(workspace, '.opencode');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'goal-plan.json');
}

function loadState(ctx) {
  const path = getStatePath(ctx);
  if (!existsSync(path)) return { goal: null, plan: null, tasks: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { goal: null, plan: null, tasks: [] };
  }
}

function saveState(ctx, state) {
  writeFileSync(getStatePath(ctx), JSON.stringify(state, null, 2));
}

// --- Commands ---

async function cmdGoalSet(ctx, { objective, criteria = [], deadline }) {
  const state = loadState(ctx);
  state.goal = { objective, criteria, deadline, createdAt: new Date().toISOString() };
  state.plan = null;
  state.tasks = [];
  saveState(ctx, state);
  return { goal: state.goal, message: 'Goal set. Use /plan:create to decompose.' };
}

async function cmdGoalShow(ctx) {
  const state = loadState(ctx);
  if (!state.goal) return { goal: null, message: 'No goal set. Use /goal:set <objective>' };
  return { goal: state.goal, plan: state.plan, taskCount: state.tasks.length };
}

async function cmdGoalClear(ctx) {
  const state = loadState(ctx);
  state.goal = null;
  state.plan = null;
  state.tasks = [];
  saveState(ctx, state);
  return { cleared: true };
}

async function cmdPlanCreate(ctx, { tasks = [], auto = false }) {
  const state = loadState(ctx);
  if (!state.goal) throw new Error('No goal set. Use /goal:set first.');
  
  let planTasks = tasks;
  if (auto && tasks.length === 0) {
    // Simple auto-decomposition based on goal criteria
    planTasks = state.goal.criteria.map((c, i) => ({
      id: `task-${i + 1}`,
      title: c,
      status: 'pending',
      evidence: null,
      startedAt: null,
      completedAt: null
    }));
    if (planTasks.length === 0) {
      planTasks = [{ id: 'task-1', title: state.goal.objective, status: 'pending', evidence: null }];
    }
  }
  
  state.plan = { createdAt: new Date().toISOString(), goalRef: state.goal.objective };
  state.tasks = planTasks;
  saveState(ctx, state);
  return { plan: state.plan, tasks: state.tasks };
}

async function cmdPlanShow(ctx) {
  const state = loadState(ctx);
  if (!state.plan) return { plan: null, message: 'No plan. Use /plan:create' };
  const summary = {
    total: state.tasks.length,
    pending: state.tasks.filter(t => t.status === 'pending').length,
    in_progress: state.tasks.filter(t => t.status === 'in_progress').length,
    done: state.tasks.filter(t => t.status === 'done').length,
    blocked: state.tasks.filter(t => t.status === 'blocked').length
  };
  return { plan: state.plan, tasks: state.tasks, summary };
}

async function cmdPlanUpdate(ctx, { taskId, status, evidence }) {
  const state = loadState(ctx);
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  
  const validStatus = ['pending', 'in_progress', 'done', 'blocked'];
  if (!validStatus.includes(status)) throw new Error(`Invalid status: ${status}`);
  
  task.status = status;
  if (evidence) task.evidence = evidence;
  if (status === 'in_progress' && !task.startedAt) task.startedAt = new Date().toISOString();
  if (status === 'done') task.completedAt = new Date().toISOString();
  
  saveState(ctx, state);
  return { task };
}

async function cmdTaskNext(ctx) {
  const state = loadState(ctx);
  const next = state.tasks.find(t => t.status === 'pending');
  if (!next) return { task: null, message: 'No pending tasks' };
  return { task: next };
}

async function cmdTaskStart(ctx, { taskId }) {
  return await cmdPlanUpdate(ctx, { taskId, status: 'in_progress' });
}

async function cmdTaskDone(ctx, { taskId, evidence }) {
  return await cmdPlanUpdate(ctx, { taskId, status: 'done', evidence });
}

async function cmdReviewGate(ctx) {
  const state = loadState(ctx);
  if (!state.goal) throw new Error('No goal set');
  if (!state.plan) throw new Error('No plan created');
  
  const results = state.tasks.map(t => ({
    id: t.id,
    title: t.title,
    criteria: state.goal.criteria.find(c => t.title.includes(c)) || t.title,
    status: t.status,
    evidence: t.evidence,
    passed: t.status === 'done' && !!t.evidence
  }));
  
  const allPassed = results.every(r => r.passed);
  return { goal: state.goal.objective, results, allPassed, readyForReview: allPassed };
}

async function cmdReviewSummary(ctx) {
  const state = loadState(ctx);
  if (!state.goal) return { summary: 'No goal set' };
  
  const done = state.tasks.filter(t => t.status === 'done').length;
  const total = state.tasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  
  return {
    goal: state.goal.objective,
    deadline: state.goal.deadline,
    progress: `${done}/${total} (${pct}%)`,
    tasks: state.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, evidence: t.evidence })),
    ready: state.tasks.every(t => t.status === 'done' && t.evidence)
  };
}

// --- Tools ---
const tools = {
  goal_set: cmdGoalSet,
  goal_show: cmdGoalShow,
  goal_clear: cmdGoalClear,
  plan_create: cmdPlanCreate,
  plan_show: cmdPlanShow,
  plan_update: cmdPlanUpdate,
  task_next: cmdTaskNext,
  task_start: cmdTaskStart,
  task_done: cmdTaskDone,
  review_gate: cmdReviewGate,
  review_summary: cmdReviewSummary
};

const commands = {
  'goal:set': cmdGoalSet,
  'goal:show': cmdGoalShow,
  'goal:clear': cmdGoalClear,
  'plan:create': cmdPlanCreate,
  'plan:show': cmdPlanShow,
  'plan:update': cmdPlanUpdate,
  'task:next': cmdTaskNext,
  'task:start': cmdTaskStart,
  'task:done': cmdTaskDone,
  'review:gate': cmdReviewGate,
  'review:summary': cmdReviewSummary
};

export default { commands, tools };