// Compatibility check — CI only (needs the npm registry). Packs the BUILT package exactly as it
// would be published, installs the tarball into a throwaway fixture project beside the MINIMUM
// TESTED and the LATEST version of every optional peer, and then:
//
//   1. type-checks fixtures that use every entry point (index, /vercel, /anthropic, /openai)
//      against the REAL peer types — under `moduleResolution: nodenext` as an ESM consumer
//      (.mts) AND a CommonJS consumer (.cts), under `bundler`, and under legacy `node10`
//      (typesVersions);
//   2. proves the per-format declarations: an ESM consumer's `import sdk from '…'` must be a
//      compile error (it throws at runtime — the package has no default export);
//   3. type-checks the published declarations themselves (skipLibCheck off, no DOM lib);
//   4. runs the real peer SDKs through the wrappers at runtime (canned `fetch`), with ESM
//      `import` and CJS `require`, and asserts the recorded usage.
//
// The `ai-v5` / `ai-v6` entries install the tarball with plain `npm install` into projects on an
// OLDER AI SDK major: the install must succeed (the optional peers are unconstrained, so npm never
// answers ERESOLVE), and the manual `record()` path plus the Anthropic / OpenAI wrappers must
// type-check (node10) and run (CommonJS). `/vercel` itself needs AI SDK v7 and is not exercised there.
//
// Usage (after `npm run build`):  node scripts/compat-check.mjs [--matrix min|latest|ai-v5|ai-v6[,…]] [--keep]
//
// MATRIX.min holds the minimum TESTED versions (documented in the README). The package's
// `peerDependencies` are deliberately `*` + optional — a range could only veto installs for
// entry points that never touch that peer; this script asserts they stay that way.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '@bluefyn/ai-spend-sdk';

const MATRIX = [
  {
    name: 'min',
    typescript: '5.4.5',
    deps: { ai: '7.0.0', zod: '3.25.76', '@anthropic-ai/sdk': '0.40.0', openai: '4.80.0' },
    // The Responses API arrived in openai 4.87.
    responses: false,
  },
  {
    name: 'latest',
    typescript: '5.9.3',
    deps: { ai: 'latest', zod: 'latest', '@anthropic-ai/sdk': 'latest', openai: 'latest' },
    responses: true,
  },
  {
    name: 'ai-v5',
    typescript: '5.9.3',
    deps: { ai: '5', zod: '3.25.76', '@anthropic-ai/sdk': 'latest', openai: 'latest' },
    responses: true,
    // An AI SDK major before v7: no `registerTelemetry` — only the non-Vercel paths are checked.
    legacyAi: true,
  },
  {
    name: 'ai-v6',
    typescript: '5.9.3',
    deps: { ai: '6', zod: '3.25.76', '@anthropic-ai/sdk': 'latest', openai: 'latest' },
    responses: true,
    legacyAi: true,
  },
];

