import { looksLikeEmail } from './attribution';
import {
  AUTH_PAUSE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  OVERFLOW_WARN_INTERVAL_MS,
  Outcome,
  ResponseClass,
  classifyStatus,
  endpointNotFoundHint,
  errorMessage,
  isPauseCause,
  parseJsonBody,
  postIngest,
  problemCodeOf,
  retryDelayMs,
  settledOrTimeout,
  timerDelay,
} from './delivery';
import type { AiSpendCustomerNameStats, AiSpendFetch, AiSpendLogger, IngestReply, PauseCause } from './delivery';
import { AiSpendDeliveryError, AiSpendRejectedCustomerNameError } from './errors';
import type { AiSpendSdkError } from './errors';
import { unrefTimer } from './runtime';
import { isRecord } from './util';
import { AI_SPEND_CUSTOMER_NAMES_PATH, AI_SPEND_LIMITS } from './wire';
import type { AiSpendWireCustomerNameRejection, AiSpendWireCustomerNamesRequest } from './wire';

/**
 * Customer names: `nameCustomer(customer, displayName)` reports the human-readable name of a
 * customer id ONCE, apart from usage events (which never carry names). Pending names wait in a
 * bounded map — one entry per customer, a newer name replacing a pending one — drained in the
 * background by ONE in-flight request at a time, independent of event batches: a stuck names
 * request never delays events, and vice versa. Headers, retries, `Retry-After`, the pause
 * and the shutdown deadline follow the event-batch policy exactly (the helpers are shared with
 * `delivery.ts`). A name that is pending, in flight or was acknowledged in this process is not
 * sent again. Nothing in this module throws into its caller.
 */

export interface CustomerNamesOptions {
  endpoint: string;
  apiKey: string;
  fetch: AiSpendFetch;
  logger: AiSpendLogger;
  onError: ((error: AiSpendSdkError) => void) | undefined;
  /** How long the first pending name waits for company before a request goes out (the client's `flushIntervalMs`). */
  flushIntervalMs: number;
  maxRetryMs: number;
  requestTimeoutMs?: number;
  /** Called after a request settles with nothing left to send (the natural-exit hold is released). Must not throw. */
  onIdle?: () => void;
  /** Pending names before the oldest is dropped. Default 1 000. */
  maxPending?: number;
  /** Acknowledged names remembered to skip repeats (oldest forgotten first). Default 10 000. */
  maxAcknowledged?: number;
  /** Injectable for tests. */
  now?: () => number;
  random?: () => number;
}

/** A `nameCustomer()` input the server would refuse. Never echoes the value (it may be PII). */
export interface CustomerNameIssue {
  /** `code` of the `AiSpendRejectedCustomerNameError` it is reported as. */
  code: string;
  /** Warned about once per kind, e.g. `customer_too_long`. */
  kind: string;
  message: string;
}

export type CustomerNameCheck = { valid: true; customer: string; displayName: string } | { valid: false; issue: CustomerNameIssue };

const DEFAULT_MAX_PENDING = 1_000;
const DEFAULT_MAX_ACKNOWLEDGED = 10_000;
/** Distinct server rejection codes warned about (each once); the rest go to onError / debug only. */
const MAX_WARNED_REJECTION_CODES = 50;

/** `code` of a name `nameCustomer()` refused before sending. */
const LocalRejection = {
  INVALID_CUSTOMER: 'invalid_customer',
  CUSTOMER_EMAIL_LIKE: 'customer_email_like',
  INVALID_DISPLAY_NAME: 'invalid_display_name',
} as const;

interface PendingName {
  displayName: string;
  /** Enqueue order: `flush()` sends what was pending when it was called. */
  seq: number;
}

interface NameBatch {
  /** customer → display name, in body order. */
  names: Map<string, string>;
  firstSeq: number;
  body: string;
  attempts: number;
  firstAttemptAt: number | undefined;
  /** Earliest next attempt (backoff / `Retry-After` / pause); 0 = now. */
  nextAttemptAt: number;
  /** Already counted as dropped by a shutdown deadline while it was still in flight. */
  abandoned: boolean;
}

function issueOf(code: string, kind: string, message: string) {
  const issue: CustomerNameIssue = { code, kind, message };

  return issue;
}

