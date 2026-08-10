import fs from 'node:fs';
import path from 'node:path';

import { executeArgv } from './runner.js';
import {
  assertContainedRealPath,
  discoverGitRepository,
  isPathContained,
  runGit,
} from './git.js';

export class WorktreeOperationError extends Error {
  constructor(message, rescue) {
    super(message);
    this.name = 'WorktreeOperationError';
    this.rescue = rescue;
  }
}

function laneSegment(lane) {
  if (typeof lane !== 'string' || lane.length === 0) throw new TypeError('lane must be a non-empty string');
  if (lane === '.' || lane === '..' || lane.includes('/') || lane.includes('\\') || lane.includes(':')) {
    throw new Error('lane must be a single path-safe segment');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lane)) throw new Error('lane contains unsupported characters');
  return lane;
}

function branchName(branch, lane) {
  const value = branch ?? `worktree-proof/${lane}`;
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || value.includes('..')) {
    throw new Error('branch must be a valid non-empty git branch name');
  }
  if (value.includes('\\') || value.includes('\0')) throw new Error('branch contains unsupported characters');
  return value;
}

function boundedError(error) {
  if (!error) return undefined;
  return { name: error.name ?? 'Error', code: error.code, message: String(error.message ?? error) };
}

function rescueRecord(input, reason, status, error) {
  return {
    lane: input?.lane,
    branch: input?.branch,
    path: input?.path,
    worktreeRoot: input?.worktreeRoot,
    reason,
    status,
    error: boundedError(error),
    rescued: true,
  };
}

function gitOptions(config, cwd) {
  return {
    cwd,
    gitBin: config.gitBin ?? config.git,
    spawnSync: config.spawnSync,
    env: config.env,
    timeoutMs: config.gitTimeoutMs,
    maxBuffer: config.maxBuffer,
  };
}

function gitCall(config, args, cwd, extra = {}) {
  const runner = config.gitRunner ?? runGit;
  return runner(args, { ...gitOptions(config, cwd), ...extra, cwd });
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink?.() || (Number.isInteger(stats.attributes) && (stats.attributes & 0x400) !== 0)) {
    throw new Error('worktree root cannot be a symlink or reparse point');
  }
}

