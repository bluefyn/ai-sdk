import type { AiSpendClient } from './client';
import {
  fromOpenAIChatUsage,
  fromOpenAIEmbeddingsUsage,
  fromOpenAIResponsesUsage,
  openAIChatSearchRequests,
  openAIResponsesToolRequests,
  withToolRequests,
} from './normalize';
import { internalOf } from './internal';
import { clipText, isRecord, rec, safe, str } from './util';
import { AI_SPEND_LIMITS, AiSpendAdapter, AiSpendProvider, AiSpendStatus } from './wire';
import type { AiSpendAttribution, AiSpendStatus as AiSpendStatusValue } from './wire';
import { baseUrlHost, runEventStreamCall, runPromiseCall, tapIterableStream, wrapClient } from './wrap';
import type { AdapterCall, MethodContext, MethodHandler, ProxyNode, RecordingStreamObserver, WrapConfig } from './wrap';

export { aiSpendOptions } from './wrap';
export type { AiSpendWrapped } from './wrap';

/**
 * OpenAI SDK adapter (`openai`, incl. `AzureOpenAI`): wrap the client once, and every call
 * below records ONE usage event when it finishes.
 *
 * Instrumented:
 * - `chat.completions.create()` — non-streaming, and `stream: true`. OpenAI reports stream
 *   usage only when `stream_options.include_usage` is true, so when the caller did NOT set
 *   `include_usage`, the wrapper sends `include_usage: true` and HIDES the extra usage-only
 *   final chunk (`choices: []`) from the caller — iteration, `tee()` and
 *   `toReadableStream()` yield exactly the chunks they would have without the wrapper
 *   (other chunks may carry `usage: null`, which the SDK types already allow). A caller that
 *   set `include_usage: true` sees its usage chunk as usual; one that set it to `false` is
 *   respected and the stream is recorded without token counts.
 * - `chat.completions.parse()` — structured outputs.
 * - `responses.create()` — non-streaming, and `stream: true` (usage from the
 *   `response.completed` / `response.incomplete` / `response.failed` event); `responses.parse()`;
 *   `responses.stream()` (the `ResponseStream` helper, recorded on its `end` event).
 * - `embeddings.create()`.
 *
 * Not instrumented (record manually): background responses (`background: true` — billed when
 * they finish, possibly in another process), `responses.stream({ response_id })` replays,
 * the `chat.completions.stream()` / `runTools()` helpers, Assistants, Realtime, audio, images
 * and batch. Breaking out of a chat-completions stream before its final chunk records the call
 * as `aborted` without token counts (OpenAI reports stream usage only at the very end).
 *
 * Built-in tools: Responses `web_search_call` / `file_search_call` output items are counted as
 * `usage.toolRequests.web_search` / `.file_search` (billed per call); a Chat Completions search
 * model (`*-search-preview`) counts one `web_search` per call. Code interpreter is billed per
 * container session, not per call, and is not counted.
 *
 * Provider (override with `wrapOpenAI(client, aiSpend, defaults, { provider })`, e.g. for a
 * LiteLLM / Helicone proxy in front of real OpenAI): `azure_openai` when the client's `baseURL`
 * host is an Azure OpenAI / AI Foundry endpoint (`*.openai.azure.com`,
 * `*.cognitiveservices.azure.com`, `*.services.ai.azure.com`) or the client is an `AzureOpenAI`
 * (has an `apiVersion`); `openai` for `api.openai.com` (or no `baseURL`); a well-known
 * OpenAI-compatible host maps to its provider (`groq`, `openrouter`, `deepseek`, `google`, `xai`,
 * `together`, `fireworks`, `mistral`); any other host is recorded as its lower-cased host name —
 * with ONE warning per host, because the catalog has no price for it (its calls stay unpriced
 * until a price is added for that provider, or `{ provider }` names the real one). The model
 * recorded is the one in the RESPONSE — the real model, never an Azure deployment name.
 *
 * Azure `api-version`s before `2024-09-01` reject `stream_options`: on such a client the wrapper
 * does not add `include_usage`, and streamed chat completions are recorded without token counts
 * (one warning) — upgrade the api-version for exact cost.
 *
 * The client is typed structurally — the package has no dependency on `openai`.
 */

/** The part of an OpenAI client the wrapper needs (`OpenAI`, `AzureOpenAI`). */
export interface OpenAIClientLike {
  chat: { completions: { create: (...args: never[]) => unknown } };
}

// ---------------------------------------------------------------- chat completions

/**
 * One chat-completions stream. The final chunk (with `include_usage`) has `choices: []` and
 * the usage of the whole request; every other chunk has `usage: null`.
 */
