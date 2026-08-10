/**
 * Host-neutral onboarding adapters.
 *
 * Adapters only render text.  They never inspect a host's credentials, install
 * anything, call a network, or claim that a host has a capability it has not
 * explicitly supplied in the context.
 */

export const ADAPTER_TARGETS = Object.freeze([
  'agent-skills',
  'claude-code',
  'generic-prompt',
  'vscode',
  'ci',
]);

const TARGET_ALIASES = new Map([
  ['agent-skills', 'agent-skills'],
  ['agents', 'agent-skills'],
  ['codex', 'agent-skills'],
  ['codex-agent-skill', 'agent-skills'],
  ['claude', 'claude-code'],
  ['claude-code', 'claude-code'],
  ['generic', 'generic-prompt'],
  ['prompt', 'generic-prompt'],
  ['generic-prompt', 'generic-prompt'],
  ['vscode', 'vscode'],
  ['vs-code', 'vscode'],
  ['ci', 'ci'],
  ['github-actions', 'ci'],
]);

const SECRET_KEY_RE = /(?:^|[_-])(secret|token|password|passwd|api[-_]?key|private[-_]?key|auth|cookie|credential)(?:$|[_-])|(?:secret|token|password|passwd|credential|cookie|apiKey|apiToken|privateKey|accessToken|authToken)$/i;
const SECRET_VALUE_RE = /-----BEGIN [^-]+ PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{1,}|(?:^|\n)\s*[A-Za-z][A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|COOKIE|CREDENTIAL)[A-Za-z0-9_.-]*\s*[:=]\s*[^\s#]+/i;

export class AdapterError extends TypeError {
  constructor(message, code = 'ERR_ADAPTER') {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

function canonicalTarget(target) {
  if (typeof target !== 'string' || !target.trim()) {
    throw new AdapterError('adapter target must be a non-empty string', 'ERR_UNKNOWN_ADAPTER');
  }
  const normalized = TARGET_ALIASES.get(target.trim().toLowerCase());
  if (!normalized) {
    throw new AdapterError(`unknown adapter target: ${target}`, 'ERR_UNKNOWN_ADAPTER');
  }
  return normalized;
}

function stringList(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 20);
}

function projectName(project) {
  const raw = project?.name
    ?? project?.package?.name
    ?? project?.metadata?.name
    ?? (typeof project?.root === 'string' ? project.root.split(/[\\/]/).filter(Boolean).at(-1) : undefined)
    ?? 'project';
  const name = String(raw).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return name || 'project';
}

function normalizeContext(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new AdapterError('adapter context must be an object', 'ERR_INVALID_CONTEXT');
  }
  assertNoSecrets(context);
  const project = context.project && typeof context.project === 'object' ? context.project : context;
  const stack = project.stack && typeof project.stack === 'object' ? project.stack : {};
  const languages = stringList(stack.languages ?? project.languages);
  const f×Íø¶‰žËkºwµç}ÁÑ¥½¹ÌèìÝè€œ‘íÝ½É­ÍÁ…•½±‘•Éôœô°(€€€€€ÁÉ½‰±•µ5…Ñ¡•Èèmt°(€€€€€ÁÉ•Í•¹Ñ…Ñ¥½¸èìÉ•Ù•…°è€Í¥±•¹Ðœ°Á…¹•°è€Í¡…É•œô°(€€€õt°(€ô°¹Õ±°°€È¥õq¹€ì)ô()™Õ¹Ñ¥½¸¥]½É­™±½Ü¡½¹Ñ•áÐ¤ì(€€¼¼Q¡¥Ì¥Ì„‘•±¥‰•É…Ñ•±ä½ÁÐµ¥¸±½…°Ù…±¥‘…Ñ¥½¸Í¹¥ÁÁ•Ð¸€%Ð‘½•Ì¹½Ð(€€¼¼¥¹ÍÑ…±°‘•Á•¹‘•¹¥•Ì½È…‘¡•­½ÕÐ½Í•ÑÕÀ…Ñ¥½¹Ìì„É•Á½Í¥Ñ½Éä½Ý¹•È(€€¼¼µÕÍÐÝ¥É”¥Ð¥¹Ñ¼…¸•á¥ÍÑ¥¹œ$©½ˆÝ¥Ñ „ÁÉ½Ù¥Í¥½¹•9½‘”ÉÕ¹Ñ¥µ”¸(€É•ÑÕÉ¸€Œ]½É­ÑÉ••AÉ½½˜Ù…±¥‘…Ñ¥½¸Í¹¥ÁÁ•Ð™½È€‘í½¹Ñ•áÐ¹¹…µ•ô(Œ=ÁÐ¥¸‰äÁ±…¥¹œÑ¡¥ÌÍÑ•À¥¸…¸•á¥ÍÑ¥¹œ$©½ˆÝ¥Ñ 9½‘”¹©Ì€ÈÀ¬…Ù…¥±…‰±”¸(Œ9¼Í½™ÑÝ…É”¥Ì¥¹ÍÑ…±±•…¹¹¼¹•ÑÝ½É¬¥Ì…±±•‰äÑ¡¥ÌÍ¹¥ÁÁ•Ð¸(´¹…µ”è]½É­ÑÉ••AÉ½½˜Ù…±¥‘…Ñ”(€¥˜èp‘íì¡…Í¡¥±•Ì ‰¥¸½Ý½É­ÑÉ•”µÁÉ½½˜¹©Ìœ¤€„ô€œœõô(€ÉÕ¸è¹½‘”€¸½‰¥¸½Ý½É­ÑÉ•”µÁÉ½½˜¹©ÌÙ…±¥‘…Ñ”€¸)€ì)ô((¼¨¨(€¨I•¹‘•È½¹”¡½ÍÐµ¹•ÕÑÉ…°…‘…ÁÑ•È¸€Q¡”É•ÍÕ±Ð¥Ì‘…Ñ„µ½¹±ä…¹…¸‰”Á…ÍÍ•(€¨Ñ¼‰Õ¥±‘%¹¥ÑA±…¸ì¹¼™¥±•ÍåÍÑ•´½È¹•ÑÝ½É¬…•ÍÌ½ÕÉÌ¡•É”¸(€¨¼)•áÁ½ÉÐ™Õ¹Ñ¥½¸É•¹‘•É‘…ÁÑ•È¡Ñ…É•Ð°½¹Ñ•áÐ€ôíô¤ì(€½¹ÍÐ…¹½¹¥…°€ô…¹½¹¥…±Q…É•Ð¡Ñ…É•Ð¤ì(€½¹ÍÐ¹½Éµ…±¥é•€ô¹½Éµ…±¥é•½¹Ñ•áÐ¡½¹Ñ•áÐ¤ì(€±•Ð™¥±•Ìì(€±•Ð…Á…‰¥±¥Ñ¥•Ìì(€ÍÝ¥Ñ €¡…¹½¹¥…°¤ì(€€€…Í”€…•¹ÐµÍ­¥±±Ìœè(€€€€€™¥±•Ì€ôl(€€€€€€€ìÁ…Ñ è€œ¹…•¹ÑÌ½Í­¥±±Ì½Ý½É­ÑÉ•”µÁÉ½½˜½M-%10¹µœ°½¹Ñ•¹Ðè¹•ÕÑÉ…±M­¥±°¡¹½Éµ…±¥é•°€•¹ÐM­¥±±Ì½½‘•àœ¤°µ½‘”è€É•…Ñ”œô°(€€€€€€€ìÁ…Ñ è€œ¹…•¹ÑÌ½Í­¥±±Ì½Ý½É­ÑÉ•”µÁÉ½½˜½…•¹ÑÌ½½Á•¹…¤¹å…µ°œ°½¹Ñ•¹Ðè½‘•á5•Ñ…‘…Ñ„¡¹½Éµ…±¥é•¤°µ½‘”è€É•…Ñ”œô°(€€€€€tì(€€€€€…Á…‰¥±¥Ñ¥•Ì€ôì…•¹ÑM­¥±±ÌèÑÉÕ”°½‘•àèÑÉÕ”ôì(€€€€€‰É•…¬ì(€€€…Í”€±…Õ‘”µ½‘”œè(€€€€€™¥±•Ì€ôl(€€€€€€€ìÁ…Ñ è€1U¹µœ°½¹Ñ•¹Ðè±…Õ‘•5•Ñ…‘…Ñ„¡¹½Éµ…±¥é•¤°µ½‘”è€É•…Ñ”œô°(€€€€€€€ìÁ…Ñ è€œ¹±…Õ‘”½Í­¥±±Ì½Ý½É­ÑÉ•”µÁÉ½½˜½M-%10¹µœ°½¹Ñ•¹Ðè¹•ÕÑÉ…±M­¥±°¡¹½Éµ…±¥é•°€±…Õ‘”½‘”œ¤°µ½‘”è€É•…Ñ”œô°(€€€€€tì(€€€€€…Á…‰¥±¥Ñ¥•Ì€ôì±…Õ‘•½‘”èÑÉÕ”ôì(€€€€€‰É•…¬ì(€€€…Í”€•¹•É¥ŒµÁÉ½µÁÐœè(€€€€€™¥±•Ì€ômìÁ…Ñ è€]=I-QI}AI==}AI=5AP¹µœ°½¹Ñ•¹Ðè•¹•É¥AÉ½µÁÐ¡¹½Éµ…±¥é•¤°µ½‘”è€É•…Ñ”œõtì(€€€€€…Á…‰¥±¥Ñ¥•Ì€ôì•¹•É¥AÉ½µÁÐèÑÉÕ”ôì(€€€€€‰É•…¬ì(€€€…Í”€ÙÍ½‘”œè(€€€€€™¥±•Ì€ômìÁ…Ñ è€œ¹ÙÍ½‘”½Ñ…Í­Ì¹©Í½¸œ°½¹Ñ•¹ÐèÙÍ½‘•Q…Í­Ì¡¹½Éµ…±¥é•¤°µ½‘”è€É•…Ñ”œõtì(€€€€€…Á…‰¥±¥Ñ¥•Ì€ôìÙÍ½‘•Q…Í­ÌèÑÉÕ”ôì(€€€€€‰É•…¬ì(€€€…Í”€¤œè(€€€€€™¥±•Ì€ômìÁ…Ñ è€œ¹¥Ñ¡Õˆ½Ý½É­™±½ÝÌ½Ý½É­ÑÉ•”µÁÉ½½˜¹åµ°œ°½¹Ñ•¹Ðè¥]½É­™±½Ü¡¹½Éµ…±¥é•¤°µ½‘”è€É•…Ñ”œõtì(€€€€€…Á…‰¥±¥Ñ¥•Ì€ôì¥M¹¥ÁÁ•ÐèÑÉÕ”ôì(€€€€€‰É•…¬ì(€€€‘•™…Õ±Ðè(€€€€€Ñ¡É½Ü¹•Ü‘…ÁÑ•ÉÉÉ½È¡Õ¹­¹½Ý¸…‘…ÁÑ•ÈÑ…É•Ðè€‘íÑ…É•Ñõ€°€II}U9-9=]9}AQHœ¤ì(€ô(€½¹ÍÐÉ•ÍÕ±Ð€ôì(€€€Ñ…É•Ðè…¹½¹¥…°°(€€€É•ÅÕ•ÍÑ•‘Q…É•ÐèÑ…É•Ð°(€€€™¥±•Ìè=‰©•Ð¹™É••é”¡™¥±•Ì¹µ…À ¡™¥±”¤€ôø=‰©•Ð¹™É••é”¡ì€¸¸¹™¥±”ô¤¤¤°(€€€Ý…É¹¥¹Ìè=‰©•Ð¹™É••é”¡l‘…ÁÑ•È½ÕÑÁÕÐ¥Ì…‘Ù¥Í½Éä…¹¡½ÍÐµ¹•ÕÑÉ…°ìÙ•É¥™ä…Á…‰¥±¥Ñ¥•Ì±½…±±ä‰•™½É”ÕÍ”¸t¤°(€€€…Á…‰¥±¥Ñ¥•Ìè=‰©•Ð¹™É••é”¡…Á…‰¥±¥Ñ¥•Ì¤°(€ôì(€¥˜€¡É•ÍÕ±Ð¹™¥±•Ì¹±•¹Ñ €ôôô€Ä¤ì(€€€É•ÍÕ±Ð¹Á…Ñ €ôÉ•ÍÕ±Ð¹™¥±•ÍlÁt¹Á…Ñ ì(€€€É•ÍÕ±Ð¹½¹Ñ•¹Ð€ôÉ•ÍÕ±Ð¹™¥±•ÍlÁt¹½¹Ñ•¹Ðì(€ô(€É•ÑÕÉ¸=‰©•Ð¹™É••é”¡É•ÍÕ±Ð¤ì)ô()•áÁ½ÉÐì…¹½¹¥…±Q…É•Ð…Ì¹½Éµ…±¥é•‘…ÁÑ•ÉQ…É•Ðôì