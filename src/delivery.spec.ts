import { AUTH_PAUSE_MS, AiSpendDelivery, FIELD_WARNING_REPORT_INTERVAL_MS, MIN_RETRY_DELAY_MS, backoffCeilingMs, parseRetryAfter } from './delivery';
import type { AiSpendFetch, AiSpendFetchResponse, AiSpendLogger, DeliveryOptions } from './delivery';
import { AiSpendDeliveryError, AiSpendFieldWarningError, AiSpendRejectedEventError } from './errors';
import type { AiSpendSdkError } from './errors';
import { uuidv7 } from './uuidv7';
import type { AiSpendWireBatch, AiSpendWireEvent } from './wire';

function wireEvent(n: number, padding = 0) {
  const event: AiSpendWireEvent = {
    event_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    provider: 'openai',
    model: 'gpt-5',
    status: 'success',
    usage: { input_tokens: n, output_tokens: 1 },
    ...(padding > 0 ? { tags: { pad: 'x'.repeat(padding) } } : {}),
  };

  return event;
}

function response(status: number, body: unknown = '', headers: Record<string, string> = {}) {
  const res: AiSpendFetchResponse = {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };

  return res;
}

function accepted(batch: AiSpendWireBatch) {
  return response(202, { accepted: batch.events.length, duplicates: 0, rejected: [] });
}

interface Harness {
  delivery: AiSpendDelivery;
  fetch: jest.Mock<ReturnType<AiSpendFetch>, Parameters<AiSpendFetch>>;
  errors: AiSpendSdkError[];
  logger: { debug: jest.Mock; warn: jest.Mock; error: jest.Mock };
  batches: () => AiSpendWireBatch[];
}

function harness(overrides: Partial<DeliveryOptions> = {}, handler?: (batch: AiSpendWireBatch, call: number) => AiSpendFetchResponse | Promise<AiSpendFetchResponse>) {
  const errors: AiSpendSdkError[] = [];
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  let calls = 0;
  const fetch = jest.fn<ReturnType<AiSpendFetch>, Parameters<AiSpendFetch>>(async (_url, init) => {
    const batch = JSON.parse(init.body) as AiSpendWireBatch;

    calls++;

    return handler ? handler(batch, calls) : accepted(batch);
  });
  const delivery = new AiSpendDelivery({
    endpoint: 'https://ingest.test/api/',
    apiKey: 'bfu_test',
    fetch,
    logger: logger as AiSpendLogger,
    onError: (error) => errors.push(error),
    maxQueueSize: 10_000,
    flushIntervalMs: 5_000,
    maxBatchSize: 500,
    maxBatchBytes: 900_000,
    maxRetryMs: 600_000,
    random: () => 0.5,
    ...overrides,
  });
  const result: Harness = {
    delivery,
    fetch,
    errors,
    logger,
    batches: () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body) as AiSpendWireBatch),
  };

  return result;
}

