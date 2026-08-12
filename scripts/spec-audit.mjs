import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const specPath = join(scriptDir, '..', 'docs', 'WORKFLOW_SPEC.md');
const helperPolicyPath = join(scriptDir, '..', 'docs', 'HELPER_POLICY.md');
const required = Array.from({ length: 10 }, (_, index) => '§' + (index + 1));

async function auditFile(path, label) {
  try {
    const source = await readFile(path, 'utf8');
    const headers = [...source.matchAll(/^##\s+(§\d+)\b[^\r\n]*$/gm)].map(
      ([, section]) => section,
    );
    const missing = required.filter((section) => !headers.includes(section));
    const duplicates = required.filter(
      (section) => headers.filter((candidate) => candidate === section).length > 1,
    );

    if (missing.length || duplicates.length) {
      if (missing.length) console.error(label + ': Missing headers: ' + missing.join(', '));
      if (duplicates.length) console.error(label + ': Duplicate headers: ' + duplicates.join(', '));
      return false;
    } else {
      console.log(label + ': Present headers: ' + required.join(', '));
      console.log(label + ': Spec audit passed: ' + path);
      return true;
    }
  } catch (error) {
    console.error(label + ': Spec audit failed: ' + error.message);
    return false;
  }
}

async function main() {
  const specOk = await auditFile(specPath, 'WORKFLOW_SPEC');
  const helperOk = await auditFile(helperPolicyPath, 'HELPER_POLICY');
  if (!specOk || !helperOk) {
    process.exitCode = 1;
  } else {
    console.log('All audits passed.');
  }
}

main();
