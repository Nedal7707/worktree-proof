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
  assert.ok(recipe.prerequisites.length >= sc×^û¶‰žËkºwµçiÍ½¸¡µ…¹¥™•ÍÑA…Ñ ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡µ…¹¥™•ÍÐ¸‘Í¡•µ„°€œ¸¸½Í¡•µ…Ì½Ñ½½°µµ…¹¥™•ÍÐ¹Í¡•µ„¹©Í½¸œ¤ì(€™½È€¡½¹ÍÐ™¥•±½˜l¥œ°€¹…µ”œ°€‘•ÍÉ¥ÁÑ¥½¸œ°€…Ñ•½É¥•Ìœ°€…Á…‰¥±¥Ñ¥•Ìœ°€½µµ…¹œ°€ÁÉ½‰•Ìt¤ì(€€€…ÍÍ•ÉÐ¹½¬¡=‰©•Ð¹¡…Í=Ý¸¡µ…¹¥™•ÍÐ°™¥•±¤°Ñ½½°µ…¹¥™•ÍÐ¥Ìµ¥ÍÍ¥¹œ€‘í™¥•±‘õ€¤ì(€ô(€…ÍÍ•ÉÐ¹µ…Ñ ¡µ…¹¥™•ÍÐ¹¥°€½ym„µèÀ´åum„µèÀ´ä¹|µt¨¼¤ì(€…ÍÍ•ÉÐ¹½¬¡ÉÉ…ä¹¥ÍÉÉ…ä¡µ…¹¥™•ÍÐ¹…Á…‰¥±¥Ñ¥•Ì¤€˜˜µ…¹¥™•ÍÐ¹…Á…‰¥±¥Ñ¥•Ì¹±•¹Ñ €ø€À¤ì(€…ÍÍ•ÉÐ¹½¬¡µ…¹¥™•ÍÐ¹…Á…‰¥±¥Ñ¥•Ì¹±•¹Ñ €ðô€ÌÈ¤ì(€½¹ÍÐ…Á…‰¥±¥Ñ¥•Ì€ô¹•ÜM•Ð ¤ì(€™½È€¡½¹ÍÐ…Á…‰¥±¥Ñä½˜µ…¹¥™•ÍÐ¹…Á…‰¥±¥Ñ¥•Ì¤ì(€€€…ÍÍ•ÉÐ¹µ…Ñ ¡…Á…‰¥±¥Ñä°€½ym„µèÀ´åt¬ üél¹|¼µum„µèÀ´åt¬¤¨¼¤ì(€€€…ÍÍ•ÉÐ¹½¬ ……Á…‰¥±¥Ñ¥•Ì¹¡…Ì¡…Á…‰¥±¥Ñä¤°‘ÕÁ±¥…Ñ”…Á…‰¥±¥Ñä€‘í…Á…‰¥±¥Ñåõ€¤ì(€€€…Á…‰¥±¥Ñ¥•Ì¹…‘¡…Á…‰¥±¥Ñä¤ì(€ô(€…ÍÍ•ÉÐ¹•ÅÕ…°¡µ…¹¥™•ÍÐ¹ÁÉ½‰•ÍlÁt¹…ÉÍlÁt°€œ´µÙ•ÉÍ¥½¸œ¤ì(€™½È€¡½¹ÍÐ™¥±•A…Ñ ½˜É•¥Á•¥±•Ì ¤¤ì(€€€½¹ÍÐÉ•¥Á”€ôÉ•…‘)Í½¸¡™¥±•A…Ñ ¤ì(€€€™½È€¡½¹ÍÐÑ…œ½˜É•¥Á”¹Ñ½½±…Á…‰¥±¥Ñ¥•Ì¤ì(€€€€€…ÍÍ•ÉÐ¹½¬¡…Á…‰¥±¥Ñ¥•Ì¹¡…Ì¡Ñ…œ¤°€‘íÉ•¥Á”¹¥‘ôÉ•™•ÉÌÑ¼µ¥ÍÍ¥¹œ…Á…‰¥±¥Ñä€‘íÑ…õ€¤ì(€€€ô(€ô)ô¤ì()Ñ•ÍÐ ­••ÁÌÑ¡”É•ÕÍ…‰±”Ñ•µÁ±…Ñ•ÌÍ…™”°½¹É•Ñ”°…¹ÍÑÉÕÑÕÉ…±±ä½µÁ±•Ñ”œ°€ ¤€ôøì(€½¹ÍÐ•áÁ•Ñ•‘Q•µÁ±…Ñ•Ì€ôl(€€€€Ý½É­ÑÉ•”µÁÉ½½˜¹½¹™¥œ¹©Í½¸œ°(€€€€±…¹”µÁ±…¸¹©Í½¸œ°(€€€€Ñ½½°µµ…¹¥™•ÍÐ¹©Í½¸œ°(€€€€±½ÍÕÉ”µÉ••¥ÁÐ¹©Í½¸œ°(€€€€…¤µÁÉ½µÁÐµ‰É¥•™Ì¹©Í½¸œ°(€tì(€™½È€¡½¹ÍÐ¹…µ”½˜•áÁ•Ñ•‘Q•µÁ±…Ñ•Ì¤ì(€€€½¹ÍÐ™¥±•A…Ñ €ôÁ…Ñ ¹©½¥¸¡Ñ•µÁ±…Ñ•ÍI½½Ð°¹…µ”¤ì(€€€…ÍÍ•ÉÐ¹½¬¡™Ì¹•á¥ÍÑÍMå¹Œ¡™¥±•A…Ñ ¤°µ¥ÍÍ¥¹œÑ•µÁ±…Ñ”€‘í¹…µ•õ€¤ì(€€€½¹ÍÐÙ…±Õ”€ôÉ•…‘)Í½¸¡™¥±•A…Ñ ¤ì(€€€…ÍÍ•ÉÑM…™•MÑÉ¥¹Ì¡Ù…±Õ”°¹…µ”¤ì(€ô((€½¹ÍÐ½¹™¥œ€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡Ñ•µÁ±…Ñ•ÍI½½Ð°€Ý½É­ÑÉ•”µÁÉ½½˜¹½¹™¥œ¹©Í½¸œ¤¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡½¹™¥œ¹…¹½¹¥…±I•˜°€µ…¥¸œ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡½¹™¥œ¹Ý½É­ÑÉ••I½½Ð°€œ¹Ý½É­ÑÉ•”µÁÉ½½˜½Ý½É­ÑÉ••Ìœ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡½¹™¥œ¹±•…Í•MÑ½É”°€œ¹Ý½É­ÑÉ•”µÁÉ½½˜½±•…Í•Ì¹©Í½¸œ¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡½¹™¥œ¹±½ÍÕÉ•MÑ½É”°€œ¹Ý½É­ÑÉ•”µÁÉ½½˜½±½ÍÕÉ•Ìœ¤ì((€½¹ÍÐ±…¹•A±…¸€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡Ñ•µÁ±…Ñ•ÍI½½Ð°€±…¹”µÁ±…¸¹©Í½¸œ¤¤ì(€…ÍÍ•ÉÐ¹•ÅÕ…°¡±…¹•A±…¸¹Í¡•µ…Y•ÉÍ¥½¸°€œÄ¸Àœ¤ì(€…ÍÍ•ÉÐ¹½¬¡ÉÉ…ä¹¥ÍÉÉ…ä¡±…¹•A±…¸¹±…¹•Ì¤€˜˜±…¹•A±…¸¹±…¹•Ì¹±•¹Ñ €øô€È¤ì(€…ÍÍ•ÉÑ1…¹•M¡…Á”¡ì±…¹•Ìè±…¹•A±…¸¹±…¹•Ìô°€±…¹”µÁ±…¸¹©Í½¸œ¤ì((€½¹ÍÐ±½ÍÕÉ”€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡Ñ•µÁ±…Ñ•ÍI½½Ð°€±½ÍÕÉ”µÉ••¥ÁÐ¹©Í½¸œ¤¤ì(€™½È€¡½¹ÍÐ™¥•±½˜lÍ¡•µ…Y•ÉÍ¥½¸œ°€±…¹•%œ°€½ÕÑ½µ”œ°€±½Í•‘Ðœ°€…¹½¹¥…±I•˜œ°€Ñ•ÍÑÌœ°€•Ù¥‘•¹”t¤ì(€€€…ÍÍ•ÉÐ¹½¬¡=‰©•Ð¹¡…Í=Ý¸¡±½ÍÕÉ”°™¥•±¤°±½ÍÕÉ”Ñ•µÁ±…Ñ”¥Ìµ¥ÍÍ¥¹œ€‘í™¥•±‘õ€¤ì(€ô((€½¹ÍÐÁÉ½µÁÑÌ€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡Ñ•µÁ±…Ñ•ÍI½½Ð°€…¤µÁÉ½µÁÐµ‰É¥•™Ì¹©Í½¸œ¤¤ì(€…ÍÍ•ÉÐ¹½¬¡ÉÉ…ä¹¥ÍÉÉ…ä¡ÁÉ½µÁÑÌ¹‰É¥•™Ì¤€˜˜ÁÉ½µÁÑÌ¹‰É¥•™Ì¹±•¹Ñ €ôôô•áÁ•Ñ•‘I•¥Á•%‘Ì¹±•¹Ñ ¤ì(€…ÍÍ•ÉÐ¹‘••ÁÅÕ…°¡ÁÉ½µÁÑÌ¹‰É¥•™Ì¹µ…À ¡ìÉ•¥Á•%ô¤€ôøÉ•¥Á•%¤¹Í½ÉÐ ¤°l¸¸¹•áÁ•Ñ•‘I•¥Á•%‘Ít¹Í½ÉÐ ¤¤ì(€™½È€¡½¹ÍÐ‰É¥•˜½˜ÁÉ½µÁÑÌ¹‰É¥•™Ì¤ì(€€€…ÍÍ•ÉÐ¹½¬¡‰É¥•˜¹ÁÉ½µÁÐ¹±•¹Ñ €øô€ÄÈÀ¤ì(€€€…ÍÍ•ÉÐ¹½¬¡‰É¥•˜¹…¹Ñ¥½…±Ì¹±•¹Ñ €øô€È¤ì(€€€…ÍÍ•ÉÐ¹½¬¡‰É¥•˜¹É••¥ÁÑ½ÕÌ¹±•¹Ñ €øô€Ä¤ì(€ô(€…ÍÍ•ÉÑM…™•MÑÉ¥¹Ì¡™Ì¹É•…‘¥±•Må¹Œ¡Á…Ñ ¹©½¥¸¡Ñ•µÁ±…Ñ•ÍI½½Ð°€…¤µÁÉ½µÁÐµ‰É¥•˜¹µœ¤°€ÕÑ˜àœ¤°€…¤µÁÉ½µÁÐµ‰É¥•˜¹µœ¤ì)ô¤ì(