/** The trimmed value — or why the server would refuse it (it wants 1…`maxLength` characters, no NUL). */
function trimmedText(value: unknown, field: 'customer' | 'displayName', maxLength: number, code: string) {
  const kind = field === 'customer' ? 'customer' : 'display_name';

  if (typeof value !== 'string') return issueOf(code, `${kind}_type`, `${field} must be a string`);
  if (value.includes('\u0000')) return issueOf(code, `${kind}_nul`, `${field} contains a NUL character`);

  const trimmed = value.trim();

  if (trimmed.length === 0) return issueOf(code, `${kind}_empty`, `${field} is empty`);
  if (trimmed.length > maxLength) return issueOf(code, `${kind}_too_long`, `${field} is longer than ${maxLength} characters`);

  return trimmed;
}

/**
 * Validate `nameCustomer()` input the way the server does: both values trimmed; `customer`
 * 1–256 characters and never email-like (it is the opaque id AI calls are attributed to),
 * `displayName` 1–256 characters; no NUL in either.
 */
export function checkCustomerName(customer: unknown, displayName: unknown) {
  const id = trimmedText(customer, 'customer', AI_SPEND_LIMITS.CUSTOMER_MAX_LENGTH, LocalRejection.INVALID_CUSTOMER);
  const name = trimmedText(displayName, 'displayName', AI_SPEND_LIMITS.CUSTOMER_NAME_MAX_LENGTH, LocalRejection.INVALID_DISPLAY_NAME);
  let check: CustomerNameCheck;

  if (typeof id !== 'string') {
    check = { valid: false, issue: id };
  } else if (looksLikeEmail(id)) {
    check = {
      valid: false,
      issue: issueOf(LocalRejection.CUSTOMER_EMAIL_LIKE, 'customer_email', 'customer looks like an email address — pass the opaque id your AI calls are attributed to, never PII'),
    };
  } else if (typeof name !== 'string') {
    check = { valid: false, issue: name };
  } else {
    check = { valid: true, customer: id, displayName: name };
  }

  return check;
}

function nameCount(count: number) {
  return `${count} customer name${count === 1 ? '' : 's'}`;
}

export class AiSpendCustomerNames {
  /** Names waiting to be sent, one per customer, oldest first (`Map` insertion order). */
  private readonly pending = new Map<string, PendingName>();
  /** Names the server acknowledged in this process, oldest first: repeats are not sent again. */
  private readonly acknowledged = new Map<string, string>();
  private seq = 0;
  /** The request in flight or awaiting its retry. */
  private batch: NameBatch | undefined;
  private inFlight: Promise<Outcome> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private kickScheduled = false;
  private pausedUntil = 0;
  /** Pause causes already warned about since the last accepted request: one warning each. */
  private readonly pauseWarned = new Set<PauseCause>();
  private unreadableWarned = false;
  private closed = false;
  private closedWarned = false;
  private shutdownPromise: Promise<void> | undefined;
  private lastOverflowWarnAt = Number.NEGATIVE_INFINITY;
  private readonly counters = { acknowledged: 0, rejected: 0, dropped: 0 };
  private readonly url: string;
  private readonly maxPending: number;
  private readonly maxAcknowledged: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly warnedRejectionCodes = new Set<string>();
  private readonly warnedStatuses = new Set<number>();

