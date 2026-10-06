/**
 * LIVE contract tests for the SDK adapters and the ingest endpoint — never part of `npm test`
 * (the testMatch of jest.config.cjs does not match `*.live-spec.ts`). Run with
 * `npx jest --config jest.live.config.cts`. Each block runs only when its variables are set:
 *
 *   AI_SPEND_SDK_LIVE_ANTHROPIC_KEY   sk-ant-…  → wrapAnthropic (create, stream: true, stream()) + Vercel/Anthropic
 *   AI_SPEND_SDK_LIVE_OPENAI_KEY      sk-…      → wrapOpenAI (chat, chat stream, Responses, embeddings) + Vercel/OpenAI
 *   AI_SPEND_SDK_LIVE_INGEST_KEY      bfu_…     → SDK → ingest API smoke (202, accepted = 1, replay deduped)
 *   AI_SPEND_SDK_LIVE_INGEST_URL      API base of the environment under test, e.g. https://gateway.example.com/api
 *
 * Optional: AI_SPEND_SDK_LIVE_ANTHROPIC_MODEL / AI_SPEND_SDK_LIVE_OPENAI_MODEL (cheap model ids)
 * and AI_SPEND_SDK_LIVE_PEERS_DIR — a directory with `openai` installed (`openai` is not a
 * dev dependency of this package; jest.live.config.cts adds `<dir>/node_modules` to the module paths).
 *
 * Each call is tiny (a few dozen tokens). The contract: the usage an adapter RECORDS equals the
 * usage the provider REPORTED for that same call. Assertions only — nothing is printed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

import { captureClient } from '../__fixtures__/capture';
import { wrapAnthropic } from '../anthropic';
import { createAiSpend } from '../client';
import type { AiSpendFetch } from '../delivery';
import type { AiSpendSdkError } from '../errors';
import { wrapOpenAI } from '../openai';
import { uuidv7 } from '../uuidv7';
import { aiSpendTelemetry } from '../vercel';
import type { AiSpendWireEvent } from '../wire';

const env = (name: string) => process.env[name]?.trim() || undefined;

const ANTHROPIC_KEY = env('AI_SPEND_SDK_LIVE_ANTHROPIC_KEY');
const OPENAI_KEY = env('AI_SPEND_SDK_LIVE_OPENAI_KEY');
const INGEST_KEY = env('AI_SPEND_SDK_LIVE_INGEST_KEY');
const INGEST_URL = env('AI_SPEND_SDK_LIVE_INGEST_URL');
const ANTHROPIC_MODEL = env('AI_SPEND_SDK_LIVE_ANTHROPIC_MODEL') ?? 'claude-haiku-4-5';
const OPENAI_MODEL = env('AI_SPEND_SDK_LIVE_OPENAI_MODEL') ?? 'gpt-5.6-terra';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const PROMPT = 'Reply with the single word: OK';

type Json = Record<string, unknown>;

function obj(value: unknown) {
  const out: Json = typeof value === 'object' && value !== null ? (value as Json) : {};

  return out;
}

function num(value: unknown) {
  return typeof value === 'number' ? value : 0;
}

/** The only event a single call must produce. */
function single(events: AiSpendWireEvent[]) {
  expect(events).toHaveLength(1);

  const [event] = events;

  return { event, usage: event.usage ?? {} };
}

/** Anthropic-reported usage ↔ recorded usage (input excludes cache; writes split by TTL). */
function expectAnthropicUsage(recorded: AiSpendWireEvent['usage'], reported: unknown) {
  const u = obj(reported);

  expect(recorded?.input_tokens).toBe(num(u['input_tokens']));
  expect(recorded?.cached_input_tokens).toBe(num(u['cache_read_input_tokens']));
  expect(num(recorded?.cache_write_5m_tokens) + num(recorded?.cache_write_1h_tokens)).toBe(num(u['cache_creation_input_tokens']));
  expect(recorded?.output_tokens).toBe(num(u['output_tokens']));
}

/** OpenAI-reported usage ↔ recorded usage (reported input INCLUDES cached tokens). */
function expectOpenAIUsage(recorded: AiSpendWireEvent['usage'], reported: { input: unknown; cached: unknown; output: unknown; reasoning: unknown }) {
  expect(num(recorded?.input_tokens) + num(recorded?.cached_input_tokens)).toBe(num(reported.input));
  expect(recorded?.cached_input_tokens).toBe(num(reported.cached));
  expect(recorded?.output_tokens).toBe(num(reported.output));
  expect(recorded?.reasoning_tokens).toBe(num(reported.reasoning));
}

