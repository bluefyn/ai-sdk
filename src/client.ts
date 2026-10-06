import {
  ambientAttribution,
  carry,
  current,
  isValidFeature,
  mergeAttribution,
  missingAttributionIssues,
  pickAttribution,
  registerAmbientWarner,
  validateAttribution,
  withCarried,
  withContext,
} from './attribution';
import type { AiSpendCarrier } from './attribution';
import { AiSpendCustomerNames, checkCustomerName } from './customer-names';
import type { CustomerNameIssue } from './customer-names';
import { AiSpendDelivery } from './delivery';
import { eventIdFrom } from './event-id';
import type { AiSpendCustomerNameStats, AiSpendEventStats, AiSpendFetch, AiSpendLogger, AiSpendStats } from './delivery';
import {
  AiSpendAttributionError,
  AiSpendAttributionIssueCode,
  AiSpendInvalidUsageError,
  AiSpendRejectedCustomerNameError,
  AiSpendRejectedEventError,
  AiSpendSdkError,
  AiSpendUsageIssueCode,
} from './errors';
import type { AiSpendAttributionIssue, AiSpendUsageIssue } from './errors';
import { registerInternal } from './internal';
import type { AiSpendClientInternal } from './internal';
import { CANONICAL_USAGE_KEYS, checkUsageKeys, isEmptyUsage, sanitizeUsage } from './normalize';
import { registerExitFlush } from './exit-flush';
import type { ExitFlushRegistration, ExitFlushTarget } from './exit-flush';
import { isBrowser, readEnv } from './runtime';
import { clipText, isRecord } from './util';
import { isUuid, uuidv7 } from './uuidv7';
import {
  AI_SPEND_API_KEY_ENV,
  AI_SPEND_CUSTOMER_NAMES_PATH,
  AI_SPEND_DEFAULT_ENDPOINT,
  AI_SPEND_ENDPOINT_ENV,
  AI_SPEND_EVENTS_PATH,
  AI_SPEND_LIMITS,
  AI_SPEND_SDK_NAME,
  AI_SPEND_SDK_VERSION,
  AiSpendAdapter,
  AiSpendRejectionCode,
  AiSpendStatus,
} from './wire';
import type { AiSpendAttribution, AiSpendUsageRecord, AiSpendWireEvent } from './wire';

export interface AiSpendOptions {
  /** `bfu_…` ingest key. Default: `process.env.BLUEFYN_AI_SPEND_KEY`. Missing → the client is disabled (one warning). */
  apiKey?: string;
  /**
   * API base URL WITHOUT `/v1` — the SDK appends `/v1/ai-usage/…` itself. Default:
   * `process.env.BLUEFYN_AI_SPEND_ENDPOINT`, else `https://gateway.bluefyn.ai/api`. A base pasted
   * with `/v1` (or the full events / customer-names URL) is trimmed back to the base with one
   * warning.
   */
  endpoint?: string;
  /**
   * Feature for calls nothing else attributed. Precedence, highest first: per-call value →
   * ambient `withContext` → (Vercel adapter) a valid lowercased `functionId` → `defaultFeature`.
   */
  defaultFeature?: string;
  /** Customer for calls with no per-call or ambient customer. */
  defaultCustomer?: string;
  /**
   * Throw from `record()` instead of warning: `AiSpendAttributionError` on missing/invalid
   * attribution, `AiSpendInvalidUsageError` on a manual usage with unknown keys or nothing billable.
   * For test suites only.
   */
  strict?: boolean;
  /** Warn (once per call site / feature, rate-limited) about missing or invalid attribution. Default: `NODE_ENV !== 'production'`. */
  warnOnMissingAttribution?: boolean;
  /** Buffered events before the oldest are dropped. Default 10 000. */
  maxQueueSize?: number;
  /** Background flush interval (events and customer names). Default 5 000 ms. */
  flushIntervalMs?: number;
  /** Events per request (server max 500). Default 500. */
  maxBatchSize?: number;
  /** Request body size (server max 1 MB). Default 900 000 bytes. */
  maxBatchBytes?: number;
  /** How long a failing batch (or customer-names request) is retried before it is dropped. Default 600 000 ms (10 min). */
  maxRetryMs?: number;
  /** Called with every delivery failure / rejection. Never awaited; its errors are swallowed. */
  onError?: (error: AiSpendSdkError) => void;
  /** Where the SDK logs. Default: `console` (debug lines only when `debug: true`). */
  logger?: AiSpendLogger;
  /** Print the SDK's debug lines through the default console logger. */
  debug?: boolean;
  /** Custom `fetch` (proxies, tests). Default: the global `fetch`. */
  fetch?: AiSpendFetch;
  /** Turn the client into a no-op (e.g. in unit tests). */
  disabled?: boolean;
}

export interface AiSpendShutdownOptions {
  /**
   * How long shutdown may keep delivering (retrying through backoff / `Retry-After`). Events and
   * customer names still undelivered then are counted as dropped. Default 5 000 ms; `0` = do not wait.
   */
  timeoutMs?: number;
}

