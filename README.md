# @bluefyn/ai-spend-sdk

Track what each AI model call costs you, per customer and per feature, in [Bluefyn AI Spend](https://bluefyn.ai).

The SDK records one usage event for each model call your Node.js backend makes and sends it to Bluefyn in the background. Bluefyn prices each call and shows the cost per customer, feature, model and run. The SDK sends metadata only: provider, model, token counts, status, latency and the ids you attach. It never reads or sends prompts, completions, tool arguments, embeddings or images.

- Adapters for the Vercel AI SDK, the Anthropic SDK and the OpenAI SDK, plus `record()` for any other provider.
- It never throws into your code, never blocks a call, and keeps its memory bounded.
- Zero runtime dependencies. MIT licensed. Developed at [github.com/bluefyn/ai-sdk](https://github.com/bluefyn/ai-sdk) and published from there with npm provenance.

## Requirements

- Node.js `^20.16.0 || >=22.3.0`, tested on Node.js 20, 22 and 24. ESM and CommonJS.
- A backend. In a browser the SDK turns itself off, so the key never reaches your users.
- For an adapter, the library you already use: `ai` 7 or later, `@anthropic-ai/sdk` 0.40 or later, or `openai` 4.80 or later (4.87 or later for the Responses API). They are optional peer dependencies, so the SDK installs beside any version you have.

Vercel Functions, AWS Lambda and Cloudflare Workers each need one extra line. See [Runtimes](https://app.bluefyn.ai/docs/ai-spend-sdk#sdk-runtimes).

## Get access and an SDK key

1. Email [support@bluefyn.ai](mailto:support@bluefyn.ai) to turn on AI Spend and its Product lens for your workspace. Until Bluefyn turns them on, the AI spend page has no Product lens, and the ingest endpoint refuses events with `403 feature_disabled`. The SDK then logs one warning and pauses sending.
2. As a workspace Owner or Admin, open **Payables → AI spend**, switch to the **Product** lens, and open **Settings → SDK keys**.
3. Click **Create SDK key**. Name the key and pick the environment you send from: `production`, `staging`, `development`, or a name of your own. Copy the key. It starts with `bfu_` and is shown once.

An SDK key can send usage events and customer names. It cannot read any data. Bluefyn stores each event under the environment of the key that sent it.

## Install

```sh
npm install @bluefyn/ai-spend-sdk
```

Set the key in the environment of every process that calls a model:

```sh
BLUEFYN_AI_SPEND_KEY=bfu_...
```

## Create the client once

```ts
// ai-spend.ts
import { createAiSpend } from '@bluefyn/ai-spend-sdk';

export const aiSpend = createAiSpend(); // reads BLUEFYN_AI_SPEND_KEY
```

Import this one client wherever you call a model. Without a key, the client logs one warning and does nothing, so your code runs unchanged in local development.

## Record your AI calls

Pick the library you call models with. Each example records one event per model call.

### Vercel AI SDK

```ts
// telemetry.ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, registerTelemetry } from 'ai';
import { aiSpendTelemetry } from '@bluefyn/ai-spend-sdk/vercel';
import { aiSpend } from './ai-spend';

export const aiSpendIntegration = aiSpendTelemetry(aiSpend);

registerTelemetry(aiSpendIntegration); // once, at startup

const { text } = await generateText({ model: anthropic('claude-opus-5-5'), prompt: 'Hi' });
```

`generateText`, `streamText`, `generateObject`, `streamObject`, `embed` and `embedMany` are recorded. A call that passes its own `telemetry.integrations` replaces the registered ones, so add AI Spend to that list with `withAiSpendIntegration(aiSpendIntegration, [yours])`.

### Anthropic SDK

```ts
// anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from '@bluefyn/ai-spend-sdk/anthropic';
import { aiSpend } from './ai-spend';

export const anthropic = wrapAnthropic(new Anthropic(), aiSpend);

const message = await anthropic.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hi' }],
});
```

The wrapped client has the same type, methods and return values as your client. Use it everywhere instead of `new Anthropic()`, and wrap each client once. Streams, `messages.stream()`, `messages.parse()`, and the Amazon Bedrock and Google Vertex AI clients are recorded too.

### OpenAI SDK

```ts
// openai.ts
import OpenAI from 'openai';
import { wrapOpenAI } from '@bluefyn/ai-spend-sdk/openai';
import { aiSpend } from './ai-spend';

export const openai = wrapOpenAI(new OpenAI(), aiSpend);

const response = await openai.responses.create({ model: 'gpt-5', input: 'Hi' });
const completion = await openai.chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'Hi' }] });
```

Chat Completions, Responses and embeddings are recorded, streaming included. Wrap an Azure OpenAI client, or a client of an OpenAI-compatible host, the same way.

### Any other provider

```ts
import { fromOpenAIChatUsage } from '@bluefyn/ai-spend-sdk';
import { aiSpend } from './ai-spend';

const startedAt = Date.now();
const completion = await callModel(request); // a client no adapter covers

aiSpend.record({
  provider: 'openai',
  model: completion.model,
  usage: fromOpenAIChatUsage(completion.usage),
  latencyMs: Date.now() - startedAt,
});
```

Build `usage` with a normalizer (`fromAnthropicUsage`, `fromOpenAIChatUsage`, `fromOpenAIResponsesUsage`, `fromOpenAIEmbeddingsUsage` or `fromVercelUsage`), so cached tokens are never counted twice.

## Say which customer and feature each call is for

```ts
import { aiSpend } from './ai-spend';

export async function POST(request: Request) {
  const account = await auth(request);

  // Every AI call inside, however deep, is attributed to this customer and feature.
  return aiSpend.withContext({ customer: account.id, feature: 'support.reply' }, () => handleChat(request));
}
```

- `customer` is your own opaque id for the account, never an email address.
- `feature` is a lowercase dot path such as `support.reply`. Costs roll up by prefix, so `support` includes `support.reply`.
- A call without a customer or a feature is still recorded, under **Unattributed**.

For Express middleware, NestJS interceptors, background jobs and per-call attribution, see [Attribution](https://app.bluefyn.ai/docs/ai-spend-sdk#sdk-attribution).

## Send what is buffered before the process ends

The SDK sends a batch every 5 seconds, and its timers never keep your process alive. Send the rest before the process ends:

```ts
import { waitUntil } from '@vercel/functions';
import { aiSpend } from './ai-spend';

// A long-running server, when the platform stops it:
process.on('SIGTERM', async () => {
  await aiSpend.shutdown();
  process.exit(0);
});

// Vercel Functions, before the handler returns. In Next.js, after(() => aiSpend.flush()) works too.
waitUntil(aiSpend.flush());

// AWS Lambda, before the handler returns:
await aiSpend.flush();
```

A script or a cron job calls `await aiSpend.shutdown()` before it ends.

## Check the first event

```ts
import { aiSpend } from './ai-spend';

// After one AI call, send now instead of waiting for the next batch:
await aiSpend.flush();

console.log(aiSpend.enabled, aiSpend.stats()); // true { queued: 0, sent: 1, accepted: 1, ... }
```

In Bluefyn, **Settings** in the Product lens shows the event as soon as it arrives. Its cost appears on the Overview, Customers and Features tabs about 5 minutes later. If `accepted` stays at 0, see [Troubleshooting](https://app.bluefyn.ai/docs/ai-spend-sdk#sdk-troubleshooting).

## Learn more

- [AI Spend SDK guide](https://app.bluefyn.ai/docs/ai-spend-sdk): every adapter, option and recipe.
- [Troubleshooting](https://app.bluefyn.ai/docs/ai-spend-sdk#sdk-troubleshooting): each symptom, what to check and how to fix it.
- [Limits](https://app.bluefyn.ai/docs/ai-spend-sdk#sdk-limits): batch size, event age, daily cap, rate limits and when figures appear.
- [Key management](https://app.bluefyn.ai/docs/ai-spend-sdk#sdk-keys): rotate, rename and revoke keys, disconnect the SDK, uninstall.
- [Data and privacy](https://app.bluefyn.ai/docs/ai-spend-sdk#sdk-what-is-sent): every field that leaves your servers, and how long Bluefyn keeps it.
- [REST API](https://app.bluefyn.ai/docs/ai-usage): send the same events from any language.
- [How AI Spend works](https://app.bluefyn.ai/docs/ai-spend): pricing, reconciliation with your provider bill, and alerts.
- [Changelog](https://github.com/bluefyn/ai-sdk/blob/main/CHANGELOG.md): what changed in each version.
- Support: [support@bluefyn.ai](mailto:support@bluefyn.ai). Report SDK bugs at [github.com/bluefyn/ai-sdk/issues](https://github.com/bluefyn/ai-sdk/issues).
- [Security policy](https://github.com/bluefyn/ai-sdk/blob/main/SECURITY.md): how to report a vulnerability privately.
- [Contributing](https://github.com/bluefyn/ai-sdk/blob/main/CONTRIBUTING.md): build and test the SDK, and open a pull request.

## License

MIT © Bluefyn
