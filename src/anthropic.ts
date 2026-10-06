import type { AiSpendClient } from './client';
import { anthropicServiceTier, bedrockEndpointTier, fromAnthropicUsage, REGIONAL_SERVICE_TIER, withEndpointTier } from './normalize';
import { rec, str } from './util';
import { AiSpendAdapter, AiSpendProvider, AiSpendStatus } from './wire';
import type { AiSpendAttribution, AiSpendStatus as AiSpendStatusValue } from './wire';
import { baseUrlHost, runEventStreamCall, runPromiseCall, tapIterableStream, wrapClient } from './wrap';
import type { AdapterCall, MethodContext, ProxyNode, RecordingStreamObserver, WrapConfig } from './wrap';

export { aiSpendOptions } from './wrap';
export type { AiSpendWrapped } from './wrap';

/**
 * Anthropic SDK adapter (`@anthropic-ai/sdk`): wrap the client once, and every Messages call
 * records ONE usage event when it finishes.
 *
 * Instrumented (on `messages` and `beta.messages`):
 * - `create()` — non-streaming (usage of the returned message) and `stream: true` (usage
 *   accumulated from `message_start` + the cumulative `message_delta`, recorded when the
 *   caller finishes reading the stream);
 * - `stream()` — the `MessageStream` helper (recorded on its `end` event, whether it
 *   succeeded, failed or was aborted — nothing is consumed on the caller's behalf);
 * - `parse()` — structured outputs (usage of the returned message).
 *
 * Not instrumented (record manually if you use them): `messages.batches` (batch results arrive
 * later, priced as batch), `beta.messages.toolRunner()`, and anything you call on the raw
 * HTTP methods. Token counting (`countTokens`) is free and passes straight through.
 *
 * Service tier: `usage.service_tier` (`standard` / `priority` / `batch`), or `fast` when the
 * call ran in fast mode (`usage.speed === 'fast'`, priced at the fast-mode rates). On Bedrock
 * and Vertex the endpoint has its own price: `regional` for a Bedrock geography (`us.` / `eu.`
 * / `apac.` / `jp.` / `au.`) or in-region model id, and for a Vertex client whose region is not
 * `global` — about 10% above the global endpoint. `fast` still wins.
 *
 * The client is typed structurally — the package has no dependency on `@anthropic-ai/sdk`.
 * Works with `Anthropic`, and the same Messages API on `AnthropicBedrock` (provider
 * `bedrock`) and `AnthropicVertex` (provider `google`).
 */

/** A Vertex AI multi-region endpoint host (`aiplatform.us.rep.googleapis.com`). */
const VERTEX_MULTI_REGION_HOST = /^aiplatform\.[a-z0-9-]+\.rep\.googleapis\.com$/;

/** The part of an Anthropic client the wrapper needs (`Anthropic`, `AnthropicBedrock`, `AnthropicVertex`). */
export interface AnthropicClientLike {
  messages: { create: (...args: never[]) => unknown };
}

/**
 * Accumulates the usage of one streamed message. `message_start` carries the input side
 * (incl. the cache 5m/1h split and the service tier); every `message_delta` carries
 * CUMULATIVE counts (output, and — on newer API versions — input / cache / server-tool use),
 * so non-null delta fields overwrite.
 */
class AnthropicStreamObserver implements RecordingStreamObserver {
  public complete = false;
  private model: string | undefined;
  private usage: Record<string, unknown> = {};

  public constructor(private readonly endpointTier: string | undefined) {}

  public event(event: unknown) {
    const e = rec(event);

    switch (e['type']) {
      case 'message_start': {
        const message = rec(e['message']);

        this.model = str(message['model']) ?? this.model;
        this.usage = { ...rec(message['usage']) };
        break;
      }

      case 'message_delta': {
        for (const [key, value] of Object.entries(rec(e['usage']))) {
          if (value !== null && value !== undefined) {
            this.usage[key] = value;
          }
        }

        break;
      }

      case 'message_stop':
        this.complete = true;
        break;
      default:
        break;
    }

    return false;
  }

  public finish(call: AdapterCall, status: AiSpendStatusValue) {
    call.record({
      status,
      model: this.model,
      usage: fromAnthropicUsage(this.usage),
      serviceTier: withEndpointTier(anthropicServiceTier(this.usage), this.endpointTier),
    });
  }
}

function recordMessage(call: AdapterCall, value: unknown, endpointTier: string | undefined) {
  const message = rec(value);
  const usage = rec(message['usage']);

  call.record({
    status: AiSpendStatus.SUCCESS,
    model: str(message['model']),
    usage: fromAnthropicUsage(usage),
    serviceTier: withEndpointTier(anthropicServiceTier(usage), endpointTier),
  });
}

