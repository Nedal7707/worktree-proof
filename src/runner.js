import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function sanitizeText(value, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  let text = value == null ? '' : String(value);
  text = text.replace(ANSI_ESCAPE_RE, '');
  if (Buffer.byteLength(text, 'utf8') <= maxOutputBytes) return text;
  let truncated = Buffer.from(text, 'utf8').subarray(0, maxOutputBytes).toString('utf8');
  // Avoid returning a dangling UTF-16 replacement where a multi-byte codepoint
  // was cut. This is intentionally small and deterministic for logs/tests.
  truncated = truncated.replace(/\uFFFD$/, '');
  return `${truncated}\n[output truncated]`;
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('argv must be a non-empty array of strings');
  }
}

function normalizedError(error) {
  if (!error) return undefined;
  return {
    code: error.code ?? 'SPAWN_ERROR',
    message: String(error.message ?? error),
  };
}

function baseResult(argv, options = {}) {
  return {
    ok: false,
    argv: [...argv],
    cwd: options.cwd ? path.resolve(options.cwd) : undefined,
    code: null,
    status: null,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    error: undefined,
  };
}

function resultFromRaw(argv, options, raw) {
  const result = baseResult(argv, options);
  result.code = Number.isInteger(raw?.status) ? raw.status : null;
  result.status = result.code;
  result.signal = raw?.signal ?? null;
  result.stdout = sanitizeText(raw?.stdout, options.maxOutputBytes);
  result.stderr = sanitizeText(raw?.stderr, options.maxOutputBytes);
  result.error = normalizedError(raw?.error);
  result.ok = result.code === 0 && !result.signal && !result.error;
  return result;
}

/**
 * Execute argv directly with shell execution disabled. No command string is
 * reconstructed and no environment value is placed in the returned result.
 */
export function executeArgv(argv, options = {}) {
  validateArgv(argv);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError('maxOutputBytes must be a positive integer');
  const timeoutMs = options.timeoutMs == null ? 0 : Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('timeoutMs must be a non-negative number');
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const [command, ...args] = argv;
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options.spawnOptions,
    shell: false,
  };

  return new Promã­í¢G§²ÚîÆ­yÒ?.on?.('data', (chunk) => append(stderr, chunk));
    child?.once?.('error', (error) => finalize(null, null, error));
    child?.once?.('close', (code, signal) => finalize(code, signal));
    child?.once?.('exit', (code, signal) => finalize(code, signal));
    // Some lightweight injected child implementations only expose `on`.
    if (!child?.once && child?.on) {
      child.on('error', (error) => finalize(null, null, error));
      child.on('close', (code, signal) => finalize(code, signal));
      child.on('exit', (code, signal) => finalize(code, signal));
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        timeoutError = { code: 'ETIMEDOUT', message: `command timed out after ${timeoutMs}ms` };
        try {
          child?.kill?.(options.killSignal ?? 'SIGTERM');
        } catch {
          // The final result remains sanitized; inability to kill is reflected
          // by the bounded grace timer below rather than an exception.
        }
        const grace = options.killGraceMs == null ? 250 : Math.max(0, Number(options.killGraceMs));
        killTimer = setTimeout(() => {
          if (settled) return;
          try {
            child?.kill?.('SIGKILL');
          } catch {
            // Finalize even for an injected process that ignores kill().
          }
          finalize(null, 'SIGTERM', timeoutError);
        }, grace);
      }, timeoutMs);
    }
  });
}

/**
 * Synchronous counterpart for callers that already use a sync git/worktree
 * transaction. It preserves the same sanitized result shape.
 */
export function executeArgvSync(argv, options = {}) {
  validateArgv(argv);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError('maxOutputBytes must be a positive integer');
  const timeoutMs = options.timeoutMs == null ? 0 : Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('timeoutMs must be a non-negative number');
  const spawnSyncImpl = options.spawnSyncImpl ?? options.spawnSync ?? nodeSpawnSync;
  const [command, ...args] = argv;
  let raw;
  try {
    raw = spawnSyncImpl(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: timeoutMs || undefined,
      maxBuffer: options.maxBuffer ?? maxOutputBytes,
      input: options.input,
      ...options.spawnOptions,
      shell: false,
    });
  } catch (error) {
    raw = { error };
  }
  const result = resultFromRaw(argv, { ...options, maxOutputBytes }, raw);
  if (raw?.error?.code === 'ETIMEDOUT' || raw?.signal === 'SIGTERM' && timeoutMs > 0) {
    result.timedOut = true;
    result.ok = false;
  }
  return result;
}

export const runArgv = executeArgv;
export const runArgvSync = executeArgvSync;
export const runCommand = executeArgv;

export { sanitizeText };
