# Changelog

All notable changes to `@bluefyn/ai-spend-sdk` are listed here. The package follows
[Semantic Versioning](https://semver.org/).

## 0.2.0

The first public release. It records the token usage of your AI calls, attributed to a feature and
a customer, and sends it to Bluefyn AI Spend. It sends metadata only (token counts, model,
attribution). Prompts and completions never leave your process.

0.2.0 was published by hand, from a build of commit `3e456e7`. It has a registry signature but no
provenance attestation, and the repository has no `v0.2.0` tag.
[RELEASING.md](https://github.com/bluefyn/ai-sdk/blob/main/RELEASING.md#how-020-was-published)
explains why. Later versions are published from a tag by CI, with provenance.

### Adapters

- `@bluefyn/ai-spend-sdk/vercel`: `aiSpendTelemetry`, a telemetry integration for the Vercel AI
  SDK v7 that you register with `registerTelemetry()`. Calls that pass their own integrations add
  it with `withAiSpendIntegration`. It records one event per model call: every `generateText` /
  `streamText` step, `generateObject` / `streamObject`, and `embed` / `embedMany`. Vercel AI
  Gateway calls are recorded under the `vercel_gateway` provider with the cost the gateway
  reported.
- `@bluefyn/ai-spend-sdk/anthropic`: `wrapAnthropic` for `@anthropic-ai/sdk`, including
  `AnthropicBedrock` and `AnthropicVertex`. It records `messages.create()` (streaming or not),
  `messages.stream()` and `messages.parse()`, on `messages` and `beta.messages`, with the service
  tier, fast mode, and Bedrock or Vertex regional endpoints.
- `@bluefyn/ai-spend-sdk/openai`: `wrapOpenAI` for `openai`, including `AzureOpenAI` and
  OpenAI-compatible hosts. It records `chat.completions.create()` (streaming or not, and it
  requests stream usage for you), `chat.completions.parse()`, `responses.create()`,
  `responses.parse()`, `responses.stream()` and `embeddings.create()`, with web and file search
  calls.
- Peers are optional and typed structurally. The package has no runtime dependencies.

### Recording and attribution

- `createAiSpend()` reads the ingest key from `BLUEFYN_AI_SPEND_KEY` and the API base from
  `BLUEFYN_AI_SPEND_ENDPOINT` when you do not pass `apiKey` / `endpoint`. Without a key the
  client is a no-op with one warning.
- `record()` sends any other call by hand. `fromAnthropicUsage`, `fromOpenAIChatUsage`,
  `fromOpenAIResponsesUsage`, `fromOpenAIEmbeddingsUsage` and `fromVercelUsage` convert a
  provider's usage object for it.
- `withContext()` and `current()` attribute every call inside a scope to a feature and a
  customer. `carry()` and `withCarried()` move that context across a queue or a worker.
  `defaultFeature` and `defaultCustomer` cover the rest.
- `nameCustomer()` reports a customer's display name once, apart from usage events.
- `strict: true` makes `record()` throw instead of warning, for test suites:
  `AiSpendAttributionError` on missing or invalid attribution, `AiSpendInvalidUsageError` on a
  manual usage with unknown keys or nothing billable.
- `uuidv7()` and `eventIdFrom()` give each event an id the server deduplicates on, so a retried
  job never counts a call twice.

### Delivery

- Events are buffered in memory (10,000 by default, oldest dropped first) and sent in the
  background in batches of up to 500 events.
- Network errors, 408, 429 and 5xx answers are retried with backoff and `Retry-After` for up to
  10 minutes.
- A 401 or 403 (the key was refused) or a 404 (nothing answers at the endpoint) pauses sending
  for 5 minutes with one warning. Events keep buffering and are sent once the endpoint accepts
  them again.
- `flush()` sends what is buffered. `shutdown()` drains the buffer within a deadline. A Node
  process that ends without `shutdown()` still flushes on `beforeExit`.
- `stats()` counts sent, accepted, duplicate, rejected and dropped events. `onError` receives
  typed errors (`AiSpendDeliveryError`, `AiSpendRejectedEventError`,
  `AiSpendFieldWarningError`, `AiSpendRejectedCustomerNameError`).

### Runtime

- Node.js `^20.16.0 || >=22.3.0`. The ambient context needs `process.getBuiltinModule`, which
  Node 22.0 to 22.2 lack.
- CommonJS and ES module builds, each with its own type declarations.
- In a browser bundle the client disables itself instead of failing.
