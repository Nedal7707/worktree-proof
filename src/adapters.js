/**
 * Host-neutral onboarding adapters.
 *
 * Adapters only render text.  They never inspect a host's credentials, install
 * anything, call a network, or claim that a host has a capability it has not
 * explicitly supplied in the context.
 */

import { containsSecretLikeValue, toSafeIdentifier } from './text-safety.js';

// Portable protocol previews live in their own deterministic module but are
// re-exported here for embedders that already consume the adapter surface.
export {
  createIntegrationManifest,
  renderClientPreview,
  validateIntegrationManifest,
} from './manifest.js';

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
  const name = toSafeIdentifier(raw, 80);
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
  const frameworks = stringList(stack.frameworks ?? project.frameworks);
  const packageManagers = stringList(stack.packageManagers ?? project.packageManagers);
  const name = projectName(project);
  const preset = typeof context.preset === 'string' && context.preset.trim()
    ? context.preset.trim()
    : 'project-onboarding';
  const capabilities = context.capabilities && typeof context.capabilities === 'object'
    ? Object.fromEntries(Object.entries(context.capabilities).filter(([key, value]) => typeof key === 'string' && typeof value === 'boolean'))
    : {};

  // Context is data supplied by a caller.  Reject secret-shaped values before
  // interpolation so a prompt/template cannot become a secret capture sink.
  assertNoSecrets({ name, preset, languages, frameworks, packageManagers, capabilities });
  return { name, preset, languages, frameworks, packageManagers, capabilities };
}

