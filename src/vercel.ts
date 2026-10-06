import { ambientAttribution, current, isValidFeature, mergeAttribution, pickAttribution } from './attribution';
import type { AiSpendClient } from './client';
import { internalOf, recordVia } from './internal';
import { anthropicServiceTier, bedrockEndpointTier, fromVercelUsage, vercelOpenAIToolRequests, withEndpointTier, withToolRequests } from './normalize';
import type { VercelProviderMetadataLike, VercelUsageLike } from './normalize';
import { isRecord, rec, safe, str } from './util';
import { AiSpendAdapter, AiSpendProvider, AiSpendStatus } from './wire';
import type { AiSpendAttribution, AiSpendCostInput, AiSpendStatus as AiSpendStatusValue, CanonicalUsage } from './wire';

/**
 * Vercel AI SDK (v7) adapter: a telemetry integration for `registerTelemetry()` that emits
 * ONE usage event per model call (step) — `generateText` / `streamText` steps, the single
 * `generateObject` / `streamObject` call, and every `embed` / `embedMany` model call.
 *
 * Per-call telemetry REPLACES the registered integrations (AI SDK v7 does not merge them): a
 * call that passes `telemetry: { integrations: [...] }` must include the AI Spend integration
 * in that array — `withAiSpendIntegration(integration, [...])` — or it is not recorded, and
 * `telemetry: { isEnabled: false }` turns AI Spend off for that call.
 *
 * Vercel AI Gateway calls (string model ids such as `'anthropic/claude-sonnet-4.5'`, the AI
 * SDK's default provider) are recorded under provider `vercel_gateway` with the gateway's model
 * id, and carry the cost the gateway reported for that call (`providerMetadata.gateway.cost`)
 * as the event's explicit USD cost: Vercel bills them, so they are never reconciled against a
 * direct Anthropic / OpenAI bill. Embedding model calls report no metadata of their own, so a
 * gateway `embed` / `embedMany` is recorded when the operation ends, with the cost the gateway
 * reported for the operation; an `embedMany` split over several model calls carries no cost
 * (the AI SDK keeps only one chunk's gateway metadata), and stays unpriced unless the workspace
 * has a `vercel_gateway` price for that model.
 *
 * Typed structurally (no import of `ai`), so the package has no hard dependency on it; a
 * spec asserts assignability to the real `Telemetry` type. Hooks never throw.
 */

/** What `resolveAttribution` receives, once per operation (at `onStart`). */
export interface AiSpendVercelCallInfo {
  callId: string;
  /** `telemetry.functionId` of the call. */
  functionId: string | undefined;
  /** The call's `runtimeContext` — only keys opted in via `telemetry.includeRuntimeContext` are present. */
  runtimeContext: unknown;
  /** Extra telemetry metadata, when the AI SDK version provides it. */
  metadata: unknown;
  /** AI SDK provider id, e.g. `anthropic.messages`. */
  provider: string | undefined;
  /** Requested model id. */
  modelId: string | undefined;
  /** `ai.generateText`, `ai.streamText`, `ai.generateObject`, `ai.embed`, … */
  operationId: string | undefined;
}

/** What the `eventId` option receives, once per event the adapter emits. */
export interface AiSpendVercelEventIdInfo {
  /** The AI SDK's `callId` of the operation. */
  callId: string;
  /** 0-based index of the event within the operation (step 0, step 1, …). */
  sequence: number;
}

export interface AiSpendTelemetryOptions {
  /** Per-call attribution (wins over `runtimeContext[runtimeContextKey]`, which wins over ambient context). */
  resolveAttribution?: (info: AiSpendVercelCallInfo) => AiSpendAttribution | undefined | null;
  /** `runtimeContext` key holding an `AiSpendAttribution`. Default `aiSpend`. Remember `telemetry.includeRuntimeContext: { aiSpend: true }`. */
  runtimeContextKey?: string;
  /** Use a lowercased `functionId` as the feature when nothing else set one (only if it is a valid feature path). Default true. */
  featureFromFunctionId?: boolean;
  /**
   * Idempotency key for each event the adapter emits — e.g. derived from the AI SDK callId, so a
   * replay of the same operation (a backfill from your own logs) dedupes against what was
   * reported live. `sequence` = 0-based index of the event within the operation. Called only
   * when the AI SDK supplied a callId (never for the synthesized `anonymous-…` id). Return
   * undefined for a fresh UUIDv7; same rules as `record({ eventId })`. A throwing resolver
   * contributes nothing. An event with an id carries its end time as `occurredAt`.
   */
  eventId?: (info: AiSpendVercelEventIdInfo) => string | undefined;
}

