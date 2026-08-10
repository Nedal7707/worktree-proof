/**
 * Explicit, local Codex/Claude handoff messages.
 *
 * This is a file-backed protocol, not a relay: WorktreeProof never launches an
 * assistant, polls a service, shares credentials, or executes a message.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeFileScope, normalizeLaneId } from './scope.js';
import { releaseLease, reserveLease } from './leases.js';

export const BRIDGE_MESSAGE_TYPES = Object.freeze(['task', 'status', 'result', 'question', 'cancel']);
export const BRIDGE_STATUSES = Object.freeze(['pending', 'claimed', 'completed', 'failed', 'cancelled']);
export const BRIDGE_MAX_MESSAGE_BYTES = 16 * 1024;
export const BRIDGE_MAX_MESSAGES = 1000;
export const BRIDGE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const BRIDGE_DEFAULT_CLAIM_MS = 30 * 60 * 1000;
export const BRIDGE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BRIDGE_MAX_CLAIM_MS = 24 * 60 * 60 * 1000;

const AGENT_ID = /^[a-z][a-z0-9._-]{0,31}$/u;
const MESSAGE_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SECRET = /(?:bearer\s+|-----BEGIN [^-]+ PRIVATE KEY-----|(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|auth|cookie|credential)\s*[:=]|\b(?:sk|gh[pousr]|xox[baprs])[-_][a-z0-9-]{12,})/iu;
const COMMAND_OR_NETWORK = /(?:https?:\/\/|\b(?:curl|wget|Invoke-WebRequest|powershell|pwsh|cmd(?:\.exe)?|node\s+-e|python\s+-c)\b|[;&|`]|\$\()/iu;

export class BridgeValidationError extends TypeError {
  constructor(message, code = 'ERR_INVALID_BRIDGE_MESSAGE') {
    super(message);
    this.name = 'BridgeValidationError';
    this.code = code;
  }
}

export class BridgeError extends Error {
  constructor(message, code = 'ERR_BRIDGE') {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function bridgeRoot(value) {
  const root = value?.bridgeRoot ?? value?.stateDir ?? value?.root ?? value;
  return path.resolve(typeof root === 'string' && root.trim() ? root : path.join(process.cwd(), '.worktree-proof', 'bridge'));
}

function requireSafeText(value, field, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new BridgeValidationError(`${field} must be a non-empty trimmed string`, 'ERR_INVALID_BRIDGE_FIELD');
  }
  if (value.length > max || CONTROL.test(value) || SECRET.test(value) || COMMAND_OR_NETWORK.test(value)) {
    throw new BridgeValidationError(`${field} contains unsafe content`, 'ERR_UNSAFE_BRIDGE_CONTENT');
  }
  return value;
}

export function normalizeAgentId(value, field = 'agent') {
  if (typeof value !== 'string') throw new BridgeValidationError(`${field} must be a string`, 'ERR_INVALID_AGENT_ID');
  const normalized = value.trim().toLowerCase();
  if (!AGENT_ID.test(normalized)) throw new BridgeValidationError(`${field} is not a safe agent iãž»¶‰žËkºwµçT¡±•…Í•A…Ñ °ì(€€€€€€€±…¹•%°(€€€€€€€™¥±•M½Á”èµ•ÍÍ…”¹™¥±•M½Á”°(€€€€€€€½Ý¹•ÈèÉ••¥Ù•È°(€€€€€€€Í•ÍÍ¥½¸è‰É¥‘”´‘íµ•ÍÍ…”¹µ•ÍÍ…•%¹Í±¥” À°€ÈÐ¥õ€°(€€€€€ô°ìÑÑ±5Ìè±…¥µ5Ìô¤ì(€€€ô(€€€É•ÑÕÉ¸ÝÉ¥Ñ•5•ÍÍ…”¡É½½Ð°ì€¸¸¹µ•ÍÍ…”°ÍÑ…ÑÕÌè€±…¥µ•œ°±…¥µ•‘	äèÉ••¥Ù•È°±…¥µ•‘Ðè¹½Ü¹Ñ½%M=MÑÉ¥¹œ ¤°É•±…¥µ•‘É½´èµ•ÍÍ…”¹É•±…¥µ•‘É½´ô¤ì(€ô¤ì)ô()•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸…­	É¥‘•5•ÍÍ…”¡É½½Ñ=É%¹ÁÕÐ°µ…å‰•%¹ÁÕÐ¤ì(€½¹ÍÐìÉ½½Ð°¥¹ÁÕÐô€ô¥¹ÁÕÑ¹‘I½½Ð¡É½½Ñ=É%¹ÁÕÐ°µ…å‰•%¹ÁÕÐ¤ì(€½¹ÍÐ…Ñ½È€ô¹½Éµ…±¥é••¹Ñ%¡¥¹ÁÕÐ¹…Ñ½È€üü¥¹ÁÕÐ¹Í•¹‘•È°€…Ñ½Èœ¤ì(€É•ÑÕÉ¸Ý¥Ñ¡	É¥‘•1½¬¡É½½Ð°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐµ•ÍÍ…”€ô…Ý…¥ÐÉ•…‘5•ÍÍ…”¡É½½Ð°¥¹ÁÕÐ¹µ•ÍÍ…•%¤ì(€€€¥˜€ …mµ•ÍÍ…”¹Í•¹‘•È°µ•ÍÍ…”¹É•¥Á¥•¹Ð°µ•ÍÍ…”¹±…¥µ•‘	åt¹™¥±Ñ•È¡	½½±•…¸¤¹¥¹±Õ‘•Ì¡…Ñ½È¤¤ì(€€€€€Ñ¡É½Ü¹•Ü	É¥‘•ÉÉ½È …­¹½Ý±•‘•µ•¹Ð…Ñ½È¥Ì¹½Ð„Á…ÉÑ¥¥Á…¹Ðœ°€II}	I%}=I	%8œ¤ì(€€€ô(€€€É•ÑÕÉ¸ÝÉ¥Ñ•5•ÍÍ…”¡É½½Ð°ì€¸¸¹µ•ÍÍ…”°…­Ðè¹•Ü…Ñ”¡¥¹ÁÕÐ¹¹½Ü€üü…Ñ”¹¹½Ü ¤¤¹Ñ½%M=MÑÉ¥¹œ ¤ô¤ì(€ô¤ì)ô((¼¨¨½µÁ±•Ñ”°™…¥°°½È…¹•°„±…¥µ•µ•ÍÍ…”Ý¥Ñ ‰½Õ¹‘••Ù¥‘•¹”½¹±ä¸€¨¼)•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸½µÁ±•Ñ•	É¥‘•5•ÍÍ…”¡É½½Ñ=É%¹ÁÕÐ°µ…å‰•%¹ÁÕÐ¤ì(€½¹ÍÐìÉ½½Ð°¥¹ÁÕÐô€ô¥¹ÁÕÑ¹‘I½½Ð¡É½½Ñ=É%¹ÁÕÐ°µ…å‰•%¹ÁÕÐ¤ì(€½¹ÍÐ…Ñ½È€ô¹½Éµ…±¥é••¹Ñ%¡¥¹ÁÕÐ¹…Ñ½È€üü¥¹ÁÕÐ¹Í•¹‘•È°€…Ñ½Èœ¤ì(€½¹ÍÐÍÑ…ÑÕÌ€ô¥¹ÁÕÐ¹ÍÑ…ÑÕÌ€üü€½µÁ±•Ñ•œì(€¥˜€ …l½µÁ±•Ñ•œ°€™…¥±•œ°€…¹•±±•t¹¥¹±Õ‘•Ì¡ÍÑ…ÑÕÌ¤¤Ñ¡É½Ü¹•Ü	É¥‘•Y…±¥‘…Ñ¥½¹ÉÉ½È ¥¹Ù…±¥Ñ•Éµ¥¹…°‰É¥‘”ÍÑ…ÑÕÌœ°€II}%9Y1%}	I%}MQQULœ¤ì(€É•ÑÕÉ¸Ý¥Ñ¡	É¥‘•1½¬¡É½½Ð°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐµ•ÍÍ…”€ô…Ý…¥ÐÉ•…‘5•ÍÍ…”¡É½½Ð°¥¹ÁÕÐ¹µ•ÍÍ…•%¤ì(€€€¥˜€¡µ•ÍÍ…”¹ÍÑ…ÑÕÌ€„ôô€±…¥µ•œñðµ•ÍÍ…”¹±…¥µ•‘	ä€„ôô…Ñ½È¤Ñ¡É½Ü¹•Ü	É¥‘•ÉÉ½È ½¹±äÑ¡”ÕÉÉ•¹Ð±…¥µ…¹Ðµ…ä½µÁ±•Ñ”„µ•ÍÍ…”œ°€II}	I%}=I	%8œ¤ì(€€€½¹ÍÐ½µÁ±•Ñ•€ô…Ý…¥ÐÝÉ¥Ñ•5•ÍÍ…”¡É½½Ð°ì(€€€€€€¸¸¹µ•ÍÍ…”°(€€€€€ÍÑ…ÑÕÌ°(€€€€€½µÁ±•Ñ•‘Ðè¹•Ü…Ñ”¡¥¹ÁÕÐ¹¹½Ü€üü…Ñ”¹¹½Ü ¤¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€€€€€É•ÍÕ±Ðè¥¹ÁÕÐ¹É•ÍÕ±Ð°(€€€ô¤ì(€€€¥˜€¡µ•ÍÍ…”¹™¥±•M½Á”¤ì(€€€€€½¹ÍÐ±•…Í•A…Ñ €ôÁ…Ñ ¹©½¥¸¡Á…Ñ ¹‘¥É¹…µ”¡É½½Ð¤°€±•…Í•Ì¹©Í½¸œ¤ì(€€€€€½¹ÍÐ±…¹•%€ôµ•ÍÍ…”¹±…¹•%€üü‰É¥‘”´‘íµ•ÍÍ…”¹µ•ÍÍ…•%¹Í±¥” À°€ÈÀ¥õ€ì(€€€€€…Ý…¥ÐÉ•±•…Í•1•…Í”¡±•…Í•A…Ñ °ì(€€€€€€€±…¹•%°(€€€€€€€½Ý¹•Èè…Ñ½È°(€€€€€€€Í•ÍÍ¥½¸è‰É¥‘”´‘íµ•ÍÍ…”¹µ•ÍÍ…•%¹Í±¥” À°€ÈÐ¥õ€°(€€€€€€€É•…Í½¸è‰É¥‘”€‘íÍÑ…ÑÕÍõ€°(€€€€€ô¤¹…Ñ  ¡•ÉÉ½È¤€ôøì(€€€€€€€¥˜€¡•ÉÉ½Èü¹½‘”€„ôô€II}1M}9=Q}=U9œ¤Ñ¡É½Ü•ÉÉ½Èì(€€€€€ô¤ì(€€€ô(€€€É•ÑÕÉ¸½µÁ±•Ñ•ì(€ô¤ì)ô()•áÁ½ÉÐ½¹ÍÐÍ•¹‘5•ÍÍ…”€ôÍ•¹‘	É¥‘•5•ÍÍ…”ì)•áÁ½ÉÐ½¹ÍÐ¥¹‰½à€ô±¥ÍÑ	É¥‘•%¹‰½àì)•áÁ½ÉÐ½¹ÍÐ±…¥µ5•ÍÍ…”€ô±…¥µ	É¥‘•5•ÍÍ…”ì)•áÁ½ÉÐ½¹ÍÐ…­5•ÍÍ…”€ô…­	É¥‘•5•ÍÍ…”ì)•áÁ½ÉÐ½¹ÍÐ½µÁ±•Ñ•5•ÍÍ…”€ô½µÁ±•Ñ•	É¥‘•5•ÍÍ…”ì()•áÁ½ÉÐ‘•™…Õ±Ðì(€	I%}5MM}QeAL°(€	I%}MQQUML°(€	I%}5a}5MM}	eQL°(€	I%}5a}5MML°(€	I%}U1Q}QQ1}5L°(€	I%}U1Q}1%5}5L°(€	I%}5a}QQ1}5L°(€	I%}5a}1%5}5L°(€Ù…±¥‘…Ñ•	É¥‘•5•ÍÍ…”°(€Í•¹‘	É¥‘•5•ÍÍ…”°(€±¥ÍÑ	É¥‘•%¹‰½à°(€±…¥µ	É¥‘•5•ÍÍ…”°(€…­	É¥‘•5•ÍÍ…”°(€½µÁ±•Ñ•	É¥‘•5•ÍÍ…”°)ôì(