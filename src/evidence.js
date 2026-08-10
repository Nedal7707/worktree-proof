import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { normalizeLaneId } from './scope.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const MAX_DEPTH = 128;

export class EvidenceValidationError extends TypeError {
  constructor(message, code = 'ERR_INVALID_CLOSURE_RECEIPT') {
    super(message);
    this.name = 'EvidenceValidationError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Return whether a value can be represented without loss as strict JSON. */
export function isJsonSafe(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    // JSON.stringify escapes control characters in strings, so they remain
    // JSON-safe even though identity fields below deliberately reject them.
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let safe = false;
  if (Array.isArray(value)) {
    safe = true;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || !isJsonSafe(value[index], seen, depth + 1)) {
        safe = false;
        break;
      }
    }
  } else if (isPlainObject(value)) {
    safe = true;
    for (const key of Object.keys(value)) {
      if (!isJsonSafe(value[key], seen, depth + 1)) {
        safe = false;
        break;
      }
    }
  }
  seen.delete(value);
  return safe;
}

function cloneJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = cloneJson(item);
  return output;
}

function requiredText(receipt, field) {
  if (typeof receipt[field] !== 'string' || !receipt[field].trim() || receipt[field] !== receipt[field].trim()) {
    throw new EvidenceValidationError(`${field} must be a non-empty trimmed string`, 'ERR_INVALID_CLOSURE_FIELD');
  }
  if (CONTROL_CHARS.test(receipt[field])) {
    throw new EvidenceValidationError(`${field} contains a control character`, 'ERR_INVALID_CLOSURE_FIELD');
  }
}

