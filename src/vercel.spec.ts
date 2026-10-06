import { withContext } from './attribution';
import { createAiSpend } from './client';
import type { AiSpendClient, AiSpendOptions } from './client';
import type { AiSpendFetch } from './delivery';
import { AiSpendAttributionError } from './errors';
import { eventIdFrom } from './event-id';
import { aiSpendTelemetry, gatewayCostFromMetadata, providerFromVercel, serviceTierFromMetadata, withAiSpendIntegration } from './vercel';
import type { AiSpendTelemetryOptions } from './vercel';
import type { AiSpendUsageRecord, AiSpendWireBatch, AiSpendWireEvent } from './wire';

const ANTHROPIC_RAW_USAGE = {
  input_tokens: 2095,
  cache_creation_input_tokens: 2051,
  cache_read_input_tokens: 12304,
  cache_creation: { ephemeral_5m_input_tokens: 1024, ephemeral_1h_input_tokens: 1027 },
  output_tokens: 503,
  server_tool_use: { web_search_requests: 2 },
  service_tier: 'priority',
};

/** A v7 `onLanguageModelCallEnd` event for an Anthropic call (shape as dispatched by `ai@7`). */
function modelCallEnd(callId: string, overrides: Record<string, unknown> = {}) {
  return {
    callId,
    functionId: 'Support.Reply',
    provider: 'anthropic.messages',
    modelId: 'claude-opus-5-5-20260901',
    finishReason: 'stop' as const,
    responseId: 'msg_01',
    content: [],
    usage: {
      inputTokens: 16450,
      inputTokenDetails: { noCacheTokens: 2095, cacheReadTokens: 12304, cacheWriteTokens: 2051 },
      outputTokens: 503,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: 16953,
      raw: ANTHROPIC_RAW_USAGE,
    },
    providerMetadata: { anthropic: { usage: ANTHROPIC_RAW_USAGE, stopSequence: null } },
    performance: { responseTimeMs: 1234.4, effectiveOutputTokensPerSecond: 400, outputTokensPerSecond: undefined, inputTokensPerSecond: undefined, effectiveTotalTokensPerSecond: 1, timeToFirstOutputMs: undefined },
    ...overrides,
  };
}

function start(callId: string, overrides: Record<string, unknown> = {}) {
  return {
    callId,
    operationId: 'ai.generateText',
    provider: 'anthropic.messages',
    modelId: 'claude-opus-5-5',
    functionId: 'Support.Reply',
    runtimeContext: { aiSpend: { customer: 'cus_1', runId: 'run_1' } },
    ...overrides,
  };
}

function setup(options: AiSpendTelemetryOptions = {}, clientOptions: AiSpendOptions = {}) {
  const events: AiSpendWireEvent[] = [];

  const fetch: AiSpendFetch = async (_url, init) => {
    const batch = JSON.parse(init.body) as AiSpendWireBatch;

    events.push(...batch.events);

    return { status: 202, text: async () => JSON.stringify({ accepted: batch.events.length, duplicates: 0, rejected: [] }) };
  };

  const client = createAiSpend({ apiKey: 'bfu_test', fetch, logger: {}, warnOnMissingAttribution: false, ...clientOptions });
  const integration = aiSpendTelemetry(client, options);

  return { client, integration, events };
}

