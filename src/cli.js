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

/** An operational error returned by a runtime adapter×zöÚ$z{-®éÜj×Ç°¢–b‡&W7VÇCòçfW'6–öâ’&WGW&â&W7VÇBçfW'6–öã°¢–b‡&W7VÇCòçÆææVBbb&W7VÇCòæW†V7WFVBÓÓÒfÇ6R’°¢&WGW&âG·'6VBæ6öÖÖæGÓ¢ÆææVB†æ÷BW†V7WFVB–°¢Ğ¢–b‡&W7VÇCòçÆææVBbb&W7VÇCòç7V&Ö—GFVBÓÓÒfÇ6R’°¢&WGW&âG·'6VBæ6öÖÖæGÓ¢ÆææVB‚G·&W7VÇBç&V6öçÒ–°¢Ğ¢–b‡&W7VÇCòç7W÷'FVBÓÓÒfÇ6R’&WGW&âG·'6VBæ6öÖÖæGÓ¢G·&W7VÇBç&V6öçÖ°¢–b‡&W7VÇBÓÓÒVæFVf–æVBÇÂ&W7VÇBÓÓÒçVÆÂ’&WGW&âG·'6VBæ6öÖÖæGÓ¢ö¶°¢òòFòæ÷BV6†ò&&—G&'’FFW"7G&–æw2†'VææW"6÷VÆB†fR&WGW&æVB6†–Æ@¢òò&ö6W72÷WGWB6öçF–æ–ær7&VFVçF–Â÷"÷F†W"6Vç6—F—fRfÇVR’à¢–b‡G—Vöb&W7VÇBÓÓÒw7G&–ærr’&WGW&âG·'6VBæ6öÖÖæGÓ¢ö¶°¢–b‡G—Vöb&W7VÇBÓÓÒvçVÖ&W"rÇÂG—Vöb&W7VÇBÓÓÒv&ööÆVâr’&WGW&â7G&–ær‡&W7VÇB“°¢òò‡VÖâ÷WGWB–çFVçF–öæÆÇ’6öçF–ç2¶W—2æB7FGW2öæÇ’Âæ÷B&&—G&'¢òòfÇVW2&WGW&æVB'’FFW'2à¢6öç7B¶W—2Òö&¦V7Bæ¶W—2‡6fU&W7VÇBóò·Ò’ç6÷'B‚“°¢&WGW&âG·'6VBæ6öÖÖæGÓ¢ö²G¶¶W—2æÆVæwF‚ò‚G¶¶W—2æ¦ö–â‚rÂr—Ò–¢rwÖ°§Ğ ¢ò¢ ¢¢'VâöæR4Ä’–çfö6F–öââF†R&WGW&âfÇVR—27V—F&ÆRf÷"&–â÷v÷&·G&VR×&ööbæ§0¢¢æBf÷"FW7G3²æò&ö6W72W†—Bö67W'2†W&Rà¢¢ğ¦W‡÷'B7–æ2gVæ7F–öâ'Vä6Æ’†&wbÒ&ö6W72æ&wbç6Æ–6Rƒ"’Â÷F–öç2Ò·Ò’°¢6öç7B–òÒ÷F–öç2æ–òóòFVfVÇD–ò‚“°¢ÆWB'6VC°¢G'’°¢'6VBÒ'6T&w2†&wb“°¢Ò6F6‚†W'&÷"’°¢6öç7BÖW76vRÒW'&÷$ÖW76vR†W'&÷"“°¢6öç7BfÆÆ&6²Ò²ö³¢fÇ6RÂW'&÷#¢ÖW76vRÂ6öFS¢U„•Eô4ôDU2åU4tRÓ°¢–b†&wbæ–æ6ÇVFW2‚rÒÖ§6öâr’’–òç7FF÷WB‡6fT§6öâ†fÆÆ&6²’“°¢VÇ6R–òç7FFW'"†W'&÷#¢G¶ÖW76vWÕÆâG·W6vR‚—Ö“°¢&WGW&âfÆÆ&6³°¢Ğ ¢–b‡'6VBæ6öÖÖæBÓÓÒVæFVf–æVBÇÂ'6VBæ6öÖÖæD†VÇÇÂ'6VBæ6öÖÖæEfW'6–öâ’°¢6öç7B&W7VÇBÒ'6VBæ6öÖÖæEfW'6–öâò²fW'6–öã¢fW'6–öåFW‡B‚’Ò¢²†VÇ¢W6vR‚’Ó°¢–òç7FF÷WB‡'6VBæ÷F–öç2æ§6öâò6fT§6öâ‡²ö³¢G'VRÂ6öÖÖæC¢'6VBæ6öÖÖæBóòçVÆÂÂ&W7VÇBÒ’¢‡&W7VÇBçfW'6–öâóò&W7VÇBæ†VÇ’“°¢&WGW&â²ö³¢G'VRÂ6öFS¢U„•Eô4ôDU2äô²Â&W7VÇBÓ°¢Ğ ¢6öç7B&WòÒ&W6öÇfR†÷F–öç2ç&Wòóò'6VBæ÷F–öç2ç&Wòóò&ö6W72æ7vB‚’“°¢ÆWB6öæf–tFF°¢G'’°¢6öæf–tFFÒv—B†÷F–öç2æÆöD6öæf–p¢ò÷F–öç2æÆöD6öæf–r‡&WòÂ'6VBæ÷F–öç2æ6öæf–r¢¢ÆöD6öæf–r‡&WòÂ'6VBæ÷F–öç2æ6öæf–r’“°¢6öç7BFW2Òv—BÆöE'VçF–ÖTFWVæFVæ6–W2†÷F–öç2æFW2óò·Ò“°¢6öç7B&W7VÇBÒv—BW†V7WFT6öÖÖæB‡'6VBÂ²&WòÂ6öæf–tFFÂFW2Ò“°¢–òç7FF÷WB‡&VæFW%&W7VÇB‡'6VBÂ&W7VÇB’“°¢&WGW&â²ö³¢G'VRÂ6öFS¢U„•Eô4ôDU2äô²Â&W7VÇBÓ°¢Ò6F6‚†W'&÷"’°¢6öç7BÖW76vRÒW'&÷$ÖW76vR†W'&÷"“°¢6öç7B6öFRÒW'&÷#òæ6öFRÓÓÒU„•Eô4ôDU2åU4tRòU„•Eô4ôDU2åU4tR¢U„•Eô4ôDU2äU%$õ#°¢–b‡'6VBæ÷F–öç2æ§6öâ’–òç7FF÷WB‡6fT§6öâ‡²ö³¢fÇ6RÂ6öÖÖæC¢'6VBæ6öÖÖæBÂW'&÷#¢ÖW76vRÂ6öFRÒ’“°¢VÇ6R–òç7FFW'"†W'&÷#¢G¶ÖW76vWÖ“°¢&WGW&â²ö³¢fÇ6RÂ6öFRÂW'&÷#¢ÖW76vRÓ°¢Ğ§Ğ ¦W‡÷'B7–æ2gVæ7F–öâÖ–â†&wbÒ&ö6W72æ&wbç6Æ–6Rƒ"’Â÷F–öç2Ò·Ò’°¢6öç7B&W7VÇBÒv—B'Vä6Æ’†&wbÂ÷F–öç2“°¢&WGW&â&W7VÇBæ6öFRóò‡&W7VÇBæö²òU„•Eô4ôDU2äô²¢U„•Eô4ôDU2äU%$õ"“°§Ğ