class ChatStreamObserver implements RecordingStreamObserver {
  public complete = false;
  private model: string | undefined;
  private serviceTier: string | undefined;
  private usage: unknown;

  public constructor(
    /** The wrapper injected `include_usage` — hide the usage-only chunk from the caller. */
    private readonly hideUsageChunk: boolean,
    /** Usage is expected at the end (injected, or the caller asked for it). */
    private readonly usageExpected: boolean,
  ) {}

  public event(event: unknown) {
    const chunk = rec(event);
    const choices = chunk['choices'];

    this.model = str(chunk['model']) ?? this.model;
    this.serviceTier = str(chunk['service_tier']) ?? this.serviceTier;

    if (!this.usageExpected && Array.isArray(choices) && choices.some((choice) => rec(choice)['finish_reason'] != null)) {
      this.complete = true;
    }

    if (isRecord(chunk['usage'])) {
      this.usage = chunk['usage'];
      this.complete = true;

      return this.hideUsageChunk && Array.isArray(choices) && choices.length === 0;
    }

    return false;
  }

  public finish(call: AdapterCall, status: AiSpendStatusValue) {
    call.record({ status, model: this.model, usage: withToolRequests(fromOpenAIChatUsage(rec(this.usage)), chatSearches(call, this.model)), serviceTier: this.serviceTier });
  }
}

/** One web search when the requested or the responding model is a Chat Completions search model. */
function chatSearches(call: AdapterCall, responseModel: string | undefined) {
  const fromResponse = openAIChatSearchRequests(responseModel);

  return Object.keys(fromResponse).length > 0 ? fromResponse : openAIChatSearchRequests(call.requestModel);
}

function recordChatCompletion(call: AdapterCall, value: unknown) {
  const completion = rec(value);
  const model = str(completion['model']);

  call.record({
    status: AiSpendStatus.SUCCESS,
    model,
    usage: withToolRequests(fromOpenAIChatUsage(rec(completion['usage'])), chatSearches(call, model)),
    serviceTier: str(completion['service_tier']),
  });
}

/** Azure OpenAI `api-version`s before this one reject the `stream_options` request argument. */
const AZURE_STREAM_OPTIONS_SINCE = '2024-09-01';

/** True when the wrapped client is an Azure OpenAI client pinned to an api-version that rejects `stream_options`. */
function rejectsStreamOptions(ctx: MethodContext) {
  if (ctx.scope.provider !== AiSpendProvider.AZURE_OPENAI) return false;

  const apiVersion = Reflect.get(ctx.scope.target, 'apiVersion');
  const day = typeof apiVersion === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(apiVersion)?.[0] : undefined;

  return day !== undefined && day < AZURE_STREAM_OPTIONS_SINCE;
}

/** `chat.completions.create(body, options)`. */
function chatCreate(ctx: MethodContext) {
  const body = rec(ctx.args[0]);
  const streaming = body['stream'] === true;
  const streamOptions = rec(body['stream_options']);
  const oldAzure = streaming && streamOptions['include_usage'] === undefined && rejectsStreamOptions(ctx);

  if (oldAzure) {
    ctx.scope.warnOnce(
      'azure_stream_options',
      `AI Spend: this AzureOpenAI client's api-version predates ${AZURE_STREAM_OPTIONS_SINCE} and rejects stream_options, so streamed chat completions are recorded WITHOUT token counts — upgrade to api-version 2024-10-21 or later for exact cost`,
    );
  }

  const inject = streaming && streamOptions['include_usage'] === undefined && !oldAzure;
  const args = inject ? [{ ...body, stream_options: { ...streamOptions, include_usage: true } }, ...ctx.args.slice(1)] : ctx.args;
  const usageExpected = inject || streamOptions['include_usage'] === true;

  return runPromiseCall({ ...ctx, args }, str(body['model']), (call, value) => {
    if (streaming && tapIterableStream(value, () => new ChatStreamObserver(inject, usageExpected), (observer, status) => observer.finish(call, status))) {
      return;
    }

    recordChatCompletion(call, value);
  });
}

/** `chat.completions.parse(body, options)` — never streams. */
function chatParse(ctx: MethodContext) {
  return runPromiseCall(ctx, str(rec(ctx.args[0])['model']), recordChatCompletion);
}

// ---------------------------------------------------------------- responses

/** `Response.status` → event status; `undefined` = not finished yet (not billed yet — not recorded). */
function responseStatus(status: unknown) {
  switch (status) {
    case 'failed':
      return AiSpendStatus.ERROR;
    case 'cancelled':
      return AiSpendStatus.ABORTED;
    case 'queued':
    case 'in_progress':
      return undefined;
    default:
      return AiSpendStatus.SUCCESS;
  }
}

