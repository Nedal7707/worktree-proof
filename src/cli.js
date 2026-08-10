/**
 * The worktree-proof command line interface.
 *
 * This module deliberately keeps argument parsing and process I/O separate from
 * the worktree-proof runtime.  The runtime modules are loaded lazily and can be
 * replaced by `options.deps`, which makes the CLI useful to embedders and keeps
 * the command contract testable without a Git checkout.
 */

import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
});

const COMMANDS = Object.freeze([
  'doctor',
  'plan',
  'reserve',
  'release',
  'run',
  'status',
  'close',
  'cleanup',
  'validate',
  'tools',
  'resources',
  'recipes',
  'init',
  'bridge',
  'tasks',
]);

const VALUE_OPTIONS = new Set([
  '--repo',
  '--config',
  '--input',
  '--receipt',
  '--schema',
  '--lane-id',
  '--file-scope',
  '--scope',
  '--branch',
  '--integration-target',
  '--lease-id',
  '--lease',
  '--owner',
  '--session',
  '--ttl',
  '--capacity',
  '--resources',
  '--backlog',
  '--lanes',
  '--timeout',
  '--max-output-bytes',
  '--canonical-ref',
  '--reason',
  '--task',
  '--mode',
  '--output',
  '--goal',
  '--target',
  '--targets',
  '--preset',
  '--profile',
  '--allowed-root',
  '--allowed-roots',
  '--max-depth',
  '--max-entries',
  '--catalog',
  '--manifest',
  '--concurrency',
  '--workload',
  '--sender',
  '--recipient',
  '--agent',
  '--message-id',
  '--type',
  '--summary',
  '--reply-to',
  '--capabilities',
  '--receipt-ref',
  '--result-status',
  '--ttl-ms',
  '--claim-ms',
  '--idempotency-key',
  '--status',
  '--actor',
  '--bridge-root',
  '--host-ceiling',
  '--other-task-reservations',
  '--namespace',
  '--current-task-id',
]);

const BOOLEAN_OPTIONS = new Set([
  '--json',
  '--help',
  '-h',
  '--version',
  '-v',
  '-V',
  '--dry-run',
  '--no-submit',
  '--force',
  '--all',
  '--apply',
  '--confirm',
  '--include-unavailable',
]);

const OPTION_ALIASES = new Map([
  ['-h', '--help'],
  ['-v', '--version'],
  ['-V', '--version'],
]);

const MODULE_FILES = Object.freeze({
  scope: 'scope.js',
  planner: 'planner.js',
  leases: 'leases.js',
  evidence: 'evidence.js',
  git: 'git.js',
  worktree: 'worktree.js',
  runner: 'runner.js',
  adapters: 'adapters.js',
  init: 'init.js',
  tools: 'tools.js',
  resources: 'resources.js',
  bridge: 'bridge.js',
  tasks: 'tasks.js',
});

/** A usage error is rendered by the caller, rather than printed here. */
export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
    this.code = EXIT_CODES.USAGE;
  }
}

/** An operational error returned by a runtime adapter. */
export class CliOperationError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CliOperationError';
    this.code = EXIT_CODES.ERROR;
  }
}

function defaultIo() {
  return {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
}

function canonicalOption(option) {
  return OPTION_ALIASES.get(option) ?? option;
}

function parseOptionToken(token) {
  const equalAt = token.indexOf('=');
  if (equalAt < 0) return { name: canonicalOption(token), inlineValue: undefined };
  return {
    name: canonicalOption(token.slice(0, equalAt)),
    inlineValue: token.slice(equalAt + 1),
  };
}

function parseBoolean(value, option) {
  if (value === undefined) return true;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new CliUsageError(`${option} expects a boolean when using =value`);
}

/**
 * Parse argv without interpreting command arguments after `--`.
 *
 * Values are kept as strings so callers can choose their own validation.  The
 * parser rejects every unknown option, including options on a known command;
 * that is intentional so a typo cannot silently change lane state.
 */
export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');

  const tokens = [...argv];
  let command;
  let commandHelp = false;
  let commandVersion = false;
  let passthrough = [];
  const options = {
    json: false,
    dryRun: false,
    noSubmit: false,
    force: false,
    all: false,
  };
  const positionals = [];
  let afterSeparator = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (afterSeparator) {
      passthrough.push(token);
      continue;
    }
    if (token === '--') {
      afterSeparator = true;
      continue;
    }
    if (token.startsWith('-')) {
      const { name, inlineValue } = parseOptionToken(token);
      if (!VALUE_OPTIONS.has(name) && !BOOLEAN_OPTIONS.has(name)) {
        throw new CliUsageError(`unknown option: ${token}`);
      }
      if (VALUE_OPTIONS.has(name)) {
        let value = inlineValue;
        if (value === undefined) {
          value = tokens[index + 1];
          if (value === undefined || value === '--' || value.startsWith('-')) {
            throw new CliUsageError(`${name} expects a value`);
          }
          index += 1;
        }
        const key = name.slice(2).replaceAll('-', '');
        // Keep command-facing camelCase keys while preserving an options map.
        const keyMap = {
          repo: 'repo',
          config: 'config',
          input: 'input',
          receipt: 'receipt',
          schema: 'schema',
          laneid: 'laneId',
          filescope: 'fileScope',
          scope: 'fileScope',
          branch: 'branch',
          integrationtarget: 'integrationTarget',
          leaseid: 'leaseId',
          lease: 'lease',
          owner: 'owner',
          session: 'session',
          ttl: 'ttl',
          capacity: 'capacity',
          resources: 'resources',
          backlog: 'backlog',
          lanes: 'lanes',
          timeout: 'timeout',
          maxoutputbytes: 'maxOutputBytes',
          canonicalref: 'canonicalRef',
          reason: 'reason',
          task: 'task',
          mode: 'mode',
          output: 'output',
          goal: 'goal',
          target: 'target',
          targets: 'targets',
          preset: 'preset',
          profile: 'profile',
          allowedroot: 'allowedRoot',
          allowedroots: 'allowedRoots',
          maxdepth: 'maxDepth',
          maxentries: 'maxEntries',
          catalog: 'catalog',
          manifest: 'manifest',
          concurrency: 'concurrency',
          workload: 'workload',
          sender: 'sender',
          recipient: 'recipient',
          agent: 'agent',
          messageid: 'messageId',
          type: 'type',
          summary: 'summary',
          replyto: 'replyTo',
          capabilities: 'capabilities',
          receiptref: 'receiptRef',
          resultstatus: 'resultStatus',
          ttlms: 'ttlMs',
          claimms: 'claimMs',
          idempotencykey: 'idempotencyKey',
          actor: 'actor',
          status: 'status',
          bridgeroot: 'bridgeRoot',
          hostceiling: 'hostCeiling',
          othertaskreservations: 'otherTaskReservations',
          namespace: 'namespace',
          currenttaskid: 'currentTaskId',
        };
        const mappedKey = keyMap[key] ?? key;
        if (mappedKey === 'goal' || mappedKey === 'allowedRoot') {
          const prior = options[mappedKey];
          options[mappedKey] = prior === undefined ? value : [...(Array.isArray(prior) ? prior : [prior]), value];
        } else {
          options[mappedKey] = value;
        }
      } else {
        const key = name === '--help'
          ? 'help'
          : name === '--version'
            ? 'version'
            : name.slice(2).replaceAll('-', '');
        const keyMap = {
          json: 'json',
          help: 'help',
          version: 'version',
          dryrun: 'dryRun',
          nosubmit: 'noSubmit',
          force: 'force',
          all: 'all',
          apply: 'apply',
          confirm: 'confirm',
          includeunavailable: 'includeUnavailable',
        };
        options[keyMap[key] ?? key] = parseBoolean(inlineValue, name);
      }
      continue;
    }

    if (!command) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  if (command === 'help' || options.help === true) commandHelp = true;
  if (command === 'version' || options.version === true) commandVersion = true;
  if (command && !COMMANDS.includes(command) && !commandHelp && !commandVersion) {
    throw new CliUsageError(`unknown command: ${command}`);
  }
  if (afterSeparator && command !== 'run') {
    throw new CliUsageError('`--` command arguments are only valid for run');
  }

  return {
    command,
    commandHelp,
    commandVersion,
    options,
    positionals,
    passthrough,
  };
}

