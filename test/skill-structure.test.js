import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(testDirectory);
const skillNames = ['worktree-proof', 'omnibus-maintainer', 'safe-parallel-delegation', 'protocol-client'];

function frontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, `${file} must start with YAML frontmatter`);
  const fields = Object.fromEntries(
    [...match[1].matchAll(/^([a-z]+):\s*(.+)$/gm)].map(([, key, value]) => [key, value.trim()]),
  );
  assert.equal(Object.keys(fields).sort().join(','), 'description,name', `${file} frontmatter must contain only name and description`);
  return { fields, body: text.slice(match[0].length) };
}

test('Agent Skills use the canonical minimal structure', async () => {
  for (const skillName of skillNames) {
    const skillDirectory = path.join(projectRoot, 'skills', skillName);
    const skillFile = path.join(skillDirectory, 'SKILL.md');
    const interfaceFile = path.join(skillDirectory, 'agents', 'openai.yaml');
    const skillText = await readFile(skillFile, 'utf8');
    const interfaceText = await readFile(interfaceFile, 'utf8');
    const { fields, body } = frontmatter(skillText, skillFile);

    assert.equal(fields.name, skillName);
    assert.ok(fields.description.length >= 25, `${skillName} description should explain a trigger`);
    assert.ok(!body.includes('TODO'), `${skillName} must not contain TODO placeholders`);
    assert.ok(!body.includes('Structuring This Skill'), `${skillName} must not contain init guidance`);

    const displayName = interfaceText.match(/^\s*display_name:\s*"([^"]+)"\s*$/m)?.[1];
    const shortDescription = interfaceText.match(/^\s*short_description:\s*"([^"]+)"\s*$/m)?.[1];
    const defaultPrompt = interfaceText.match(/^\s*default_prompt:\s*"([^"]+)"\s*$/m)?.[1];
    assert.ok(displayName, `${skillName} needs a quoted display_name`);
    assert.ok(shortDescription, `${skillName} needs a quoted short_description`);
    assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64, `${skillName} short_description must be 25-64 characters`);
    assert.ok(defaultPrompt.includes(`$${skillName}`), `${skillName} default_prompt must mention its skill token`);

    const entries = await readdir(skillDirectory, { withFileTypes: true });
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['SKILL.md', 'agents'], `${skillName} should not contain extra top-level files`);
  }
});