/**
 * `regional` for a Vertex client whose region is not `global` (a regional or multi-region
 * endpoint): its `region` property (`AnthropicVertex`), else its base URL host. Undefined for
 * the global endpoint and when neither says.
 */
function vertexEndpointTier(client: unknown) {
  try {
    const region = typeof client === 'object' && client !== null ? Reflect.get(client, 'region') : undefined;

    if (typeof region === 'string' && region.trim()) {
      return region.trim().toLowerCase() === 'global' ? undefined : REGIONAL_SERVICE_TIER;
    }
  } catch {
    // an unreadable region falls back to the host
  }

  const host = baseUrlHost(client);

  return host.endsWith('-aiplatform.googleapis.com') || VERTEX_MULTI_REGION_HOST.test(host) ? REGIONAL_SERVICE_TIER : undefined;
}

/** Endpoint tier of one call: Bedrock reads the requested model id, Vertex the client's region. */
function endpointTierOf(ctx: MethodContext, requestedModel: string | undefined) {
  if (ctx.scope.provider === AiSpendProvider.BEDROCK) return bedrockEndpointTier(requestedModel);
  if (ctx.scope.provider === AiSpendProvider.GOOGLE) return vertexEndpointTier(ctx.scope.target);

  return undefined;
}

/** `messages.create(body, options)` — a message, or (`stream: true`) a raw event stream. */
function create(ctx: MethodContext) {
  const body = rec(ctx.args[0]);
  const streaming = body['stream'] === true;
  const model = str(body['model']);
  const endpointTier = endpointTierOf(ctx, model);

  return runPromiseCall(ctx, model, (call, value) => {
    if (
      streaming &&
      tapIterableStream(value, () => new AnthropicStreamObserver(endpointTier), (observer, status) => observer.finish(call, status))
    ) {
      return;
    }

    recordMessage(call, value, endpointTier);
  });
}

/** `messages.parse(body, options)` — structured output; resolves to a message. */
function parse(ctx: MethodContext) {
  const model = str(rec(ctx.args[0])['model']);
  const endpointTier = endpointTierOf(ctx, model);

  return runPromiseCall(ctx, model, (call, value) => recordMessage(call, value, endpointTier));
}

/** `messages.stream(body, options)` — returns the SDK's own `MessageStream`, untouched. */
function stream(ctx: MethodContext) {
  const model = str(rec(ctx.args[0])['model']);

  return runEventStreamCall(ctx, model, new AnthropicStreamObserver(endpointTierOf(ctx, model)), 'streamEvent');
}

const MESSAGES: ProxyNode = { methods: { create, parse, stream } };

const ANTHROPIC_CONFIG: WrapConfig = {
  adapter: AiSpendAdapter.ANTHROPIC,
  root: { children: { messages: MESSAGES, beta: { children: { messages: MESSAGES } } } },
  providerOf: anthropicProviderOf,
};

/** `anthropic`, or `bedrock` / `google` for the Bedrock and Vertex flavours of the client (by `baseURL`). */
export function anthropicProviderOf(client: unknown) {
  const host = baseUrlHost(client);

  if (host.includes('bedrock') && host.endsWith('.amazonaws.com')) return AiSpendProvider.BEDROCK;
  if (host.endsWith('aiplatform.googleapis.com') || VERTEX_MULTI_REGION_HOST.test(host)) return AiSpendProvider.GOOGLE;

  return AiSpendProvider.ANTHROPIC;
}

/**
 * Wrap an Anthropic client so every Messages call is recorded. Returns a proxy with the
 * client's exact type and behaviour (plus `withAttribution()`); use it everywhere you used
 * the client. Wrap ONCE — wrapping a wrapped client records calls twice.
 *
 * Attribution per call, highest first: the `aiSpend` request option
 * (`create(body, { aiSpend: { customer } })` in JavaScript, `aiSpendOptions()` in TypeScript) →
 * `withAttribution()` → the ambient `withContext()` → `defaults` → the AI Spend client's
 * `defaultCustomer` / `defaultFeature`.
 *
 * ```ts
 * const anthropic = wrapAnthropic(new Anthropic(), aiSpend, { feature: 'support' });
 * await anthropic.messages.create({ model: 'claude-opus-5-5', max_tokens: 1024, messages }, aiSpendOptions({ customer: account.id }));
 * ```
 */
export function wrapAnthropic<T extends AnthropicClientLike>(anthropic: T, aiSpend: AiSpendClient, defaults?: AiSpendAttribution) {
  return wrapClient(anthropic, aiSpend, defaults, ANTHROPIC_CONFIG);
}
