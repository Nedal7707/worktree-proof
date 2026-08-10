/**
 * Safe, declarative tool inventory helpers.
 *
 * The registry intentionally has a very small execution surface: a manifest
 * may name an executable and one of a few version/help flags.  Detection never
 * invokes a shell, reads process state, or runs an installer.  This makes the
 * module useful to a CLI, a desktop app, or a browser-side planning service
 * without turning user supplied data into an execution primitive.
 */

import { readFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('../catalog/tools.json', import.meta.url));

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
export const MAX_PROBE_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_SCAN_CONCURRENCY = 4;

const MANIFEST_KEYS = new Set([
  'id',
  'name',
  'description',
  'categories',
  'capabilities',
  'tags',
  'command',
  'probes',
  'source',
]);
const PROBE_KEYS = new Set(['args', 'timeoutMs']);
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;
const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,63}$/u;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9+._/-]{0,63}$/u;
const SAFE_PROBE_ARGS = new Set([
  '--version',
  '-V',
  '-v',
  'version',
  '-version',
  '/version',
  '--help',
  '-h',
  'help',
  '/?',
]);
const AVAILABILITY_VALUES = new Set(['available', 'unavailable', 'unknown', 'timed-out']);

/** Raised when a manifest would be unsafe or does not match the contract. */
export class ToolManifestValidationError extends TypeError {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolManifestValidationError';
    this.code = details.code ?? 'ERR_INVALID_TOOL_MANIFEST';
    this.path = details.path;
  }
}

/** Raised when a catalog cannot be read or contains invalid entries. */
export class ToolCatalogError extends TypeError {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolCatalogError';
    this.code = details.code ?? 'ERR_INVALID_TOOL_CATALOG';
    this.path = details.path;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ToolManifestValidationError('manifest must not contain symbol properties', {
      code: 'ERR_UNSAFE_TOOL_MANIFEST',
    });
  }
  return Object.keys(value);
}