function resolveRepository(config) {
  const supplied = config.repository ?? config.repo;
  if (config.repoRoot || config.root || supplied?.repoRoot || supplied?.root) {
    const repoRoot = path.resolve(config.repoRoot ?? config.root ?? supplied.repoRoot ?? supplied.root);
    let commonDir;
    if (config.commonDir ?? supplied?.commonDir) {
      commonDir = path.resolve(config.commonDir ?? supplied.commonDir);
    } else {
      let commonResult = gitCall(config, ['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot, { throwOnError: false });
      if (!commonResult.ok) commonResult = gitCall(config, ['reÛ|¶‰Ëkºwµç@‘¥ÉÑäµ½ÈµÍÑ…ÑÕÌµ™…¥±•œ°ÍÑ…ÑÕÌ¤ôì((€€€€¼¼I”µ¡•¬•Ù•ÉäÉ•µ½Ù…°ÁÉ•½¹‘¥Ñ¥½¸¥µµ•‘¥…Ñ•±ä‰•™½É”¥¹Ù½­¥¹œ¥Ğ¸(€€€¥˜€¡…İ…¥Ğ±•…Í•%ÍÑ¥Ù”¡É•½É°½ÁÑ¥½¹Ì¤¤É•ÑÕÉ¸ìÉ•µ½Ù•è™…±Í”°ÁÉ½Ñ•Ñ•èÑÉÕ”°É•…Í½¸è€…Ñ¥Ù”µ±•…Í”œ°±…¹”èÉ•½É¹±…¹”°Á…Ñ èİ½É­ÑÉ••A…Ñ ôì(€€€…ÍÍ•ÉÑ½¹Ñ…¥¹•‘I•…±A…Ñ ¡É½½Ğ°İ½É­ÑÉ••A…Ñ °ì…±±½İ5¥ÍÍ¥¹œè™…±Í”ô¤ì(€€€½¹ÍĞ™¥¹…±MÑ…ÑÕÌ€ô¥¹ÍÁ•Ñ]½É­ÑÉ••MÑ…ÑÕÌ¡İ½É­ÑÉ••A…Ñ °½ÁÑ¥½¹Ì¤ì(€€€Ù…±¥‘…Ñ•½ÉI•µ½Ù…°¡É•½É°½ÁÑ¥½¹Ì°™¥¹…±MÑ…ÑÕÌ¤ì(€€€¥˜€ …™¥¹…±MÑ…ÑÕÌ¹±•…¸¤É•ÑÕÉ¸ìÉ•µ½Ù•è™…±Í”°É•ÍÕ•èÉ•ÍÕ•I•½É¡É•½É°€‰•…µ”µ‘¥ÉÑäœ°™¥¹…±MÑ…ÑÕÌ¤ôì(€€€½¹ÍĞÉ•µ½Ù•€ô¥Ñ…±°¡½ÁÑ¥½¹Ì°lİ½É­ÑÉ•”œ°€É•µ½Ù”œ°İ½É­ÑÉ••A…Ñ¡t°É•½É¹É•Á½I½½Ğ¤ì(€€€¥˜€ …É•µ½Ù•¹½¬ñğ™Ì¹•á¥ÍÑÍMå¹Œ¡İ½É­ÑÉ••A…Ñ ¤¤ì(€€€€€É•ÑÕÉ¸ìÉ•µ½Ù•è™…±Í”°É•ÍÕ•èÉ•ÍÕ•I•½É¡É•½É°€É•µ½Ù”µ™…¥±•œ°™¥¹…±MÑ…ÑÕÌ°¹•ÜÉÉ½È¡É•µ½Ù•¹ÍÑ‘•ÉÈñğ€¥Ğİ½É­ÑÉ•”É•µ½Ù”™…¥±•œ¤¤ôì(€€€ô(€€€É•ÑÕÉ¸ìÉ•µ½Ù•èÑÉÕ”°±…¹”èÉ•½É¹±…¹”°‰É…¹ èÉ•½É¹‰É…¹ °Á…Ñ èİ½É­ÑÉ••A…Ñ °ÍÑ…ÑÕÌè™¥¹…±MÑ…ÑÕÌôì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€½¹ÍĞÉ•ÍÕ”€ôÉ•ÍÕ•I•½É¡ì€¸¸¹É•½É°Á…Ñ èİ½É­ÑÉ••A…Ñ €üüÉ•½É¹Á…Ñ °İ½É­ÑÉ••I½½ĞèÉ½½Ğ€üüÉ•½É¹İ½É­ÑÉ••I½½Ğô°€Ù…±¥‘…Ñ¥½¸µ™…¥±•œ°ÍÑ…ÑÕÌ°•ÉÉ½È¤ì(€€€É•ÑÕÉ¸ìÉ•µ½Ù•è™…±Í”°É•ÍÕ•èÉ•ÍÕ”ôì(€ô)ô((¼¨¨(€¨±•…¸•á…Ñ±äÑ¡”É•½É‘ÌÍÕÁÁ±¥•‰äÑ¡”…±±•È¸=µ¥ÑÑ¥¹œ±…¹•Í€¥Ì…¸(€¨•áÁ±¥¥Ğ¹¼µ½ÀìÑ¡¥Ì™Õ¹Ñ¥½¸¹•Ù•È‘¥Í½Ù•ÉÌ½ÈÍİ••ÁÌ±½‰…°İ½É­ÑÉ••Ì¸(€¨¼)•áÁ½ÉĞ…Íå¹Œ™Õ¹Ñ¥½¸±•…¹ÕÁ5…¹…•‘]½É­ÑÉ••Ì¡½ÁÑ¥½¹Ì€ôíô¤ì(€½¹ÍĞ±…¹•Ì€ô½ÁÑ¥½¹Ì¹±…¹•Ì€üü½ÁÑ¥½¹Ì¹µ…¹…•‘1…¹•Ìì(€¥˜€ …ÉÉ…ä¹¥ÍÉÉ…ä¡±…¹•Ì¤¤Ñ¡É½Ü¹•ÜQåÁ•ÉÉ½È ±•…¹ÕÀÉ•ÅÕ¥É•Ì…¸•áÁ±¥¥Ğ±…¹•Ì…ÉÉ…äœ¤ì(€½¹ÍĞÉ•ÍÕ±ÑÌ€ômtì(€™½È€¡½¹ÍĞ±…¹”½˜±…¹•Ì¤É•ÍÕ±ÑÌ¹ÁÕÍ ¡…İ…¥ĞÉ•µ½Ù•1…¹•]½É­ÑÉ•”¡±…¹”°½ÁÑ¥½¹Ì¤¤ì(€É•ÑÕÉ¸ì(€€€É•ÍÕ±ÑÌ°(€€€É•µ½Ù•èÉ•ÍÕ±ÑÌ¹™¥±Ñ•È ¡É•ÍÕ±Ğ¤€ôøÉ•ÍÕ±Ğ¹É•µ½Ù•¤°(€€€ÁÉ½Ñ•Ñ•èÉ•ÍÕ±ÑÌ¹™¥±Ñ•È ¡É•ÍÕ±Ğ¤€ôøÉ•ÍÕ±Ğ¹ÁÉ½Ñ•Ñ•¤°(€€€É•ÍÕ•ÌèÉ•ÍÕ±ÑÌ¹µ…À ¡É•ÍÕ±Ğ¤€ôøÉ•ÍÕ±Ğ¹É•ÍÕ•¤¹™¥±Ñ•È¡	½½±•…¸¤°(€ôì)ô()•áÁ½ÉĞ½¹ÍĞ±•…¹ÕÁ]½É­ÑÉ••Ì€ô±•…¹ÕÁ5…¹…•‘]½É­ÑÉ••Ìì)•áÁ½ÉĞ½¹ÍĞÉ•…Ñ•]½É­ÑÉ•”€ôÉ•…Ñ•1…¹•]½É­ÑÉ•”ì)•áÁ½ÉĞ½¹ÍĞÉ•µ½Ù•]½É­ÑÉ•”€ôÉ•µ½Ù•1…¹•]½É­ÑÉ•”ì)•áÁ½ÉĞì…ÍÍ•ÉÑ½¹Ñ…¥¹•‘I•…±A…Ñ °¥ÍA…Ñ¡½¹Ñ…¥¹•ôì((¼¨¨á•ÕÑ”„±…¹”½µµ…¹…¹¥¹ÍÁ•ĞÍÑ…ÑÕÌ•Ù•¸İ¡•¸•á•ÕÑ¥½¸™…¥±Ì¸€¨¼)•áÁ½ÉĞ…Íå¹Œ™Õ¹Ñ¥½¸ÉÕ¹1…¹•½µµ…¹¡É•½É°…ÉØ°½ÁÑ¥½¹Ì€ôíô¤ì(€½¹ÍĞİ½É­ÑÉ••A…Ñ €ôÉ•½Éü¹Á…Ñ ì(€¥˜€ …É•½Éü¹µ…¹…•ñğ€…İ½É­ÑÉ••A…Ñ ¤Ñ¡É½Ü¹•ÜQåÁ•ÉÉ½È µ…¹…•±…¹”É•½É¥ÌÉ•ÅÕ¥É•œ¤ì(€½¹ÍĞÉ½½Ğ€ôÁ…Ñ ¹É•Í½±Ù”¡½ÁÑ¥½¹Ì¹İ½É­ÑÉ••I½½Ğ€üüÉ•½É¹İ½É­ÑÉ••I½½Ğ¤ì(€…ÍÍ•ÉÑ½¹Ñ…¥¹•‘I•…±A…Ñ ¡É½½Ğ°İ½É­ÑÉ••A…Ñ °ì…±±½İ5¥ÍÍ¥¹œè™…±Í”ô¤ì(€±•Ğ•á•ÕÑ¥½¸ì(€±•Ğ•á•ÕÑ¥½¹ÉÉ½Èì(€ÑÉäì(€€€½¹ÍĞ•á•ÕÑ”€ô½ÁÑ¥½¹Ì¹•á•ÕÑ•ÉØ€üü•á•ÕÑ•ÉØì(€€€•á•ÕÑ¥½¸€ô…İ…¥Ğ•á•ÕÑ”¡…ÉØ°ì€¸¸¹½ÁÑ¥½¹Ì°İèİ½É­ÑÉ••A…Ñ °Í¡•±°è™…±Í”ô¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€•á•ÕÑ¥½¹ÉÉ½È€ô‰½Õ¹‘•‘ÉÉ½È¡•ÉÉ½È¤ì(€ô(€½¹ÍĞÍÑ…ÑÕÌ€ô¥¹ÍÁ•Ñ]½É­ÑÉ••MÑ…ÑÕÌ¡İ½É­ÑÉ••A…Ñ °½ÁÑ¥½¹Ì¤ì(€É•ÑÕÉ¸ì•á•ÕÑ¥½¸°•á•ÕÑ¥½¹ÉÉ½È°ÍÑ…ÑÕÌ°±…¹”èÉ•½É¹±…¹”°‰É…¹ èÉ•½É¹‰É…¹ °Á…Ñ èİ½É­ÑÉ••A…Ñ ôì)ô(