const TERMINAL_RESPONSE_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/** One Responses API stream: usage arrives with the terminal `response.*` event. */
class ResponsesStreamObserver implements RecordingStreamObserver {
  public complete = false;
  private model: string | undefined;
  private serviceTier: string | undefined;
  private usage: unknown;
  private toolRequests: Record<string, number> = {};
  private failed = false;

  public event(event: unknown) {
    const e = rec(event);
    const type = str(e['type']);
    const response = rec(e['response']);

    this.model = str(response['model']) ?? this.model;
    this.serviceTier = str(response['service_tier']) ?? this.serviceTier;

    if (type && TERMINAL_RESPONSE_EVENTS.has(type)) {
      this.usage = response['usage'];
      this.toolRequests = openAIResponsesToolRequests(response);
      this.failed = type === 'response.failed';
      this.complete = true;
    }

    return false;
  }

  public finish(call: AdapterCall, status: AiSpendStatusValue) {
    call.record({
      status: this.failed ? AiSpendStatus.ERROR : status,
      model: this.model,
      usage: withToolRequests(fromOpenAIResponsesUsage(rec(this.usage)), this.toolRequests),
      serviceTier: this.serviceTier,
    });
  }
}

function recordResponse(call: AdapterCall, value: unknown) {
  const response = rec(value);
  const status = responseStatus(response['status']);

  if (!status) return;

  call.record({
    status,
    model: str(response['model']),
    usage: withToolRequests(fromOpenAIResponsesUsage(rec(response['usage'])), openAIResponsesToolRequests(response)),
    serviceTier: str(response['service_tier']),
  });
}

/**
 * Background responses (`background: true`) are billed when they finish — possibly in another
 * process — so they pass straight through, unrecorded.
 */
function unlessBackground(handler: MethodHandler): MethodHandler {
  return (ctx) => (rec(ctx.args[0])['background'] === true ? ctx.original(...ctx.args) : handler(ctx));
}

/** `responses.create(body, options)`. */
function responsesCreate(ctx: MethodContext) {
  const body = rec(ctx.args[0]);
  const streaming = body['stream'] === true;

  return runPromiseCall(ctx, str(body['model']), (call, value) => {
    if (streaming && tapIterableStream(value, () => new ResponsesStreamObserver(), (observer, status) => observer.finish(call, status))) {
      return;
    }

    recordResponse(call, value);
  });
}

/** `responses.parse(body, options)` — never streams. */
function responsesParse(ctx: MethodContext) {
  return runPromiseCall(ctx, str(rec(ctx.args[0])['model']), recordResponse);
}

/** `responses.stream(body, options)` — returns the SDK's own `ResponseStream`, untouched. A `response_id` replay passes straight through. */
function responsesStream(ctx: MethodContext) {
  const body = rec(ctx.args[0]);

  if (body['response_id'] !== undefined) {
    return ctx.original(...ctx.args);
  }

  return runEventStreamCall(ctx, str(body['model']), new ResponsesStreamObserver(), 'event');
}

// ---------------------------------------------------------------- embeddings

/** `embeddings.create(body, options)` — input tokens only. */
function embeddingsCreate(ctx: MethodContext) {
  return runPromiseCall(ctx, str(rec(ctx.args[0])['model']), (call, value) => {
    const response = rec(value);

    call.record({ status: AiSpendStatus.SUCCESS, model: str(response['model']), usage: fromOpenAIEmbeddingsUsage(rec(response['usage'])) });
  });
}

// ---------------------------------------------------------------- wrap

const AZURE_OPENAI_HOST_SUFFIXES = ['.openai.azure.com', '.cognitiveservices.azure.com', '.services.ai.azure.com'];

/** OpenAI-compatible hosts (the domain, matched with its subdomains) → provider id. */
const COMPATIBLE_HOSTS: ReadonlyArray<readonly [string, string]> = [
  ['openai.com', AiSpendProvider.OPENAI],
  ['groq.com', 'groq'],
  ['openrouter.ai', 'openrouter'],
  ['deepseek.com', 'deepseek'],
  ['googleapis.com', AiSpendProvider.GOOGLE],
  ['x.ai', 'xai'],
  ['together.xyz', 'together'],
  ['together.ai', 'together'],
  ['fireworks.ai', 'fireworks'],
  ['mistral.ai', 'mistral'],
];

function onDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * How an OpenAI-SDK client's provider was detected: `fromHost` is true when nothing recognised
 * the `baseURL` host and the host name itself became the provider.
 */
