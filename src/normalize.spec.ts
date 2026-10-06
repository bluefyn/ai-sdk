import {
  anthropicServiceTier,
  bedrockEndpointTier,
  billedTokens,
  checkUsageKeys,
  fromAnthropicUsage,
  fromOpenAIChatUsage,
  fromOpenAIEmbeddingsUsage,
  fromOpenAIResponsesUsage,
  fromVercelUsage,
  openAIChatSearchRequests,
  openAIResponsesToolRequests,
  isEmptyUsage,
  sanitizeUsage,
  suggestUsageKey,
  vercelOpenAIToolRequests,
  withEndpointTier,
  withToolRequests,
} from './normalize';
import type { CanonicalUsage } from './wire';

// ---------------------------------------------------------------- golden fixtures (real payload shapes)

/** Anthropic Messages API `usage` — 5m + 1h cache writes, cache reads, server web search. */
const ANTHROPIC_MESSAGE_USAGE = {
  input_tokens: 2095,
  cache_creation_input_tokens: 2051,
  cache_read_input_tokens: 12304,
  cache_creation: { ephemeral_5m_input_tokens: 1024, ephemeral_1h_input_tokens: 1027 },
  output_tokens: 503,
  server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
  service_tier: 'standard',
};

/** Anthropic streaming `message_delta.usage` (cumulative; nullable fields). */
const ANTHROPIC_MESSAGE_DELTA_USAGE = {
  input_tokens: 38,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  output_tokens: 1187,
  server_tool_use: { web_search_requests: 1 },
};

/** Older Anthropic payload: a cache write total without the TTL breakdown. */
const ANTHROPIC_NO_BREAKDOWN_USAGE = {
  input_tokens: 12,
  cache_creation_input_tokens: 4000,
  cache_read_input_tokens: 0,
  cache_creation: null,
  output_tokens: 90,
  server_tool_use: null,
  service_tier: 'priority',
};