export interface AiSpendClient {
  /** False when disabled (no key, browser, `disabled: true`, no `fetch`): every method is then a no-op. */
  readonly enabled: boolean;
  /**
   * Record one provider call. Never throws (except in `strict` mode) and never blocks. `usage`
   * keys other than the canonical ones (`inputTokens`, `cachedInputTokens`, `cacheWrite5mTokens`,
   * `cacheWrite1hTokens`, `outputTokens`, `reasoningTokens`, `toolRequests`) are ignored with a
   * warning (once per call site) naming the key meant; so is a `success` event with no tokens, no
   * tool requests and no cost. Both are counted in `stats().invalidUsage`.
   */
  record(usage: AiSpendUsageRecord): void;
  /**
   * Give one of your customers a human-readable name in Bluefyn — `customer` is the same opaque
   * id you attribute AI calls to (`withContext({ customer })`). Call it when the customer signs
   * up, logs in, or is renamed. The name is sent once, in the background and apart from usage
   * events (which never carry names); repeats of a name already sent from this process are
   * skipped, and a name someone set in Bluefyn always wins over it.
   *
   * Fire-and-forget: never throws, never blocks. Both values are trimmed; an empty or longer than
   * 256-character value, or a `customer` that looks like an email address, is dropped with one
   * warning per kind of problem (counted in `stats().customerNames.rejected`, reported to
   * `onError`). A no-op on a disabled client.
   */
  nameCustomer(customer: string, displayName: string): void;
  /**
   * Send everything buffered now — events and customer names. Resolves once everything queued at
   * call time was attempted. Serverless: `await` it or hand it to `waitUntil`.
   */
  flush(): Promise<void>;
  /** Final flush (bounded by `timeoutMs`), then stop background work. Call from your shutdown hook. */
  shutdown(options?: AiSpendShutdownOptions): Promise<void>;
  stats(): AiSpendStats;
  /** Run `fn` with this attribution merged over the enclosing context. */
  withContext<T>(attrs: AiSpendAttribution, fn: () => T): T;
  /** The ambient attribution of the current async flow. */
  current(): AiSpendAttribution | undefined;
  /** Serialisable snapshot of the ambient attribution, to put in a job payload. */
  carry(): AiSpendCarrier | undefined;
  /** Restore a carried attribution around `fn` (e.g. in a queue worker). */
  withCarried<T>(carrier: AiSpendCarrier | null | undefined | unknown, fn: () => T): T;
}

const DEFAULTS = {
  maxQueueSize: 10_000,
  flushIntervalMs: 5_000,
  maxBatchSize: 500,
  maxBatchBytes: 900_000,
  maxRetryMs: 600_000,
  shutdownTimeoutMs: 5_000,
} as const;

/** Attribution warnings: at most this many per window, each distinct key once. */
const WARN_WINDOW_MS = 60_000;
const WARN_MAX_PER_WINDOW = 10;
const WARN_MAX_KEYS = 1_000;
/** Same rule as the server's `cost.amount`: at most 6 integer digits (below $1,000,000 per call). */
const DECIMAL_PATTERN = new RegExp(`^\\d{1,${AI_SPEND_LIMITS.COST_MAX_INTEGER_DIGITS}}(\\.\\d+)?$`);
/** The server only reads `occurred_at` as an RFC 3339 timestamp: a 4-digit year. */
const MIN_OCCURRED_AT_MS = -62_167_219_200_000; // 0000-01-01T00:00:00.000Z
const MAX_OCCURRED_AT_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z
/** The server keeps 9 decimals (it rounds beyond that); numbers are formatted to this scale. */
const COST_DECIMALS = 9;
/** A numeric `occurredAt` below this is almost certainly seconds, not milliseconds (it is before 1973). */
const SECONDS_EPOCH_SUSPECT_BELOW = 1e11;
const SDK_FRAME = /[\\/]ai-spend-sdk[\\/](?:src|dist)[\\/]/;
const SPEC_FRAME = /\.(?:spec|test)\.[cm]?[jt]s/;
/** Frames captured below the public entry point when looking for the caller's line. */
const CALL_SITE_FRAMES = 2;
/** The server keeps at most this many characters of `sdk.adapter`. */
const SDK_ADAPTER_MAX_LENGTH = 32;

/** The default logger: `console`, prefixed `[ai-spend]` (pass `logger` to route it elsewhere). */
function consoleLogger(debug: boolean) {
  const logger: AiSpendLogger = {
    debug: debug ? (message, meta) => console.debug(`[ai-spend] ${message}`, meta ?? '') : undefined,
    info: (message, meta) => console.info(`[ai-spend] ${message}`, meta ?? ''),
    warn: (message, meta) => console.warn(`[ai-spend] ${message}`, meta ?? ''),
    error: (message, meta) => console.error(`[ai-spend] ${message}`, meta ?? ''),
  };

  return logger;
}