function usage() {
  return [
    'WorktreeProof — Evidence-backed guardrails for AI coding agents.',
    'Vibe fast. Ship with proof.',
    '',
    'Usage:',
    '  worktree-proof <command> [options]',
    '  worktree-proof run [options] -- <program> [args...]',
    '',
    'Commands:',
    '  doctor, plan, reserve, release, run, status, close, cleanup, validate',
    '  tools list|scan|recommend',
    '  resources scan|plan',
    '  recipes list|show <name>',
    '  init preview|apply (apply requires --confirm)',
    '  bridge send|inbox|claim|ack|complete|fail|cancel',
    '  tasks inspect --input <host-snapshot.json>',
    '',
    'Global options:',
    '  --repo <path>       Repository root (default: current directory)',
    '  --config <path>     JSON configuration file',
    '  --json              Emit one JSON result',
    '  --dry-run           Plan without mutating state',
    '  --no-submit         Do not submit or reserve external state',
    '  --help, --version   Show help or version',
    '  --confirm           Explicitly authorize init writes; preview is default',
  ].join('\n');
}

export function helpText() {
  return usage();
}

function versionText() {
  return `worktree-proof ${VERSION}`;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redact(value, key = '') {
  const sensitive = /(secret|token|password|passwd|cookie|authorization|credential|private.?key|api.?key|access.?key|refresh.?token|session)/i;
  if (sensitive.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (isObject(value)) {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redact(childValue, childKey);
    }
    return output;
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return '[function]';
  return value;
}

function safeJson(value) {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return JSON.stringify({ ok: false, error: 'result is not serializable' });
  }
}

function errorMessage(error) {
  if (error instanceof CliUsageError || error instanceof CliOperationError) return error.message;
  if (error instanceof SyntaxError) return 'invalid JSON input';
  // Adapter errors can contain command output, paths, or user-provided values.
  // Keep those details out of CLI logs; runtime modules should return a safe
  // structured error when callers need actionable diagnostics.
  return 'operation failed';
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(repo, configOption) {
  const candidate = configOption
    ? (isAbsolute(configOption) ? configOption : resolve(repo, configOption))
    : join(repo, 'worktree-proof.config.json');
  if (!(await pathExists(candidate))) return { path: candidate, config: {} };
  let text;
  try {
    text = await readFile(candidate, 'utf8');
  } catch (error) {
    throw new CliOperationError(`cannot read config: ${candidate}`, error);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new CliOperationError(`invalid config JSON: ${candidate}`, error);
  }
  if (!isObject(config)) throw new CliOperationError('config must contain a JSON object');
  return { path: candidate, config };
}

async function loadRuntimeDependencies(overrides = {}) {
  const deps = { ...overrides };
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  for (const [group, file] of Object.entries(MODULE_FILES)) {
    if (hasOwn(deps, group)) continue;
    try {
      deps[group] = await import(pathToFileURL(join(cliDirectory, file)).href);
    } catch (error) {
      // A command can still provide a useful read-only response while an
      // optional runtime module is being assembled.  Keep this isolated here;
      // the adapter below is the only place that knows module export names.
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') {
        deps[group] = { __loadError: error };
      } else {
        deps[group] = {};
      }
    }
  }
  return deps;
}

function findExport(module, names) {
  if (!module) return undefined;
  for (const name of names) {
    if (typeof module[name] === 'function') return module[name];
    if (typeof module.default?.[name] === 'function') return module.default[name];
  }
  if (typeof module.default === 'function') return module.default;
  return undefined;
}

/**
 * Isolated compatibility adapter for the runtime modules.  Runtime workers can
 * rename an export or change its object signature without changing the CLI
 * parser or command behavior; update this table only at integration time.
 */
export const ADAPTER_EXPORTS = Object.freeze({
  doctor: [['scope', ['doctorScope', 'inspectScope', 'checkScope', 'doctor']], ['git', ['discoverGitRepository', 'findGitRepository']]],
  plan: [['planner', ['plan', 'createPlan', 'buildPlan']]],
  reserve: [['leases', ['reserveLease', 'reserve', 'acquireLease']]],
  release: [['leases', ['releaseLease', 'release', 'revokeLease']]],
  run: [['runner', ['executeArgv', 'runArgv', 'execute', 'run']]],
  status: [['leases', ['status', 'statusLeases', 'listLeases', 'inspectLeases']], ['scope', ['status', 'scopeStatus']]],
  close: [['evidence', ['closeLane', 'close', 'createClosureReceipt', 'writeClosureReceipt']]],
  cleanup: [['worktree', ['cleanupManagedWorktrees', 'cleanup', 'removeManagedWorktrees']]],
  validate: [['evidence', ['validateClosureReceipt', 'validateReceipt', 'validate']], ['scope', ['validateLane', 'validate']]],
});

async function invokeFirst(deps, command, payload) {
  const candidates = ADAPTER_EXPORTS[command] ?? [];
  for (const [group, names] of candidates) {
    const fn = findExport(deps[group], names);
    if (!fn) continue;
    return await fn(payload);
  }
  return { supported: false, command, reason: 'runtime adapter unavailable' };
}

function configuredPath(repo, value, fallback) {
  const selected = value ?? fallback;
  return isAbsolute(selected) ? selected : resolve(repo, selected);
}

function projectStatePath(repo, value, fallback, label) {
  const root = resolve(repo);
  const candidate = configuredPath(root, value, fallback);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CliUsageError(`${label} must stay inside the repository`);
  }
  return candidate;
}