/** OpenAI Chat Completions (reasoning model) — prompt_tokens INCLUDES cached_tokens. */
const OPENAI_CHAT_USAGE = {
  prompt_tokens: 2006,
  completion_tokens: 300,
  total_tokens: 2306,
  prompt_tokens_details: { cached_tokens: 1920, audio_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 192, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
};

/** OpenAI Responses API `response.usage`. */
const OPENAI_RESPONSES_USAGE = {
  input_tokens: 5328,
  input_tokens_details: { cached_tokens: 4864 },
  output_tokens: 1052,
  output_tokens_details: { reasoning_tokens: 768 },
  total_tokens: 6380,
};

/** OpenAI Embeddings `usage`. */
const OPENAI_EMBEDDINGS_USAGE = { prompt_tokens: 8, total_tokens: 8 };

/** Vercel AI SDK v7 `LanguageModelUsage` of an Anthropic call (cache-INCLUSIVE inputTokens) + provider metadata. */
const VERCEL_ANTHROPIC_USAGE = {
  inputTokens: 16450,
  inputTokenDetails: { noCacheTokens: 2095, cacheReadTokens: 12304, cacheWriteTokens: 2051 },
  outputTokens: 503,
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens: 16953,
  raw: ANTHROPIC_MESSAGE_USAGE,
};
const VERCEL_ANTHROPIC_METADATA = {
  anthropic: { usage: ANTHROPIC_MESSAGE_USAGE, cacheCreationInputTokens: 2051, stopSequence: null, iterations: null, container: null, contextManagement: null },
};

/** Vercel AI SDK v7 usage of an OpenAI chat call. */
const VERCEL_OPENAI_USAGE = {
  inputTokens: 2006,
  inputTokenDetails: { noCacheTokens: 86, cacheReadTokens: 1920, cacheWriteTokens: undefined },
  outputTokens: 300,
  outputTokenDetails: { textTokens: 108, reasoningTokens: 192 },
  totalTokens: 2306,
  raw: OPENAI_CHAT_USAGE,
};
const VERCEL_OPENAI_METADATA = { openai: { responseId: 'resp_1', serviceTier: 'flex' } };

function parts(usage: CanonicalUsage) {
  return [usage.inputTokens, usage.cachedInputTokens, usage.cacheWrite5mTokens, usage.cacheWrite1hTokens, usage.outputTokens];
}

describe('usage normalizer', () => {
  describe('fromAnthropicUsage', () => {
    it('keeps input exclusive of cache, splits cache writes by TTL and counts web searches', () => {
      expect(fromAnthropicUsage(ANTHROPIC_MESSAGE_USAGE)).toEqual({
        inputTokens: 2095,
        cachedInputTokens: 12304,
        cacheWrite5mTokens: 1024,
        cacheWrite1hTokens: 1027,
        outputTokens: 503,
        reasoningTokens: 0,
        toolRequests: { web_search: 2 },
      });
    });

    it('reads streaming message_delta usage with nullable cache fields', () => {
      expect(fromAnthropicUsage(ANTHROPIC_MESSAGE_DELTA_USAGE)).toEqual({
        inputTokens: 38,
        cachedInputTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 1187,
        reasoningTokens: 0,
        toolRequests: { web_search: 1 },
      });
    });

    it('treats a cache write without a TTL breakdown as 5-minute writes', () => {
      const usage = fromAnthropicUsage(ANTHROPIC_NO_BREAKDOWN_USAGE);

      expect(usage.cacheWrite5mTokens).toBe(4000);
      expect(usage.cacheWrite1hTokens).toBe(0);
      expect(usage.toolRequests).toEqual({});
    });

    it('puts a breakdown remainder into the 5-minute bucket', () => {
      const usage = fromAnthropicUsage({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600 } });

      expect(usage.cacheWrite5mTokens).toBe(400);
      expect(usage.cacheWrite1hTokens).toBe(600);
    });
  });

  describe('fromAnthropicUsage — server-side iterations (mirrors @ai-sdk/anthropic 4.0.60 convertAnthropicUsage)', () => {
    /** Compaction + a message + an advisor call; the top level reports only the final message. */
    const ITERATIONS_USAGE = {
      input_tokens: 950,
      output_tokens: 210,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 0,
      iterations: [
        { type: 'compaction', input_tokens: 18000, output_tokens: 1200 },
        { type: 'message', input_tokens: 950, output_tokens: 210, cache_read_input_tokens: 4000 },
        { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 3000, output_tokens: 400 },
      ],
    };

    it('sums input/output over the executor iterations (message + compaction), cache from the top level', () => {
      expect(fromAnthropicUsage(ITERATIONS_USAGE)).toEqual({
        inputTokens: 18950,
        cachedInputTokens: 4000,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 1410,
        reasoningTokens: 0,
        toolRequests: {},
      });
    });

    it('agrees with the Vercel path, where the AI SDK already summed the iterations', () => {
      const vercel = fromVercelUsage({
        inputTokens: 22950,
        inputTokenDetails: { noCacheTokens: 18950, cacheReadTokens: 4000, cacheWriteTokens: 0 },
        outputTokens: 1410,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        raw: ITERATIONS_USAGE,
      });

      expect(vercel).toEqual(fromAnthropicUsage(ITERATIONS_USAGE));
    });

    it('uses the top-level counts when a fallback model served the request', () => {
      const usage = fromAnthropicUsage({ ...ITERATIONS_USAGE, iterations: [...ITERATIONS_USAGE.iterations, { type: 'fallback_message', input_tokens: 700, output_tokens: 90 }] });

      expect([usage.inputTokens, usage.outputTokens]).toEqual([950, 210]);
    });

    it('uses the top-level counts when no executor iteration is present', () => {
      const usage = fromAnthropicUsage({ ...ITERATIONS_USAGE, iterations: [{ type: 'advisor_message', input_tokens: 3000, output_tokens: 400 }] });

      expect([usage.inputTokens, usage.outputTokens]).toEqual([950, 210]);
    });
  });

  describe('OpenAI', () => {
    it('subtracts cached tokens from prompt_tokens (chat completions)', () => {
      expect(fromOpenAIChatUsage(OPENAI_CHAT_USAGE)).toEqual({
        inputTokens: 86,
        cachedInputTokens: 1920,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 300,
        reasoningTokens: 192,
        toolRequests: {},
      });
    });

    it('subtracts cached tokens from input_tokens (Responses API)', () => {
      expect(fromOpenAIResponsesUsage(OPENAI_RESPONSES_USAGE)).toEqual({
        inputTokens: 464,
        cachedInputTokens: 4864,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 1052,
        reasoningTokens: 768,
        toolRequests: {},
      });
    });

    it('maps embeddings usage to input tokens only', () => {
      expect(fromOpenAIEmbeddingsUsage(OPENAI_EMBEDDINGS_USAGE)).toEqual(expect.objectContaining({ inputTokens: 8, outputTokens: 0, cachedInputTokens: 0 }));
    });

    it('splits a reported cache write out of the prompt too', () => {
      const usage = fromOpenAIChatUsage({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } });

      expect(usage).toEqual(expect.objectContaining({ inputTokens: 100, cachedInputTokens: 600, cacheWrite5mTokens: 300 }));
    });

    it('never counts reasoning on top of output', () => {
      const usage = fromOpenAIChatUsage(OPENAI_CHAT_USAGE);

      expect(billedTokens(usage)).toBe(OPENAI_CHAT_USAGE.total_tokens);
      expect(usage.reasoningTokens).toBeLessThanOrEqual(usage.outputTokens);
    });

    // Regression: the platform's ledgers once added OpenAI cached tokens ON TOP of prompt_tokens,
    // billing cache hits twice (2006 + 1920 = 3926 input-side tokens for a 2006-token prompt).
    it('REGRESSION: cached tokens are never double counted', () => {
      const usage = fromOpenAIChatUsage(OPENAI_CHAT_USAGE);
      const inputSide = usage.inputTokens + usage.cachedInputTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;

      expect(inputSide).toBe(OPENAI_CHAT_USAGE.prompt_tokens);
      expect(inputSide).not.toBe(OPENAI_CHAT_USAGE.prompt_tokens + OPENAI_CHAT_USAGE.prompt_tokens_details.cached_tokens);
      expect(fromVercelUsage(VERCEL_OPENAI_USAGE).inputTokens + fromVercelUsage(VERCEL_OPENAI_USAGE).cachedInputTokens).toBe(2006);
    });

    it('clamps an impossible cached count to the prompt size', () => {
      const usage = fromOpenAIChatUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 250 } });

      expect(usage.inputTokens).toBe(0);
      expect(usage.cachedInputTokens).toBe(100);
    });
  });

  describe('fromVercelUsage (AI SDK v7)', () => {
    it('reads an Anthropic call, taking the 1h split and web searches from provider metadata', () => {
      expect(fromVercelUsage(VERCEL_ANTHROPIC_USAGE, VERCEL_ANTHROPIC_METADATA)).toEqual(fromAnthropicUsage(ANTHROPIC_MESSAGE_USAGE));
    });

    it('falls back to usage.raw for the Anthropic split when metadata is absent', () => {
      expect(fromVercelUsage(VERCEL_ANTHROPIC_USAGE).cacheWrite1hTokens).toBe(1027);
    });

    it('reads an OpenAI call from the input token details', () => {
      expect(fromVercelUsage(VERCEL_OPENAI_USAGE, VERCEL_OPENAI_METADATA)).toEqual(fromOpenAIChatUsage(OPENAI_CHAT_USAGE));
    });

    it('derives the uncached part when noCacheTokens is missing', () => {
      const usage = fromVercelUsage({ inputTokens: 1000, inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 100 }, outputTokens: 10 });

      expect(usage).toEqual(expect.objectContaining({ inputTokens: 200, cachedInputTokens: 700, cacheWrite5mTokens: 100, outputTokens: 10 }));
    });

    it('maps the embedding { tokens } shape to input tokens', () => {
      expect(fromVercelUsage({ tokens: 42 })).toEqual(expect.objectContaining({ inputTokens: 42, outputTokens: 0 }));
    });

    it('treats an all-undefined usage (provider reported nothing) as zero', () => {
      const usage = fromVercelUsage({
        inputTokens: undefined,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
      });

      expect(billedTokens(usage)).toBe(0);
    });
  });

  describe('invariant: disjoint parts sum to the tokens the provider bills', () => {
    it.each([
      ['anthropic message', fromAnthropicUsage(ANTHROPIC_MESSAGE_USAGE), 2095 + 2051 + 12304 + 503],
      ['anthropic delta', fromAnthropicUsage(ANTHROPIC_MESSAGE_DELTA_USAGE), 38 + 1187],
      ['anthropic no breakdown', fromAnthropicUsage(ANTHROPIC_NO_BREAKDOWN_USAGE), 12 + 4000 + 90],
      ['openai chat', fromOpenAIChatUsage(OPENAI_CHAT_USAGE), OPENAI_CHAT_USAGE.total_tokens],
      ['openai responses', fromOpenAIResponsesUsage(OPENAI_RESPONSES_USAGE), OPENAI_RESPONSES_USAGE.total_tokens],
      ['openai embeddings', fromOpenAIEmbeddingsUsage(OPENAI_EMBEDDINGS_USAGE), OPENAI_EMBEDDINGS_USAGE.total_tokens],
      ['vercel anthropic', fromVercelUsage(VERCEL_ANTHROPIC_USAGE, VERCEL_ANTHROPIC_METADATA), VERCEL_ANTHROPIC_USAGE.totalTokens],
      ['vercel openai', fromVercelUsage(VERCEL_OPENAI_USAGE, VERCEL_OPENAI_METADATA), VERCEL_OPENAI_USAGE.totalTokens],
    ])('%s', (_label, usage, billed) => {
      expect(billedTokens(usage)).toBe(billed);
      parts(usage).forEach((part) => {
        expect(Number.isInteger(part)).toBe(true);
        expect(part).toBeGreaterThanOrEqual(0);
      });
      expect(usage.reasoningTokens).toBeLessThanOrEqual(usage.outputTokens);
    });

    it('holds for random OpenAI payloads (property check)', () => {
      let seed = 7;

      const next = (max: number) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;

        return seed % (max + 1);
      };

      for (let i = 0; i < 500; i++) {
        const prompt = next(200_000);
        const cached = next(prompt);
        const completion = next(50_000);
        const reasoning = next(completion);
        const usage = fromOpenAIChatUsage({
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
          prompt_tokens_details: { cached_tokens: cached },
          completion_tokens_details: { reasoning_tokens: reasoning },
        });

        expect(billedTokens(usage)).toBe(prompt + completion);
        expect(usage.cachedInputTokens).toBe(cached);
        expect(usage.reasoningTokens).toBe(reasoning);
      }
    });
  });

  describe('defensive parsing', () => {
    it.each([undefined, null, 'garbage', 42, []])('returns zero usage for %p', (input) => {
      const garbage = input as unknown as Parameters<typeof fromAnthropicUsage>[0];

      expect(billedTokens(fromAnthropicUsage(garbage))).toBe(0);
      expect(billedTokens(fromOpenAIChatUsage(garbage as Parameters<typeof fromOpenAIChatUsage>[0]))).toBe(0);
      expect(billedTokens(fromVercelUsage(garbage as Parameters<typeof fromVercelUsage>[0]))).toBe(0);
    });

    it('clamps negatives, rounds fractions and ignores non-numbers', () => {
      const usage = fromAnthropicUsage({ input_tokens: -5, output_tokens: 10.6, cache_read_input_tokens: Number.NaN, cache_creation_input_tokens: '12' as unknown as number });

      expect(parts(usage)).toEqual([0, 0, 0, 0, 11]);
    });

    it('sanitizes a hand-built usage (reasoning capped at output, bad tool counts dropped)', () => {
      expect(sanitizeUsage({ inputTokens: 10.2, outputTokens: 5, reasoningTokens: 9, toolRequests: { web_search: 2, '': 3, bad: -1 } })).toEqual({
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 5,
        reasoningTokens: 5,
        toolRequests: { web_search: 2 },
      });
    });
  });
});