function fail(message) {
  process.stderr.write(`compat-check: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`compat-check: ${message}\n`);
}

function run(command, args, cwd, { capture = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: { ...process.env, npm_config_update_notifier: 'false' } });

  if (result.error) fail(`${command} ${args.join(' ')}: ${result.error.message}`);

  return { status: result.status ?? 1, stdout: result.stdout ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Run to success or fail the check; returns stdout (stderr only shows up on failure). */
function mustRun(command, args, cwd) {
  const { status, stdout, output } = run(command, args, cwd, { capture: true });

  if (status !== 0) fail(`${command} ${args.join(' ')} failed in ${cwd}\n${output}`);

  return stdout;
}

function write(dir, file, content) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

// ---------------------------------------------------------------- fixture sources

const TYPED_USAGE = `
export const aiSpend: AiSpendClient = createAiSpend({ disabled: true });
export const telemetry: Telemetry = aiSpendTelemetry(aiSpend, { runtimeContextKey: 'aiSpend' });
registerTelemetry(telemetry);

export const anthropic: Anthropic = wrapAnthropic(new Anthropic({ apiKey: 'x' }), aiSpend, { feature: 'compat' });
const scopedAnthropic = wrapAnthropic(new Anthropic({ apiKey: 'x' }), aiSpend).withAttribution({ customer: 'c' });
export const openai: OpenAI = wrapOpenAI(new OpenAI({ apiKey: 'x' }), aiSpend).withAttribution({ feature: 'f' });

const BODY = { model: 'm', max_tokens: 1, messages: [{ role: 'user' as const, content: 'hi' }] };
const CHAT = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

export async function calls() {
  const message = await scopedAnthropic.messages.create(BODY, aiSpendOptions({ customer: 'c' }, { timeout: 1_000 }));
  const usage: CanonicalUsage = fromAnthropicUsage(message.usage);
  const model: string = message.model;

  const events = await anthropic.messages.create({ ...BODY, stream: true });
  for await (const event of events) {
    const type: string = event.type;
    void type;
  }
  events.controller.abort();

  const helper = anthropic.messages.stream(BODY).on('text', (text: string) => void text);
  const final = await helper.finalMessage();
  const outputTokens: number = final.usage.output_tokens;

  const completion = await openai.chat.completions.create(CHAT, aiSpendOptions({ customer: 'c' }));
  const chatUsage: CanonicalUsage = fromOpenAIChatUsage(completion.usage);
  const chunks = await openai.chat.completions.create({ ...CHAT, stream: true });
  for await (const chunk of chunks) {
    const content: string | null | undefined = chunk.choices[0]?.delta?.content;
    void content;
  }
  const [left, right] = chunks.tee();
  void left.toReadableStream();
  void right.controller;

  const embedding = await openai.embeddings.create({ model: 'e', input: 'x' });
  const record: AiSpendUsageRecord = { provider: 'openai', model: embedding.model, usage: fromOpenAIEmbeddingsUsage(embedding.usage), customer: 'c' };
  aiSpend.record(record);
  aiSpend.nameCustomer('c', 'Acme Inc.');
  const namesQueued: number = aiSpend.stats().customerNames.queued;
  void namesQueued;

  const carried = withContext({ customer: 'c', feature: 'jobs.enrich' }, () => carry());
  withCarried(carried, () => undefined);

  return [usage, model, outputTokens, chatUsage] as const;
}
`;

const RESPONSES_USAGE = `
export async function responses() {
  const response = await openai.responses.create({ model: 'm', input: 'hi' });
  const usage: CanonicalUsage = fromOpenAIResponsesUsage(response.usage);
  const events = await openai.responses.create({ model: 'm', input: 'hi', stream: true });
  for await (const event of events) {
    const type: string = event.type;
    void type;
  }
  const helper = openai.responses.stream({ model: 'm', input: 'hi' });
  await helper.finalResponse();

  return usage;
}
`;

function esmSource(responses) {
  return `import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { registerTelemetry } from 'ai';
import type { Telemetry } from 'ai';
import { carry, createAiSpend, fromAnthropicUsage, fromOpenAIChatUsage, fromOpenAIEmbeddingsUsage, fromOpenAIResponsesUsage, withCarried, withContext } from '${NAME}';
import type { AiSpendClient, AiSpendUsageRecord, CanonicalUsage } from '${NAME}';
import { aiSpendTelemetry } from '${NAME}/vercel';
import { aiSpendOptions, wrapAnthropic } from '${NAME}/anthropic';
import { wrapOpenAI } from '${NAME}/openai';

void fromOpenAIResponsesUsage;
${TYPED_USAGE}
${responses ? RESPONSES_USAGE : ''}`;
}

/** CommonJS consumer: our entry points (resolved through the `require` condition) + type-only peers. */
const CJS_SOURCE = `import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { createAiSpend, withContext } from '${NAME}';
import type { AiSpendClient } from '${NAME}';
import { aiSpendTelemetry } from '${NAME}/vercel';
import { aiSpendOptions, wrapAnthropic } from '${NAME}/anthropic';
import type { AiSpendWrapped } from '${NAME}/anthropic';
import { wrapOpenAI } from '${NAME}/openai';

declare const anthropicClient: Anthropic;
declare const openaiClient: OpenAI;

export const aiSpend: AiSpendClient = createAiSpend({ disabled: true });
export const anthropic: AiSpendWrapped<Anthropic> = wrapAnthropic(anthropicClient, aiSpend);
export const openai = wrapOpenAI(openaiClient, aiSpend).withAttribution({ customer: 'c' });
export const integration = aiSpendTelemetry(aiSpend);

export async function run() {
  const message = await withContext({ feature: 'cjs' }, () =>
    anthropic.messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, aiSpendOptions({ customer: 'c' })),
  );
  const completion = await openai.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

  return [message.model, completion.model];
}
`;

const DEFAULT_IMPORT_SOURCE = `import sdk from '${NAME}';

export const client = sdk;
`;

const COMPILER = { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: ['node'], skipLibCheck: true, esModuleInterop: true };

function tsconfigs(dir, responses) {
  write(dir, 'esm.mts', esmSource(responses));
  write(dir, 'cjs.cts', CJS_SOURCE);
  write(dir, 'bundler.ts', esmSource(responses));
  write(dir, 'node10.ts', CJS_SOURCE);
  write(dir, 'default-import.mts', DEFAULT_IMPORT_SOURCE);

  write(dir, 'tsconfig.nodenext.json', { compilerOptions: { ...COMPILER, module: 'nodenext', moduleResolution: 'nodenext' }, files: ['esm.mts', 'cjs.cts'] });
  write(dir, 'tsconfig.bundler.json', { compilerOptions: { ...COMPILER, module: 'esnext', moduleResolution: 'bundler' }, files: ['bundler.ts'] });
  write(dir, 'tsconfig.node10.json', { compilerOptions: { ...COMPILER, module: 'commonjs', moduleResolution: 'node10' }, files: ['node10.ts'] });
  write(dir, 'tsconfig.default-import.json', { compilerOptions: { ...COMPILER, module: 'nodenext', moduleResolution: 'nodenext' }, files: ['default-import.mts'] });

  const pkg = join('node_modules', ...NAME.split('/'));
  const declarations = ['index', 'vercel', 'anthropic', 'openai'].flatMap((entry) => [join(pkg, 'dist', 'esm', `${entry}.d.ts`), join(pkg, 'dist', 'cjs', `${entry}.d.ts`)]);

  write(dir, 'tsconfig.declarations.json', { compilerOptions: { ...COMPILER, module: 'nodenext', moduleResolution: 'nodenext', skipLibCheck: false }, files: declarations });
}

// ---------------------------------------------------------------- runtime sources

const RUNTIME_SHARED = `
const assert = ASSERT;
const events = [];
const aiSpend = sdk.createAiSpend({
  apiKey: 'bfu_compat',
  logger: {},
  warnOnMissingAttribution: false,
  fetch: async (_url, init) => {
    events.push(...JSON.parse(init.body).events);
    return { status: 202, text: async () => '{"accepted":1,"duplicates":0,"rejected":[]}' };
  },
});
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (lines) => new Response(lines.map((line) => 'data: ' + line + '\\n\\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const bodyOf = (init) => JSON.parse(String(init && init.body));

const MESSAGE = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-compat', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 30, cache_read_input_tokens: 70, cache_creation_input_tokens: 0, output_tokens: 5 } };
const USAGE = { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 60 } };
const CHUNK = (extra) => JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-compat', ...extra });

const anthropic = anthropicEntry.wrapAnthropic(
  new Anthropic({ apiKey: 'x', maxRetries: 0, fetch: async () => json(MESSAGE) }),
  aiSpend,
  { feature: 'compat.anthropic' },
);
const openai = openaiEntry.wrapOpenAI(
  new OpenAI({
    apiKey: 'x',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = bodyOf(init);
      if (!body.stream) return json({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-compat', choices: [], usage: USAGE });
      const lines = [CHUNK({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }], usage: null })];
      if (body.stream_options && body.stream_options.include_usage) lines.push(CHUNK({ choices: [], usage: USAGE }));
      lines.push('[DONE]');
      return sse(lines);
    },
  }),
  aiSpend,
  { feature: 'compat.openai' },
);

async function main() {
  assert.ok(anthropic instanceof Anthropic, 'wrapped Anthropic is still an Anthropic');
  assert.ok(openai instanceof OpenAI, 'wrapped OpenAI is still an OpenAI');

  const message = await anthropic.messages.create({ model: 'claude-compat', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }, { aiSpend: { customer: 'cus_1' } });
  assert.equal(message.id, 'msg_1');

  await openai.chat.completions.create({ model: 'gpt-compat', messages: [{ role: 'user', content: 'hi' }] });

  let chunks = 0;
  for await (const chunk of await openai.chat.completions.create({ model: 'gpt-compat', messages: [{ role: 'user', content: 'hi' }], stream: true })) {
    assert.ok(chunk.choices.length > 0, 'the injected usage chunk is hidden');
    chunks++;
  }
  assert.equal(chunks, 1);

  await aiSpend.flush();
  assert.equal(events.length, 3, 'one event per wrapped call');
  assert.deepEqual(
    events.map((e) => [e.provider, e.model, e.usage.input_tokens, e.usage.cached_input_tokens]),
    [['anthropic', 'claude-compat', 30, 70], ['openai', 'gpt-compat', 40, 60], ['openai', 'gpt-compat', 40, 60]],
  );
  assert.equal(events[0].customer, 'cus_1');

  const telemetry = vercel.aiSpendTelemetry(aiSpend);
  assert.equal(typeof telemetry.onLanguageModelCallEnd, 'function');
  return 'ok';
}
`;

const RUNTIME_ESM = `import ASSERT from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import * as sdk from '${NAME}';
import * as vercel from '${NAME}/vercel';
import * as anthropicEntry from '${NAME}/anthropic';
import * as openaiEntry from '${NAME}/openai';
${RUNTIME_SHARED}
await main();

// The real ai SDK drives the Vercel adapter (its mock models ship in \`ai/test\`).
const ai = await import('ai');
let test;
try {
  test = await import('ai/test');
} catch {
  test = undefined;
}
const Mock = test && (test.MockLanguageModelV4 ?? test.MockLanguageModelV3);
if (Mock) {
  const before = events.length;
  await ai.generateText({
    model: new Mock({
      provider: 'anthropic.messages',
      modelId: 'claude-compat',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hi' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: undefined } },
        warnings: [],
      }),
    }),
    prompt: 'hi',
    telemetry: { functionId: 'compat.vercel', integrations: [vercel.aiSpendTelemetry(aiSpend)] },
  });
  await aiSpend.flush();
  ASSERT.equal(events.length, before + 1, 'the Vercel adapter records a generateText call');
  ASSERT.equal(events.at(-1).feature, 'compat.vercel');
} else {
  process.stdout.write('runtime (esm): ai/test mock models unavailable — Vercel runtime check skipped\\n');
}
process.stdout.write('runtime (esm): ok\\n');
`;

const RUNTIME_CJS = `const ASSERT = require('node:assert/strict');
const interop = (m) => (m && m.default) || m;
const Anthropic = interop(require('@anthropic-ai/sdk'));
const OpenAI = interop(require('openai'));
const sdk = require('${NAME}');
const vercel = require('${NAME}/vercel');
const anthropicEntry = require('${NAME}/anthropic');
const openaiEntry = require('${NAME}/openai');
${RUNTIME_SHARED}
main().then(
  () => process.stdout.write('runtime (cjs): ok\\n'),
  (error) => {
    process.stderr.write(String(error && error.stack || error) + '\\n');
    process.exit(1);
  },
);
`;

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const only = argv.includes('--matrix') ? argv[argv.indexOf('--matrix') + 1] : undefined;
const keep = argv.includes('--keep');
const wanted = only ? only.split(',').map((name) => name.trim()).filter(Boolean) : undefined;
const matrix = wanted ? MATRIX.filter((entry) => wanted.includes(entry.name)) : MATRIX;

if (wanted && matrix.length !== wanted.length) fail(`unknown --matrix "${only}" (expected a comma list of ${MATRIX.map((e) => e.name).join(' | ')})`);
if (!existsSync(join(root, 'dist', 'cjs', 'index.js'))) fail('dist/ is missing — run `npm run build` first');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const peerRanges = manifest.peerDependencies ?? {};

for (const [peer, range] of Object.entries(peerRanges)) {
  assert.equal(range, '*', `peerDependencies.${peer} must stay "*" (a range vetoes npm installs of paths that never use ${peer})`);
  assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `peerDependencies.${peer} must stay optional`);
}

const work = mkdtempSync(join(tmpdir(), 'ai-spend-sdk-compat-'));

try {
  const packed = JSON.parse(mustRun('npm', ['pack', '--json', '--pack-destination', work], root));
  const tarball = join(work, packed[0].filename);

  log(`packed ${packed[0].filename} (${packed[0].files.length} files, ${packed[0].size} bytes)`);

  for (const entry of matrix) {
    const dir = join(work, entry.name);

    write(dir, 'package.json', {
      name: `ai-spend-sdk-compat-${entry.name}`,
      version: '0.0.0',
      private: true,
      dependencies: { [NAME]: `file:${tarball}`, ...entry.deps, typescript: entry.typescript, '@types/node': '^20' },
    });
    write(dir, '.npmrc', 'ignore-scripts=true\naudit=false\nfund=false\n');

    log(`[${entry.name}] installing ${Object.entries(entry.deps).map(([k, v]) => `${k}@${v}`).join(', ')}, typescript@${entry.typescript}`);
    mustRun('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], dir);

    const installed = ['ai', '@anthropic-ai/sdk', 'openai', 'typescript']
      .map((dep) => `${dep}@${JSON.parse(readFileSync(join(dir, 'node_modules', ...dep.split('/'), 'package.json'), 'utf8')).version}`)
      .join(', ');

    log(`[${entry.name}] resolved ${installed}`);

    tsconfigs(dir, entry.responses);

    const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    // The ESM / bundler fixtures import `registerTelemetry` (AI SDK v7): an older `ai` only gets the
    // CommonJS fixture (no `ai` import) and the published declarations.
    const configs = entry.legacyAi ? ['node10', 'declarations'] : ['nodenext', 'bundler', 'node10', 'declarations'];

    for (const config of configs) {
      mustRun(process.execPath, [tsc, '-p', `tsconfig.${config}.json`], dir);
      log(`[${entry.name}] tsc ${config}: ok`);
    }

    const negative = run(process.execPath, [tsc, '-p', 'tsconfig.default-import.json'], dir, { capture: true });

    if (negative.status === 0 || !/TS1192|has no default export/.test(negative.output)) {
      fail(`[${entry.name}] an ESM default import of ${NAME} must not type-check (per-format declarations broken?)\n${negative.output}`);
    }

    log(`[${entry.name}] ESM default import rejected by tsc: ok`);

    write(dir, 'runtime.mjs', RUNTIME_ESM);
    write(dir, 'runtime.cjs', RUNTIME_CJS);

    if (!entry.legacyAi) process.stdout.write(mustRun(process.execPath, ['runtime.mjs'], dir));

    process.stdout.write(mustRun(process.execPath, ['runtime.cjs'], dir));
  }

  log(`all checks passed (${matrix.map((entry) => entry.name).join(', ')})`);
} finally {
  if (keep) {
    log(`fixtures kept in ${work}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}