function detectOpenAIProvider(client: unknown) {
  const host = baseUrlHost(client);

  if (AZURE_OPENAI_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { provider: AiSpendProvider.AZURE_OPENAI, fromHost: false };

  const apiVersion = typeof client === 'object' && client !== null ? Reflect.get(client, 'apiVersion') : undefined;

  if (typeof apiVersion === 'string' && apiVersion.length > 0) return { provider: AiSpendProvider.AZURE_OPENAI, fromHost: false };
  if (!host) return { provider: AiSpendProvider.OPENAI, fromHost: false };

  const known = COMPATIBLE_HOSTS.find(([domain]) => onDomain(host, domain));

  return known ? { provider: known[1], fromHost: false } : { provider: clipText(host, AI_SPEND_LIMITS.PROVIDER_MAX_LENGTH), fromHost: true };
}

/**
 * The AI Spend provider of an OpenAI-SDK client, from its `baseURL`: `azure_openai` for Azure
 * OpenAI / AI Foundry endpoints and `AzureOpenAI` clients; `openai` for `api.openai.com` or no
 * `baseURL`; a well-known OpenAI-compatible host's provider id; else the lower-cased host name.
 */
export function openAIProviderOf(client: unknown) {
  return detectOpenAIProvider(client).provider;
}

/** The one-time warning for a client recorded under its own host name (no catalog price exists for it). */
export function unknownHostWarning(provider: string) {
  return (
    `AI Spend: this OpenAI client's baseURL host "${provider}" is not a provider AI Spend knows, so its calls are recorded as provider "${provider}" — ` +
    `which has no catalog price: they show as unpriced ($0) until you add a price for "${provider}" (AI Spend settings → Unpriced models → Add price). ` +
    `If the host is a proxy or gateway in front of real OpenAI (LiteLLM, Helicone, Portkey, a corporate gateway), pass the real provider instead: ` +
    `wrapOpenAI(client, aiSpend, defaults, { provider: 'openai' })`
  );
}

const OPENAI_ROOT: ProxyNode = {
  children: {
    chat: { children: { completions: { methods: { create: chatCreate, parse: chatParse } } } },
    responses: { methods: { create: unlessBackground(responsesCreate), parse: unlessBackground(responsesParse), stream: unlessBackground(responsesStream) } },
    embeddings: { methods: { create: embeddingsCreate } },
  },
};

const OPENAI_CONFIG: WrapConfig = {
  adapter: AiSpendAdapter.OPENAI,
  root: OPENAI_ROOT,
  providerOf: openAIProviderOf,
};

/** The detected provider, warning once per host (through the AI Spend client) when it is only the host name. */
function providerWithHostWarning(aiSpend: AiSpendClient) {
  return (client: object) => {
    const { provider, fromHost } = detectOpenAIProvider(client);

    if (fromHost) {
      safe(() => {
        if (aiSpend.enabled !== false) internalOf(aiSpend)?.warnOnce(`openai_provider_from_host|${provider}`, unknownHostWarning(provider));
      });
    }

    return provider;
  };
}

/** Options of `wrapOpenAI`. */
export interface WrapOpenAIOptions {
  /**
   * Record every call under this provider instead of the one detected from the client's
   * `baseURL` — e.g. `'openai'` for a LiteLLM / Helicone / corporate proxy in front of real
   * OpenAI, so its calls are priced and reconciled as OpenAI. Applies to `withOptions()` copies too.
   */
  provider?: string;
}

/**
 * Wrap an OpenAI (or `AzureOpenAI`) client so chat completions, Responses and embeddings
 * calls are recorded. Returns a proxy with the client's exact type and behaviour (plus
 * `withAttribution()`); use it everywhere you used the client. Wrap ONCE.
 *
 * Attribution per call, highest first: the `aiSpend` request option (`aiSpendOptions()` in
 * TypeScript) → `withAttribution()` → the ambient `withContext()` → `defaults` → the AI Spend
 * client's `defaultCustomer` / `defaultFeature`.
 *
 * ```ts
 * const openai = wrapOpenAI(new OpenAI(), aiSpend, { feature: 'search' });
 * await openai.embeddings.create({ model: 'text-embedding-3-small', input }, aiSpendOptions({ customer: account.id }));
 * ```
 */
export function wrapOpenAI<T extends OpenAIClientLike>(openai: T, aiSpend: AiSpendClient, defaults?: AiSpendAttribution, options?: WrapOpenAIOptions) {
  const provider = typeof options?.provider === 'string' ? options.provider.trim().toLowerCase() : '';

  return wrapClient(openai, aiSpend, defaults, { ...OPENAI_CONFIG, providerOf: provider ? () => provider : providerWithHostWarning(aiSpend) });
}