  public constructor(private readonly options: CustomerNamesOptions) {
    this.url = `${options.endpoint.replace(/\/+$/, '')}${AI_SPEND_CUSTOMER_NAMES_PATH}`;
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
    this.maxAcknowledged = Math.max(1, options.maxAcknowledged ?? DEFAULT_MAX_ACKNOWLEDGED);
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  /**
   * Queue one name (already validated — see `checkCustomerName`) unless it is what is pending,
   * in flight or acknowledged for that customer. A newer name replaces a pending one. Sends in
   * the background.
   */
  public enqueue(customer: string, displayName: string) {
    try {
      if (this.closed) {
        this.counters.dropped++;

        if (!this.closedWarned) {
          this.closedWarned = true;
          this.log('warn', 'AI Spend: nameCustomer() was called after shutdown() — the name is dropped (counted in stats().customerNames.dropped)');
        }

        return;
      }

      const queued = this.pending.get(customer);

      if (queued?.displayName === displayName) return;

      // A newer name goes to the back of the queue — or cancels the pending change when it is
      // what the server already has (or is being sent).
      if (queued) this.pending.delete(customer);
      if (this.lastSent(customer) === displayName) return;

      this.makeRoom();
      this.seq++;
      this.pending.set(customer, { displayName, seq: this.seq });

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
   * Send the names pending now. Resolves once every name queued at call time was attempted — or
   * earlier, when sending must wait (a pause, backoff, `Retry-After`); those names stay queued.
   */
  public async flush() {
    try {
      const target = this.seq;

      for (let guard = 0; guard < 100_000; guard++) {
        if (this.inFlight) {
          await this.inFlight;
          continue;
        }

        const nextSeq = this.batch?.firstSeq ?? this.oldestPending()?.seq;

        if (nextSeq === undefined || nextSeq > target) return;

        const outcome = await this.sendNext();

        if (outcome !== Outcome.SENT && outcome !== Outcome.REJECTED && outcome !== Outcome.DROPPED) return;
      }
    } catch (error) {
      this.internalError('flush', error);
    }
  }

  /**
   * Stop accepting names and deliver what is pending until `timeoutMs` elapses — retrying
   * through backoff / `Retry-After` / a pause while the deadline allows. Names still
   * undelivered then are counted as dropped, with ONE warning and one `onError`. Idempotent.
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
    const stats: AiSpendCustomerNameStats = {
      queued: this.pending.size + (this.batch?.names.size ?? 0),
      ...this.counters,
    };

    return stats;
  }

  /** Count names the SDK refused before they were queued (`checkCustomerName`). */
  public countRejected(names: number) {
    this.counters.rejected += names;
  }

  // ------------------------------------------------------------ pending names

  private oldestPending() {
    const oldest = this.pending.values().next();

    return oldest.done ? undefined : oldest.value;
  }

  /** The name the server has for `customer` as far as this process knows: being sent, else acknowledged. */
  private lastSent(customer: string) {
    return this.batch?.names.get(customer) ?? this.acknowledged.get(customer);
  }

  /** Drop the oldest pending names until one more fits (counted; one warning per minute). */
  private makeRoom() {
    let dropped = 0;

    for (const customer of this.pending.keys()) {
      if (this.pending.size < this.maxPending) break;

      this.pending.delete(customer);
      dropped++;
    }

    if (dropped === 0) return;

    this.counters.dropped += dropped;

    const now = this.now();

    if (now - this.lastOverflowWarnAt >= OVERFLOW_WARN_INTERVAL_MS) {
      this.lastOverflowWarnAt = now;
      this.log(
        'warn',
        `AI Spend: ${this.maxPending} customer names are already waiting to be sent — dropping the oldest. Is the ingest endpoint reachable? See stats().customerNames.dropped.`,
      );
    }
  }

  /** Remember acknowledged names (most recent last), forgetting the oldest beyond the cap. */
  private acknowledge(names: Array<[string, string]>) {
    for (const [customer, displayName] of names) {
      this.acknowledged.delete(customer);
      this.acknowledged.set(customer, displayName);
    }

    for (const customer of this.acknowledged.keys()) {
      if (this.acknowledged.size <= this.maxAcknowledged) break;

      this.acknowledged.delete(customer);
    }
  }

  private thresholdReached() {
    return this.pending.size >= AI_SPEND_LIMITS.MAX_CUSTOMER_NAMES_PER_REQUEST;
  }

  // ------------------------------------------------------------ scheduling

  /** Send soon, off the caller's stack (a microtask — never synchronously inside `nameCustomer()`). */
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

  /** After every request: make sure what is left goes out without waiting for the next `nameCustomer()`. */
  private rearm() {
    if (this.closed || this.timer !== undefined) return;

    const now = this.now();

    if (this.batch) {
      this.schedule(Math.max(this.batch.nextAttemptAt, this.pausedUntil) - now);
    } else if (this.pending.size > 0) {
      this.schedule(this.pausedUntil > now ? this.pausedUntil - now : this.thresholdReached() ? 0 : this.options.flushIntervalMs);
    }
  }

  /** Background drain: keep sending while full requests are ready; `rearm()` covers the rest. */
  private async drain() {
    try {
      for (let guard = 0; guard < 10_000; guard++) {
        const outcome = await this.sendNext();
        const progressed = outcome === Outcome.SENT || outcome === Outcome.REJECTED || outcome === Outcome.DROPPED;

        if (progressed && !this.batch && this.thresholdReached()) continue;

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
          await settledOrTimeout(this.inFlight, deadline - now);
          continue;
        }

        if (!this.batch && this.pending.size === 0) break;

        const readyAt = Math.max(this.pausedUntil, this.batch?.nextAttemptAt ?? 0);

        if (readyAt > now) {
          await settledOrTimeout(undefined, Math.min(readyAt, deadline) - now);
          continue;
        }

        await settledOrTimeout(this.sendNext(), deadline - now);
      }
    } catch (error) {
      this.internalError('shutdown', error);
    } finally {
      this.abandonRemaining();
      this.clearTimer();
    }
  }

  /** Shutdown deadline: count every undelivered name as dropped — ONE warning, one `onError`. */
  private abandonRemaining() {
    let count = this.pending.size;

    this.pending.clear();

    if (this.batch) {
      count += this.batch.names.size;
      this.batch.abandoned = true;
      this.batch = undefined;
    }

    if (count === 0) return;

    this.counters.dropped += count;
    this.log('warn', `AI Spend: shutdown() timed out with ${nameCount(count)} undelivered — dropped (counted in stats().customerNames.dropped)`);
    this.report(
      new AiSpendDeliveryError(`AI Spend dropped ${nameCount(count)} at shutdown: the deadline was reached before they could be delivered`, {
        eventCount: 0,
        customerNameCount: count,
      }),
    );
  }

  // ------------------------------------------------------------ sending

  private takeBatch() {
    const names = new Map<string, string>();
    let firstSeq = this.seq;

    for (const [customer, queued] of this.pending) {
      if (names.size >= AI_SPEND_LIMITS.MAX_CUSTOMER_NAMES_PER_REQUEST) break;
      if (names.size === 0) firstSeq = queued.seq;

      names.set(customer, queued.displayName);
    }

    for (const customer of names.keys()) {
      this.pending.delete(customer);
    }

    const request: AiSpendWireCustomerNamesRequest = {
      customers: [...names].map(([customer, displayName]) => ({ customer, display_name: displayName })),
    };
    const batch: NameBatch = {
      names,
      firstSeq,
      body: JSON.stringify(request),
      attempts: 0,
      firstAttemptAt: undefined,
      nextAttemptAt: 0,
      abandoned: false,
    };

    return batch;
  }

  /**
   * Attempt the request awaiting retry, or the next one from the pending names. One request at
   * a time; never before a pause or the request's backoff / `Retry-After` has elapsed.
   */
  private async sendNext() {
    if (this.inFlight) return Outcome.WAITING;

    const now = this.now();

    if (this.pausedUntil > now) {
      this.schedule(this.pausedUntil - now);

      return Outcome.PAUSED;
    }

    if (this.batch && this.batch.nextAttemptAt > now) {
      this.schedule(this.batch.nextAttemptAt - now);

      return Outcome.WAITING;
    }

    const batch = this.batch ?? (this.pending.size > 0 ? this.takeBatch() : undefined);

    if (!batch) return Outcome.IDLE;

    this.batch = batch;
    this.inFlight = this.attempt(batch);

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
      this.rearm();

      if (!this.batch && this.pending.size === 0) this.notifyIdle();
    }
  }

  private notifyIdle() {
    try {
      this.options.onIdle?.();
    } catch (error) {
      this.internalError('onIdle', error);
    }
  }

  private async attempt(batch: NameBatch) {
    try {
      batch.attempts++;
      batch.firstAttemptAt ??= this.now();

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
      if (kind === ResponseClass.REJECTED) return this.onRequestRejected(batch, status, bodyText);
      if (kind === ResponseClass.RETRYABLE) return this.retryOrDrop(batch, retryAfterMs, `HTTP ${status}`, undefined, status);

      const firstTime = !this.warnedStatuses.has(status);

      this.warnedStatuses.add(status);

      return this.abandon(batch, `unexpected HTTP ${status} from the AI Spend customer-names endpoint (check the endpoint URL)`, status, firstTime);
    } catch (error) {
      this.internalError('attempt', error);

      return this.retryOrDrop(batch, undefined, `internal error: ${errorMessage(error)}`, error);
    }
  }

  /** The request is done (success, rejection, drop): forget it unless a shutdown already did. */
  private settle(batch: NameBatch) {
    if (this.batch === batch) this.batch = undefined;
  }

  /** 2xx: every entry not in `rejected` was stored or already known (`named` / `unchanged`). */
  private onSuccess(batch: NameBatch, bodyText: string) {
    const count = batch.names.size;
    const entries = [...batch.names];

    this.settle(batch);
    this.pauseWarned.clear();

    if (batch.abandoned) {
      // Delivered after the shutdown deadline had already counted it as dropped.
      this.counters.dropped -= count;
    }

    const body = parseJsonBody(bodyText);

    if (!isRecord(body) || !Array.isArray(body['rejected'])) {
      // The server took the request but its answer is unreadable: it stored the names.
      this.counters.acknowledged += count;
      this.acknowledge(entries);

      if (!this.unreadableWarned) {
        this.unreadableWarned = true;
        this.log('warn', 'AI Spend: the customer-names endpoint answered 2xx without a readable body — the names are counted as acknowledged');
      }

      return Outcome.SENT;
    }

    const refused = new Set<number>();
    let rejected = 0;

    for (const raw of body['rejected'].filter(isRecord)) {
      if (rejected >= count) break;

      const rejection = raw as Partial<AiSpendWireCustomerNameRejection>;
      const index = this.entryIndex(rejection, entries);

      if (index !== undefined) {
        if (refused.has(index)) continue;

        refused.add(index);
      }

      rejected++;
      this.onNameRejected(rejection, index === undefined ? undefined : entries[index][0], index);
    }

    // Each entry lands in exactly one bucket, even when the server reported a rejection it did not locate.

    this.counters.rejected += rejected;
    this.counters.acknowledged += count - rejected;
    this.acknowledge(entries.filter((_, index) => !refused.has(index)));

    return Outcome.SENT;
  }

  /** The entry a rejection is about: its `index` when valid, else the entry with its `customer`. */
  private entryIndex(rejection: Partial<AiSpendWireCustomerNameRejection>, entries: Array<[string, string]>) {
    const index = rejection.index;

    if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < entries.length) return index;
    if (typeof rejection.customer !== 'string') return undefined;

    const found = entries.findIndex(([customer]) => customer === rejection.customer);

    return found >= 0 ? found : undefined;
  }

