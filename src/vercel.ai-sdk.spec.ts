/**
 * Drives the adapter with the REAL `ai` dev dependency (v7.0.111) and its mock models, and pins
 * type compatibility with the real `Telemetry` interface (checked by `npm run typecheck`). The
 * published package does not depend on `ai`. jest.config.cjs skips this spec below Node 22, the
 * `engines` floor of `ai` 7.
 */
import { embedMany, generateText, isStepCount, registerTelemetry, tool } from 'ai';
import type { Telemetry } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { withContext } from './attribution';
import { createAiSpend } from './client';
import type { AiSpendOptions } from './client';
import type { AiSpendFetch } from './delivery';
import { AiSpendAttributionError } from './errors';
import { aiSpendTelemetry, withAiSpendIntegration } from './vercel';
import type { AiSpendWireBatch, AiSpendWireEvent } from './wire';

const ANTHROPIC_RAW_USAGE = {
  input_tokens: 120,
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 4000,
  cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
  output_tokens: 42,
  server_tool_use: { web_search_requests: 1 },
  service_tier: 'standard',
};

function anthropicModel() {
  return new MockLanguageModelV4({
    provider: 'anthropic.messages',
    modelId: 'claude-opus-5-5',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'hello' }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: {
        inputTokens: { total: 4420, noCache: 120, cacheRead: 4000, cacheWrite: 300 },
        outputTokens: { total: 42, text: 42, reasoning: undefined },
        raw: ANTHROPIC_RAW_USAGE,
      },
      providerMetadata: { anthropic: { usage: ANTHROPIC_RAW_USAGE } },
      response: { id: 'msg_1', modelId: 'claude-opus-5-5-20260901', timestamp: new Date() },
      warnings: [],
    }),
  });
}

function setup(clientOptions: AiSpendOptions = {}) {
  const events: AiSpendWireEvent[] = [];

  const fetch: AiSpendFetch = async (_url, init) => {
    const batch = JSON.parse(init.body) as AiSpendWireBatch;

    events.push(...batch.events);

    return { status: 202, text: async () => JSON.stringify({ accepted: batch.events.length, duplicates: 0, rejected: [] }) };
  };

  const client = createAiSpend({ apiKey: 'bfu_test', fetch, logger: {}, warnOnMissingAttribution: false, ...clientOptions });

  return { client, events };
}

