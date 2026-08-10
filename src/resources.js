/**
 * Bounded, read-only resource diagnostics for WorktreeProof.
 *
 * The module intentionally uses only Node.js built-ins.  Probes are injected
 * through `scanResources` options so callers can test platform-specific
 * branches without changing host state or reading file contents.
 */

import * as nodeOs from 'node:os';
import * as nodeProcess from 'node:process';
import nodePath from 'node:path';
import { promises as nodeFs } from 'node:fs';

const BYTES_PER_GIB = 1024 ** 3;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 4096;
const PROFILE_NAMES = ['low-resource', 'balanced', 'fast', 'ci'];
// A request is not a promise. The host/runtime ceiling and measured resource
// capacity remain authoritative and may reduce the effective value to zero.
export const DEFAULT_REQUESTED_CONCURRENCY = 8;
export const MAX_REQUESTED_CONCURRENCY = 24;
export const POLICY_GOAL_CONCURRENCY = MAX_REQUESTED_CONCURRENCY;
// Backward-compatible name from the v0.1 preview. It now means the package's
// maximum accepted request, not a universal machine or runtime capacity.
export const PUBLIC_MAX_CONCURRENCY = MAX_REQUESTED_CONCURRENCY;

const DIRECTORY_GROUPS = Object.freeze({
  worktree: new Set(['worktree', 'worktrees', '.worktree', '.worktrees', '_worktrees']),
  build: new Set(['build', 'dist', 'out', 'target', 'coverage', 'artifacts', '.next']),
  cache: new Set(['cache', '.cache', 'caches', 'tmp-cache', 'npm-cache']),
});

/**
 * Stable defaults used by profile selection.  Returned profiles are cloned so
 * callers cannot mutate this module's policy.
 */