function leasePath(payload) {
  return configuredPath(
    payload.repo,
    payload.config.leaseStore ?? payload.config.leaseRegistry,
    join('.worktree-proof', 'leases.json'),
  );
}

function bridgePath(payload) {
  return configuredPath(
    payload.repo,
    payload.options.bridgeRoot ?? payload.config.bridgeDirectory,
    join('.worktree-proof', 'bridge'),
  );
}

function laneFromPayload(payload) {
  const defaults = isObject(payload.config.defaults) ? payload.config.defaults : {};
  const laneId = payload.options.laneId ?? payload.laneId ?? defaults.laneId;
  const fileScope = payload.options.fileScope ?? defaults.fileScope;
  if (typeof laneId !== 'string' || !laneId.trim()) {
    throw new CliUsageError('reserve requires --lane-id');
  }
  if (typeof fileScope !== 'string' || !fileScope.trim()) {
    throw new CliUsageError('reserve requires --file-scope');
  }
  const lane = { laneId, fileScope };
  const owner = payload.options.owner ?? payload.config.owner ?? defaults.owner;
  const session = payload.options.session ?? payload.config.session ?? defaults.session;
  // Local-only defaults keep the documented one-command demo usable while
  // allowing callers to provide stable owner/session labels in configuration.
  // They are metadata, never credentials, and are not rendered by the CLI.
  lane.owner = owner ?? 'local';
  lane.session = session ?? `process-${process.pid}`;
  return lane;
}

function numericOption(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CliUsageError(`invalid numeric option: ${value}`);
  return number;
}

async function readJsonInput(repo, value, label) {
  if (value === undefined) return undefined;
  const inputPath = configuredPath(repo, value, value);
  try {
    if ((await stat(inputPath)).isDirectory()) return undefined;
  } catch (error) {
    throw new CliOperationError(`cannot read ${label}`, error);
  }
  let text;
  try {
    text = await readFile(inputPath, 'utf8');
  } catch (error) {
    throw new CliOperationError(`cannot read ${label}: ${inputPath}`, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliOperationError(`invalid ${label} JSON`, error);
  }
}

function parseJsonOption(value, option) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CliUsageError(`${option} expects valid JSON`);
  }
}

async function writeJsonAtomic(filePath, value) {
  const destination = resolve(filePath);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    // Best effort cleanup; the original destination is never removed.
    try {
      const { rm } = await import('node:fs/promises');
      await rm(temporary, { force: true });
    } catch {
      // Keep the original write error as the actionable result.
    }
    throw new CliOperationError('unable to persist local lane state', error);
  }
  return destination;
}

async function listJsonRecords(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const path = join(directory, entry.name);
      try {
        records.push({ path, value: JSON.parse(await readFile(path, 'utf8')) });
      } catch (error) {
        throw new CliOperationError(`invalid state JSON: ${entry.name}`, error);
      }
    }
    return records;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error instanceof CliOperationError) throw error;
    throw new CliOperationError('unable to read local lane state', error);
  }
}

function optionList(value, option) {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && value.trim().startsWith('[')
    ? parseJsonOption(value, option)
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new CliUsageError(`${option} expects a comma-separated list or JSON string array`);
  }
  return parsed;
}

async function listRecipeFiles(repo) {
  const localDirectory = join(repo, 'recipes');
  const directory = await pathExists(localDirectory) ? localDirectory : join(PACKAGE_ROOT, 'recipes');
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new CliOperationError('unable to read recipe catalog', error);
  }
}

async function readRecipe(repo, name) {
  if (typeof name !== 'string' || !name.trim()) throw new CliUsageError('recipes show requires a recipe name');
  const normalized = name.trim().replace(/\.json$/i, '');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) throw new CliUsageError('recipe name contains unsupported characters');
  const localDirectory = resolve(repo, 'recipes');
  const directory = await pathExists(localDirectory) ? localDirectory : join(PACKAGE_ROOT, 'recipes');
  const file = resolve(directory, `${normalized}.json`);
  if (file !== resolve(directory, `${normalized}.json`)) throw new CliUsageError('recipe path escaped the repository');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new CliOperationError('recipe was not found', error);
    throw new CliOperationError('recipe JSON is invalid', error);
  }
}

