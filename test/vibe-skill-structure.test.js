import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(testDirectory);
const skillNames = ['vibe-to-verified', 'tool-orchestrator'];

function parseFrontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, `${file} must start with YAML frontmatter`);
  const fields = Object.fromEntries(
    [...match[1].matchAll(/^([a-z]+):\s*(.+)$/gm)].map(([, key, value]) => [key, value.trim()]),
  );
  assert.equal(
    Object.keys(fields).sort().join(','),
    'description,name',
    `${file} frontmatter must contain only name and description`,
  );
  return { fields, body: text.slice(match[0].length) };
}

function interfaceValue(text, key) {
  return text.match(new RegExp(`^\\s*${key}:\\s*"([^"]+)"\\s*$`, 'm'))?.[1];
}

test('new vibe skills use the canonical minimal Agent Skills structure', async () => {
  for (const skillName of skillNames) {
    const skillDirectory = path.join(projectRoot, 'skills', skillName);
    const skillFile = path.join(skillDirectory, 'SKILL.md');
    const interfaceFile = path.join(skillDirectory, 'agents', 'openai.yaml');
    const skillText = await readFile(skillFile, 'utf8');
    const interfaceText = await readFile(interfaceFile, 'utf8');
    const { fields, body } = parseFrontmatter(skillText, skillFile);

    assert.equal(fields.name, skillName);
    assert.match(fields.name, /^[a-z0-9-]+$/);
    assert.ok(fields.description.length >= 25, `${skillName} description should explain a trigger`);
    assert.ok(!body.includes('TODO'), `${skillName} must not contain TODO placeholders`);
    assert.ok(!body.includes('Structuring This Skill'), `${skillName} must not contain init guidance`);

    const displayName = interfaceValue(interfaceText, 'display_name');
    const shortDescription = interfaceValue(interfaceText, 'short_description');
    const defaultPrompt = interfaceValue(interfaceText, 'default_prompt');
    assert.ok(displayName, `${skillName} needs a quoted display_name`);
    assert.ok(shortDescription, `${skillName} needs a quoted short_description`);
    assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64, `${skillName} short_description must be 25-64 characters`);
    assert.ok(defaultPrompt?.includes(`$${skillName}`), `${skillName} default_prompt must mention its skill token`);

    const entries = await readdir(skillDirectory, { withFileTypes: true });
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['SKILL.md', 'agents'], `${skillName} should not contain extra top-level files`);
    assert.ok((await readFile(path.join(skillDirectory, 'agents', 'openai.yaml'), 'utf8')).includes('interface:'), `${skillName} metadata needs an interface block`);
  }
});

test('vibe skills retain their requested safety workflow', async () => {
  const vibe = await readFile(path.join(projectRoot, 'skills', 'vibe-to-verified', 'SKILL.md'), 'utf8');
  const tools = await readFile(path.join(projectRoot, 'skills', 'tool-orchestrator', 'SKILL.md'), 'utf8');

  for (const term of ['scope', 'lane', 'test', 'preview', 'rollback', 'closure']) {
    assert.match(vibe, new RegExp(term, 'i'), `vibe-to-verified should mention ${term}`);
  }
  for (const term of ['discover', 'capabilit', 'credential', 'confirm', 'external']) {
    assert.match(tools, new RegExp(term, 'i'), `tool-orchestrator should mention ${term}`);
  }
});
