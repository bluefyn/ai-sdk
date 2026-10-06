/**
 * The ingest wire contract (`POST {endpoint}/v1/ai-usage/events`, and
 * `POST {endpoint}/v1/ai-usage/customers/names` for customer names) and the SDK's own input
 * types. Wire fields are snake_case exactly as the public API documents them; SDK-facing
 * inputs are camelCase.
 */

export const AI_SPEND_SDK_NAME = '@bluefyn/ai-spend-sdk';
/** Kept equal to package.json `version` (a spec asserts it). */
export const AI_SPEND_SDK_VERSION = '0.2.0';
export const AI_SPEND_DEFAULT_ENDPOINT = 'https://gateway.bluefyn.ai/api';
export const AI_SPEND_EVENTS_PATH = '/v1/ai-usage/events';
/** Where `nameCustomer()` reports display names — separately from usage events, which never carry one. */
export const AI_SPEND_CUSTOMER_NAMES_PATH = '/v1/ai-usage/customers/names';
/** Environment variable the ingest key is read from when `apiKey` is not passed. */
export const AI_SPEND_API_KEY_ENV = 'BLUEFYN_AI_SPEND_KEY';
/**
 * Environment variable the API base is read from when `endpoint` is not passed (Node only) —
 * e.g. `https://gateway.example.com/api`. Same rule as the option: the base WITHOUT `/v1` (a
 * trailing `/v1` is stripped with one warning).
 */
export const AI_SPEND_ENDPOINT_ENV = 'BLUEFYN_AI_SPEND_ENDPOINT';

/** Outcome of the provider call. */
export const AiSpendStatus = {
  SUCCESS: 'success',
  ERROR: 'error',
  ABORTED: 'aborted',
} as const;
export type AiSpendStatus = (typeof AiSpendStatus)[keyof typeof AiSpendStatus];

/** Providers the platform prices out of the box; any other string is accepted (manual records). */
export const AiSpendProvider = {
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  BEDROCK: 'bedrock',
  AZURE_OPENAI: 'azure_openai',
  GOOGLE: 'google',
  /**
   * Calls routed through the Vercel AI Gateway (AI SDK string model ids such as
   * `'anthropic/claude-sonnet-4.5'`). Vercel bills them, so they carry the gateway's own cost
   * and are never reconciled against a direct Anthropic / OpenAI bill.
   */
  VERCEL_GATEWAY: 'vercel_gateway',
} as const;
export type AiSpendKnownProvider = (typeof AiSpendProvider)[keyof typeof AiSpendProvider];

/** Which integration produced an event (diagnostics only). */
export const AiSpendAdapter = {
  MANUAL: 'manual',
  VERCEL: 'vercel',
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
} as const;
export type AiSpendAdapter = (typeof AiSpendAdapter)[keyof typeof AiSpendAdapter];

/** Per-event rejection codes returned in a `202` body. */
export const AiSpendRejectionCode = {
  INVALID_SCHEMA: 'invalid_schema',
  OCCURRED_AT_OUT_OF_RANGE: 'occurred_at_out_of_range',
  /**
   * Retired: no longer emitted — an invalid `feature` is now dropped from a stored event with a
   * `field_dropped` warning ({@link AiSpendWarningCode}). Kept for compatibility.
   */
  INVALID_FEATURE: 'invalid_feature',
  /**
   * Retired: no longer emitted — tags past the limit are dropped from a stored event with a
   * `tags_truncated` warning ({@link AiSpendWarningCode}). Kept for compatibility.
   */
  TOO_MANY_TAGS: 'too_many_tags',
  USAGE_INCONSISTENT: 'usage_inconsistent',
  UNSUPPORTED_CURRENCY: 'unsupported_currency',
} as const;
export type AiSpendRejectionCode = (typeof AiSpendRejectionCode)[keyof typeof AiSpendRejectionCode];

/**
 * Per-event warning codes returned in a `202` body (`warnings`): the event WAS stored (usage and
 * cost kept), but an invalid attribution or diagnostic field was dropped from it. Fix the field
 * in later events; never resend the event.
 */
export const AiSpendWarningCode = {
  /** The field was invalid and was dropped (e.g. a negative `latency_ms`, a malformed `feature` or tag). */
  FIELD_DROPPED: 'field_dropped',
  /** More tags than an event may carry: the tags past the limit (in key order) were dropped. */
  TAGS_TRUNCATED: 'tags_truncated',
} as const;
export type AiSpendWarningCode = (typeof AiSpendWarningCode)[keyof typeof AiSpendWarningCode];

