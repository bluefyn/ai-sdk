import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAiSpend, formatCostAmount, normalizeEndpoint } from './client';
import type { AiSpendOptions } from './client';
import type { AiSpendFetch, AiSpendFetchResponse } from './delivery';
import { AiSpendAttributionError, AiSpendDeliveryError, AiSpendInvalidUsageError, AiSpendRejectedCustomerNameError, AiSpendRejectedEventError, AiSpendUsageIssueCode } from './errors';
import type { AiSpendSdkError } from './errors';
import { eventIdFrom } from './event-id';
import { internalOf } from './internal';
import { fromOpenAIChatUsage } from './normalize';
import { AI_SPEND_API_KEY_ENV, AI_SPEND_CUSTOMER_NAMES_PATH, AI_SPEND_DEFAULT_ENDPOINT, AI_SPEND_ENDPOINT_ENV, AI_SPEND_EVENTS_PATH, AI_SPEND_SDK_NAME, AI_SPEND_SDK_VERSION } from './wire';
import type { AiSpendUsageRecord, AiSpendWireBatch, AiSpendWireCustomerName, AiSpendWireCustomerNamesRequest, AiSpendWireEvent } from './wire';

/** The ingest API taking everything: events → 202 all accepted, customer names → 200 all named. */
function ingestReply(url: string, body: string) {
  if (url.endsWith(AI_SPEND_CUSTOMER_NAMES_PATH)) {
    const request = JSON.parse(body) as AiSpendWireCustomerNamesRequest;
    const reply: AiSpendFetchResponse = { status: 200, text: async () => JSON.stringify({ named: request.customers.length, unchanged: 0, rejected: [] }) };

    return reply;
  }

  const batch = JSON.parse(body) as AiSpendWireBatch;
  const reply: AiSpendFetchResponse = { status: 202, text: async () => JSON.stringify({ accepted: batch.events.length, duplicates: 0, rejected: [] }) };

  return reply;
}

function setup(options: AiSpendOptions = {}) {
  const events: AiSpendWireEvent[] = [];
  const names: AiSpendWireCustomerName[] = [];
  const errors: AiSpendSdkError[] = [];
  const fetch = jest.fn<ReturnType<AiSpendFetch>, Parameters<AiSpendFetch>>(async (url, init) => {
    if (url.endsWith(AI_SPEND_CUSTOMER_NAMES_PATH)) {
      names.push(...(JSON.parse(init.body) as AiSpendWireCustomerNamesRequest).customers);
    } else {
      events.push(...(JSON.parse(init.body) as AiSpendWireBatch).events);
    }

    return ingestReply(url, init.body);
  });
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = createAiSpend({ apiKey: 'bfu_test', fetch, logger, warnOnMissingAttribution: false, onError: (e) => errors.push(e), ...options });

  return { client, events, names, errors, fetch, logger };
}

/** An ingest API whose `stuckPath` never answers (everything else is taken). */
function stuckAt(stuckPath: string) {
  return jest.fn<ReturnType<AiSpendFetch>, Parameters<AiSpendFetch>>(async (url, init) =>
    url.endsWith(stuckPath) ? new Promise<AiSpendFetchResponse>(() => undefined) : ingestReply(url, init.body),
  );
}

