import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configRoot = process.env.OPENCODE_CONFIG
  ? dirname(resolve(process.env.OPENCODE_CONFIG))
  : join(homedir(), ".config", "opencode");
const pluginRoot = join(configRoot, "plugins");
const commandRoot = join(configRoot, "commands");
// Claude Code skills dir — OpenCode auto-loads these as external skills.
const claudeSkillRoot = join(homedir(), ".claude", "skills");
// Operator-managed upstream skill libraries installed beside the own skills.
// These are NOT vendored into the repo; they are local copies for this machine
// only, matching the upstream pins in integrations/skill-sources.json.
const UPSTREAM_SKILLS = [
  {
    name: "delegate-skills",
    repository: "https://github.com/amElnagdy/delegate-skills.git",
    ref: "f9f2528525b820e7fd24724f87d6821c0e272947",
    skills: ["opencode-delegate", "vibe-delegate", "codex-delegate", "claude-delegate"],
  },
  {
    name: "superpowers",
    repository: "https://github.com/obra/superpowers.git",
    ref: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797",
    skills: [
      "brainstorming",
      "dispatching-parallel-agents",
      "executing-plans",
      "finishing-a-development-branch",
      "receiving-code-review",
      "requesting-code-review",
      "subagent-driven-development",
      "systematic-debugging",
      "test-driven-development",
      "using-git-worktrees",
      "using-superpowers",
      "verification-before-completion",
      "writing-plans",
      "writing-skills",
    ],
  },
];

// [global file prefix, repo plugin directory, required dependency set]
const plugins = [
  ["worktreeproof-chrome-use", "opencode-plugin-chrome-use"],
  ["worktreeproof-computer-use", "opencode-plugin-computer-use"],
  ["worktreeproof-goal-plan", "opencode-plugin-goal-plan"],
  ["worktreeproof-worktree-proof", "opencode-plugin-worktree-proof"],
  ["worktreeproof-workflow-enforcement", "opencode-plugin-workflow-enforcement"],
];

const SKILLS_TO_INSTALL = [
  "complete-workflow",
  "best-practice-guard",
  "omnibus-maintainer",
  "protocol-client",
  "resource-efficient-coding",
  "safe-parallel-delegation",
  "token-efficient-context",
  "tool-orchestrator",
  "ui-proof-loop",
  "vibe-to-verified",
  "worktree-proof",
  "worktree-proof-stack",
];

const requiredDependencies = {
  "@nut-tree-fork/nut-js": "^4.2.0",
  "@opencode-ai/plugin": "1.18.16",
  "screenshot-desktop": "^1.15.0",
  ws: "^8.16.0",
};

async function ensureGlobalPackage() {
  const packagePath = join(configRoot, "package.json");
  let packageJson = {};
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    /* create below */
  }
  packageJson.type = "module";
  packageJson.dependencies = { ...requiredDependencies, ...(packageJson.dependencies || {}) };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function installDependencies(directory) {
  const command = process.platform === "win32" ? "npm install" : "npm";
  const args = process.platform === "win32" ? [] : ["install"];
  const result = spawnSync(command, args, { cwd: directory, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`npm install failed in ${directory}`);
}

await mkdir(pluginRoot, { recursive: true });
await mkdir(commandRoot, { recursive: true });
await ensureGlobalPackage();
await installDependencies(configRoot);

for (const [globalName, packageName] of plugins) {
  const source = join(repoRoot, "integrations", packageName, "src", "index.js");
  const globalPlugin = join(pluginRoot, `${globalName}.js`);
  await copyFile(source, globalPlugin);
}

for (const command of ["goal", "plan", "task", "review"]) {
  const source = join(repoRoot, "integrations", "opencode-commands", `${command}.md`);
  const destination = join(commandRoot, `${command}.md`);
  await writeFile(destination, await readFile(source));
}

// Copy WorktreeProof-owned skills into ~/.claude/skills so OpenCode (and
// Claude Code) auto-load them as external skills.
for (const skill of SKILLS_TO_INSTALL) {
  const source = join(repoRoot, "skills", skill);
  const destination = join(claudeSkillRoot, skill);
  await mkdir(destination, { recursive: true });
  const files = ["SKILL.md"];
  for (const file of files) {
    try {
      await copyFile(join(source, file), join(destination, file));
    } catch {
      /* skill variant without that file */
    }
  }
  const agentsSource = join(source, "agents");
  const agentsDestination = join(destination, "agents");
  try {
    await copyFile(join(agentsSource, "openai.yaml"), join(agentsDestination, "openai.yaml"));
  } catch {
    /* no agent binding */
  }
}

// Operator-managed upstream skills (Nagdy delegate skills + superpowers).
// Uses a shallow temp clone pinned to the recorded ref, then copies the named
// skill directories into ~/.claude/skills so OpenCode and Claude Code can load
// them. This is the documented optional-library install path.
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

for (const upstream of UPSTREAM_SKILLS) {
  const tempClone = join(tmpdir(), `wtp-${upstream.name}-${Date.now()}`);
  try {
    const clone = spawnSync("git", ["clone", "--depth", "1", upstream.repository, tempClone], { stdio: "inherit", shell: process.platform === "win32" });
    if (clone.status !== 0) throw new Error(`git clone failed for ${upstream.name}`);
    for (const skill of upstream.skills) {
      const sourceDir = join(tempClone, "skills", skill);
      const targetDir = join(claudeSkillRoot, skill);
      try {
        await mkdir(targetDir, { recursive: true });
        await copyFile(join(sourceDir, "SKILL.md"), join(targetDir, "SKILL.md"));
        console.log(`installed upstream skill: ${skill}`);
      } catch (error) {
        console.warn(`skill ${upstream.name}/${skill} not copied: ${error.message}`);
      }
    }
  } finally {
    await rm(tempClone, { recursive: true, force: true }).catch(() => {});
  }
}

console.log(
  JSON.stringify(
    {
      installed: plugins.map(([globalName]) => globalName),
      pluginRoot,
      commandRoot,
      skillsInstalledTo: claudeSkillRoot,
      restartRequired: true,
    },
    null,
    2,
  ),
);
