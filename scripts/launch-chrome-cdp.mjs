// Launch the user's NORMAL Chrome profile with a CDP port so agents can drive
// the browser that is already logged into all accounts. This is the only
// profile chrome_* tools are allowed to use.
//
// Usage:
//   node scripts/launch-chrome-cdp.mjs            # launch (or report state) on 9222
//   node scripts/launch-chrome-cdp.mjs --port 9333  # launch on a custom port
//   node scripts/launch-chrome-cdp.mjs --check    # report only
//
// Rules:
//   - Uses the standard user-data-dir (%LOCALAPPDATA%\Google\Chrome\User Data).
//   - Never creates or uses a dedicated/automation profile.
//   - If the normal Chrome is already running without the debug port, the
//     script FAILS with instructions: close Chrome, then run it again.
//     (Chrome ignores the debug flag for an existing process.)

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const portArg = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? process.env.CHROME_CDP_PORT ?? "9222";
const PORT = Number(portArg);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`Invalid CDP port: ${portArg}`);
const checkOnly = process.argv.includes("--check");

const candidateProfiles = [
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data") : null,
  join(homedir(), "AppData", "Local", "Google", "Chrome", "User Data"),
  "C:\\Users\\Nedal\\AppData\\Local\\Google\\Chrome\\User Data",
].filter(Boolean);

const chromeCandidates = [
  process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : null,
  process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : null,
  join(homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
].filter(Boolean);

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function cdpVersion() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const profile = (await Promise.all(candidateProfiles.map(async (p) => ({ p, ok: await exists(p) })))).find((x) => x.ok)?.p;
const chromeExe = (await Promise.all(chromeCandidates.map(async (p) => ({ p, ok: await exists(p) })))).find((x) => x.ok)?.p;

if (!profile) throw new Error("Normal Chrome profile not found. Expected %LOCALAPPDATA%\\Google\\Chrome\\User Data.");
if (!chromeExe) throw new Error("Chrome executable not found.");

const version = await cdpVersion();
if (version) {
  console.log(JSON.stringify({ ok: true, port: PORT, browser: version.Browser, alreadyRunning: true, profile }, null, 2));
} else if (checkOnly) {
  console.log(JSON.stringify({ ok: false, port: PORT, alreadyRunning: false, profile, nextStep: "Run without --check to launch normal Chrome with the CDP port." }, null, 2));
} else {
  console.log(`Launching NORMAL Chrome (logged-in profile) with CDP port ${PORT}...`);
  console.log(`Profile: ${profile}`);
  const child = spawn(chromeExe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: false,
  });
  child.unref();
  console.log(JSON.stringify({ ok: true, launched: true, port: PORT, profile, note: `Wait a few seconds; agents then connect to chrome_connect on 127.0.0.1:${PORT}.` }, null, 2));
}
