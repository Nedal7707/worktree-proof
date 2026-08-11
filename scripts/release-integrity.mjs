import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const MANIFEST_NAME = 'release-manifest.json';
const SBOM_NAME = 'sbom.cdx.json';
const CHECKSUMS_NAME = 'SHA256SUMS';
const SCHEMA_VERSION = 1;

function fail(message) {
  throw new Error(message);
}

function packageTarballName(name, version) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

function safeFileName(name) {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/u.test(name);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`could not read JSON ${filePath}: ${error.message}`);
  }
}

async function sha256(filePath) {
  const digest = createHash('sha256');
  digest.update(await readFile(filePath));
  return digest.digest('hex');
}

async function regularFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      fail(`release directory contains a non-file entry: ${entry.name}`);
    }
    if (!safeFileName(entry.name)) {
      fail(`release directory contains an unsafe file name: ${entry.name}`);
    }
  }
  return entries.map((entry) => entry.name);
}

async function ensureDirectory(directory) {
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) {
      fail(`release path is not a directory: ${directory}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      fail(`could not inspect release directory: ${error.message}`);
    }
    await mkdir(directory, { recursive: true });
  }
}

function assertSbom(sbom, packageInfo) {
  if (sbom?.bomFormat !== 'CycloneDX') {
    fail('SBOM must declare the CycloneDX format');
  }
  if (typeof sbom.specVersion !== 'string' || sbom.specVersion.length === 0) {
    fail('SBOM must declare a CycloneDX specification version');
  }
  const expectedPurl = `pkg:npm/${packageInfo.name}@${packageInfo.version}`;
  if (sbom?.metadata?.component?.purl !== expectedPurl) {
    fail(`SBOM component purl must be ${expectedPurl}`);
  }
  if (!Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    fail('SBOM must include components and dependencies arrays');
  }
}

async function packageInfo() {
  const info = await readJson(path.join(ROOT, 'package.json'));
  if (typeof info.name !== 'string' || typeof info.version !== 'string') {
    fail('package.json must include a package name and version');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(info.version)) {
    fail(`package version is not semantic: ${info.version}`);
  }
  return info;
}

function parseChecksums(text) {
  const entries = new Map();
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) {
    fail(`${CHECKSUMS_NAME} is empty`);
  }
  for (const line of lines) {
    const match = /^(?<hash>[0-9a-f]{64})  (?<name>[^\s]+)$/iu.exec(line);
    if (!match || !safeFileName(match.groups.name)) {
      fail(`invalid ${CHECKSUMS_NAME} entry: ${line}`);
    }
    if (entries.has(match.groups.name)) {
      fail(`duplicate ${CHECKSUMS_NAME} entry: ${match.groups.name}`);
    }
    entries.set(match.groups.name, match.groups.hash.toLowerCase());
  }
  return entries;
}

async function verifyChecksums(directory, files) {
  const checksumsPath = path.join(directory, CHECKSUMS_NAME);
  const entries = parseChecksums(await readFile(checksumsPath, 'utf8'));
  const expected = files.filter((name) => name !== CHECKSUMS_NAME).sort();
  const listed = [...entries.keys()].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    fail(`${CHECKSUMS_NAME} must list exactly: ${expected.join(', ')}`);
  }
  for (const name of expected) {
    const actual = await sha256(path.join(directory, name));
    if (actual !== entries.get(name)) {
      fail(`${name} does not match ${CHECKSUMS_NAME}`);
    }
  }
  return entries;
}

async function create(directory) {
  await ensureDirectory(directory);
  const packageInfoValue = await packageInfo();
  const files = await regularFiles(directory);
  const expectedTarball = packageTarballName(packageInfoValue.name, packageInfoValue.version);
  const tarballs = files.filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1 || tarballs[0] !== expectedTarball) {
    fail(`release directory must contain exactly ${expectedTarball}`);
  }
  const allowed = new Set([expectedTarball, SBOM_NAME, MANIFEST_NAME, CHECKSUMS_NAME]);
  const unexpected = files.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    fail(`release directory contains unexpected files: ${unexpected.join(', ')}`);
  }
  const sbomPath = path.join(directory, SBOM_NAME);
  const sbom = await readJson(sbomPath);
  assertSbom(sbom, packageInfoValue);

  const packagePath = path.join(directory, expectedTarball);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    package: {
      name: packageInfoValue.name,
      version: packageInfoValue.version,
      filename: expectedTarball,
      sha256: await sha256(packagePath),
    },
    sbom: {
      filename: SBOM_NAME,
      format: sbom.bomFormat,
      specVersion: sbom.specVersion,
      sha256: await sha256(sbomPath),
    },
  };
  await writeFile(
    path.join(directory, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const checksumFiles = [expectedTarball, SBOM_NAME, MANIFEST_NAME].sort();
  const checksumLines = [];
  for (const name of checksumFiles) {
    checksumLines.push(`${await sha256(path.join(directory, name))}  ${name}`);
  }
  await writeFile(path.join(directory, CHECKSUMS_NAME), `${checksumLines.join('\n')}\n`, 'utf8');
  console.log(`created ${MANIFEST_NAME} and ${CHECKSUMS_NAME} for ${expectedTarball}`);
}

async function verify(directory) {
  await ensureDirectory(directory);
  const files = await regularFiles(directory);
  const packageInfoValue = await packageInfo();
  const expectedTarball = packageTarballName(packageInfoValue.name, packageInfoValue.version);
  const expected = [expectedTarball, SBOM_NAME, MANIFEST_NAME, CHECKSUMS_NAME].sort();
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`release directory must contain exactly: ${expected.join(', ')}`);
  }
  const checksums = await verifyChecksums(directory, files);
  const manifest = await readJson(path.join(directory, MANIFEST_NAME));
  if (manifest?.schemaVersion !== SCHEMA_VERSION) {
    fail(`unsupported release manifest schema: ${manifest?.schemaVersion}`);
  }
  if (manifest?.package?.name !== packageInfoValue.name || manifest?.package?.version !== packageInfoValue.version) {
    fail('release manifest package identity does not match package.json');
  }
  if (manifest.package.filename !== expectedTarball || manifest.sbom.filename !== SBOM_NAME) {
    fail('release manifest file names are inconsistent');
  }
  if (manifest.package.sha256 !== checksums.get(expectedTarball)) {
    fail('release manifest package checksum does not match SHA256SUMS');
  }
  if (manifest.sbom.sha256 !== checksums.get(SBOM_NAME)) {
    fail('release manifest SBOM checksum does not match SHA256SUMS');
  }
  const sbom = await readJson(path.join(directory, SBOM_NAME));
  assertSbom(sbom, packageInfoValue);
  if (manifest.sbom.format !== sbom.bomFormat || manifest.sbom.specVersion !== sbom.specVersion) {
    fail('release manifest SBOM metadata does not match the SBOM');
  }
  console.log(`verified ${expectedTarball}, ${SBOM_NAME}, ${MANIFEST_NAME}, and ${CHECKSUMS_NAME}`);
}

async function checkRef(ref) {
  const packageInfoValue = await packageInfo();
  const tag = String(ref ?? '').replace(/^refs\/tags\//u, '');
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(tag)) {
    fail(`release ref must be a semantic version tag such as v0.2.0: ${ref}`);
  }
  if (packageInfoValue.version !== tag.slice(1)) {
    fail(`package.json version ${packageInfoValue.version} does not match release tag ${tag}`);
  }
  console.log(`verified ${tag} matches package.json ${packageInfoValue.name}@${packageInfoValue.version}`);
}

async function main() {
  const command = process.argv[2];
  const directory = path.resolve(process.argv[3] ?? 'dist/release');
  if (command === 'create') {
    await create(directory);
    return;
  }
  if (command === 'verify') {
    await verify(directory);
    return;
  }
  if (command === 'check-ref') {
    await checkRef(process.argv[3]);
    return;
  }
  fail('usage: node scripts/release-integrity.mjs <create|verify|check-ref> [value]');
}

main().catch((error) => {
  console.error(`release integrity check failed: ${error.message}`);
  process.exitCode = 1;
});
