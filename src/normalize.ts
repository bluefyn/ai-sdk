import { isRecord, isStorableText, rec, str } from './util';
import { AI_SPEND_LIMITS } from './wire';
import type { CanonicalUsage } from './wire';

/**
 * Usage normalizer: every provider quirk lives here, so the parts of a
 * {@link CanonicalUsage} are DISJOINT and sum to exactly what the provider bills.
 *
 * - Anthropic `input_tokens` EXCLUDES cache reads/writes (they are reported beside it).
 * - OpenAI `prompt_tokens` / `input_tokens` INCLUDE cached tokens — they are subtracted,
 *   never added (adding them was the known double count).
 * - Reasoning is a subset of output everywhere; it is carried for information only.
 * - Counts are integers ≥ 0: negatives clamp to 0, fractions round, garbage reads as 0.
 */

type Count = number | null | undefined;

/** Anthropic `Usage` / `MessageDeltaUsage` (Messages API, streaming `message_delta` included). */
export interface AnthropicUsageLike {
  input_tokens?: Count;
  output_tokens?: Count;
  cache_read_input_tokens?: Count;
  cache_creation_input_tokens?: Count;
  cache_creation?: {
    ephemeral_5m_input_tokens?: Count;
    ephemeral_1h_input_tokens?: Count;
  } | null;
  server_tool_use?: {
    web_search_requests?: Count;
  } | null;
  service_tier?: string | null;
  /** `fast` when the request ran in fast mode (`speed: 'fast'`), else `standard`. */
  speed?: string | null;
  output_tokens_details?: { thinking_tokens?: Count } | null;
  /**
   * Server-side sampling iterations (compaction, advisor, fallback). When present the billed
   * input/output are the SUM over the executor iterations — see {@link fromAnthropicUsage}.
   */
  iterations?: ReadonlyArray<{ type?: string | null; input_tokens?: Count; output_tokens?: Count }> | null;
}

/** OpenAI Chat Completions `usage`. */
export interface OpenAIChatUsageLike {
  prompt_tokens?: Count;
  completion_tokens?: Count;
  total_tokens?: Count;
  prompt_tokens_details?: { cached_tokens?: Count; cache_write_tokens?: Count } | null;
  completion_tokens_details?: { reasoning_tokens?: Count } | null;
}

/** OpenAI Responses API `usage`. */
export interface OpenAIResponsesUsageLike {
  input_tokens?: Count;
  output_tokens?: Count;
  total_tokens?: Count;
  input_tokens_details?: { cached_tokens?: Count; cache_write_tokens?: Count } | null;
  output_tokens_details?: { reasoning_tokens?: Count } | null;
}

/** OpenAI Embeddings `usage` (input only). */
export interface OpenAIEmbeddingsUsageLike {
  prompt_tokens?: Count;
  total_tokens?: Count;
}

/**
 * Vercel AI SDK `LanguageModelUsage`: v6+ (`inputTokens` is cache-INCLUSIVE; the details carry
 * the split), the v5 shape (top-level `cachedInputTokens` / `reasoningTokens`), or the
 * embedding `{ tokens }` shape.
 */
export interface VercelUsageLike {
  inputTokens?: Count;
  outputTokens?: Count;
  totalTokens?: Count;
  inputTokenDetails?: { noCacheTokens?: Count; cacheReadTokens?: Count; cacheWriteTokens?: Count } | null;
  outputTokenDetails?: { textTokens?: Count; reasoningTokens?: Count } | null;
  /** AI SDK v5: cache reads (OpenAI: inside `inputTokens`; Anthropic: beside it). */
  cachedInputTokens?: Count;
  /** AI SDK v5: reasoning tokens (a subset of `outputTokens`). */
  reasoningTokens?: Count;
  /** Provider-shaped usage as returned (Anthropic: the raw `usage` object). */
  raw?: unknown;
  /** Embedding usage. */
  tokens?: Count;
}

/** Vercel `providerMetadata` — `{ [providerKey]: { … } }`. */
export type VercelProviderMetadataLike = Record<string, unknown> | null | undefined;

const WEB_SEARCH_TOOL = 'web_search';
const FILE_SEARCH_TOOL = 'file_search';
/**
 * OpenAI built-in tool calls billed per call, by Responses API output item type. Code
 * interpreter is billed per container SESSION (not per call), so it is not counted here.
 */
