// Post-build smoke check: load the built package THROUGH ITS `exports` MAP (Node package
// self-reference by name) with both `require` and `import`, for every entry point, and run a
// few calls — a broken export path, a missing `.js` extension in the ESM output, or a
// format mix-up fails here instead of in a user's app.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const NAME = '@bluefyn/ai-spend-sdk';
// `load` spells each `require` specifier as a literal: SAST flags `require` of a non-literal
// (`require(entry.path)`) as potential path traversal. `path` still drives the ESM `import()`.
const ENTRIES = [
  { path: NAME, load: () => require('@bluefyn/ai-spend-sdk'), exports: ['createAiSpend', 'withContext', 'current', 'carry', 'withCarried', 'fromAnthropicUsage', 'fromOpenAIChatUsage', 'fromOpenAIResponsesUsage', 'fromOpenAIEmbeddingsUsage', 'fromVercelUsage', 'uuidv7', 'eventIdFrom', 'AiSpendSdkError', 'AiSpendRejectedCustomerNameError', 'AiSpendFieldWarningError', 'AiSpendWarningCode'] },
  { path: `${NAME}/vercel`, load: () => require('@bluefyn/ai-spend-sdk/vercel'), exports: ['aiSpendTelemetry', 'withAiSpendIntegration'] },
  { path: `${NAME}/anthropic`, load: () => require('@bluefyn/ai-spend-sdk/anthropic'), exports: ['wrapAnthropic', 'aiSpendOptions', 'anthropicProviderOf'] },
  { path: `${NAME}/openai`, load: () => require('@bluefyn/ai-spend-sdk/openai'), exports: ['wrapOpenAI', 'aiSpendOptions', 'openAIProviderOf'] },
];

/** A capturing client: the provider wrappers must record through the real delivery path (customer names through theirs). */
function capturing(sdk) {
  const events = [];
  const names = [];
  const client = sdk.createAiSpend({
    apiKey: 'bfu_smoke',
    logger: {},
    warnOnMissingAttribution: false,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);

      if (url.endsWith(sdk.AI_SPEND_CUSTOMER_NAMES_PATH)) {
        names.push(...body.customers);

        return { status: 200, text: async () => JSON.stringify({ named: body.customers.length, unchanged: 0, rejected: [] }) };
      }

      events.push(...body.events);

      return { status: 202, text: async () => JSON.stringify({ accepted: body.events.length, duplicates: 0, rejected: [] }) };
    },
  });

  return { client, events, names };
}

async function exerciseWrappers(label, sdk, anthropicEntry, openaiEntry) {
  const { client, events, names } = capturing(sdk);
  const message = { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } };
  const anthropic = anthropicEntry.wrapAnthropic({ messages: { create: async () => message } }, client, { feature: 'smoke.anthropic' });

  assert.equal(await anthropic.messages.create({ model: 'claude-opus-5-5' }, anthropicEntry.aiSpendOptions({ customer: 'cus_1' })), message, `${label}: anthropic result untouched`);

  const chunks = [
    { model: 'gpt-5', choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }], usage: null },
    { model: 'gpt-5', choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } },
  ];
  const seenBodies = [];
  const openai = openaiEntry.wrapOpenAI(
    {
      baseURL: 'https://acme.openai.azure.com/openai',
      chat: {
        completions: {
          create: async (body) => {
            seenBodies.push(body);

            return {
              controller: new AbortController(),
              async *[Symbol.asyncIterator]() {
                yield* chunks;
              },
            };
          },
        },
      },
    },
    client,
  );
  const seen = [];

  for await (const chunk of await openai.chat.completions.create({ model: 'gpt-5', stream: true })) seen.push(chunk);

  assert.equal(seen.length, 1, `${label}: injected usage chunk is hidden`);
  assert.deepEqual(seenBodies[0].stream_options, { include_usage: true }, `${label}: include_usage injected`);

  client.nameCustomer(' cus_1 ', 'Acme Inc.');
  await client.flush();

  assert.deepEqual(names, [{ customer: 'cus_1', display_name: 'Acme Inc.' }], `${label}: customer name delivered on its own endpoint`);

  assert.equal(events.length, 2, `${label}: one event per wrapped call`);
  assert.equal(events[0].usage.cached_input_tokens, 90, `${label}: anthropic usage`);
  assert.equal(events[0].sdk.adapter, 'anthropic', `${label}: anthropic adapter`);
  assert.equal(events[1].provider, 'azure_openai', `${label}: azure provider`);
  assert.equal(events[1].usage.input_tokens, 40, `${label}: openai cached tokens split out`);
}