describe('AI SDK v5 usage shape (fromVercelUsage)', () => {
  it('OpenAI: subtracts the top-level cachedInputTokens (cache-inclusive input) and reads reasoningTokens', () => {
    expect(fromVercelUsage({ inputTokens: 10_000, cachedInputTokens: 9_000, outputTokens: 200, reasoningTokens: 50 })).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 9_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 200,
      reasoningTokens: 50,
      toolRequests: {},
    });
  });

  it('Anthropic: input already excludes the cache; reads and writes come from the raw usage', () => {
    const raw = {
      input_tokens: 120,
      cache_read_input_tokens: 4_000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      output_tokens: 42,
    };

    expect(fromVercelUsage({ inputTokens: 120, cachedInputTokens: 4_000, outputTokens: 42 }, { anthropic: { usage: raw } })).toEqual({
      inputTokens: 120,
      cachedInputTokens: 4_000,
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 200,
      outputTokens: 42,
      reasoningTokens: 0,
      toolRequests: {},
    });
  });

  it('Amazon Bedrock: input already excludes the cache — the AWS Converse example (inputTokens 4, cacheRead 1032) keeps every token', () => {
    // @ai-sdk/amazon-bedrock 3.x (AI SDK v5): inputTokens = Converse inputTokens, cachedInputTokens = cacheReadInputTokens.
    expect(fromVercelUsage({ inputTokens: 4, cachedInputTokens: 1_032, outputTokens: 135 }, { bedrock: { usage: { cacheWriteInputTokens: 0 } } })).toEqual({
      inputTokens: 4,
      cachedInputTokens: 1_032,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 135,
      reasoningTokens: 0,
      toolRequests: {},
    });
  });

  it('Amazon Bedrock: cache writes come from providerMetadata.bedrock.usage.cacheWriteInputTokens', () => {
    const usage = fromVercelUsage({ inputTokens: 12, cachedInputTokens: undefined, outputTokens: 30, reasoningTokens: 5 }, { bedrock: { usage: { cacheWriteInputTokens: 2_048 } } });

    expect(usage).toEqual({ inputTokens: 12, cachedInputTokens: 0, cacheWrite5mTokens: 2_048, cacheWrite1hTokens: 0, outputTokens: 30, reasoningTokens: 5, toolRequests: {} });
    expect(billedTokens(usage)).toBe(12 + 2_048 + 30);
    // Without the v5 cache keys, the Bedrock metadata alone still marks the v5 shape.
    expect(fromVercelUsage({ inputTokens: 12, outputTokens: 30 }, { bedrock: { usage: { cacheWriteInputTokens: 100, cacheReadInputTokens: 50 } } })).toEqual(
      expect.objectContaining({ inputTokens: 12, cachedInputTokens: 50, cacheWrite5mTokens: 100 }),
    );
  });

  it('Amazon Bedrock on AI SDK v7 (details present) keeps reading the details', () => {
    expect(
      fromVercelUsage(
        { inputTokens: 1_036, outputTokens: 135, inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 1_032, cacheWriteTokens: 0 }, outputTokenDetails: {} },
        { bedrock: { usage: { cacheWriteInputTokens: 0 } } },
      ),
    ).toEqual(expect.objectContaining({ inputTokens: 4, cachedInputTokens: 1_032, cacheWrite5mTokens: 0 }));
  });

  it('agrees with the provider-native normalizer for the same Anthropic call (v5 and v7 shapes)', () => {
    const raw = { input_tokens: 120, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 300, output_tokens: 42 };
    const v5 = fromVercelUsage({ inputTokens: 120, cachedInputTokens: 4_000, outputTokens: 42 }, { anthropic: { usage: raw } });
    const v7 = fromVercelUsage(
      { inputTokens: 4_420, outputTokens: 42, inputTokenDetails: { noCacheTokens: 120, cacheReadTokens: 4_000, cacheWriteTokens: 300 }, outputTokenDetails: {} },
      { anthropic: { usage: raw } },
    );

    expect(v5).toEqual(fromAnthropicUsage(raw));
    expect(v7).toEqual(fromAnthropicUsage(raw));
  });
});

