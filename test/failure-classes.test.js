import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(testDirectory);

const requiredFields = [
  'id',
  'title',
  'symptom',
  'invariant',
  'mechanicalControl',
  'recovery',
  'testableAcceptance',
];

const expectedIds = [
  'silent-wait-deadlock',
  'identical-tool-retries',
  'wrong-workspace-target',
  'overlapping-file-lanes',
  'hierarchy-authority-deadlock',
  'misleading-diff-claims',
  'unmerged-branch-accumulation',
  'dirty-work-loss',
  'unbounded-tool-spend',
  'unsafe-credential-handling',
  'missing-terminal-evidence',
];

async function loadCatalogue() {
  return JSON.parse(await readFile(path.join(projectRoot, 'lessons', 'failure-classes.json'), 'utf8'));
}

test('failure-class catalogue has one complete lesson for every public class', async () => {
  const catalogue = await loadCatalogue();

  assert.equal(catalogue.schemaVersion, '1');
  assert.ok(Array.isArray(catalogue.lessons));
  assert.deepEqual(catalogue.lessons.map((lesson) => lesson.id), expectedIds);
  assert.equal(new Set(catalogue.lessons.map((lesson) => lesson.id)).size, catalogue.lessons.length);

  for (const lesson of catalogue.lessons) {
    for (const field of requiredFields) {
      assert.equal(typeof lesson[field], 'string', `${lesson.id}.${field} must be a string`);
      assert.ok(lesson[field].trim().length > 0, `${lesson.id}.${field} must not be empty`);
    }
    assert.match(lesson.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test('failure-class schema requires the same contract as every lesson', async () => {
  const schema = JSON.parse(await readFile(path.join(projectRoot, 'schemas', 'failure-class.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['schemaVersion', 'lessons']);
  assert.equal(schema.properties.schemaVersion.const, '1');

  const lessonSchema = schema.$defs.failureClass;
  assert.ok(lessonSchema);
  assert.equal(lessonSchema.additionalProperties, false);
  assert.deepEqual(lessonSchema.required, requiredFields);
  assert.deepEqual(Object.keys(lessonSchema.properties).sort(), requiredFields.slice().sort());
});

test('failure-class documentation names every acceptance contract', async () => {
  const docs = await readFile(path.join(projectRoot, 'docs', 'FAILURE-CLASSES.md'), 'utf8');
  const catalogue = await loadCatalogue();
  for (const lesson of catalogue.lessons) {
    assert.ok(docs.includes(`## ${lesson.title}`), `documentation should include ${lesson.title}`);
  }
  for (const label of ['Symptom', 'Invariant', 'Mechanical control', 'Recovery', 'Testable acceptance']) {
    assert.ok(docs.includes(`**${label}:**`), `documentation should include ${label}`);
  }
});