const OPENAI_TOOL_CALL_ITEMS: Readonly<Record<string, string>> = {
  web_search_call: WEB_SEARCH_TOOL,
  file_search_call: FILE_SEARCH_TOOL,
};
/** Chat Completions search models (`gpt-4o-search-preview`, …) run one web search per call. */
const OPENAI_SEARCH_MODEL = /-search(?:-preview|-api)?(?:-\d{4}-\d{2}-\d{2})?$/;

function count(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.round(value);
}

function emptyUsage() {
  const usage: CanonicalUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    toolRequests: {},
  };

  return usage;
}

function toolRequestsOf(entries: Array<[string, unknown]>) {
  const out: Record<string, number> = {};

  for (const [name, value] of entries) {
    const n = count(value);

    if (n > 0) {
      out[name] = n;
    }
  }

  return out;
}

/**
 * Split a cache-write total into its 5-minute / 1-hour TTL parts. The breakdown wins where
 * present; any remainder (or the whole total, without a breakdown) is a 5-minute write.
 */
function splitCacheWrites(total: number, breakdown: unknown) {
  if (!isRecord(breakdown)) {
    return { cacheWrite5mTokens: total, cacheWrite1hTokens: 0 };
  }

  const oneHour = count(breakdown['ephemeral_1h_input_tokens']);
  const fiveMinutes = count(breakdown['ephemeral_5m_input_tokens']);

  if (oneHour + fiveMinutes === 0) {
    return { cacheWrite5mTokens: total, cacheWrite1hTokens: 0 };
  }

  return { cacheWrite5mTokens: Math.max(fiveMinutes, total - oneHour), cacheWrite1hTokens: oneHour };
}

/**
 * Anthropic Messages usage → canonical. `input_tokens` already excludes cache reads and
 * writes; cache writes split by TTL from `cache_creation`; web searches are per-request.
 */
export function fromAnthropicUsage(usage: AnthropicUsageLike | null | undefined) {
  if (!isRecord(usage)) {
    return emptyUsage();
  }

  const u = rec(usage);
  const { inputTokens, outputTokens } = anthropicInputOutput(u);
  const thinking = count(rec(u['output_tokens_details'])['thinking_tokens']);
  const result: CanonicalUsage = {
    inputTokens,
    cachedInputTokens: count(u['cache_read_input_tokens']),
    ...splitCacheWrites(count(u['cache_creation_input_tokens']), u['cache_creation']),
    outputTokens,
    reasoningTokens: Math.min(thinking, outputTokens),
    toolRequests: toolRequestsOf([[WEB_SEARCH_TOOL, rec(u['server_tool_use'])['web_search_requests']]]),
  };

  return result;
}

/**
 * Input/output tokens exactly as `@ai-sdk/anthropic` (4.0.60 `convertAnthropicUsage`) bills
 * them: with server-side `iterations` present and none of them a `fallback_message`, the
 * SUM over the executor iterations (`message` + `compaction`); otherwise the top-level
 * counts. Cache reads/writes always come from the top level.
 */
function anthropicInputOutput(u: Record<string, unknown>) {
  const iterations = Array.isArray(u['iterations']) ? u['iterations'].filter(isRecord) : [];
  const servedByFallback = iterations.some((iteration) => iteration['type'] === 'fallback_message');

  if (iterations.length > 0 && !servedByFallback) {
    const executor = iterations.filter((iteration) => iteration['type'] === 'compaction' || iteration['type'] === 'message');

    if (executor.length > 0) {
      return {
        inputTokens: executor.reduce((sum, iteration) => sum + count(iteration['input_tokens']), 0),
        outputTokens: executor.reduce((sum, iteration) => sum + count(iteration['output_tokens']), 0),
      };
    }
  }

  return { inputTokens: count(u['input_tokens']), outputTokens: count(u['output_tokens']) };
}

