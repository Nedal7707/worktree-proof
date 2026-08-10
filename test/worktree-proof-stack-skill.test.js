import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(testDirectory);
const skillName = 'worktree-proof-stack';
const skillDirectory = path.join(projectRoot, 'skills', skillName);

function parseFrontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, `${file} must start with YAML frontmatter`);
  const fields = Object.fromEntries(
    [...match[1].matchAll(/^([a-z]+):\s*(.+)$/gm)].map(([, key, value]) => [key, value.trim()]),
  );
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
  return { fields, body: text.slice(match[0].length) };
}

test('worktree-proof-stack uses the canonical minimal Agent Skill structure', async () => {
  const skillFile = path.join(skillDirectory, 'SKILL.md');
  const interfaceFile = path.join(skillDirectory, 'agents', 'openai.yaml');
  const skillText = await readFile(skillFile, 'utf8');
  const interfaceText = await readFile(interfaceFile, 'utf8');
  const { fields, body } = parseFrontmatter(skillText, skillFile);

  assert.equal(fields.name, skillName);
  assert.ok(fields.description.length >= 25);
  assert.doesNotMatch(body, /TODO|Structuring This Skill/);
  for (const section of ['Orient and bound', 'Prove independence', 'Reserve and execute safely', 'Integrate and verify', 'Close or recover']) {
    assert.match(body, new RegExp(`^## ${section}$`, 'm'));
  }

  const displayName = interfaceText.match(/^\s*display_name:\s*"([^"]+)"\s*$/m)?.[1];
  const shortDescription = interfaceText.match(/^\s*short_description:\s*"([^"]+)"\s*$/m)?.[1];
  const defaultPrompt = interfaceText.match(/^\s*default_prompt:\s*"([^"]+)"\s*$/m)?.[1];
  assert.ok(displayName);
  assert.ok(shortDescription);
  assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64);
  assert.ok(defaultPrompt?.includes(`$${skillName}`));

  const entries = await readdir(skillDirectory, { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['SKILL.md', 'agents']);
  const agentEntries = await readdir(path.join(skillDirectory, 'agents'), { withFileTypes: true });
  assert.deepEqual(agentEntries.map((entry) => entry.name).sort(), ['openai.yaml']);
});