function stateDirectory(payload) {
  return configuredPath(payload.repo, payload.config.stateDirectory, '.worktree-proof');
}

function runDirectory(payload) {
  return configuredPath(payload.repo, payload.config.runStore, join(stateDirectory(payload), 'runs'));
}

function planDirectory(payload) {
  return configuredPath(payload.repo, payload.config.planStore, join(stateDirectory(payload), 'plans'));
}

function closureDirectory(payload) {
  return configuredPath(payload.repo, payload.config.closureStore, join(stateDirectory(payload), 'closures'));
}

async function persistPlan(payload, plan) {
  if (!payload.submit || payload.dryRun) return undefined;
  const stamp = new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 17);
  const path = join(planDirectory(payload), `plan-${stamp}-${process.pid}.json`);
  return writeJsonAtomic(path, {
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    plan,
  });
}

async function persistRun(payload, result) {
  if (!payload.submit || payload.dryRun) return undefined;
  const laneId = payload.options.laneId ?? payload.laneId;
  if (!laneId) return undefined;
  const stamp = new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 17);
  const path = join(runDirectory(payload), `run-${laneId}-${stamp}-${process.pid}.json`);
  const record = {
    schemaVersion: '1',
    laneId,
    recordedAt: new Date().toISOString(),
    ok: result?.ok === true,
    code: Number.isInteger(result?.code) ? result.code : null,
    status: Number.isInteger(result?.status) ? result.status : null,
    signal: typeof result?.signal === 'string' ? result.signal : null,
    timedOut: result?.timedOut === true,
    stdoutBytes: Number.isInteger(result?.stdoutBytes) ? result.stdoutBytes : 0,
    stderrBytes: Number.isInteger(result?.stderrBytes) ? result.stderrBytes : 0,
    errorCode: typeof result?.errorCode === 'string' ? result.errorCode : undefined,
  };
  return writeJsonAtomic(path, record);
}

async function validateLocalState(repo, payload, deps, requestedPath) {
  const target = requestedPath ? configuredPath(repo, requestedPath, requestedPath) : repo;
  let targetStats;
  try {
    targetStats = await stat(target);
  } catch (error) {
    throw new CliOperationError('validation input was not found', error);
  }

  const checked = [];
  const receipts = [];
  const receiptPaths = [];
  const validateReceipt = findExport(deps.evidence, ['validateClosureReceipt', 'validateReceipt', 'validate']);
  const validateLane = findExport(deps.scope, ['normalizeLane', 'validateLane', 'validate']);
  const checkReceipt = (value, path) => {
    if (validateReceipt) validateReceipt(value);
    receipts.push(value);
    receiptPaths.push(path);
    checked.push(path);
  };

  if (!targetStats.isDirectory()) {
    let value;
    try {
      value = JSON.parse(await readFile(target, 'utf8'));
    } catch (error) {
      throw new CliOperationError('invalid validation JSON', error);
    }
    if (target.toLowerCase().endsWith('leases.json')) {
      const Registry = deps.leases?.LeaseRegistry;
      if (typeof Registry === 'function') await new Registry(target).read();
      checked.push(target);
    } else if (target.toLowerCase().includes('lane') && Array.isArray(value)) {
      if (validateLane) value.forEach((lane) => validateLane(lane));
      checked.push(target);
    } else {
      checkReceipt(value, target);
    }
    return { valid: true, path: target, checked, receipts: receipts.length, receiptPaths };
  }

  const state = stateDirectory(payload);
  const closureRecords = [
    ...(await listJsonRecords(closureDirectory(payload))),
    ...(await listJsonRecords(join(state, 'receipts'))),
  ];
  for (const record of closureRecords) checkReceipt(record.value, record.path);
  const registryPath = leasePath(payload);
  if (await pathExists(registryPath)) {
    const Registry = deps.leases?.LeaseRegistry;
    if (typeof Registry === 'function') await new Registry(registryPath).read();
    checked.push(registryPath);
  }
  const plans = await listJsonRecords(planDirectory(payload));
  for (const record of plans) {
    if (!record.value || typeof record.value !== 'object' || !record.value.plan) {
      throw new CliOperationError(`invalid plan state: ${record.path}`);
    }
    checked.push(record.path);
  }
  return { valid: true, path: target, checked, receipts: receipts.length, receiptPaths };
}

function planInput(payload, input) {
  const explicitLaneId = payload.options.laneId ?? payload.laneId;
  const explicitScope = payload.options.fileScope;
  if (explicitLaneId !== undefined || explicitScope !== undefined) {
    if (typeof explicitLaneId !== 'string' || !explicitLaneId.trim()) {
      throw new CliUsageError('plan requires a lane id');
    }
    if (typeof explicitScope !== 'string' || !explicitScope.trim()) {
      throw new CliUsageError('plan requires --scope');
    }
    return {
      lanes: [{
        laneId: explicitLaneId,
        fileScope: explicitScope,
        ...(payload.options.task ? { task: payload.options.task } : {}),
        ...(payload.options.mode ? { mode: payload.options.mode } : {}),
      }],
    };
  }
  const source = input ?? payload.config;
  if (Array.isArray(source)) return { lanes: source };
  if (!isObject(source)) return {};
  return {
    lanes: source.lanes ?? [],
    backlog: source.backlog ?? [],
    capacity: source.capacity,
    resources: source.resources,
  };
}

function sanitizeRunnerResult(result) {
  if (!isObject(result)) return { ok: Boolean(result) };
  const stdout = typeof result.stdout === 'string' ? Buffer.byteLength(result.stdout, 'utf8') : undefined;
  const stderr = typeof result.stderr === 'string' ? Buffer.byteLength(result.stderr, 'utf8') : undefined;
  return {
    ok: result.ok === true,
    code: Number.isInteger(result.code) ? result.code : null,
    status: Number.isInteger(result.status) ? result.status : null,
    signal: typeof result.signal === 'string' ? result.signal : null,
    timedOut: result.timedOut === true,
    stdoutBytes: stdout,
    stderrBytes: stderr,
    errorCode: typeof result.error?.code === 'string' ? result.error.code : undefined,
  };
}