/** Shared OpenAI split: the reported input INCLUDES cache reads (and cache writes, when reported). */
function fromOpenAIParts(parts: { input: unknown; cached: unknown; cacheWrite: unknown; output: unknown; reasoning: unknown }) {
  const reportedInput = count(parts.input);
  const cachedInputTokens = Math.min(count(parts.cached), reportedInput);
  const cacheWrite = Math.min(count(parts.cacheWrite), reportedInput - cachedInputTokens);
  const outputTokens = count(parts.output);
  const result: CanonicalUsage = {
    inputTokens: reportedInput - cachedInputTokens - cacheWrite,
    cachedInputTokens,
    cacheWrite5mTokens: cacheWrite,
    cacheWrite1hTokens: 0,
    outputTokens,
    reasoningTokens: Math.min(count(parts.reasoning), outputTokens),
    toolRequests: {},
  };

  return result;
}

/** OpenAI Chat Completions usage → canonical (`prompt_tokens` includes `cached_tokens`). */
export function fromOpenAIChatUsage(usage: OpenAIChatUsageLike | null | undefined) {
  if (!isRecord(usage)) {
    return emptyUsage();
  }

  const u = rec(usage);
  const prompt = rec(u['prompt_tokens_details']);

  return fromOpenAIParts({
    input: u['prompt_tokens'],
    cached: prompt['cached_tokens'],
    cacheWrite: prompt['cache_write_tokens'],
    output: u['completion_tokens'],
    reasoning: rec(u['completion_tokens_details'])['reasoning_tokens'],
  });
}

/** OpenAI Responses API usage → canonical (`input_tokens` includes `cached_tokens`). */
export function fromOpenAIResponsesUsage(usage: OpenAIResponsesUsageLike | null | undefined) {
  if (!isRecord(usage)) {
    return emptyUsage();
  }

  const u = rec(usage);
  const input = rec(u['input_tokens_details']);

  return fromOpenAIParts({
    input: u['input_tokens'],
    cached: input['cached_tokens'],
    cacheWrite: input['cache_write_tokens'],
    output: u['output_tokens'],
    reasoning: rec(u['output_tokens_details'])['reasoning_tokens'],
  });
}

/** OpenAI Embeddings usage → canonical: input only. */
export function fromOpenAIEmbeddingsUsage(usage: OpenAIEmbeddingsUsageLike | null | undefined) {
  const result = emptyUsage();
  const u = rec(usage);

  result.inputTokens = count(u['prompt_tokens'] ?? u['total_tokens']);

  return result;
}

/** The raw Anthropic usage object, from provider metadata or `usage.raw`. */
function anthropicRawUsage(usage: Record<string, unknown>, providerMetadata: VercelProviderMetadataLike) {
  const fromMetadata = rec(rec(providerMetadata)['anthropic'])['usage'];

  if (isRecord(fromMetadata)) {
    return fromMetadata;
  }

  const raw = usage['raw'];

  return isRecord(raw) && ('cache_creation' in raw || 'server_tool_use' in raw || 'cache_creation_input_tokens' in raw)
    ? raw
    : undefined;
}

/**
 * The Amazon Bedrock provider metadata (`providerMetadata.bedrock`) — its `usage` carries the
 * cache writes (`cacheWriteInputTokens`), which AI SDK v5 does not put in the usage itself.
 */
function bedrockMetadata(providerMetadata: VercelProviderMetadataLike) {
  const bedrock = rec(providerMetadata)['bedrock'];

  return isRecord(bedrock) ? bedrock : undefined;
}

/**
 * Vercel AI SDK usage → canonical.
 *
 * - v6+ (`inputTokenDetails` present): `inputTokens` is cache-inclusive, so the non-cached part
 *   comes from `inputTokenDetails.noCacheTokens` (or total − reads − writes).
 * - v5 (no `inputTokenDetails`): cache reads are the top-level `cachedInputTokens` and reasoning
 *   the top-level `reasoningTokens`. For the cache-EXCLUSIVE providers v5's `inputTokens` already
 *   leaves the cache out and is kept as is: Anthropic (its raw usage in the provider metadata —
 *   reads / writes come from it) and Amazon Bedrock (`providerMetadata.bedrock` — reads are
 *   `cachedInputTokens`, writes `providerMetadata.bedrock.usage.cacheWriteInputTokens`). For every
 *   other provider (OpenAI, Google, …) `inputTokens` includes the reads, which are subtracted.
 *
 * For Anthropic calls the provider metadata (or `usage.raw`) supplies the 1-hour cache-write
 * split and web-search requests. An embedding `{ tokens }` maps to input tokens.
 */