/** Wire limits (mirrors of the server-side validator). */
export const AI_SPEND_LIMITS = {
  FEATURE_PATTERN: /^[a-z0-9_-]+(\.[a-z0-9_-]+){0,5}$/,
  FEATURE_MAX_LENGTH: 128,
  CUSTOMER_MAX_LENGTH: 256,
  /** `display_name` of a customer (`nameCustomer()`), trimmed. */
  CUSTOMER_NAME_MAX_LENGTH: 256,
  USER_MAX_LENGTH: 256,
  ENTITY_REF_MAX_LENGTH: 256,
  RUN_ID_MAX_LENGTH: 128,
  MAX_TAGS: 10,
  TAG_KEY_PATTERN: /^[a-z0-9_.-]{1,40}$/,
  TAG_VALUE_MAX_LENGTH: 128,
  /** Distinct `usage.tool_requests` names per event. */
  MAX_TOOL_NAMES: 20,
  TOOL_NAME_MAX_LENGTH: 64,
  /** `occurred_at` older than this is rejected by the server. */
  MAX_EVENT_AGE_MS: 30 * 24 * 60 * 60_000,
  /** `occurred_at` further in the future than this is rejected by the server. */
  MAX_EVENT_FUTURE_SKEW_MS: 5 * 60_000,
  /** `provider` (checked lower-cased, as the server stores it). */
  PROVIDER_MAX_LENGTH: 64,
  /** `model` (and its lower-cased form). */
  MODEL_MAX_LENGTH: 160,
  /** `service_tier` (lower-cased). */
  SERVICE_TIER_MAX_LENGTH: 32,
  /** `latency_ms` is a Postgres INTEGER. */
  MAX_LATENCY_MS: 2_147_483_647,
  /** Each token count of one event. */
  MAX_TOKENS_PER_FIELD: 10_000_000_000,
  /** Each `usage.tool_requests` count of one event. */
  MAX_TOOL_REQUESTS_PER_TOOL: 1_000_000,
  /** Integer digits of `cost.amount` (below $1,000,000 per call). */
  COST_MAX_INTEGER_DIGITS: 6,
  MAX_EVENTS_PER_BATCH: 500,
  MAX_BATCH_BYTES: 1_000_000,
  /** Entries per `POST /v1/ai-usage/customers/names`. */
  MAX_CUSTOMER_NAMES_PER_REQUEST: 100,
} as const;

/**
 * Disjoint token counts of ONE provider call — they sum to what the provider bills.
 * Same shape as the platform's `AiSpendCanonicalUsage`.
 */
export interface CanonicalUsage {
  /** Uncached input tokens only. */
  inputTokens: number;
  /** Cache reads. */
  cachedInputTokens: number;
  /** Cache writes with a 5-minute TTL (Anthropic's default; every other provider's writes land here). */
  cacheWrite5mTokens: number;
  /** Cache writes with a 1-hour TTL. */
  cacheWrite1hTokens: number;
  /** Output tokens, reasoning included. */
  outputTokens: number;
  /** Informational subset of `outputTokens`; never priced separately. */
  reasoningTokens: number;
  /** Server-side tool requests by tool name, e.g. `{ web_search: 2 }`. */
  toolRequests: Record<string, number>;
}

/** Who and what a model call is attributed to. Every field is optional. */
export interface AiSpendAttribution {
  /** Opaque id of YOUR customer (never an email or other PII). ≤256 chars. */
  customer?: string;
  /** Lowercase dot-path naming the product capability, e.g. `support.chat.summarize`. ≤6 segments of `[a-z0-9_-]`, ≤128 chars. */
  feature?: string;
  /** Opaque id of the end user. ≤256 chars. */
  user?: string;
  /** Groups every model call of one agent run / job. ≤128 chars. */
  runId?: string;
  /** The record being processed, `type:id` (e.g. `contract:123`). ≤256 chars. */
  entityRef?: string;
  /** ≤10 free-form tags; key `[a-z0-9_.-]{1,40}`, value ≤128 chars. */
  tags?: Record<string, string>;
}

/** An explicit cost for a model the platform cannot price (self-hosted, niche provider). USD only. */
export interface AiSpendCostInput {
  /** Decimal amount, e.g. `'0.0042'` (a number is accepted and stringified). */
  amount: string | number;
  currency?: 'USD';
}