describe('service tier and built-in tool helpers', () => {
  it('anthropicServiceTier: fast mode wins over service_tier', () => {
    expect(anthropicServiceTier({ service_tier: 'standard', speed: 'fast' })).toBe('fast');
    expect(anthropicServiceTier({ service_tier: 'priority', speed: 'standard' })).toBe('priority');
    expect(anthropicServiceTier({})).toBeUndefined();
    expect(anthropicServiceTier(null)).toBeUndefined();
  });

  it('openAIResponsesToolRequests counts web_search_call and file_search_call items, not code interpreter', () => {
    const response = {
      output: [
        { type: 'web_search_call', id: 'ws_1' },
        { type: 'web_search_call', id: 'ws_2' },
        { type: 'file_search_call', id: 'fs_1' },
        { type: 'code_interpreter_call', id: 'ci_1' },
        { type: 'message', id: 'msg_1' },
      ],
    };

    expect(openAIResponsesToolRequests(response)).toEqual({ web_search: 2, file_search: 1 });
    expect(openAIResponsesToolRequests({ output: null })).toEqual({});
  });

  it('openAIChatSearchRequests: one web search per Chat Completions search-model call', () => {
    expect(openAIChatSearchRequests('gpt-4o-search-preview')).toEqual({ web_search: 1 });
    expect(openAIChatSearchRequests('gpt-4o-mini-search-preview-2025-03-11')).toEqual({ web_search: 1 });
    expect(openAIChatSearchRequests('gpt-4o')).toEqual({});
    expect(openAIChatSearchRequests(undefined)).toEqual({});
  });

  it('vercelOpenAIToolRequests counts provider-executed default-named tool calls only', () => {
    const content = [
      { type: 'tool-call', toolName: 'web_search', providerExecuted: true },
      { type: 'tool-result', toolName: 'web_search' },
      { type: 'tool-call', toolName: 'web_search_preview', providerExecuted: true },
      { type: 'tool-call', toolName: 'file_search', providerExecuted: true },
      { type: 'tool-call', toolName: 'web_search' },
      { type: 'tool-call', toolName: 'myLookup', providerExecuted: true },
    ];

    expect(vercelOpenAIToolRequests(content)).toEqual({ web_search: 2, file_search: 1 });
  });

  it('withToolRequests adds counts without mutating the base usage', () => {
    const base = fromOpenAIResponsesUsage({ input_tokens: 10, output_tokens: 1 });
    const merged = withToolRequests(base, { web_search: 2 });

    expect(merged.toolRequests).toEqual({ web_search: 2 });
    expect(base.toolRequests).toEqual({});
    expect(withToolRequests(base, {})).toBe(base);
  });
});