async function invokeAdapter(deps, command, payload, input) {
  // These calls form the only compatibility boundary between the CLI and the
  // runtime modules.  Keep all signature adaptation here when a runtime API is
  // changed; parser behavior and command safety remain independent.
  if (command === 'tasks') {
    const action = payload.positionals[0] ?? 'inspect';
    if (action !== 'inspect') throw new CliUsageError(`unknown tasks action: ${action}`);
    if (!isObject(input) && !Array.isArray(input)) throw new CliUsageError('tasks inspect requires --input with a host snapshot');
    const tasksApi = deps.tasks;
    if (!tasksApi) return { supported: false, command, reason: 'task awareness adapter unavailable' };
    return {
      action,
      snapshot: tasksApi.sanitizeTaskSnapshot(input, {
        namespace: payload.options.namespace,
        currentTaskId: payload.options.currentTaskId,
      }),
    };
  }

  if (command === 'bridge') {
    const action = payload.positionals[0] ?? 'inbox';
    const bridgeApi = deps.bridge;
    if (!bridgeApi) return { supported: false, command, reason: 'bridge adapter unavailable' };
    const root = projectStatePath(
      payload.repo,
      payload.options.bridgeRoot ?? payload.config.bridgeRoot,
      join('.worktree-proof', 'bridge'),
      'bridge root',
    );
    const messageId = payload.options.messageId ?? payload.positionals[1];
    if (action === 'send') {
      const source = isObject(input) ? input : {};
      return {
        action,
        message: await bridgeApi.sendBridgeMessage(root, {
          ...source,
          sender: payload.options.sender ?? source.sender,
          recipient: payload.options.recipient ?? source.recipient,
          type: payload.options.type ?? source.type ?? 'task',
          summary: payload.options.summary ?? source.summary,
          laneId: payload.options.laneId ?? source.laneId,
          fileScope: payload.options.fileScope ?? source.fileScope,
          capabilities: optionList(payload.options.capabilities, '--capabilities') ?? source.capabilities,
          replyTo: payload.options.replyTo ?? source.replyTo,
          idempotencyKey: payload.options.idempotencyKey ?? source.idempotencyKey,
          ttlMs: numericOption(payload.options.ttlMs, source.ttlMs),
        }),
      };
    }
    if (action === 'inbox') {
      const recipient = payload.options.recipient ?? payload.options.agent;
      if (!recipient) throw new CliUsageError('bridge inbox requires --recipient or --agent');
      return {
        action,
        messages: await bridgeApi.listBridgeInbox(root, { recipient, status: payload.options.status }),
      };
    }
    if (!messageId) throw new CliUsageError(`bridge ${action} requires --message-id or a message id positional`);
    if (action === 'claim') {
      const receiver = payload.options.agent ?? payload.options.recipient;
      if (!receiver) throw new CliUsageError('bridge claim requires --agent or --recipient');
      return {
        action,
        message: await bridgeApi.claimBridgeMessage(root, {
          messageId,
          receiver,
          claimMs: numericOption(payload.options.claimMs, undefined),
        }),
      };
    }
    if (action === 'ack') {
      const actor = payload.options.actor ?? payload.options.agent;
      if (!actor) throw new CliUsageError('bridge ack requires --actor or --agent');
      return { action, message: await bridgeApi.ackBridgeMessage(root, { messageId, actor }) };
    }
    if (['complete', 'fail', 'cancel'].includes(action)) {
      const source = isObject(input) ? input : {};
      const actor = payload.options.actor ?? payload.options.agent;
      if (!actor) throw new CliUsageError(`bridge ${action} requires --actor or --agent`);
      const result = {
        ...(payload.options.summary ?? source.summary ? { summary: payload.options.summary ?? source.summary } : {}),
        ...(payload.options.receiptRef ?? source.receiptRef ? { receiptRef: payload.options.receiptRef ?? source.receiptRef } : {}),
        ...(Array.isArray(source.evidence) ? { evidence: source.evidence } : {}),
      };
      return {
        action,
        message: await bridgeApi.completeBridgeMessage(root, {
          messageId,
          actor,
          status: payload.options.resultStatus ?? source.status ?? (action === 'fail' ? 'failed' : action === 'cancel' ? 'cancelled' : 'completed'),
          result: Object.keys(result).length ? result : undefined,
        }),
      };
    }
    throw new CliUsageError(`unknown bridge action: ${action}`);
  }

  if (command === 'tools') {
    const action = payload.positionals[0] ?? 'list';
    const toolsApi = deps.tools;
    if (!toolsApi) return { supported: false, command, reason: 'tool catalog adapter unavailable' };
    const catalog = toolsApi.loadToolCatalog({
      catalogPath: payload.options.catalog ? configuredPath(payload.repo, payload.options.catalog, payload.options.catalog) : undefined,
    });
    if (action === 'list') {
      return {
        action,
        count: catalog.length,
        tools: catalog.map((tool) => ({ id: tool.id, name: tool.name, categories: tool.categories, capabilities: tool.capabilities })),
      };
    }
    if (action === 'scan') {
      const scanOptions = {};
      if (payload.options.concurrency !== undefined) scanOptions.concurrency = numericOption(payload.options.concurrency);
      const inventory = await toolsApi.scanTools(catalog, scanOptions);
      return { action, inventory: toolsApi.summarizeInventory(inventory), results: inventory };
    }
    if (action === 'recommend') {
      const goals = optionList(payload.options.goal ?? payload.positionals.slice(1), '--goal') ?? [];
      if (goals.length === 0) throw new CliUsageError('tools recommend requires --goal or a goal positional');
      const inventory = payload.options.input
        ? JSON.parse(await readFile(configuredPath(payload.repo, payload.options.input, payload.options.input), 'utf8'))
        : undefined;
      return { action, goals, recommendations: toolsApi.recommendTools(goals, inventory, { catalog, includeUnavailable: payload.options.includeUnavailable === true }) };
    }
    throw new CliUsageError(`unknown tools action: ${action}`);
  }

  if (command === 'resources') {
    const action = payload.positionals[0] ?? 'scan';
    const resourcesApi = deps.resources;
    if (!resourcesApi) return { supported: false, command, reason: 'resource diagnostics adapter unavailable' };
    const resourcePolicy = isObject(payload.config.resourcePolicy) ? payload.config.resourcePolicy : {};
    const scan = input && isObject(input) ? input : await resourcesApi.scanResources({
      repoPath: payload.repo,
      maxDepth: numericOption(payload.options.maxDepth, undefined),
      maxEntries: numericOption(payload.options.maxEntries, undefined),
    });
    if (action === 'scan') {
      return {
        action,
        scan,
        profile: resourcesApi.chooseResourceProfile(scan, payload.options.profile),
        sessionGuard: resourcesApi.planSessionGuard(scan, {
          requested: numericOption(payload.options.concurrency, resourcePolicy.requested),
          configuredMax: resourcePolicy.configuredMax,
          hostCeiling: numericOption(payload.options.hostCeiling, resourcePolicy.hostCeiling),
          otherTaskReservations: numericOption(payload.options.otherTaskReservations, undefined),
        }),
        summary: resourcesApi.summarizeResources(scan),
      };
    }
    if (action === 'plan') {
      const roots = optionList(payload.options.allowedRoots ?? payload.options.allowedRoot, '--allowed-roots') ?? ['.'];
      return {
        action,
        scan,
        sessionGuard: resourcesApi.planSessionGuard(scan, {
          requested: numericOption(payload.options.concurrency, resourcePolicy.requested),
          configuredMax: resourcePolicy.configuredMax,
          hostCeiling: numericOption(payload.options.hostCeiling, resourcePolicy.hostCeiling),
          otherTaskReservations: numericOption(payload.options.otherTaskReservations, undefined),
        }),
        cleanup: resourcesApi.planProjectCleanup(scan, { allowedRoots: roots }),
      };
    }
    throw new CliUsageError(`unknown resources action: ${action}`);
  }

  if (command === 'recipes') {
    const action = payload.positionals[0] ?? 'list';
    const files = await listRecipeFiles(payload.repo);
    if (action === 'list') return { action, recipes: files.map((file) => file.replace(/\.json$/i, '')) };
    if (action === 'show') return { action, recipe: await readRecipe(payload.repo, payload.positionals[1]) };
    throw new CliUsageError(`unknown recipes action: ${action}`);
  }

  if (command === 'init') {
    const action = payload.positionals[0] ?? 'preview';
    const initApi = deps.init;
    if (!initApi) return { supported: false, command, reason: 'init adapter unavailable' };
    const targets = optionList(payload.options.targets ?? payload.options.target, '--targets');
    const plan = await initApi.buildInitPlan({ repo: payload.repo, targets, preset: payload.options.preset });
    if (action === 'preview' || payload.dryRun) {
      return { action: 'preview', dryRun: true, plan: await initApi.applyInitPlan(plan, { dryRun: true }) };
    }
    if (action !== 'apply') throw new CliUsageError(`unknown init action: ${action}`);
    if (payload.options.confirm !== true) throw new CliUsageError('init apply requires --confirm');
    return { action, dryRun: false, result: await initApi.applyInitPlan(plan, { dryRun: false, confirm: true }) };
  }

  if (command === 'plan') {
    const fn = findExport(deps.planner, ['planCapacity', 'plan', 'createPlan', 'buildPlan']);
    if (fn) {
      const requested = planInput(payload, input);
      if (payload.options.lanes !== undefined) requested.lanes = parseJsonOption(payload.options.lanes, '--lanes');
      if (payload.options.backlog !== undefined) requested.backlog = parseJsonOption(payload.options.backlog, '--backlog');
      if (payload.options.capacity !== undefined) requested.capacity = numericOption(payload.options.capacity);
      if (payload.options.resources !== undefined) requested.resources = parseJsonOption(payload.options.resources, '--resources');
      return await fn(requested);
    }
  }

  if (command === 'reserve') {
    const fn = findExport(deps.leases, ['reserveLease']);
    if (fn) {
      const lane = laneFromPayload(payload);
      const ttl = numericOption(payload.options.ttl, undefined);
      if (ttl !== undefined) lane.ttlMs = ttl;
      return await fn(leasePath(payload), lane, ttl === undefined ? {} : { ttlMs: ttl });
    }
    const registry = deps.leases?.LeaseRegistry;
    if (typeof registry === 'function') {
      const ttl = numericOption(payload.options.ttl, undefined);
      const instance = new registry(leasePath(payload), ttl === undefined ? {} : { ttlMs: ttl });
      return await instance.reserve(laneFromPayload(payload));
    }
  }

  if (command === 'release') {
    const fn = findExport(deps.leases, ['releaseLease']);
    const selector = {
      ...(payload.options.leaseId ? { leaseId: payload.options.leaseId } : {}),
      ...(payload.options.laneId || payload.laneId ? { laneId: payload.options.laneId ?? payload.laneId } : {}),
      ...(payload.options.owner ? { owner: payload.options.owner } : {}),
      ...(payload.options.session ? { session: payload.options.session } : {}),
      ...(payload.options.reason ? { reason: payload.options.reason } : {}),
    };
    if (Object.keys(selector).length === 0 && payload.options.lease) selector.leaseId = payload.options.lease;
    if (Object.keys(selector).length === 0) throw new CliUsageError('release requires --lease-id or --lane-id');
    if (fn) return await fn(leasePath(payload), selector);
    const Registry = deps.leases?.LeaseRegistry;
    if (typeof Registry === 'function') return await new Registry(leasePath(payload)).release(selector);
  }

  if (command === 'run') {
    const fn = findExport(deps.runner, ['executeArgv', 'runArgv', 'runCommand', 'execute', 'run']);
    if (fn) {
      const laneId = payload.options.laneId ?? payload.laneId;
      if (laneId) {
        const Registry = deps.leases?.LeaseRegistry;
        if (typeof Registry === 'function') {
          const active = await new Registry(leasePath(payload)).active();
          if (!active.some((entry) => entry.laneId === laneId)) {
            throw new CliOperationError('run requires an active reservation for the lane');
          }
        }
      }
      const runnerOptions = {
        cwd: payload.repo,
        timeoutMs: numericOption(payload.options.timeout, undefined),
        maxOutputBytes: numericOption(payload.options.maxOutputBytes, undefined),
      };
      return sanitizeRunnerResult(await fn(payload.argv, runnerOptions));
    }
  }

  if (command === 'doctor') {
    const fn = findExport(deps.scope, ['doctorScope', 'inspectScope', 'checkScope', 'doctor']);
    if (fn) return await fn(payload);
    const discover = findExport(deps.git, ['discoverGitRepository', 'findGitRepository', 'discoverRepository']);
    if (discover) {
      try {
        const repository = await discover(payload.repo, {
          canonicalRef: payload.options.canonicalRef ?? payload.config.canonicalRef,
        });
        return { ok: true, repository, nodeMajor: Number(process.versions.node.split('.')[0]) };
      } catch {
        // Doctor is useful before a repository exists.  Report a concise
        // prerequisite result instead of surfacing git's command output.
        return {
          ok: Number(process.versions.node.split('.')[0]) >= 20,
          repository: payload.repo,
          git: false,
          nodeMajor: Number(process.versions.node.split('.')[0]),
          stateDirectory: configuredPath(payload.repo, payload.config.stateDirectory, '.worktree-proof'),
        };
      }
    }
    return {
      ok: Number(process.versions.node.split('.')[0]) >= 20,
      repository: payload.repo,
      nodeMajor: Number(process.versions.node.split('.')[0]),
      stateDirectory: configuredPath(payload.repo, payload.config.stateDirectory, '.worktree-proof'),
    };
  }

  if (command === 'status') {
    const fn = findExport(deps.leases, ['status', 'statusLeases', 'listLeases', 'inspectLeases']);
    if (fn) {
      const result = await fn({ registryPath: leasePath(payload), ...payload });
      const runs = await listJsonRecords(runDirectory(payload));
      const closures = await listJsonRecords(closureDirectory(payload));
      return {
        ...(isObject(result) ? result : { value: result }),
        runs: runs.map((entry) => entry.value),
        closures: closures.map((entry) => entry.value),
        awaitingClosure: (isObject(result) && Array.isArray(result.active) ? result.active : []).filter(
          (entry) => !closures.some((closure) => closure.value?.laneId === entry.laneId),
        ),
      };
    }
    const Registry = deps.leases?.LeaseRegistry;
    if (typeof Registry === 'function') {
      const instance = new Registry(leasePath(payload));
      const leases = await instance.list();
      const active = leases.filter((entry) => entry.status === 'active');
      const runs = await listJsonRecords(runDirectory(payload));
      const closures = await listJsonRecords(closureDirectory(payload));
      return {
        leases,
        active,
        runs: runs.map((entry) => entry.value),
        closures: closures.map((entry) => entry.value),
        awaitingClosure: active.filter((entry) => !closures.some((closure) => closure.value?.laneId === entry.laneId)),
      };
    }
    const scopeFn = findExport(deps.scope, ['status', 'scopeStatus']);
    if (scopeFn) return await scopeFn(payload);
  }

  if (command === 'close') {
    const fn = findExport(deps.evidence, ['closeLane', 'close', 'createClosureReceipt', 'writeClosureReceipt']);
    if (fn) return await fn({ ...payload, receipt: input });
    const validate = findExport(deps.evidence, ['validateClosureReceipt', 'assertClosureReceipt']);
    if (validate && input !== undefined) return await validate(input);
  }

  if (command === 'cleanup') {
    const fn = findExport(deps.worktree, ['cleanupManagedWorktrees', 'cleanupWorktrees', 'cleanup', 'removeManagedWorktrees']);
    if (fn) {
      return await fn({
        repoRoot: payload.repo,
        worktreeRoot: configuredPath(payload.repo, payload.config.worktreeRoot, join('.worktree-proof', 'worktrees')),
        dryRun: payload.dryRun,
        lanes: payload.options.lanes === undefined ? [] : parseJsonOption(payload.options.lanes, '--lanes'),
        force: payload.options.force === true,
        config: payload.config,
      });
    }
  }

  if (command === 'validate') {
    const fn = findExport(deps.evidence, ['validateClosureReceipt', 'validateReceipt', 'validate']);
    if (fn && input !== undefined) return await fn(input);
    const scopeFn = findExport(deps.scope, ['validateLane', 'validate']);
    if (scopeFn && input !== undefined) return await scopeFn(input);
    return await validateLocalState(payload.repo, payload, deps, payload.options.input ?? payload.options.receipt ?? payload.positionals[0]);
  }

  return await invokeFirst(deps, command, payload);
}