/** Input of `client.record()` — one provider call. */
export interface AiSpendUsageRecord extends AiSpendAttribution {
  /** `anthropic`, `openai`, `bedrock`, `azure_openai`, `google`, or any other provider name. */
  provider: string;
  /** Model id as the provider returned it (never a deployment name). */
  model: string;
  /** Token counts; omitted parts count as 0. Build it with a `from*Usage` normalizer. */
  usage?: Partial<CanonicalUsage>;
  /** Defaults to `success`. */
  status?: AiSpendStatus;
  /**
   * The provider's service tier, sent lower-cased: OpenAI's response `service_tier`
   * (`default` / `flex` / `priority` / `scale`), Anthropic's `usage.service_tier`
   * (`standard` / `priority` / `batch`), or `fast` for an Anthropic fast-mode call. The
   * Anthropic and Vercel adapters send `regional` for a Bedrock geography / in-region call and
   * (Anthropic adapter) a Vertex call outside the `global` region — priced above the global endpoint.
   */
  serviceTier?: string;
  /** The call was batch-priced. */
  batch?: boolean;
  /** Milliseconds; rounded. A value above 2^31 − 1 is left out (the event is still sent). */
  latencyMs?: number;
  /**
   * When the call ended (a `Date`, an ISO string or epoch MILLISECONDS). Defaults to now. Usage
   * is booked on the UTC day of `occurredAt`. The server dedupes on `eventId` alone, across its
   * 30-day ingest window — so a replay is still a duplicate when its `occurredAt` differs — but
   * pass the original call time whenever you pass `eventId`: a replay stamped "now" lands on the
   * wrong day if its first send never arrived, and once the original is older than 30 days it
   * is no longer in the window and would be stored again (with the original time it is rejected
   * as `occurred_at_out_of_range` instead).
   */
  occurredAt?: Date | string | number;
  /**
   * Idempotency key; defaults to a fresh UUIDv7 (every `record()` is then a new event). To make
   * your own replays (job retries, re-delivered webhooks) dedupe, pass the SAME key each time
   * (the server dedupes on it across its 30-day ingest window), with the original `occurredAt`:
   * - a UUID (any version) is sent as is (lower-cased);
   * - any other non-empty string — e.g. `${job.id}:${step}` — is turned into a deterministic
   *   UUIDv5 (`eventIdFrom(key)`), so the same key always yields the same `event_id`.
   * The REST API itself only accepts a UUID `event_id`.
   */
  eventId?: string;
  cost?: AiSpendCostInput;
}

// ---------------------------------------------------------------- wire (snake_case)

export interface AiSpendWireUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  tool_requests?: Record<string, number>;
}

export interface AiSpendWireCost {
  amount: string;
  currency: 'USD';
}

export interface AiSpendWireSdkInfo {
  name: string;
  version: string;
  adapter: string;
}

export interface AiSpendWireEvent {
  event_id: string;
  occurred_at: string;
  provider: string;
  model: string;
  service_tier?: string;
  batch?: boolean;
  status: AiSpendStatus;
  latency_ms?: number;
  usage?: AiSpendWireUsage;
  customer?: string;
  feature?: string;
  user?: string;
  run_id?: string;
  entity_ref?: string;
  tags?: Record<string, string>;
  cost?: AiSpendWireCost;
  sdk?: AiSpendWireSdkInfo;
}

export interface AiSpendWireBatch {
  events: AiSpendWireEvent[];
}

export interface AiSpendWireRejection {
  index: number;
  event_id?: string;
  code: AiSpendRejectionCode | string;
  detail: string;
}

/** A field dropped from a STORED event (`202` `warnings`). The event must not be resent. */
export interface AiSpendWireWarning {
  index: number;
  event_id?: string;
  code: AiSpendWarningCode | string;
  /** Wire field the warning is about, e.g. `latency_ms`, `feature`, `tags.region`. */
  field: string;
  detail: string;
}

/** `202 Accepted` body. */
export interface AiSpendWireResponse {
  accepted: number;
  duplicates: number;
  rejected: AiSpendWireRejection[];
  /**
   * Invalid attribution / diagnostic fields dropped from events that WERE stored (their usage and
   * cost kept). Absent on older servers.
   */
  warnings?: AiSpendWireWarning[];
  /**
   * Accepted events whose `feature` was booked under `_overflow` because the workspace already
   * has its maximum number of feature paths. Absent on older servers.
   */
  overflowed_features?: number;
  /** Tags dropped from accepted events because the workspace already has its maximum number of tag keys. Absent on older servers. */
  dropped_tag_keys?: number;
}

/** One entry of `POST /v1/ai-usage/customers/names`. Both values are trimmed. */
export interface AiSpendWireCustomerName {
  /** The opaque id your AI calls are attributed to (`customer`). */
  customer: string;
  display_name: string;
}

export interface AiSpendWireCustomerNamesRequest {
  /** 1–100 entries. */
  customers: AiSpendWireCustomerName[];
}

export interface AiSpendWireCustomerNameRejection {
  /** Position of the entry in `customers`. */
  index: number;
  /** The entry's customer, when the server could read one. */
  customer: string | null;
  code: string;
  message: string;
}

/**
 * `200 OK` body of `POST /v1/ai-usage/customers/names`. `named` entries were stored; `unchanged`
 * ones the server already had — or kept the name a person set in Bluefyn, which always wins.
 */
export interface AiSpendWireCustomerNamesResponse {
  named: number;
  unchanged: number;
  rejected: AiSpendWireCustomerNameRejection[];
}
