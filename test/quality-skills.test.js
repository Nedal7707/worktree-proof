import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skillNames = ['ui-proof-loop', 'best-practice-guard', 'token-efficient-context'];

function parseFrontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, `${file} must start with YAML frontmatter`);
  const fields = Object.fromEntries(
    [...match[1].matchAll(/^([a-z]+):\s*(.+)$/gm)].map(([, key, value]) => [key, value.trim()]),
  );
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
  return { fields, body: text.slice(match[0].length) };
}

test('quality skills use the canonical minimal Agent Skills structure', async () => {
  for (const skillName of skillNames) {
    const directory = path.join(projectRoot, 'skills', skillName);
    const skillFile = path.join(directory, 'SKILL.md');
    const interfaceFile = path.join(directory, 'agents', 'openai.yaml');
    const skillText = await readFile(skillFile, 'utf8');
    const { fields, body } = parseFrontmatter(skillText, skillFile);
    const interfaceText = await readFile(interfaceFile, 'utf8');

    assert.equal(fields.name, skillName);
    assert.ok(fields.description.length >= 25);
    assert.ok(!body.includes('TODO'));
    assert.ok(!body.includes('Structuring This Skill'));
    assert.match(interfaceText, /^\s*display_name:\s*"[^"]+"\s*$/m);
    const shortDescription = interfaceText.match(/^\s*short_description:\s*"([^"]+)"\s*$/m)?.[1];
    assert.ok(shortDescription && shortDescription.length >= 25 && shortDescription.length <= 64);
    assert.match(interfaceText, new RegExp(`default_prompt:\\s*"[^"]*\\$${skillName}`));
    assert.deepEqual((await readdir(directory)).sort(), ['SKILL.md', 'agents']);
  }
});

test('quality skills state their required evidence and safety boundaries', async () => {
  const ui = await readFile(path.join(projectRoot, 'skills/ui-proof-loop/SKILL.md'), 'utf8');
  assert.match(ui, /screens?|states?|actions?/i);
  assert.match(ui, /console.*network.*DOM|console, network, and DOM/i);
  assert.match(ui, /redact/i);
  assert.match(ui, /operator.*review|review.*operator/i);

  const guard = await readFile(path.join(projectRoot, 'skills/best-practice-guard/SKILL.md'), 'utf8');
  for (const gate of ['Security', 'Accessibility', 'Compatibility', 'Performance', 'Tests', 'Maintainability']) {
    assert.match(guard, new RegExp(`\\*\\*${gate}:`));
  }
  assert.match(guard, /source|version/i);
  assert.match(guard, /blanket|universal/i);

  const context = await readFile(path.join(projectRoot, 'skills/token-efficient-context/SKILL.md'), 'utf8');
  assert.match(context, /budget/i);
  assert.match(context, /fresh|timestamp|revision/i);
  assert.match(context, /conflict/i);
  assert.match(context, /hidden chain-of-thought|hidden reasoning/i);
  assert.match(context, /Stop|stop/i);
});

test('quality skill files are readable without extra resources', async () => {
  for (const skillName of skillNames) {
    await access(path.join(projectRoot, 'skills', skillName, 'SKILL.md'));
    await access(path.join(projectRoot, 'skills', skillName, 'agents', 'openai.yaml'));
  }
});