  /** `customer` is the matched entry's id (else the server's echo, if any); it goes to onError only, never to the log. */
  private onNameRejected(rejection: Partial<AiSpendWireCustomerNameRejection>, customer: string | undefined, index: number | undefined) {
    const code = typeof rejection.code === 'string' && rejection.code.length > 0 ? rejection.code : 'unknown';
    const detail = typeof rejection.message === 'string' ? rejection.message : '';
    const echoed = typeof rejection.customer === 'string' ? rejection.customer : undefined;

    this.log('debug', 'AI Spend: customer name rejected', { index, code, detail });
    this.warnRejection(code, `AI Spend: the server rejected a customer name (${code}): ${detail}`);
    this.report(new AiSpendRejectedCustomerNameError({ code, detail, customer: customer ?? echoed, index }));
  }

  /** 401 / 403 / 404: pause, keep the request — the pause never uses up its retry budget (like event batches). */
  private onPause(batch: NameBatch, kind: PauseCause, status: number, bodyText: string) {
    const now = this.now();
    const code = problemCodeOf(bodyText);
    const notFound = kind === ResponseClass.ENDPOINT_NOT_FOUND;

    this.pausedUntil = now + AUTH_PAUSE_MS;

    if (!this.pauseWarned.has(kind)) {
      this.pauseWarned.add(kind);
      this.log(
        'warn',
        notFound
          ? `AI Spend: ${endpointNotFoundHint(this.url)}. Sending names is paused for 5 minutes; names keep queueing.`
          : `AI Spend: the customer-names endpoint answered ${status}${code ? ` (${code})` : ''} — check BLUEFYN_AI_SPEND_KEY (a bfu_ ingest key) and that AI Spend is enabled. Sending names is paused for 5 minutes; names keep queueing.`,
      );
    }

    this.report(
      new AiSpendDeliveryError(
        notFound ? `AI Spend customer-names endpoint not found (HTTP 404): ${this.url}` : `AI Spend ingest refused the key for customer names (HTTP ${status})`,
        { status, eventCount: 0, customerNameCount: batch.names.size },
      ),
    );

    if (batch.abandoned) return Outcome.DROPPED;

    // A fresh retry budget once the endpoint accepts the request again.
    batch.firstAttemptAt = undefined;
    batch.nextAttemptAt = this.pausedUntil;
    this.schedule(AUTH_PAUSE_MS);

    return Outcome.PAUSED;
  }

