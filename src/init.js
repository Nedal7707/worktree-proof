import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAdapter, normalizeAdapterTarget } from './adapters.js';
import { containsSecretLikeValue } from './text-safety.js';

const MAX_METADATA_BYTES = 512 * 1024;
const PACKAGE_MANAGER_FILES = new Map([
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['poetry.lock', 'poetry'],
  ['Pipfile.lock', 'pipenv'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'],
  ['Gemfile.lock', 'bundler'],
  ['composer.lock', 'composer'],
]);

const SECRET_FILE_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|.*(?:secret|token|password|credential|private[-_.]?key).*)$/i;
const AUTH_FILE_RE = /(?:auth|login|session|cookie|oauth|private[-_.]?key|\.pem$|\.p12$|\.pfx$)/i;
const LOCKFILE_RE = /(?:^|[._-])(?:lock|lockfile)(?:[._-]|$)|(?:^|[._-])(?:lock|lockfile)$/i;
const SECRET_KEY_RE = /(?:^|[_-])(secret|token|password|passwd|api[-_]?key|private[-_]?key|auth|cookie|credential)(?:$|[_-])|(?:secret|token|password|passwd|credential|cookie|apiKey|apiToken|privateKey|accessToken|authToken)$/i;

export class InitSafetyError extends Error {
  constructor(message, code = 'ERR_INIT_SAFETY') {
    super(message);
    this.name = 'InitSafetyError';
    this.code = code;
  }
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].sort();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toRootInput(repo) {
  if (repo instanceof URL) return repo;
  if (repo === undefined || repo === null || repo === '') return process.cwd();
  if (typeof repo !== 'string') throw new InitSafetyError('repository must be a path or file URL', 'ERR_INVALID_REPO');
  return repo;
}

async function resolveRepository(repo) {
  const input = toRootInput(repo);
  let candidate;
  try {
    candidate = input instanceof URL ? fileURLToPath(input) : path.resolve(input);
    const info = await lstat(candidate);
    if (!info.isDirectory()) throw new InitSafetyError(`repository is not a directory: ${candidate}`, 'ERR_INVALID_REPO');
    // Resolve the root once.  Child symlinks are never followed by the
    // detector, while a user-provided root alias is normalized for the plan.
    const canonical = await realpath(candidate);
    const canonicalInfo = await stat(canonical);
    if (!canonicalInfo.isDirectory()) throw new InitSafetyError(`repository is not a directory: ${candidate}`, 'ERR_INVALID_REPO');
    return canonical;
  } catch (error) {
    if (error instanceof InitSafetyError) throw error;
    throw new InitSafetyError(`cannot inspect repository: ${error.message}`, 'ERR_INVALID_REPO');
  }
}

async function safeReadText(file, maxBytes = MAX_METADATA_BYTES) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function entryMap(root) {
  const result = new Map();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    result.set(entry.name, entry);
  }
  return result;
}

function addMarker(markers, name) {
  if (name && !markers.includes(name)) markers.push(name);
}

function detectFrameworks(dependencies) {
  const names = new Set(Object.keys(dependencies ?? {}).map((name) => name.toLowerCase()));
  const frameworks = [];
  const groups = [
    ['next', ['next']],
    ['react', ['react', 'react-dom']],
    ['vue', ['vue']],
    ['svelte', ['svelte', '@sveltejs/kit']],
    ['angular', ['@angular/core', '@angular/cli']],
    ['vite', ['vite']],
    ['express', ['express']],
    ['fastify', ['fastify']],
    ['typescript', ['typescript']],
  ];
  for (const [label, candidates] of groups) {
    if (candidates.some((candidate) => names.has(candidate))) frameworks.push(label);
  }
  return frameworks;
}

function detectTextFrameworks(text, frameworks) {
  const lower = text.toLowerCase();
  const patterns = [
    ['django', /(?:django|django-admin)/],
    ['flask', /\bflask\b/],
    ['fastapi', /\bfastapi\b/],
    ['pytest', /\bpytest\b/],
    ['rails', /\brails\b/],
    ['spring', /\bspring(?:-boot)?\b/],
    ['phoenix', /\bphoenix\b/],
  ];
  for (const [label, pattern] of patterns) {
    if (pattern.test(lower) && !frameworks.includes(label)) frameworks.push(label);
  }
}