describe('AiSpendDelivery', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 30, 12, 0, 0) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('batching', () => {
    it('flushes on the interval, never synchronously', async () => {
      const h = harness();

      h.delivery.enqueue(wireEvent(1));
      h.delivery.enqueue(wireEvent(2));
      h.delivery.enqueue(wireEvent(3));
      expect(h.fetch).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(4_999);
      expect(h.fetch).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.batches()[0].events).toHaveLength(3);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ queued: 0, sent: 3, accepted: 3 }));
    });

    it('posts JSON to {endpoint}/v1/ai-usage/events with the bearer key', async () => {
      const h = harness();

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();

      const [url, init] = h.fetch.mock.calls[0];

      expect(url).toBe('https://ingest.test/api/v1/ai-usage/events');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual(expect.objectContaining({ authorization: 'Bearer bfu_test', 'content-type': 'application/json' }));
    });

    it('sends as soon as a batch is full (by count), then waits for the interval for the rest', async () => {
      const h = harness({ maxBatchSize: 5 });

      for (let i = 0; i < 12; i++) h.delivery.enqueue(wireEvent(i));

      await jest.advanceTimersByTimeAsync(0);
      expect(h.batches().map((b) => b.events.length)).toEqual([5, 5]);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(h.batches().map((b) => b.events.length)).toEqual([5, 5, 2]);
    });

    it('caps a batch by bytes', async () => {
      const h = harness({ maxBatchBytes: 3_000 });

      for (let i = 0; i < 20; i++) h.delivery.enqueue(wireEvent(i, 500));

      await h.delivery.flush();

      const bodies = h.fetch.mock.calls.map(([, init]) => init.body);

      expect(bodies.length).toBeGreaterThan(3);
      bodies.forEach((body) => expect(Buffer.byteLength(body)).toBeLessThanOrEqual(3_000));
      expect(h.batches().reduce((n, b) => n + b.events.length, 0)).toBe(20);
    });

    it('keeps only ONE request in flight', async () => {
      let release: (() => void) | undefined;
      const h = harness({ maxBatchSize: 2 }, (batch) => new Promise((resolve) => (release = () => resolve(accepted(batch)))));

      for (let i = 0; i < 6; i++) h.delivery.enqueue(wireEvent(i));

      await jest.advanceTimersByTimeAsync(0);
      expect(h.fetch).toHaveBeenCalledTimes(1);

      release?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(h.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('bounded buffer', () => {
    it('drops the OLDEST events at capacity and counts them', async () => {
      const h = harness({ maxQueueSize: 3 });
      const events = Array.from({ length: 5 }, (_, i) => wireEvent(i));

      events.forEach((e) => h.delivery.enqueue(e));
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ queued: 3, dropped: 2 }));

      await h.delivery.flush();
      expect(h.batches()[0].events.map((e) => e.event_id)).toEqual(events.slice(2).map((e) => e.event_id));
    });
  });

  describe('retries', () => {
    it('computes full-jitter ceilings 1 s → 60 s', () => {
      expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffCeilingMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    });

    it('retries 5xx with jittered exponential backoff, keeping event ids stable', async () => {
      const h = harness({ random: () => 0.5 }, (batch, call) => (call <= 3 ? response(503) : accepted(batch)));

      h.delivery.enqueue(wireEvent(1));
      h.delivery.enqueue(wireEvent(2));
      await jest.advanceTimersByTimeAsync(5_000); // attempt 1 → 503, retry in max(0.5 × 1 s, 1 s floor) = 1 s
      expect(h.fetch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(999);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1); // attempt 2 → 503, retry in 0.5 × 2 s = 1 s
      expect(h.fetch).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1_000); // attempt 3 → 503, retry in 0.5 × 4 s = 2 s
      expect(h.fetch).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(h.fetch).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1); // attempt 4 → 202
      expect(h.fetch).toHaveBeenCalledTimes(4);

      const bodies = h.fetch.mock.calls.map(([, init]) => init.body);

      expect(new Set(bodies).size).toBe(1);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ retries: 3, sent: 2, accepted: 2, queued: 0, failedBatches: 0 }));
    });

    it('keeps every delay within [1 s floor, ceiling] (full jitter)', async () => {
      const draws = [0, 0.999999, 0.25, 0.75, 0.5, 0.1, 0.9];
      let i = 0;
      const attemptTimes: number[] = [];
      const h = harness({ random: () => draws[i++ % draws.length] }, () => {
        attemptTimes.push(Date.now());

        return response(500);
      });

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      await jest.advanceTimersByTimeAsync(200_000);

      const gaps = attemptTimes.slice(1).map((t, k) => t - attemptTimes[k]);

      expect(gaps.length).toBeGreaterThanOrEqual(draws.length);
      gaps.slice(0, draws.length).forEach((gap, k) => {
        const ceiling = backoffCeilingMs(k + 1);

        expect(gap).toBeGreaterThanOrEqual(MIN_RETRY_DELAY_MS);
        expect(gap).toBeLessThanOrEqual(Math.max(ceiling, MIN_RETRY_DELAY_MS));
        expect(gap).toBe(Math.max(Math.floor(draws[k] * ceiling), MIN_RETRY_DELAY_MS));
      });
    });

    it('never retries sooner than 1 s — not for Retry-After: 0 nor a past HTTP date', async () => {
      const past = new Date(Date.now() - 60_000).toUTCString();
      const h = harness({ random: () => 0 }, (batch, call) => {
        if (call === 1) return response(429, '', { 'retry-after': '0' });
        if (call === 2) return response(503, '', { 'retry-after': past });

        return accepted(batch);
      });

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      await jest.advanceTimersByTimeAsync(999);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(999);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.fetch).toHaveBeenCalledTimes(3);
    });

    it('clamps a huge Retry-After to the retry budget instead of overflowing setTimeout', async () => {
      const h = harness({ maxRetryMs: 60_000 }, () => response(503, '', { 'retry-after': String(10 ** 10) }));

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      await jest.advanceTimersByTimeAsync(59_999);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1); // last attempt at the budget, then dropped
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 1, failedBatches: 1 }));
    });

    it('honours Retry-After in seconds and as an HTTP date', async () => {
      const retryAt = new Date(Date.now() + 42_000).toUTCString();
      const h = harness({}, (batch, call) => {
        if (call === 1) return response(429, '', { 'retry-after': '7' });
        if (call === 2) return response(503, '', { 'retry-after': retryAt });

        return accepted(batch);
      });

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      expect(h.fetch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(6_999);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.fetch).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(h.fetch).toHaveBeenCalledTimes(3);
    });

    it('parses Retry-After values', () => {
      const now = Date.UTC(2026, 0, 1);

      expect(parseRetryAfter('3', now)).toBe(3_000);
      expect(parseRetryAfter(new Date(now + 10_000).toUTCString(), now)).toBe(10_000);
      expect(parseRetryAfter('soon', now)).toBeUndefined();
      expect(parseRetryAfter(null, now)).toBeUndefined();
    });

    it('drops and counts a batch after maxRetryMs', async () => {
      const h = harness({ maxRetryMs: 60_000, random: () => 0.999 }, () => response(502));

      h.delivery.enqueue(wireEvent(1));
      h.delivery.enqueue(wireEvent(2));
      await h.delivery.flush();
      await jest.advanceTimersByTimeAsync(120_000);

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 2, failedBatches: 1, queued: 0 }));
      expect(h.errors.at(-1)).toBeInstanceOf(AiSpendDeliveryError);
      expect(h.fetch.mock.calls.length).toBeGreaterThan(2);

      const callsAfterDrop = h.fetch.mock.calls.length;

      await jest.advanceTimersByTimeAsync(600_000);
      expect(h.fetch.mock.calls.length).toBe(callsAfterDrop);
    });

    describe('429 that cannot clear within the retry budget', () => {
      const capRefusal = (headers: Record<string, string> = { 'retry-after': '43200' }) =>
        response(429, { code: 'daily_event_cap_exceeded', message: 'This workspace reached its daily limit of 250000 usage events.' }, headers);

      it('drops a batch the daily event cap refused at once — counted, reported with the reset time, never resent', async () => {
        const h = harness({}, () => capRefusal());

        for (let i = 0; i < 3; i++) h.delivery.enqueue(wireEvent(i));
        await h.delivery.flush();

        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 3, failedBatches: 1, retries: 0, queued: 0, sent: 0 }));

        const [error] = h.errors;

        expect(error).toBeInstanceOf(AiSpendDeliveryError);
        expect(error).toEqual(expect.objectContaining({ status: 429, eventCount: 3 }));
        expect(error?.message).toContain('AI Spend dropped 3 events: the workspace reached its daily event cap (HTTP 429 daily_event_cap_exceeded)');
        expect(error?.message).toContain('until the cap resets at 2026-10-01T00:00:00.000Z (the next UTC midnight)');
        expect(h.delivery.stats().lastError).toContain('daily event cap');
        expect(h.logger.warn).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(600_000);
        expect(h.fetch).toHaveBeenCalledTimes(1);
      });

      it('still sends later batches (the cap may be raised): each refused one is dropped and reported, warned once', async () => {
        const h = harness({}, (batch, call) => (call <= 2 ? capRefusal() : accepted(batch)));

        h.delivery.enqueue(wireEvent(1));
        await h.delivery.flush();
        h.delivery.enqueue(wireEvent(2));
        await h.delivery.flush();
        h.delivery.enqueue(wireEvent(3));
        await h.delivery.flush();

        expect(h.fetch).toHaveBeenCalledTimes(3);
        expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 2, failedBatches: 2, sent: 1, accepted: 1 }));
        expect(h.errors.filter((error) => error instanceof AiSpendDeliveryError)).toHaveLength(2);
        expect(h.logger.warn).toHaveBeenCalledTimes(1);
      });

      it('takes the next UTC midnight as the reset when a cap refusal carries no Retry-After', async () => {
        const h = harness({}, () => capRefusal({}));

        h.delivery.enqueue(wireEvent(1));
        await h.delivery.flush();

        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.errors[0]?.message).toContain('2026-10-01T00:00:00.000Z');
      });

      it('retries a 429 whose Retry-After fits the retry budget left', async () => {
        const h = harness({ maxRetryMs: 60_000, random: () => 0 }, (batch, call) => {
          if (call === 1) return response(503);
          // 1 s into the budget: 59 s left.
          if (call === 2) return response(429, '', { 'retry-after': '59' });

          return accepted(batch);
        });

        h.delivery.enqueue(wireEvent(1));
        await h.delivery.flush();
        await jest.advanceTimersByTimeAsync(1_000);
        expect(h.fetch).toHaveBeenCalledTimes(2);

        await jest.advanceTimersByTimeAsync(58_999);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(1);
        expect(h.fetch).toHaveBeenCalledTimes(3);
        expect(h.delivery.stats()).toEqual(expect.objectContaining({ sent: 1, dropped: 0, failedBatches: 0, queued: 0 }));
      });

      it('drops a 429 whose Retry-After is longer than the retry budget left', async () => {
        const h = harness({ maxRetryMs: 60_000, random: () => 0 }, (_batch, call) =>
          call === 1 ? response(503) : response(429, '', { 'retry-after': '60' }),
        );

        h.delivery.enqueue(wireEvent(1));
        await h.delivery.flush();
        await jest.advanceTimersByTimeAsync(1_000);

        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 1, failedBatches: 1, queued: 0 }));
        expect(h.errors[0]?.message).toContain('HTTP 429 with Retry-After 60 s');
        expect(h.errors[0]?.message).toContain("longer than the 59000 ms left of this batch's retry budget (maxRetryMs 60000)");

        await jest.advanceTimersByTimeAsync(120_000);
        expect(h.fetch).toHaveBeenCalledTimes(2);
      });

      it('shutdown() does not wait out a cap refusal', async () => {
        const h = harness({}, () => capRefusal());

        h.delivery.enqueue(wireEvent(1));

        const done = h.delivery.shutdown(5_000);
        let finished = false;

        void done.then(() => (finished = true));
        await jest.advanceTimersByTimeAsync(10);

        expect(finished).toBe(true);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 1, failedBatches: 1, queued: 0 }));
        expect(h.errors).toHaveLength(1);
      });

      it('a batch already dropped by the shutdown deadline is not counted twice when its cap refusal arrives', async () => {
        const h = harness({}, () => new Promise((resolve) => setTimeout(() => resolve(capRefusal()), 3_000)));

        h.delivery.enqueue(wireEvent(1));

        const done = h.delivery.shutdown(1_000);

        await jest.advanceTimersByTimeAsync(1_000);
        await done;
        await jest.advanceTimersByTimeAsync(2_000);

        expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 1, failedBatches: 0, queued: 0 }));
        expect(h.errors).toHaveLength(1);
      });
    });

    it('retries network errors', async () => {
      const h = harness({}, (batch, call) => {
        if (call === 1) throw new TypeError('fetch failed');

        return accepted(batch);
      });

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      expect(h.delivery.stats().lastError).toContain('fetch failed');

      await jest.advanceTimersByTimeAsync(1_000);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ sent: 1, retries: 1 }));
    });
  });

  describe('non-retryable responses', () => {
    it.each([400, 413, 422])('never retries HTTP %i and reports the rejection', async (status) => {
      const h = harness({}, () => response(status, { type: 'about:blank', title: 'Bad', code: 'invalid_schema', detail: 'events[0].model is required' }));

      h.delivery.enqueue(wireEvent(1));
      h.delivery.enqueue(wireEvent(2));
      await h.delivery.flush();
      await jest.advanceTimersByTimeAsync(700_000);

      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ rejected: 2, retries: 0, queued: 0 }));
      expect(h.errors[0]).toBeInstanceOf(AiSpendRejectedEventError);
      expect((h.errors[0] as AiSpendRejectedEventError).code).toBe('invalid_schema');
    });

    it('reports per-event rejections from a 202 body', async () => {
      const h = harness({}, (batch) =>
        response(202, {
          accepted: 1,
          duplicates: 1,
          rejected: [{ index: 2, event_id: batch.events[2].event_id, code: 'invalid_feature', detail: 'feature must be a lowercase dot-path' }],
        }),
      );
      const events = [wireEvent(1), wireEvent(2), wireEvent(3)];

      events.forEach((e) => h.delivery.enqueue(e));
      await h.delivery.flush();

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ sent: 3, accepted: 1, duplicates: 1, rejected: 1 }));
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toEqual(expect.objectContaining({ code: 'invalid_feature', eventId: events[2].event_id, index: 2 }));
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('401/403/404 pause', () => {
    it.each([401, 403])('pauses sending for 5 minutes after HTTP %i with ONE warning, keeps buffering', async (status) => {
      let fail = true;
      const h = harness({}, (batch) => (fail ? response(status, { code: 'feature_not_enabled' }) : accepted(batch)));

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      expect(h.delivery.stats().paused).toBe(true);

      for (let i = 0; i < 3; i++) h.delivery.enqueue(wireEvent(i));
      await h.delivery.flush();
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS - 1);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.delivery.stats().queued).toBe(4);

      await jest.advanceTimersByTimeAsync(1); // pause over → same batch again → 401 again
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.logger.warn).toHaveBeenCalledTimes(1);

      fail = false;
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS);
      await h.delivery.flush();
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ paused: false, sent: 4, queued: 0 }));
    });

    it('an auth outage longer than maxRetryMs loses nothing: the pause never uses up the retry budget', async () => {
      let fail = true;
      const h = harness({}, (batch) => (fail ? response(403, { code: 'feature_disabled' }) : accepted(batch)));

      for (let i = 0; i < 3; i++) h.delivery.enqueue(wireEvent(i));
      await h.delivery.flush();

      // One hour of 403s: 12 pauses, far beyond maxRetryMs (10 min).
      await jest.advanceTimersByTimeAsync(12 * AUTH_PAUSE_MS - 1);
      expect(h.fetch.mock.calls.length).toBeGreaterThanOrEqual(12);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 0, failedBatches: 0, queued: 3, paused: true }));

      fail = false;
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS);
      await h.delivery.flush();
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ sent: 3, accepted: 3, dropped: 0, queued: 0, paused: false }));
    });

    it('pauses on HTTP 404 instead of dropping: ONE warning naming the URL tried, and every buffered event is sent once the endpoint answers', async () => {
      let notFound = true;
      const h = harness({ maxBatchSize: 1 }, (batch) => (notFound ? response(404) : accepted(batch)));

      for (let i = 0; i < 3; i++) h.delivery.enqueue(wireEvent(i));
      await h.delivery.flush();

      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ paused: true, queued: 3, sent: 0, dropped: 0, failedBatches: 0, lastError: 'HTTP 404: sending paused for 5 minutes' }));
      expect(h.logger.warn.mock.calls).toEqual([
        [
          'AI Spend: nothing answers at https://ingest.test/api/v1/ai-usage/events (HTTP 404) — check BLUEFYN_AI_SPEND_ENDPOINT / the endpoint option (the API base, e.g. https://gateway.bluefyn.ai/api); if it is the default, AI Spend ingest is not live at that address yet: email support@bluefyn.ai. Sending is paused for 5 minutes; events keep buffering.',
          undefined,
        ],
      ]);
      expect(h.errors.map((error) => [error.message, (error as AiSpendDeliveryError).status])).toEqual([
        ['AI Spend ingest endpoint not found (HTTP 404): https://ingest.test/api/v1/ai-usage/events', 404],
      ]);

      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS - 1);
      expect(h.fetch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.errors).toHaveLength(2);

      notFound = false;
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS);
      await h.delivery.flush();
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ paused: false, sent: 3, accepted: 3, queued: 0, dropped: 0, failedBatches: 0 }));
      expect(h.batches().map((batch) => batch.events[0].usage?.input_tokens)).toEqual([0, 0, 0, 1, 2]);
    });

    it('keeps the buffer bounded by maxQueueSize while a 404 pauses sending (oldest dropped first)', async () => {
      let notFound = true;
      const h = harness({ maxBatchSize: 1, maxQueueSize: 2 }, (batch) => (notFound ? response(404) : accepted(batch)));

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      for (let i = 2; i <= 6; i++) h.delivery.enqueue(wireEvent(i));

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ paused: true, queued: 3, dropped: 3 }));

      notFound = false;
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS);
      await h.delivery.flush();
      expect(h.batches().slice(1).map((batch) => batch.events[0].usage?.input_tokens)).toEqual([1, 5, 6]);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ sent: 3, queued: 0, dropped: 3 }));
    });

    it('after an auth pause, a later 5xx streak gets a fresh retry budget', async () => {
      const statuses = [401, 503];
      const h = harness({}, (batch, call) => (call === 1 ? response(statuses[0]) : call < 6 ? response(statuses[1]) : accepted(batch)));

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS + 120_000);
      await h.delivery.flush();

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ sent: 1, dropped: 0, failedBatches: 0 }));
    });
  });

  describe('workspace budget signals (202 body)', () => {
    it('counts overflowed_features / dropped_tag_keys in stats() and warns once per kind', async () => {
      const h = harness({}, (batch) => response(202, { accepted: batch.events.length, duplicates: 0, rejected: [], overflowed_features: 2, dropped_tag_keys: 1 }));

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      h.delivery.enqueue(wireEvent(2));
      await h.delivery.flush();

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ overflowedFeatures: 4, droppedTagKeys: 2, accepted: 2 }));
      expect(h.logger.warn.mock.calls.filter(([m]) => (m as string).includes('_overflow'))).toHaveLength(1);
      expect(h.logger.warn.mock.calls.filter(([m]) => (m as string).includes('tag keys'))).toHaveLength(1);
    });

    it('tolerates a server that does not send them (or sends garbage)', async () => {
      const h = harness({}, (batch, call) =>
        response(202, call === 1 ? { accepted: batch.events.length, duplicates: 0, rejected: [] } : { accepted: 1, duplicates: 0, rejected: [], overflowed_features: 'x', dropped_tag_keys: -3 }),
      );

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();
      h.delivery.enqueue(wireEvent(2));
      await h.delivery.flush();

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ overflowedFeatures: 0, droppedTagKeys: 0, accepted: 2 }));
      expect(h.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('field warnings (202 `warnings`)', () => {
    function warned(batch: AiSpendWireBatch, warnings: unknown[]) {
      return response(202, { accepted: batch.events.length, duplicates: 0, rejected: [], warnings, overflowed_features: 0, dropped_tag_keys: 0 });
    }

    it('counts every warning in stats().fieldWarnings and reports once per minute, carrying everything since the last report', async () => {
      const h = harness({}, (batch, call) =>
        call === 3
          ? warned(batch, [])
          : warned(batch, [
              { index: 0, event_id: batch.events[0].event_id, code: 'field_dropped', field: call === 1 ? 'latency_ms' : 'feature', detail: `detail ${call}` },
              { index: 0, code: 'tags_truncated', field: 'tags', detail: 'more than 10 tags' },
            ]),
      );

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ fieldWarnings: 2, accepted: 1, rejected: 0, dropped: 0 }));
      expect(h.errors).toHaveLength(1);
      const first = h.errors[0] as AiSpendFieldWarningError;

      expect(first).toBeInstanceOf(AiSpendFieldWarningError);
      expect(first).toEqual(expect.objectContaining({ count: 2, fields: ['latency_ms', 'tags'], code: 'tags_truncated', field: 'tags', detail: 'more than 10 tags' }));
      // The event id comes from the batch when the server did not echo one.
      expect(first.eventId).toBe(h.batches()[0].events[0].event_id);
      expect(h.logger.warn.mock.calls.filter(([m]) => (m as string).includes('stats().fieldWarnings'))).toHaveLength(1);

      // Within the minute: counted, not reported.
      h.delivery.enqueue(wireEvent(2));
      await h.delivery.flush();
      h.delivery.enqueue(wireEvent(3));
      await h.delivery.flush();
      expect(h.delivery.stats().fieldWarnings).toBe(4);
      expect(h.errors).toHaveLength(1);

      // After the interval, the next warning carries every one since the previous report.
      await jest.advanceTimersByTimeAsync(FIELD_WARNING_REPORT_INTERVAL_MS);
      h.delivery.enqueue(wireEvent(4));
      await h.delivery.flush();

      expect(h.delivery.stats().fieldWarnings).toBe(6);
      expect(h.errors).toHaveLength(2);
      expect(h.errors[1]).toEqual(expect.objectContaining({ count: 4, fields: ['feature', 'tags'] }));
      expect(h.logger.warn.mock.calls.filter(([m]) => (m as string).includes('stats().fieldWarnings'))).toHaveLength(2);
    });

    it('is never a rejection, and tolerates an older server (no warnings) or garbage', async () => {
      const h = harness({}, (batch, call) =>
        call === 1
          ? response(202, { accepted: batch.events.length, duplicates: 0, rejected: [] })
          : response(202, { accepted: batch.events.length, duplicates: 0, rejected: [], warnings: call === 2 ? 'x' : [null, 7] }),
      );

      for (const n of [1, 2, 3]) {
        h.delivery.enqueue(wireEvent(n));
        await h.delivery.flush();
      }

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ fieldWarnings: 0, accepted: 3, rejected: 0 }));
      expect(h.errors).toHaveLength(0);
      expect(h.logger.warn).not.toHaveBeenCalled();
    });

    it('fills in missing warning fields and survives a throwing onError', async () => {
      const h = harness({ onError: () => { throw new TypeError('onError boom'); } }, (batch) => warned(batch, [{}]));

      h.delivery.enqueue(wireEvent(1));
      await h.delivery.flush();

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ fieldWarnings: 1, accepted: 1 }));
      expect(h.logger.warn.mock.calls[0][0]).toContain('unknown on unknown');
    });
  });

  describe('flush / shutdown', () => {
    it('flush() drains everything queued at call time in consecutive batches', async () => {
      const h = harness();

      for (let i = 0; i < 1_200; i++) h.delivery.enqueue(wireEvent(i));

      await h.delivery.flush();
      expect(h.batches().map((b) => b.events.length)).toEqual([500, 500, 200]);
      expect(h.delivery.stats().queued).toBe(0);
    });

    it('flush() never sends before Retry-After / backoff — 5 flushes against Retry-After: 120 = 1 POST', async () => {
      const h = harness({}, (batch, call) => (call === 1 ? response(429, '', { 'retry-after': '120' }) : accepted(batch)));

      h.delivery.enqueue(wireEvent(1));

      for (let i = 0; i < 5; i++) await h.delivery.flush();

      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.delivery.stats().queued).toBe(1);

      await jest.advanceTimersByTimeAsync(120_000);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ queued: 0, sent: 1 }));
    });

    it('REGRESSION: events recorded while a flush()-driven request is in flight are sent without another record()', async () => {
      const h = harness({ flushIntervalMs: 20 }, (batch) => new Promise((resolve) => setTimeout(() => resolve(accepted(batch)), 100)));

      h.delivery.enqueue(wireEvent(1)); // A
      const flushed = h.delivery.flush(); // A in flight for 100 ms

      h.delivery.enqueue(wireEvent(2)); // B — the 20 ms timer fires while A is in flight
      await jest.advanceTimersByTimeAsync(100);
      await flushed;
      expect(h.fetch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(20 + 100);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ queued: 0, sent: 2 }));
    });

    it('shutdown() drains the buffer, stops every timer and ignores later events', async () => {
      const h = harness();

      h.delivery.enqueue(wireEvent(1));
      h.delivery.enqueue(wireEvent(2));
      await h.delivery.shutdown(5_000);

      expect(h.delivery.stats()).toEqual(expect.objectContaining({ sent: 2, queued: 0 }));
      expect(jest.getTimerCount()).toBe(0);

      h.delivery.enqueue(wireEvent(3));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('shutdown() gives up after timeoutMs when the endpoint hangs, counting the batch as dropped', async () => {
      const h = harness({}, () => new Promise<AiSpendFetchResponse>(() => undefined));

      h.delivery.enqueue(wireEvent(1));

      const done = h.delivery.shutdown(2_000);
      let finished = false;

      void done.then(() => (finished = true));
      await jest.advanceTimersByTimeAsync(1_999);
      expect(finished).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 1, queued: 0 }));
    });

    it('shutdown() keeps retrying through 503s until the deadline, then drops with ONE warning + onError', async () => {
      const h = harness({ random: () => 0 }, () => response(503));

      for (let i = 0; i < 3; i++) h.delivery.enqueue(wireEvent(i));

      const done = h.delivery.shutdown(5_000);

      await jest.advanceTimersByTimeAsync(5_000);
      await done;

      expect(h.fetch.mock.calls.length).toBeGreaterThanOrEqual(4); // t=0,1,2,3,4 s
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 3, queued: 0, sent: 0 }));
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.errors.filter((e) => e instanceof AiSpendDeliveryError)).toHaveLength(1);
    });

    it('shutdown() delivers once the endpoint recovers inside the deadline', async () => {
      const h = harness({ random: () => 0 }, (batch, call) => (call === 1 ? response(429, '', { 'retry-after': '2' }) : accepted(batch)));

      h.delivery.enqueue(wireEvent(1));
      h.delivery.enqueue(wireEvent(2));

      const done = h.delivery.shutdown(5_000);

      await jest.advanceTimersByTimeAsync(2_000);
      await done;

      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ sent: 2, dropped: 0, queued: 0 }));
      expect(h.logger.warn).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('shutdown() waits out a 401 pause only until the deadline', async () => {
      const h = harness({}, () => response(401, { code: 'invalid_key' }));

      h.delivery.enqueue(wireEvent(1));

      const done = h.delivery.shutdown(3_000);

      await jest.advanceTimersByTimeAsync(3_000);
      await done;

      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 1, queued: 0 }));
    });

    it('shutdown(0) does not wait: everything queued is counted as dropped', async () => {
      const h = harness();

      h.delivery.enqueue(wireEvent(1));
      h.delivery.enqueue(wireEvent(2));
      await h.delivery.shutdown(0);

      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 2, queued: 0 }));
    });

    it('a batch in flight at the deadline that then succeeds is un-dropped', async () => {
      const h = harness({}, (batch) => new Promise((resolve) => setTimeout(() => resolve(accepted(batch)), 3_000)));

      h.delivery.enqueue(wireEvent(1));

      const done = h.delivery.shutdown(1_000);

      await jest.advanceTimersByTimeAsync(1_000);
      await done;
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 1, sent: 0 }));

      await jest.advanceTimersByTimeAsync(2_000);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 0, sent: 1 }));
    });

    it('counts events recorded after shutdown as dropped (one warning)', async () => {
      const h = harness();

      await h.delivery.shutdown(1_000);
      h.delivery.enqueue(wireEvent(1));
      h.delivery.enqueue(wireEvent(2));

      expect(h.delivery.stats().dropped).toBe(2);
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
    });

    it('shutdown() is idempotent', async () => {
      const h = harness();

      h.delivery.enqueue(wireEvent(1));

      const first = h.delivery.shutdown(1_000);

      expect(h.delivery.shutdown(1_000)).toBe(first);
      await first;
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('warnings', () => {
    it('warns once (not per batch) on an unexpected status such as 405, dropping each batch', async () => {
      const h = harness({ maxBatchSize: 1 }, () => response(405));

      for (let i = 0; i < 3; i++) h.delivery.enqueue(wireEvent(i));

      await h.delivery.flush();

      expect(h.fetch).toHaveBeenCalledTimes(3);
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ dropped: 3, failedBatches: 3 }));
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.errors).toHaveLength(3);
    });

    it('warns once per minute when drop-oldest starts dropping', async () => {
      const h = harness({ maxQueueSize: 2 });

      for (let i = 0; i < 10; i++) h.delivery.enqueue(wireEvent(i));

      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.delivery.stats().dropped).toBe(8);

      await jest.advanceTimersByTimeAsync(60_000);
      h.delivery.enqueue(wireEvent(11));
      h.delivery.enqueue(wireEvent(12));
      h.delivery.enqueue(wireEvent(13));
      expect(h.logger.warn).toHaveBeenCalledTimes(2);
    });

    it('reports overflow drops to onError once per minute, carrying every drop since the last report', async () => {
      const h = harness({ maxQueueSize: 2, flushIntervalMs: 3_600_000 }, () => new Promise<AiSpendFetchResponse>(() => undefined));

      for (let i = 0; i < 10; i++) h.delivery.enqueue(wireEvent(i));

      const overflow = () => h.errors.filter((e) => e instanceof AiSpendDeliveryError && e.message.includes('buffer is full'));

      expect(overflow()).toHaveLength(1);
      expect(overflow()[0]).toEqual(expect.objectContaining({ eventCount: 1 }));

      await jest.advanceTimersByTimeAsync(30_000);
      for (let i = 0; i < 5; i++) h.delivery.enqueue(wireEvent(i));
      expect(overflow()).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(30_000);
      h.delivery.enqueue(wireEvent(99));
      expect(overflow()).toHaveLength(2);
      // 7 more dropped during the first minute (after the first report) + 5 + 1 since.
      expect(overflow()[1]).toEqual(expect.objectContaining({ eventCount: 13 }));
      expect(h.delivery.stats().dropped).toBe(14);
    });
  });

  describe('fault injection — never throws', () => {
    it('survives fetch throwing synchronously, returning garbage, and unreadable bodies', async () => {
      const faults: Array<() => unknown> = [
        () => {
          throw new Error('sync boom');
        },
        () => undefined,
        () => ({ status: 202 }),
        () => ({ status: 202, text: () => Promise.reject(new Error('stream broke')) }),
        () => response(202, '<html>not json</html>'),
        () => response(202, { accepted: 'many' }),
      ];
      let call = 0;
      const fetch = jest.fn(async () => faults[Math.min(call++, faults.length - 1)]() as AiSpendFetchResponse);
      const h = harness({ fetch: fetch as unknown as AiSpendFetch });

      for (let i = 0; i < faults.length; i++) {
        h.delivery.enqueue(wireEvent(i));
        await expect(h.delivery.flush()).resolves.toBeUndefined();
        await jest.advanceTimersByTimeAsync(60_000);
      }

      expect(h.delivery.stats().queued).toBe(0);
      expect(h.delivery.stats().sent).toBeGreaterThan(0);
    });

    it('survives a throwing onError callback and a throwing logger', async () => {
      const throwing = () => {
        throw new Error('user code bug');
      };

      const h = harness(
        { onError: throwing, logger: { debug: throwing, warn: throwing, error: throwing } },
        () => response(400, { code: 'invalid_schema' }),
      );

      h.delivery.enqueue(wireEvent(1));
      await expect(h.delivery.flush()).resolves.toBeUndefined();
      expect(h.delivery.stats().rejected).toBe(1);
    });

    it('survives timer errors', async () => {
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation(() => {
        throw new Error('no timers here');
      });
      const h = harness();

      try {
        expect(() => h.delivery.enqueue(wireEvent(1))).not.toThrow();
        expect(h.delivery.stats().queued).toBe(1);
      } finally {
        spy.mockRestore();
      }

      await h.delivery.flush();
      expect(h.delivery.stats().sent).toBe(1);
    });

    it('counts an event that cannot be serialised as dropped and reports it', () => {
      const h = harness();
      const circular = wireEvent(1) as AiSpendWireEvent & { self?: unknown };

      circular.self = circular;
      expect(() => h.delivery.enqueue(circular)).not.toThrow();
      expect(h.delivery.stats()).toEqual(expect.objectContaining({ queued: 0, dropped: 1 }));
      expect(h.errors[0]).toBeInstanceOf(AiSpendDeliveryError);
    });
  });
});