// ---------------------------------------------------------------- structural event shapes

interface TelemetryBaseEvent {
  readonly callId?: string;
  readonly functionId?: string;
  readonly provider?: string;
  readonly modelId?: string;
}

export interface VercelStartEventLike extends TelemetryBaseEvent {
  readonly operationId?: string;
  readonly runtimeContext?: unknown;
}

export interface VercelModelCallEndEventLike extends TelemetryBaseEvent {
  readonly usage?: VercelUsageLike;
  readonly providerMetadata?: VercelProviderMetadataLike;
  readonly performance?: { readonly responseTimeMs?: number };
  /** The step's content parts (provider-executed tool calls among them). */
  readonly content?: unknown;
}

export interface VercelObjectStepEndEventLike extends TelemetryBaseEvent {
  readonly usage?: VercelUsageLike;
  readonly providerMetadata?: VercelProviderMetadataLike;
  readonly response?: { readonly modelId?: string };
}

export interface VercelEmbedStartEventLike extends TelemetryBaseEvent {
  readonly embedCallId?: string;
}

export interface VercelEmbedEndEventLike extends TelemetryBaseEvent {
  readonly embedCallId?: string;
  readonly usage?: { readonly tokens?: number };
}

/** An operation's `onEnd` event; for `embed` / `embedMany` it carries the provider metadata (the gateway's cost). */
export interface VercelEndEventLike extends TelemetryBaseEvent {
  readonly providerMetadata?: VercelProviderMetadataLike;
}

export interface VercelExecuteModelCallOptions<T> {
  callId: string;
  execute: () => PromiseLike<T>;
}

/**
 * The object to pass to `registerTelemetry()`. A call with its own `telemetry.integrations`
 * must list it there too (`withAiSpendIntegration`) — per-call integrations replace the
 * registered ones.
 */
export interface AiSpendTelemetryIntegration {
  onStart: (event: VercelStartEventLike) => void;
  onLanguageModelCallStart: (event: TelemetryBaseEvent) => void;
  onLanguageModelCallEnd: (event: VercelModelCallEndEventLike) => void;
  onObjectStepStart: (event: TelemetryBaseEvent) => void;
  onObjectStepEnd: (event: VercelObjectStepEndEventLike) => void;
  onToolExecutionStart: (event: TelemetryBaseEvent) => void;
  onToolExecutionEnd: (event: TelemetryBaseEvent) => void;
  onEmbedStart: (event: VercelEmbedStartEventLike) => void;
  onEmbedEnd: (event: VercelEmbedEndEventLike) => void;
  onEnd: (event: VercelEndEventLike) => void;
  onAbort: (event: TelemetryBaseEvent) => void;
  onError: (event: unknown) => void;
  /** Present only for `strict` clients: fails the model call when attribution is incomplete. */
  executeLanguageModelCall?: <T>(options: VercelExecuteModelCallOptions<T>) => PromiseLike<T>;
  /**
   * Record every model call (and embedding call) that STARTED and has not ended as an
   * `aborted` event (no token counts — the provider never reported them), and forget it.
   * Call it at shutdown, BEFORE `aiSpend.shutdown()`, so calls cut off by the process exiting
   * are still counted. Returns how many calls it recorded. Never throws.
   */
  abortOpenCalls: (reason?: string) => number;
}

interface OpenModelCall {
  startedAt: number;
  provider: string | undefined;
  modelId: string | undefined;
}

interface CallState {
  /** The AI SDK's callId — undefined when the adapter synthesized an `anonymous-…` one. */
  callId: string | undefined;
  startedAt: number;
  /** Touched by every hook of the operation — the stale sweep keys off inactivity, not age. */
  lastSeenAt: number;
  provider: string | undefined;
  modelId: string | undefined;
  functionId: string | undefined;
  attribution: AiSpendAttribution;
  emitted: number;
  /** A model call that started and has not reported its end yet. */
  openModelCall: OpenModelCall | undefined;
  embedStarts: Map<string, number>;
  /** Gateway embedding calls that ended, held until the operation's `onEnd` carries the gateway's cost. */
  gatewayEmbeds: GatewayEmbed[];
}

interface GatewayEmbed {
  usage: CanonicalUsage;
  model: string | undefined;
  provider: string | undefined;
  latencyMs: number;
}