function markerFor(entryMap, name) {
  const entry = entryMap.get(name);
  return entry && !entry.isSymbolicLink();
}

/**
 * Inspect only safe repository metadata.  Secret/auth files and lockfile
 * contents are never read; their presence is represented by booleans/names.
 */
export async function inspectProject(repo = process.cwd()) {
  const root = await resolveRepository(repo);
  const entries = await entryMap(root);
  const markers = [];
  const languages = [];
  const frameworks = [];
  const packageManagers = [];
  const lockfiles = [];

  for (const [name, manager] of PACKAGE_MANAGER_FILES) {
    if (markerFor(entries, name)) {
      lockfiles.push(name);
      if (!packageManagers.includes(manager)) packageManagers.push(manager);
      addMarker(markers, name);
    }
  }

  const packageEntry = entries.get('package.json');
  let packageMetadata = {};
  let packageJsonText;
  if (packageEntry && !packageEntry.isSymbolicLink()) {
    packageJsonText = await safeReadText(path.join(root, 'package.json'));
    if (packageJsonText) {
      try {
        const parsed = JSON.parse(packageJsonText);
        if (isObject(parsed)) {
          const dependencyNames = Object.keys({
            ...(isObject(parsed.dependencies) ? parsed.dependencies : {}),
            ...(isObject(parsed.devDependencies) ? parsed.devDependencies : {}),
            ...(isObject(parsed.peerDependencies) ? parsed.peerDependencies : {}),
          });
          packageMetadata = {
            name: typeof parsed.name === 'string' ? parsed.name.slice(0, 120) : undefined,
            type: typeof parsed.type === 'string' ? parsed.type : undefined,
            packageManager: typeof parsed.packageManager === 'string' ? parsed.packageManager.slice(0, 80) : undefined,
            scripts: isObject(parsed.scripts) ? sortedUnique(Object.keys(parsed.scripts)).slice(0, 100) : [],
            dependencies: sortedUnique(dependencyNames).slice(0, 200),
          };
          if (packageMetadata.packageManager) {
            const manager = packageMetadata.packageManager.split('@')[0].toLowerCase();
            if (manager && !packageManagers.includes(manager)) packageManagers.push(manager);
          }
          if (packageMetadata.dependencies.length) {
            frameworks.push(...detectFrameworks(Object.fromEntries(packageMetadata.dependencies.map((name) => [name, true]))));
          }
          addMarker(markers, 'package.json');
        }
      } catch {
        packageMetadata = {};
      }
    }
    if (packageJsonText && isObject(packageMetadata)) languages.push('javascript');
  }

  const languageMarkers = [
    ['tsconfig.json', 'typescript'],
    ['jsconfig.json', 'javascript'],
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['setup.py', 'python'],
    ['Pipfile', 'python'],
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
    ['pom.xml', 'java'],
    ['build.gradle', 'java'],
    ['Gemfile', 'ruby'],
    ['composer.json', 'php'],
    ['mix.exs', 'elixir'],
  ];
  for (const [name, language] of languageMarkers) {
    if (markerFor(entries, name)) {
      addMarker(markers, name);
      languages.push(language);
    }
  }

  for (const [name, manager] of [['pnpm-workspace.yaml', 'pnpm'], ['lerna.json', 'npm'], ['uv.lock', 'uv']]) {
    if (markerFor(entries, name)) {
      addMarker(markers, name);
      packageManagers.push(manager);
    }
  }

  // Read only non-secret, bounded manifest text to identify common frameworks.
  for (const filename of ['pyproject.toml', 'requirements.txt', 'Pipfile', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', 'mix.exs']) {
    if (!markerFor(entries, filename)) continue;
    const text = await safeReadText(path.join(root, filename));
    if (text) detectTextFrameworks(text, frameworks);
  }

  const tools = {
    agentSkills: Boolean(markerFor(entries, '.agents')) && Boolean(await safeDirectory(path.join(root, '.agents', 'skills'))),
    claudeCode: Boolean(markerFor(entries, '.claude')) && Boolean(await safeDirectory(path.join(root, '.claude', 'skills'))),
    vscode: Boolean(markerFor(entries, '.vscode')),
    vscodeTasks: Boolean(await safeFile(path.join(root, '.vscode', 'tasks.json'))),
    ci: Boolean(markerFor(entries, '.github')) && Boolean(await safeDirectory(path.join(root, '.github', 'workflows'))),
    git: Boolean(markerFor(entries, '.git')),
  };
  tools.codex = tools.agentSkills;

  const sensitiveFiles = [];
  let hasSensitiveFiles = false;
  let hasAuthFiles = false;
  for (const name of entries.keys()) {
    const lower = name.toLowerCase();
    if (SECRET_FILE_RE.test(name) || lower === '.env' || lower.startsWith('.env.')) {
      hasSensitiveFiles = true;
      sensitiveFiles.push(name);
    }
    if (AUTH_FILE_RE.test(name)) hasAuthFiles = true;
  }

  return Object.freeze({
    root,
    name: packageMetadata.name ?? path.basename(root),
    markers: Object.freeze(sortedUnique(markers)),
    stack: Object.freeze({
      languages: Object.freeze(sortedUnique(languages)),
      frameworks: Object.freeze(sortedUnique(frameworks)),
      packageManagers: Object.freeze(sortedUnique(packageManagers)),
    }),
    package: Object.freeze({
      name: packageMetadata.name,
      type: packageMetadata.type,
      packageManager: packageMetadata.packageManager,
      scripts: Object.freeze(packageMetadata.scripts ?? []),
      dependencies: Object.freeze(packageMetadata.dependencies ?? []),
    }),
    files: Object.freeze({
      lockfiles: Object.freeze(sortedUnique(lockfiles)),
      hasSensitiveFiles,
      hasAuthFiles,
      sensitive: hasSensitiveFiles,
      auth: hasAuthFiles,
    }),
    tools: Object.freeze(tools),
  });
}

async function safeDirectory(file) {
  try {
    const info = await lstat(file);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function safeFile(file) {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function toolFlags(toolInventory) {
  const normalizeToolName = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (Array.isArray(toolInventory)) {
    return new Set(toolInventory.filter((value) => typeof value === 'string').map(normalizeToolName));
  }
  if (!isObject(toolInventory)) return new Set();
  const nested = [toolInventory.available, toolInventory.tools, toolInventory.capabilities, toolInventory.availableIds]
    .filter((value) => Array.isArray(value))
    .flat();
  const nestedNames = nested.flatMap((value) => {
    if (typeof value === 'string') return [value];
    if (!isObject(value) || value.available === false || value.availability === 'unavailable') return [];
    return [value.id, value.name, ...(Array.isArray(value.capabilities) ? value.capabilities : [])].filter((item) => typeof item === 'string');
  });
  return new Set([
    ...Object.entries(toolInventory).filter(([, value]) => value === true).map(([key]) => normalizeToolName(key)),
    ...nestedNames.map(normalizeToolName),
  ]);
}

/** Return an explainable, deterministic onboarding recommendation. */
export function recommendPreset(project = {}, toolInventory = {}) {
  if (!isObject(project)) throw new InitSafetyError('project must be an object', 'ERR_INVALID_PROJECT');
  const projectTools = isObject(project.tools) ? Object.entries(project.tools).filter(([, value]) => value === true).map(([key]) => key.toLowerCase()) : [];
  const normalizeToolName = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const inventory = new Set([...projectTools, ...toolFlags(toolInventory)].map(normalizeToolName));
  const targets = ['generic-prompt'];
  const reasons = ['generic-prompt: available to any repository without assuming a host integration'];
  const choose = (target, aliases, reason) => {
    if (aliases.some((alias) => inventory.has(normalizeToolName(alias)))) {
      targets.push(target);
      reasons.push(`${target}: detected or requested ${aliases.join('/')}`);
    }
  };
  choose('agent-skills', ['agentskills', 'agent-skills', 'codex', 'agents'], 'Agent Skills/Codex support');
  choose('claude-code', ['claude', 'claude-code', 'claudecode'], 'Claude Code support');
  choose('vscode', ['vscode', 'vs-code', 'vscodetasks'], 'VS Code workspace support');
  choose('ci', ['ci', 'github-actions', 'github', 'gitlab', 'cicd'], 'CI workflow support');
  const orderedTargets = ['agent-skills', 'claude-code', 'generic-prompt', 'vscode', 'ci'].filter((target) => targets.includes(target));
  const orderedReasons = orderedTargets.map((target) => reasons[targets.indexOf(target)]);
  return Object.freeze({
    preset: 'project-onboarding',
    targets: Object.freeze(orderedTargets),
    reasons: Object.freeze(orderedReasons),
    confidence: orderedTargets.length > 1 ? 'high' : 'medium',
  });
}

function assertNoSecretInput(value, keyPath = '') {
  if (typeof value === 'string') {
    if (containsSecretLikeValue(value)) {
      throw new InitSafetyError(`secret-like value at ${keyPath || 'input'}`, 'ERR_SECRET_INPUT');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSecretInput(child, `${keyPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const safeBooleanFlag = typeof child === 'boolean' && /^(?:has)?(?:auth|sensitive)(?:files)?$/i.test(key);
    if (SECRET_KEY_RE.test(key) && !safeBooleanFlag) throw new InitSafetyError(`secret-like input key: ${key}`, 'ERR_SECRET_INPUT');
    assertNoSecretInput(child, keyPath ? `${keyPath}.${key}` : key);
  }
}

function isAbsoluteAny(value) {
  return path.isAbsolute(value) || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new InitSafetyError('write path must be non-empty', 'ERR_INVALID_WRITE');
  if (value.includes('\0')) throw new InitSafetyError('write path contains NUL', 'ERR_INVALID_WRITE');
  if (/[\u0001-\u001f\u007f]/.test(value)) throw new InitSafetyError('write path contains control characters', 'ERR_INVALID_WRITE');
  if (isAbsoluteAny(value) || /^[A-Za-z]:/.test(value)) throw new InitSafetyError(`absolute write path refused: ${value}`, 'ERR_ABSOLUTE_PATH');
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) throw new InitSafetyError(`path traversal refused: ${value}`, 'ERR_PATH_ESCAPE');
  if (parts.some((part) => part === '' || part === '.')) throw new InitSafetyError(`ambiguous write path refused: ${value}`, 'ERR_INVALID_WRITE');
  const basename = parts.at(-1).toLowerCase();
  if (/[<>:"|?*]/.test(basename)) throw new InitSafetyError(`invalid write path characters: ${value}`, 'ERR_INVALID_WRITE');
  if (basename === '.git' || parts.some((part) => part.toLowerCase() === '.git')) {
    throw new InitSafetyError(`git internals are not writable: ${value}`, 'ERR_SENSITIVE_PATH');
  }
  if (parts.some((part) => SECRET_FILE_RE.test(part) || AUTH_FILE_RE.test(part) || LOCKFILE_RE.test(part)) || basename.endsWith('.lock')) {
    throw new InitSafetyError(`sensitive/auth/lockfile path refused: ${value}`, 'ERR_SENSITIVE_PATH');
  }
  return parts.join('/');
}

function safeRootPlanPath(root) {
  if (typeof root !== 'string' || !root.trim() || !isAbsoluteAny(root)) {
    throw new InitSafetyError('plan root must be an absolute repository path', 'ERR_INVALID_REPO');
  }
  return path.resolve(root);
}

async function assertParentComponents(root, relativePath) {
  const components = relativePath.split('/');
  const parentComponents = components.slice(0, -1);
  let current = root;
  const missing = [];
  for (const component of parentComponents) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new InitSafetyError(`symlink escape refused: ${current}`, 'ERR_SYMLINK_ESCAPE');
      if (!info.isDirectory()) throw new InitSafetyError(`write parent is not a directory: ${current}`, 'ERR_COLLISION');
    } catch (error) {
      if (error instanceof InitSafetyError) throw error;
      if (error?.code === 'ENOENT') {
        missing.push(current);
      } else {
        throw new InitSafetyError(`cannot inspect write parent: ${current}`, 'ERR_WRITE_PREFLIGHT');
      }
    }
  }
  return { parent: path.join(root, ...parentComponents), missing };
}

async function validatePlan(plan) {
  if (!isObject(plan)) throw new InitSafetyError('plan must be an object', 'ERR_INVALID_PLAN');
  const root = safeRootPlanPath(plan.root);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    throw new InitSafetyError(`repository root is unavailable: ${root}`, 'ERR_INVALID_REPO');
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new InitSafetyError('repository root symlink/shape refused', 'ERR_SYMLINK_ESCAPE');
  const rawWrites = plan.writes ?? plan.files;
  if (!Array.isArray(rawWrites) || rawWrites.length === 0) throw new InitSafetyError('plan must contain writes', 'ERR_INVALID_PLAN');
  const writes = [];
  const seen = new Set();
  for (const raw of rawWrites) {
    if (!isObject(raw)) throw new InitSafetyError('each write must be an object', 'ERR_INVALID_WRITE');
    const relativePath = safeRelativePath(raw.path ?? raw.relativePath);
    if (seen.has(relativePath)) throw new InitSafetyError(`duplicate write path: ${relativePath}`, 'ERR_PLAN_COLLISION');
    seen.add(relativePath);
    if (raw.mode !== undefined && raw.mode !== 'create') {
      throw new InitSafetyError(`destructive write mode refused: ${raw.mode}`, 'ERR_DESTRUCTIVE_CHANGE');
    }
    if (raw.overwrite === true || raw.replace === true || raw.delete === true || raw.remove === true) {
      throw new InitSafetyError(`destructive write operation refused: ${relativePath}`, 'ERR_DESTRUCTIVE_CHANGE');
    }
    if (typeof raw.content !== 'string') throw new InitSafetyError(`content must be text: ${relativePath}`, 'ERR_INVALID_WRITE');
    if (containsSecretLikeValue(raw.content)) throw new InitSafetyError(`secret-like content refused: ${relativePath}`, 'ERR_SECRET_INPUT');
    const { parent, missing } = await assertParentComponents(root, relativePath);
    const absolutePath = path.join(root, ...relativePath.split('/'));
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new InitSafetyError(`symlink target refused: ${relativePath}`, 'ERR_SYMLINK_ESCAPE');
      throw new InitSafetyError(`refusing to overwrite existing path: ${relativePath}`, 'ERR_COLLISION');
    } catch (error) {
      if (error instanceof InitSafetyError) throw error;
      if (error?.code !== 'ENOENT') throw new InitSafetyError(`cannot inspect target: ${relativePath}`, 'ERR_WRITE_PREFLIGHT');
    }
    writes.push(Object.freeze({
      path: relativePath,
      absolutePath,
      parent,
      missing,
      content: raw.content,
      mode: 'create',
      adapter: typeof raw.adapter === 'string' ? raw.adapter : undefined,
    }));
  }
  return { root, writes };
}

/**
 * Build a deterministic create-only plan.  Building is read-only; the returned
 * plan advertises dryRun=true and can be passed to applyInitPlan later.
 */
export async function buildInitPlan(options = {}) {
  if (!isObject(options)) throw new InitSafetyError('init options must be an object', 'ERR_INVALID_OPTIONS');
  if (options.force === true || options.overwrite === true || options.destructive === true) {
    throw new InitSafetyError('destructive initialization options are refused', 'ERR_DESTRUCTIVE_CHANGE');
  }
  assertNoSecretInput(options.context);
  const project = options.project ?? await inspectProject(options.repo ?? options.root ?? process.cwd());
  if (!isObject(project) || typeof project.root !== 'string') throw new InitSafetyError('project must include a repository root', 'ERR_INVALID_PROJECT');
  const root = await resolveRepository(project.root);
  const toolInventory = options.toolInventory ?? project.tools ?? {};
  const recommendation = recommendPreset(project, toolInventory);
  let presetTarget;
  if (typeof options.preset === 'string' && options.preset.trim()) {
    try {
      presetTarget = normalizeAdapterTarget(options.preset);
    } catch {
      // Named presets (for example project-onboarding) are not adapter targets.
    }
  }
  const requestedTargets = options.targets
    ?? (options.target ? [options.target] : (presetTarget ? [presetTarget] : recommendation.targets));
  if (!Array.isArray(requestedTargets) || requestedTargets.length === 0) throw new InitSafetyError('at least one adapter target is required', 'ERR_INVALID_TARGETS');
  const targets = [];
  const files = [];
  const warnings = [];
  const preset = typeof options.preset === 'string' && options.preset.trim() ? options.preset.trim() : recommendation.preset;
  const context = {
    ...(isObject(options.context) ? options.context : {}),
    project: { ...project, root },
    preset,
    capabilities: isObject(options.capabilities) ? options.capabilities : {},
  };
  assertNoSecretInput(context);
  for (const requested of requestedTargets) {
    const target = normalizeAdapterTarget(requested);
    if (targets.includes(target)) continue;
    const rendered = renderAdapter(target, context);
    targets.push(target);
    warnings.push(...rendered.warnings);
    for (const file of rendered.files) files.push({ ...file, adapter: target });
  }
  // Validate generated paths/content without checking filesystem collisions yet;
  // this keeps plan construction read-only while apply remains fail-closed.
  const seen = new Set();
  const writes = files.map((file) => {
    const relativePath = safeRelativePath(file.path);
    if (seen.has(relativePath)) throw new InitSafetyError(`adapter outputs collide at ${relativePath}`, 'ERR_PLAN_COLLISION');
    seen.add(relativePath);
    if (typeof file.content !== 'string' || containsSecretLikeValue(file.content)) {
      throw new InitSafetyError(`unsafe adapter output: ${relativePath}`, 'ERR_SECRET_INPUT');
    }
    return Object.freeze({ path: relativePath, content: file.content, mode: 'create', adapter: file.adapter });
  });
  return Object.freeze({
    version: 1,
    root,
    preset,
    targets: Object.freeze(targets),
    project: Object.freeze(project),
    writes: Object.freeze(writes),
    warnings: Object.freeze(sortedUnique(warnings)),
    dryRun: true,
  });
}

async function confirmExplicitly(confirm, plan) {
  if (confirm === true) return true;
  if (typeof confirm === 'function') {
    try {
      return (await confirm(plan)) === true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Apply a create-only plan.  Dry-run is the default and explicit confirmation is mandatory. */
export async function applyInitPlan(plan, options = {}) {
  if (!isObject(options)) throw new InitSafetyError('apply options must be an object', 'ERR_INVALID_OPTIONS');
  const dryRun = options.dryRun !== undefined ? options.dryRun !== false : plan?.dryRun !== false;
  if (dryRun !== true && dryRun !== false) throw new InitSafetyError('dryRun must be boolean', 'ERR_INVALID_OPTIONS');
  if (!dryRun && !(await confirmExplicitly(options.confirm, plan))) {
    throw new InitSafetyError('explicit confirmation is required before writing', 'ERR_CONFIRM_REQUIRED');
  }
  const validated = await validatePlan(plan);
  const planned = validated.writes.map((write) => write.path);
  if (dryRun) {
    return Object.freeze({
      ok: true,
      dryRun: true,
      planned: Object.freeze(planned),
      writes: Object.freeze(planned),
      written: Object.freeze([]),
    });
  }

  const written = [];
  try {
    // All collision/symlink checks completed before the first mutation.
    for (const write of validated.writes) {
      await mkdir(write.parent, { recursive: true });
      const tempPath = path.join(write.parent, `.${path.basename(write.absolutePath)}.worktree-proof-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(tempPath, 'wx', 0o644);
        await handle.writeFile(write.content, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        // The target was proven absent in preflight.  A concurrent creator is
        // treated as a collision rather than being overwritten.
        try {
          await access(write.absolutePath);
          throw new InitSafetyError(`refusing to overwrite existing path: ${write.path}`, 'ERR_COLLISION');
        } catch (error) {
          if (error instanceof InitSafetyError) throw error;
          if (error?.code !== 'ENOENT') throw error;
        }
        await rename(tempPath, write.absolutePath);
        written.push(write.path);
      } finally {
        if (handle) await handle.close().catch(() => {});
        await rm(tempPath, { force: true }).catch(() => {});
      }
    }
  } catch (error) {
    if (error instanceof InitSafetyError) throw error;
    throw new InitSafetyError(`atomic write failed: ${error.message}`, 'ERR_WRITE_FAILED');
  }
  return Object.freeze({
    ok: true,
    dryRun: false,
    planned: Object.freeze(planned),
    writes: Object.freeze(planned),
    written: Object.freeze(written),
  });
}

export { safeRelativePath as normalizeWritePath };