export function fromVercelUsage(usage: VercelUsageLike | null | undefined, providerMetadata?: VercelProviderMetadataLike) {
  if (!isRecord(usage)) {
    return emptyUsage();
  }

  const u = rec(usage);
  const details = rec(u['inputTokenDetails']);

  if (u['inputTokens'] == null && details['noCacheTokens'] == null && u['tokens'] != null) {
    const embedding = emptyUsage();

    embedding.inputTokens = count(u['tokens']);

    return embedding;
  }

  const anthropic = anthropicRawUsage(u, providerMetadata);
  const bedrock = anthropic ? undefined : bedrockMetadata(providerMetadata);
  const outputTokens = count(u['outputTokens']);
  const noDetails = !isRecord(u['inputTokenDetails']) && !isRecord(u['outputTokenDetails']);
  // v5 has neither details object but carries the top-level `cachedInputTokens` / `reasoningTokens`
  // keys (a Bedrock usage without them is still v5: only v6+ has the details objects).
  const isV5 = noDetails && ('cachedInputTokens' in u || 'reasoningTokens' in u || bedrock !== undefined);
  let inputTokens: number;
  let cachedInputTokens: number;
  let cacheWrite: number;
  let reasoning: number;

  if (isV5) {
    reasoning = count(u['reasoningTokens']);

    if (anthropic) {
      inputTokens = count(u['inputTokens']);
      cachedInputTokens = count(anthropic['cache_read_input_tokens'] ?? u['cachedInputTokens']);
      cacheWrite = count(anthropic['cache_creation_input_tokens']);
    } else if (bedrock) {
      const bedrockUsage = rec(bedrock['usage']);

      inputTokens = count(u['inputTokens']);
      cachedInputTokens = count(u['cachedInputTokens'] ?? bedrockUsage['cacheReadInputTokens']);
      cacheWrite = count(bedrockUsage['cacheWriteInputTokens']);
    } else {
      const reported = count(u['inputTokens']);

      cachedInputTokens = Math.min(count(u['cachedInputTokens']), reported);
      inputTokens = reported - cachedInputTokens;
      cacheWrite = 0;
    }
  } else {
    cachedInputTokens = count(details['cacheReadTokens']);
    cacheWrite = count(details['cacheWriteTokens']);
    inputTokens = details['noCacheTokens'] != null ? count(details['noCacheTokens']) : Math.max(0, count(u['inputTokens']) - cachedInputTokens - cacheWrite);
    reasoning = count(rec(u['outputTokenDetails'])['reasoningTokens']);
  }

  const oneHour = anthropic ? Math.min(splitCacheWrites(cacheWrite, anthropic['cache_creation']).cacheWrite1hTokens, cacheWrite) : 0;
  const result: CanonicalUsage = {
    inputTokens,
    cachedInputTokens,
    cacheWrite5mTokens: cacheWrite - oneHour,
    cacheWrite1hTokens: oneHour,
    outputTokens,
    reasoningTokens: Math.min(reasoning, outputTokens),
    toolRequests: toolRequestsOf([[WEB_SEARCH_TOOL, rec(anthropic?.['server_tool_use'])['web_search_requests']]]),
  };

  return result;
}

/**
 * The service tier of an Anthropic call (raw `usage`): `fast` when it ran in fast mode
 * (`usage.speed === 'fast'`, priced at the fast-mode rates), else `usage.service_tier`.
 */
export function anthropicServiceTier(usage: unknown) {
  const u = rec(usage);
  const speed = str(u['speed']);

  if (speed && speed.toLowerCase() === 'fast') return 'fast';

  return str(u['service_tier']);
}

/**
 * Service tier of a cloud provider's regional / multi-region / geography endpoint (Amazon
 * Bedrock geo and in-region inference, Vertex AI regional and multi-region endpoints), which
 * list about 10% above the provider's global endpoint. The catalog prices it on this tier.
 */
export const REGIONAL_SERVICE_TIER = 'regional';

/** ARN resource types whose id names a model or a system inference profile (readable). */
const BEDROCK_READABLE_ARN_TYPES = new Set(['inference-profile', 'foundation-model']);

