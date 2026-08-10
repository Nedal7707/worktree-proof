import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAdapter, normalizeAdapterTarget } from './adapters.js';

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
const SECRET_VALUE_RE = /-----BEGIN [^-]+ PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{1,}|(?:^|\n)\s*[A-Za-z][A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|COOKIE|CREDENTIAL)[A-Za-z0-9_.-]*\s*[:=]\s*[^\s#]+/i;

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
    if (!canonicalInfo.isDirectory()) throw new InitSafetyError(`repository is not a directory: ${candidateëÍ5¶‰žËkºwµçYÉ••é”¡ÁÉ½©•Ð¤°(€€€ÝÉ¥Ñ•Ìè=‰©•Ð¹™É••é”¡ÝÉ¥Ñ•Ì¤°(€€€Ý…É¹¥¹Ìè=‰©•Ð¹™É••é”¡Í½ÉÑ•‘U¹¥ÅÕ”¡Ý…É¹¥¹Ì¤¤°(€€€‘ÉåIÕ¸èÑÉÕ”°(€ô¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸½¹™¥ÉµáÁ±¥¥Ñ±ä¡½¹™¥É´°Á±…¸¤ì(€¥˜€¡½¹™¥É´€ôôôÑÉÕ”¤É•ÑÕÉ¸ÑÉÕ”ì(€¥˜€¡ÑåÁ•½˜½¹™¥É´€ôôô€™Õ¹Ñ¥½¸œ¤ì(€€€ÑÉäì(€€€€€É•ÑÕÉ¸€¡…Ý…¥Ð½¹™¥É´¡Á±…¸¤¤€ôôôÑÉÕ”ì(€€€ô…Ñ ì(€€€€€É•ÑÕÉ¸™…±Í”ì(€€€ô(€ô(€É•ÑÕÉ¸™…±Í”ì)ô((¼¨¨ÁÁ±ä„É•…Ñ”µ½¹±äÁ±…¸¸€ÉäµÉÕ¸¥ÌÑ¡”‘•™…Õ±Ð…¹•áÁ±¥¥Ð½¹™¥Éµ…Ñ¥½¸¥Ìµ…¹‘…Ñ½Éä¸€¨¼)•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸…ÁÁ±å%¹¥ÑA±…¸¡Á±…¸°½ÁÑ¥½¹Ì€ôíô¤ì(€¥˜€ …¥Í=‰©•Ð¡½ÁÑ¥½¹Ì¤¤Ñ¡É½Ü¹•Ü%¹¥ÑM…™•ÑåÉÉ½È …ÁÁ±ä½ÁÑ¥½¹ÌµÕÍÐ‰”…¸½‰©•Ðœ°€II}%9Y1%}=AQ%=9Lœ¤ì(€½¹ÍÐ‘ÉåIÕ¸€ô½ÁÑ¥½¹Ì¹‘ÉåIÕ¸€„ôôÕ¹‘•™¥¹•€ü½ÁÑ¥½¹Ì¹‘ÉåIÕ¸€„ôô™…±Í”€èÁ±…¸ü¹‘ÉåIÕ¸€„ôô™…±Í”ì(€¥˜€¡‘ÉåIÕ¸€„ôôÑÉÕ”€˜˜‘ÉåIÕ¸€„ôô™…±Í”¤Ñ¡É½Ü¹•Ü%¹¥ÑM…™•ÑåÉÉ½È ‘ÉåIÕ¸µÕÍÐ‰”‰½½±•…¸œ°€II}%9Y1%}=AQ%=9Lœ¤ì(€¥˜€ …‘ÉåIÕ¸€˜˜€„¡…Ý…¥Ð½¹™¥ÉµáÁ±¥¥Ñ±ä¡½ÁÑ¥½¹Ì¹½¹™¥É´°Á±…¸¤¤¤ì(€€€Ñ¡É½Ü¹•Ü%¹¥ÑM…™•ÑåÉÉ½È •áÁ±¥¥Ð½¹™¥Éµ…Ñ¥½¸¥ÌÉ•ÅÕ¥É•‰•™½É”ÝÉ¥Ñ¥¹œœ°€II}=9%I5}IEU%Iœ¤ì(€ô(€½¹ÍÐÙ…±¥‘…Ñ•€ô…Ý…¥ÐÙ…±¥‘…Ñ•A±…¸¡Á±…¸¤ì(€½¹ÍÐÁ±…¹¹•€ôÙ…±¥‘…Ñ•¹ÝÉ¥Ñ•Ì¹µ…À ¡ÝÉ¥Ñ”¤€ôøÝÉ¥Ñ”¹Á…Ñ ¤ì(€¥˜€¡‘ÉåIÕ¸¤ì(€€€É•ÑÕÉ¸=‰©•Ð¹™É••é”¡ì(€€€€€½¬èÑÉÕ”°(€€€€€‘ÉåIÕ¸èÑÉÕ”°(€€€€€Á±…¹¹•è=‰©•Ð¹™É••é”¡Á±…¹¹•¤°(€€€€€ÝÉ¥Ñ•Ìè=‰©•Ð¹™É••é”¡Á±…¹¹•¤°(€€€€€ÝÉ¥ÑÑ•¸è=‰©•Ð¹™É••é”¡mt¤°(€€€ô¤ì(€ô((€½¹ÍÐÝÉ¥ÑÑ•¸€ômtì(€ÑÉäì(€€€€¼¼±°½±±¥Í¥½¸½Íåµ±¥¹¬¡•­Ì½µÁ±•Ñ•‰•™½É”Ñ¡”™¥ÉÍÐµÕÑ…Ñ¥½¸¸(€€€™½È€¡½¹ÍÐÝÉ¥Ñ”½˜Ù…±¥‘…Ñ•¹ÝÉ¥Ñ•Ì¤ì(€€€€€…Ý…¥Ðµ­‘¥È¡ÝÉ¥Ñ”¹Á…É•¹Ð°ìÉ•ÕÉÍ¥Ù”èÑÉÕ”ô¤ì(€€€€€½¹ÍÐÑ•µÁA…Ñ €ôÁ…Ñ ¹©½¥¸¡ÝÉ¥Ñ”¹Á…É•¹Ð°€¸‘íÁ…Ñ ¹‰…Í•¹…µ”¡ÝÉ¥Ñ”¹…‰Í½±ÕÑ•A…Ñ ¥ô¹Ý½É­ÑÉ•”µÁÉ½½˜´‘íÉ…¹‘½µUU% ¥ô¹ÑµÁ€¤ì(€€€€€±•Ð¡…¹‘±”ì(€€€€€ÑÉäì(€€€€€€€¡…¹‘±”€ô…Ý…¥Ð½Á•¸¡Ñ•µÁA…Ñ °€Ýàœ°€Á¼ØÐÐ¤ì(€€€€€€€…Ý…¥Ð¡…¹‘±”¹ÝÉ¥Ñ•¥±”¡ÝÉ¥Ñ”¹½¹Ñ•¹Ð°€ÕÑ˜àœ¤ì(€€€€€€€…Ý…¥Ð¡…¹‘±”¹Íå¹Œ ¤ì(€€€€€€€…Ý…¥Ð¡…¹‘±”¹±½Í” ¤ì(€€€€€€€¡…¹‘±”€ôÕ¹‘•™¥¹•ì(€€€€€€€€¼¼Q¡”Ñ…É•ÐÝ…ÌÁÉ½Ù•¸…‰Í•¹Ð¥¸ÁÉ•™±¥¡Ð¸€½¹ÕÉÉ•¹ÐÉ•…Ñ½È¥Ì(€€€€€€€€¼¼ÑÉ•…Ñ•…Ì„½±±¥Í¥½¸É…Ñ¡•ÈÑ¡…¸‰•¥¹œ½Ù•ÉÝÉ¥ÑÑ•¸¸(€€€€€€€ÑÉäì(€€€€€€€€€…Ý…¥Ð…•ÍÌ¡ÝÉ¥Ñ”¹…‰Í½±ÕÑ•A…Ñ ¤ì(€€€€€€€€€Ñ¡É½Ü¹•Ü%¹¥ÑM…™•ÑåÉÉ½È¡É•™ÕÍ¥¹œÑ¼½Ù•ÉÝÉ¥Ñ”•á¥ÍÑ¥¹œÁ…Ñ è€‘íÝÉ¥Ñ”¹Á…Ñ¡õ€°€II}=11%M%=8œ¤ì(€€€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€€€¥˜€¡•ÉÉ½È¥¹ÍÑ…¹•½˜%¹¥ÑM…™•ÑåÉÉ½È¤Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€€€¥˜€¡•ÉÉ½Èü¹½‘”€„ôô€9=9Pœ¤Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€ô(€€€€€€€…Ý…¥ÐÉ•¹…µ”¡Ñ•µÁA…Ñ °ÝÉ¥Ñ”¹…‰Í½±ÕÑ•A…Ñ ¤ì(€€€€€€€ÝÉ¥ÑÑ•¸¹ÁÕÍ ¡ÝÉ¥Ñ”¹Á…Ñ ¤ì(€€€€€ô™¥¹…±±äì(€€€€€€€¥˜€¡¡…¹‘±”¤…Ý…¥Ð¡…¹‘±”¹±½Í” ¤¹…Ñ   ¤€ôøíô¤ì(€€€€€€€…Ý…¥ÐÉ´¡Ñ•µÁA…Ñ °ì™½É”èÑÉÕ”ô¤¹…Ñ   ¤€ôøíô¤ì(€€€€€ô(€€€ô(€ô…Ñ €¡•ÉÉ½È¤ì(€€€¥˜€¡•ÉÉ½È¥¹ÍÑ…¹•½˜%¹¥ÑM…™•ÑåÉÉ½È¤Ñ¡É½Ü•ÉÉ½Èì(€€€Ñ¡É½Ü¹•Ü%¹¥ÑM…™•ÑåÉÉ½È¡…Ñ½µ¥ŒÝÉ¥Ñ”™…¥±•è€‘í•ÉÉ½È¹µ•ÍÍ…•õ€°€II}]I%Q}%1œ¤ì(€ô(€É•ÑÕÉ¸=‰©•Ð¹™É••é”¡ì(€€€½¬èÑÉÕ”°(€€€‘ÉåIÕ¸è™…±Í”°(€€€Á±…¹¹•è=‰©•Ð¹™É••é”¡Á±…¹¹•¤°(€€€ÝÉ¥Ñ•Ìè=‰©•Ð¹™É••é”¡Á±…¹¹•¤°(€€€ÝÉ¥ÑÑ•¸è=‰©•Ð¹™É••é”¡ÝÉ¥ÑÑ•¸¤°(€ô¤ì)ô()•áÁ½ÉÐìÍ…™•I•±…Ñ¥Ù•A…Ñ …Ì¹½Éµ…±¥é•]É¥Ñ•A…Ñ ôì(