import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = nodePath.dirname(nodePath.dirname(fileURLToPath(import.meta.url)));
const skillRoot = nodePath.join(projectRoot, 'skills', 'resource-efficient-coding');

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'resource skill must start with YAML frontmatter');
  const fields = Object.fromEntries([...match[1].matchAll(/^([a-z]+):\s*(.+)$/gm)].map(([, key, value]) => [key, value.trim()]));
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
  return { fields, body: text.slice(match[0].length) };
}

test('resource-efficient-coding uses canonical skill metadata and safety guidance', async () => {
  const skillText = await readFile(nodePath.join(skillRoot, 'SKILL.md'), 'utf8');
  const { fields, body } = parseFrontmatter(skillText);
  assert.equal(fields.name, 'resource-efficient-coding');
  assert.ok(fields.description.length >= 25);
  for (const term of ['CPU', 'RAM', 'disk', 'concurrency', 'cache', 'bounded', 'recover', 'evidence']) assert.match(body, new RegExp(term, 'i'));
  assert.match(body, /safeToDelete: false|safeToDelete.*false/i);
  assert.match(body, /never.*delete|deletion/i);
  const interfaceText = await readFile(nodePath.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
  assert.match(interfaceText, /display_name:/);
  assert.match(interfaceText, /short_description:/);
  assert.match(interfaceText, /\$resource-efficient-coding/);
  assert.deepEqual((await readdir(skillRoot)).sort(), ['SKILL.md', 'agents']);
  await access(nodePath.join(skillRoot, 'agents', 'openai.yaml'));
});
