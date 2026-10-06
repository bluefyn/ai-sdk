import { AiSpendDeliveryError, AiSpendFieldWarningError, AiSpendRejectedEventError } from './errors';
import type { AiSpendSdkError } from './errors';
import { unrefTimer, utf8Length } from './runtime';
import { isRecord } from './util';
import { AI_SPEND_DEFAULT_ENDPOINT, AI_SPEND_EVENTS_PATH, AI_SPEND_SDK_NAME, AI_SPEND_SDK_VERSION } from './wire';
import type { AiSpendWireEvent, AiSpendWireRejection, AiSpendWireWarning } from './wire';

/**
 * Delivery layer: a bounded in-memory buffer drained in the background by ONE in-flight
 * request at a time. Event ids and `occurred_at` are fixed before an event gets here, each
 * event is serialised once (at enqueue) and a batch's body is built once, so a retry re-sends
 * byte-identical events (the server dedupes on event id). Nothing in this module throws into
 * its caller.
 *
 * The request, status-policy, backoff and deadline helpers below are exported for customer
 * names (`customer-names.ts`), so both deliveries send the same headers and retry, pause and
 * give up by the same rules.
 */

/** Minimal `fetch` the SDK needs (the global `fetch` satisfies it). */
export type AiSpendFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<AiSpendFetchResponse>;

export interface AiSpendFetchResponse {
  status: number;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}

export interface AiSpendLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface AiSpendStats {
  /** Events waiting to be sent (buffered + the batch in flight / awaiting retry). */
  queued: number;
  /** Events in batches the server answered 2xx to. */
  sent: number;
  accepted: number;
  duplicates: number;
  /** Events the server (or the SDK's pre-flight check) refused. */
  rejected: number;
  /**
   * Events lost: buffer overflow (oldest first), a batch abandoned after retries, a batch the
   * daily event cap refused (`429 daily_event_cap_exceeded`, dropped at once), events still
   * undelivered at the `shutdown()` deadline, events recorded after `shutdown()`, and events
   * that could not be serialised.
   */
  dropped: number;
  /** Retry attempts made. */
  retries: number;
  /**
   * Batches abandoned: retries exhausted, a 429 that cannot clear within the retry budget (the
   * daily event cap, or a longer `Retry-After`), or an unexpected non-retryable status.
   */
  failedBatches: number;
  /**
   * Accepted events whose `feature` the server booked under `_overflow`: the workspace already
   * has its maximum number of feature paths (never put ids in feature paths).
   */
  overflowedFeatures: number;
  /** Tags the server dropped from accepted events: the workspace already has its maximum number of tag keys. */
  droppedTagKeys: number;
  /**
   * Invalid attribution / diagnostic fields the server dropped from events it STORED (the `202`
   * `warnings`: `field_dropped`, `tags_truncated`) — usage and cost were kept. Fix the field in
   * later events; never resend. Reported to the logger and `onError` at most once a minute.
   */
  fieldWarnings: number;
  /**
   * Manual `record()` calls whose `usage` had keys the SDK does not know (e.g. `input` instead of
   * `inputTokens` — those values are ignored), or a `success` event with no tokens, no tool
   * requests and no cost (stored unpriced at $0). Warned once per call site; the events are still
   * sent. `strict: true` throws `AiSpendInvalidUsageError` instead.
   */
  invalidUsage: number;
  /**
   * Sending is paused after a 401/403 (the key was refused) or a 404 (nothing answers at the
   * endpoint). Events keep buffering (bounded by `maxQueueSize`) and are sent once the endpoint
   * accepts them again — a pause never uses up a batch's retry budget.
   */
  paused: boolean;
  lastError?: string;
  /** Customer names (`nameCustomer()`); every field above counts events only. */
  customerNames: AiSpendCustomerNameStats;
}

/** Customer-name delivery (`nameCustomer()`), counted apart from events. */
export interface AiSpendCustomerNameStats {
  /** Names waiting to be sent (pending + the request in flight / awaiting retry). */
  queued: number;
  /** Names the server stored, or already had (`named` + `unchanged`). */
  acknowledged: number;
  /** Names the server — or the SDK's own check in `nameCustomer()` — refused. */
  rejected: number;
  /**
   * Names lost: pending names over the cap (oldest first), a request abandoned after retries,
   * names still undelivered at the `shutdown()` deadline, and names reported after `shutdown()`.
   */
  dropped: number;
}

/** What `AiSpendDelivery` counts: `AiSpendStats` without the customer names. */
export type AiSpendEventStats = Omit<AiSpendStats, 'customerNames'>;