/** Suffixes a pasted endpoint may carry that the SDK appends itself — longest first. */
const ENDPOINT_SUFFIXES = [AI_SPEND_EVENTS_PATH, AI_SPEND_CUSTOMER_NAMES_PATH, '/v1'];

/**
 * The API base the transports append their paths to: trimmed, trailing slashes removed, and a
 * trailing `/v1` (or a full events / customer-names path) stripped — the documented public-API
 * base is `…/api/v1`, and keeping it would post to `…/v1/v1/…`, where every request 404s.
 * `trimmed` is set when a suffix was removed, so the caller can warn.
 */
export function normalizeEndpoint(raw: string) {
  let endpoint = raw.trim().replace(/\/+$/, '');
  const lower = endpoint.toLowerCase();
  const suffix = ENDPOINT_SUFFIXES.find((candidate) => lower.endsWith(candidate.toLowerCase()));

  if (suffix) {
    endpoint = endpoint.slice(0, endpoint.length - suffix.length).replace(/\/+$/, '');
  }

  return { endpoint, trimmed: suffix !== undefined };
}

function positiveInt(value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), max) : fallback;
}

function toDate(value: Date | string | number | undefined) {
  if (value === undefined) return new Date();

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * `cost.amount` as the server's decimal string: numbers are written without exponent or
 * float tails (`5e-7` → `0.0000005`, `0.1 + 0.2` → `0.3`), at most 9 decimals; NaN,
 * Infinity, negatives and $1,000,000 or more (above 6 integer digits) are refused (undefined).
 */
export function formatCostAmount(amount: unknown) {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount < 0) return undefined;

    const fixed = amount.toFixed(COST_DECIMALS).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

    return DECIMAL_PATTERN.test(fixed) ? fixed : undefined;
  }

  if (typeof amount === 'bigint') {
    const digits = amount.toString();

    return DECIMAL_PATTERN.test(digits) ? digits : undefined;
  }

  if (typeof amount === 'string') {
    const trimmed = amount.trim();

    return DECIMAL_PATTERN.test(trimmed) ? trimmed : undefined;
  }

  return undefined;
}

/** First frame of `stack` outside the SDK (a spec file counts as outside), if any. */
function callerFrame(stack: unknown) {
  if (typeof stack !== 'string') return undefined;

  const caller = stack.split('\n').slice(1).find((frame) => !SDK_FRAME.test(frame) || SPEC_FRAME.test(frame));

  return caller?.trim().replace(/^at\s+/, '');
}

/**
 * Only the few frames just below `entry` (the public method the caller called), so the stack
 * is cheap to capture and format; `Error.stackTraceLimit` is restored at once.
 */
function framesBelow(entry: (...args: never[]) => unknown) {
  try {
    const holder: { stack?: unknown } = {};
    const limit = Error.stackTraceLimit;

    Error.stackTraceLimit = CALL_SITE_FRAMES;

    try {
      Error.captureStackTrace(holder, entry);
    } finally {
      Error.stackTraceLimit = limit;
    }

    return holder.stack;
  } catch {
    return undefined; // no V8 stack API (or a locked-down `Error`): the caller falls back to a plain stack
  }
}

/**
 * First stack frame outside the SDK — the caller's line — used to dedupe warnings. Looks just
 * below `entry` first; falls back to the full stack (`entry` not on it, or the frames just
 * below it are the SDK's own).
 */
function callSite(entry: (...args: never[]) => unknown) {
  return callerFrame(framesBelow(entry)) ?? callerFrame(new Error().stack) ?? 'unknown';
}

/** Rate-limited, deduplicated warnings (attribution problems must not flood logs). */
class AttributionWarnings {
  private readonly seen = new Set<string>();
  private windowStart = 0;
  private windowCount = 0;

  public constructor(private readonly log: (message: string) => void) {}

  public warn(key: string, message: string) {
    if (this.seen.has(key)) return;
    if (this.seen.size >= WARN_MAX_KEYS) return;

    const now = Date.now();

    if (now - this.windowStart > WARN_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }

    // Rate-limited: NOT marked as seen, so this call site still warns once the window resets.
    if (this.windowCount >= WARN_MAX_PER_WINDOW) return;

    this.windowCount++;
    this.seen.add(key);
    this.log(message);
  }
}

class AiSpendClientImpl implements AiSpendClient {
  public readonly enabled: boolean;
  private readonly logger: AiSpendLogger;
  private readonly delivery: AiSpendDelivery | undefined;
  private readonly customerNames: AiSpendCustomerNames | undefined;
  private readonly defaults: AiSpendAttribution;
  private readonly strict: boolean;
  private readonly warnAttribution: boolean;
  private readonly warnings: AttributionWarnings;
  private readonly onError: ((error: AiSpendSdkError) => void) | undefined;
  /** Data-quality warnings (not gated by `warnOnMissingAttribution`): each distinct key once. */
  private readonly warnedOnce = new Set<string>();
  /** Strongly held here; by the natural-exit hooks strongly only while something is pending. */
  private exitTarget: ExitFlushTarget | undefined;
  /** Membership of the natural-exit flush: held on enqueue, released when idle, left on `shutdown()`. */
  private exitFlush: ExitFlushRegistration | undefined;

