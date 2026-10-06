// README samples check. Compiles every ```ts block of README.md against the package's real
// published types (dist/, through the `exports` map) and the real types of the libraries the
// samples import, so a sample that stops compiling fails CI instead of a reader's build. A block
// whose first line is `// <name>.ts` is written under that file name, so the other blocks can
// import it (`import { aiSpend } from './ai-spend'`).
//
// Identifiers that stand for the reader's own code (`auth()`, `request`) are declared in GLOBALS
// below. A sample that uses any other undeclared name fails. So does a template literal that
// interpolates an object: it compiles, but renders "[object Object]", and as an `eventId` key it
// makes every call deduplicate into one.
//
// It also fails when README.md names a Bluefyn host that is not in PUBLIC_HOSTS, or links to a
// section of the public guide that is not in GUIDE_ANCHORS.
//
// Usage (needs dist/, so `npm run check-docs` builds first):  node scripts/check-docs.mjs [--keep]
// The libraries are installed once from the npm registry into node_modules/.cache/check-docs and
// reused while the pinned versions below are unchanged.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '@bluefyn/ai-spend-sdk';
const cache = join(root, 'node_modules', '.cache', 'check-docs');

/** The Bluefyn hosts a reader may use. Any other `*.bluefyn.ai` host is internal and fails. */
const PUBLIC_HOSTS = new Set(['bluefyn.ai', 'app.bluefyn.ai', 'gateway.bluefyn.ai']);

/**
 * The section anchors of the public guide, https://app.bluefyn.ai/docs/ai-spend-sdk. The guide is
 * built outside this repository, so this list is a copy of its section ids: when the guide renames
 * or removes a section, update this list and the README links together.
 */
const GUIDE_ANCHORS = new Set([
  'ai-spend-sdk',
  'sdk-quickstart',
  'sdk-attribution',
  'sdk-request-context',
  'sdk-background-jobs',
  'sdk-customer-names',
  'sdk-vercel',
  'sdk-anthropic',
  'sdk-openai',
  'sdk-manual',
  'sdk-idempotency',
  'sdk-runtimes',
  'sdk-options',
  'sdk-environments',
  'sdk-delivery',
  'sdk-production',
  'sdk-keys',
  'sdk-limits',
  'sdk-monitoring',
  'sdk-what-is-sent',
  'sdk-troubleshooting',
  'sdk-changelog',
  'sdk-support',
]);

/** The libraries the README samples import, at the versions they are checked against. */
const README_DEPS = {
  ai: '7.0.111',
  zod: '4.3.6',
  '@ai-sdk/anthropic': '4.0.60',
  '@anthropic-ai/sdk': '0.77.0',
  openai: '7.28.0',
  '@vercel/functions': '3.9.11',
  '@types/node': '20.19.43',
};

const GLOBALS = `import type OpenAI from 'openai';

declare global {
  const request: unknown;
  function auth(request: Request): Promise<{ id: string }>;
  function handleChat(request: Request): Promise<Response>;
  function callModel(input: unknown): Promise<OpenAI.Chat.ChatCompletion>;
}

export {};
`;

const COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  target: 'ES2022',
  lib: ['ES2022'],
  module: 'ESNext',
  moduleResolution: 'bundler',
  moduleDetection: 'force',
  types: ['node'],
  esModuleInterop: true,
  skipLibCheck: true,
};