describe('cloud endpoint tier', () => {
  it.each([
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'regional'],
    ['EU.anthropic.claude-sonnet-4-5-20250929-v1:0', 'regional'],
    ['apac.anthropic.claude-haiku-4-5-20251001-v1:0', 'regional'],
    ['jp.anthropic.claude-haiku-4-5-20251001-v1:0', 'regional'],
    ['au.anthropic.claude-haiku-4-5-20251001-v1:0', 'regional'],
    ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'regional'],
    ['arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0', 'regional'],
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'regional'],
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0', undefined],
    ['arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3', undefined],
    ['global.anthropic.claude-sonnet-4-5-20250929-v1:0', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('bedrockEndpointTier(%p) → %p', (modelId, expected) => {
    expect(bedrockEndpointTier(modelId)).toBe(expected);
  });

  it('withEndpointTier: fast wins, then the endpoint tier, then the reported tier', () => {
    expect(withEndpointTier('fast', 'regional')).toBe('fast');
    expect(withEndpointTier('standard', 'regional')).toBe('regional');
    expect(withEndpointTier(undefined, 'regional')).toBe('regional');
    expect(withEndpointTier('priority', undefined)).toBe('priority');
    expect(withEndpointTier(undefined, undefined)).toBeUndefined();
  });
});