  /** 400 / 413 / 422: the server will never take this request — every name in it is rejected. */
  private onRequestRejected(batch: NameBatch, status: number, bodyText: string) {
    const count = batch.names.size;
    const problem = parseJsonBody(bodyText);
    const code = problemCodeOf(bodyText) ?? `http_${status}`;
    const detail = isRecord(problem) && typeof problem['detail'] === 'string' ? problem['detail'] : `the server refused the request with HTTP ${status}`;

    this.settle(batch);

    if (batch.abandoned) {
      this.counters.dropped -= count;
    }

    this.counters.rejected += count;
    this.warnRejection(code, `AI Spend: a request of ${nameCount(count)} was rejected (HTTP ${status}, ${code}): ${detail}`);
    this.report(new AiSpendRejectedCustomerNameError({ code, detail }));

    return Outcome.REJECTED;
  }

  /**
   * Retryable failure: the event-batch backoff exactly (full jitter, floored at 1 s, `Retry-After`
   * honoured, never past the retry budget) — or drop the request once `maxRetryMs` has elapsed.
   */
  private retryOrDrop(batch: NameBatch, retryAfterMs: number | undefined, reason: string, cause?: unknown, status?: number) {
    const now = this.now();
    const elapsed = now - (batch.firstAttemptAt ?? now);

    if (batch.abandoned) return Outcome.DROPPED;

    if (elapsed >= this.options.maxRetryMs) {
      return this.abandon(batch, `${reason}; gave up after ${this.options.maxRetryMs} ms`, status, true, cause);
    }

    const delay = retryDelayMs(batch.attempts, retryAfterMs, this.random(), this.options.maxRetryMs - elapsed);

    batch.nextAttemptAt = now + delay;
    this.batch = batch;
    this.log('debug', 'AI Spend: customer-names delivery failed, retrying', { reason, attempt: batch.attempts, delayMs: delay });
    this.schedule(delay);

    return Outcome.RETRY;
  }

