import { ambientAttribution, mergeAttribution, pickAttribution } from './attribution';
import type { AiSpendClient } from './client';
import { internalOf, recordVia } from './internal';
import type { AiSpendClientInternal } from './internal';
import { isRecord, rec, safe } from './util';
import { AiSpendStatus } from './wire';
import type { AiSpendAttribution, AiSpendStatus as AiSpendStatusValue, AiSpendUsageRecord, CanonicalUsage } from './wire';

/**
 * Shared machinery of the provider-SDK wrappers (`/anthropic`, `/openai`). NOT public API.
 *
 * A wrapped client is a Proxy over the caller's own client: every property, method and type
 * is the original's, except a few instrumented methods (`messages.create`, …). An
 * instrumented call records ONE usage event when it finishes and hands back EXACTLY what the
 * SDK returned — the same resolved object, the same stream instance (tapped in place, so
 * iteration, `tee()`, `toReadableStream()`, `.on()`, `finalMessage()` and `controller` all
 * keep working). The recording path never throws into the host and never alters a request
 * or response payload (the one documented exception: OpenAI chat streams get
 * `stream_options.include_usage`, see `openai.ts`).
 */

/** Request-options key carrying per-call attribution; read and removed before the SDK sees the options. */
const AI_SPEND_OPTION = 'aiSpend';

/** A wrapped provider client: the original client's exact type, plus `withAttribution`. */
export type AiSpendWrapped<T> = T & {
  /**
   * A view of the same client whose calls carry `attribution` (merged over the view it was
   * called on). Per-call `aiSpend` options still win. Cheap: no client is copied.
   */
  withAttribution(attribution: AiSpendAttribution): AiSpendWrapped<T>;
};

/**
 * Typed per-call attribution for a wrapped client's request options:
 * `client.messages.create(body, aiSpendOptions({ customer: 'cus_1' }, { timeout: 30_000 }))`.
 * Plain JavaScript can pass `{ aiSpend: { … } }` directly; the wrapper strips it before the
 * request is sent. Returned as the type of `options`, so it fits the SDK's own options type.
 */
export function aiSpendOptions<O extends object = Record<never, never>>(attribution: AiSpendAttribution, options?: O) {
  const merged = { ...(options ?? {}), [AI_SPEND_OPTION]: attribution };

  return merged as unknown as O;
}

// ---------------------------------------------------------------- small utilities

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isObjectLike(value) && typeof (value as { then?: unknown }).then === 'function';
}

