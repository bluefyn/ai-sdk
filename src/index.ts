/**
 * `@bluefyn/ai-spend-sdk` — track the cost of your AI features per customer and feature.
 * In-process, asynchronous, metadata only (token counts, model, attribution — never prompts
 * or completions; customer display names only when you report them with `nameCustomer()`).
 * Adapters: `@bluefyn/ai-spend-sdk/vercel` (Vercel AI SDK v7), `/anthropic`, `/openai`; manual
 * `record()` for everything else.
 */
export { createAiSpend } from './client';
export type { AiSpendClient, AiSpendOptions, AiSpendShutdownOptions } from './client';
export type { AiSpendCustomerNameStats, AiSpendFetch, AiSpendFetchResponse, AiSpendLogger, AiSpendStats } from './delivery';
export { carry, current, withCarried, withContext } from './attribution';
export type { AiSpendCarrier } from './attribution';
export {
  fromAnthropicUsage,
  fromOpenAIChatUsage,
  fromOpenAIEmbeddingsUsage,
  fromOpenAIResponsesUsage,
  fromVercelUsage,
} from './normalize';
export type {
  AnthropicUsageLike,
  OpenAIChatUsageLike,
  OpenAIEmbeddingsUsageLike,
  OpenAIResponsesUsageLike,
  VercelProviderMetadataLike,
  VercelUsageLike,
} from './normalize';
export {
  AiSpendAttributionError,
  AiSpendAttributionIssueCode,
  AiSpendDeliveryError,
  AiSpendFieldWarningError,
  AiSpendInvalidUsageError,
  AiSpendRejectedCustomerNameError,
  AiSpendRejectedEventError,
  AiSpendSdkError,
  AiSpendUsageIssueCode,
} from './errors';
export type { AiSpendAttributionIssue, AiSpendUsageIssue } from './errors';
export { uuidv7 } from './uuidv7';
export { eventIdFrom } from './event-id';
export {
  AI_SPEND_API_KEY_ENV,
  AI_SPEND_CUSTOMER_NAMES_PATH,
  AI_SPEND_DEFAULT_ENDPOINT,
  AI_SPEND_ENDPOINT_ENV,
  AI_SPEND_EVENTS_PATH,
  AI_SPEND_LIMITS,
  AI_SPEND_SDK_NAME,
  AI_SPEND_SDK_VERSION,
  AiSpendAdapter,
  AiSpendProvider,
  AiSpendRejectionCode,
  AiSpendStatus,
  AiSpendWarningCode,
} from './wire';
export type {
  AiSpendAttribution,
  AiSpendCostInput,
  AiSpendKnownProvider,
  AiSpendUsageRecord,
  AiSpendWireBatch,
  AiSpendWireCost,
  AiSpendWireCustomerName,
  AiSpendWireCustomerNameRejection,
  AiSpendWireCustomerNamesRequest,
  AiSpendWireCustomerNamesResponse,
  AiSpendWireEvent,
  AiSpendWireRejection,
  AiSpendWireResponse,
  AiSpendWireSdkInfo,
  AiSpendWireUsage,
  AiSpendWireWarning,
  CanonicalUsage,
} from './wire';