function assertNoSecrets(value, keyPath = '') {
  if (typeof value === 'string') {
    if (containsSecretLikeValue(value)) {
      throw new AdapterError(`secret-like value at ${keyPath || 'context'}`, 'ERR_SECRET_INPUT');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${keyPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const safeBooleanFlag = typeof child === 'boolean' && /^(?:has)?(?:auth|sensitive)(?:files)?$/i.test(key);
    if (SECRET_KEY_RE.test(key) && !safeBooleanFlag) {
      throw new AdapterError(`secret-like context key: ${key}`, 'ERR_SECRET_INPUT');
    }
    assertNoSecrets(child, keyPath ? `${keyPath}.${key}` : key);
  }
}

function stackSummary(context) {
  const parts = [
    ...context.languages,
    ...context.frameworks,
    ...context.packageManagers,
  ];
  return parts.length ? parts.join(', ') : 'the detected project stack';
}

function neutralSkill(context, host) {
  return `---
name: worktree-proof
description: Coordinate bounded coding-agent lanes with explicit scopes, reservations, run records, and closure receipts.
---

# WorktreeProof onboarding (${host})

This is an optional, local guide for **${context.name}**. It describes WorktreeProof
artifacts; it does not install software, contact a service, read credentials, or
claim that this host has a particular agent capability.

## Suggested use

1. Inspect the repository and confirm the proposed file scope.
2. Run WorktreeProof commands that are already available in this checkout.
3. Keep plans in dry-run mode until a human explicitly confirms creation.
4. Treat a missing command, provider, or host feature as unavailable; do not
   emulate it or silently fall back to a network service.

## Shared WorktreeProof protocol

- Keep laneId and a relative POSIX fileScope in .worktree-proof/ state.
- Use the shared lease/resource-budget records; never create a second sidebar
  session or a vendor relay as overflow.
- Close with a redacted receipt validated by
  schemas/closure-receipt.schema.json after checks and evidence are recorded.
- resources scan and resources plan are read-only diagnostics; their public
  recommendation is bounded and may refuse new work under host pressure.
- bridge inbox/claim/complete uses bounded files for explicit handoffs. It
  never starts another assistant or forwards hidden context.
- tasks inspect accepts a one-shot host snapshot, hashes task IDs, discards
  private task text, and reports a mode only when the host explicitly supplies
  it.

Detected stack: ${stackSummary(context)}.

Generated preset: ${context.preset}.
`;
}

function codexMetadata(context) {
  return `interface:
  display_name: WorktreeProof
  short_description: Conflict-safe local lanes and closure receipts
  default_prompt: Inspect this repository, propose a dry-run WorktreeProof plan, and wait for explicit confirmation before creating files.
  project: ${context.name}
`;
}

function claudeMetadata(context) {
  return `# WorktreeProof for Claude Code\n\nUse the same vendor-neutral .worktree-proof/ state as every other adapter.\nKeep laneId, fileScope, lease, resource-budget, bridge-message, task-awareness, and closure-receipt fields unchanged.\nBridge commands are explicit local file handoffs; they do not start Codex or share hidden context.\nTask modes are host-reported only and remain unknown when absent.\nThis file does not authenticate or call a network.\n\nProject: ${context.name}\n`;
}

function genericPrompt(context) {
  return `# WorktreeProof prompt for ${context.name}

Use WorktreeProof as a local, host-neutral planning aid for this repository.

- Start with a read-only project inspection.
- Propose non-overlapping relative scopes and a dry-run initialization plan.
- Never read, print, or copy secrets, credentials, auth files, lockfiles, or
  private session material.
- Never install software or call a network as part of onboarding.
- Ask for explicit confirmation before writing any new file; refuse collisions,
  path traversal, symlink escapes, and destructive changes.
- If a host feature is missing, report it as unavailable rather than pretending
  to provide it.

Detected stack: ${stackSummary(context)}.
`;
}

function vscodeTasks(context) {
  const label = `WorktreeProof: validate ${context.name}`;
  // The task intentionally calls only a local script.  It does not install a
  // CLI, invoke a shell string, or assert that a provider is present.
  return `${JSON.stringify({
    version: '2.0.0',
    tasks: [{
      label,
      type: 'process',
      command: 'node',
      args: ['./bin/worktree-proof.js', 'validate', '.'],
      options: { cwd: '${workspaceFolder}' },
      problemMatcher: [],
      presentation: { reveal: 'silent', panel: 'shared' },
    }],
  }, null, 2)}\n`;
}

function ciWorkflow(context) {
  // This is a deliberately opt-in local validation snippet.  It does not
  // install dependencies or add checkout/setup actions; a repository owner
  // must wire it into an existing CI job with a provisioned Node runtime.
  return `# WorktreeProof validation snippet for ${context.name}
# Opt in by placing this step in an existing CI job with Node.js 20+ available.
# No software is installed and no network is called by this snippet.
- name: WorktreeProof validate
  if: \${{ hashFiles('bin/worktree-proof.js') != '' }}
  run: node ./bin/worktree-proof.js validate .
`;
}

/**
 * Render one host-neutral adapter.  The result is data-only and can be passed
 * to buildInitPlan; no filesystem or network access occurs here.
 */
export function renderAdapter(target, context = {}) {
  const canonical = canonicalTarget(target);
  const normalized = normalizeContext(context);
  let files;
  let capabilities;
  switch (canonical) {
    case 'agent-skills':
      files = [
        { path: '.agents/skills/worktree-proof/SKILL.md', content: neutralSkill(normalized, 'Agent Skills/Codex'), mode: 'create' },
        { path: '.agents/skills/worktree-proof/agents/openai.yaml', content: codexMetadata(normalized), mode: 'create' },
      ];
      capabilities = { agentSkills: true, codex: true };
      break;
    case 'claude-code':
      files = [
        { path: 'CLAUDE.md', content: claudeMetadata(normalized), mode: 'create' },
        { path: '.claude/skills/worktree-proof/SKILL.md', content: neutralSkill(normalized, 'Claude Code'), mode: 'create' },
      ];
      capabilities = { claudeCode: true };
      break;
    case 'generic-prompt':
      files = [{ path: 'WORKTREE_PROOF_PROMPT.md', content: genericPrompt(normalized), mode: 'create' }];
      capabilities = { genericPrompt: true };
      break;
    case 'vscode':
      files = [{ path: '.vscode/tasks.json', content: vscodeTasks(normalized), mode: 'create' }];
      capabilities = { vscodeTasks: true };
      break;
    case 'ci':
      files = [{ path: '.github/workflows/worktree-proof.yml', content: ciWorkflow(normalized), mode: 'create' }];
      capabilities = { ciSnippet: true };
      break;
    default:
      throw new AdapterError(`unknown adapter target: ${target}`, 'ERR_UNKNOWN_ADAPTER');
  }
  const result = {
    target: canonical,
    requestedTarget: target,
    files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
    warnings: Object.freeze(['Adapter output is advisory and host-neutral; verify capabilities locally before use.']),
    capabilities: Object.freeze(capabilities),
  };
  if (result.files.length === 1) {
    result.path = result.files[0].path;
    result.content = result.files[0].content;
  }
  return Object.freeze(result);
}

export { canonicalTarget as normalizeAdapterTarget };