/** Hostname of a client's `baseURL` (lowercased), or '' when absent/unparseable. */
export function baseUrlHost(client: unknown) {
  try {
    const baseURL = isObjectLike(client) ? Reflect.get(client, 'baseURL') : undefined;

    return typeof baseURL === 'string' ? new URL(baseURL).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** A thrown SDK error → `aborted` for user aborts (`APIUserAbortError`, `AbortError`), else `error`. */
function statusOfError(error: unknown) {
  const name = isObjectLike(error) ? (error as { name?: unknown }).name : undefined;

  return name === 'APIUserAbortError' || name === 'AbortError' ? AiSpendStatus.ABORTED : AiSpendStatus.ERROR;
}

// ---------------------------------------------------------------- scope + call

export interface WrapConfig {
  /** `sdk.adapter` of the emitted events. */
  readonly adapter: string;
  /** Which properties are resources and which methods are instrumented. */
  readonly root: ProxyNode;
  /** AI Spend provider for a (possibly `withOptions`-derived) client. */
  readonly providerOf: (client: object) => string;
}

/** One wrapped view of a client: its config, attribution layers and proxy cache. */
export class WrapScope {
  /** target object → its proxy in this scope (keeps `wrapped.messages === wrapped.messages`). */
  public readonly cache = new WeakMap<object, object>();

  public constructor(
    public readonly config: WrapConfig,
    public readonly client: AiSpendClient,
    public readonly internal: AiSpendClientInternal | undefined,
    public readonly provider: string,
    /** Attribution passed to `wrapX(client, aiSpend, defaults)` — below ambient context. */
    public readonly defaults: AiSpendAttribution,
    /** Accumulated `withAttribution()` layers — above ambient context, below per-call. */
    public readonly scoped: AiSpendAttribution,
    /** False when the AI Spend client is disabled (and not strict): calls pass straight through. */
    public readonly active: boolean,
    /** The provider client this view wraps (a `withOptions()` copy for a derived view). */
    public readonly target: object,
  ) {}

  public derive(changes: { provider?: string; scoped?: AiSpendAttribution; target?: object }) {
    return new WrapScope(
      this.config,
      this.client,
      this.internal,
      changes.provider ?? this.provider,
      this.defaults,
      changes.scoped ?? this.scoped,
      this.active,
      changes.target ?? this.target,
    );
  }

  /** A data-quality warning through the AI Spend client, once per `key` (no-op for a foreign client). */
  public warnOnce(key: string, message: string) {
    safe(() => this.internal?.warnOnce(key, message));
  }
}

export interface CallOutcome {
  status: AiSpendStatusValue;
  /** Response model; falls back to the requested model. */
  model?: string;
  usage?: CanonicalUsage;
  serviceTier?: string;
}

/**
 * One instrumented SDK call. Attribution is resolved when the call STARTS (a stream may end
 * in another async context): per-call `aiSpend` > `withAttribution` > ambient `withContext`
 * > wrapper defaults (> the AI Spend client's own defaults, applied by `record`). Records at
 * most once.
 */
export class AdapterCall {
  public readonly attribution: AiSpendAttribution;
  private readonly startedAt = Date.now();
  /** The ambient store, read ONCE (never copied: it is only ever merged in as an override). */
  private readonly ambient = ambientAttribution();
  private recorded = false;

  public constructor(
    private readonly scope: WrapScope,
    private readonly method: string,
    /** The model the request asked for (the response model wins when present). */
    public readonly requestModel: string | undefined,
    perCall: AiSpendAttribution,
  ) {
    this.attribution = mergeAttribution(mergeAttribution(mergeAttribution(scope.defaults, this.ambient), scope.scoped), perCall);
  }

  /** Strict clients throw `AiSpendAttributionError` here — BEFORE the model call, so no spend happens. */
  public assertAttribution() {
    this.scope.internal?.assertAttribution(this.attribution, this.ambient);
  }

  public record(outcome: CallOutcome) {
    if (this.recorded) return;

    this.recorded = true;

    safe(() => {
      const model = outcome.model ?? this.requestModel ?? 'unknown';
      const usage: AiSpendUsageRecord = {
        ...this.attribution,
        provider: this.scope.provider,
        model,
        usage: outcome.usage ?? {},
        status: outcome.status,
        latencyMs: Date.now() - this.startedAt,
        ...(outcome.serviceTier ? { serviceTier: outcome.serviceTier } : {}),
      };
      const warnKey = `${this.scope.config.adapter}|${this.method}|${model}`;

      recordVia(this.scope.client, this.scope.internal, this.scope.config.adapter, usage, warnKey);
    });
  }

  /** A thrown/rejected call: its provider usage is unknown, so it is a zero-token event. */
  public recordError(error: unknown) {
    this.record({ status: statusOfError(error) });
  }
}

// ---------------------------------------------------------------- promises

/**
 * Observe an SDK promise (a Stainless `APIPromise`, or any thenable) WITHOUT changing it:
 * returns a Proxy whose `then` / `catch` / `finally` / `withResponse()` run the hooks once,
 * then hand the caller the untouched value / error. Every other member (`asResponse()`, …)
 * is the original's. Parsing stays lazy — nothing is read until the caller awaits.
 */
function observePromise<P>(promise: P, onValue: (value: unknown) => void, onError: (error: unknown) => void) {
  if (!isThenable(promise)) {
    safe(() => onValue(promise));

    return promise;
  }

  const target = promise as unknown as object;
  const originalThen = (promise as PromiseLike<unknown>).then;
  let settled = false;
  let observed: Promise<unknown> | undefined;

  const value = (resolved: unknown) => {
    if (!settled) {
      settled = true;
      safe(() => onValue(resolved));
    }

    return resolved;
  };

  const error = (reason: unknown) => {
    if (!settled) {
      settled = true;
      safe(() => onError(reason));
    }

    throw reason;
  };

  const observe = () => {
    observed ??= Promise.resolve(Reflect.apply(originalThen, target, [value, error]) as PromiseLike<unknown>);

    return observed;
  };

  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => observe().then(onFulfilled, onRejected);
      }

      if (prop === 'catch') {
        return (onRejected?: (e: unknown) => unknown) => observe().then(undefined, onRejected);
      }

      if (prop === 'finally') {
        return (onFinally?: () => void) => observe().finally(onFinally);
      }

      const member: unknown = Reflect.get(t, prop, t);

      if (prop === 'withResponse' && typeof member === 'function') {
        return () =>
          Promise.resolve(Reflect.apply(member, t, []) as PromiseLike<unknown>).then((result) => {
            value(rec(result)['data']);

            return result;
          }, error);
      }

      return typeof member === 'function' && prop !== 'constructor' ? member.bind(t) : member;
    },
  });

  return proxy as unknown as P;
}