function commandPayload(parsed, repo, configData) {
  return {
    repo,
    config: configData.config,
    configPath: configData.path,
    options: { ...parsed.options },
    positionals: [...parsed.positionals],
    argv: [...parsed.passthrough],
    dryRun: parsed.options.dryRun === true,
    submit: parsed.options.noSubmit !== true && parsed.options.dryRun !== true,
    noSubmit: parsed.options.noSubmit === true,
  };
}

function requireValue(options, name, command) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliUsageError(`${command} requires --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return value;
}

function checkCommandPositionals(parsed) {
  const { command, positionals } = parsed;
  if (command === 'run') {
    if (positionals.length > 1) throw new CliUsageError('run accepts at most one positional lane id');
    if (parsed.passthrough.length === 0 && !parsed.options.dryRun) {
      throw new CliUsageError('run requires a program after `--`');
    }
  }
  if (['reserve', 'release', 'close'].includes(command)
      && positionals.length > 1) {
    throw new CliUsageError(`${command} accepts at most one positional lane id`);
  }
  if (command === 'validate' && positionals.length > 1) {
    throw new CliUsageError('validate accepts at most one receipt path');
  }
  if (command === 'bridge' && positionals.length > 2) {
    throw new CliUsageError('bridge accepts an action and at most one message id');
  }
  if (command === 'tasks' && positionals.length > 1) {
    throw new CliUsageError('tasks accepts one action');
  }
}

async function executeCommand(parsed, context) {
  const { command, options } = parsed;
  if (command === undefined || parsed.commandHelp) return { help: usage() };
  if (parsed.commandVersion) return { version: versionText() };
  checkCommandPositionals(parsed);

  const payload = commandPayload(parsed, context.repo, context.configData);
  if (parsed.positionals.length === 1 && !options.laneId) payload.laneId = parsed.positionals[0];
  if (command === 'run') {
    // The runner receives an argv array, never a shell command string.  A dry
    // run reports shape only so command arguments cannot leak into logs.
    if (parsed.passthrough.length === 0 || options.dryRun) {
      return {
        planned: true,
        executed: false,
        argvCount: parsed.passthrough.length,
        submit: payload.submit,
      };
    }
  }

  if (['reserve', 'release', 'close', 'cleanup'].includes(command)
      && (!payload.submit || options.dryRun)) {
    return {
      planned: true,
      submitted: false,
      command,
      reason: options.dryRun ? 'dry-run' : 'no-submit',
    };
  }
  if (command === 'bridge'
      && (parsed.positionals[0] ?? 'inbox') !== 'inbox'
      && (!payload.submit || options.dryRun)) {
    return {
      planned: true,
      submitted: false,
      command,
      action: parsed.positionals[0],
      reason: options.dryRun ? 'dry-run' : 'no-submit',
    };
  }

  const inputOption = options.input ?? options.receipt
    ?? (command === 'validate' ? parsed.positionals[0] : undefined);
  const configuredReceipt = command === 'close' ? context.configData.config.receipt : undefined;
  const input = inputOption === undefined
    ? (typeof configuredReceipt === 'string'
      ? await readJsonInput(context.repo, configuredReceipt, 'receipt')
      : configuredReceipt)
    : await readJsonInput(context.repo, inputOption, command === 'validate' ? 'receipt' : 'input');
  const result = await invokeAdapter(context.deps, command, payload, input);
  if (command === 'plan') {
    const persisted = await persistPlan(payload, result);
    return persisted ? { ...(isObject(result) ? result : { value: result }), planPath: persisted } : result;
  }
  if (command === 'run') {
    const sanitized = sanitizeRunnerResult(result);
    const persisted = await persistRun(payload, sanitized);
    return persisted ? { ...sanitized, runPath: persisted } : sanitized;
  }
  return result === undefined ? { ok: true, command } : result;
}

function renderResult(parsed, result) {
  const safeResult = redact(result);
  if (parsed.options.json) {
    return safeJson({ ok: true, command: parsed.command ?? null, result: safeResult });
  }
  if (result?.help) return result.help;
  if (result?.version) return result.version;
  if (result?.planned && result?.executed === false) {
    return `${parsed.command}: planned (not executed)`;
  }
  if (result?.planned && result?.submitted === false) {
    return `${parsed.command}: planned (${result.reason})`;
  }
  if (result?.supported === false) return `${parsed.command}: ${result.reason}`;
  if (result === undefined || result === null) return `${parsed.command}: ok`;
  // Do not echo arbitrary adapter strings (a runner could have returned child
  // process output containing a credential or other sensitive value).
  if (typeof result === 'string') return `${parsed.command}: ok`;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  // Human output intentionally contains keys and status only, not arbitrary
  // values returned by adapters.
  const keys = Object.keys(safeResult ?? {}).sort();
  return `${parsed.command}: ok${keys.length ? ` (${keys.join(', ')})` : ''}`;
}

/**
 * Run one CLI invocation.  The return value is suitable for bin/worktree-proof.js
 * and for tests; no process exit occurs here.
 */
export async function runCli(argv = process.argv.slice(2), options = {}) {
  const io = options.io ?? defaultIo();
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const message = errorMessage(error);
    const fallback = { ok: false, error: message, code: EXIT_CODES.USAGE };
    if (argv.includes('--json')) io.stdout(safeJson(fallback));
    else io.stderr(`error: ${message}\n${usage()}`);
    return fallback;
  }

  if (parsed.command === undefined || parsed.commandHelp || parsed.commandVersion) {
    const result = parsed.commandVersion ? { version: versionText() } : { help: usage() };
    io.stdout(parsed.options.json ? safeJson({ ok: true, command: parsed.command ?? null, result }) : (result.version ?? result.help));
    return { ok: true, code: EXIT_CODES.OK, result };
  }

  const repo = resolve(options.repo ?? parsed.options.repo ?? process.cwd());
  let configData;
  try {
    configData = await (options.loadConfig
      ? options.loadConfig(repo, parsed.options.config)
      : loadConfig(repo, parsed.options.config));
    const deps = await loadRuntimeDependencies(options.deps ?? {});
    const result = await executeCommand(parsed, { repo, configData, deps });
    io.stdout(renderResult(parsed, result));
    return { ok: true, code: EXIT_CODES.OK, result };
  } catch (error) {
    const message = errorMessage(error);
    const code = error?.code === EXIT_CODES.USAGE ? EXIT_CODES.USAGE : EXIT_CODES.ERROR;
    if (parsed.options.json) io.stdout(safeJson({ ok: false, command: parsed.command, error: message, code }));
    else io.stderr(`error: ${message}`);
    return { ok: false, code, error: message };
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const result = await runCli(argv, options);
  return result.code ?? (result.ok ? EXIT_CODES.OK : EXIT_CODES.ERROR);
}