  public constructor(options: AiSpendOptions) {
    this.logger = options.logger ?? consoleLogger(options.debug === true);
    this.strict = options.strict === true;
    this.onError = options.onError;
    this.warnAttribution = options.warnOnMissingAttribution ?? readEnv('NODE_ENV') !== 'production';
    this.warnings = new AttributionWarnings((message) => this.log('warn', `AI Spend: ${message}`));
    this.defaults = this.resolveDefaults(options);

    // Closes over the logger only: the process-wide warner must not keep this client alive.
    const logger = this.logger;

    registerAmbientWarner((message) => {
      try {
        logger.warn?.(message);
      } catch {
        // a broken logger must never break the caller
      }
    });

    const disabledReason = this.disabledReason(options);

    if (disabledReason) {
      this.enabled = false;
      this.delivery = undefined;
      this.customerNames = undefined;

      if (options.disabled !== true) {
        this.log('warn', `AI Spend SDK disabled: ${disabledReason}. AI calls are not tracked.`);
      }

      return;
    }

    // Bound: some runtimes throw "Illegal invocation" when fetch is called with another `this`.
    const fetchImpl = options.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as AiSpendFetch);
    // Events and customer names: same endpoint, key and retry policy — two independent queues.
    const transport = {
      endpoint: this.resolveEndpoint(options),
      apiKey: (options.apiKey ?? readEnv(AI_SPEND_API_KEY_ENV)) as string,
      fetch: fetchImpl,
      logger: this.logger,
      onError: this.onError,
      flushIntervalMs: positiveInt(options.flushIntervalMs, DEFAULTS.flushIntervalMs),
      maxRetryMs: positiveInt(options.maxRetryMs, DEFAULTS.maxRetryMs),
      onIdle: () => this.exitFlush?.releaseIfIdle(),
    };

