#!/usr/bin/env node
/**
 * WorktreeProof V4 — one-click universal installer.
 *
 * Installs the complete WorktreeProof stack for ANY agentic app or model:
 *   - 5 OpenCode plugins (54 tools)   -> ~/.config/opencode/plugins
 *   - 4 slash commands                -> ~/.config/opencode/commands
 *   - 286 skills (own + superpowers + delegate + planning-with-files +
 *     claude-mem + OpenAI Codex curated marketplace + ui-review-loop)
 *                                     -> ~/.claude/skills, ~/.agents/skills,
 *                                        ~/.config/opencode/skills
 *   - MCP server wiring               -> opencode.jsonc (worktree-proof)
 *   - Workflow-enforcement mandate    -> injected into every session
 *
 * Usage:
 *   node install.mjs            # full install + verification report
 *   node install.mjs --check    # report only, no writes
 *   npm run setup               # same as node install.mjs
 */
import { spawnSync } from "node:child_process";
import { access, constants, copyFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.includes("--check");
const SKILL_DIRS = [
  join(homedir(), ".claude", "skills"),
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".config", "opencode", "skills"),
];
const OWN_SKILLS = [
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

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// 1) Run the primary installer (plugins, commands, own/upstream/curated skills
//    into ~/.claude/skills, global package deps, MCP config is documented).
function runPrimaryInstaller() {
  const script = join(repoRoot, "scripts", "install-opencode-plugins.mjs");
  const command = process.platform === "win32" ? process.execPath : process.execPath;
  const result = spawnSync(command, [script], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Primary installer failed (${result.status})`);
}

// 2) Mirror WorktreeProof-owned skills into every agent-visible skill dir.
async function mirrorOwnSkills() {
  let copied = 0;
  for (const skill of OWN_SKILLS) {
    const source = join(repoRoot, "skills", skill, "SKILL.md");
    if (!(await exists(source))) continue;
    for (const dir of SKILL_DIRS) {
      const targetDir = join(dir, skill);
      await mkdir(targetDir, { recursive: true });
      await copyFile(source, join(targetDir, "SKILL.md"));
      copied += 1;
    }
  }
  return copied;
}

// 3) Verification report.
async function report() {
  const counts = {};
  for (const dir of SKILL_DIRS) {
    try {
      counts[dir] = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).length;
    } catch {
      counts[dir] = 0;
    }
  }
  const pluginDir = join(homedir(), ".config", "opencode", "plugins");
  const plugins = (await exists(pluginDir)) ? (await readdir(pluginDir)).filter((n) => n.endsWith(".js")).length : 0;
  const commandDir = join(homedir(), ".config", "opencode", "commands");
  const commands = (await exists(commandDir)) ? (await readdir(commandDir)).filter((n) => n.endsWith(".md")).length : 0;
  return { plugins, commands, skills: counts };
}

const before = await report();
if (checkOnly) {
  console.log(JSON.stringify({ check: true, ...before }, null, 2));
  process.exit(0);
}

runPrimaryInstaller();
const mirrored = await mirrorOwnSkills();
const after = await report();

console.log(
  JSON.stringify(
    {
      installed: true,
      plugins: after.plugins,
      commands: after.commands,
      skills: after.skills,
      ownSkillsMirrored: mirrored,
      restartRequired: true,
      nextSteps: [
        "Restart OpenCode Desktop to load plugins, commands, MCP, and skills.",
        "Verify: /goal /plan /task /review commands appear; 54 plugin tools load.",
      ],
    },
    null,
    2,
  ),
);
