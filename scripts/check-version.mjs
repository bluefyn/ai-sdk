// Release version guard: package.json `version` must equal AI_SPEND_SDK_VERSION in src/wire.ts
// (the version every event reports as `sdk.version`) and — when given — the release tag's version.
//
// Usage:  node scripts/check-version.mjs [expected-version]
//   e.g.  node scripts/check-version.mjs "${GITHUB_REF_NAME#v}"
// Prints the version on success; exits 1 with a message on any mismatch.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  process.stderr.write(`check-version: ${message}\n`);
  process.exit(1);
}

const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const wire = readFileSync(join(root, 'src', 'wire.ts'), 'utf8');
const wireVersion = /export const AI_SPEND_SDK_VERSION = '([^']+)';/.exec(wire)?.[1];
const expected = process.argv[2];

if (typeof pkgVersion !== 'string' || !SEMVER.test(pkgVersion)) fail(`package.json version "${pkgVersion}" is not a semver version`);
if (wireVersion === undefined) fail('AI_SPEND_SDK_VERSION not found in src/wire.ts');
if (wireVersion !== pkgVersion) fail(`AI_SPEND_SDK_VERSION in src/wire.ts (${wireVersion}) does not match package.json (${pkgVersion})`);
if (expected !== undefined && expected !== pkgVersion) fail(`the release tag's version (${expected}) does not match package.json (${pkgVersion})`);

process.stdout.write(`${pkgVersion}\n`);