    this.enabled = true;
    this.delivery = new AiSpendDelivery({
      ...transport,
      maxQueueSize: positiveInt(options.maxQueueSize, DEFAULTS.maxQueueSize),
      maxBatchSize: positiveInt(options.maxBatchSize, DEFAULTS.maxBatchSize, AI_SPEND_LIMITS.MAX_EVENTS_PER_BATCH),
      maxBatchBytes: positiveInt(options.maxBatchBytes, DEFAULTS.maxBatchBytes, AI_SPEND_LIMITS.MAX_BATCH_BYTES),
    });
    this.customerNames = new AiSpendCustomerNames(transport);
    this.exitFlush = registerExitFlush(this.exitFlushTarget());
  }

  public record(usage: AiSpendUsageRecord) {
    this.recordFrom(AiSpendAdapter.MANUAL, usage);
  }

  /** Adapters call this (via the internal handle) so events carry their adapter name. */
  public recordFrom(adapter: string, usage: AiSpendUsageRecord, warnKey?: string) {
    if (!this.enabled && !this.strict) return;

    try {
      const attribution = this.resolveAttribution(usage, warnKey);

      // Adapters build canonical usage themselves; a hand-built one is checked for wrong keys / nothing billable.
      if (adapter === AiSpendAdapter.MANUAL) this.checkManualUsage(usage);

      if (!this.enabled || !this.delivery) return;

      const event = this.toWireEvent(adapter, usage, attribution);

      if (event) {
        this.delivery.enqueue(event);
        this.exitFlush?.hold();
      }
    } catch (error) {
      if ((error instanceof AiSpendAttributionError || error instanceof AiSpendInvalidUsageError) && this.strict) {
        throw error;
      }

      this.log('debug', 'AI Spend: record() failed internally', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  public nameCustomer(customer: string, displayName: string) {
    if (!this.enabled || !this.customerNames) return;

    try {
      const checked = checkCustomerName(customer, displayName);

      // `in`, not `checked.valid`: consumers compiling this source without strictNullChecks do not
      // narrow a boolean discriminant.
      if ('issue' in checked) {
        this.rejectNameLocally(checked.issue);
      } else {
        this.customerNames.enqueue(checked.customer, checked.displayName);
        this.exitFlush?.hold();
      }
    } catch (error) {
      this.log('debug', 'AI Spend: nameCustomer() failed internally', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  public async flush() {
    try {
      // Both queues drain side by side; neither waits behind the other's requests.
      await Promise.all([this.delivery?.flush(), this.customerNames?.flush()]);
      this.exitFlush?.releaseIfIdle();
    } catch {
      // never throws
    }
  }

  public async shutdown(options?: AiSpendShutdownOptions) {
    try {
      this.exitFlush?.unregister();

      const requested = options?.timeoutMs;
      const timeoutMs = typeof requested === 'number' && Number.isFinite(requested) && requested >= 0 ? requested : DEFAULTS.shutdownTimeoutMs;

      // One deadline for both: names undelivered by then are dropped, like events.
      await Promise.all([this.delivery?.shutdown(timeoutMs), this.customerNames?.shutdown(timeoutMs)]);
    } catch {
      // never throws
    }
  }

  public stats() {
    const events: AiSpendEventStats = this.delivery?.stats() ?? {
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
    };
    const customerNames: AiSpendCustomerNameStats = this.customerNames?.stats() ?? { queued: 0, acknowledged: 0, rejected: 0, dropped: 0 };
    const stats: AiSpendStats = { ...events, customerNames };

    return stats;
  }

  public withContext<T>(attrs: AiSpendAttribution, fn: () => T) {
    return withContext(attrs, fn);
  }

  public current() {
    return current();
  }

  public carry() {
    return carry();
  }

  public withCarried<T>(carrier: AiSpendCarrier | null | undefined | unknown, fn: () => T) {
    return withCarried(carrier, fn);
  }

  /**
   * Strict-mode check an adapter can run BEFORE a model call (so the call itself fails in
   * tests). `ambient` is the ambient attribution the adapter read in this synchronous turn.
   */
  public assertAttribution(perCall: AiSpendAttribution, ambient: AiSpendAttribution | undefined) {
    if (!this.strict) return;

    const { issues } = this.resolve(perCall, ambient);

    if (issues.length > 0) {
      throw new AiSpendAttributionError(issues);
    }
  }

  /** A data-quality warning from an adapter, once per `key` for the client's lifetime. */
  public warnOnceFor(key: string, message: string) {
    this.warnOnce(key, message);
  }

  /** A debug line from an adapter (never throws). */
  public debugFor(message: string, meta?: Record<string, unknown>) {
    this.log('debug', message, meta);
  }

  // ------------------------------------------------------------ internals

  /**
   * What the natural-exit hooks see. Held by this client; the hooks hold it strongly only while
   * events / names are pending, so a client the application dropped is delivered before it can be
   * collected, and an idle one is not kept alive by them.
   */
  private exitFlushTarget() {
    const target: ExitFlushTarget = {
      pending: () => {
        const stats = this.stats();

        return stats.queued + stats.customerNames.queued;
      },
      flush: () => this.flush(),
      warnUnsent: (count) =>
        this.log(
          'warn',
          `AI Spend: the process is exiting with ${count} events / customer names still unsent — call \`await aiSpend.shutdown()\` (or \`flush()\`) before your script ends`,
        ),
    };

    this.exitTarget = target;

    return target;
  }

  /**
   * `endpoint` option → `BLUEFYN_AI_SPEND_ENDPOINT` → the production default, normalised by
   * `normalizeEndpoint` (one warning when a `/v1` or full path is trimmed). A non-string or blank
   * value counts as not given, and a value that normalises to nothing falls back to the default —
   * configuration never throws.
   */
  private resolveEndpoint(options: AiSpendOptions) {
    const configured = typeof options.endpoint === 'string' && options.endpoint.trim().length > 0 ? options.endpoint : undefined;
    const source = configured !== undefined ? 'the endpoint option' : AI_SPEND_ENDPOINT_ENV;
    const raw = configured ?? readEnv(AI_SPEND_ENDPOINT_ENV);

    if (raw === undefined) return AI_SPEND_DEFAULT_ENDPOINT;

    const { endpoint, trimmed } = normalizeEndpoint(raw);

    if (endpoint.length === 0) {
      this.log('warn', `AI Spend: ${source} (${JSON.stringify(raw)}) is not an API base URL — using ${AI_SPEND_DEFAULT_ENDPOINT}`);

      return AI_SPEND_DEFAULT_ENDPOINT;
    }

    if (trimmed) {
      this.log(
        'warn',
        `AI Spend: ${source} should be the API base without /v1 (the SDK adds /v1/ai-usage/… itself) — using ${JSON.stringify(endpoint)} instead of ${JSON.stringify(raw)}`,
      );
    }

    return endpoint;
  }

  private disabledReason(options: AiSpendOptions) {
    if (options.disabled === true) return 'disabled by configuration';
    if (isBrowser()) return 'running in a browser — the ingest key must never ship to end users; record usage from your backend';
    if (!(options.apiKey ?? readEnv(AI_SPEND_API_KEY_ENV))) return `no ingest key (pass apiKey or set ${AI_SPEND_API_KEY_ENV})`;
    if (typeof (options.fetch ?? globalThis.fetch) !== 'function') return 'no fetch implementation available (Node ≥ 18, or pass options.fetch)';

    return undefined;
  }

  private resolveDefaults(options: AiSpendOptions) {
    const defaults: AiSpendAttribution = {};

    if (typeof options.defaultCustomer === 'string' && options.defaultCustomer.length > 0) {
      defaults.customer = options.defaultCustomer;
    }

    if (typeof options.defaultFeature === 'string' && options.defaultFeature.length > 0) {
      if (isValidFeature(options.defaultFeature)) {
        defaults.feature = options.defaultFeature;
      } else {
        this.log('warn', 'AI Spend: defaultFeature is not a valid feature path (lowercase dot-path, ≤6 segments of [a-z0-9_-]) and is ignored');
      }
    }

    return defaults;
  }

  /** per-call → ambient → client defaults, validated; `issues` = invalid values + missing customer / feature. */
  private resolve(perCall: AiSpendAttribution, ambient: AiSpendAttribution | undefined) {
    const { attribution, issues } = validateAttribution(mergeAttribution(mergeAttribution(this.defaults, ambient), perCall));

    return { attribution, issues: [...issues, ...missingAttributionIssues(attribution)] };
  }

  /** The event's attribution at record time; warns (dev) or throws (strict) about its issues. */
  private resolveAttribution(usage: AiSpendUsageRecord, warnKey?: string) {
    const { attribution, issues } = this.resolve(pickAttribution(usage), ambientAttribution());

    if (issues.length === 0) return attribution;

    if (this.strict) {
      throw new AiSpendAttributionError(issues);
    }

    if (this.warnAttribution) {
      this.warnAbout(issues, usage, attribution, warnKey);
    }

    return attribution;
  }

  private warnAbout(issues: AiSpendAttributionIssue[], usage: AiSpendUsageRecord, attribution: AiSpendAttribution, warnKey?: string) {
    // Adapters pass a warnKey; a manual `record()` does not — its caller's line is just below `record`.
    const site = warnKey ?? callSite(AiSpendClientImpl.prototype.record);
    const where = attribution.feature ? `feature "${attribution.feature}"` : `${usage.provider}/${usage.model}`;

    for (const issue of issues) {
      const scope = issue.code === AiSpendAttributionIssueCode.MISSING_CUSTOMER || issue.code === AiSpendAttributionIssueCode.MISSING_FEATURE
        ? `${attribution.feature ?? ''}|${site}`
        : issue.field;

      this.warnings.warn(`${issue.code}|${scope}`, `${issue.message} (${where}${warnKey ? '' : ` at ${site}`})`);
    }
  }

  /**
   * A hand-built `record()` usage the server would store as something other than what the caller
   * meant: keys the SDK does not read (their values are silently 0 — e.g. `input` for
   * `inputTokens`), a non-object `usage`, or a `success` event with no tokens, no tool requests and
   * no cost (stored unpriced at $0). Counted in `stats().invalidUsage` and warned once per call
   * site; `strict` throws `AiSpendInvalidUsageError`. The event itself is still sent.
   */
  private checkManualUsage(usage: AiSpendUsageRecord) {
    const issues: AiSpendUsageIssue[] = [];
    const keys = checkUsageKeys(usage.usage);
    const canonicalList = CANONICAL_USAGE_KEYS.join(', ');

    if (keys.notAnObject) {
      issues.push({
        code: AiSpendUsageIssueCode.NOT_AN_OBJECT,
        keys: [],
        message: `usage must be an object with ${canonicalList} — it was ignored`,
      });
    } else if (keys.unknown.length > 0) {
      const named = keys.unknown.map(({ key, suggestion }) => (suggestion ? `"${key}" (did you mean ${suggestion}?)` : `"${key}"`)).join(', ');
      const hint = keys.normalizer ? ` — this looks like a provider usage object: pass usage: ${keys.normalizer}` : '';

      issues.push({
        code: AiSpendUsageIssueCode.UNKNOWN_KEY,
        keys: keys.unknown.map(({ key }) => key),
        message: `usage has unknown key${keys.unknown.length === 1 ? '' : 's'} ${named}, ignored (counted as 0). The keys record() reads are ${canonicalList}${hint}`,
      });
    }

    const status = this.statusOf(usage.status);
    const hasCost = isRecord(usage.cost) && (usage.cost.currency ?? 'USD') === 'USD' && formatCostAmount(usage.cost.amount) !== undefined;

    if (status === AiSpendStatus.SUCCESS && !hasCost && isEmptyUsage(sanitizeUsage(usage.usage))) {
      issues.push({
        code: AiSpendUsageIssueCode.EMPTY,
        keys: [],
        message: `a successful call was recorded with no tokens, no tool requests and no cost, so it is stored unpriced at $0 — pass usage: { inputTokens, outputTokens, … } (or a from*Usage() normalizer), or a cost`,
      });
    }

    if (issues.length === 0) return;

    if (this.strict) throw new AiSpendInvalidUsageError(issues);

    this.delivery?.countInvalidUsage(1);

    const site = callSite(AiSpendClientImpl.prototype.record);
    const where = `${typeof usage.provider === 'string' ? usage.provider : '?'}/${typeof usage.model === 'string' ? usage.model : '?'}`;

    for (const issue of issues) {
      this.warnOnce(`${issue.code}|${site}`, `AI Spend: record() ${issue.message} (${where} at ${site})`);
    }
  }

  /**
   * The wire event — pre-flighted against the server's validator, so an event the SDK builds is
   * never refused as a WHOLE over a field the SDK can fix: an invalid optional value (latency,
   * service tier, cost, a tool name) is dropped or clipped with a one-time warning and the
   * event's usage is still sent. Only an unusable identity (no provider/model, an invalid
   * `occurredAt`) keeps the event from being sent.
   */
  private toWireEvent(adapter: string, usage: AiSpendUsageRecord, attribution: AiSpendAttribution) {
    const provider = typeof usage.provider === 'string' ? clipText(usage.provider.trim(), AI_SPEND_LIMITS.PROVIDER_MAX_LENGTH).trim() : '';
    const model = typeof usage.model === 'string' ? clipText(usage.model.trim(), AI_SPEND_LIMITS.MODEL_MAX_LENGTH).trim() : '';
    const occurredAt = toDate(usage.occurredAt);
    const occurredAtMs = occurredAt?.getTime();

    if (!provider || !model || occurredAtMs === undefined || occurredAtMs < MIN_OCCURRED_AT_MS || occurredAtMs > MAX_OCCURRED_AT_MS) {
      this.rejectLocally(
        occurredAtMs === undefined || occurredAtMs < MIN_OCCURRED_AT_MS || occurredAtMs > MAX_OCCURRED_AT_MS
          ? 'occurredAt is not a valid date (years 0000–9999)'
          : 'provider and model are required',
        typeof usage.eventId === 'string' ? usage.eventId : undefined,
      );

      return undefined;
    }

    this.checkOccurredAt(usage.occurredAt, occurredAtMs);

    if (usage.eventId !== undefined && usage.occurredAt === undefined) {
      this.warnOnce(
        'event_id_without_occurred_at',
        'AI Spend: eventId was passed without occurredAt, so occurredAt defaults to now. The server dedupes eventId across its 30-day window, but a replay stamped now is booked on the day of the replay, and one sent more than 30 days after the call is stored again. Pass the original call time as occurredAt.',
      );
    }

    const canonical = sanitizeUsage(usage.usage, (key, message) => this.warnOnce(key, `AI Spend: ${message}`));

    const event: AiSpendWireEvent = {
      event_id: this.eventIdOf(usage.eventId),
      occurred_at: new Date(occurredAtMs).toISOString(),
      provider,
      model,
      status: this.statusOf(usage.status),
      usage: {
        input_tokens: canonical.inputTokens,
        cached_input_tokens: canonical.cachedInputTokens,
        cache_write_5m_tokens: canonical.cacheWrite5mTokens,
        cache_write_1h_tokens: canonical.cacheWrite1hTokens,
        output_tokens: canonical.outputTokens,
        reasoning_tokens: canonical.reasoningTokens,
        ...(Object.keys(canonical.toolRequests).length > 0 ? { tool_requests: canonical.toolRequests } : {}),
      },
      sdk: { name: AI_SPEND_SDK_NAME, version: AI_SPEND_SDK_VERSION, adapter: clipText(adapter, SDK_ADAPTER_MAX_LENGTH) },
    };

    const serviceTier = this.serviceTierOf(usage.serviceTier);

    if (serviceTier) event.service_tier = serviceTier;

    if (usage.batch === true) event.batch = true;

    const latencyMs = this.latencyOf(usage.latencyMs);

    if (latencyMs !== undefined) event.latency_ms = latencyMs;

    if (attribution.customer) event.customer = attribution.customer;
    if (attribution.feature) event.feature = attribution.feature;
    if (attribution.user) event.user = attribution.user;
    if (attribution.runId) event.run_id = attribution.runId;
    if (attribution.entityRef) event.entity_ref = attribution.entityRef;
    if (attribution.tags && Object.keys(attribution.tags).length > 0) event.tags = attribution.tags;

    const cost = this.costOf(usage);

    if (cost) event.cost = cost;

    return event;
  }

  /**
   * A caller-supplied UUID is kept; any other non-empty string becomes a deterministic UUIDv5
   * (`eventIdFrom`), so replays of the same key still dedupe. Anything else gets a fresh UUIDv7.
   */
  private eventIdOf(eventId: unknown) {
    if (isUuid(eventId)) return eventId.toLowerCase();

    if (typeof eventId === 'string' && eventId.length > 0) {
      this.log('debug', 'AI Spend: eventId is not a UUID — a deterministic UUIDv5 was derived from it (eventIdFrom)');

      return eventIdFrom(eventId);
    }

    if (eventId !== undefined) {
      this.warnOnce('event_id', 'AI Spend: eventId must be a non-empty string (a UUID, or your own key); a fresh id was generated instead, so replays of this event will NOT be deduplicated');
    }

    return uuidv7();
  }

  /** The server rejects `occurred_at` older than 30 days or more than 5 minutes ahead. */
  private checkOccurredAt(raw: AiSpendUsageRecord['occurredAt'], occurredAtMs: number) {
    if (typeof raw === 'number' && raw > 0 && raw < SECONDS_EPOCH_SUSPECT_BELOW) {
      this.warnOnce('occurred_at_seconds', 'AI Spend: occurredAt looks like SECONDS since the epoch — pass milliseconds (Date.now()) or a Date');
    }

    const offset = occurredAtMs - Date.now();

    if (offset < -AI_SPEND_LIMITS.MAX_EVENT_AGE_MS || offset > AI_SPEND_LIMITS.MAX_EVENT_FUTURE_SKEW_MS) {
      this.warnOnce(
        'occurred_at_range',
        'AI Spend: occurredAt is more than 30 days old or more than 5 minutes in the future — the server will reject the event (occurred_at_out_of_range)',
      );
    }
  }

  /** Lower-cased (the wire contract), storable and ≤ 32 characters; an unusable value is left out. */
  private serviceTierOf(serviceTier: unknown) {
    if (typeof serviceTier !== 'string') return undefined;

    const trimmed = serviceTier.trim().toLowerCase();

    if (trimmed.length === 0) return undefined;

    const clipped = clipText(trimmed, AI_SPEND_LIMITS.SERVICE_TIER_MAX_LENGTH).trim();

    if (clipped !== trimmed) {
      this.warnOnce('service_tier', `AI Spend: serviceTier is longer than ${AI_SPEND_LIMITS.SERVICE_TIER_MAX_LENGTH} characters or not well-formed text — it was shortened or left out`);
    }

    return clipped.length > 0 ? clipped : undefined;
  }

  /** Whole milliseconds; a value the server cannot store (above 2^31 − 1) is left out — the event is still sent. */
  private latencyOf(latencyMs: unknown) {
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) return undefined;

    const rounded = Math.round(latencyMs);

    if (rounded > AI_SPEND_LIMITS.MAX_LATENCY_MS) {
      this.warnOnce('latency_ms', 'AI Spend: latencyMs is above 2^31 − 1 ms (a timestamp passed by mistake?) — it was left out; the event is still recorded');

      return undefined;
    }

    return rounded;
  }

  private statusOf(status: unknown) {
    return status === AiSpendStatus.ERROR || status === AiSpendStatus.ABORTED ? status : AiSpendStatus.SUCCESS;
  }

  private costOf(usage: AiSpendUsageRecord) {
    const cost = usage.cost;

    if (!cost) return undefined;

    if ((cost.currency ?? 'USD') !== 'USD') {
      this.warnOnce('cost_currency', 'AI Spend: only USD costs are accepted; the explicit cost was dropped (usage is still recorded)');

      return undefined;
    }

    const amount = formatCostAmount(cost.amount);

    if (amount === undefined) {
      this.warnOnce('cost_amount', `AI Spend: cost.amount must be a non-negative decimal below 1,000,000 (at most ${AI_SPEND_LIMITS.COST_MAX_INTEGER_DIGITS} integer digits, e.g. "0.0042" or 0.0042); the explicit cost was dropped`);

      return undefined;
    }

    return { amount, currency: 'USD' as const };
  }

  private rejectLocally(detail: string, eventId: string | undefined) {
    this.delivery?.countRejected(1);
    this.log('warn', `AI Spend: event not recorded — ${detail}`);

    const error = new AiSpendRejectedEventError({ code: AiSpendRejectionCode.INVALID_SCHEMA, detail, eventId });

    try {
      this.onError?.(error);
    } catch {
      // user callback errors are swallowed
    }
  }

  /** `nameCustomer()` input the server would refuse: counted as rejected, warned once per kind, reported to `onError`. */
  private rejectNameLocally(issue: CustomerNameIssue) {
    this.customerNames?.countRejected(1);
    this.warnOnce(`customer_name.${issue.kind}`, `AI Spend: nameCustomer() dropped a name: ${issue.message}`);

    const error = new AiSpendRejectedCustomerNameError({ code: issue.code, detail: issue.message });

    try {
      this.onError?.(error);
    } catch {
      // user callback errors are swallowed
    }
  }

  /** A data-quality warning, once per `key` for the client's lifetime. */
  private warnOnce(key: string, message: string) {
    if (this.warnedOnce.has(key)) return;

    this.warnedOnce.add(key);
    this.log('warn', message);
  }

  private log(level: 'debug' | 'warn', message: string, meta?: Record<string, unknown>) {
    try {
      this.logger[level]?.(message, meta);
    } catch {
      // a broken logger must never break the caller
    }
  }
}

/**
 * Create the AI Spend client. Keep ONE per process (create it at startup, `shutdown()` it
 * on exit). Missing key / browser / `disabled` → a no-op client.
 */
export function createAiSpend(options: AiSpendOptions = {}) {
  const impl = new AiSpendClientImpl(options);
  const internal: AiSpendClientInternal = {
    recordFrom: (adapter, usage, warnKey) => impl.recordFrom(adapter, usage, warnKey),
    assertAttribution: (perCall, ambient) => impl.assertAttribution(perCall, ambient),
    warnOnce: (key, message) => impl.warnOnceFor(key, message),
    debug: (message, meta) => impl.debugFor(message, meta),
    strict: options.strict === true,
  };

  registerInternal(impl, internal);

  const client: AiSpendClient = impl;

  return client;
}