/** Start an instrumented call: strict check, then invoke. A synchronous throw is recorded and re-thrown untouched. */
function startCall(ctx: MethodContext, requestModel: string | undefined) {
  const call = new AdapterCall(ctx.scope, ctx.path, requestModel, ctx.perCall);

  call.assertAttribution();

  try {
    const result: unknown = ctx.original(...ctx.args);

    return { call, result };
  } catch (error) {
    call.recordError(error);
    throw error;
  }
}

/**
 * Run an instrumented call that returns a promise: then `onValue` (a message / completion /
 * stream) or a zero-token error event.
 */
export function runPromiseCall(ctx: MethodContext, requestModel: string | undefined, onValue: (call: AdapterCall, value: unknown) => void) {
  const { call, result } = startCall(ctx, requestModel);

  return observePromise(result, (value) => onValue(call, value), (error) => call.recordError(error));
}

// ---------------------------------------------------------------- streams

/** Per-iteration view of a stream's events. */
export interface StreamObserver {
  /** Inspect one event; return true to HIDE it from the caller (only the injected OpenAI usage chunk). */
  event(event: unknown): boolean;
  /** The provider's end-of-response event was seen. */
  readonly complete: boolean;
}

const TAPPED = Symbol.for('@bluefyn/ai-spend-sdk.tapped');

function isTapped(stream: object) {
  return Reflect.get(stream, TAPPED) === true;
}

function markTapped(stream: object) {
  Object.defineProperty(stream, TAPPED, { value: true, enumerable: false, configurable: true });
}

function isAborted(stream: object) {
  const controller: unknown = Reflect.get(stream, 'controller');
  const signal: unknown = isObjectLike(controller) ? Reflect.get(controller, 'signal') : undefined;

  return isObjectLike(signal) && Reflect.get(signal, 'aborted') === true;
}

interface BranchState {
  active: number;
}

/**
 * Tap an async-iterable SDK stream (Stainless `Stream`: `messages.create({ stream: true })`,
 * `chat.completions.create({ stream: true })`, …) IN PLACE: the instance gets its own
 * `[Symbol.asyncIterator]` (which `for await` and `toReadableStream()` use) and `tee()`, both
 * delegating to the originals. Returns false when the value is not such a stream.
 *
 * Outcome per iteration: ran to the end → `success` (or `aborted` if the controller was
 * aborted before the end event); the consumer stopped early (`break` → `return()`) →
 * `aborted`, unless the end event was already seen; the iterator threw → `error`. With
 * `tee()` branches, a branch that stops early only records when no other branch is still
 * being read.
 */
export function tapIterableStream<O extends StreamObserver>(stream: unknown, makeObserver: () => O, finish: (observer: O, status: AiSpendStatusValue) => void) {
  if (!isObjectLike(stream) || typeof Reflect.get(stream, Symbol.asyncIterator) !== 'function') {
    return false;
  }

  if (isTapped(stream)) {
    return true;
  }

  try {
    tapInstance(stream, { active: 0 }, makeObserver, finish);

    return true;
  } catch {
    return false;
  }
}

