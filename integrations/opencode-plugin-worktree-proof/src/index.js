import { tool } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

// WorktreeProof CLI as OpenCode agent tools.
// Resolves the CLI in order: WORKTREE_PROOF_CLI env → local checkout bin → PATH.

const DEFAULT_TIMEOUT_MS = 60_000;

function result(title, value) {
  return { title, output: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

let cachedCli = null;

async function resolveCli(context) {
  if (cachedCli) return cachedCli;
  const candidates = [];
  if (process.env.WORKTREE_PROOF_CLI) candidates.push(process.env.WORKTREE_PROOF_CLI);
  candidates.push(join(context.worktree || context.directory, "bin", "worktree-proof.js"));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      cachedCli = { command: process.execPath, args: [candidate] };
      return cachedCli;
    } catch {
      /* try next */
    }
  }
  cachedCli = { command: "worktree-proof", args: [] };
  return cachedCli;
}

function runCli(cli, cliArgs, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cli.command, [...cli.args, ...cliArgs], {
      cwd: undefined,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`WorktreeProof CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr, code });
      else reject(new Error(stderr.trim() || `WorktreeProof CLI exited ${code}`));
    });
  });
}

async function cli(context, args, { timeoutMs } = {}) {
  const cliConfig = await resolveCli(context);
  const run = await runCli(cliConfig, args, { timeoutMs });
  try {
    return JSON.parse(run.stdout);
  } catch {
    return { stdout: run.stdout.slice(0, 4000), stderr: run.stderr.slice(0, 2000) };
  }
}

const wpTools = {
  wp_doctor: tool({
    description: "Run WorktreeProof doctor: local diagnostics for the current repository.",
    args: {},
    async execute(_, context) { return result("wp doctor", await cli(context, ["doctor", "--json"])); },
  }),
  wp_capabilities: tool({
    description: "Return the deterministic WorktreeProof protocol capabilities envelope.",
    args: { protocolVersion: tool.schema.string().optional() },
    async execute(args, context) {
      const versionArgs = args.protocolVersion ? ["--protocol-version", args.protocolVersion] : [];
      return result("wp capabilities", await cli(context, ["capabilities", "--json", ...versionArgs]));
    },
  }),
  wp_status: tool({
    description: "Return redacted local status: lanes, leases, run records, closure state.",
    args: {},
    async execute(_, context) { return result("wp status", await cli(context, ["status", "--json"])); },
  }),
  wp_plan: tool({
    description: "Create or preview one lane plan with a named scope. Previews by default; pass dryRun:false to record the plan.",
    args: {
      laneId: tool.schema.string().describe("Normalized lane identifier"),
      fileScope: tool.schema.string().describe("Relative POSIX file scope, e.g. src/ or docs/"),
      dryRun: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      const dryRun = args.dryRun !== false;
      return result("wp plan", await cli(context, ["plan", args.laneId, "--scope", args.fileScope, "--json", ...(dryRun ? ["--dry-run"] : [])]));
    },
  }),
  wp_reserve: tool({
    description: "Reserve a lane with a bounded lease and conflict-aware scope. Previews by default; pass dryRun:false to reserve.",
    args: {
      laneId: tool.schema.string(),
      fileScope: tool.schema.string(),
      ttlMs: tool.schema.number().int().min(1).max(7_776_000_000).optional(),
      dryRun: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      const dryRun = args.dryRun !== false;
      const ttlArgs = args.ttlMs ? ["--ttl-ms", String(args.ttlMs)] : [];
      return result("wp reserve", await cli(context, ["reserve", args.laneId, "--scope", args.fileScope, "--json", ...(dryRun ? ["--dry-run"] : []), ...ttlArgs]));
    },
  }),
  wp_run: tool({
    description: "Run an argv command inside a reserved lane without a shell and with bounded output. Requires laneId and the exact argv after the -- separator.",
    args: {
      laneId: tool.schema.string(),
      program: tool.schema.string().describe("Program to execute, e.g. node"),
      argv: tool.schema.array(tool.schema.string()).describe("Exact arguments, e.g. [--test, test/]"),
      timeoutMs: tool.schema.number().int().min(1000).max(300000).optional(),
    },
    async execute(args, context) {
      return result("wp run", await cli(context, ["run", args.laneId, "--json", "--", args.program, ...(args.argv || [])], { timeoutMs: args.timeoutMs }));
    },
  }),
  wp_close: tool({
    description: "Close a lane with an explicit JSON closure receipt; never invents terminal evidence. Pass the receipt object exactly.",
    args: {
      laneId: tool.schema.string(),
      receipt: tool.schema.record(tool.schema.string(), tool.schema.any()).describe("Closure receipt object with terminal evidence"),
    },
    async execute(args, context) {
      const receiptPath = join(context.worktree || context.directory, ".worktree-proof", `receipt-${Date.now()}.json`);
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(join(context.worktree || context.directory, ".worktree-proof"), { recursive: true });
      await writeFile(receiptPath, JSON.stringify(args.receipt));
      const outcome = await cli(context, ["close", args.laneId, "--receipt", receiptPath, "--json"]);
      return result("wp close", { ...outcome, receiptPath: undefined });
    },
  }),
  wp_release: tool({
    description: "Release a lane lease after closure. Previews by default; pass dryRun:false to release.",
    args: { laneId: tool.schema.string(), dryRun: tool.schema.boolean().optional() },
    async execute(args, context) {
      const dryRun = args.dryRun !== false;
      return result("wp release", await cli(context, ["release", args.laneId, "--json", ...(dryRun ? ["--dry-run"] : [])]));
    },
  }),
  wp_validate: tool({
    description: "Validate the current WorktreeProof state without mutating it.",
    args: {},
    async execute(_, context) { return result("wp validate", await cli(context, ["validate", "--json"])); },
  }),
  wp_cleanup: tool({
    description: "Return the non-mutating cleanup inventory for stale or superseded lanes.",
    args: {},
    async execute(_, context) { return result("wp cleanup", await cli(context, ["cleanup", "--json"])); },
  }),
  wp_leases: tool({
    description: "Inspect current lane leases.",
    args: { laneId: tool.schema.string().optional() },
    async execute(args, context) {
      const laneArgs = args.laneId ? [args.laneId] : [];
      return result("wp leases", await cli(context, ["leases", "inspect", ...laneArgs, "--json"]));
    },
  }),
  wp_tools: tool({
    description: "List, scan, or recommend declarative tool capabilities.",
    args: { action: tool.schema.enum(["list", "scan", "recommend"]).optional(), goals: tool.schema.array(tool.schema.string()).optional() },
    async execute(args, context) {
      const action = args.action || "list";
      const goalArgs = (args.goals || []).flatMap((goal) => ["--goal", goal]);
      return result("wp tools", await cli(context, ["tools", action, "--json", ...goalArgs]));
    },
  }),
  wp_recipes: tool({
    description: "List bounded recipes or show one recipe.",
    args: { name: tool.schema.string().optional() },
    async execute(args, context) {
      const showArgs = args.name ? ["show", args.name] : ["list"];
      return result("wp recipes", await cli(context, ["recipes", ...showArgs, "--json"]));
    },
  }),
  wp_resources: tool({
    description: "Run the read-only resource scan or inventory plan.",
    args: { action: tool.schema.enum(["scan", "plan"]).optional() },
    async execute(args, context) {
      const action = args.action || "scan";
      return result("wp resources", await cli(context, ["resources", action, "--json"]));
    },
  }),
  wp_bridge_inbox: tool({
    description: "Read the local Codex↔Claude bridge inbox (read-only).",
    args: { agent: tool.schema.string().optional() },
    async execute(args, context) {
      const agentArgs = args.agent ? ["--agent", args.agent] : [];
      return result("wp bridge inbox", await cli(context, ["bridge", "inbox", "--json", ...agentArgs]));
    },
  }),
  wp_manifest: tool({
    description: "Render the portable preview manifest for a client (public, preview-only).",
    args: { target: tool.schema.enum(["generic", "codex", "claude"]).optional() },
    async execute(args, context) { return result("wp manifest", await cli(context, ["manifest", "preview", args.target || "generic"])); },
  }),
};

export const WorktreeProofPlugin = async ({ client }) => {
  await client.app.log({ body: { service: "worktreeproof-core", level: "info", message: "WorktreeProof CLI tools loaded" } }).catch(() => {});
  return {
    tool: wpTools,
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        "WorktreeProof lane discipline: for substantive work use wp_plan → wp_reserve → wp_run → wp_close. Reserve before running; close only with explicit terminal evidence; never claim a lane is closed without a receipt; never report progress as a percentage of invented work — report terminal evidence only.",
      );
    },
  };
};
