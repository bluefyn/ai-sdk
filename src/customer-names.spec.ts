import { AiSpendCustomerNames, checkCustomerName } from './customer-names';
import type { CustomerNamesOptions } from './customer-names';
import { AUTH_PAUSE_MS, AiSpendDelivery } from './delivery';
import type { AiSpendFetch, AiSpendFetchResponse, AiSpendLogger } from './delivery';
import { AiSpendDeliveryError, AiSpendRejectedCustomerNameError } from './errors';
import type { AiSpendSdkError } from './errors';
import { uuidv7 } from './uuidv7';
import { AI_SPEND_SDK_NAME, AI_SPEND_SDK_VERSION } from './wire';
import type { AiSpendWireCustomerNamesRequest } from './wire';

function response(status: number, body: unknown = '', headers: Record<string, string> = {}) {
  const res: AiSpendFetchResponse = {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };

  return res;
}

function named(request: AiSpendWireCustomerNamesRequest) {
  return response(200, { named: request.customers.length, unchanged: 0, rejected: [] });
}

function harness(
  overrides: Partial<CustomerNamesOptions> = {},
  handler?: (request: AiSpendWireCustomerNamesRequest, call: number) => AiSpendFetchResponse | Promise<AiSpendFetchResponse>,
) {
  const errors: AiSpendSdkError[] = [];
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  let calls = 0;
  const fetch = jest.fn<ReturnType<AiSpendFetch>, Parameters<AiSpendFetch>>(async (_url, init) => {
    const request = JSON.parse(init.body) as AiSpendWireCustomerNamesRequest;

    calls++;

    return handler ? handler(request, calls) : named(request);
  });
  const names = new AiSpendCustomerNames({
    endpoint: 'https://ingest.test/api/',
    apiKey: 'bfu_test',
    fetch,
    logger: logger as AiSpendLogger,
    onError: (error) => errors.push(error),
    flushIntervalMs: 5_000,
    maxRetryMs: 600_000,
    random: () => 0.5,
    ...overrides,
  });
  const requests = () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body) as AiSpendWireCustomerNamesRequest);
  /** `[customer, display_name]` pairs of each request, in order. */
  const sent = () => requests().map((request) => request.customers.map((entry) => [entry.customer, entry.display_name]));

  return { names, fetch, errors, logger, requests, sent };
}

describe('checkCustomerName', () => {
  it('trims both values and accepts up to 256 characters', () => {
    expect(checkCustomerName('  cus_1 ', '\tAcme Inc.\n')).toEqual({ valid: true, customer: 'cus_1', displayName: 'Acme Inc.' });
    expect(checkCustomerName(` ${'c'.repeat(256)} `, ` ${'n'.repeat(256)} `)).toEqual({ valid: true, customer: 'c'.repeat(256), displayName: 'n'.repeat(256) });
  });

  it.each([
    ['a non-string customer', 'invalid_customer', 'customer_type', 123, 'Acme'],
    ['a missing customer', 'invalid_customer', 'customer_type', undefined, 'Acme'],
    ['a blank customer', 'invalid_customer', 'customer_empty', '   ', 'Acme'],
    ['a 257-character customer', 'invalid_customer', 'customer_too_long', 'c'.repeat(257), 'Acme'],
    ['a customer with a NUL', 'invalid_customer', 'customer_nul', 'cus\u00001', 'Acme'],
    ['an email-like customer', 'customer_email_like', 'customer_email', ' jane.doe@acme.io ', 'Jane Doe'],
    ['a non-string display name', 'invalid_display_name', 'display_name_type', 'cus_1', null],
    ['a blank display name', 'invalid_display_name', 'display_name_empty', 'cus_1', ' \n '],
    ['a 257-character display name', 'invalid_display_name', 'display_name_too_long', 'cus_1', 'n'.repeat(257)],
    ['a display name with a NUL', 'invalid_display_name', 'display_name_nul', 'cus_1', 'Ac\u0000me'],
  ])('refuses %s as %s / %s', (_label, code, kind, customer, displayName) => {
    expect(checkCustomerName(customer, displayName)).toEqual({ valid: false, issue: { code, kind, message: expect.any(String) } });
  });

  it('never echoes the refused value', () => {
    const check = checkCustomerName('jane.doe@acme.io', 'Jane Doe');

    expect(check.valid).toBe(false);
    expect(JSON.stringify(check)).not.toContain('jane.doe');
  });
});