const DEFAULT_RUNTIME_CONTEXT_KEY = 'aiSpend';
/** An operation with no hook activity for this long (a stream its consumer stopped reading) is forgotten. */
const STALE_CALL_MS = 30 * 60_000;
const SWEEP_EVERY_MS = 60_000;

/**
 * AI SDK provider id (`anthropic.messages`, `openai.responses`, `amazon-bedrock`, `gateway`, …)
 * → AI Spend provider. `gateway` (the Vercel AI Gateway) → `vercel_gateway`.
 */
export function providerFromVercel(providerId: string | undefined) {
  const id = (providerId ?? '').toLowerCase();

  if (id === 'gateway' || id.startsWith('gateway.')) return AiSpendProvider.VERCEL_GATEWAY;
  if (id.startsWith('anthropic')) return AiSpendProvider.ANTHROPIC;
  if (id.startsWith('azure')) return AiSpendProvider.AZURE_OPENAI;
  if (id.startsWith('openai')) return AiSpendProvider.OPENAI;
  if (id.startsWith('amazon-bedrock') || id.startsWith('bedrock')) return AiSpendProvider.BEDROCK;
  if (id.startsWith('google') || id.startsWith('vertex')) return AiSpendProvider.GOOGLE;

  return id.split('.')[0] || 'unknown';
}

/**
 * Service tier from provider metadata: Anthropic `usage.service_tier` (`fast` when
 * `usage.speed === 'fast'`), OpenAI `serviceTier`. (The adapter adds the Bedrock endpoint tier
 * on top — see {@link serviceTierOfStep}.)
 */
export function serviceTierFromMetadata(providerMetadata: VercelProviderMetadataLike) {
  if (!isRecord(providerMetadata)) return undefined;

  const anthropic = providerMetadata['anthropic'];
  const anthropicTier = isRecord(anthropic) ? anthropicServiceTier(anthropic['usage']) : undefined;

  if (anthropicTier) return anthropicTier;

  for (const value of Object.values(providerMetadata)) {
    if (isRecord(value) && str(value['serviceTier'])) {
      return str(value['serviceTier']);
    }
  }

  return undefined;
}

/**
 * The service tier of one finished step: {@link serviceTierFromMetadata}, with Amazon Bedrock's
 * endpoint tier (`regional` for a geography or in-region model id — read from the REQUESTED
 * model id) over it; `fast` still wins. Vertex AI calls through the AI SDK carry no region in
 * telemetry, so they keep the metadata tier.
 */
function serviceTierOfStep(providerMetadata: VercelProviderMetadataLike, provider: string, requestedModelId: string | undefined) {
  const endpointTier = provider === AiSpendProvider.BEDROCK ? bedrockEndpointTier(requestedModelId) : undefined;

  return withEndpointTier(serviceTierFromMetadata(providerMetadata), endpointTier);
}

