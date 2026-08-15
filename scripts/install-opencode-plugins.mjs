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

// [global file prefix, repo plugin directory, required dependency set]
const plugins = [
  ["worktreeproof-chrome-use", "opencode-plugin-chrome-use"],
  ["worktreeproof-computer-use", "opencode-plugin-computer-use"],
  ["worktreeproof-goal-plan", "opencode-plugin-goal-plan"],
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

console.log(
  JSON.stringify(
    { installed: plugins.map(([globalName]) => globalName), pluginRoot, commandRoot, restartRequired: true },
    null,
    2,
  ),
);