function outcomeOf(receipt) {
  const outcome = receipt.outcome;
  const status = receipt.status;
  if (outcome !== undefined && status !== undefined && outcome !== status) {
    throw new EvidenceValidationError('outcome and status disagree', 'ERR_CONFLICTING_OUTCOME');
  }
  const value = outcome ?? status;
  if (value !== 'merged' && value !== 'abandoned') {
    throw new EvidenceValidationError('outcome must be "merged" or "abandoned"', 'ERR_INVALID_×Mz¶‰žËkºwµç`œ¤ì(€ô(€½¹ÍÐ¹½Éµ…±¥é•€ôÙ…±¥‘…Ñ•±½ÍÕÉ•I••¥ÁÐ¡É••¥ÁÐ¤ì(€½¹ÍÐ‘•ÍÑ¥¹…Ñ¥½¸€ôÉ•Í½±Ù”¡™¥±•A…Ñ ¤ì(€½¹ÍÐÁ…É•¹Ð€ô‘¥É¹…µ”¡‘•ÍÑ¥¹…Ñ¥½¸¤ì(€…Ý…¥Ðµ­‘¥È¡Á…É•¹Ð°ìÉ•ÕÉÍ¥Ù”èÑÉÕ”ô¤ì(€½¹ÍÐÑ•µÁ½É…Éä€ô€‘í‘•ÍÑ¥¹…Ñ¥½¹ô¸‘íÁÉ½•ÍÌ¹Á¥‘ô¸‘í…Ñ”¹¹½Ü ¥ô¹ÑµÁ€ì(€½¹ÍÐÑ•áÐ€ô€‘í)M=8¹ÍÑÉ¥¹¥™ä¡¹½Éµ…±¥é•°¹Õ±°°€È¥õq¹€ì(€ÑÉäì(€€€…Ý…¥ÐÝÉ¥Ñ•¥±”¡Ñ•µÁ½É…Éä°Ñ•áÐ°ì•¹½‘¥¹œè€ÕÑ˜àœ°™±…œè€Ýàœô¤ì(€€€…Ý…¥ÐÉ•¹…µ”¡Ñ•µÁ½É…Éä°‘•ÍÑ¥¹…Ñ¥½¸¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€…Ý…¥ÐÉ´¡Ñ•µÁ½É…Éä°ì™½É”èÑÉÕ”ô¤¹…Ñ   ¤€ôøíô¤ì(€€€½¹ÍÐÝÉ…ÁÁ•€ô¹•ÜÙ¥‘•¹•Y…±¥‘…Ñ¥½¹ÉÉ½È¡Õ¹…‰±”Ñ¼ÝÉ¥Ñ”±½ÍÕÉ”É••¥ÁÐè€‘í•ÉÉ½È¹µ•ÍÍ…•õ€°€II}1=MUI}]I%Qœ¤ì(€€€ÝÉ…ÁÁ•¹…ÕÍ”€ô•ÉÉ½Èì(€€€Ñ¡É½ÜÝÉ…ÁÁ•ì(€ô(€É•ÑÕÉ¸ìÁ…Ñ è‘•ÍÑ¥¹…Ñ¥½¸°É••¥ÁÐè¹½Éµ…±¥é•°ÝÉ¥ÑÑ•¸èÑÉÕ”°É•Á±…•è½ÁÑ¥½¹Ì¹É•Á±…”€„ôô™…±Í”ôì)ô((¼¨¨(€¨±½Í”½¹”±…¹”™É½´„Ù…±¥‘…Ñ•É••¥ÁÐ¸€Q¡”Á…å±½…Í¡…Á”µ¥ÉÉ½ÉÌÑ¡”1$(€¨½µµ…¹…‘…ÁÑ•È…¹¥Ì‘•±¥‰•É…Ñ•±ä•áÁ±¥¥Ð…‰½ÕÐÑ¡”É•Á½Í¥Ñ½Éä…¹(€¨±½ÍÕÉ”ÍÑ½É”¸€µ¥ÍÍ¥¹œÉ••¥ÁÐ¥Ì…¸•ÉÉ½Èè„±½Í”½Á•É…Ñ¥½¸µÕÍÐ¹•Ù•È(€¨¥¹Ù•¹ÐÑ•Éµ¥¹…°•Ù¥‘•¹”¸(€¨¼)•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸±½Í•1…¹”¡Á…å±½…€ôíô¤ì(€¥˜€ …Á…å±½…ñðÑåÁ•½˜Á…å±½…€„ôô€½‰©•ÐœñðÉÉ…ä¹¥ÍÉÉ…ä¡Á…å±½…¤¤ì(€€€Ñ¡É½Ü¹•ÜÙ¥‘•¹•Y…±¥‘…Ñ¥½¹ÉÉ½È ±½Í”Á…å±½…µÕÍÐ‰”…¸½‰©•Ðœ°€II}%9Y1%}1=M}Ae1=œ¤ì(€ô(€½¹ÍÐÉ••¥ÁÐ€ôÁ…å±½…¹É••¥ÁÐì(€¥˜€ …É••¥ÁÐñðÑåÁ•½˜É••¥ÁÐ€„ôô€½‰©•ÐœñðÉÉ…ä¹¥ÍÉÉ…ä¡É••¥ÁÐ¤¤ì(€€€Ñ¡É½Ü¹•ÜÙ¥‘•¹•Y…±¥‘…Ñ¥½¹ÉÉ½È ±½Í”É•ÅÕ¥É•Ì„)M=8É••¥ÁÐœ°€II}5%MM%9}1=MUI}I%APœ¤ì(€ô(€½¹ÍÐ¹½Éµ…±¥é•€ôÙ…±¥‘…Ñ•±½ÍÕÉ•I••¥ÁÐ¡É••¥ÁÐ¤ì(€¥˜€¡ÑåÁ•½˜¹½Éµ…±¥é•¹±…¹•%€„ôô€ÍÑÉ¥¹œœñð€…¹½Éµ…±¥é•¹±…¹•%¹ÑÉ¥´ ¤¤ì(€€€Ñ¡É½Ü¹•ÜÙ¥‘•¹•Y…±¥‘…Ñ¥½¹ÉÉ½È ±½ÍÕÉ”É••¥ÁÐÉ•ÅÕ¥É•Ì±…¹•%œ°€II}%9Y1%}1=MUI}%1œ¤ì(€ô(€¥˜€¡ÑåÁ•½˜¹½Éµ…±¥é•¹±½Í•‘Ð€„ôô€ÍÑÉ¥¹œœñð€…¹½Éµ…±¥é•¹±½Í•‘Ð¹ÑÉ¥´ ¤¤ì(€€€Ñ¡É½Ü¹•ÜÙ¥‘•¹•Y…±¥‘…Ñ¥½¹ÉÉ½È ±½ÍÕÉ”É••¥ÁÐÉ•ÅÕ¥É•Ì±½Í•‘Ðœ°€II}%9Y1%}1=MUI}%1œ¤ì(€ô(€±•Ð±…¹•%ì(€ÑÉäì(€€€±…¹•%€ô¹½Éµ…±¥é•1…¹•%¡¹½Éµ…±¥é•¹±…¹•%¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€½¹ÍÐÝÉ…ÁÁ•€ô¹•ÜÙ¥‘•¹•Y…±¥‘…Ñ¥½¹ÉÉ½È¡¥¹Ù…±¥±½ÍÕÉ”±…¹•%è€‘í•ÉÉ½È¹µ•ÍÍ…•õ€°€II}%9Y1%}1=MUI}%1œ¤ì(€€€ÝÉ…ÁÁ•¹…ÕÍ”€ô•ÉÉ½Èì(€€€Ñ¡É½ÜÝÉ…ÁÁ•ì(€ô((€½¹ÍÐ½¹™¥œ€ôÁ…å±½…¹½¹™¥œ€˜˜ÑåÁ•½˜Á…å±½…¹½¹™¥œ€ôôô€½‰©•Ðœ€üÁ…å±½…¹½¹™¥œ€èíôì(€½¹ÍÐ½ÁÑ¥½¹Ì€ôÁ…å±½…¹½ÁÑ¥½¹Ì€˜˜ÑåÁ•½˜Á…å±½…¹½ÁÑ¥½¹Ì€ôôô€½‰©•Ðœ€üÁ…å±½…¹½ÁÑ¥½¹Ì€èíôì(€½¹ÍÐÉ•Á½Í¥Ñ½Éä€ôÑåÁ•½˜Á…å±½…¹É•Á¼€ôôô€ÍÑÉ¥¹œœ€˜˜Á…å±½…¹É•Á¼¹ÑÉ¥´ ¤€üÁ…å±½…¹É•Á¼€èÁÉ½•ÍÌ¹Ý ¤ì(€½¹ÍÐÍÑ½É”€ô½ÁÑ¥½¹Ì¹±½ÍÕÉ•MÑ½É”€üü½¹™¥œ¹±½ÍÕÉ•MÑ½É”€üü€œ¹Ý½É­ÑÉ•”µÁÉ½½˜½±½ÍÕÉ•Ìœì(€½¹ÍÐÍÑ½É•A…Ñ €ôÉ•Í½±Ù”¡É•Á½Í¥Ñ½Éä°ÍÑ½É”¤ì(€½¹ÍÐ‘•ÍÑ¥¹…Ñ¥½¸€ô½ÁÑ¥½¹Ì¹½ÕÑÁÕÐ(€€€€üÉ•Í½±Ù”¡É•Á½Í¥Ñ½Éä°½ÁÑ¥½¹Ì¹½ÕÑÁÕÐ¤(€€€€è€‘íÍÑ½É•A…Ñ¡ô¼‘í±…¹•%‘ô¹©Í½¹€ì(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÝÉ¥Ñ•±½ÍÕÉ•I••¥ÁÐ¡‘•ÍÑ¥¹…Ñ¥½¸°ì€¸¸¹¹½Éµ…±¥é•°±…¹•%ô°ìÉ•Á±…”èÑÉÕ”ô¤ì(€É•ÑÕÉ¸ì(€€€±½Í•èÑÉÕ”°(€€€±…¹•%°(€€€½ÕÑ½µ”èÉ•ÍÕ±Ð¹É••¥ÁÐ¹½ÕÑ½µ”°(€€€Á…Ñ èÉ•ÍÕ±Ð¹Á…Ñ °(€€€É••¥ÁÐèÉ•ÍÕ±Ð¹É••¥ÁÐ°(€ôì)ô(