/**
 * Endpoint tier of an Amazon Bedrock call, from the model id the caller REQUESTED (the
 * response does not say which endpoint served it):
 * - `global.anthropic.…` (Global cross-region inference) → undefined: the base price;
 * - a geography profile (`us.` / `eu.` / `apac.` / `jp.` / `au.` …) or an in-region id with
 *   no profile prefix (`anthropic.claude-…`) → `regional`;
 * - an ARN is read through its resource (`…:inference-profile/us.anthropic.…`,
 *   `…:foundation-model/anthropic.…`); an application inference profile ARN is opaque → undefined.
 */
export function bedrockEndpointTier(modelId: string | undefined) {
  let id = (modelId ?? '').trim().toLowerCase();

  if (!id) return undefined;

  if (id.startsWith('arn:')) {
    const resource = id.split(':').slice(5).join(':');
    const slash = resource.indexOf('/');

    if (slash < 0 || !BEDROCK_READABLE_ARN_TYPES.has(resource.slice(0, slash))) return undefined;

    id = resource.slice(slash + 1);
  }

  if (!id) return undefined;

  return id.split('.')[0] === 'global' ? undefined : REGIONAL_SERVICE_TIER;
}

/**
 * The tier to record when the endpoint has its own price: `fast` (fast-mode rates) wins, then
 * the endpoint tier (`regional`), then the provider's own reported tier.
 */
export function withEndpointTier(serviceTier: string | undefined, endpointTier: string | undefined) {
  if (serviceTier && serviceTier.toLowerCase() === 'fast') return serviceTier;

  return endpointTier ?? serviceTier;
}

/**
 * OpenAI built-in tool calls of a Responses API `response` (its `output` items): `web_search`
 * and `file_search` calls, billed per call on top of tokens.
 */
export function openAIResponsesToolRequests(response: unknown) {
  const output = rec(response)['output'];
  const counts: Record<string, number> = {};

  if (!Array.isArray(output)) return counts;

  for (const item of output) {
    const tool = OPENAI_TOOL_CALL_ITEMS[str(rec(item)['type']) ?? ''];

    if (tool) counts[tool] = (counts[tool] ?? 0) + 1;
  }

  return counts;
}

/** A Chat Completions search model (`gpt-4o-search-preview`, …) — every call runs one web search. */
export function openAIChatSearchRequests(model: string | undefined) {
  const counts: Record<string, number> = {};

  if (model && OPENAI_SEARCH_MODEL.test(model.toLowerCase())) counts[WEB_SEARCH_TOOL] = 1;

  return counts;
}

/**
 * OpenAI built-in tool calls the Vercel AI SDK reports as provider-executed `tool-call` content
 * parts (`@ai-sdk/openai` Responses models). Only the default tool names are recognised —
 * `web_search` / `web_search_preview` / `file_search`; a tool registered under another key is
 * not counted.
 */
export function vercelOpenAIToolRequests(content: unknown) {
  const counts: Record<string, number> = {};

  if (!Array.isArray(content)) return counts;

  for (const part of content) {
    const p = rec(part);

    if (p['type'] !== 'tool-call' || p['providerExecuted'] !== true) continue;

    const name = (str(p['toolName']) ?? '').toLowerCase();
    const tool = name === WEB_SEARCH_TOOL || name === 'web_search_preview' ? WEB_SEARCH_TOOL : name === FILE_SEARCH_TOOL ? FILE_SEARCH_TOOL : undefined;

    if (tool) counts[tool] = (counts[tool] ?? 0) + 1;
  }

  return counts;
}

/** `base` with `extra` tool-request counts added (a new object). */
export function withToolRequests(base: CanonicalUsage, extra: Record<string, number>) {
  if (Object.keys(extra).length === 0) return base;

  const toolRequests = { ...base.toolRequests };

  for (const [name, n] of Object.entries(extra)) {
    toolRequests[name] = (toolRequests[name] ?? 0) + n;
  }

  const result: CanonicalUsage = { ...base, toolRequests };

  return result;
}

/** Tokens the provider bills for a canonical usage (every disjoint token part). */
export function billedTokens(usage: CanonicalUsage) {
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens + usage.outputTokens;
}

/** Map keys the server refuses (they would reach `Object.prototype` machinery). */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Optional sink for `sanitizeUsage`'s data-quality notes: `(key, message)`, keyed for once-only warnings. */
export type UsageWarn = (key: string, message: string) => void;