describe('aiSpendTelemetry (Vercel AI SDK v7)', () => {
  it('emits ONE event per model call with normalized usage, response model, latency and tier', async () => {
    const { client, integration, events } = setup();

    integration.onStart(start('call-1'));
    integration.onLanguageModelCallEnd(modelCallEnd('call-1'));
    integration.onLanguageModelCallEnd(modelCallEnd('call-1', { usage: { inputTokens: 10, inputTokenDetails: { noCacheTokens: 10 }, outputTokens: 5 }, providerMetadata: undefined }));
    integration.onEnd({ callId: 'call-1' });
    await client.flush();

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-opus-5-5-20260901',
        status: 'success',
        latency_ms: 1234,
        service_tier: 'priority',
        customer: 'cus_1',
        run_id: 'run_1',
        feature: 'support.reply',
        usage: {
          input_tokens: 2095,
          cached_input_tokens: 12304,
          cache_write_5m_tokens: 1024,
          cache_write_1h_tokens: 1027,
          output_tokens: 503,
          reasoning_tokens: 0,
          tool_requests: { web_search: 2 },
        },
        sdk: expect.objectContaining({ adapter: 'vercel' }),
      }),
    );
    expect(events[1].usage).toEqual(expect.objectContaining({ input_tokens: 10, output_tokens: 5 }));
    expect(events[0].event_id).not.toBe(events[1].event_id);
  });

  it('resolves attribution: resolveAttribution → runtimeContext → ambient context', async () => {
    const resolveAttribution = jest.fn(() => ({ feature: 'billing.resolve', tags: { surface: 'api' } }));
    const { client, integration, events } = setup({ resolveAttribution });

    withContext({ customer: 'cus_ambient', user: 'usr_ambient', feature: 'ambient.feature', tags: { region: 'eu' } }, () => {
      integration.onStart(start('call-2', { runtimeContext: { aiSpend: { customer: 'cus_runtime' } } }));
    });
    integration.onLanguageModelCallEnd(modelCallEnd('call-2'));
    integration.onEnd({ callId: 'call-2' });
    await client.flush();

    expect(resolveAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-2', functionId: 'Support.Reply', provider: 'anthropic.messages', modelId: 'claude-opus-5-5', operationId: 'ai.generateText' }),
    );
    expect(events[0]).toEqual(
      expect.objectContaining({ customer: 'cus_runtime', user: 'usr_ambient', feature: 'billing.resolve', tags: { region: 'eu', surface: 'api' } }),
    );
  });

  it('derives the feature from functionId only when nothing else set it and it is a valid path', async () => {
    const { client, integration, events } = setup();
    const off = setup({ featureFromFunctionId: false });

    integration.onStart(start('a', { functionId: 'Not A Feature' }));
    integration.onLanguageModelCallEnd(modelCallEnd('a'));
    off.integration.onStart(start('b'));
    off.integration.onLanguageModelCallEnd(modelCallEnd('b'));
    await client.flush();
    await off.client.flush();

    expect(events[0].feature).toBeUndefined();
    expect(off.events[0].feature).toBeUndefined();
  });

  it('reads a runtimeContext under a custom key', async () => {
    const { client, integration, events } = setup({ runtimeContextKey: 'billing' });

    integration.onStart(start('c', { runtimeContext: { billing: { customer: 'cus_custom' }, aiSpend: { customer: 'ignored' } } }));
    integration.onLanguageModelCallEnd(modelCallEnd('c'));
    await client.flush();

    expect(events[0].customer).toBe('cus_custom');
  });

  it('emits generateObject usage from onObjectStepEnd', async () => {
    const { client, integration, events } = setup();

    integration.onStart(start('obj', { operationId: 'ai.generateObject', provider: 'openai.responses', modelId: 'gpt-5', runtimeContext: undefined }));
    integration.onObjectStepEnd({
      callId: 'obj',
      provider: 'openai.responses',
      modelId: 'gpt-5',
      usage: { inputTokens: 2006, inputTokenDetails: { noCacheTokens: 86, cacheReadTokens: 1920 }, outputTokens: 300, outputTokenDetails: { reasoningTokens: 192 } },
      providerMetadata: { openai: { serviceTier: 'flex' } },
      response: { modelId: 'gpt-5-2025-08-07' },
    });
    integration.onEnd({ callId: 'obj' });
    await client.flush();

    expect(events[0]).toEqual(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5-2025-08-07',
        service_tier: 'flex',
        usage: expect.objectContaining({ input_tokens: 86, cached_input_tokens: 1920, output_tokens: 300, reasoning_tokens: 192 }),
      }),
    );
    expect(events[0].latency_ms).toEqual(expect.any(Number));
  });

  it('emits one event per embedding model call', async () => {
    const { client, integration, events } = setup();

    integration.onStart(start('emb', { operationId: 'ai.embedMany', provider: 'openai.embedding', modelId: 'text-embedding-3-small' }));
    integration.onEmbedStart({ callId: 'emb', embedCallId: 'e1', provider: 'openai.embedding', modelId: 'text-embedding-3-small' });
    integration.onEmbedStart({ callId: 'emb', embedCallId: 'e2', provider: 'openai.embedding', modelId: 'text-embedding-3-small' });
    integration.onEmbedEnd({ callId: 'emb', embedCallId: 'e1', provider: 'openai.embedding', modelId: 'text-embedding-3-small', usage: { tokens: 800 } });
    integration.onEmbedEnd({ callId: 'emb', embedCallId: 'e2', provider: 'openai.embedding', modelId: 'text-embedding-3-small', usage: { tokens: 200 } });
    integration.onEnd({ callId: 'emb' });
    await client.flush();

    expect(events.map((e) => [e.provider, e.model, e.usage?.input_tokens, e.usage?.output_tokens])).toEqual([
      ['openai', 'text-embedding-3-small', 800, 0],
      ['openai', 'text-embedding-3-small', 200, 0],
    ]);
  });

  it('records a zero-token error/aborted event when the operation reported no model call', async () => {
    const { client, integration, events } = setup();

    integration.onStart(start('err'));
    integration.onError({ callId: 'err', error: new Error('overloaded') });
    integration.onStart(start('abort'));
    integration.onAbort({ callId: 'abort' });
    integration.onStart(start('partial'));
    integration.onLanguageModelCallEnd(modelCallEnd('partial'));
    integration.onError({ callId: 'partial', error: new Error('tool failed') }); // no model call open → nothing extra
    await client.flush();

    expect(events.map((e) => [e.status, e.usage?.input_tokens])).toEqual([
      ['error', 0],
      ['aborted', 0],
      ['success', 2095],
    ]);
  });

  it('records the failing step of a multi-step run even after earlier steps succeeded', async () => {
    const { client, integration, events } = setup();

    integration.onStart(start('multi'));
    integration.onLanguageModelCallStart({ callId: 'multi', provider: 'anthropic.messages', modelId: 'claude-opus-5-5' });
    integration.onLanguageModelCallEnd(modelCallEnd('multi'));
    integration.onLanguageModelCallStart({ callId: 'multi', provider: 'anthropic.messages', modelId: 'claude-sonnet-5' }); // step 2
    integration.onError({ callId: 'multi', error: Object.assign(new Error('overloaded'), { statusCode: 529 }) });
    integration.onStart(start('aborted-step'));
    integration.onLanguageModelCallStart({ callId: 'aborted-step', provider: 'anthropic.messages', modelId: 'claude-opus-5-5' });
    integration.onLanguageModelCallEnd(modelCallEnd('aborted-step'));
    integration.onLanguageModelCallStart({ callId: 'aborted-step', provider: 'anthropic.messages', modelId: 'claude-opus-5-5' });
    integration.onAbort({ callId: 'aborted-step' });
    await client.flush();

    expect(events.map((e) => [e.status, e.model, e.usage?.input_tokens, e.customer])).toEqual([
      ['success', 'claude-opus-5-5-20260901', 2095, 'cus_1'],
      ['error', 'claude-sonnet-5', 0, 'cus_1'],
      ['success', 'claude-opus-5-5-20260901', 2095, 'cus_1'],
      ['aborted', 'claude-opus-5-5', 0, 'cus_1'],
    ]);
  });

  it('uses usage carried by the error of a failed model call', async () => {
    const { client, integration, events } = setup();

    integration.onStart(start('obj', { operationId: 'ai.generateObject' }));
    integration.onObjectStepStart({ callId: 'obj', provider: 'anthropic.messages', modelId: 'claude-opus-5-5' });
    integration.onError({ callId: 'obj', error: { name: 'SomeError', usage: { inputTokens: 50, inputTokenDetails: { noCacheTokens: 50 }, outputTokens: 7 } } });
    await client.flush();

    expect(events[0]).toEqual(expect.objectContaining({ status: 'error', usage: expect.objectContaining({ input_tokens: 50, output_tokens: 7 }) }));
  });

  it('keeps a long-running operation alive (sweep keys off inactivity, not age)', async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 30, 12) });

    try {
      const { client, integration, events } = setup();

      integration.onStart(start('long')); // runtimeContext customer: cus_1
      integration.onStart(start('idle', { runtimeContext: { aiSpend: { customer: 'cus_idle' } } }));

      for (let minute = 0; minute < 50; minute += 10) {
        jest.advanceTimersByTime(10 * 60_000);
        integration.onToolExecutionEnd({ callId: 'long' }); // activity every 10 min
      }

      integration.onStart(start('trigger-sweep'));
      integration.onLanguageModelCallEnd(modelCallEnd('long'));
      integration.onLanguageModelCallEnd(modelCallEnd('idle')); // idle > 30 min: swept → re-opened without its runtimeContext
      await client.flush();

      expect(events.map((e) => e.customer)).toEqual(['cus_1', undefined]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never throws from a hook, whatever it is handed', () => {
    const { integration } = setup({
      resolveAttribution: () => {
        throw new Error('user resolver bug');
      },
    });
    const garbage: unknown[] = [undefined, null, 42, 'x', {}, { callId: 7 }, { callId: 'g', usage: 'nope', performance: null }];

    for (const value of garbage) {
      const event = value as Parameters<typeof integration.onStart>[0];

      expect(() => integration.onStart(event)).not.toThrow();
      expect(() => integration.onLanguageModelCallEnd(event)).not.toThrow();
      expect(() => integration.onObjectStepEnd(event)).not.toThrow();
      expect(() => integration.onEmbedStart(event)).not.toThrow();
      expect(() => integration.onEmbedEnd(event)).not.toThrow();
      expect(() => integration.onEnd(event)).not.toThrow();
      expect(() => integration.onAbort(event)).not.toThrow();
      expect(() => integration.onError(value)).not.toThrow();
    }
  });

  it('falls back to the public record() for a client that is not an SDK client', () => {
    const recorded: AiSpendUsageRecord[] = [];
    const double: AiSpendClient = {
      enabled: true,
      record: (usage) => recorded.push(usage),
      nameCustomer: () => undefined,
      flush: async () => undefined,
      shutdown: async () => undefined,
      stats: () => ({
        queued: 0,
        sent: 0,
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        dropped: 0,
        retries: 0,
        failedBatches: 0,
        overflowedFeatures: 0,
        droppedTagKeys: 0,
        fieldWarnings: 0,
        invalidUsage: 0,
        paused: false,
        customerNames: { queued: 0, acknowledged: 0, rejected: 0, dropped: 0 },
      }),
      withContext: (_attrs, fn) => fn(),
      current: () => undefined,
      carry: () => undefined,
      withCarried: (_carrier, fn) => fn(),
    };
    const integration = aiSpendTelemetry(double);

    integration.onStart(start('d'));
    integration.onLanguageModelCallEnd(modelCallEnd('d'));

    expect(recorded).toEqual([expect.objectContaining({ provider: 'anthropic', customer: 'cus_1', feature: 'support.reply' })]);
  });

  describe('strict mode', () => {
    it('fails the model call before it runs when attribution is incomplete', async () => {
      const { integration } = setup({}, { strict: true });
      const execute = jest.fn(async () => 'model output');

      integration.onStart(start('s1', { runtimeContext: undefined, functionId: undefined }));
      expect(integration.executeLanguageModelCall).toBeDefined();
      expect(() => integration.executeLanguageModelCall?.({ callId: 's1', execute })).toThrow(AiSpendAttributionError);
      expect(execute).not.toHaveBeenCalled();

      integration.onStart(start('s2'));
      await expect(integration.executeLanguageModelCall?.({ callId: 's2', execute })).resolves.toBe('model output');
    });

    it('adds no execute wrapper for a non-strict client', () => {
      expect(setup().integration.executeLanguageModelCall).toBeUndefined();
    });
  });

  describe('helpers', () => {
    it.each([
      ['anthropic.messages', 'anthropic'],
      ['openai.chat', 'openai'],
      ['openai.responses', 'openai'],
      ['azure.chat', 'azure_openai'],
      ['amazon-bedrock', 'bedrock'],
      ['google.generative-ai', 'google'],
      ['google.vertex.chat', 'google'],
      ['vertex.anthropic.messages', 'google'],
      ['mistral.chat', 'mistral'],
      ['gateway', 'vercel_gateway'],
      [undefined, 'unknown'],
    ])('maps provider id %p → %p', (id, expected) => {
      expect(providerFromVercel(id)).toBe(expected);
    });

    it('reads the service tier from provider metadata (Anthropic fast mode → fast)', () => {
      expect(serviceTierFromMetadata({ anthropic: { usage: { service_tier: 'batch' } } })).toBe('batch');
      expect(serviceTierFromMetadata({ anthropic: { usage: { service_tier: 'standard', speed: 'fast' } } })).toBe('fast');
      expect(serviceTierFromMetadata({ openai: { serviceTier: 'priority' } })).toBe('priority');
      expect(serviceTierFromMetadata(undefined)).toBeUndefined();
    });

    it('reads the gateway cost of one call (BYOK: the market cost)', () => {
      expect(gatewayCostFromMetadata({ gateway: { cost: '0.0012', marketCost: '0.0015' } })).toEqual({ amount: '0.0012', currency: 'USD' });
      expect(gatewayCostFromMetadata({ gateway: { cost: '0', marketCost: '0.0015' } })).toEqual({ amount: '0.0015', currency: 'USD' });
      expect(gatewayCostFromMetadata({ gateway: { cost: 0.5 } })).toEqual({ amount: 0.5, currency: 'USD' });
      expect(gatewayCostFromMetadata({ gateway: { cost: '-1' } })).toBeUndefined();
      expect(gatewayCostFromMetadata({ gateway: { routing: {} } })).toBeUndefined();
      expect(gatewayCostFromMetadata(undefined)).toBeUndefined();
    });

    it('withAiSpendIntegration puts AI Spend in a per-call integrations array (once)', () => {
      const { integration } = setup();
      const other = { onStart: () => undefined };

      expect(withAiSpendIntegration(integration, [other])).toEqual([integration, other]);
      expect(withAiSpendIntegration(integration, other)).toEqual([integration, other]);
      expect(withAiSpendIntegration(integration)).toEqual([integration]);
      expect(withAiSpendIntegration(integration, [integration, other])).toEqual([integration, other]);
    });
  });

  describe('Vercel AI Gateway', () => {
    it('records a gateway call as vercel_gateway with the gateway model id and the per-call gateway cost', async () => {
      const { client, integration, events } = setup();
      const usage = { inputTokens: 100, inputTokenDetails: { noCacheTokens: 100 }, outputTokens: 10, outputTokenDetails: {} };

      integration.onStart(start('gw-1', { provider: 'gateway', modelId: 'anthropic/claude-sonnet-4.5' }));
      integration.onLanguageModelCallEnd(
        modelCallEnd('gw-1', { provider: 'gateway', modelId: 'anthropic/claude-sonnet-4.5', usage, providerMetadata: { gateway: { cost: '0.0012', routing: {} } } }),
      );
      integration.onLanguageModelCallEnd(
        modelCallEnd('gw-1', { provider: 'gateway', modelId: 'anthropic/claude-sonnet-4.5', usage, providerMetadata: { gateway: { cost: '0.0008' } } }),
      );
      integration.onEnd({ callId: 'gw-1' });
      await client.flush();

      expect(events).toEqual([
        expect.objectContaining({ provider: 'vercel_gateway', model: 'anthropic/claude-sonnet-4.5', cost: { amount: '0.0012', currency: 'USD' } }),
        expect.objectContaining({ provider: 'vercel_gateway', model: 'anthropic/claude-sonnet-4.5', cost: { amount: '0.0008', currency: 'USD' } }),
      ]);
    });

    it('records a gateway embed at the operation end with the cost the gateway reported for it', async () => {
      const { client, integration, events } = setup();
      const model = 'openai/text-embedding-3-small';

      integration.onStart(start('gw-emb', { operationId: 'ai.embed', provider: 'gateway', modelId: model }));
      integration.onEmbedStart({ callId: 'gw-emb', embedCallId: 'e1', provider: 'gateway', modelId: model });
      integration.onEmbedEnd({ callId: 'gw-emb', embedCallId: 'e1', provider: 'gateway', modelId: model, usage: { tokens: 42 } });
      await client.flush();
      expect(events).toHaveLength(0); // held until onEnd carries the gateway's cost

      integration.onEnd({ callId: 'gw-emb', providerMetadata: { gateway: { cost: '0.00000084' } } });
      await client.flush();

      expect(events).toEqual([
        expect.objectContaining({ provider: 'vercel_gateway', model, status: 'success', usage: expect.objectContaining({ input_tokens: 42 }), cost: { amount: '0.00000084', currency: 'USD' } }),
      ]);
    });

    it('records a multi-chunk gateway embedMany WITHOUT a cost (the AI SDK keeps one chunk of metadata, not a total)', async () => {
      const { client, integration, events } = setup();
      const model = 'openai/text-embedding-3-small';

      integration.onStart(start('gw-many', { operationId: 'ai.embedMany', provider: 'gateway', modelId: model }));
      integration.onEmbedEnd({ callId: 'gw-many', embedCallId: 'e1', provider: 'gateway', modelId: model, usage: { tokens: 800 } });
      integration.onEmbedEnd({ callId: 'gw-many', embedCallId: 'e2', provider: 'gateway', modelId: model, usage: { tokens: 200 } });
      integration.onEnd({ callId: 'gw-many', providerMetadata: { gateway: { cost: '0.000004' } } });
      await client.flush();

      expect(events.map((e) => [e.provider, e.usage?.input_tokens, e.cost])).toEqual([
        ['vercel_gateway', 800, undefined],
        ['vercel_gateway', 200, undefined],
      ]);
    });

    it('still records finished gateway embedding calls when the operation errors, aborts or is cut off', async () => {
      const { client, integration, events } = setup();
      const model = 'openai/text-embedding-3-small';

      integration.onStart(start('gw-err', { operationId: 'ai.embedMany', provider: 'gateway', modelId: model }));
      integration.onEmbedEnd({ callId: 'gw-err', embedCallId: 'e1', provider: 'gateway', modelId: model, usage: { tokens: 300 } });
      integration.onError({ callId: 'gw-err', error: new Error('chunk 2 failed') });

      integration.onStart(start('gw-open', { operationId: 'ai.embed', provider: 'gateway', modelId: model }));
      integration.onEmbedEnd({ callId: 'gw-open', embedCallId: 'e1', provider: 'gateway', modelId: model, usage: { tokens: 7 } });
      expect(integration.abortOpenCalls()).toBe(0);
      await client.flush();

      expect(events.map((e) => [e.status, e.usage?.input_tokens, e.cost])).toEqual([
        ['success', 300, undefined],
        ['success', 7, undefined],
      ]);
    });

    it('never attaches a gateway cost to a direct-provider call', async () => {
      const { client, integration, events } = setup();

      integration.onLanguageModelCallEnd(modelCallEnd('d-1', { providerMetadata: { anthropic: { usage: ANTHROPIC_RAW_USAGE }, gateway: { cost: '9' } } }));
      await client.flush();

      expect(events[0].cost).toBeUndefined();
    });
  });

  describe('OpenAI built-in tools', () => {
    it('counts provider-executed web_search / file_search tool calls of an OpenAI step', async () => {
      const { client, integration, events } = setup();
      const content = [
        { type: 'tool-call', toolName: 'web_search', providerExecuted: true },
        { type: 'tool-call', toolName: 'file_search', providerExecuted: true },
        { type: 'tool-call', toolName: 'lookup' },
      ];

      integration.onLanguageModelCallEnd(
        modelCallEnd('o-1', {
          provider: 'openai.responses',
          modelId: 'gpt-5',
          content,
          usage: { inputTokens: 100, inputTokenDetails: { noCacheTokens: 100 }, outputTokens: 10, outputTokenDetails: {} },
          providerMetadata: { openai: { serviceTier: 'flex' } },
        }),
      );
      // Anthropic web searches come from its usage — content parts are never counted twice.
      integration.onLanguageModelCallEnd(modelCallEnd('a-1', { content }));
      await client.flush();

      expect(events.map((e) => e.usage?.tool_requests)).toEqual([{ web_search: 1, file_search: 1 }, { web_search: 2 }]);
      expect(events[0].service_tier).toBe('flex');
    });
  });

  describe('abortOpenCalls()', () => {
    it('records every started-but-unfinished model and embedding call as aborted, once, and returns the count', async () => {
      const { client, integration, events } = setup();

      integration.onStart(start('long-1'));
      integration.onLanguageModelCallStart({ callId: 'long-1', provider: 'anthropic.messages', modelId: 'claude-opus-5-5' });
      integration.onStart(start('emb-1', { operationId: 'ai.embedMany', provider: 'openai.embedding', modelId: 'text-embedding-3-small' }));
      integration.onEmbedStart({ callId: 'emb-1', embedCallId: 'e1' });
      integration.onStart(start('done-1'));
      integration.onLanguageModelCallStart({ callId: 'done-1' });
      integration.onLanguageModelCallEnd(modelCallEnd('done-1'));

      expect(integration.abortOpenCalls('process shutdown')).toBe(2);
      expect(integration.abortOpenCalls()).toBe(0);
      await client.flush();

      const aborted = events.filter((e) => e.status === 'aborted');

      expect(aborted).toEqual([
        expect.objectContaining({ provider: 'anthropic', model: 'claude-opus-5-5', customer: 'cus_1', usage: expect.objectContaining({ input_tokens: 0, output_tokens: 0 }) }),
        expect.objectContaining({ provider: 'openai', model: 'text-embedding-3-small' }),
      ]);
      expect(events.filter((e) => e.status === 'success')).toHaveLength(1);
    });

    it('never throws, whatever the client', () => {
      const integration = aiSpendTelemetry({ record: () => { throw new TypeError('boom'); } } as unknown as AiSpendClient);

      integration.onLanguageModelCallStart({ callId: 'x' });
      expect(integration.abortOpenCalls()).toBe(1);
    });
  });

  describe('eventId option (deterministic ids for replay dedupe)', () => {
    it('asks the resolver for every event of an operation, with the AI SDK callId and a 0-based sequence', async () => {
      const seen: Array<{ callId: string; sequence: number }> = [];
      const { client, integration, events } = setup({
        eventId: (info) => {
          seen.push(info);

          return `${info.callId}:${info.sequence}`;
        },
      });

      integration.onStart(start('c1'));
      integration.onLanguageModelCallEnd(modelCallEnd('c1'));
      integration.onLanguageModelCallEnd(modelCallEnd('c1'));
      integration.onEnd({ callId: 'c1' });
      await client.flush();

      expect(seen).toEqual([
        { callId: 'c1', sequence: 0 },
        { callId: 'c1', sequence: 1 },
      ]);
      expect(events.map((e) => e.event_id)).toEqual([eventIdFrom('c1:0'), eventIdFrom('c1:1')]);
    });

    it('covers the failed step recorded on error and the calls abortOpenCalls() closes', async () => {
      const { client, integration, events } = setup({ eventId: ({ callId, sequence }) => `${callId}:${sequence}` });

      integration.onStart(start('c2'));
      integration.onLanguageModelCallEnd(modelCallEnd('c2'));
      integration.onLanguageModelCallStart({ callId: 'c2' });
      integration.onError({ callId: 'c2', error: new TypeError('boom') });
      integration.onStart(start('c3'));
      integration.onLanguageModelCallStart({ callId: 'c3' });
      integration.abortOpenCalls();
      await client.flush();

      expect(events.map((e) => [e.status, e.event_id])).toEqual([
        ['success', eventIdFrom('c2:0')],
        ['error', eventIdFrom('c2:1')],
        ['aborted', eventIdFrom('c3:0')],
      ]);
    });

    it('a throwing resolver or an undefined answer leaves the event a fresh id — and the event is still sent', async () => {
      let calls = 0;
      const { client, integration, events } = setup({
        eventId: ({ sequence }) => {
          calls++;

          if (sequence === 0) throw new TypeError('resolver blew up');

          return undefined;
        },
      });

      integration.onStart(start('c4'));
      integration.onLanguageModelCallEnd(modelCallEnd('c4'));
      integration.onLanguageModelCallEnd(modelCallEnd('c4'));
      integration.onEnd({ callId: 'c4' });
      await client.flush();

      expect(calls).toBe(2);
      expect(events).toHaveLength(2);
      expect(new Set(events.map((e) => e.event_id)).size).toBe(2);
      expect(events.map((e) => e.event_id)).not.toContain(eventIdFrom('c4:0'));
    });

    it('is never called for an operation whose callId the adapter synthesized', async () => {
      const resolver = jest.fn(() => 'never');
      const { client, integration, events } = setup({ eventId: resolver });

      integration.onStart(start('', { callId: undefined }));
      integration.abortOpenCalls();
      integration.onLanguageModelCallStart({ provider: 'anthropic.messages', modelId: 'claude-opus-5-5' });
      integration.abortOpenCalls();
      await client.flush();

      expect(events).toHaveLength(1);
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  describe('Amazon Bedrock endpoint tier', () => {
    function bedrockStep(callId: string, modelId: string, providerMetadata?: Record<string, unknown>) {
      return modelCallEnd(callId, { provider: 'amazon-bedrock', modelId, providerMetadata });
    }

    it('records regional for a geography or in-region model id, nothing for the global profile, and fast still wins', async () => {
      const { client, integration, events } = setup();

      integration.onStart(start('b1', { provider: 'amazon-bedrock' }));
      integration.onLanguageModelCallEnd(bedrockStep('b1', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'));
      integration.onLanguageModelCallEnd(bedrockStep('b1', 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0'));
      integration.onLanguageModelCallEnd(bedrockStep('b1', 'anthropic.claude-sonnet-4-5-20250929-v1:0'));
      integration.onLanguageModelCallEnd(bedrockStep('b1', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'));
      integration.onLanguageModelCallEnd(bedrockStep('b1', 'us.anthropic.claude-opus-4-6-v1', { anthropic: { usage: { speed: 'fast' } } }));
      integration.onEnd({ callId: 'b1' });
      await client.flush();

      expect(events.map((e) => [e.provider, e.service_tier])).toEqual([
        ['bedrock', 'regional'],
        ['bedrock', 'regional'],
        ['bedrock', 'regional'],
        ['bedrock', undefined],
        ['bedrock', 'fast'],
      ]);
    });

    it('leaves direct Anthropic and OpenAI calls on their reported tier', async () => {
      const { client, integration, events } = setup();

      integration.onStart(start('b2'));
      integration.onLanguageModelCallEnd(modelCallEnd('b2', { modelId: 'us.anthropic.claude-opus-5-5' }));
      integration.onEnd({ callId: 'b2' });
      await client.flush();

      expect(events.map((e) => e.service_tier)).toEqual(['priority']);
    });
  });
});
