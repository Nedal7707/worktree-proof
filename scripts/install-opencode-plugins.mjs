import { access, constants, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
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
// OpenAI Codex curated marketplace skills are already cached locally by the
// Codex desktop app. When present, they are copied into the OpenCode-visible
// skill directory so the same official plugin skills remain available.
const CODEX_CURATED_SKILLS = join(homedir(), ".codex", "plugins", "cache", "openai-curated");
const CODEX_OWN_SKILLS = join(homedir(), ".codex", "skills");
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
  {
    name: "planning-with-files",
    repository: "https://github.com/OthmanAdi/planning-with-files.git",
    ref: "9b7d0a007946ae7694216642fd5be78c2f13b6db",
    skills: ["planning-with-files"],
  },
  {
    name: "claude-mem",
    repository: "https://github.com/thedotmack/claude-mem.git",
    ref: "d768ba364302d12b76e69e4f021f0bb1d2d50ed6",
    sourceSubdir: "plugin/skills",
    skills: [
      "babysit",
      "cloud-sync",
      "design-is",
      "do",
      "how-it-works",
      "knowledge-agent",
      "learn-codebase",
      "make-plan",
      "mem-search",
      "mode-creator",
      "oh-my-issues",
      "pathfinder",
      "smart-explore",
      "standup",
      "timeline-report",
      "version-bump",
      "weekly-digests",
      "what-the",
      "wowerpoint",
    ],
    prefix: "claude-mem-",
  },
];

// [global file prefix, repo plugin directory, required dependency set]
const plugins = [
  ["worktreeproof-chrome-use", "opencode-plugin-chrome-use"],
  ["worktreeproof-computer-use", "opencode-plugin-computer-use"],
  ["worktreeproof-goal-plan", "opencode-plugin-goal-plan"],
  ["worktreeproof-worktree-proof", "opencode-plugin-worktree-proof"],
  ["worktreeproof-workflow-enforcement", "opencode-plugin-workflow-enforcement"],
  ["worktreeproof-telegram", "opencode-plugin-telegram"],
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
for (const upstream of UPSTREAM_SKILLS) {
  const tempClone = join(tmpdir(), `wtp-${upstream.name}-${Date.now()}`);
  try {
    const clone = spawnSync("git", ["clone", "--depth", "1", upstream.repository, tempClone], { stdio: "inherit", shell: process.platform === "win32" });
    if (clone.status !== 0) throw new Error(`git clone failed for ${upstream.name}`);
    for (const skill of upstream.skills) {
      const sourceDir = upstream.sourceSubdir ? join(tempClone, upstream.sourceSubdir, skill) : join(tempClone, "skills", skill);
      const targetName = upstream.prefix ? `${upstream.prefix}${skill}` : skill;
      const targetDir = join(claudeSkillRoot, targetName);
      try {
        await mkdir(targetDir, { recursive: true });
        await copyFile(join(sourceDir, "SKILL.md"), join(targetDir, "SKILL.md"));
        // OpenCode requires the frontmatter `name:` to equal the directory
        // name; prefixed upstream skills are rewritten to their target name.
        if (upstream.prefix) {
          const lines = (await readFile(join(targetDir, "SKILL.md"), "utf8")).split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            if (/^name:\s*/.test(lines[index])) {
              lines[index] = `name: ${targetName}`;
              break;
            }
          }
          await writeFile(join(targetDir, "SKILL.md"), lines.join("\n"));
        }
        console.log(`installed upstream skill: ${targetName}`);
      } catch (error) {
        console.warn(`skill ${upstream.name}/${skill} not copied: ${error.message}`);
      }
    }
  } finally {
    await rm(tempClone, { recursive: true, force: true }).catch(() => {});
  }
}

// Copy curated Codex marketplace skills when the local cache exists.
// Layout: <curated>/<plugin>/<version-hash>/skills/<skill>/SKILL.md
async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function installCuratedCodexSkills() {
  let plugins;
  try {
    plugins = await readdir(CODEX_CURATED_SKILLS, { withFileTypes: true });
  } catch {
    return 0;
  }
  let installed = 0;
  for (const plugin of plugins.filter((entry) => entry.isDirectory())) {
    let versions;
    try {
      versions = await readdir(join(CODEX_CURATED_SKILLS, plugin.name), { withFileTypes: true });
    } catch {
      continue;
    }
    const versionDir = versions.find((entry) => entry.isDirectory());
    if (!versionDir) continue;
    const skillsDir = join(CODEX_CURATED_SKILLS, plugin.name, versionDir.name, "skills");
    let skills;
    try {
      skills = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const skill of skills.filter((entry) => entry.isDirectory())) {
      const sourceSkill = join(skillsDir, skill.name);
      let hasManifest;
      try {
        await access(join(sourceSkill, "SKILL.md"), constants.F_OK);
        hasManifest = true;
      } catch {
        hasManifest = false;
      }
      if (!hasManifest) continue;
      const target = join(claudeSkillRoot, skill.name);
      if (!(await exists(target))) {
        await mkdir(target, { recursive: true });
        await copyFile(join(sourceSkill, "SKILL.md"), join(target, "SKILL.md"));
        installed += 1;
      }
    }
  }
  return installed;
}

// Copy Codex-owned skills that do not exist in OpenCode yet (e.g.
// ui-review-loop) so nothing the old Codex had is lost.
async function installCodexOwnSkills() {
  let skills;
  try {
    skills = await readdir(CODEX_OWN_SKILLS, { withFileTypes: true });
  } catch {
    return 0;
  }
  let installed = 0;
  for (const skill of skills.filter((entry) => entry.isDirectory())) {
    const sourceSkill = join(CODEX_OWN_SKILLS, skill.name);
    let hasManifest;
    try {
      await access(join(sourceSkill, "SKILL.md"), constants.F_OK);
      hasManifest = true;
    } catch {
      hasManifest = false;
    }
    if (!hasManifest) continue;
    const target = join(claudeSkillRoot, skill.name);
    if (!(await exists(target))) {
      await mkdir(target, { recursive: true });
      await copyFile(join(sourceSkill, "SKILL.md"), join(target, "SKILL.md"));
      installed += 1;
    }
  }
  return installed;
}

const curatedInstalled = await installCuratedCodexSkills();
const codexOwnInstalled = await installCodexOwnSkills();

console.log(
  JSON.stringify(
    {
      installed: plugins.map(([globalName]) => globalName),
      pluginRoot,
      commandRoot,
      skillsInstalledTo: claudeSkillRoot,
      curatedCodexSkillsCopied: curatedInstalled,
      codexOwnSkillsCopied: codexOwnInstalled,
      restartRequired: true,
    },
    null,
    2,
  ),
);
