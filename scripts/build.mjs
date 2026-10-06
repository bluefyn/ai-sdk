// Builds the published output with the TypeScript compiler only (no bundler, no runtime deps):
//   dist/cjs   CommonJS + its declarations   (+ package.json {"type":"commonjs"})
//   dist/esm   ES2022 modules + declarations, relative specifiers rewritten to explicit
//              `.js` / `/index.js`            (+ package.json {"type":"module"})
// Declarations are emitted PER FORMAT, next to the code they describe: a `.d.ts` takes the
// module format of its nearest package.json, so under `moduleResolution: node16/nodenext` an
// ESM consumer gets ESM types (a default import is a compile error, as it is at runtime) and a
// CJS consumer gets CJS types. One shared types folder would be read as CommonJS by both.
// Source keeps extensionless relative imports, which jest and `moduleResolution: bundler` resolve
// as-is; the ESM build adds the extensions.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const configPath = join(root, 'tsconfig.build.json');

function fail(message) {
  process.stderr.write(`build: ${message}\n`);
  process.exit(1);
}

function readConfig() {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => fail(ts.flattenDiagnosticMessageText(d.messageText, '\n')) };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);

  if (!parsed) fail('could not read tsconfig.build.json');
  if (parsed.errors.length > 0) fail(formatDiagnostics(parsed.errors));

  return parsed;
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  });
}

function compile(parsed, overrides) {
  const options = { ...parsed.options, ...overrides, noEmit: false, importHelpers: false, noEmitHelpers: false };
  const program = ts.createProgram(parsed.fileNames, options);
  const emit = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics];

  if (diagnostics.length > 0) fail(formatDiagnostics(diagnostics));
}

function walk(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) walk(path, predicate, out);
    else if (predicate(path)) out.push(path);
  }

  return out;
}

/** `./x` → `./x.js` (or `./x/index.js`) for every relative specifier the emitted file references. */
function rewriteSpecifiers(dir, extension) {
  const pattern = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(['"])(\.\.?\/[^'"]*)\2/g;

  for (const file of walk(dir, (p) => p.endsWith(extension))) {
    const source = readFileSync(file, 'utf8');
    const rewritten = source.replace(pattern, (match, lead, quote, specifier) => {
      if (/\.(c|m)?js$/.test(specifier) || specifier.endsWith('.json')) return match;

      const base = resolve(dirname(file), specifier);
      const candidates = extension === '.d.ts' ? [`${base}.d.ts`, join(base, 'index.d.ts')] : [`${base}.js`, join(base, 'index.js')];
      const target = candidates.find((c) => existsSync(c));

      if (!target) fail(`unresolvable relative import "${specifier}" in ${file}`);

      const fixed = target.endsWith(`index${extension}`) ? `${specifier}/index.js` : `${specifier}.js`;

      return `${lead}${quote}${fixed}${quote}`;
    });

    if (rewritten !== source) writeFileSync(file, rewritten);
  }
}

function writePackageJson(dir, type) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}

rmSync(dist, { recursive: true, force: true });

const parsed = readConfig();

compile(parsed, {
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  outDir: join(dist, 'cjs'),
  declaration: true,
});
writePackageJson(join(dist, 'cjs'), 'commonjs');

compile(parsed, {
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  outDir: join(dist, 'esm'),
  declaration: true,
});
rewriteSpecifiers(join(dist, 'esm'), '.js');
rewriteSpecifiers(join(dist, 'esm'), '.d.ts');
writePackageJson(join(dist, 'esm'), 'module');

process.stdout.write(`build: ${parsed.fileNames.length} sources → dist/{cjs,esm} (code + per-format declarations)\n`);