function clampTokens(value: unknown, field: string, warn: UsageWarn | undefined) {
  const n = count(value);

  if (n > AI_SPEND_LIMITS.MAX_TOKENS_PER_FIELD) {
    warn?.('usage_tokens_cap', `usage.${field} is above ${AI_SPEND_LIMITS.MAX_TOKENS_PER_FIELD} tokens for one call — it was capped there`);

    return AI_SPEND_LIMITS.MAX_TOKENS_PER_FIELD;
  }

  return n;
}

/**
 * Tool-request counts as the server stores them: names trimmed and lower-cased (case variants
 * merged), reserved and invalid names dropped, each count capped, at most 20 names.
 */
function sanitizeToolRequests(raw: unknown, warn: UsageWarn | undefined) {
  const merged = new Map<string, number>();

  for (const [rawName, value] of Object.entries(rec(raw))) {
    const name = rawName.trim().toLowerCase();

    if (!isValidToolName(name) || RESERVED_KEYS.has(name)) {
      warn?.('tool_name_invalid', 'a usage.toolRequests name is empty, longer than 64 characters, reserved or not well-formed text — it was dropped');
      continue;
    }

    const n = count(value);

    if (n > 0) merged.set(name, (merged.get(name) ?? 0) + n);
  }

  const out: Record<string, number> = {};

  for (const [name, n] of merged) {
    if (Object.keys(out).length >= AI_SPEND_LIMITS.MAX_TOOL_NAMES) {
      warn?.('tool_name_count', `more than ${AI_SPEND_LIMITS.MAX_TOOL_NAMES} usage.toolRequests names on one call — the extra names were dropped`);
      break;
    }

    if (n > AI_SPEND_LIMITS.MAX_TOOL_REQUESTS_PER_TOOL) {
      warn?.('tool_request_cap', `a usage.toolRequests count is above ${AI_SPEND_LIMITS.MAX_TOOL_REQUESTS_PER_TOOL} for one call — it was capped there`);
    }

    out[name] = Math.min(n, AI_SPEND_LIMITS.MAX_TOOL_REQUESTS_PER_TOOL);
  }

  return out;
}

/**
 * Coerce a partial / hand-built usage into one the server accepts: integers ≥ 0 capped at the
 * per-field maximum, reasoning ≤ output, tool names normalised as the server stores them.
 */
export function sanitizeUsage(usage: Partial<CanonicalUsage> | null | undefined, warn?: UsageWarn) {
  const u = rec(usage);
  const outputTokens = clampTokens(u['outputTokens'], 'outputTokens', warn);
  const result: CanonicalUsage = {
    inputTokens: clampTokens(u['inputTokens'], 'inputTokens', warn),
    cachedInputTokens: clampTokens(u['cachedInputTokens'], 'cachedInputTokens', warn),
    cacheWrite5mTokens: clampTokens(u['cacheWrite5mTokens'], 'cacheWrite5mTokens', warn),
    cacheWrite1hTokens: clampTokens(u['cacheWrite1hTokens'], 'cacheWrite1hTokens', warn),
    outputTokens,
    reasoningTokens: Math.min(clampTokens(u['reasoningTokens'], 'reasoningTokens', warn), outputTokens),
    toolRequests: sanitizeToolRequests(u['toolRequests'], warn),
  };

  return result;
}

/** True when `value` contains a C0 control character or DEL (the server rejects them in tool names). */
function hasControlCharacter(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code < 0x20 || code === 0x7f) return true;
  }

  return false;
}

/** A tool name the server accepts: 1–64 storable chars, no control characters. */
export function isValidToolName(name: string) {
  return name.length > 0 && name.length <= AI_SPEND_LIMITS.TOOL_NAME_MAX_LENGTH && isStorableText(name) && !hasControlCharacter(name);
}

// ---------------------------------------------------------------- manual usage checks

/** The keys of a {@link CanonicalUsage} — the only ones `record({ usage })` reads. */
export const CANONICAL_USAGE_KEYS: readonly string[] = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
  'outputTokens',
  'reasoningTokens',
  'toolRequests',
];

const CANONICAL_KEY_SET: ReadonlySet<string> = new Set(CANONICAL_USAGE_KEYS);