async function exercise(label, sdk, vercel) {
  const client = sdk.createAiSpend({ disabled: true });

  assert.equal(client.enabled, false, `${label}: disabled client`);
  client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 1 } });
  client.nameCustomer('cus_1', 'Acme Inc.');
  await client.flush();
  await client.shutdown({ timeoutMs: 10 });
  assert.deepEqual(client.stats().customerNames, { queued: 0, acknowledged: 0, rejected: 0, dropped: 0 }, `${label}: disabled client names nothing`);

  const usage = sdk.fromOpenAIChatUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } });

  assert.equal(usage.inputTokens, 200, `${label}: OpenAI cached tokens are subtracted`);
  assert.match(sdk.uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `${label}: uuidv7`);

  const seen = await sdk.withContext({ customer: 'cus_1' }, async () => {
    await Promise.resolve();

    return sdk.current()?.customer;
  });

  assert.equal(seen, 'cus_1', `${label}: ambient context propagates across await`);

  const integration = vercel.aiSpendTelemetry(client);

  assert.equal(typeof integration.onLanguageModelCallEnd, 'function', `${label}: vercel integration`);
}

const cjs = ENTRIES.map((entry) => ({ entry, module: entry.load() }));
const esm = await Promise.all(ENTRIES.map(async (entry) => ({ entry, module: await import(entry.path) })));

for (const [label, loaded] of [['cjs', cjs], ['esm', esm]]) {
  for (const { entry, module } of loaded) {
    for (const name of entry.exports) {
      assert.ok(module[name] !== undefined, `${label}: ${entry.path} exports ${name}`);
    }
  }
}

assert.ok(require.resolve(NAME).includes('/dist/cjs/'), 'require resolves to dist/cjs');

// Per-format declarations: every export condition names its own existing `.d.ts`, the ESM
// ones sit under `type: module` and import siblings with explicit `.js` specifiers.
const root = dirname(require.resolve(`${NAME}/package.json`));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const [subpath, conditions] of Object.entries(pkg.exports)) {
  if (typeof conditions === 'string') continue;

  for (const [condition, format] of [['import', 'module'], ['require', 'commonjs']]) {
    const types = join(root, conditions[condition].types);

    assert.ok(existsSync(types), `${subpath} ${condition}: ${conditions[condition].types} exists`);
    assert.equal(JSON.parse(readFileSync(join(dirname(types), 'package.json'), 'utf8')).type, format, `${subpath} ${condition}: types sit in a "${format}" scope`);

    if (format === 'module') {
      assert.doesNotMatch(readFileSync(types, 'utf8'), /from '\.\.?\/[^']*(?<!\.js)'/, `${subpath}: ESM declarations use explicit .js specifiers`);
    }
  }

  assert.equal(conditions.default, conditions.require.default, `${subpath}: the "default" condition is the CJS build`);
}

assert.ok(import.meta.resolve(NAME).includes('/dist/esm/'), 'import resolves to dist/esm');

await exercise('cjs', cjs[0].module, cjs[1].module);
await exercise('esm', esm[0].module, esm[1].module);
await exerciseWrappers('cjs', cjs[0].module, cjs[2].module, cjs[3].module);
await exerciseWrappers('esm', esm[0].module, esm[2].module, esm[3].module);
// A wrapper from one build records through a client from the other (internal handle via Symbol.for).
await exerciseWrappers('esm-wrapper/cjs-client', cjs[0].module, esm[2].module, esm[3].module);

// One process-wide AsyncLocalStorage: context set through the ESM build is visible to the CJS build.
const crossFormat = await esm[0].module.withContext({ feature: 'smoke.cross' }, async () => cjs[0].module.current()?.feature);

assert.equal(crossFormat, 'smoke.cross', 'ESM and CJS builds share the ambient context');

process.stdout.write('smoke: CJS + ESM entry points load and work (index, vercel, anthropic, openai)\n');