function tapInstance<O extends StreamObserver>(stream: object, branches: BranchState, makeObserver: () => O, finish: (observer: O, status: AiSpendStatusValue) => void) {
  const iterate = Reflect.get(stream, Symbol.asyncIterator) as (this: object) => AsyncIterator<unknown>;
  const tee: unknown = Reflect.get(stream, 'tee');

  Object.defineProperty(stream, Symbol.asyncIterator, {
    value: function aiSpendTappedIterator() {
      return tapIterator(Reflect.apply(iterate, stream, []) as AsyncIterator<unknown>, stream, branches, makeObserver(), finish);
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });

  if (typeof tee === 'function') {
    Object.defineProperty(stream, 'tee', {
      value: function aiSpendTappedTee(...args: unknown[]) {
        const out: unknown = Reflect.apply(tee, stream, args);

        if (Array.isArray(out)) {
          for (const branch of out) {
            if (isObjectLike(branch) && typeof Reflect.get(branch, Symbol.asyncIterator) === 'function') {
              safe(() => tapInstance(branch, branches, makeObserver, finish));
            }
          }
        }

        return out;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  markTapped(stream);
}

function tapIterator<O extends StreamObserver>(
  source: AsyncIterator<unknown>,
  stream: object,
  branches: BranchState,
  observer: O,
  finish: (observer: O, status: AiSpendStatusValue) => void,
) {
  let ended = false;

  branches.active++;

  const end = (status: AiSpendStatusValue) => {
    if (ended) return;

    ended = true;
    branches.active--;

    if (status === AiSpendStatus.SUCCESS || branches.active <= 0) {
      safe(() => finish(observer, status));
    }
  };

  const stoppedEarly = () => (observer.complete ? AiSpendStatus.SUCCESS : AiSpendStatus.ABORTED);

  const iterator: AsyncIterableIterator<unknown> = {
    async next(...args: [] | [unknown]) {
      for (;;) {
        let result: IteratorResult<unknown>;

        try {
          result = await source.next(...args);
        } catch (error) {
          end(statusOfError(error));
          throw error;
        }

        if (result.done) {
          end(observer.complete || !isAborted(stream) ? AiSpendStatus.SUCCESS : AiSpendStatus.ABORTED);

          return result;
        }

        let hide = false;

        try {
          hide = observer.event(result.value);
        } catch {
          // a failing observer never hides an event from the caller
        }

        if (!hide) {
          return result;
        }
      }
    },

    async return(value?: unknown) {
      end(stoppedEarly());

      if (typeof source.return === 'function') {
        return source.return(value);
      }

      const done: IteratorResult<unknown> = { done: true, value };

      return done;
    },

    async throw(error?: unknown) {
      end(stoppedEarly());

      if (typeof source.throw === 'function') {
        return source.throw(error);
      }

      throw error;
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return iterator;
}

/**
 * Tap an event-emitter SDK stream (Anthropic `MessageStream`, OpenAI `ResponseStream`)
 * through its public `on()`: `eventName` feeds the observer, `end` (emitted after success,
 * error AND abort) finishes. Only non-error listeners are added, so the stream's
 * unhandled-rejection behaviour is unchanged, and nothing is consumed for the caller.
 */
export function tapEventStream(stream: unknown, eventName: string, observer: StreamObserver, finish: (status: AiSpendStatusValue) => void) {
  if (!isObjectLike(stream)) return false;
  if (isTapped(stream)) return true;

  const on: unknown = Reflect.get(stream, 'on');

  if (typeof on !== 'function') return false;

  try {
    Reflect.apply(on, stream, [eventName, (event: unknown) => safe(() => void observer.event(event))]);
    Reflect.apply(on, stream, ['end', () => safe(() => finish(eventStreamStatus(stream)))]);
    markTapped(stream);

    return true;
  } catch {
    return false;
  }
}

function eventStreamStatus(stream: object) {
  if (Reflect.get(stream, 'aborted') === true) return AiSpendStatus.ABORTED;
  if (Reflect.get(stream, 'errored') === true) return AiSpendStatus.ERROR;

  return AiSpendStatus.SUCCESS;
}

/** A stream observer that records its call once the stream ends. */
export interface RecordingStreamObserver extends StreamObserver {
  finish(call: AdapterCall, status: AiSpendStatusValue): void;
}

/**
 * Run an instrumented call that returns an event-emitter stream helper (Anthropic
 * `MessageStream`, OpenAI `ResponseStream`) and hand it back untouched: tapped through
 * `on(eventName)`, or — a stream without `on()` — through its iterator.
 */
export function runEventStreamCall(ctx: MethodContext, requestModel: string | undefined, observer: RecordingStreamObserver, eventName: string) {
  const { call, result } = startCall(ctx, requestModel);
  const finish = (status: AiSpendStatusValue) => observer.finish(call, status);

  if (!tapEventStream(result, eventName, observer, finish)) {
    tapIterableStream(result, () => observer, (_observer, status) => finish(status));
  }

  return result;
}

// ---------------------------------------------------------------- client proxy

/** An instrumented method call, after the per-call `aiSpend` option was stripped. */
export interface MethodContext {
  readonly scope: WrapScope;
  /** `messages.create`, `chat.completions.create`, … */
  readonly path: string;
  /** The original method, bound to its resource. */
  readonly original: (...args: unknown[]) => unknown;
  /** The caller's arguments (options without `aiSpend`); handlers may replace the body. */
  readonly args: unknown[];
  readonly perCall: AiSpendAttribution;
}

export type MethodHandler = (ctx: MethodContext) => unknown;

/** Instrumentation map of one object in the client tree. */
export interface ProxyNode {
  readonly methods?: Readonly<Record<string, MethodHandler>>;
  readonly children?: Readonly<Record<string, ProxyNode>>;
}

/** `(body, { …options, aiSpend })` → `(body, options)` + the per-call attribution. */
function stripAiSpendOption(args: unknown[]) {
  const options = args[1];

  if (!isRecord(options) || !Object.prototype.hasOwnProperty.call(options, AI_SPEND_OPTION)) {
    return { args, perCall: pickAttribution(undefined) };
  }

  const { [AI_SPEND_OPTION]: raw, ...rest } = options;
  const forwarded = args.slice();

  forwarded[1] = rest;

  return { args: forwarded, perCall: pickAttribution(raw) };
}

/** A non-configurable read-only own property must be returned as-is (Proxy invariant). */
function mustReturnAsIs(target: object, prop: PropertyKey) {
  const descriptor = Object.getOwnPropertyDescriptor(target, prop);

  if (!descriptor || descriptor.configurable) return false;

  return 'value' in descriptor ? descriptor.writable !== true : descriptor.get === undefined;
}

function instrument(scope: WrapScope, path: string, handler: MethodHandler, resource: object, method: (...args: unknown[]) => unknown) {
  return function aiSpendInstrumented(...callArgs: unknown[]) {
    const { args, perCall } = stripAiSpendOption(callArgs);
    const original = (...forwarded: unknown[]) => Reflect.apply(method, resource, forwarded);

    if (!scope.active) {
      return original(...args);
    }

    return handler({ scope, path, original, args, perCall });
  };
}

function proxyFor<T extends object>(target: T, node: ProxyNode, scope: WrapScope, path: string, isRoot: boolean) {
  const cached = scope.cache.get(target);

  if (cached) return cached as T;

  const members = new Map<PropertyKey, { source: unknown; value: unknown }>();

  const memo = (prop: PropertyKey, source: unknown, make: () => unknown) => {
    const hit = members.get(prop);

    if (hit && hit.source === source) return hit.value;

    const value = make();

    members.set(prop, { source, value });

    return value;
  };

  const proxy = new Proxy(target, {
    get(t, prop) {
      if (isRoot && prop === 'withAttribution') {
        return memo(prop, scope, () => (attribution: AiSpendAttribution) =>
          proxyFor(t, node, scope.derive({ scoped: mergeAttribution(scope.scoped, pickAttribution(attribution)) }), path, true));
      }

      const value: unknown = Reflect.get(t, prop, t);

      if (prop === 'constructor' || mustReturnAsIs(t, prop)) {
        return value;
      }

      if (typeof prop === 'symbol') {
        return typeof value === 'function' ? memo(prop, value, () => value.bind(t)) : value;
      }

      const child = node.children?.[prop];

      if (child && isObjectLike(value)) {
        return proxyFor(value, child, scope, `${path}${prop}.`, false);
      }

      const handler = node.methods?.[prop];

      if (handler && typeof value === 'function') {
        return memo(prop, value, () => instrument(scope, `${path}${prop}`, handler, t, value as (...args: unknown[]) => unknown));
      }

      if (isRoot && prop === 'withOptions' && typeof value === 'function') {
        return memo(prop, value, () => (...args: unknown[]) => {
          const next: unknown = Reflect.apply(value, t, args);

          return isObjectLike(next) ? proxyFor(next, node, scope.derive({ provider: scope.config.providerOf(next), target: next }), path, true) : next;
        });
      }

      return typeof value === 'function' ? memo(prop, value, () => value.bind(t)) : value;
    },
  });

  scope.cache.set(target, proxy);

  return proxy;
}

/**
 * Wrap `target` (a provider SDK client). A missing / foreign AI Spend client returns the
 * target untouched — wrapping never throws.
 */
export function wrapClient<T extends object>(target: T, aiSpend: AiSpendClient, defaults: AiSpendAttribution | undefined, config: WrapConfig) {
  if (!isObjectLike(target) || !isObjectLike(aiSpend) || typeof (aiSpend as { record?: unknown }).record !== 'function') {
    return target as AiSpendWrapped<T>;
  }

  const internal = internalOf(aiSpend);
  const active = aiSpend.enabled !== false || internal?.strict === true;
  const scope = new WrapScope(config, aiSpend, internal, config.providerOf(target), pickAttribution(defaults), {}, active, target);
  const wrapped = proxyFor(target, config.root, scope, '', true) as AiSpendWrapped<T>;

  return wrapped;
}