/** The resolver's value, or undefined when it throws (a throwing resolver contributes nothing). */
function resolveSafely<T>(resolve: () => T) {
  try {
    return resolve();
  } catch {
    return undefined;
  }
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** A non-negative decimal string from a gateway cost value (decimal string or number), else undefined. */
function decimalOf(value: unknown) {
  if (typeof value === 'string' && DECIMAL.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;

  return undefined;
}

function isZero(amount: string | number) {
  return Number(amount) === 0;
}

/**
 * The cost the Vercel AI Gateway reported for ONE model call (`providerMetadata.gateway.cost`,
 * USD). With BYOK the gateway charges nothing (`cost` 0) while the upstream provider bills its
 * market price — then `marketCost` is the cost. Undefined when the gateway reported none.
 */
export function gatewayCostFromMetadata(providerMetadata: VercelProviderMetadataLike) {
  const gateway = rec(rec(providerMetadata)['gateway']);
  const cost = decimalOf(gateway['cost']);
  const market = decimalOf(gateway['marketCost']);
  const amount = cost !== undefined && isZero(cost) && market !== undefined && !isZero(market) ? market : cost;

  if (amount === undefined) return undefined;

  const result: AiSpendCostInput = { amount, currency: 'USD' };

  return result;
}

/**
 * The integrations array for ONE call's `telemetry.integrations`: AI Spend's integration plus
 * yours. Per-call integrations replace the ones registered with `registerTelemetry()`, so
 * without AI Spend in the array that call is not recorded.
 *
 * ```ts
 * const aiSpendIntegration = aiSpendTelemetry(aiSpend);
 * registerTelemetry(aiSpendIntegration);
 * await generateText({ model, prompt, telemetry: { integrations: withAiSpendIntegration(aiSpendIntegration, [langfuse]) } });
 * ```
 */
export function withAiSpendIntegration<T>(integration: AiSpendTelemetryIntegration, others?: T | readonly T[] | null) {
  const rest: T[] = others == null ? [] : Array.isArray(others) ? [...(others as readonly T[])] : [others as T];
  const out: Array<AiSpendTelemetryIntegration | T> = [integration];

  for (const other of rest) {
    if ((other as unknown) !== integration) out.push(other);
  }

  return out;
}

/** `{ callId, error }` envelope (or a raw thrown value) → callId. */
function callIdOfError(event: unknown) {
  return isRecord(event) ? str(event['callId']) : undefined;
}

/** Usage an error carries (e.g. `NoObjectGeneratedError.usage`), if any. */
function usageOfError(event: unknown) {
  const error = isRecord(event) && 'error' in event ? event['error'] : event;
  const usage = isRecord(error) ? error['usage'] : undefined;

  return isRecord(usage) ? (usage as VercelUsageLike) : undefined;
}

export function aiSpendTelemetry(client: AiSpendClient, options: AiSpendTelemetryOptions = {}) {
  const internal = internalOf(client);
  const runtimeContextKey = options.runtimeContextKey ?? DEFAULT_RUNTIME_CONTEXT_KEY;
  const featureFromFunctionId = options.featureFromFunctionId !== false;
  const calls = new Map<string, CallState>();
  let lastSweep = Date.now();

  const record = (
    usage: CanonicalUsage,
    state: CallState,
    details: { model: string | undefined; provider: string | undefined; status: AiSpendStatusValue; latencyMs?: number; serviceTier?: string; cost?: AiSpendCostInput },
  ) => {
    const model = details.model ?? state.modelId ?? 'unknown';
    const resolveEventId = options.eventId;
    const callId = state.callId;
    const eventId = callId && resolveEventId ? str(resolveSafely(() => resolveEventId({ callId, sequence: state.emitted }))) : undefined;
    const usageRecord = {
      ...state.attribution,
      provider: providerFromVercel(details.provider ?? state.provider),
      model,
      usage,
      status: details.status,
      ...(details.latencyMs !== undefined ? { latencyMs: details.latencyMs } : {}),
      ...(details.serviceTier ? { serviceTier: details.serviceTier } : {}),
      ...(details.cost ? { cost: details.cost } : {}),
      // An id goes with an explicit end time (the call's own time), as `record()` asks of every replayable event.
      ...(eventId ? { eventId, occurredAt: new Date() } : {}),
    };
    const warnKey = `vercel|${state.functionId ?? model}`;

    state.emitted++;
    recordVia(client, internal, AiSpendAdapter.VERCEL, usageRecord, warnKey);
  };

  const attributionFor = (info: AiSpendVercelCallInfo) => {
    let resolved: AiSpendAttribution = {};

    if (options.resolveAttribution) {
      try {
        resolved = pickAttribution(options.resolveAttribution(info));
      } catch {
        // a throwing resolver just contributes nothing
      }
    }

    const fromRuntime = isRecord(info.runtimeContext) ? pickAttribution(info.runtimeContext[runtimeContextKey]) : {};
    const merged = mergeAttribution(mergeAttribution(current(), fromRuntime), resolved);

    if (!merged.feature && featureFromFunctionId && info.functionId) {
      const feature = info.functionId.toLowerCase();

      if (isValidFeature(feature)) {
        merged.feature = feature;
      }
    }

    return merged;
  };

  /**
   * Record the gateway embedding calls held for `state`. Only a SINGLE model call gets the cost:
   * `onEnd`'s provider metadata is the gateway's report for that one call, while for an
   * `embedMany` split over several calls the AI SDK keeps only one chunk's metadata (not a total).
   */
  const releaseGatewayEmbeds = (state: CallState, providerMetadata: VercelProviderMetadataLike) => {
    const held = state.gatewayEmbeds;

    if (held.length === 0) return;

    state.gatewayEmbeds = [];

    const cost = held.length === 1 ? gatewayCostFromMetadata(providerMetadata) : undefined;

    if (held.length > 1) {
      safe(() => internal?.debug('AI Spend: a gateway embedMany ran several model calls — recorded without the gateway cost (the AI SDK reports one chunk only)', { calls: held.length }));
    }

    for (const embed of held) {
      safe(() =>
        record(embed.usage, state, {
          model: embed.model,
          provider: embed.provider,
          status: AiSpendStatus.SUCCESS,
          latencyMs: embed.latencyMs,
          ...(cost ? { cost } : {}),
        }),
      );
    }
  };

  const sweep = (now: number) => {
    if (now - lastSweep < SWEEP_EVERY_MS) return;

    lastSweep = now;

    for (const [callId, state] of calls) {
      if (now - state.lastSeenAt > STALE_CALL_MS) {
        calls.delete(callId);
        releaseGatewayEmbeds(state, undefined);
      }
    }
  };

  const open = (event: VercelStartEventLike) => {
    const now = Date.now();

    sweep(now);

    const realCallId = str(event.callId);
    const callId = realCallId ?? `anonymous-${now}`;
    const functionId = str(event.functionId);
    const info: AiSpendVercelCallInfo = {
      callId,
      functionId,
      runtimeContext: event.runtimeContext,
      metadata: (event as { metadata?: unknown }).metadata,
      provider: str(event.provider),
      modelId: str(event.modelId),
      operationId: str(event.operationId),
    };
    const state: CallState = {
      callId: realCallId,
      startedAt: now,
      lastSeenAt: now,
      provider: info.provider,
      modelId: info.modelId,
      functionId,
      attribution: attributionFor(info),
      emitted: 0,
      openModelCall: undefined,
      embedStarts: new Map(),
      gatewayEmbeds: [],
    };

    calls.set(callId, state);

    return state;
  };

  /** The known state of a call, marked active — keeps a long-running operation (slow tools, long agent runs) from being swept. */
  const touch = (event: TelemetryBaseEvent) => {
    const callId = str(event.callId);
    const existing = callId ? calls.get(callId) : undefined;

    if (existing) existing.lastSeenAt = Date.now();

    return existing;
  };

  /** State for a call — opened lazily when `onStart` was missed (integration registered mid-call). */
  const stateOf = (event: TelemetryBaseEvent) => touch(event) ?? open(event);

  const startModelCall = (event: TelemetryBaseEvent) => {
    const state = stateOf(event);

    state.openModelCall = { startedAt: Date.now(), provider: str(event.provider), modelId: str(event.modelId) };
  };

  const close = (event: unknown, status: AiSpendStatusValue) => {
    const callId = callIdOfError(event);

    if (!callId) return;

    const state = calls.get(callId);

    calls.delete(callId);

    if (!state) return;

    // Embedding calls that finished were billed whatever the operation's outcome; the cost is only known on success.
    releaseGatewayEmbeds(state, status === AiSpendStatus.SUCCESS ? (rec(event)['providerMetadata'] as VercelProviderMetadataLike) : undefined);

    if (status === AiSpendStatus.SUCCESS) return;

    // Record the failed step: a model call that started and never reported its end — or, when
    // the operation reported nothing at all, the operation itself — so error rates and "cost of
    // errors" see it. Steps that already reported carry their own tokens (never re-counted).
    const failed = state.openModelCall;

    if (!failed && state.emitted > 0) return;

    const usage = status === AiSpendStatus.ERROR && failed ? usageOfError(event) : undefined;

    record(fromVercelUsage(usage), state, {
      model: failed?.modelId ?? state.modelId,
      provider: failed?.provider ?? state.provider,
      status,
      latencyMs: Date.now() - (failed?.startedAt ?? state.startedAt),
    });
  };

  /** The usage + cost of one finished step: OpenAI built-in tool calls added; a gateway call carries the gateway's cost. */
  const stepDetails = (event: VercelModelCallEndEventLike | VercelObjectStepEndEventLike, state: CallState) => {
    const providerId = str(event.provider) ?? state.provider;
    const provider = providerFromVercel(providerId);
    const base = fromVercelUsage(event.usage, event.providerMetadata);
    const content = (event as VercelModelCallEndEventLike).content;
    const usage = provider === AiSpendProvider.OPENAI || provider === AiSpendProvider.AZURE_OPENAI ? withToolRequests(base, vercelOpenAIToolRequests(content)) : base;
    const cost = provider === AiSpendProvider.VERCEL_GATEWAY ? gatewayCostFromMetadata(event.providerMetadata) : undefined;
    const serviceTier = serviceTierOfStep(event.providerMetadata, provider, str(event.modelId) ?? state.openModelCall?.modelId ?? state.modelId);

    return { usage, cost, serviceTier };
  };

  /** Every model / embedding call that started and never ended → one `aborted` event each. */
  const abortOpenCalls = (reason?: string) => {
    let aborted = 0;
    const now = Date.now();

    for (const [callId, state] of calls) {
      const open = state.openModelCall;

      releaseGatewayEmbeds(state, undefined);

      if (open) {
        state.openModelCall = undefined;
        aborted++;
        safe(() =>
          record(fromVercelUsage(undefined), state, {
            model: open.modelId ?? state.modelId,
            provider: open.provider ?? state.provider,
            status: AiSpendStatus.ABORTED,
            latencyMs: now - open.startedAt,
          }),
        );
      }

      for (const startedAt of state.embedStarts.values()) {
        aborted++;
        safe(() => record(fromVercelUsage(undefined), state, { model: state.modelId, provider: state.provider, status: AiSpendStatus.ABORTED, latencyMs: now - startedAt }));
      }

      state.embedStarts.clear();
      calls.delete(callId);
    }

    if (aborted > 0) {
      safe(() => internal?.debug(`AI Spend: recorded ${aborted} still-open AI SDK model calls as aborted`, { reason: reason ?? 'abortOpenCalls()' }));
    }

    return aborted;
  };

  const integration: AiSpendTelemetryIntegration = {
    onStart: (event) => safe(() => void open(event)),

    onLanguageModelCallStart: (event) => safe(() => startModelCall(event)),

    onLanguageModelCallEnd: (event) =>
      safe(() => {
        const state = stateOf(event);
        const latency = event.performance?.responseTimeMs;
        const { usage, cost, serviceTier } = stepDetails(event, state);

        state.openModelCall = undefined;

        record(usage, state, {
          model: str(event.modelId),
          provider: str(event.provider),
          status: AiSpendStatus.SUCCESS,
          latencyMs: typeof latency === 'number' ? latency : undefined,
          serviceTier,
          cost,
        });
      }),

    onObjectStepStart: (event) => safe(() => startModelCall(event)),

    onObjectStepEnd: (event) =>
      safe(() => {
        const state = stateOf(event);
        const startedAt = state.openModelCall?.startedAt ?? state.startedAt;
        const { usage, cost, serviceTier } = stepDetails(event, state);

        state.openModelCall = undefined;
        record(usage, state, {
          model: str(event.response?.modelId) ?? str(event.modelId),
          provider: str(event.provider),
          status: AiSpendStatus.SUCCESS,
          latencyMs: Date.now() - startedAt,
          serviceTier,
          cost,
        });
      }),

    onEmbedStart: (event) =>
      safe(() => {
        const embedCallId = str(event.embedCallId);

        if (embedCallId) stateOf(event).embedStarts.set(embedCallId, Date.now());
      }),

    onEmbedEnd: (event) =>
      safe(() => {
        const state = stateOf(event);
        const embedCallId = str(event.embedCallId);
        const startedAt = (embedCallId ? state.embedStarts.get(embedCallId) : undefined) ?? state.startedAt;

        if (embedCallId) state.embedStarts.delete(embedCallId);

        const usage = fromVercelUsage({ tokens: event.usage?.tokens });
        const details = { model: str(event.modelId), provider: str(event.provider), latencyMs: Date.now() - startedAt };

        // The gateway's cost arrives only with the operation's onEnd: hold the call until then.
        if (providerFromVercel(details.provider ?? state.provider) === AiSpendProvider.VERCEL_GATEWAY) {
          state.gatewayEmbeds.push({ usage, ...details });

          return;
        }

        record(usage, state, { ...details, status: AiSpendStatus.SUCCESS });
      }),

    onToolExecutionStart: (event) => safe(() => void touch(event)),
    onToolExecutionEnd: (event) => safe(() => void touch(event)),

    onEnd: (event) => safe(() => close(event, AiSpendStatus.SUCCESS)),
    onAbort: (event) => safe(() => close(event, AiSpendStatus.ABORTED)),
    onError: (event) => safe(() => close(event, AiSpendStatus.ERROR)),

    abortOpenCalls: (reason) => {
      try {
        return abortOpenCalls(reason);
      } catch {
        return 0;
      }
    },
  };

  if (internal?.strict) {
    integration.executeLanguageModelCall = (callOptions) => {
      const state = calls.get(callOptions.callId);

      // Throws AiSpendAttributionError → the model call (and the test) fails before any spend.
      internal.assertAttribution(state?.attribution ?? {}, ambientAttribution());

      return callOptions.execute();
    };
  }

  return integration;
}