function fail(message) {
  process.stderr.write(`check-docs: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`check-docs: ${message}\n`);
}

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Installs DEPS into the cache once per DEPS value; the stamp file records which value is there. */
function installDeps(deps) {
  const stamp = createHash('sha256').update(JSON.stringify(deps)).digest('hex');
  const stampFile = join(cache, '.deps-stamp');

  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return;

  rmSync(cache, { recursive: true, force: true });
  write(join(cache, 'package.json'), `${JSON.stringify({ name: 'ai-spend-sdk-check-docs', private: true, dependencies: deps }, null, 2)}\n`);
  log(`installing ${Object.entries(deps).map(([name, version]) => `${name}@${version}`).join(', ')}`);

  const result = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], {
    cwd: cache,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });

  if (result.status !== 0) fail(`npm install failed in ${cache}\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`);

  writeFileSync(stampFile, stamp);
}

/** Every ```ts block of a markdown file, with the line its code starts on. */
function markdownSamples(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const samples = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^```(tsx?|jsx?|typescript|javascript|mjs|cjs)\b/.test(lines[i]) && !/^```(ts|typescript)\s*$/.test(lines[i])) {
      fail(`${relative(root, path)}:${i + 1}: \`${lines[i]}\` would not be compiled; fence TypeScript samples as a bare \`\`\`ts`);
    }

    if (!/^```(ts|typescript)\s*$/.test(lines[i])) continue;

    const start = i + 1;
    let end = start;

    while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;

    if (end === lines.length) fail(`${relative(root, path)}:${i + 1}: unclosed code fence`);

    const code = lines.slice(start, end).join('\n');
    const named = /^\/\/ ([\w.-]+\.ts)\s*$/.exec(lines[start] ?? '')?.[1];

    samples.push({ file: named ?? `block-${start + 1}.ts`, code, where: (line) => `${relative(root, path)}:${start + line}` });
    i = end;
  }

  return samples;
}

function checkHosts(label, text) {
  for (const [host] of text.matchAll(/(?:[a-z0-9-]+\.)*bluefyn\.ai\b/gi)) {
    if (!PUBLIC_HOSTS.has(host.toLowerCase())) fail(`${label} names ${host}, which is not a public Bluefyn host (PUBLIC_HOSTS in scripts/check-docs.mjs)`);
  }
}

function checkGuideAnchors(label, text) {
  for (const [, anchor] of text.matchAll(/app\.bluefyn\.ai\/docs\/ai-spend-sdk#([^\s)"'>]*)/g)) {
    if (!GUIDE_ANCHORS.has(anchor)) fail(`${label} links to /docs/ai-spend-sdk#${anchor}, which is not a section of the guide (GUIDE_ANCHORS in scripts/check-docs.mjs)`);
  }
}

// ---------------------------------------------------------------- main

const keep = process.argv.includes('--keep');

if (!existsSync(join(root, 'dist', 'esm', 'index.d.ts'))) fail('dist/ is missing: run `npm run check-docs` (it builds first) or `npm run build`');

const readmePath = join(root, 'README.md');
const readmeText = readFileSync(readmePath, 'utf8');
const readme = markdownSamples(readmePath);

checkHosts('README.md', readmeText);
checkGuideAnchors('README.md', readmeText);

if (readme.length < 5) fail(`found only ${readme.length} TypeScript blocks in README.md; did the fence syntax change?`);

installDeps(README_DEPS);

const link = join(cache, 'node_modules', ...NAME.split('/'));

rmSync(link, { recursive: true, force: true });
mkdirSync(dirname(link), { recursive: true });
symlinkSync(root, link, 'dir');

const dir = join(cache, 'samples');
const files = new Map();

rmSync(dir, { recursive: true, force: true });
write(join(dir, 'globals.d.ts'), GLOBALS);

for (const sample of readme) {
  const file = join(dir, sample.file);

  if (files.has(file)) fail(`two samples write ${sample.file}: ${files.get(file).where(1)} and ${sample.where(1)}`);

  files.set(file, sample);
  write(file, `${sample.code}\n`);
}

write(join(dir, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['**/*.ts'] }, null, 2)}\n`);

const parsed = ts.getParsedCommandLineOfConfigFile(join(dir, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => fail(ts.flattenDiagnosticMessageText(d.messageText, '\n')) });
if (parsed.errors.length > 0) fail(ts.formatDiagnostics(parsed.errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => dir, getNewLine: () => '\n' }));

const program = ts.createProgram(parsed.fileNames, parsed.options);
const compiled = new Set(program.getSourceFiles().map((source) => resolve(source.fileName)));

for (const [file, sample] of files) {
  if (!compiled.has(resolve(file))) fail(`${sample.where(1)} was written but not compiled; check the samples tsconfig include`);
}

const checker = program.getTypeChecker();
const diagnostics = [...ts.getPreEmitDiagnostics(program)];

/** Object types whose string form means something; anything else renders "[object Object]". */
const STRINGABLE = new Set(['Date', 'URL', 'URLSearchParams', 'String', 'Number', 'Boolean']);

function rendersAsObject(type) {
  if (type.isUnion()) return type.types.some(rendersAsObject);

  return (type.flags & ts.TypeFlags.Object) !== 0 && !checker.isArrayType(type) && !STRINGABLE.has(type.getSymbol()?.getName() ?? '');
}

for (const sourceFile of program.getSourceFiles()) {
  if (!files.has(resolve(sourceFile.fileName))) continue;

  const visit = (node) => {
    if (ts.isTemplateSpan(node) && rendersAsObject(checker.getTypeAtLocation(node.expression))) {
      diagnostics.push({
        file: sourceFile,
        start: node.expression.getStart(sourceFile),
        code: 'DOCS',
        messageText: `\`\${${node.expression.getText(sourceFile)}}\` interpolates an object (${checker.typeToString(checker.getTypeAtLocation(node.expression))}) and renders "[object Object]"`,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

for (const diagnostic of diagnostics) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

  const code = typeof diagnostic.code === 'number' ? `TS${diagnostic.code}` : diagnostic.code;

  if (!diagnostic.file) {
    process.stderr.write(`error ${code}: ${message}\n`);
    continue;
  }

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  const sample = files.get(resolve(diagnostic.file.fileName));
  const where = sample ? sample.where(line + 1) : relative(root, diagnostic.file.fileName);
  const source = diagnostic.file.text.split('\n')[line] ?? '';

  process.stderr.write(`${where}:${character + 1} error ${code}: ${message}\n    ${source.trim()}\n`);
}

if (!keep) rmSync(dir, { recursive: true, force: true });

if (diagnostics.length > 0) fail(`${diagnostics.length} error(s) in ${readme.length} README samples`);

log(`${readme.length} README samples compile (typescript ${ts.version})`);