export const RESOURCE_PROFILES = Object.freeze({
  'low-resource': Object.freeze({
    name: 'low-resource',
    maxConcurrency: 1,
    memoryPerWorkerBytes: 256 * 1024 ** 2,
    cacheMode: 'minimal',
    artifactPolicy: 'stream-and-discard',
    diskReserveRatio: 0.2,
    cpuUtilization: 0.5,
  }),
  balanced: Object.freeze({
    name: 'balanced',
    maxConcurrency: 4,
    memoryPerWorkerBytes: 512 * 1024 ** 2,
    cacheMode: 'bounded',
    artifactPolicy: 'retain-required',
    diskReserveRatio: 0.1,
    cpuUtilization: 0.75,
  }),
  fast: Object.freeze({
    name: 'fast',
    maxConcurrency: MAX_REQUESTED_CONCURRENCY,
    memoryPerWorkerBytes: 768 * 1024 ** 2,
    cacheMode: 'reuse-with-cap',
    artifactPolicy: 'retain-required',
    diskReserveRatio: 0.05,
    cpuUtilization: 1,
  }),
  ci: Object.freeze({
    name: 'ci',
    maxConcurrency: 8,
    memoryPerWorkerBytes: 512 * 1024 ** 2,
    cacheMode: 'deterministic-bounded',
    artifactPolicy: 'retain-evidence-only',
    diskReserveRatio: 0.15,
    cpuUtilization: 0.8,
  }),
});

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0×^;æÚ$z{-®éÜj×Ò°¢5RG¶F—7Æ”çVÖ&W"†7RæÆöv–6Ä6÷VçB—ÒÆöv–6ÂòÆöBG¶F—7Æ”çVÖ&W"†7RæÆöB—ÖÀ¢$Òg&VRG¶F—7Æ”'—FW2†ÖVÖ÷'’æg&VT'—FW2—ÒöbG¶F—7Æ”'—FW2†ÖVÖ÷'’çF÷FÄ'—FW2—Ò‡&W77W&RG¶ÖVÖ÷'’ç&W77W&U&F–òÓÓÒçVÆÂÇÂÖVÖ÷'’ç&W77W&U&F–òÓÓÒVæFVf–æVBòwVæf–Æ&ÆRr¢G´ÖF‚ç&÷VæB†ÖVÖ÷'’ç&W77W&U&F–ò¢—ÒVÒ–À¢æöFR†VG¶F—7Æ”'—FW2†æöFTÖVÖ÷'’æ†VW6VD'—FW2—ÒòG¶F—7Æ”'—FW2†æöFTÖVÖ÷'’æ†VF÷FÄ'—FW2—ÖÀ¢F—6²g&VRG¶F—7Æ”'—FW2†F—6²æg&VT'—FW2—ÒöbG¶F—7Æ”'—FW2†F—6²çF÷FÄ'—FW2—ÖÀ¢fö÷G&–çBG¶F—7Æ”'—FW2†fö÷G&–çBæ'—FW2óò6FVv÷&–W2ç&Wóòæ'—FW2—Ò†v—BG¶F—7Æ”'—FW2†6FVv÷&–W2æv—Còæ'—FW2—ÒÂv÷&·G&VRG¶F—7Æ”'—FW2†6FVv÷&–W2çv÷&·G&VSòæ'—FW2—ÒÂ'V–ÆBG¶F—7Æ”'—FW2†6FVv÷&–W2æ'V–ÆCòæ'—FW2—ÒÂ66†RG¶F—7Æ”'—FW2†6FVv÷&–W2æ66†Sòæ'—FW2—Ò–À¢6öæ7W'&Væ7’G¶F—7Æ”çVÖ&W"†æ÷&ÖÆ—¦VE66âæ6öæ7W'&Væ7“òæ7W'&VçBóòæ÷&ÖÆ—¦VE66âæ6öæ7W'&Væ7“òæ7F—fR—ÖÀ¢Ó°¢&WGW&â'G2æ¦ö–â‚s²r“°§Ð ¢ò¢ ¢¢6öÆÆV7BÆÂ7W÷'FVBF–væ÷7F–72â&ö&Rf–ÇW&W2&R&W&W6VçFVB0¢¢Væf–Æ&ÆRö&Æö6¶VBf–VÆG26ò6ÆÆW"6â6†ö÷6R6öç6W'fF—fR&öf–ÆS°¢¢F†W’&RæWfW"6öçfW'FVB–çFò'&öBfÆÆ&6²66âà¢¢ð¦W‡÷'B7–æ2gVæ7F–öâ66å&W6÷W&6W2†÷F–öç2Ò·Ò’°¢–b‚÷F–öç2ÇÂG—Vöb÷F–öç2ÓÒvö&¦V7BrÇÂ'&’æ—4'&’†÷F–öç2’’F‡&÷ræWrG—TW'&÷"‚w66å&W6÷W&6W2÷F–öç2×W7B&Râö&¦V7Br“°¢6öç7B÷4–×ÂÒ÷F–öç2æ÷2óòæöFT÷3°¢6öç7Bg4–×ÂÒ²ââææöFTg2Ââââ†÷F–öç2æg2óò·Ò’Ó°¢6öç7B&WõF‚ÒæöFUF‚ç&W6öÇfR†÷F–öç2ç&WõF‚óò÷F–öç2ç&ö÷DF—"óò÷F–öç2ç&ö¦V7E&ö÷Bóò÷F–öç2æ7vBóòæöFU&ö6W72æ7vB‚’“°¢6öç7BÆFf÷&ÒÒæ÷&ÖÆ—¦UÆFf÷&Ò†÷F–öç2Â÷4–×Â“°¢6öç7B¶F—6²Âfö÷G&–çEÒÒv—B&öÖ—6RæÆÂ…°¢6öÆÆV7DF—6²†÷F–öç2Â&WõF‚Âg4–×Â’À¢66äfö÷G&–çB‡&WõF‚Â÷F–öç2Âg4–×Â’À¢Ò“°¢6öç7B7RÒ6öÆÆV7D7R†÷F–öç2Â÷4–×Â“°¢6öç7BÖVÖ÷'’Ò6öÆÆV7DÖVÖ÷'’†÷F–öç2Â÷4–×Â“°¢6öç7BæöFTÖVÖ÷'’Ò6öÆÆV7DæöFTÖVÖ÷'’†÷F–öç2“°¢6öç7B6öæ7W'&Væ7’Ò6öÆÆV7D6öæ7W'&Væ7’†÷F–öç2“°¢6öç7Bv&æ–æw2ÒµÓ°¢–b‚7Ræf–Æ&ÆR’v&æ–æw2çW6‚‚t5RÖWG&–72Væf–Æ&ÆRr“°¢–b‚ÖVÖ÷'’æf–Æ&ÆR’v&æ–æw2çW6‚‚w7—7FVÒÖVÖ÷'’ÖWG&–72Væf–Æ&ÆRr“°¢–b‚F—6²æf–Æ&ÆR’v&æ–æw2çW6‚‚vF—6²ÖWG&–72Væf–Æ&ÆRr“°¢–b†fö÷G&–çBç7FGW2ÓÒvö²r’v&æ–æw2çW6‚†fö÷G&–çB66âG¶fö÷G&–çBç7FGW7Ö“°¢&WGW&â°¢66†VÖfW'6–öã¢sãrÀ¢66ææVDC¢G—Vöb÷F–öç2ææ÷rÓÓÒvgVæ7F–öârò7G&–ær†÷F–öç2ææ÷r‚’’¢G—Vöb÷F–öç2ææ÷rÓÓÒw7G&–ærrò÷F–öç2ææ÷r¢æWrFFR‚’çFô•4õ7G&–ær‚’À¢ÆFf÷&ÒÀ¢&WõF‚À¢7RÀ¢ÖVÖ÷'’À¢&Ó¢ÖVÖ÷'’À¢æöFS¢æöFTÖVÖ÷'’À¢&ö6W73¢æöFTÖVÖ÷'’À¢F—6²À¢fö÷G&–çBÀ¢6öæ7W'&Væ7’À¢Æ–Ö—G3¢²Ö„FWFƒ¢fö÷G&–çBæÖ„FWF‚ÂÖ„VçG&–W3¢fö÷G&–çBæÖ„VçG&–W2ÒÀ¢v&æ–æw2À¢Ó°§Ð ¦W‡÷'BFVfVÇB°¢$U4õU$4Uõ$ôd”ÄU2À¢DTdTÅEõ$UTU5DTEô4ôä5U%$Tä5’À¢Ô…õ$UTU5DTEô4ôä5U%$Tä5’À¢ôÄ”5•ôtôÅô4ôä5U%$Tä5’À¢T$Ä”5ôÔ…ô4ôä5U%$Tä5’À¢66å&W6÷W&6W2À¢6†ö÷6U&W6÷W&6U&öf–ÆRÀ¢&V6öÖÖVæD6öæ7W'&Væ7’À¢Æå&ö¦V7D6ÆVçWÀ¢Æå6W76–öäwV&BÀ¢7VÖÖ&—¦U&W6÷W&6W2À§Ó° 