describe('createAiSpend', () => {
  const savedKey = process.env[AI_SPEND_API_KEY_ENV];
  const savedEndpoint = process.env[AI_SPEND_ENDPOINT_ENV];

  // A developer shell with BLUEFYN_AI_SPEND_ENDPOINT set must not change what these specs post to.
  beforeEach(() => {
    delete process.env[AI_SPEND_ENDPOINT_ENV];
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env[AI_SPEND_API_KEY_ENV];
    else process.env[AI_SPEND_API_KEY_ENV] = savedKey;

    if (savedEndpoint === undefined) delete process.env[AI_SPEND_ENDPOINT_ENV];
    else process.env[AI_SPEND_ENDPOINT_ENV] = savedEndpoint;
  });

  describe('endpoint', () => {
    const CUSTOM_BASE = 'https://gateway.example.com/api';

    async function postedUrls(options: AiSpendOptions) {
      const { client, fetch, logger } = setup(options);

      client.record({ provider: 'openai', model: 'gpt-5', feature: 'chat', customer: 'cus_1', usage: { inputTokens: 1 } });
      client.nameCustomer('cus_1', 'Acme Inc.');
      await client.flush();
      await client.shutdown();

      return { urls: fetch.mock.calls.map(([url]) => url).sort(), warnings: logger.warn.mock.calls.map(([message]) => String(message)) };
    }

    function expectedUrls(base: string) {
      return [`${base}${AI_SPEND_CUSTOMER_NAMES_PATH}`, `${base}${AI_SPEND_EVENTS_PATH}`];
    }

    it('posts to the production base by default, without warnings', async () => {
      const { urls, warnings } = await postedUrls({});

      expect(urls).toEqual(expectedUrls(AI_SPEND_DEFAULT_ENDPOINT));
      expect(warnings).toEqual([]);
    });

    it('uses a configured base as is', async () => {
      const { urls, warnings } = await postedUrls({ endpoint: `${CUSTOM_BASE}/` });

      expect(urls).toEqual(expectedUrls(CUSTOM_BASE));
      expect(warnings).toEqual([]);
    });

    it('strips a pasted /v1 base (the public-API docs base) with ONE warning, so the path is not doubled', async () => {
      const { urls, warnings } = await postedUrls({ endpoint: `${CUSTOM_BASE}/v1` });

      expect(urls).toEqual(expectedUrls(CUSTOM_BASE));
      expect(urls.some((url) => url.includes('/v1/v1/'))).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('without /v1');
      expect(warnings[0]).toContain(CUSTOM_BASE);
    });

    it('strips a pasted full events URL back to the base', async () => {
      const { urls, warnings } = await postedUrls({ endpoint: `${CUSTOM_BASE}${AI_SPEND_EVENTS_PATH}` });

      expect(urls).toEqual(expectedUrls(CUSTOM_BASE));
      expect(warnings).toHaveLength(1);
    });

    it('reads the base from BLUEFYN_AI_SPEND_ENDPOINT when no option is given', async () => {
      process.env[AI_SPEND_ENDPOINT_ENV] = CUSTOM_BASE;

      const { urls, warnings } = await postedUrls({});

      expect(urls).toEqual(expectedUrls(CUSTOM_BASE));
      expect(warnings).toEqual([]);
    });

    it('normalises the environment value too, naming the variable in the warning', async () => {
      process.env[AI_SPEND_ENDPOINT_ENV] = `${CUSTOM_BASE}/v1/`;

      const { urls, warnings } = await postedUrls({});

      expect(urls).toEqual(expectedUrls(CUSTOM_BASE));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(AI_SPEND_ENDPOINT_ENV);
    });

    it('prefers the endpoint option over the environment', async () => {
      process.env[AI_SPEND_ENDPOINT_ENV] = 'https://elsewhere.example/api';

      const { urls } = await postedUrls({ endpoint: CUSTOM_BASE });

      expect(urls).toEqual(expectedUrls(CUSTOM_BASE));
    });

    it('never throws on a bad endpoint: blank or non-string counts as not given, a bare /v1 falls back to the default', async () => {
      process.env[AI_SPEND_ENDPOINT_ENV] = CUSTOM_BASE;

      expect((await postedUrls({ endpoint: '   ' })).urls).toEqual(expectedUrls(CUSTOM_BASE));
      expect((await postedUrls({ endpoint: 42 as unknown as string })).urls).toEqual(expectedUrls(CUSTOM_BASE));

      delete process.env[AI_SPEND_ENDPOINT_ENV];

      const bare = await postedUrls({ endpoint: '/v1' });

      expect(bare.urls).toEqual(expectedUrls(AI_SPEND_DEFAULT_ENDPOINT));
      expect(bare.warnings).toHaveLength(1);
    });

    it('does not warn about the endpoint when the client is disabled', () => {
      delete process.env[AI_SPEND_API_KEY_ENV];

      const logger = { warn: jest.fn() };

      createAiSpend({ endpoint: `${CUSTOM_BASE}/v1`, logger });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain(AI_SPEND_API_KEY_ENV);
    });
  });

  describe('normalizeEndpoint', () => {
    it.each([
      ['https://gateway.bluefyn.ai/api', 'https://gateway.bluefyn.ai/api', false],
      ['  https://gateway.bluefyn.ai/api//  ', 'https://gateway.bluefyn.ai/api', false],
      ['https://gateway.bluefyn.ai/api/v1', 'https://gateway.bluefyn.ai/api', true],
      ['https://gateway.bluefyn.ai/api/V1/', 'https://gateway.bluefyn.ai/api', true],
      ['https://gateway.bluefyn.ai/api/v1/ai-usage/events', 'https://gateway.bluefyn.ai/api', true],
      ['https://gateway.bluefyn.ai/api/v1/ai-usage/customers/names', 'https://gateway.bluefyn.ai/api', true],
      ['https://gateway.bluefyn.ai/apiv1', 'https://gateway.bluefyn.ai/apiv1', false],
      ['https://gateway.bluefyn.ai/api/v10', 'https://gateway.bluefyn.ai/api/v10', false],
    ])('%s → %s', (raw, endpoint, trimmed) => {
      expect(normalizeEndpoint(raw)).toEqual({ endpoint, trimmed });
    });
  });

  it('keeps AI_SPEND_SDK_VERSION equal to package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { name: string; version: string };

    expect(AI_SPEND_SDK_VERSION).toBe(pkg.version);
    expect(AI_SPEND_SDK_NAME).toBe(pkg.name);
  });

  describe('disabled clients', () => {
    it('disables itself with ONE warning when no key is configured', async () => {
      delete process.env[AI_SPEND_API_KEY_ENV];

      const logger = { warn: jest.fn() };
      const fetch = jest.fn();
      const client = createAiSpend({ logger, fetch: fetch as unknown as AiSpendFetch });

      client.record({ provider: 'openai', model: 'gpt-5' });
      client.record({ provider: 'openai', model: 'gpt-5' });
      await client.flush();
      await client.shutdown();

      expect(client.enabled).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain(AI_SPEND_API_KEY_ENV);
      expect(fetch).not.toHaveBeenCalled();
      expect(client.stats()).toEqual(expect.objectContaining({ queued: 0, sent: 0, dropped: 0 }));
    });

    it('reads the key from BLUEFYN_AI_SPEND_KEY', () => {
      process.env[AI_SPEND_API_KEY_ENV] = 'bfu_from_env';

      expect(createAiSpend({ fetch: jest.fn() as unknown as AiSpendFetch, logger: {} }).enabled).toBe(true);
    });

    it('refuses to run in a browser', () => {
      const g = globalThis as Record<string, unknown>;
      const logger = { warn: jest.fn() };

      g['window'] = {};
      g['document'] = {};

      try {
        const client = createAiSpend({ apiKey: 'bfu_test', logger, fetch: jest.fn() as unknown as AiSpendFetch });

        expect(client.enabled).toBe(false);
        expect(logger.warn.mock.calls[0][0]).toContain('browser');
      } finally {
        delete g['window'];
        delete g['document'];
      }
    });

    it('is silent when explicitly disabled', () => {
      const logger = { warn: jest.fn() };

      expect(createAiSpend({ disabled: true, logger }).enabled).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('record() usage checks (plain-JavaScript callers)', () => {
    const unknownKeyWarnings = (warn: jest.Mock) => warn.mock.calls.map(([m]) => m as string).filter((m) => m.includes('unknown key'));
    const emptyWarnings = (warn: jest.Mock) => warn.mock.calls.map(([m]) => m as string).filter((m) => m.includes('no tokens, no tool requests and no cost'));

    it('warns once per call site about unknown usage keys, naming the canonical key meant — and still sends the event, counted in stats().invalidUsage', async () => {
      const { client, events, logger } = setup();
      const recordWrong = () => client.record({ provider: 'openai', model: 'gpt-5', usage: { input: 1_000, output: 100 } as never });

      recordWrong();
      recordWrong();
      await client.flush();

      const warnings = unknownKeyWarnings(logger.warn);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"input" (did you mean inputTokens?)');
      expect(warnings[0]).toContain('"output" (did you mean outputTokens?)');
      expect(warnings[0]).toContain('inputTokens, cachedInputTokens, cacheWrite5mTokens, cacheWrite1hTokens, outputTokens, reasoningTokens, toolRequests');
      expect(warnings[0]).toContain('client.spec.ts');
      expect(emptyWarnings(logger.warn)).toHaveLength(1); // nothing billable was left either
      expect(events).toHaveLength(2);
      expect(events[0].usage).toEqual(expect.objectContaining({ input_tokens: 0, output_tokens: 0 }));
      expect(client.stats().invalidUsage).toBe(2);
    });

    it('warns again from another call site, and names the from*Usage normalizer for a provider-shaped usage', () => {
      const { client, logger } = setup();

      client.record({ provider: 'openai', model: 'gpt-5', usage: { input: 1 } as never });
      client.record({ provider: 'openai', model: 'gpt-5', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } as never });

      const warnings = unknownKeyWarnings(logger.warn);

      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain('fromOpenAIChatUsage');
      expect(client.stats().invalidUsage).toBe(2);
    });

    it('warns about a successful call with nothing billable — but not for an error/aborted call, a cost-only call, or tool requests only', () => {
      const { client, logger } = setup();

      client.record({ provider: 'openai', model: 'gpt-5', status: 'error' });
      client.record({ provider: 'openai', model: 'gpt-5', status: 'aborted', usage: {} });
      client.record({ provider: 'selfhost', model: 'llama', cost: { amount: '0.01' } });
      client.record({ provider: 'openai', model: 'gpt-5', usage: { toolRequests: { web_search: 1 } } });
      client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 5, outputTokens: 1 } });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(client.stats().invalidUsage).toBe(0);

      client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 0 } });
      client.record({ provider: 'selfhost', model: 'llama', cost: { amount: 'free' } });

      expect(emptyWarnings(logger.warn)).toHaveLength(2);
      expect(emptyWarnings(logger.warn)[0]).toContain('unpriced at $0');
      expect(client.stats().invalidUsage).toBe(2);
    });

    it('flags a usage that is not an object', () => {
      const { client, logger } = setup();

      client.record({ provider: 'openai', model: 'gpt-5', usage: 1_000 as never });

      expect(logger.warn.mock.calls.some(([m]) => (m as string).includes('usage must be an object'))).toBe(true);
      expect(client.stats().invalidUsage).toBe(1);
    });

    it('does not check adapter events (they build canonical usage) and never warns on a disabled client', () => {
      const { client, logger } = setup();

      internalOf(client)?.recordFrom('openai', { provider: 'openai', model: 'gpt-5' }, 'adapter-site');
      expect(logger.warn).not.toHaveBeenCalled();
      expect(client.stats().invalidUsage).toBe(0);

      const disabled = setup({ apiKey: '', disabled: true });

      disabled.client.record({ provider: 'openai', model: 'gpt-5', usage: { input: 1 } as never });
      expect(disabled.logger.warn).not.toHaveBeenCalled();
    });

    it('strict mode throws AiSpendInvalidUsageError (even with no ingest key); attribution errors still come first', () => {
      const strict = setup({ strict: true, apiKey: '', defaultCustomer: 'cus_1', defaultFeature: 'app.chat' });

      expect(() => strict.client.record({ provider: 'openai', model: 'gpt-5', usage: { input: 1_000, output: 100 } as never })).toThrow(AiSpendInvalidUsageError);

      let thrown: unknown;

      try {
        strict.client.record({ provider: 'openai', model: 'gpt-5', usage: { input: 1_000 } as never });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AiSpendInvalidUsageError);
      expect((thrown as AiSpendInvalidUsageError).issues.map((issue) => issue.code)).toEqual([AiSpendUsageIssueCode.UNKNOWN_KEY, AiSpendUsageIssueCode.EMPTY]);
      expect((thrown as AiSpendInvalidUsageError).issues[0].keys).toEqual(['input']);

      expect(() => strict.client.record({ provider: 'openai', model: 'gpt-5' })).toThrow(/no tokens, no tool requests and no cost/);
      expect(() => strict.client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 10 } })).not.toThrow();

      const noDefaults = setup({ strict: true, apiKey: '' });

      expect(() => noDefaults.client.record({ provider: 'openai', model: 'gpt-5', usage: { input: 1 } as never })).toThrow(AiSpendAttributionError);
    });
  });

  describe('record()', () => {
    it('builds a snake_case wire event with SDK diagnostics', async () => {
      const { client, events } = setup();
      const record: AiSpendUsageRecord = {
        provider: 'openai',
        model: 'gpt-5-2025-08-07',
        usage: fromOpenAIChatUsage({ prompt_tokens: 2006, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1920 }, completion_tokens_details: { reasoning_tokens: 192 } }),
        serviceTier: 'flex',
        batch: true,
        latencyMs: 812.4,
        customer: 'cus_1',
        feature: 'support.chat',
        user: 'usr_1',
        runId: 'run_1',
        entityRef: 'ticket:9',
        tags: { region: 'eu' },
        cost: { amount: '0.0042' },
      };

      client.record(record);
      await client.flush();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        event_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        occurred_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        provider: 'openai',
        model: 'gpt-5-2025-08-07',
        service_tier: 'flex',
        batch: true,
        status: 'success',
        latency_ms: 812,
        usage: { input_tokens: 86, cached_input_tokens: 1920, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 300, reasoning_tokens: 192 },
        customer: 'cus_1',
        feature: 'support.chat',
        user: 'usr_1',
        run_id: 'run_1',
        entity_ref: 'ticket:9',
        tags: { region: 'eu' },
        cost: { amount: '0.0042', currency: 'USD' },
        sdk: { name: AI_SPEND_SDK_NAME, version: AI_SPEND_SDK_VERSION, adapter: 'manual' },
      });
    });

    it('fixes occurred_at at record time, not send time', async () => {
      jest.useFakeTimers({ now: Date.UTC(2026, 8, 30, 10, 0, 0) });

      try {
        const { client, events } = setup();

        client.record({ provider: 'anthropic', model: 'claude-opus-5-5', customer: 'c', feature: 'f' });
        await jest.advanceTimersByTimeAsync(5_000);

        expect(events[0].occurred_at).toBe('2026-09-30T10:00:00.000Z');
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps a caller-supplied event id (idempotent replays) and derives a deterministic one from any other key', async () => {
      const { client, events } = setup();
      const occurredAt = new Date();

      client.record({ provider: 'openai', model: 'gpt-5', eventId: '0192F3A0-7B7C-7D5E-8F00-0123456789AB', occurredAt });
      client.record({ provider: 'openai', model: 'gpt-5', eventId: 'not-a-uuid', occurredAt });
      await client.flush();

      expect(events[0].event_id).toBe('0192f3a0-7b7c-7d5e-8f00-0123456789ab');
      expect(events[1].event_id).toBe(eventIdFrom('not-a-uuid'));
    });

    it('drops an explicit cost that is not a USD decimal, but still records the usage', async () => {
      const { client, events } = setup();

      client.record({ provider: 'selfhosted', model: 'llama-4', cost: { amount: '1,20' } });
      client.record({ provider: 'selfhosted', model: 'llama-4', cost: { amount: 0.5, currency: 'EUR' as 'USD' } });
      client.record({ provider: 'selfhosted', model: 'llama-4', cost: { amount: 0.25 } });
      await client.flush();

      expect(events.map((e) => e.cost)).toEqual([undefined, undefined, { amount: '0.25', currency: 'USD' }]);
    });

    it('rejects an event without provider/model locally, via onError — never by throwing', async () => {
      const { client, events, errors } = setup();

      expect(() => client.record({ provider: '', model: 'gpt-5' })).not.toThrow();
      expect(() => client.record(null as unknown as AiSpendUsageRecord)).not.toThrow();
      expect(() => client.record({ provider: 'openai', model: 'gpt-5', occurredAt: 'yesterday-ish' })).not.toThrow();
      await client.flush();

      expect(events).toHaveLength(0);
      expect(errors.every((e) => e instanceof AiSpendRejectedEventError)).toBe(true);
      expect(client.stats().rejected).toBeGreaterThanOrEqual(2);
    });

    it('never blocks: nothing is sent synchronously', () => {
      const { client, fetch } = setup();

      client.record({ provider: 'openai', model: 'gpt-5' });
      expect(fetch).not.toHaveBeenCalled();
      expect(client.stats().queued).toBe(1);
    });
  });

  describe('explicit cost', () => {
    it.each([
      [0.003 * 1.1, '0.0033'],
      [5e-7, '0.0000005'],
      [0.1 + 0.2, '0.3'],
      ['0.0042', '0.0042'],
      [0.25, '0.25'],
      [12, '12'],
      [0.0000000004, '0'],
      ['1.1234567891234', '1.1234567891234'],
    ])('formats %p as %p (no exponent, no float tail)', (input, expected) => {
      expect(formatCostAmount(input)).toBe(expected);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1e21, '-1', '1e-7', '', 'abc', null])('refuses %p', (input) => {
      expect(formatCostAmount(input)).toBeUndefined();
    });

    it('sends numeric costs as plain decimals and warns once for refused amounts', async () => {
      const { client, events, logger } = setup();

      for (const amount of [0.003 * 1.1, 5e-7, 0.1 + 0.2, '0.0042', 0.25]) client.record({ provider: 'selfhost', model: 'llama', cost: { amount } });
      for (const amount of [Number.NaN, -3, '1,5']) client.record({ provider: 'selfhost', model: 'llama', cost: { amount }, usage: { inputTokens: 1 } });
      await client.flush();

      expect(events.map((e) => e.cost?.amount)).toEqual(['0.0033', '0.0000005', '0.3', '0.0042', '0.25', undefined, undefined, undefined]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('local validation (mirrors whole-event server rejections)', () => {
    it('turns a non-UUID eventId into a deterministic UUIDv5: a replayed job key dedupes', async () => {
      const { client, events, logger } = setup();
      const occurredAt = new Date();

      // A BullMQ job retried three times with the same natural key → ONE event id.
      for (let attempt = 0; attempt < 3; attempt++) client.record({ provider: 'x', model: 'y', eventId: 'job-123:step-2', occurredAt, usage: { inputTokens: 1 } });
      client.record({ provider: 'x', model: 'y', eventId: 'job-123:step-3', occurredAt, usage: { inputTokens: 1 } });
      await client.flush();

      expect(events.every((e) => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e.event_id))).toBe(true);
      expect(new Set(events.slice(0, 3).map((e) => e.event_id)).size).toBe(1);
      expect(events[3].event_id).not.toBe(events[0].event_id);
      expect(events[0].event_id).toBe(eventIdFrom('job-123:step-2'));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('generates a fresh id for an unusable eventId (empty / not a string), with one warning', async () => {
      const { client, events, logger } = setup();

      client.record({ provider: 'x', model: 'y', eventId: '', occurredAt: new Date() });
      client.record({ provider: 'x', model: 'y', eventId: 42 as unknown as string, occurredAt: new Date() });
      await client.flush();

      expect(events.map((e) => e.event_id.charAt(14))).toEqual(['7', '7']);
      expect(logger.warn.mock.calls.filter(([m]) => (m as string).includes('must be a non-empty string'))).toHaveLength(1);
    });

    it('warns once when eventId is passed without occurredAt (a late replay would be booked on the wrong day, or stored again)', async () => {
      const { client, logger } = setup();

      client.record({ provider: 'x', model: 'y', eventId: eventIdFrom('a') });
      client.record({ provider: 'x', model: 'y', eventId: eventIdFrom('b') });
      client.record({ provider: 'x', model: 'y', eventId: eventIdFrom('c'), occurredAt: Date.now() });
      await client.flush();

      expect(logger.warn.mock.calls.filter(([m]) => (m as string).includes('without occurredAt'))).toHaveLength(1);
    });

    it('warns when occurredAt looks like seconds or falls outside the accepted window', async () => {
      const { client, events, logger } = setup();

      client.record({ provider: 'x', model: 'y', occurredAt: Math.floor(Date.now() / 1000) });
      client.record({ provider: 'x', model: 'y', occurredAt: Date.now() - 40 * 86_400_000 });
      client.record({ provider: 'x', model: 'y', occurredAt: Date.now() + 10 * 60_000 });
      await client.flush();

      const messages = logger.warn.mock.calls.map(([m]) => m as string);

      expect(messages.filter((m) => m.includes('SECONDS'))).toHaveLength(1);
      expect(messages.filter((m) => m.includes('occurred_at_out_of_range'))).toHaveLength(1);
      expect(events).toHaveLength(3);
    });

    it('drops NUL / lone-surrogate attribution and strips them from provider/model — the usage is still sent', async () => {
      const { client, events, errors } = setup();

      client.record({ provider: 'x', model: 'y', customer: 'cus\u0000_1', user: 'usr_\ud800', feature: 'ok.feature', tags: { a: 'b\u0000', c: '\udc00', d: 'ok' } });
      client.record({ provider: 'open\u0000ai', model: 'gpt\ud8005', usage: { inputTokens: 7 } });
      client.record({ provider: '\u0000', model: 'y' });
      await client.flush();

      expect(events).toHaveLength(2);
      expect(events[0].customer).toBeUndefined();
      expect(events[0].user).toBeUndefined();
      expect(events[0].tags).toEqual({ d: 'ok' });
      expect(events[0].feature).toBe('ok.feature');
      expect(events[1]).toEqual(expect.objectContaining({ provider: 'openai', model: 'gpt5', usage: expect.objectContaining({ input_tokens: 7 }) }));
      expect(errors.filter((e) => e instanceof AiSpendRejectedEventError)).toHaveLength(1);
    });

    it('clips provider / model / service tier to the stored lengths (lower-cased forms included), never splitting a surrogate pair', async () => {
      const { client, events } = setup();

      client.record({ provider: 'p'.repeat(63) + '😀', model: 'İ'.repeat(100), serviceTier: '  PRIORITY  ' });
      client.record({ provider: 'x', model: 'y', serviceTier: 'T'.repeat(40) });
      await client.flush();

      expect(events[0].provider).toBe('p'.repeat(63));
      expect(events[0].model.toLowerCase().length).toBeLessThanOrEqual(160);
      expect(events[0].service_tier).toBe('priority');
      expect(events[1].service_tier).toBe('t'.repeat(32));
    });

    it('leaves out a latency the server cannot store and drops a cost of $1,000,000 or more — the event is still sent', async () => {
      const { client, events, logger } = setup();

      client.record({ provider: 'x', model: 'y', latencyMs: Date.now(), cost: { amount: '1000000' } });
      client.record({ provider: 'x', model: 'y', latencyMs: 2_147_483_647, cost: { amount: '999999.123456789' } });
      await client.flush();

      expect(events).toHaveLength(2);
      expect(events[0].latency_ms).toBeUndefined();
      expect(events[0].cost).toBeUndefined();
      expect(events[1].latency_ms).toBe(2_147_483_647);
      expect(events[1].cost).toEqual({ amount: '999999.123456789', currency: 'USD' });
      expect(logger.warn.mock.calls.filter(([m]) => (m as string).includes('latencyMs'))).toHaveLength(1);
    });

    it('caps token and tool-request counts at the server maximums and normalises tool names', async () => {
      const { client, events } = setup();

      client.record({
        provider: 'x',
        model: 'y',
        usage: { inputTokens: 2e10, outputTokens: 5, reasoningTokens: 9, toolRequests: { ' Web_Search ': 2, web_search: 1, constructor: 1, prototype: 1, FILE_SEARCH: 3e6, '   ': 1 } },
      });
      await client.flush();

      expect(events[0].usage).toEqual(
        expect.objectContaining({ input_tokens: 10_000_000_000, output_tokens: 5, reasoning_tokens: 5, tool_requests: { web_search: 3, file_search: 1_000_000 } }),
      );
    });

    it('rejects an occurredAt the server cannot read (outside years 0000–9999) locally', async () => {
      const { client, events, errors } = setup();

      client.record({ provider: 'x', model: 'y', occurredAt: new Date('+010000-01-01T00:00:00Z') });
      await client.flush();

      expect(events).toHaveLength(0);
      expect(errors[0]).toBeInstanceOf(AiSpendRejectedEventError);
      expect(client.stats().rejected).toBe(1);
    });

    it('keeps at most 20 valid tool names and warns once', async () => {
      const { client, events, logger } = setup();
      const toolRequests = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`tool_${i}`, 1]));

      client.record({ provider: 'x', model: 'y', usage: { toolRequests: { ...toolRequests, 'bad\nname': 2 } } });
      client.record({ provider: 'x', model: 'y', usage: { toolRequests } });
      await client.flush();

      expect(Object.keys(events[0].usage?.tool_requests ?? {})).toHaveLength(20);
      expect(Object.keys(events[0].usage?.tool_requests ?? {})).not.toContain('bad\nname');
      expect(logger.warn.mock.calls.filter(([m]) => (m as string).includes('toolRequests'))).toHaveLength(2);
    });
  });

  describe('nameCustomer()', () => {
    it('sends the trimmed name to its own endpoint — never on usage events', async () => {
      const { client, events, names, fetch } = setup();

      client.withContext({ customer: 'cus_1', feature: 'support.chat' }, () => client.record({ provider: 'openai', model: 'gpt-5' }));
      client.nameCustomer('  cus_1 ', ' Acme Inc. ');
      expect(fetch).not.toHaveBeenCalled();
      await client.flush();

      expect(names).toEqual([{ customer: 'cus_1', display_name: 'Acme Inc.' }]);
      expect(events).toHaveLength(1);
      expect(events[0].customer).toBe('cus_1');
      expect(JSON.stringify(events)).not.toContain('Acme');
      expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
        `${AI_SPEND_DEFAULT_ENDPOINT}${AI_SPEND_CUSTOMER_NAMES_PATH}`,
        `${AI_SPEND_DEFAULT_ENDPOINT}${AI_SPEND_EVENTS_PATH}`,
      ]);
    });

    it('sends a name once per process', async () => {
      const { client, names } = setup();

      expect(client.stats().customerNames).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 0 });

      client.nameCustomer('cus_1', 'Acme Inc.');
      client.nameCustomer('cus_1', 'Acme Inc.');
      await client.flush();
      client.nameCustomer('cus_1', ' Acme Inc.');
      await client.flush();

      expect(names).toHaveLength(1);
      expect(client.stats().customerNames).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 0 });
    });

    it('drops invalid input: one warning per kind of problem, counted as rejected, reported to onError', async () => {
      const { client, names, errors, logger } = setup();

      client.nameCustomer('jane.doe@acme.io', 'Jane Doe');
      client.nameCustomer('john.doe@acme.io', 'John Doe');
      client.nameCustomer('cus_1', '   ');
      client.nameCustomer('c'.repeat(257), 'Acme');
      client.nameCustomer(42 as unknown as string, 'Acme');
      client.nameCustomer('cus_2', undefined as unknown as string);
      await client.flush();

      const warnings = logger.warn.mock.calls.map(([message]) => message as string).filter((message) => message.includes('nameCustomer()'));

      expect(names).toHaveLength(0);
      expect(warnings).toHaveLength(5);
      expect(warnings.join('\n')).not.toContain('jane.doe');
      expect(client.stats().customerNames).toEqual({ queued: 0, acknowledged: 0, rejected: 6, dropped: 0 });
      expect(errors.every((error) => error instanceof AiSpendRejectedCustomerNameError)).toBe(true);
      expect(errors.map((error) => (error as AiSpendRejectedCustomerNameError).code)).toEqual([
        'customer_email_like',
        'customer_email_like',
        'invalid_display_name',
        'invalid_customer',
        'invalid_customer',
        'invalid_display_name',
      ]);
    });

    it('is a no-op on a disabled client', async () => {
      const logger = { warn: jest.fn() };
      const fetch = jest.fn();
      const client = createAiSpend({ disabled: true, logger, fetch: fetch as unknown as AiSpendFetch });

      expect(() => client.nameCustomer('cus_1', 'Acme Inc.')).not.toThrow();
      expect(() => client.nameCustomer('jane.doe@acme.io', '')).not.toThrow();
      await client.flush();
      await client.shutdown();

      expect(fetch).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(client.stats().customerNames).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 0 });
    });

    it('shutdown() delivers pending names; names reported after it are dropped (one warning)', async () => {
      const { client, names, logger } = setup();

      client.nameCustomer('cus_1', 'Acme Inc.');
      await client.shutdown({ timeoutMs: 1_000 });
      client.nameCustomer('cus_2', 'Globex');
      client.nameCustomer('cus_3', 'Initech');

      expect(names).toEqual([{ customer: 'cus_1', display_name: 'Acme Inc.' }]);
      expect(client.stats().customerNames).toEqual({ queued: 0, acknowledged: 1, rejected: 0, dropped: 2 });
      expect(logger.warn.mock.calls.filter(([message]) => (message as string).includes('after shutdown()'))).toHaveLength(1);
    });

    it('shutdown() holds names to the same deadline: names still undelivered then are dropped', async () => {
      jest.useFakeTimers({ now: Date.UTC(2026, 9, 2, 12, 0, 0) });

      try {
        const errors: AiSpendSdkError[] = [];
        const client = createAiSpend({ apiKey: 'bfu_test', fetch: stuckAt(AI_SPEND_CUSTOMER_NAMES_PATH), logger: {}, onError: (e) => errors.push(e) });

        client.record({ provider: 'openai', model: 'gpt-5' });
        client.nameCustomer('cus_1', 'Acme Inc.');

        const done = client.shutdown({ timeoutMs: 2_000 });
        let finished = false;

        void done.then(() => (finished = true));
        await jest.advanceTimersByTimeAsync(1_999);
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(finished).toBe(true);

        expect(client.stats()).toEqual(expect.objectContaining({ sent: 1, dropped: 0, queued: 0 }));
        expect(client.stats().customerNames).toEqual({ queued: 0, acknowledged: 0, rejected: 0, dropped: 1 });
        expect(errors).toEqual([expect.any(AiSpendDeliveryError)]);
        expect(errors[0]).toEqual(expect.objectContaining({ eventCount: 0, customerNameCount: 1 }));
      } finally {
        jest.useRealTimers();
      }
    });

    it.each([
      ['customer-names', AI_SPEND_CUSTOMER_NAMES_PATH, { sent: 1, queued: 0 }, { queued: 1, acknowledged: 0 }],
      ['event-batch', AI_SPEND_EVENTS_PATH, { sent: 0, queued: 1 }, { queued: 0, acknowledged: 1 }],
    ])('a stuck %s request does not hold up the other queue', async (_label, stuckPath, events, customerNames) => {
      jest.useFakeTimers({ now: Date.UTC(2026, 9, 2, 12, 0, 0) });

      try {
        const client = createAiSpend({ apiKey: 'bfu_test', fetch: stuckAt(stuckPath), logger: {}, warnOnMissingAttribution: false });

        client.record({ provider: 'openai', model: 'gpt-5', customer: 'cus_1', feature: 'support.chat' });
        client.nameCustomer('cus_1', 'Acme Inc.');
        await jest.advanceTimersByTimeAsync(5_000);

        expect(client.stats()).toEqual(expect.objectContaining(events));
        expect(client.stats().customerNames).toEqual(expect.objectContaining(customerNames));
        await client.shutdown({ timeoutMs: 0 });
      } finally {
        jest.useRealTimers();
      }
    });

    it('never throws — not when fetch, the logger and onError all throw', async () => {
      const throwing = () => {
        throw new Error('boom');
      };

      const client = createAiSpend({
        apiKey: 'bfu_test',
        fetch: throwing as unknown as AiSpendFetch,
        logger: { debug: throwing, warn: throwing, error: throwing },
        onError: throwing,
      });

      expect(() => client.nameCustomer('cus_1', 'Acme Inc.')).not.toThrow();
      expect(() => client.nameCustomer('jane.doe@acme.io', 'Jane Doe')).not.toThrow();
      expect(() => client.nameCustomer(null as unknown as string, {} as unknown as string)).not.toThrow();
      await expect(client.flush()).resolves.toBeUndefined();
      await expect(client.shutdown({ timeoutMs: 0 })).resolves.toBeUndefined();

      expect(client.stats().customerNames).toEqual({ queued: 0, acknowledged: 0, rejected: 2, dropped: 1 });
    });
  });

  describe('flush / shutdown / stats', () => {
    it('shutdown() drains; later records are counted as dropped', async () => {
      const { client, events } = setup();

      client.record({ provider: 'openai', model: 'gpt-5' });
      await client.shutdown({ timeoutMs: 1_000 });
      client.record({ provider: 'openai', model: 'gpt-5' });
      await client.flush();

      expect(events).toHaveLength(1);
      expect(client.stats()).toEqual(expect.objectContaining({ sent: 1, accepted: 1, queued: 0, dropped: 1, paused: false }));
    });

    it('shutdown({ timeoutMs: 0 }) does not wait', async () => {
      const { client, fetch } = setup();

      client.record({ provider: 'openai', model: 'gpt-5' });
      await client.shutdown({ timeoutMs: 0 });

      expect(fetch).not.toHaveBeenCalled();
      expect(client.stats()).toEqual(expect.objectContaining({ dropped: 1, queued: 0 }));
    });
  });
});