  private abandon(batch: NameBatch, reason: string, status?: number, warn = true, cause?: unknown) {
    const count = batch.names.size;

    this.settle(batch);

    if (!batch.abandoned) {
      this.counters.dropped += count;
    }

    if (warn) {
      this.log('warn', `AI Spend: dropped ${nameCount(count)} — ${reason}`);
    }

    this.report(new AiSpendDeliveryError(`AI Spend dropped ${nameCount(count)}: ${reason}`, { status, eventCount: 0, customerNameCount: count, cause }));

    return Outcome.DROPPED;
  }

  // ------------------------------------------------------------ helpers

  /** One warning per rejection code (the rest reach onError / debug only). */
  private warnRejection(code: string, message: string) {
    if (this.warnedRejectionCodes.has(code) || this.warnedRejectionCodes.size >= MAX_WARNED_REJECTION_CODES) return;

    this.warnedRejectionCodes.add(code);
    this.log('warn', `${message} — further "${code}" rejections are reported via onError/debug only`);
  }

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
    this.log('debug', `AI Spend: internal error in customer names ${where}`, { error: errorMessage(error) });
  }

  private log(level: 'debug' | 'warn', message: string, meta?: Record<string, unknown>) {
    try {
      this.options.logger[level]?.(message, meta);
    } catch {
      // a broken logger must not break delivery
    }
  }
}