describe('aiSpendTelemetry × ai@7 (real SDK)', () => {
  it('is assignable to the real ai `Telemetry` integration type', () => {
    const { client } = setup();
    const integration: Telemetry = aiSpendTelemetry(client);

    expect(typeof integration.onLanguageModelCallEnd).toBe('function');
  });

  it('records a generateText call with runtimeContext attribution and the Anthropic cache split', async () => {
    const { client, events } = setup();

    await withContext({ user: 'usr_1' }, () =>
      generateText({
        model: anthropicModel(),
        prompt: 'hi',
        runtimeContext: { aiSpend: { customer: 'cus_1', runId: 'run_1' } },
        telemetry: { functionId: 'support.reply', includeRuntimeContext: { aiSpend: true }, integrations: [aiSpendTelemetry(client)] },
      }),
    );
    await client.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-opus-5-5-20260901',
        status: 'success',
        service_tier: 'standard',
        customer: 'cus_1',
        user: 'usr_1',
        run_id: 'run_1',
        feature: 'support.reply',
        usage: {
          input_tokens: 120,
          cached_input_tokens: 4000,
          cache_write_5m_tokens: 100,
          cache_write_1h_tokens: 200,
          output_tokens: 42,
          reasoning_tokens: 0,
          tool_requests: { web_search: 1 },
        },
        sdk: expect.objectContaining({ adapter: 'vercel' }),
      }),
    );
    expect(events[0].latency_ms).toEqual(expect.any(Number));
  });

  it('records every embedding model call of embedMany', async () => {
    const { client, events } = setup({ defaultCustomer: 'platform' });
    const model = new MockEmbeddingModelV4({
      provider: 'openai.embedding',
      modelId: 'text-embedding-3-small',
      maxEmbeddingsPerCall: 2,
      doEmbed: async ({ values }) => ({ embeddings: values.map(() => [0.1, 0.2]), usage: { tokens: values.length * 10 }, warnings: [] }),
    });

    await embedMany({ model, values: ['a', 'b', 'c'], telemetry: { functionId: 'search.index', integrations: [aiSpendTelemetry(client)] } });
    await client.flush();

    expect(events.map((e) => e.usage?.input_tokens).sort()).toEqual([10, 20]);
    expect(events.every((e) => e.provider === 'openai' && e.feature === 'search.index' && e.customer === 'platform')).toBe(true);
  });

  it('records a successful step AND the failing next step of a real multi-step run', async () => {
    const { client, events } = setup({ defaultCustomer: 'cus_1' });
    let call = 0;
    const model = new MockLanguageModelV4({
      provider: 'anthropic.messages',
      modelId: 'claude-opus-5-5',
      doGenerate: async () => {
        call++;

        if (call > 1) throw new RangeError('overloaded');

        return {
          content: [{ type: 'tool-call', toolCallId: 'tc_1', toolName: 'lookup', input: '{}' }],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: undefined } },
          response: { id: 'msg_1', modelId: 'claude-opus-5-5-20260901', timestamp: new Date() },
          warnings: [],
        };
      },
    });

    await expect(
      generateText({
        model,
        prompt: 'hi',
        maxRetries: 0,
        stopWhen: isStepCount(3),
        tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => 'found' }) },
        telemetry: { functionId: 'support.reply', integrations: [aiSpendTelemetry(client)] },
      }),
    ).rejects.toThrow('overloaded');
    await client.flush();

    expect(events.map((e) => [e.status, e.usage?.input_tokens, e.feature])).toEqual([
      ['success', 100, 'support.reply'],
      ['error', 0, 'support.reply'],
    ]);
  });

  it('strict mode fails the real model call when attribution is missing', async () => {
    const { client } = setup({ strict: true });
    const model = anthropicModel();

    await expect(generateText({ model, prompt: 'hi', telemetry: { integrations: [aiSpendTelemetry(client)] } })).rejects.toBeInstanceOf(AiSpendAttributionError);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  describe('per-call telemetry vs the registered integration (pins AI SDK v7 behaviour)', () => {
    const globalSlot = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] };
    let saved: unknown[] | undefined;

    beforeEach(() => {
      saved = globalSlot.AI_SDK_TELEMETRY_INTEGRATIONS;
      globalSlot.AI_SDK_TELEMETRY_INTEGRATIONS = [];
    });

    afterEach(() => {
      globalSlot.AI_SDK_TELEMETRY_INTEGRATIONS = saved;
    });

    it('per-call integrations REPLACE the registered ones and isEnabled: false turns tracking off — withAiSpendIntegration restores it', async () => {
      const { client, events } = setup({ defaultCustomer: 'cus_1', defaultFeature: 'chat' });
      const integration = aiSpendTelemetry(client);
      const other: Telemetry = { onStart: () => undefined };

      registerTelemetry(integration);

      await generateText({ model: anthropicModel(), prompt: 'registered only' });
      await generateText({ model: anthropicModel(), prompt: 'own integrations', telemetry: { integrations: [other] } });
      await generateText({ model: anthropicModel(), prompt: 'disabled', telemetry: { isEnabled: false } });
      await generateText({ model: anthropicModel(), prompt: 'merged', telemetry: { integrations: withAiSpendIntegration(integration, [other]) } });
      await client.flush();

      // 1st and 4th call only: if the AI SDK ever merges per-call and registered integrations, this test flags it.
      expect(events).toHaveLength(2);
    });
  });

  describe('Vercel AI Gateway (string model ids)', () => {
    function gatewayModel(costs: string[]) {
      let step = 0;

      return new MockLanguageModelV4({
        provider: 'gateway',
        modelId: 'anthropic/claude-sonnet-4.5',
        doGenerate: async () => {
          const cost = costs[step];
          const last = step === costs.length - 1;

          step++;

          return {
            content: last ? [{ type: 'text', text: 'done' }] : [{ type: 'tool-call', toolCallId: `tc_${step}`, toolName: 'lookup', input: '{}' }],
            finishReason: last ? { unified: 'stop', raw: 'stop' } : { unified: 'tool-calls', raw: 'tool_use' },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: undefined } },
            providerMetadata: { gateway: { cost, marketCost: cost, routing: { originalModelId: 'anthropic/claude-sonnet-4.5' } } },
            response: { id: `gen_${step}`, modelId: 'anthropic/claude-sonnet-4.5', timestamp: new Date() },
            warnings: [],
          };
        },
      });
    }

    it('records each step under vercel_gateway with its OWN gateway cost (never the summed total)', async () => {
      const { client, events } = setup({ defaultCustomer: 'cus_1' });

      const result = await generateText({
        model: gatewayModel(['0.0012', '0.0008']),
        prompt: 'hi',
        stopWhen: isStepCount(3),
        tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => 'found' }) },
        telemetry: { functionId: 'support.reply', integrations: [aiSpendTelemetry(client)] },
      });

      await client.flush();

      expect(result.steps).toHaveLength(2);
      expect(events.map((e) => [e.provider, e.model, e.cost?.amount])).toEqual([
        ['vercel_gateway', 'anthropic/claude-sonnet-4.5', '0.0012'],
        ['vercel_gateway', 'anthropic/claude-sonnet-4.5', '0.0008'],
      ]);
    });
  });

  describe('abortOpenCalls() against a real in-flight call', () => {
    it('records a model call still running at shutdown as aborted', async () => {
      const { client, events } = setup({ defaultCustomer: 'cus_1', defaultFeature: 'jobs.extract' });
      const integration = aiSpendTelemetry(client);
      let release: () => void = () => undefined;
      const model = new MockLanguageModelV4({
        provider: 'anthropic.messages',
        modelId: 'claude-opus-5-5',
        doGenerate: () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                content: [{ type: 'text', text: 'late' }],
                finishReason: { unified: 'stop', raw: 'end_turn' },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
                warnings: [],
              });
          }),
      });

      const running = generateText({ model, prompt: 'hi', telemetry: { integrations: [integration] } });

      await new Promise((resolve) => setImmediate(resolve));
      expect(integration.abortOpenCalls('process shutdown')).toBe(1);
      await client.shutdown();

      expect(events).toEqual([expect.objectContaining({ status: 'aborted', provider: 'anthropic', model: 'claude-opus-5-5', feature: 'jobs.extract' })]);

      release();
      await running;
    });
  });
});
