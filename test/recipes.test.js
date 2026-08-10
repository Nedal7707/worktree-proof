import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipesRoot = path.join(projectRoot, 'recipes');
const templatesRoot = path.join(projectRoot, 'templates');
const schemaPath = path.join(projectRoot, 'schemas', 'recipe.schema.json');
const manifestPath = path.join(templatesRoot, 'tool-manifest.json');

const expectedRecipeIds = [
  'accessibility',
  'api',
  'bug-fix',
  'ci-repair',
  'database-migration',
  'deploy',
  'dependency-upgrade',
  'dirty-worktree-recovery',
  'docs',
  'feature',
  'frontend-polish',
  'idea-to-prototype',
  'incident-rescue',
  'mobile',
  'performance',
  'refactor',
  'release',
  'security-review',
];

const unsafePatterns = [
  /\brm\s+-rf\b/i,
  /\brmdir\s+\/s\b/i,
  /\b(?:del|erase)\s+\/s\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b[^\n]*--force(?:-with-lease)?/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|pwsh|powershell)\b/i,
];

const placeholderPatterns = [
  /\$\{[^}]+\}/,
  /\{\{[^}]+\}\}/,
  /<[^>\n]+>/,
  /\b(?:TODO|FIXME|TBD)\b/i,
  /\bYOUR_[A-Z0-9_]+\b/,
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function recipeFiles() {
  return fs.readdirSync(recipesRoot)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(recipesRoot, name));
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function normalizedScope(scope) {
  return scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function scopesOverlap(left, right) {
  const a = normalizedScope(left).split('/');
  const b = normalizedScope(right).split('/');
  return a.every((segment, index) => b[index] === segment)
    || b.every((segment, index) => a[index] === segment);
}

function assertSchemaBacked(recipe, schema, filePath) {
  assert.equal(schema.type, 'object', 'recipe schema must describe an object');
  assert.equal(schema.additionalProperties, false, 'recipe schema must be closed');
  for (const required of schema.required) {
    assert.ok(Object.hasOwn(recipe, required), `${filePath} is missing schema field ${required}`);
  }
  for (const key of Object.keys(recipe)) {
    assert.ok(Object.hasOwn(schema.properties, key), `${filePath} has unknown field ${key}`);
  }
  assert.match(recipe.id, new RegExp(schema.properties.id.pattern));
  assert.equal(recipe.schemaVersion, '1.0');
  assert.ok(recipe.outcomes.length >= schema.properties.outcomes.minItems);
  assert.ok(recipe.prerequisites.length >= schema.properties.prerequisites.minItems);
  assert.ok(recipe.lanes.length >= schema.properties.lanes.minItems);
  assert.ok(recipe.toolCapabilities.length >= schema.properties.toolCapabilities.minItems);
  assert.ok(recipe.qualityGates.length >= schema.properties.qualityGates.minItems);
  assert.ok(recipe.ownerConfirmationBoundaries.length >= schema.properties.ownerConfirmationBoundaries.minItems);
  assert.ok(recipe.closureReceiptRequirements.requiredFields.length >= 1);
}

function assertLaneShape(recipe, filePath) {
  const laneIds = new Set();
  const scopes = [];
  for (const lane of recipe.lanes) {
    assert.match(lane.laneId, /^[a-z0-9][a-z0-9._-]*$/);
    assert.ok(!laneIds.has(lane.laneId), `${filePath} repeats lane ${lane.laneId}`);
    laneIds.add(lane.laneId);
    const scope = normalizedScope(lane.fileScope);
    assert.ok(scope && scope !== '.', `${filePath} has an empty lane scope`);
    assert.ok(!scope.startsWith('/') && !/^[A-Za-z]:\//.test(scope), `${filePath} has an absolute lane scope`);
    assert.ok(!scope.split('/').includes('..'), `${filePath} has traversal in ${scope}`);
    for (const previous of scopes) {
      assert.equal(scopesOverlap(scope, previous), false, `${filePath} overlaps ${scope} and ${previous}`);
    }
    scopes.push(scope);
    for (const dependency of lane.dependsOn) {
      assert.ok(recipe.lanes.some(({ laneId }) => laneId === dependency), `${filePath} references unknown lane ${dependency}`);
      assert.notEqual(dependency, lane.laneId, `${filePath} makes lane ${lane.laneId} depend on itself`);
    }
    assert.ok(lane.commands.length > 0, `${filePath} lane ${lane.laneId} needs a check command`);
  }
}

function assertSafeStrings(value, filePath) {
  for (const candidate of collectStrings(value)) {
    for (const pattern of unsafePatterns) {
      assert.doesNotMatch(candidate, pattern, `${filePath} contains an unsafe command`);
    }
    for (const pattern of placeholderPatterns) {
      assert.doesNotMatch(candidate, pattern, `${filePath} contains an unresolved placeholder`);
    }
    assert.doesNotMatch(candidate, /(?:^|[\\/])(?:Users|home|private)(?:[\\/]|$)/i, `${filePath} contains a private path`);
    assert.doesNotMatch(candidate, /\b(?:password|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*[^\s]+/i, `${filePath} contains a secret assignment`);
  }
}

test('enumerates every vibe-to-verified recipe and validates it against the recipe schema', () => {
  const schema = readJson(schemaPath);
  const files = recipeFiles();
  assert.deepEqual(files.map((filePath) => path.basename(filePath, '.json')).sort(), [...expectedRecipeIds].sort());

  const recipes = files.map((filePath) => {
    const recipe = readJson(filePath);
    assertSchemaBacked(recipe, schema, path.basename(filePath));
    assert.equal(recipe.id, path.basename(filePath, '.json'));
    assertLaneShape(recipe, path.basename(filePath));
    assertSafeStrings(recipe, path.basename(filePath));
    return recipe;
  });

  for (const recipe of recipes) {
    assert.ok(recipe.outcomes.every((outcome) => outcome.evidence.length > 0));
    assert.ok(recipe.qualityGates.every((gate) => gate.evidence.length > 0));
    assert.ok(recipe.ownerConfirmationBoundaries.some((boundary) => boundary.requiresConfirmation === true));
    assert.deepEqual(recipe.closureReceiptRequirements.terminalOutcomes.sort(), ['abandoned', 'merged']);
  }
});

test('resolves every recommended tool capability through the portable tool manifest', () => {
  const manifest = readJson(manifestPath);
  assert.equal(manifest.$schema, '../schemas/tool-manifest.schema.json');
  for (const field of ['id', 'name', 'description', 'categories', 'capabilities', 'command', 'probes']) {
    assert.ok(Object.hasOwn(manifest, field), `tool manifest is missing ${field}`);
  }
  assert.match(manifest.id, /^[a-z0-9][a-z0-9._-]*$/);
  assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0);
  assert.ok(manifest.capabilities.length <= 32);
  const capabilities = new Set();
  for (const capability of manifest.capabilities) {
    assert.match(capability, /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/);
    assert.ok(!capabilities.has(capability), `duplicate capability ${capability}`);
    capabilities.add(capability);
  }
  assert.equal(manifest.probes[0].args[0], '--version');
  for (const filePath of recipeFiles()) {
    const recipe = readJson(filePath);
    for (const tag of recipe.toolCapabilities) {
      assert.ok(capabilities.has(tag), `${recipe.id} refers to missing capability ${tag}`);
    }
  }
});

test('keeps the reusable templates safe, concrete, and structurally complete', () => {
  const expectedTemplates = [
    'worktree-proof.config.json',
    'lane-plan.json',
    'tool-manifest.json',
    'closure-receipt.json',
    'ai-prompt-briefs.json',
  ];
  for (const name of expectedTemplates) {
    const filePath = path.join(templatesRoot, name);
    assert.ok(fs.existsSync(filePath), `missing template ${name}`);
    const value = readJson(filePath);
    assertSafeStrings(value, name);
  }

  const config = readJson(path.join(templatesRoot, 'worktree-proof.config.json'));
  assert.equal(config.canonicalRef, 'main');
  assert.equal(config.worktreeRoot, '.worktree-proof/worktrees');
  assert.equal(config.leaseStore, '.worktree-proof/leases.json');
  assert.equal(config.closureStore, '.worktree-proof/closures');

  const lanePlan = readJson(path.join(templatesRoot, 'lane-plan.json'));
  assert.equal(lanePlan.schemaVersion, '1.0');
  assert.ok(Array.isArray(lanePlan.lanes) && lanePlan.lanes.length >= 2);
  assertLaneShape({ lanes: lanePlan.lanes }, 'lane-plan.json');

  const closure = readJson(path.join(templatesRoot, 'closure-receipt.json'));
  for (const field of ['schemaVersion', 'laneId', 'outcome', 'closedAt', 'canonicalRef', 'tests', 'evidence']) {
    assert.ok(Object.hasOwn(closure, field), `closure template is missing ${field}`);
  }

  const prompts = readJson(path.join(templatesRoot, 'ai-prompt-briefs.json'));
  assert.ok(Array.isArray(prompts.briefs) && prompts.briefs.length === expectedRecipeIds.length);
  assert.deepEqual(prompts.briefs.map(({ recipeId }) => recipeId).sort(), [...expectedRecipeIds].sort());
  for (const brief of prompts.briefs) {
    assert.ok(brief.prompt.length >= 120);
    assert.ok(brief.antiGoals.length >= 2);
    assert.ok(brief.receiptFocus.length >= 1);
  }
  assertSafeStrings(fs.readFileSync(path.join(templatesRoot, 'ai-prompt-brief.md'), 'utf8'), 'ai-prompt-brief.md');
});