describe('AI Spend SDK live contract', () => {
  it('has at least one live variable set', () => {
    // Fails loudly instead of "passing" with every block skipped.
    expect(Boolean(ANTHROPIC_KEY) || Boolean(OPENAI_KEY) || Boolean(INGEST_KEY && INGEST_URL)).toBe(true);
  });

  (ANTHROPIC_KEY ? describe : describe.skip)('Anthropic', () => {
    const body = { model: ANTHROPIC_MODEL, max_tokens: 16, messages: [{ role: 'user' as const, content: PROMPT }] };

    function setup() {
      const captured = captureClient();
      const anthropic = wrapAnthropic(new Anthropic({ apiKey: ANTHROPIC_KEY, maxRetries: 2 }), captured.client, { feature: 'sdk.live_contract' });

      return { ...captured, anthropic };
    }

    it('messages.create records exactly the usage the API reported', async () => {
      const { anthropic, flushed } = setup();

      const message = await anthropic.messages.create(body);
      const { event, usage } = single(await flushed());

      expect(event).toEqual(expect.objectContaining({ provider: 'anthropic', model: message.model, status: 'success' }));
      expectAnthropicUsage(usage, message.usage);
    });

    it('messages.create({ stream: true }) records message_start + the final message_delta usage', async () => {
      const { anthropic, flushed } = setup();
      const stream = await anthropic.messages.create({ ...body, stream: true });
      let reported: Json = {};

      for await (const event of stream) {
        if (event.type === 'message_start') reported = { ...obj(event.message.usage) };

        if (event.type === 'message_delta') {
          for (const [key, value] of Object.entries(obj(event.usage))) {
            if (value !== null && value !== undefined) reported[key] = value;
          }
        }
      }

      const { event, usage } = single(await flushed());

      expect(event.status).toBe('success');
      expectAnthropicUsage(usage, reported);
    });

    it('messages.stream() records the final message usage', async () => {
      const { anthropic, flushed } = setup();

      const final = await anthropic.messages.stream(body).finalMessage();
      const { event, usage } = single(await flushed());

      expect(event.model).toBe(final.model);
      expectAnthropicUsage(usage, final.usage);
    });

    it('the Vercel adapter records what generateText reported', async () => {
      const { client, flushed } = captureClient();
      const result = await generateText({
        model: createAnthropic({ apiKey: ANTHROPIC_KEY })(ANTHROPIC_MODEL),
        prompt: PROMPT,
        maxOutputTokens: 16,
        telemetry: { functionId: 'sdk.live_contract', integrations: [aiSpendTelemetry(client)] },
      });
      const { event, usage } = single(await flushed());

      expect(event).toEqual(expect.objectContaining({ provider: 'anthropic', feature: 'sdk.live_contract', status: 'success' }));
      expect(num(usage.input_tokens) + num(usage.cached_input_tokens) + num(usage.cache_write_5m_tokens) + num(usage.cache_write_1h_tokens)).toBe(num(result.usage.inputTokens));
      expect(usage.output_tokens).toBe(num(result.usage.outputTokens));
    });
  });

  (OPENAI_KEY ? describe : describe.skip)('OpenAI', () => {
    interface LiveOpenAI {
      chat: { completions: { create(body: Json, options?: object): Promise<unknown> } };
      responses: { create(body: Json, options?: object): Promise<unknown> };
      embeddings: { create(body: Json, options?: object): Promise<unknown> };
    }

    async function setup() {
      const specifier = 'openai';
      let loaded: unknown;

      try {
        loaded = await import(specifier);
      } catch {
        loaded = undefined;
      }

      // CJS `openai` exports the class itself (a function) carrying `.OpenAI` / `.default`.
      const module = (typeof loaded === 'function' || typeof loaded === 'object') && loaded !== null ? (loaded as Json) : {};
      const OpenAI = (module['OpenAI'] ?? module['default']) as (new (options: Json) => LiveOpenAI) | undefined;

      // `openai` is not a dev dependency: install it and point AI_SPEND_SDK_LIVE_PEERS_DIR at it.
      expect(typeof OpenAI).toBe('function');

      const captured = captureClient();
      const openai = wrapOpenAI(new (OpenAI as new (options: Json) => LiveOpenAI)({ apiKey: OPENAI_KEY, maxRetries: 2 }), captured.client, { feature: 'sdk.live_contract' });

      return { ...captured, openai };
    }

    const chat = { model: OPENAI_MODEL, messages: [{ role: 'user', content: PROMPT }], max_completion_tokens: 256 };

    it('chat.completions.create records exactly the usage the API reported', async () => {
      const { openai, flushed } = await setup();

      const completion = obj(await openai.chat.completions.create(chat));
      const reported = obj(completion['usage']);
      const { event, usage } = single(await flushed());

      expect(event).toEqual(expect.objectContaining({ provider: 'openai', model: completion['model'], status: 'success' }));
      expectOpenAIUsage(usage, {
        input: reported['prompt_tokens'],
        cached: obj(reported['prompt_tokens_details'])['cached_tokens'],
        output: reported['completion_tokens'],
        reasoning: obj(reported['completion_tokens_details'])['reasoning_tokens'],
      });
    });

    it('a chat stream (caller asked for include_usage) records the usage chunk the caller saw', async () => {
      const { openai, flushed } = await setup();
      const stream = (await openai.chat.completions.create({ ...chat, stream: true, stream_options: { include_usage: true } })) as AsyncIterable<unknown>;
      let reported: Json = {};

      for await (const chunk of stream) {
        if (obj(chunk)['usage']) reported = obj(obj(chunk)['usage']);
      }

      const { usage } = single(await flushed());

      expectOpenAIUsage(usage, {
        input: reported['prompt_tokens'],
        cached: obj(reported['prompt_tokens_details'])['cached_tokens'],
        output: reported['completion_tokens'],
        reasoning: obj(reported['completion_tokens_details'])['reasoning_tokens'],
      });
    });

    it('a chat stream WITHOUT include_usage still records usage and never shows the caller the usage chunk', async () => {
      const { openai, flushed } = await setup();
      const stream = (await openai.chat.completions.create({ ...chat, stream: true })) as AsyncIterable<unknown>;
      let usageChunks = 0;

      for await (const chunk of stream) {
        if (obj(chunk)['usage']) usageChunks++;
      }

      const { event, usage } = single(await flushed());

      expect(usageChunks).toBe(0);
      expect(event.status).toBe('success');
      expect(num(usage.input_tokens) + num(usage.cached_input_tokens)).toBeGreaterThan(0);
      expect(num(usage.output_tokens)).toBeGreaterThan(0);
    });

    it('responses.create records exactly the usage the API reported (non-streaming and streaming)', async () => {
      const { openai, flushed } = await setup();
      const request = { model: OPENAI_MODEL, input: PROMPT, max_output_tokens: 256 };

      const response = obj(await openai.responses.create(request));
      const stream = (await openai.responses.create({ ...request, stream: true })) as AsyncIterable<unknown>;
      let streamed: Json = {};

      for await (const event of stream) {
        if (obj(event)['type'] === 'response.completed' || obj(event)['type'] === 'response.incomplete') streamed = obj(obj(obj(event)['response'])['usage']);
      }

      const events = await flushed();

      expect(events).toHaveLength(2);

      for (const [event, reported] of [
        [events[0], obj(response['usage'])],
        [events[1], streamed],
      ] as const) {
        expectOpenAIUsage(event.usage, {
          input: reported['input_tokens'],
          cached: obj(reported['input_tokens_details'])['cached_tokens'],
          output: reported['output_tokens'],
          reasoning: obj(reported['output_tokens_details'])['reasoning_tokens'],
        });
      }
    });

    it('embeddings.create records the input tokens the API reported', async () => {
      const { openai, flushed } = await setup();

      const response = obj(await openai.embeddings.create({ model: OPENAI_EMBEDDING_MODEL, input: PROMPT }));
      const { usage } = single(await flushed());

      expect(usage.input_tokens).toBe(num(obj(response['usage'])['prompt_tokens']));
      expect(usage.output_tokens).toBe(0);
    });

    it('the Vercel adapter records what generateText reported', async () => {
      const { client, flushed } = captureClient();
      const result = await generateText({
        model: createOpenAI({ apiKey: OPENAI_KEY })(OPENAI_MODEL),
        prompt: PROMPT,
        maxOutputTokens: 256,
        telemetry: { functionId: 'sdk.live_contract', integrations: [aiSpendTelemetry(client)] },
      });
      const { event, usage } = single(await flushed());

      expect(event.provider).toBe('openai');
      expect(num(usage.input_tokens) + num(usage.cached_input_tokens)).toBe(num(result.usage.inputTokens));
      expect(usage.output_tokens).toBe(num(result.usage.outputTokens));
    });
  });

  (INGEST_KEY && INGEST_URL ? describe : describe.skip)('SDK → ingest API', () => {
    it('delivers an event (202, accepted = 1) and dedupes its replay by event_id', async () => {
      const responses: Array<{ status: number; body: Json }> = [];
      const errors: AiSpendSdkError[] = [];

      const spyFetch: AiSpendFetch = async (url, init) => {
        const response = await fetch(url, init);
        const text = await response.text();

        responses.push({ status: response.status, body: obj(JSON.parse(text || '{}')) });

        return { status: response.status, headers: response.headers, text: async () => text };
      };

      const client = createAiSpend({ apiKey: INGEST_KEY, endpoint: INGEST_URL, fetch: spyFetch, logger: {}, onError: (error) => errors.push(error) });
      const record = {
        provider: 'anthropic',
        model: ANTHROPIC_MODEL,
        usage: { inputTokens: 3, outputTokens: 1 },
        customer: 'live-contract',
        feature: 'sdk.live_contract',
        eventId: uuidv7(),
      };

      client.record(record);
      await client.flush();
      client.record(record);
      await client.flush();
      await client.shutdown({ timeoutMs: 5_000 });

      expect(errors).toEqual([]);
      expect(responses.map((r) => r.status)).toEqual([202, 202]);
      expect(responses[0].body).toEqual(expect.objectContaining({ accepted: 1, duplicates: 0, rejected: [] }));
      expect(responses[1].body).toEqual(expect.objectContaining({ accepted: 0, duplicates: 1, rejected: [] }));
    });
  });
});