export interface DeliveryOptions {
  endpoint: string;
  apiKey: string;
  fetch: AiSpendFetch;
  logger: AiSpendLogger;
  onError: ((error: AiSpendSdkError) => void) | undefined;
  maxQueueSize: number;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxBatchBytes: number;
  maxRetryMs: number;
  requestTimeoutMs?: number;
  /** Called after a request settles with nothing left to send (the natural-exit hold is released). Must not throw. */
  onIdle?: () => void;
  /** Injectable for tests. */
  now?: () => number;
  random?: () => number;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** No retry is ever scheduled sooner than this — not even for `Retry-After: 0` or a past HTTP date. */
export const MIN_RETRY_DELAY_MS = 1_000;
/** How long sending pauses after a 401/403 (the key was refused) or a 404 (nothing answers at the endpoint). */
export const AUTH_PAUSE_MS = 5 * 60_000;
/** `setTimeout` overflows (fires after ~1 ms) above 2^31 − 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** A batch body is `{"events":[` + the events' JSON joined by `,` + `]}` — byte-identical to `JSON.stringify({ events })`. */
const BODY_PREFIX = '{"events":[';
const BODY_SUFFIX = ']}';
/** `{"events":[` (11 bytes) + `]}` (2 bytes). */
const BODY_OVERHEAD_BYTES = BODY_PREFIX.length + BODY_SUFFIX.length;
/** Head-room kept below `maxBatchBytes`, so a batch body never exceeds it. */
const BATCH_SAFETY_MARGIN_BYTES = 64;
/** Buffer-overflow warnings: at most one per this interval. */
export const OVERFLOW_WARN_INTERVAL_MS = 60_000;
/** Field warnings of a `202` (`warnings`): at most one log warning + one `onError` per this interval. */
export const FIELD_WARNING_REPORT_INTERVAL_MS = 60_000;
/** Distinct wire fields remembered between two field-warning reports. */
const MAX_REPORTED_FIELDS = 20;
const NON_RETRYABLE_REJECTIONS = new Set([400, 413, 422]);
const AUTH_FAILURES = new Set([401, 403]);
/**
 * Problem `code` of the 429 the events endpoint answers once the workspace accepted its daily
 * event cap — refused until the next UTC midnight (`Retry-After`), whatever is resent.
 */
export const DAILY_EVENT_CAP_EXCEEDED = 'daily_event_cap_exceeded';
const MS_PER_DAY = 86_400_000;

interface QueuedEvent {
  seq: number;
  eventId: string;
  /** The event serialised ONCE, at enqueue: sized from it, and batch bodies are joined from it. */
  json: string;
  bytes: number;
}

interface Batch {
  /** `event_id` of each event, in body order. */
  eventIds: string[];
  firstSeq: number;
  body: string;
  attempts: number;
  firstAttemptAt: number | undefined;
  /** Earliest next attempt (backoff / `Retry-After` / pause); 0 = now. */
  nextAttemptAt: number;
  /** Already counted as dropped by a shutdown deadline while it was still in flight. */
  abandoned: boolean;
}

/** What one send attempt came to (drives `flush()` / the background drain). */
export const Outcome = {
  IDLE: 'idle',
  WAITING: 'waiting',
  SENT: 'sent',
  REJECTED: 'rejected',
  DROPPED: 'dropped',
  RETRY: 'retry',
  PAUSED: 'paused',
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

/** What an HTTP status means for a request — ONE policy for event batches and customer names. */
export const ResponseClass = {
  SUCCESS: 'success',
  /** 401 / 403: the key was refused — sending pauses for `AUTH_PAUSE_MS`. */
  AUTH_FAILURE: 'auth_failure',
  /** 404: nothing answers at the endpoint (a wrong base URL, or no AI Spend ingest there) — sending pauses for `AUTH_PAUSE_MS`. */
  ENDPOINT_NOT_FOUND: 'endpoint_not_found',
  /** 400 / 413 / 422: the server will never take this body — never retried. */
  REJECTED: 'rejected',
  /** 408 / 429 / 5xx: retried with backoff (an event batch's 429 that cannot clear within its retry budget is dropped at once). */
  RETRYABLE: 'retryable',
  /** Anything else (a redirect, a 405, …): the request is abandoned. */
  UNEXPECTED: 'unexpected',
} as const;
export type ResponseClass = (typeof ResponseClass)[keyof typeof ResponseClass];
export type PauseCause = typeof ResponseClass.AUTH_FAILURE | typeof ResponseClass.ENDPOINT_NOT_FOUND;

export function isPauseCause(kind: ResponseClass): kind is PauseCause {
  return kind === ResponseClass.AUTH_FAILURE || kind === ResponseClass.ENDPOINT_NOT_FOUND;
}

export function endpointNotFoundHint(url: string) {
  return `nothing answers at ${url} (HTTP 404) — check BLUEFYN_AI_SPEND_ENDPOINT / the endpoint option (the API base, e.g. ${AI_SPEND_DEFAULT_ENDPOINT}); if it is the default, AI Spend ingest is not live at that address yet: email support@bluefyn.ai`;
}

/** A request to the ingest API (see `postIngest`). */
export interface IngestRequest {
  fetch: AiSpendFetch;
  /** Endpoint + path. */
  url: string;
  apiKey: string;
  /** Built once per batch, so a retry re-sends it byte for byte. */
  body: string;
  timeoutMs: number;
  now: () => number;
}

/** What `postIngest` resolves with. */
export interface IngestReply {
  status: number;
  /** `Retry-After`, in ms from now. */
  retryAfterMs: number | undefined;
  /** `''` when the body could not be read. */
  bodyText: string;
}

/** A count from a response body: a non-negative integer, else 0. */
function nonNegativeInt(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function noop() {
  // settles a race without caring about the outcome
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;

  return typeof error === 'string' ? error : 'unknown error';
}

/** `Retry-After` as delta-seconds or an HTTP date → milliseconds from `now` (undefined if absent/invalid). */
export function parseRetryAfter(value: string | null | undefined, now: number) {
  if (!value) return undefined;

  const trimmed = value.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }

  const date = Date.parse(trimmed);

  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Full-jitter exponential backoff ceiling for the n-th failed attempt (1-based): 1 s, 2 s, 4 s … capped at 60 s. */
export function backoffCeilingMs(attempt: number) {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** A delay safe to hand to `setTimeout`: finite, ≥ 0, ≤ 2^31 − 1 ms. */
export function timerDelay(ms: number) {
  return Number.isFinite(ms) ? Math.min(Math.max(0, Math.ceil(ms)), MAX_TIMER_DELAY_MS) : MAX_TIMER_DELAY_MS;
}

/**
 * Delay before the next attempt of a failed request: full-jitter backoff for its n-th failed
 * attempt (`random` in [0, 1)), never sooner than `Retry-After` nor `MIN_RETRY_DELAY_MS`, and
 * never past the retry budget left.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined, random: number, remainingMs: number) {
  const jittered = Math.floor(random * backoffCeilingMs(attempt));
  const wanted = Math.max(retryAfterMs ?? 0, jittered, MIN_RETRY_DELAY_MS);

  return timerDelay(Math.min(wanted, remainingMs));
}

/** The `ResponseClass` of an HTTP status. */
export function classifyStatus(status: number) {
  if (status >= 200 && status < 300) return ResponseClass.SUCCESS;
  if (AUTH_FAILURES.has(status)) return ResponseClass.AUTH_FAILURE;
  if (status === 404) return ResponseClass.ENDPOINT_NOT_FOUND;
  if (NON_RETRYABLE_REJECTIONS.has(status)) return ResponseClass.REJECTED;
  if (status === 408 || status === 429 || status >= 500) return ResponseClass.RETRYABLE;

  return ResponseClass.UNEXPECTED;
}

function responseHeader(response: AiSpendFetchResponse, name: string) {
  try {
    return typeof response.headers?.get === 'function' ? response.headers.get(name) : null;
  } catch {
    return null;
  }
}

/** The POST itself, aborted after `timeoutMs` (that timer never keeps the process alive). */
async function post(request: IngestRequest) {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timerDelay(request.timeoutMs)) : undefined;

  unrefTimer(timer);

  try {
    return await request.fetch(request.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${request.apiKey}`,
        'x-bluefyn-sdk': `${AI_SPEND_SDK_NAME}/${AI_SPEND_SDK_VERSION}`,
      },
      body: request.body,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * POST a JSON body to the ingest API with the SDK's headers (bearer key, SDK id) — the same
 * for event batches and customer names. Resolves with the status, `Retry-After` in ms and the
 * body text (an unreadable body reads as `''`); rejects on a network error or timeout.
 */
export async function postIngest(request: IngestRequest) {
  const response = await post(request);
  const status = response.status;
  const retryAfterMs = parseRetryAfter(responseHeader(response, 'retry-after'), request.now());
  const bodyText = await response.text().catch(() => '');
  const reply: IngestReply = { status, retryAfterMs, bodyText };

  return reply;
}

export function parseJsonBody(text: string) {
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `code` of an RFC 7807 problem body (or of its first error), if any. */
export function problemCodeOf(bodyText: string) {
  const body = parseJsonBody(bodyText);

  if (!isRecord(body)) return undefined;
  if (typeof body['code'] === 'string') return body['code'];

  return typeof body['error'] === 'string' ? body['error'] : undefined;
}

/**
 * Resolve when `work` settles or after `delayMs`, whichever is first; never rejects. The timer
 * is ref'd on purpose: `shutdown()` may hold the process until its deadline.
 */
export async function settledOrTimeout(work: Promise<unknown> | undefined, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const expiry = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timerDelay(delayMs));
    });

    await (work ? Promise.race([work.then(noop, noop), expiry]) : expiry);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * FIFO of queued events with O(1) dequeue: a head index advances, and the consumed prefix is
 * dropped in ONE `splice` once it is at least half the array (amortised O(1)). `shift()` would
 * copy the whole array on every call once it is large.
 */
class EventQueue {
  private readonly items: QueuedEvent[] = [];
  private head = 0;

  public get size() {
    return this.items.length - this.head;
  }

  /** The oldest event, if any. */
  public peek() {
    const oldest: QueuedEvent | undefined = this.head < this.items.length ? this.items[this.head] : undefined;

    return oldest;
  }

  public push(item: QueuedEvent) {
    this.items.push(item);
  }

  /** Remove and return the oldest event (undefined when empty). */
  public shift() {
    const oldest = this.peek();

    if (oldest) {
      this.head++;

      if (this.head * 2 >= this.items.length) {
        this.items.splice(0, this.head);
        this.head = 0;
      }
    }

    return oldest;
  }

  public clear() {
    this.items.length = 0;
    this.head = 0;
  }
}

export class AiSpendDelivery {
  private readonly queue = new EventQueue();
  private queuedBytes = 0;
  private seq = 0;
  private pending: Batch | undefined;
  private inFlight: Promise<Outcome> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private kickScheduled = false;
  private pausedUntil = 0;
  /** Pause causes already warned about since the last accepted request: one warning each. */
  private readonly pauseWarned = new Set<PauseCause>();
  private closed = false;
  private closedWarned = false;
  private shutdownPromise: Promise<void> | undefined;
  private lastOverflowWarnAt = Number.NEGATIVE_INFINITY;
  /** Buffer-overflow drops not yet reported to `onError` (reported at most once per interval). */
  private overflowSinceReport = 0;
  private readonly counters = {
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
  };
  private overflowedFeaturesWarned = false;
  private droppedTagKeysWarned = false;
  private lastFieldWarningReportAt = Number.NEGATIVE_INFINITY;
  /** Field warnings not yet reported (reported at most once per `FIELD_WARNING_REPORT_INTERVAL_MS`). */
  private fieldWarningsSinceReport = 0;
  private readonly fieldsSinceReport = new Set<string>();
  private lastError: string | undefined;
  private readonly url: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly warnedRejectionCodes = new Set<string>();
  private readonly warnedStatuses = new Set<number>();
  /** A 429 dropped batches until this time: one warning per refusal window, `onError` for every batch. */
  private rateLimitWarnedUntil = Number.NEGATIVE_INFINITY;

  public constructor(private readonly options: DeliveryOptions) {
    this.url = `${options.endpoint.replace(/\/+$/, '')}${AI_SPEND_EVENTS_PATH}`;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  /** Buffer one event (drop-oldest at capacity). Sends in the background. */
  public enqueue(event: AiSpendWireEvent) {
    try {
      if (this.closed) {
        this.counters.dropped++;

        if (!this.closedWarned) {
          this.closedWarned = true;
          this.log('warn', 'AI Spend: an AI call was recorded after shutdown() — it is dropped (counted in stats().dropped)');
        }

        return;
      }

      let json: string;
      let bytes: number;

      try {
        json = JSON.stringify(event);
        bytes = utf8Length(json);
      } catch (error) {
        this.counters.dropped++;
        this.lastError = `event not serialisable: ${errorMessage(error)}`;
        this.report(new AiSpendDeliveryError('AI Spend dropped an event that cannot be serialised to JSON', { eventCount: 1, cause: error }));

        return;
      }

      this.makeRoom();
      this.seq++;
      this.queue.push({ seq: this.seq, eventId: event.event_id, json, bytes });
      this.queuedBytes += bytes;

      if (this.thresholdReached()) {
        this.kick();
      } else {
        this.schedule(this.options.flushIntervalMs);
      }
    } catch (error) {
      this.internalError('enqueue', error);
    }
  }

  /**
   * Send what is buffered now. Resolves once every event queued at call time was attempted —
   * or earlier, when sending must wait (a pause, backoff, `Retry-After`): `flush()` never
   * sends before the server or the backoff allows it; those events stay queued.
   */
  public async flush() {
    try {
      const target = this.seq;

      for (let guard = 0; guard < 100_000; guard++) {
        if (this.inFlight) {
          await this.inFlight;
          continue;
        }

        const next = this.pending ?? this.queue.peek();

        if (!next || ('firstSeq' in next ? next.firstSeq : next.seq) > target) return;

        const outcome = await this.sendNext();

        if (outcome !== Outcome.SENT && outcome !== Outcome.REJECTED && outcome !== Outcome.DROPPED) return;
      }
    } catch (error) {
      this.internalError('flush', error);
    }
  }

  /**
   * Stop accepting events and deliver what is buffered until `timeoutMs` elapses — retrying
   * through backoff / `Retry-After` / a pause while the deadline allows. Whatever is
   * still undelivered at the deadline is counted as `dropped`, with ONE warning and one
   * `onError`. Idempotent. `timeoutMs: 0` = do not wait.
   */
  public shutdown(timeoutMs: number) {
    if (!this.shutdownPromise) {
      this.closed = true;
      this.clearTimer();
      this.shutdownPromise = this.drainUntil(this.now() + Math.max(0, timeoutMs));
    }

    return this.shutdownPromise;
  }

  public stats() {
    const stats: AiSpendEventStats = {
      queued: this.queue.size + (this.pending?.eventIds.length ?? 0),
      ...this.counters,
      paused: this.pausedUntil > this.now(),
    };

    if (this.lastError !== undefined) {
      stats.lastError = this.lastError;
    }

    return stats;
  }

  /** Count events the SDK refused before they were queued (pre-flight validation). */
  public countRejected(events: number) {
    this.counters.rejected += events;
  }

  /** Count `record()` calls whose usage had unknown keys or was empty (the events are still sent). */
  public countInvalidUsage(events: number) {
    this.counters.invalidUsage += events;
  }

  // ------------------------------------------------------------ buffer

  /**
   * Drop the oldest events until one more fits — counted, with one warning AND one `onError`
   * (carrying every drop since the previous report) per minute.
   */
  private makeRoom() {
    let dropped = 0;

    while (this.queue.size >= this.options.maxQueueSize) {
      const oldest = this.queue.shift();

      if (!oldest) break;

      this.queuedBytes -= oldest.bytes;
      this.counters.dropped++;
      dropped++;
    }

    if (dropped === 0) return;

    this.overflowSinceReport += dropped;

    const now = this.now();

    if (now - this.lastOverflowWarnAt >= OVERFLOW_WARN_INTERVAL_MS) {
      const count = this.overflowSinceReport;

      this.lastOverflowWarnAt = now;
      this.overflowSinceReport = 0;
      this.lastError = `event buffer full: ${count} events dropped`;
      this.log(
        'warn',
        `AI Spend: the event buffer is full (maxQueueSize ${this.options.maxQueueSize}) — dropping the oldest events. Is the ingest endpoint reachable? See stats().dropped.`,
      );
      this.report(
        new AiSpendDeliveryError(`AI Spend dropped ${count} events: the event buffer is full (maxQueueSize ${this.options.maxQueueSize})`, { eventCount: count }),
      );
    }
  }

  private batchByteLimit() {
    return Math.max(BODY_OVERHEAD_BYTES + 1, this.options.maxBatchBytes - BATCH_SAFETY_MARGIN_BYTES);
  }

  private thresholdReached() {
    return (
      this.queue.size >= this.options.maxBatchSize ||
      this.queuedBytes + Math.max(0, this.queue.size - 1) + BODY_OVERHEAD_BYTES >= this.batchByteLimit()
    );
  }

  // ------------------------------------------------------------ scheduling

  /** Send soon, off the caller's stack (a microtask — never synchronously inside `record()`). */
  private kick() {
    if (this.kickScheduled || this.closed) return;

    this.kickScheduled = true;
    void Promise.resolve().then(() => {
      this.kickScheduled = false;
      void this.drain();
    });
  }

  private schedule(delayMs: number) {
    if (this.closed) return;

    const delay = timerDelay(delayMs);
    const dueAt = this.now() + delay;

    if (this.timer !== undefined && this.timerDueAt <= dueAt) return;

    this.clearTimer();

    try {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.timerDueAt = Number.POSITIVE_INFINITY;
        void this.drain();
      }, delay);
      this.timerDueAt = dueAt;
      unrefTimer(this.timer);
    } catch (error) {
      this.timer = undefined;
      this.timerDueAt = Number.POSITIVE_INFINITY;
      this.internalError('schedule', error);
    }
  }

  private clearTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.timerDueAt = Number.POSITIVE_INFINITY;
  }

  /**
   * After every request: make sure what is left is going to be sent without waiting for the
   * next `record()` — the retry/pause time for a pending batch, else now (full batch) or the
   * flush interval.
   */
  private rearm() {
    if (this.closed || this.timer !== undefined) return;

    const now = this.now();

    if (this.pending) {
      this.schedule(Math.max(this.pending.nextAttemptAt, this.pausedUntil) - now);
    } else if (this.queue.size > 0) {
      this.schedule(this.pausedUntil > now ? this.pausedUntil - now : this.thresholdReached() ? 0 : this.options.flushIntervalMs);
    }
  }

  /** Background drain: keep sending while full batches are ready; `rearm()` covers the rest. */
  private async drain() {
    try {
      for (let guard = 0; guard < 10_000; guard++) {
        const outcome = await this.sendNext();
        const progressed = outcome === Outcome.SENT || outcome === Outcome.REJECTED || outcome === Outcome.DROPPED;

        if (progressed && !this.pending && this.thresholdReached()) continue;

        return;
      }
    } catch (error) {
      this.internalError('drain', error);
    }
  }

  /** Shutdown loop: send, wait out backoff / pause while the deadline allows, then give up. */
  private async drainUntil(deadline: number) {
    try {
      for (let guard = 0; guard < 100_000; guard++) {
        const now = this.now();

        if (now >= deadline) break;

        if (this.inFlight) {
          await this.untilDeadline(this.inFlight, deadline);
          continue;
        }

        if (!this.pending && this.queue.size === 0) break;

        const readyAt = Math.max(this.pausedUntil, this.pending?.nextAttemptAt ?? 0);

        if (readyAt > now) {
          await this.untilDeadline(undefined, Math.min(readyAt, deadline));
          continue;
        }

        await this.untilDeadline(this.sendNext(), deadline);
      }
    } catch (error) {
      this.internalError('shutdown', error);
    } finally {
      this.abandonRemaining();
      this.clearTimer();
    }
  }

  /** Resolve when `work` settles or at `deadline`, whichever is first. The timer is ref'd: shutdown may hold the process until its deadline. */
  private async untilDeadline(work: Promise<unknown> | undefined, deadline: number) {
    await settledOrTimeout(work, deadline - this.now());
  }

  /** Shutdown deadline: count everything undelivered as dropped — ONE warning, one `onError`. */
  private abandonRemaining() {
    let count = this.queue.size;

    this.queue.clear();
    this.queuedBytes = 0;

    if (this.pending) {
      count += this.pending.eventIds.length;
      this.pending.abandoned = true;
      this.pending = undefined;
    }

    if (count === 0) return;

    this.counters.dropped += count;
    this.lastError = `shutdown deadline reached with ${count} events undelivered`;
    this.log('warn', `AI Spend: shutdown() timed out with ${count} events undelivered — they are dropped (counted in stats().dropped)`);
    this.report(new AiSpendDeliveryError(`AI Spend dropped ${count} events at shutdown: the deadline was reached before they could be delivered`, { eventCount: count }));
  }

  // ------------------------------------------------------------ sending

  private takeBatch() {
    const eventIds: string[] = [];
    const parts: string[] = [];
    const limit = this.batchByteLimit();
    let bytes = BODY_OVERHEAD_BYTES;
    let head = this.queue.peek();
    const firstSeq = head?.seq ?? this.seq;

    while (head && parts.length < this.options.maxBatchSize) {
      const nextBytes = bytes + head.bytes + (parts.length > 0 ? 1 : 0);

      if (parts.length > 0 && nextBytes > limit) break;

      this.queue.shift();
      this.queuedBytes -= head.bytes;
      eventIds.push(head.eventId);
      parts.push(head.json);
      bytes = nextBytes;
      head = this.queue.peek();
    }

    const batch: Batch = {
      eventIds,
      firstSeq,
      body: BODY_PREFIX + parts.join(',') + BODY_SUFFIX,
      attempts: 0,
      firstAttemptAt: undefined,
      nextAttemptAt: 0,
      abandoned: false,
    };

    return batch;
  }

  /**
   * Attempt the pending (retry) batch or the next batch from the buffer. One request at a
   * time; never before a pause or a batch's backoff / `Retry-After` has elapsed.
   */
  private async sendNext() {
    if (this.inFlight) return Outcome.WAITING;

    const now = this.now();

    if (this.pausedUntil > now) {
      this.schedule(this.pausedUntil - now);

      return Outcome.PAUSED;
    }

    if (this.pending && this.pending.nextAttemptAt > now) {
      this.schedule(this.pending.nextAttemptAt - now);

      return Outcome.WAITING;
    }

    const batch = this.pending ?? (this.queue.size > 0 ? this.takeBatch() : undefined);

    if (!batch) return Outcome.IDLE;

    this.pending = batch;
    this.inFlight = this.attempt(batch);

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
      this.rearm();

      if (!this.pending && this.queue.size === 0) this.notifyIdle();
    }
  }

  private notifyIdle() {
    try {
      this.options.onIdle?.();
    } catch (error) {
      this.internalError('onIdle', error);
    }
  }

  private async attempt(batch: Batch) {
    try {
      const now = this.now();

      batch.attempts++;
      batch.firstAttemptAt ??= now;

      if (batch.attempts > 1) this.counters.retries++;

      let reply: IngestReply;

      try {
        reply = await postIngest({
          fetch: this.options.fetch,
          url: this.url,
          apiKey: this.options.apiKey,
          body: batch.body,
          timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          now: this.now,
        });
      } catch (error) {
        return this.retryOrDrop(batch, undefined, `network error: ${errorMessage(error)}`, error);
      }

      const { status, retryAfterMs, bodyText } = reply;

      if (typeof status !== 'number') return this.retryOrDrop(batch, undefined, 'malformed response from the AI Spend endpoint');

      const kind = classifyStatus(status);

      if (kind === ResponseClass.SUCCESS) return this.onSuccess(batch, bodyText);
      if (isPauseCause(kind)) return this.onPause(batch, kind, status, bodyText);
      if (kind === ResponseClass.REJECTED) return this.onBatchRejected(batch, status, bodyText);
      if (status === 429) return this.onTooManyRequests(batch, status, retryAfterMs, bodyText);
      if (kind === ResponseClass.RETRYABLE) return this.retryOrDrop(batch, retryAfterMs, `HTTP ${status}`, undefined, status);

      const firstTime = !this.warnedStatuses.has(status);

      this.warnedStatuses.add(status);

      return this.abandon(batch, `unexpected HTTP ${status} from the AI Spend endpoint (check the endpoint URL)`, status, firstTime);
    } catch (error) {
      this.internalError('attempt', error);

      return this.retryOrDrop(batch, undefined, `internal error: ${errorMessage(error)}`, error);
    }
  }

  /** The batch is done (success, rejection, drop): forget it unless a shutdown already did. */
  private settle(batch: Batch) {
    if (this.pending === batch) this.pending = undefined;
  }

  private onSuccess(batch: Batch, bodyText: string) {
    const count = batch.eventIds.length;

    this.settle(batch);
    this.counters.sent += count;
    this.pauseWarned.clear();

    if (batch.abandoned) {
      // Delivered after the shutdown deadline had already counted it as dropped.
      this.counters.dropped -= count;
    }

    const body = parseJsonBody(bodyText);

    if (!isRecord(body) || typeof body['accepted'] !== 'number') {
      // A 2xx without a readable body: the server took the batch; per-event outcome unknown.
      this.counters.accepted += count;
      this.log('debug', 'AI Spend: 2xx response without a readable body — counting the batch as accepted', { events: count });

      return Outcome.SENT;
    }

    this.counters.accepted += Math.max(0, Math.round(body['accepted']));
    this.counters.duplicates += typeof body['duplicates'] === 'number' ? Math.max(0, Math.round(body['duplicates'])) : 0;
    this.countBudgetSignals(body);
    this.countFieldWarnings(body, batch);

    const rejected = Array.isArray(body['rejected']) ? body['rejected'].filter(isRecord) : [];

    this.counters.rejected += rejected.length;

    for (const raw of rejected) {
      const rejection = raw as Partial<AiSpendWireRejection>;
      const index = typeof rejection.index === 'number' ? rejection.index : undefined;
      const eventId = typeof rejection.event_id === 'string' ? rejection.event_id : index !== undefined ? batch.eventIds[index] : undefined;
      const code = typeof rejection.code === 'string' ? rejection.code : 'unknown';
      const detail = typeof rejection.detail === 'string' ? rejection.detail : '';

      this.lastError = `event rejected: ${code}`;
      this.log('debug', 'AI Spend: event rejected', { eventId, index, code, detail });

      if (!this.warnedRejectionCodes.has(code) && this.warnedRejectionCodes.size < 50) {
        this.warnedRejectionCodes.add(code);
        this.log('warn', `AI Spend: the server rejected an event (${code}): ${detail} — further "${code}" rejections are reported via onError/debug only`);
      }

      this.report(new AiSpendRejectedEventError({ code, detail, eventId, index }));
    }

    return Outcome.SENT;
  }

  /**
   * The workspace's cardinality budgets (optional `overflowed_features` / `dropped_tag_keys` of a
   * 202 — absent on older servers): counted in `stats()`, one warning per kind.
   */
  private countBudgetSignals(body: Record<string, unknown>) {
    const overflowed = nonNegativeInt(body['overflowed_features']);
    const droppedTags = nonNegativeInt(body['dropped_tag_keys']);

    this.counters.overflowedFeatures += overflowed;
    this.counters.droppedTagKeys += droppedTags;

    if (overflowed > 0 && !this.overflowedFeaturesWarned) {
      this.overflowedFeaturesWarned = true;
      this.log(
        'warn',
        'AI Spend: this workspace has reached its limit of distinct feature paths — events for NEW features are booked under "_overflow" (their cost still counts). Never put ids in feature paths; see stats().overflowedFeatures.',
      );
    }

    if (droppedTags > 0 && !this.droppedTagKeysWarned) {
      this.droppedTagKeysWarned = true;
      this.log(
        'warn',
        'AI Spend: this workspace has reached its limit of distinct tag keys — tags with NEW keys are dropped (the events are still stored). Never put ids in tag keys; see stats().droppedTagKeys.',
      );
    }
  }

  /**
   * Fields dropped from STORED events (the optional `warnings` of a 202 — absent on older
   * servers): counted in `stats().fieldWarnings`, logged at debug one by one, and reported — one
   * warning and one `onError` carrying every warning since the previous report — at most once per
   * `FIELD_WARNING_REPORT_INTERVAL_MS`. Never a rejection: the events must not be resent.
   */
  private countFieldWarnings(body: Record<string, unknown>, batch: Batch) {
    const warnings = Array.isArray(body['warnings']) ? body['warnings'].filter(isRecord) : [];

    if (warnings.length === 0) return;

    let latest: { code: string; field: string; detail: string; eventId: string | undefined } | undefined;

    for (const raw of warnings) {
      const warning = raw as Partial<AiSpendWireWarning>;
      const index = typeof warning.index === 'number' ? warning.index : undefined;
      const eventId = typeof warning.event_id === 'string' ? warning.event_id : index !== undefined ? batch.eventIds[index] : undefined;
      const code = typeof warning.code === 'string' ? warning.code : 'unknown';
      const field = typeof warning.field === 'string' ? warning.field : 'unknown';
      const detail = typeof warning.detail === 'string' ? warning.detail : '';

      this.log('debug', 'AI Spend: a field was dropped from a stored event', { eventId, index, code, field, detail });

      if (this.fieldsSinceReport.size < MAX_REPORTED_FIELDS) this.fieldsSinceReport.add(field);

      latest = { code, field, detail, eventId };
    }

    this.counters.fieldWarnings += warnings.length;
    this.fieldWarningsSinceReport += warnings.length;

    const now = this.now();

    if (!latest || now - this.lastFieldWarningReportAt < FIELD_WARNING_REPORT_INTERVAL_MS) return;

    const count = this.fieldWarningsSinceReport;
    const fields = [...this.fieldsSinceReport];

    this.lastFieldWarningReportAt = now;
    this.fieldWarningsSinceReport = 0;
    this.fieldsSinceReport.clear();
    this.log(
      'warn',
      `AI Spend: the server dropped ${count} invalid field${count === 1 ? '' : 's'} (${fields.join(', ')}) from events it stored — usage and cost were kept, do not resend. Latest: ${latest.code} on ${latest.field}: ${latest.detail}. Fix the field in later events; see stats().fieldWarnings (reported at most once a minute).`,
    );
    this.report(new AiSpendFieldWarningError({ count, fields, ...latest }));
  }

  /**
   * 401 / 403 (the key was refused) and 404 (nothing answers at the endpoint): pause sending for
   * `AUTH_PAUSE_MS` and keep the batch. The pause does NOT use up the batch's retry budget
   * (`maxRetryMs` measures network / 5xx failures only), so events wait out a revoked key, a
   * disabled feature or an endpoint that is not live yet for as long as it lasts — memory stays
   * bounded by `maxQueueSize` (oldest dropped first) and `shutdown()`'s deadline. One warning per
   * cause until a batch is accepted again; `onError` for every refusal.
   */
  private onPause(batch: Batch, kind: PauseCause, status: number, bodyText: string) {
    const now = this.now();
    const code = problemCodeOf(bodyText);
    const answered = `${status}${code ? ` (${code})` : ''}`;
    const notFound = kind === ResponseClass.ENDPOINT_NOT_FOUND;

    this.pausedUntil = now + AUTH_PAUSE_MS;
    this.lastError = `HTTP ${answered}: sending paused for 5 minutes`;

    if (!this.pauseWarned.has(kind)) {
      this.pauseWarned.add(kind);
      this.log(
        'warn',
        notFound
          ? `AI Spend: ${endpointNotFoundHint(this.url)}. Sending is paused for 5 minutes; events keep buffering.`
          : `AI Spend: the ingest endpoint answered ${answered} — check BLUEFYN_AI_SPEND_KEY (a bfu_ ingest key) and that AI Spend is enabled. Sending is paused for 5 minutes; events keep buffering.`,
      );
    }

    this.report(
      new AiSpendDeliveryError(notFound ? `AI Spend ingest endpoint not found (HTTP 404): ${this.url}` : `AI Spend ingest refused the key (HTTP ${status})`, {
        status,
        eventCount: batch.eventIds.length,
      }),
    );

    if (batch.abandoned) return Outcome.DROPPED;

    // A fresh retry budget once the endpoint accepts the batch again.
    batch.firstAttemptAt = undefined;
    batch.nextAttemptAt = this.pausedUntil;
    this.schedule(AUTH_PAUSE_MS);

    return Outcome.PAUSED;
  }

  private onBatchRejected(batch: Batch, status: number, bodyText: string) {
    const count = batch.eventIds.length;
    const problem = parseJsonBody(bodyText);
    const code = problemCodeOf(bodyText) ?? `http_${status}`;
    const detail = isRecord(problem) && typeof problem['detail'] === 'string' ? problem['detail'] : `the server refused the batch with HTTP ${status}`;

    this.settle(batch);

    if (batch.abandoned) {
      this.counters.dropped -= count;
    }

    this.counters.rejected += count;
    this.lastError = `batch rejected: HTTP ${status} (${code})`;
    this.log('warn', `AI Spend: a batch of ${count} events was rejected (HTTP ${status}, ${code}): ${detail}`);
    this.report(new AiSpendRejectedEventError({ code, detail }));

    return Outcome.REJECTED;
  }

  /**
   * 429: retried like any retryable status, unless resending cannot succeed within the batch's
   * retry budget — the workspace's daily event cap (`daily_event_cap_exceeded`: every batch is
   * refused until the next UTC midnight) or a `Retry-After` longer than the budget left. Such a
   * batch is dropped at once (counted in `dropped` and `failedBatches`, reported to `onError`)
   * instead of being resent until `maxRetryMs` runs out only to be refused again. Later batches
   * are still sent, so events flow again as soon as the cap resets or is raised. One warning per
   * refusal window; `onError` for every dropped batch.
   */
  private onTooManyRequests(batch: Batch, status: number, retryAfterMs: number | undefined, bodyText: string) {
    const now = this.now();
    const remainingMs = this.options.maxRetryMs - (now - (batch.firstAttemptAt ?? now));
    const dailyCap = problemCodeOf(bodyText) === DAILY_EVENT_CAP_EXCEEDED;

    if (!dailyCap && (retryAfterMs === undefined || retryAfterMs <= remainingMs)) {
      return this.retryOrDrop(batch, retryAfterMs, `HTTP ${status}`, undefined, status);
    }

    // The cap resets at the next UTC midnight — what the server's `Retry-After` points at.
    const waitMs = retryAfterMs ?? MS_PER_DAY - (now % MS_PER_DAY);
    const retryAt = new Date(now + waitMs).toISOString();
    const reason = dailyCap
      ? `the workspace reached its daily event cap (HTTP 429 ${DAILY_EVENT_CAP_EXCEEDED}) — ingest refuses every batch until the cap resets at ${retryAt} (the next UTC midnight); refused events are not stored. Ask Bluefyn to raise the cap.`
      : `HTTP 429 with Retry-After ${Math.ceil(waitMs / 1000)} s (until ${retryAt}), longer than the ${Math.max(0, remainingMs)} ms left of this batch's retry budget (maxRetryMs ${this.options.maxRetryMs})`;

    if (batch.abandoned) {
      // Already counted (and reported) as dropped by the shutdown deadline.
      this.lastError = reason;

      return Outcome.DROPPED;
    }

    const firstInWindow = now >= this.rateLimitWarnedUntil;

    this.rateLimitWarnedUntil = Math.max(this.rateLimitWarnedUntil, now + waitMs);

    if (!firstInWindow) this.log('debug', 'AI Spend: dropped a batch refused with HTTP 429', { events: batch.eventIds.length, reason });

    return this.abandon(batch, reason, status, firstInWindow);
  }

  /**
   * Retryable failure: back off with full jitter (floored at 1 s, `Retry-After` honoured, never
   * past the retry budget), or drop the batch once `maxRetryMs` has elapsed.
   */
  private retryOrDrop(batch: Batch, retryAfterMs: number | undefined, reason: string, cause?: unknown, status?: number) {
    const now = this.now();
    const elapsed = now - (batch.firstAttemptAt ?? now);

    this.lastError = reason;

    if (batch.abandoned) return Outcome.DROPPED;

    if (elapsed >= this.options.maxRetryMs) {
      return this.abandon(batch, `${reason}; gave up after ${this.options.maxRetryMs} ms`, status, true, cause);
    }

    const delay = retryDelayMs(batch.attempts, retryAfterMs, this.random(), this.options.maxRetryMs - elapsed);

    batch.nextAttemptAt = now + delay;
    this.pending = batch;
    this.log('debug', 'AI Spend: delivery failed, retrying', { reason, attempt: batch.attempts, delayMs: delay });
    this.schedule(delay);

    return Outcome.RETRY;
  }

  private abandon(batch: Batch, reason: string, status?: number, warn = true, cause?: unknown) {
    const count = batch.eventIds.length;

    this.settle(batch);

    if (!batch.abandoned) {
      this.counters.dropped += count;
    }

    this.counters.failedBatches++;
    this.lastError = reason;

    if (warn) {
      this.log('warn', `AI Spend: dropped a batch of ${count} events — ${reason}`);
    }

    this.report(new AiSpendDeliveryError(`AI Spend dropped ${count} events: ${reason}`, { status, eventCount: count, cause }));

    return Outcome.DROPPED;
  }

  // ------------------------------------------------------------ helpers

  private report(error: AiSpendSdkError) {
    const onError = this.options.onError;

    if (!onError) return;

    try {
      onError(error);
    } catch (callbackError) {
      this.log('debug', 'AI Spend: onError callback threw', { error: errorMessage(callbackError) });
    }
  }

  private internalError(where: string, error: unknown) {
    this.lastError = `internal error in ${where}: ${errorMessage(error)}`;
    this.log('debug', `AI Spend: internal error in ${where}`, { error: errorMessage(error) });
  }

  private log(level: 'debug' | 'warn', message: string, meta?: Record<string, unknown>) {
    try {
      this.options.logger[level]?.(message, meta);
    } catch {
      // a broken logger must not break delivery
    }
  }
}