function requiredText(value, field, maxLength = 160) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new ToolManifestValidationError(`${field} must be a non-empty trimmed string`, {
      path: field,
      code: 'ERR_INVALID_TOOL_FIELD',
    });
  }
  if (value.length > maxLength) ï¾ú¶‰žËkºwµç}¹ÍÐÍ•…É¡…‰±”€ô¹•ÜM•Ð¡l¸¸¹µ…¹¥™•ÍÐ¹…Ñ•½É¥•Ì°€¸¸¹µ…¹¥™•ÍÐ¹…Á…‰¥±¥Ñ¥•Ì°€¸¸¹µ…¹¥™•ÍÐ¹Ñ…Ít¤ì(€€€½¹ÍÐµ…Ñ¡•‘Q…Ì€ô½…±Ì¹™¥±Ñ•È ¡½…°¤€ôøÍ•…É¡…‰±”¹¡…Ì¡½…°¤¤ì(€€€½¹ÍÐÁ…ÉÑ¥…±5…Ñ¡•Ì€ô½…±Ì¹™¥±Ñ•È ¡½…°¤€ôøl¸¸¹Í•…É¡…‰±•t¹Í½µ” ¡Ù…±Õ”¤€ôøÙ…±Õ”¹¥¹±Õ‘•Ì¡½…°¤ñð½…°¹¥¹±Õ‘•Ì¡Ù…±Õ”¤¤¤ì(€€€½¹ÍÐÍ½É”€ôµ…Ñ¡•‘Q…Ì¹±•¹Ñ €¨€Ð€¬5…Ñ ¹µ…à À°Á…ÉÑ¥…±5…Ñ¡•Ì¹±•¹Ñ €´µ…Ñ¡•‘Q…Ì¹±•¹Ñ ¤€¨€Èì(€€€¥˜€¡Í½É”€ðô€À¤½¹Ñ¥¹Õ”ì(€€€…¹‘¥‘…Ñ•Ì¹ÁÕÍ ¡ì(€€€€€¥èµ…¹¥™•ÍÐ¹¥°(€€€€€¹…µ”èµ…¹¥™•ÍÐ¹¹…µ”°(€€€€€Í½É”°(€€€€€µ…Ñ¡•‘Q…Ìèl¸¸¹¹•ÜM•Ð¡l¸¸¹µ…Ñ¡•‘Q…Ì°€¸¸¹Á…ÉÑ¥…±5…Ñ¡•Ít¥t°(€€€€€…Ñ•½É¥•Ìèl¸¸¹µ…¹¥™•ÍÐ¹…Ñ•½É¥•Ít°(€€€€€…Á…‰¥±¥Ñ¥•Ìèl¸¸¹µ…¹¥™•ÍÐ¹…Á…‰¥±¥Ñ¥•Ít°(€€€€€…Ù…¥±…‰±”èµ…¹¥™•ÍÐ¹…Ù…¥±…‰±”°(€€€€€…Ù…¥±…‰¥±¥Ñäèµ…¹¥™•ÍÐ¹…Ù…¥±…‰¥±¥Ñä°(€€€ô¤ì(€ô(€…¹‘¥‘…Ñ•Ì¹Í½ÉÐ ¡±•™Ð°É¥¡Ð¤€ôøÉ¥¡Ð¹Í½É”€´±•™Ð¹Í½É”ñð±•™Ð¹¹…µ”¹±½…±•½µÁ…É”¡É¥¡Ð¹¹…µ”¤ñð±•™Ð¹¥¹±½…±•½µÁ…É”¡É¥¡Ð¹¥¤¤ì(€É•ÑÕÉ¸…¹‘¥‘…Ñ•Ìì)ô((¼¨¨AÉ½‘Õ”ÍÑ…‰±”½Õ¹ÑÌ…¹É•‘…Ñ•Á•ÈµÑ½½°ÍÕµµ…É¥•Ì™½ÈU$½É•Á½ÉÑ¥¹œ¸€¨¼)•áÁ½ÉÐ™Õ¹Ñ¥½¸ÍÕµµ…É¥é•%¹Ù•¹Ñ½Éä¡¥¹Ù•¹Ñ½Éä¤ì(€½¹ÍÐ•¹ÑÉ¥•Ì€ô¥¹Ù•¹Ñ½Éå¹ÑÉ¥•Ì¡¥¹Ù•¹Ñ½Éä¤ì(€½¹ÍÐ…Ñ…±½œ€ôÉÉ…ä¹¥ÍÉÉ…ä¡¥¹Ù•¹Ñ½Éä¤€˜˜¥¹Ù•¹Ñ½Éä¹Ñ½½±Ì€ü¥¹Ù•¹Ñ½Éä€èÕ¹‘•™¥¹•ì(€½¹ÍÐ‰å%€ô¹•Ü5…À ¤ì(€™½È€¡½¹ÍÐ•¹ÑÉä½˜•¹ÑÉ¥•Ì¤ì(€€€½¹ÍÐ¹½Éµ…±¥é•€ô¥¹Ù•¹Ñ½Éå5…¹¥™•ÍÐ¡•¹ÑÉä°…Ñ…±½œ¤ì(€€€¥˜€¡¹½Éµ…±¥é•€˜˜€…‰å%¹¡…Ì¡¹½Éµ…±¥é•¹¥¤¤‰å%¹Í•Ð¡¹½Éµ…±¥é•¹¥°¹½Éµ…±¥é•¤ì(€ô(€½¹ÍÐÑ½½±Ì€ôl¸¸¹‰å%¹Ù…±Õ•Ì ¥tì(€€¼¼9Õ±°µÁÉ½Ñ½ÑåÁ”µ…ÁÌÁÉ•Ù•¹Ð„ÕÍÑ½´…Á…‰¥±¥Ñä¹…µ•€‰}}ÁÉ½Ñ½}|ˆ™É½´(€€¼¼µÕÑ…Ñ¥¹œÑ¡”ÍÕµµ…Éä½‰©•ÐÌÁÉ½Ñ½ÑåÁ”¸(€½¹ÍÐ‰å…Ñ•½Éä€ô=‰©•Ð¹É•…Ñ”¡¹Õ±°¤ì(€½¹ÍÐ‰å…Á…‰¥±¥Ñä€ô=‰©•Ð¹É•…Ñ”¡¹Õ±°¤ì(€½¹ÍÐ½Õ¹ÑÌ€ôì…Ù…¥±…‰±”è€À°Õ¹…Ù…¥±…‰±”è€À°Õ¹­¹½Ý¸è€À°Ñ¥µ•‘=ÕÐè€Àôì(€™½È€¡½¹ÍÐÑ½½°½˜Ñ½½±Ì¤ì(€€€½¹ÍÐ…Ù…¥±…‰¥±¥Ñä€ôÑ½½°¹…Ù…¥±…‰¥±¥Ñäì(€€€¥˜€¡…Ù…¥±…‰¥±¥Ñä€ôôô€…Ù…¥±…‰±”œ¤½Õ¹ÑÌ¹…Ù…¥±…‰±”€¬ô€Äì(€€€•±Í”¥˜€¡…Ù…¥±…‰¥±¥Ñä€ôôô€Õ¹…Ù…¥±…‰±”œ¤½Õ¹ÑÌ¹Õ¹…Ù…¥±…‰±”€¬ô€Äì(€€€•±Í”¥˜€¡…Ù…¥±…‰¥±¥Ñä€ôôô€Ñ¥µ•µ½ÕÐœ¤ì½Õ¹ÑÌ¹Ñ¥µ•‘=ÕÐ€¬ô€Äì½Õ¹ÑÌ¹Õ¹…Ù…¥±…‰±”€¬ô€Äìô(€€€•±Í”½Õ¹ÑÌ¹Õ¹­¹½Ý¸€¬ô€Äì(€€€™½È€¡½¹ÍÐ…Ñ•½Éä½˜Ñ½½°¹…Ñ•½É¥•Ì¤‰å…Ñ•½Éåm…Ñ•½Éåt€ô€¡‰å…Ñ•½Éåm…Ñ•½Éåt€üü€À¤€¬€Äì(€€€™½È€¡½¹ÍÐ…Á…‰¥±¥Ñä½˜Ñ½½°¹…Á…‰¥±¥Ñ¥•Ì¤‰å…Á…‰¥±¥Ñåm…Á…‰¥±¥Ñåt€ô€¡‰å…Á…‰¥±¥Ñåm…Á…‰¥±¥Ñåt€üü€À¤€¬€Äì(€ô(€½¹ÍÐ±¥ÍÑ•€ôÑ½½±Ì¹µ…À ¡Ñ½½°¤€ôø€¡ì(€€€¥èÑ½½°¹¥°(€€€¹…µ”èÑ½½°¹¹…µ”°(€€€…Ù…¥±…‰¥±¥ÑäèÑ½½°¹…Ù…¥±…‰¥±¥Ñä°(€€€…Ù…¥±…‰±”èÑ½½°¹…Ù…¥±…‰±”°(€€€…Ñ•½É¥•Ìèl¸¸¹Ñ½½°¹…Ñ•½É¥•Ít°(€€€…Á…‰¥±¥Ñ¥•Ìèl¸¸¹Ñ½½°¹…Á…‰¥±¥Ñ¥•Ít°(€€€€¸¸¸¡Ñ½½°¹Ù•ÉÍ¥½¸€üìÙ•ÉÍ¥½¸èÑ½½°¹Ù•ÉÍ¥½¸ô€èíô¤°(€ô¤¤ì(€É•ÑÕÉ¸ì(€€€Ñ½Ñ…°èÑ½½±Ì¹±•¹Ñ °(€€€€¸¸¹½Õ¹ÑÌ°(€€€…Ù…¥±…‰±•%‘ÌèÑ½½±Ì¹™¥±Ñ•È ¡Ñ½½°¤€ôøÑ½½°¹…Ù…¥±…‰¥±¥Ñä€ôôô€…Ù…¥±…‰±”œ¤¹µ…À ¡Ñ½½°¤€ôøÑ½½°¹¥¤°(€€€Õ¹…Ù…¥±…‰±•%‘ÌèÑ½½±Ì¹™¥±Ñ•È ¡Ñ½½°¤€ôøÑ½½°¹…Ù…¥±…‰¥±¥Ñä€ôôô€Õ¹…Ù…¥±…‰±”œñðÑ½½°¹…Ù…¥±…‰¥±¥Ñä€ôôô€Ñ¥µ•µ½ÕÐœ¤¹µ…À ¡Ñ½½°¤€ôøÑ½½°¹¥¤°(€€€Õ¹­¹½Ý¹%‘ÌèÑ½½±Ì¹™¥±Ñ•È ¡Ñ½½°¤€ôøÑ½½°¹…Ù…¥±…‰¥±¥Ñä€ôôô€Õ¹­¹½Ý¸œ¤¹µ…À ¡Ñ½½°¤€ôøÑ½½°¹¥¤°(€€€‰å…Ñ•½Éä°(€€€‰å…Á…‰¥±¥Ñä°(€€€Ñ½½±Ìè±¥ÍÑ•°(€ôì)ô