describe('AiSpendCustomerNames', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 2, 12, 0, 0) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('sending', () => {
    it('sends in the background after flushIntervalMs, never synchronously', async () => {
      const h = harness();

      h.names.enqueue('cus_1', 'Acme Inc.');
      h.names.enqueue('cus_2', 'Globex');
      expect(h.fetch).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(4_999);
      expect(h.fetch).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(h.requests()).toEqual([
        {
          customers: [
            { customer: 'cus_1', display_name: 'Acme Inc.' },
            { customer: 'cus_2', display_name: 'Globex' },
          ],
        },
      ]);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 2, rejected: 0, dropped: 0 });
    });

    it('posts to {endpoint}/v1/ai-usage/customers/names with the headers event batches send', async () => {
      const h = harness();
      const eventFetch = jest.fn<ReturnType<AiSpendFetch>, Parameters<AiSpendFetch>>(async () => response(202, { accepted: 1, duplicates: 0, rejected: [] }));
      const delivery = new AiSpendDelivery({
        endpoint: 'https://ingest.test/api/',
        apiKey: 'bfu_test',
        fetch: eventFetch,
        logger: {},
        onError: undefined,
        maxQueueSize: 10,
        flushIntervalMs: 5_000,
        maxBatchSize: 10,
        maxBatchBytes: 900_000,
        maxRetryMs: 600_000,
      });

      delivery.enqueue({ event_id: uuidv7(), occurred_at: new Date().toISOString(), provider: 'openai', model: 'gpt-5', status: 'success' });
      await delivery.flush();
      h.names.enqueue('cus_1', 'Acme Inc.');
      await h.names.flush();

      const [url, init] = h.fetch.mock.calls[0];

      expect(url).toBe('https://ingest.test/api/v1/ai-usage/customers/names');
      expect(init.method).toBe('POST');
      expect(init.signal).toBeDefined();
      expect(init.headers).toEqual(eventFetch.mock.calls[0][1].headers);
      expect(init.headers).toEqual({
        'content-type': 'application/json',
        authorization: 'Bearer bfu_test',
        'x-bluefyn-sdk': `${AI_SPEND_SDK_NAME}/${AI_SPEND_SDK_VERSION}`,
      });
    });

    it('sends at most 100 names per request — at once when 100 are pending', async () => {
      const h = harness();

      for (let i = 0; i < 250; i++) h.names.enqueue(`cus_${i}`, `Customer ${i}`);

      expect(h.fetch).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(0);
      expect(h.requests().map((request) => request.customers.length)).toEqual([100, 100]);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(h.requests().map((request) => request.customers.length)).toEqual([100, 100, 50]);
      expect(h.requests().flatMap((request) => request.customers.map((entry) => entry.customer))).toEqual(Array.from({ length: 250 }, (_, i) => `cus_${i}`));
    });

    it('keeps only ONE request in flight', async () => {
      let release: (() => void) | undefined;
      const h = harness({}, (request) => new Promise((resolve) => (release = () => resolve(named(request)))));

      for (let i = 0; i < 250; i++) h.names.enqueue(`cus_${i}`, 'n');

      await jest.advanceTimersByTimeAsync(0);
      expect(h.fetch).toHaveBeenCalledTimes(1);

      release?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.names.stats()).toEqual(expect.objectContaining({ queued: 150, acknowledged: 100 }));
    });
  });

  describe('dedupe', () => {
    it('skips a name already pending; a newer name replaces the pending one', async () => {
      const h = harness();

      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');
      h.names.enqueue('cus_1', 'Acme Inc.');
      expect(h.names.stats().queued).toBe(2);

      await h.names.flush();
      expect(h.sent()).toEqual([
        [
          ['cus_2', 'Globex'],
          ['cus_1', 'Acme Inc.'],
        ],
      ]);
    });

    it('never re-sends a name the server acknowledged in this process — a rename is sent', async () => {
      const h = harness();

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(h.fetch).toHaveBeenCalledTimes(1);

      h.names.enqueue('cus_1', 'Acme Inc.');
      await h.names.flush();
      h.names.enqueue('cus_1', 'Acme'); // the server now has "Acme Inc."
      await h.names.flush();
      expect(h.sent()).toEqual([[['cus_1', 'Acme']], [['cus_1', 'Acme Inc.']], [['cus_1', 'Acme']]]);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 3, rejected: 0, dropped: 0 });
    });

    it('going back to the acknowledged name cancels a pending rename', async () => {
      const h = harness();

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      h.names.enqueue('cus_1', 'Acme Inc.');
      expect(h.names.stats().queued).toBe(1);

      h.names.enqueue('cus_1', 'Acme');
      expect(h.names.stats().queued).toBe(0);

      await h.names.flush();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it('skips a name that is in flight or awaiting its retry', async () => {
      let release: (() => void) | undefined;
      const h = harness({}, (request, call) => (call === 1 ? new Promise((resolve) => (release = () => resolve(response(503)))) : named(request)));

      h.names.enqueue('cus_1', 'Acme');

      const flushed = h.names.flush();

      h.names.enqueue('cus_1', 'Acme'); // in flight
      expect(h.names.stats().queued).toBe(1);

      release?.();
      await flushed;
      h.names.enqueue('cus_1', 'Acme'); // awaiting its retry
      expect(h.names.stats().queued).toBe(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 0 });
    });

    it('sends a name again after the server rejected it', async () => {
      const h = harness({}, (request, call) =>
        call === 1 ? response(200, { named: 0, unchanged: 0, rejected: [{ index: 0, customer: 'cus_1', code: 'customer_unknown', message: 'no usage yet' }] }) : named(request),
      );

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();

      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 1, dropped: 0 });
    });

    it('forgets the oldest acknowledged names beyond the cap', async () => {
      const h = harness({ maxAcknowledged: 2 });

      h.names.enqueue('cus_a', 'A');
      h.names.enqueue('cus_b', 'B');
      h.names.enqueue('cus_c', 'C');
      await h.names.flush();
      h.names.enqueue('cus_c', 'C');
      h.names.enqueue('cus_a', 'A');
      await h.names.flush();

      expect(h.sent()[1]).toEqual([['cus_a', 'A']]);
    });

    it('remembers 10 000 acknowledged names by default', async () => {
      const h = harness();

      for (let i = 0; i <= 10_000; i++) {
        h.names.enqueue(`cus_${i}`, 'n');

        if (i % 1_000 === 999) await h.names.flush();
      }

      await h.names.flush();

      const before = h.fetch.mock.calls.length;

      h.names.enqueue('cus_10000', 'n');
      h.names.enqueue('cus_1', 'n');
      h.names.enqueue('cus_0', 'n'); // the oldest: forgotten
      await h.names.flush();

      expect(h.names.stats().acknowledged).toBe(10_002);
      expect(h.sent().slice(before)).toEqual([[['cus_0', 'n']]]);
    });
  });

  describe('bounded pending names', () => {
    it('drops the OLDEST pending names at the cap, counts them and warns once per minute', async () => {
      const h = harness({ maxPending: 3 });

      for (let i = 1; i <= 5; i++) h.names.enqueue(`cus_${i}`, `Customer ${i}`);

      expect(h.names.stats()).toEqual({ queued: 3, acknowledged: 0, rejected: 0, dropped: 2 });
      expect(h.logger.warn).toHaveBeenCalledTimes(1);

      await h.names.flush();
      expect(h.requests()[0].customers.map((entry) => entry.customer)).toEqual(['cus_3', 'cus_4', 'cus_5']);

      for (let i = 6; i <= 10; i++) h.names.enqueue(`cus_${i}`, 'n');

      expect(h.logger.warn).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60_000);

      for (let i = 11; i <= 14; i++) h.names.enqueue(`cus_${i}`, 'n');

      expect(h.logger.warn).toHaveBeenCalledTimes(2);
      expect(h.names.stats().dropped).toBe(5);
      await h.names.flush();
    });

    it('holds 1 000 pending names by default', async () => {
      const h = harness();

      for (let i = 0; i <= 1_000; i++) h.names.enqueue(`cus_${i}`, 'n');

      expect(h.names.stats()).toEqual(expect.objectContaining({ queued: 1_000, dropped: 1 }));
      await h.names.flush();
      expect(h.sent()[0][0]).toEqual(['cus_1', 'n']);
    });
  });

  describe('retries', () => {
    it('retries 429 / 5xx with the event-batch backoff, honouring Retry-After and re-sending the same body', async () => {
      const h = harness({ random: () => 0.5 }, (request, call) => {
        if (call === 1) return response(429, '', { 'retry-after': '7' });
        if (call === 2) return response(503);

        return named(request);
      });

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.names.stats().queued).toBe(1);

      await jest.advanceTimersByTimeAsync(6_999);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1); // Retry-After: 7 → attempt 2 → 503, retry in 0.5 × 2 s = 1 s
      expect(h.fetch).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(999);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.fetch).toHaveBeenCalledTimes(3);

      expect(new Set(h.fetch.mock.calls.map(([, init]) => init.body)).size).toBe(1);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 0 });
    });

    it('never retries sooner than 1 s, not even for Retry-After: 0', async () => {
      const h = harness({ random: () => 0 }, (request, call) => (call === 1 ? response(429, '', { 'retry-after': '0' }) : named(request)));

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      await jest.advanceTimersByTimeAsync(999);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries network errors', async () => {
      const h = harness({}, (request, call) => {
        if (call === 1) throw new TypeError('fetch failed');

        return named(request);
      });

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      expect(h.names.stats().queued).toBe(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 0 });
    });

    it('drops and reports the request after maxRetryMs — the names can be reported again', async () => {
      const h = harness({ maxRetryMs: 60_000, random: () => 0.999 }, () => response(502));

      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');
      await h.names.flush();
      await jest.advanceTimersByTimeAsync(120_000);

      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 2 });
      expect(h.errors.at(-1)).toBeInstanceOf(AiSpendDeliveryError);
      expect(h.errors.at(-1)).toEqual(expect.objectContaining({ status: 502, eventCount: 0, customerNameCount: 2 }));

      const calls = h.fetch.mock.calls.length;

      await jest.advanceTimersByTimeAsync(600_000);
      expect(h.fetch.mock.calls.length).toBe(calls);

      h.names.enqueue('cus_1', 'Acme');
      expect(h.names.stats().queued).toBe(1);
      await h.names.shutdown(0);
    });
  });

  describe('non-success responses', () => {
    it.each([401, 403])('pauses names for 5 minutes after HTTP %i with ONE warning; names keep queueing', async (status) => {
      let fail = true;
      const h = harness({}, (request) => (fail ? response(status, { code: 'invalid_key' }) : named(request)));

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      h.names.enqueue('cus_2', 'Globex');
      await h.names.flush();
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS - 1);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.names.stats().queued).toBe(2);

      await jest.advanceTimersByTimeAsync(1); // pause over → the same request again → refused again
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.errors[0]).toEqual(expect.objectContaining({ status, eventCount: 0, customerNameCount: 1 }));

      fail = false;
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS);
      await h.names.flush();
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 2, rejected: 0, dropped: 0 });
    });

    it('an auth outage longer than maxRetryMs loses no names: the pause never uses up the retry budget', async () => {
      let fail = true;
      const h = harness({}, (request) => (fail ? response(403, { code: 'feature_disabled' }) : named(request)));

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      await jest.advanceTimersByTimeAsync(12 * AUTH_PAUSE_MS - 1);
      expect(h.names.stats()).toEqual(expect.objectContaining({ queued: 1, dropped: 0 }));

      fail = false;
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS);
      await h.names.flush();
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 0 });
    });

    it.each([400, 413, 422])('never retries HTTP %i — every name in the request is rejected', async (status) => {
      const h = harness({}, () => response(status, { type: 'about:blank', title: 'Bad', code: 'invalid_schema', detail: 'customers[0].display_name is required' }));

      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');
      await h.names.flush();
      await jest.advanceTimersByTimeAsync(700_000);

      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 0, rejected: 2, dropped: 0 });
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toBeInstanceOf(AiSpendRejectedCustomerNameError);
      expect(h.errors[0]).toEqual(expect.objectContaining({ code: 'invalid_schema', detail: 'customers[0].display_name is required' }));
    });

    it('pauses names on HTTP 404 instead of dropping them: ONE warning naming the URL tried', async () => {
      let notFound = true;
      const h = harness({}, (request) => (notFound ? response(404) : named(request)));

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      h.names.enqueue('cus_2', 'Globex');
      await h.names.flush();

      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.names.stats()).toEqual({ queued: 2, acknowledged: 0, rejected: 0, dropped: 0 });
      expect(h.logger.warn.mock.calls).toEqual([
        [
          'AI Spend: nothing answers at https://ingest.test/api/v1/ai-usage/customers/names (HTTP 404) — check BLUEFYN_AI_SPEND_ENDPOINT / the endpoint option (the API base, e.g. https://gateway.bluefyn.ai/api); if it is the default, AI Spend ingest is not live at that address yet: email support@bluefyn.ai. Sending names is paused for 5 minutes; names keep queueing.',
          undefined,
        ],
      ]);
      expect(h.errors.map((error) => error.message)).toEqual(['AI Spend customer-names endpoint not found (HTTP 404): https://ingest.test/api/v1/ai-usage/customers/names']);

      notFound = false;
      await jest.advanceTimersByTimeAsync(AUTH_PAUSE_MS);
      await h.names.flush();
      expect(h.sent()).toEqual([[['cus_1', 'Acme']], [['cus_1', 'Acme']], [['cus_2', 'Globex']]]);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 2, rejected: 0, dropped: 0 });
    });

    it('abandons a request on an unexpected status such as 405, warning once', async () => {
      const h = harness({}, () => response(405));

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      h.names.enqueue('cus_2', 'Globex');
      await h.names.flush();

      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 2 });
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.errors).toEqual([expect.any(AiSpendDeliveryError), expect.any(AiSpendDeliveryError)]);
    });
  });

  describe('2xx responses', () => {
    it('acknowledges named + unchanged entries and reports each rejected one, warning once per code', async () => {
      const h = harness({}, (request, call) =>
        call === 1
          ? response(200, { named: 1, unchanged: 1, rejected: [{ index: 2, customer: 'cus_3', code: 'invalid_schema', message: 'display_name is too long' }] })
          : response(200, { named: 0, unchanged: 0, rejected: request.customers.map((entry, index) => ({ index, customer: entry.customer, code: 'invalid_schema', message: 'still no' })) }),
      );

      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');
      h.names.enqueue('cus_3', 'Initech');
      await h.names.flush();

      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 2, rejected: 1, dropped: 0 });
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toBeInstanceOf(AiSpendRejectedCustomerNameError);
      expect(h.errors[0]).toEqual(expect.objectContaining({ code: 'invalid_schema', customer: 'cus_3', index: 2, detail: 'display_name is too long' }));
      expect(h.logger.warn).toHaveBeenCalledTimes(1);

      // Acknowledged names are not sent again; the rejected one is — and its code does not warn twice.
      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');
      h.names.enqueue('cus_3', 'Initech');
      await h.names.flush();

      expect(h.sent()[1]).toEqual([['cus_3', 'Initech']]);
      expect(h.errors).toHaveLength(2);
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
    });

    it('locates a rejection without a usable index by its customer', async () => {
      const h = harness({}, () => response(200, { named: 1, unchanged: 0, rejected: [{ index: 99, customer: 'cus_2', code: 'customer_unknown', message: 'unknown customer' }] }));

      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');
      await h.names.flush();

      expect(h.errors[0]).toEqual(expect.objectContaining({ customer: 'cus_2', index: 1 }));
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 1, dropped: 0 });

      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');
      expect(h.names.stats().queued).toBe(1);
      await h.names.flush();
    });

    it('treats a 2xx it cannot read as acknowledged — the server stored the names — warning once', async () => {
      const h = harness({}, () => response(200, '<html>ok</html>'));

      h.names.enqueue('cus_1', 'Acme');
      await h.names.flush();
      h.names.enqueue('cus_2', 'Globex');
      await h.names.flush();
      h.names.enqueue('cus_1', 'Acme');

      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 2, rejected: 0, dropped: 0 });
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('flush / shutdown', () => {
    it('flush() sends every name pending at call time, in requests of ≤ 100', async () => {
      const h = harness();

      for (let i = 0; i < 250; i++) h.names.enqueue(`cus_${i}`, 'n');

      await h.names.flush();
      expect(h.requests().map((request) => request.customers.length)).toEqual([100, 100, 50]);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 250, rejected: 0, dropped: 0 });
    });

    it('flush() never sends before Retry-After — 5 flushes against Retry-After: 120 = 1 POST', async () => {
      const h = harness({}, (request, call) => (call === 1 ? response(429, '', { 'retry-after': '120' }) : named(request)));

      h.names.enqueue('cus_1', 'Acme');

      for (let i = 0; i < 5; i++) await h.names.flush();

      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.names.stats().queued).toBe(1);

      await jest.advanceTimersByTimeAsync(120_000);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 0 });
    });

    it('shutdown() delivers what is pending, stops every timer and drops names reported later (one warning)', async () => {
      const h = harness();

      h.names.enqueue('cus_1', 'Acme');
      await h.names.shutdown(5_000);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 0 });
      expect(jest.getTimerCount()).toBe(0);

      h.names.enqueue('cus_2', 'Globex');
      h.names.enqueue('cus_3', 'Initech');
      await jest.advanceTimersByTimeAsync(60_000);

      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.names.stats().dropped).toBe(2);
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('shutdown() gives up at the deadline when the endpoint hangs — ONE warning, one onError', async () => {
      const h = harness({}, () => new Promise<AiSpendFetchResponse>(() => undefined));

      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');

      const done = h.names.shutdown(2_000);
      let finished = false;

      void done.then(() => (finished = true));
      await jest.advanceTimersByTimeAsync(1_999);
      expect(finished).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);

      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 2 });
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(h.errors).toEqual([expect.any(AiSpendDeliveryError)]);
      expect(h.errors[0]).toEqual(expect.objectContaining({ eventCount: 0, customerNameCount: 2 }));
    });

    it('shutdown() keeps retrying through 503s until the deadline', async () => {
      const h = harness({ random: () => 0 }, () => response(503));

      h.names.enqueue('cus_1', 'Acme');

      const done = h.names.shutdown(5_000);

      await jest.advanceTimersByTimeAsync(5_000);
      await done;

      expect(h.fetch.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 1 });
    });

    it('shutdown(0) does not wait: everything pending is dropped', async () => {
      const h = harness();

      h.names.enqueue('cus_1', 'Acme');
      h.names.enqueue('cus_2', 'Globex');
      await h.names.shutdown(0);

      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 2 });
    });

    it('a request in flight at the deadline that then succeeds is un-dropped', async () => {
      const h = harness({}, (request) => new Promise((resolve) => setTimeout(() => resolve(named(request)), 3_000)));

      h.names.enqueue('cus_1', 'Acme');

      const done = h.names.shutdown(1_000);

      await jest.advanceTimersByTimeAsync(1_000);
      await done;
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 1 });

      await jest.advanceTimersByTimeAsync(2_000);
      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 0 });
    });

    it('shutdown() is idempotent', async () => {
      const h = harness();

      h.names.enqueue('cus_1', 'Acme');

      const first = h.names.shutdown(1_000);

      expect(h.names.shutdown(1_000)).toBe(first);
      await first;
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('fault injection — never throws', () => {
    it('survives fetch throwing synchronously, garbage responses and unreadable bodies', async () => {
      const faults: Array<() => unknown> = [
        () => {
          throw new Error('sync boom');
        },
        () => undefined,
        () => ({ status: 200 }),
        () => ({ status: 200, text: () => Promise.reject(new Error('stream broke')) }),
        () => response(200, { named: 'many', rejected: 'none' }),
        () => response(200, { named: 0, unchanged: 0, rejected: [null, 7, { index: 'x' }, { index: -1 }] }),
      ];
      let call = 0;
      const fetch = jest.fn(() => {
        const fault = faults[Math.min(call++, faults.length - 1)];

        return Promise.resolve(fault() as AiSpendFetchResponse);
      });
      const h = harness({ fetch: fetch as unknown as AiSpendFetch });

      for (let i = 0; i < faults.length; i++) {
        expect(() => h.names.enqueue(`cus_${i}`, 'n')).not.toThrow();
        await expect(h.names.flush()).resolves.toBeUndefined();
        await jest.advanceTimersByTimeAsync(60_000);
      }

      const stats = h.names.stats();

      expect(stats.queued).toBe(0);
      expect(stats.acknowledged + stats.rejected).toBe(faults.length);
    });

    it('survives a throwing onError callback and a throwing logger', async () => {
      const throwing = () => {
        throw new Error('user code bug');
      };

      const h = harness({ onError: throwing, logger: { debug: throwing, warn: throwing, error: throwing }, maxPending: 1 }, (request, call) =>
        call === 1 ? response(400, { code: 'invalid_schema' }) : response(200, { named: 0, unchanged: 0, rejected: [{ index: 0, customer: request.customers[0].customer, code: 'x', message: 'y' }] }),
      );

      h.names.enqueue('cus_1', 'Acme');
      await expect(h.names.flush()).resolves.toBeUndefined();
      expect(() => h.names.enqueue('cus_2', 'Globex')).not.toThrow();
      expect(() => h.names.enqueue('cus_3', 'Initech')).not.toThrow(); // overflow warning through a throwing logger
      await expect(h.names.flush()).resolves.toBeUndefined();

      expect(h.names.stats()).toEqual({ queued: 0, acknowledged: 0, rejected: 2, dropped: 1 });
    });

    it('survives timer errors', async () => {
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation(() => {
        throw new Error('no timers here');
      });
      const h = harness();

      try {
        expect(() => h.names.enqueue('cus_1', 'Acme')).not.toThrow();
        expect(h.names.stats().queued).toBe(1);
      } finally {
        spy.mockRestore();
      }

      await h.names.flush();
      expect(h.names.stats().acknowledged).toBe(1);
    });
  });
});