/** Common wrong names (lower-cased, letters and digits only) → the canonical key meant. */
const USAGE_KEY_ALIASES: Readonly<Record<string, string>> = {
  input: 'inputTokens',
  inputtoken: 'inputTokens',
  prompt: 'inputTokens',
  prompttokens: 'inputTokens',
  tokens: 'inputTokens',
  uncachedinputtokens: 'inputTokens',
  nocachetokens: 'inputTokens',
  output: 'outputTokens',
  outputtoken: 'outputTokens',
  completion: 'outputTokens',
  completiontokens: 'outputTokens',
  cached: 'cachedInputTokens',
  cachedtokens: 'cachedInputTokens',
  cachedinput: 'cachedInputTokens',
  cacheread: 'cachedInputTokens',
  cachereadtokens: 'cachedInputTokens',
  cachereadinputtokens: 'cachedInputTokens',
  cachewrite: 'cacheWrite5mTokens',
  cachewritetokens: 'cacheWrite5mTokens',
  cachewriteinputtokens: 'cacheWrite5mTokens',
  cachecreation: 'cacheWrite5mTokens',
  cachecreationtokens: 'cacheWrite5mTokens',
  cachecreationinputtokens: 'cacheWrite5mTokens',
  reasoning: 'reasoningTokens',
  thinking: 'reasoningTokens',
  thinkingtokens: 'reasoningTokens',
  tools: 'toolRequests',
  toolcalls: 'toolRequests',
};

/** Keys that mark a provider-shaped usage, and the normalizer that turns it into a canonical one. */
const PROVIDER_SHAPE_HINTS: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [['inputTokenDetails', 'outputTokenDetails', 'totalTokens', 'raw'], 'fromVercelUsage(result.usage, result.providerMetadata)'],
  [['prompt_tokens', 'completion_tokens', 'prompt_tokens_details', 'completion_tokens_details'], 'fromOpenAIChatUsage(completion.usage)'],
  [['cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation', 'server_tool_use'], 'fromAnthropicUsage(message.usage)'],
  [['input_tokens_details', 'output_tokens_details'], 'fromOpenAIResponsesUsage(response.usage)'],
  [['input_tokens', 'output_tokens'], 'fromAnthropicUsage(message.usage) or fromOpenAIResponsesUsage(response.usage)'],
];

function squash(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];

    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }

    previous = row;
  }

  return previous[b.length];
}

/** The canonical key a wrong usage key most likely meant (alias table, then the closest spelling), if any. */
export function suggestUsageKey(key: string) {
  const squashed = squash(key);
  const exact = CANONICAL_USAGE_KEYS.find((canonical) => squash(canonical) === squashed);

  if (exact) return exact;

  const alias = USAGE_KEY_ALIASES[squashed];

  if (alias) return alias;

  let best: string | undefined;
  let bestDistance = 4; // at most 3 edits away

  for (const canonical of CANONICAL_USAGE_KEYS) {
    const distance = editDistance(squashed, squash(canonical));

    if (distance < bestDistance) {
      best = canonical;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * What is wrong with a hand-built `record({ usage })`: `notAnObject` when it is neither an object
 * nor absent, else every key (with a value) the SDK does not read — each with the canonical key it
 * most likely meant — and the `from*Usage` normalizer for a provider-shaped usage passed as is.
 */
export function checkUsageKeys(usage: unknown) {
  if (usage === undefined || usage === null) return { notAnObject: false, unknown: [], normalizer: undefined };

  if (!isRecord(usage)) return { notAnObject: true, unknown: [], normalizer: undefined };

  const unknown: Array<{ key: string; suggestion: string | undefined }> = [];

  for (const [key, value] of Object.entries(usage)) {
    if (value === undefined || CANONICAL_KEY_SET.has(key)) continue;

    unknown.push({ key, suggestion: suggestUsageKey(key) });
  }

  const keys = new Set(unknown.map(({ key }) => key));
  const normalizer = PROVIDER_SHAPE_HINTS.find(([markers]) => markers.some((marker) => keys.has(marker)))?.[1];

  return { notAnObject: false, unknown, normalizer };
}

/** True when a canonical usage reports nothing billable: no tokens of any kind and no tool requests. */
export function isEmptyUsage(usage: CanonicalUsage) {
  return billedTokens(usage) === 0 && usage.reasoningTokens === 0 && Object.keys(usage.toolRequests).length === 0;
}
