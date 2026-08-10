import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';

import { normalizeLane, normalizeLanes, normalizeLaneId, normalizeFileScope, scopesOverlap } from './scope.js';

const REGISTRY_VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_ATTEMPTS = 40;
const DEFAULT_LOCK_DELAY_MS = 10;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export class LeaseError extends Error {
  constructor(message, code = 'ERR_LEASE') {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
  }
}

export class RegistryStateError extends LeaseError {
  constructor(message, code = 'ERR_MALFORMED_REGISTRY') {
    super(message, code);
    this.name = 'RegistryStateError';
  }
}

function currentTime(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  if (!Number.isFinite(value) || value < 0) {
    throw new LeaseError('clock must return a non-negative finite millisecond timestamp', 'ERR_INVALID_CLOCK');
  }
  return Math.trunc(value);
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value || CONTROL_CHARS.test(value)) {
    throw new RegistryStateError(`${label} must be an ISO timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new RegistryStateError(`${label} must be a canonical ISO timestamp`);
  }
  return ms;
}

function token(value, label, { normalize = true } = {}) {
  if (typeof value !== 'string') {
    throw new LeaseError(`${label} must be a string`, 'ERR_INVALID_LEASE_INPUT');
  }
  const result = normalize ? value.normalize('NFC').trim() : value;
  if (!result || CONTROL_CHARS.test(result)) {
    throw new LeaseError(`${label} must be non-empty and contain no control characters`, 'ERR_INVALID_LEASE_INPUT');
  }
  return result;
}

function stateSkeleton() {
  return { version: REGISTRY_VERSION, leases: [] };
}

function registryToken(value, label) {
  try {
    return token(value, label, { normalize: false });
  } catch (error) {
    throw new RegistryStateError(error.message, 'ERR_MALFORMED_REGISTRY');
  }
}

function registryLaneId(value, label) {
  try {
    return normalizeLaneId(value);
  } catch (error) {
    throw new RegistryStateError(`${label} is invalid: ${error.message}`, 'ERR_MALFORMED_REGISTRY');
  }
}

function registryFileScope(value, label) {
  try {
    return normalizeFileScope(value);
  } catch (error) {
    throw new RegistryStateError(`${label} is invalid: ${error.message}`, 'ERR_MALFORMED_REGISTRY');
  }
}

function validateLeaseEntry(entry, index, now) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new RegistryStateError(`registry lease ${index} must be an object`);
  }
  const leaseId = registryToken(entry.leaseId, `registry lease ${index}.leaseId`);
  const laneId = registryLaneId(entry.laneId, `registry leaseßow¶‰žËkºwµçM•ÉÉ½È¡±…¹”€‘í)M=8¹ÍÑÉ¥¹¥™ä¡±•…Í”¹±…¹•%¥ô…±É•…‘ä¡…Ì…¸…Ñ¥Ù”±•…Í•€°€II}1M}=91%Pœ¤ì(€€€€€€€ô(€€€€€€€¥˜€¡Í½Á•Í=Ù•É±…À¡•á¥ÍÑ¥¹œ¹™¥±•M½Á”°±•…Í”¹™¥±•M½Á”¤¤ì(€€€€€€€€€Ñ¡É½Ü¹•Ü1•…Í•ÉÉ½È (€€€€€€€€€€€™¥±•M½Á”€‘í)M=8¹ÍÑÉ¥¹¥™ä¡±•…Í”¹™¥±•M½Á”¥ô½Ù•É±…ÁÌ…Ñ¥Ù”±•…Í”€‘í)M=8¹ÍÑÉ¥¹¥™ä¡•á¥ÍÑ¥¹œ¹™¥±•M½Á”¥õ€°(€€€€€€€€€€€€II}1M}=91%Pœ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€ô(€€€€€½¹ÍÐ¹•áÐ€ôì€¸¸¹ÍÑ…Ñ”°±•…Í•Ìèl¸¸¹ÍÑ…Ñ”¹±•…Í•Ì°±•…Í•tôì(€€€€€…Ý…¥ÐÝÉ¥Ñ•I•¥ÍÑÉå¥±”¡Ñ¡¥Ì¹É•¥ÍÑÉåA…Ñ °¹•áÐ¤ì(€€€€€É•ÑÕÉ¸±•…Í”ì(€€€ô°Ñ¡¥Ì¹±½­=ÁÑ¥½¹Ì¤ì(€ô((€…Íå¹ŒÉ•±•…Í”¡Í•±•Ñ½È¤ì(€€€É•ÑÕÉ¸Ý¥Ñ¡I•¥ÍÑÉå1½¬¡Ñ¡¥Ì¹É•¥ÍÑÉåA…Ñ °…Íå¹Œ€ ¤€ôøì(€€€€€½¹ÍÐ¹½Ü€ôÕÉÉ•¹ÑQ¥µ”¡Ñ¡¥Ì¹±½¬¤ì(€€€€€½¹ÍÐÍÑ…Ñ”€ô…Ý…¥ÐÉ•…‘I•¥ÍÑÉå¥±”¡Ñ¡¥Ì¹É•¥ÍÑÉåA…Ñ °¹½Ü¤ì(€€€€€½¹ÍÐÅÕ•Éä€ôÑåÁ•½˜Í•±•Ñ½È€ôôô€ÍÑÉ¥¹œœ€üì±•…Í•%èÍ•±•Ñ½Èô€èÍ•±•Ñ½Èì(€€€€€¥˜€ …ÅÕ•ÉäñðÑåÁ•½˜ÅÕ•Éä€„ôô€½‰©•ÐœñðÉÉ…ä¹¥ÍÉÉ…ä¡ÅÕ•Éä¤¤ì(€€€€€€€Ñ¡É½Ü¹•Ü1•…Í•ÉÉ½È É•±•…Í”Í•±•Ñ½ÈµÕÍÐ‰”„±•…Í•%½È½‰©•Ðœ°€II}%9Y1%}I1Mœ¤ì(€€€€€ô(€€€€€½¹ÍÐµ…Ñ¡•Ì€ôÍÑ…Ñ”¹±•…Í•Ì¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø€ (€€€€€€€•¹ÑÉä¹ÍÑ…ÑÕÌ€ôôô€…Ñ¥Ù”œ(€€€€€€€€˜˜€¡ÅÕ•Éä¹±•…Í•%€ôôôÕ¹‘•™¥¹•ñð•¹ÑÉä¹±•…Í•%€ôôôÅÕ•Éä¹±•…Í•%¤(€€€€€€€€˜˜€¡ÅÕ•Éä¹±…¹•%€ôôôÕ¹‘•™¥¹•ñð•¹ÑÉä¹±…¹•%€ôôôÅÕ•Éä¹±…¹•%¤(€€€€€€¤¤ì(€€€€€¥˜€¡µ…Ñ¡•Ì¹±•¹Ñ €ôôô€À¤ì(€€€€€€€Ñ¡É½Ü¹•Ü1•…Í•ÉÉ½È …Ñ¥Ù”±•…Í”Ý…Ì¹½Ð™½Õ¹œ°€II}1M}9=Q}=U9œ¤ì(€€€€€ô(€€€€€¥˜€¡µ…Ñ¡•Ì¹±•¹Ñ €ø€Ä¤ì(€€€€€€€Ñ¡É½Ü¹•Ü1•…Í•ÉÉ½È É•±•…Í”Í•±•Ñ½È¥Ì…µ‰¥Õ½ÕÌœ°€II}I1M}5	%U=ULœ¤ì(€€€€€ô(€€€€€½¹ÍÐÑ…É•Ð€ôµ…Ñ¡•ÍlÁtì(€€€€€™½È€¡½¹ÍÐ™¥•±½˜l½Ý¹•Èœ°€Í•ÍÍ¥½¸t¤ì(€€€€€€€¥˜€¡ÅÕ•Éåm™¥•±‘t€„ôôÕ¹‘•™¥¹•€˜˜ÅÕ•Éåm™¥•±‘t€„ôôÑ…É•Ñm™¥•±‘t¤ì(€€€€€€€€€Ñ¡É½Ü¹•Ü1•…Í•ÉÉ½È¡É•±•…Í”€‘í™¥•±‘ô‘½•Ì¹½Ðµ…Ñ ±•…Í”½Ý¹•É€°€II}I1M}=I	%8œ¤ì(€€€€€€€ô(€€€€€ô(€€€€€±•ÐÉ•…Í½¸ì(€€€€€¥˜€¡ÅÕ•Éä¹É•…Í½¸€„ôôÕ¹‘•™¥¹•¤ì(€€€€€€€¥˜€¡ÑåÁ•½˜ÅÕ•Éä¹É•…Í½¸€„ôô€ÍÑÉ¥¹œœñð€…ÅÕ•Éä¹É•…Í½¸¹ÑÉ¥´ ¤ñðÅÕ•Éä¹É•…Í½¸€„ôôÅÕ•Éä¹É•…Í½¸¹ÑÉ¥´ ¤¤ì(€€€€€€€€€Ñ¡É½Ü¹•Ü1•…Í•ÉÉ½È É•±•…Í”É•…Í½¸µÕÍÐ‰”„¹½¸µ•µÁÑäÑÉ¥µµ•ÍÑÉ¥¹œœ°€II}%9Y1%}I1Mœ¤ì(€€€€€€€ô(€€€€€€€É•…Í½¸€ôÅÕ•Éä¹É•…Í½¸ì(€€€€€ô(€€€€€½¹ÍÐÉ•±•…Í•‘Ð€ô¹•Ü…Ñ”¡¹½Ü¤¹Ñ½%M=MÑÉ¥¹œ ¤ì(€€€€€½¹ÍÐÉ•±•…Í•€ôì(€€€€€€€€¸¸¹Ñ…É•Ð°(€€€€€€€ÍÑ…ÑÕÌè€É•±•…Í•œ°(€€€€€€€…Ñ¥Ù”è™…±Í”°(€€€€€€€É•±•…Í•‘Ð°(€€€€€€€ÕÁ‘…Ñ•‘ÐèÉ•±•…Í•‘Ð°(€€€€€€€€¸¸¸¡É•…Í½¸€ôôôÕ¹‘•™¥¹•€üíô€èìÉ•…Í½¸ô¤°(€€€€€ôì(€€€€€½¹ÍÐ¹•áÐ€ôì(€€€€€€€€¸¸¹ÍÑ…Ñ”°(€€€€€€€±•…Í•ÌèÍÑ…Ñ”¹±•…Í•Ì¹µ…À ¡•¹ÑÉä¤€ôø•¹ÑÉä¹±•…Í•%€ôôôÑ…É•Ð¹±•…Í•%€üÉ•±•…Í•€è•¹ÑÉä¤°(€€€€€ôì(€€€€€…Ý…¥ÐÝÉ¥Ñ•I•¥ÍÑÉå¥±”¡Ñ¡¥Ì¹É•¥ÍÑÉåA…Ñ °¹•áÐ¤ì(€€€€€É•ÑÕÉ¸É•±•…Í•ì(€€€ô°Ñ¡¥Ì¹±½­=ÁÑ¥½¹Ì¤ì(€ô)ô()•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸É•Í•ÉÙ•1•…Í”¡É•¥ÍÑÉåA…Ñ °¥¹ÁÕÐ°½ÁÑ¥½¹Ì€ôíô¤ì(€É•ÑÕÉ¸¹•Ü1•…Í•I•¥ÍÑÉä¡É•¥ÍÑÉåA…Ñ °½ÁÑ¥½¹Ì¤¹É•Í•ÉÙ”¡¥¹ÁÕÐ¤ì)ô()•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸É•±•…Í•1•…Í”¡É•¥ÍÑÉåA…Ñ °Í•±•Ñ½È°½ÁÑ¥½¹Ì€ôíô¤ì(€É•ÑÕÉ¸¹•Ü1•…Í•I•¥ÍÑÉä¡É•¥ÍÑÉåA…Ñ °½ÁÑ¥½¹Ì¤¹É•±•…Í”¡Í•±•Ñ½È¤ì)ô()•áÁ½ÉÐ½¹ÍÐÉ•¥ÍÑÉåY•ÉÍ¥½¸€ôI%MQIe}YIM%=8ì