describe('manual usage checks', () => {
  it('suggests the canonical key a wrong one most likely meant', () => {
    expect(suggestUsageKey('input')).toBe('inputTokens');
    expect(suggestUsageKey('output')).toBe('outputTokens');
    expect(suggestUsageKey('input_tokens')).toBe('inputTokens');
    expect(suggestUsageKey('prompt_tokens')).toBe('inputTokens');
    expect(suggestUsageKey('completion_tokens')).toBe('outputTokens');
    expect(suggestUsageKey('cache_read_input_tokens')).toBe('cachedInputTokens');
    expect(suggestUsageKey('cache_creation_input_tokens')).toBe('cacheWrite5mTokens');
    expect(suggestUsageKey('reasoning_tokens')).toBe('reasoningTokens');
    expect(suggestUsageKey('outputTokns')).toBe('outputTokens');
    expect(suggestUsageKey('tool_requests')).toBe('toolRequests');
    expect(suggestUsageKey('latency')).toBeUndefined();
  });

  it('lists every unknown key with a value, with a suggestion, and names the normalizer for a provider-shaped usage', () => {
    expect(checkUsageKeys({ input: 1_000, output: 100 })).toEqual({
      notAnObject: false,
      unknown: [
        { key: 'input', suggestion: 'inputTokens' },
        { key: 'output', suggestion: 'outputTokens' },
      ],
      normalizer: undefined,
    });
    expect(checkUsageKeys({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }).normalizer).toContain('fromOpenAIChatUsage');
    expect(checkUsageKeys({ inputTokens: 10, outputTokens: 2, totalTokens: 12, inputTokenDetails: {} }).normalizer).toContain('fromVercelUsage');
    expect(checkUsageKeys({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 }).normalizer).toContain('fromAnthropicUsage');
  });

  it('accepts the canonical keys, keys set to undefined, and an absent usage; flags a non-object', () => {
    expect(checkUsageKeys({ inputTokens: 1, cachedInputTokens: 2, cacheWrite5mTokens: 3, cacheWrite1hTokens: 4, outputTokens: 5, reasoningTokens: 1, toolRequests: {}, extra: undefined }).unknown).toEqual([]);
    expect(checkUsageKeys(undefined)).toEqual({ notAnObject: false, unknown: [], normalizer: undefined });
    expect(checkUsageKeys(1_000).notAnObject).toBe(true);
    expect(checkUsageKeys([1, 2]).notAnObject).toBe(true);
  });

  it('isEmptyUsage: nothing billable — no tokens of any kind and no tool requests', () => {
    expect(isEmptyUsage(sanitizeUsage({}))).toBe(true);
    expect(isEmptyUsage(sanitizeUsage({ cacheWrite1hTokens: 1 }))).toBe(false);
    expect(isEmptyUsage(sanitizeUsage({ toolRequests: { web_search: 1 } }))).toBe(false);
  });
});
