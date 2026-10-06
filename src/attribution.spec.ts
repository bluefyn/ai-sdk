import { carry, current, isAmbientContextSupported, mergeAttribution, validateAttribution, withCarried, withContext } from './attribution';
import { createAiSpend } from './client';
import type { AiSpendOptions } from './client';
import type { AiSpendFetch } from './delivery';
import { AiSpendAttributionError } from './errors';
import type { AiSpendWireBatch, AiSpendWireEvent } from './wire';

function capture(options: AiSpendOptions = {}) {
  const events: AiSpendWireEvent[] = [];

  const fetch: AiSpendFetch = async (_url, init) => {
    const batch = JSON.parse(init.body) as AiSpendWireBatch;

    events.push(...batch.events);

    return { status: 202, text: async () => JSON.stringify({ accepted: batch.events.length, duplicates: 0, rejected: [] }) };
  };

  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const client = createAiSpend({ apiKey: 'bfu_test', fetch, logger, ...options });

  return { client, events, logger };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('attribution', () => {
  it('runs on a real AsyncLocalStorage in this runtime', () => {
    expect(isAmbientContextSupported()).toBe(true);
  });

  describe('resolution order: per-call → ambient → client defaults', () => {
    it('applies each layer field by field', async () => {
      const { client, events } = capture({ defaultCustomer: 'cus_default', defaultFeature: 'app.default' });

      client.record({ provider: 'openai', model: 'gpt-5' });
      withContext({ customer: 'cus_ambient', runId: 'run_1' }, () => {
        client.record({ provider: 'openai', model: 'gpt-5' });
        client.record({ provider: 'openai', model: 'gpt-5', customer: 'cus_call', feature: 'app.call' });
      });
      await client.flush();

      expect(events.map((e) => [e.customer, e.feature, e.run_id])).toEqual([
        ['cus_default', 'app.default', undefined],
        ['cus_ambient', 'app.default', 'run_1'],
        ['cus_call', 'app.call', 'run_1'],
      ]);
    });

    it('nested contexts override field by field and merge tags', () => {
      withContext({ customer: 'a', feature: 'x', tags: { region: 'eu', plan: 'pro' } }, () => {
        withContext({ feature: 'x.y', tags: { plan: 'free', exp: 'b' } }, () => {
          expect(current()).toEqual({ customer: 'a', feature: 'x.y', tags: { region: 'eu', plan: 'free', exp: 'b' } });
        });
        expect(current()).toEqual({ customer: 'a', feature: 'x', tags: { region: 'eu', plan: 'pro' } });
      });
      expect(current()).toBeUndefined();
    });

    it('per-call tags merge over ambient tags', () => {
      expect(mergeAttribution({ tags: { a: '1', b: '2' } }, { tags: { b: '3' } })).toEqual({ tags: { a: '1', b: '3' } });
    });
  });

  describe('AsyncLocalStorage isolation', () => {
    it('keeps concurrent async flows apart', async () => {
      const seen: string[] = [];
      const flow = (customer: string, hops: number) =>
        withContext({ customer }, async () => {
          for (let i = 0; i < hops; i++) {
            await tick();
            seen.push(`${customer}:${current()?.customer}`);
          }
        });

      await Promise.all([flow('alpha', 5), flow('beta', 3), flow('gamma', 4)]);

      expect(seen).toHaveLength(12);
      seen.forEach((entry) => {
        const [expected, actual] = entry.split(':');

        expect(actual).toBe(expected);
      });
    });

    it('returns fn’s value and propagates fn’s errors untouched', async () => {
      expect(withContext({ customer: 'x' }, () => 42)).toBe(42);
      await expect(withContext({ customer: 'x' }, async () => Promise.reject(new RangeError('app bug')))).rejects.toThrow(RangeError);
    });
  });

  describe('runtime without AsyncLocalStorage', () => {
    it('module-level withContext / withCarried still run fn, and warn ONCE per process', () => {
      const slot = Symbol.for('@bluefyn/ai-spend-sdk.attribution-storage');
      const registry = globalThis as unknown as Record<symbol, unknown>;
      const saved = registry[slot];

      registry[slot] = { storage: null };

      try {
        jest.isolateModules(() => {
           
          const isolated = require('./attribution') as typeof import('./attribution');
          const warn = jest.fn();

          isolated.registerAmbientWarner(warn);
          expect(isolated.withContext({ customer: 'c' }, () => 42)).toBe(42);
          expect(isolated.withCarried({ v: 1, customer: 'c' }, () => isolated.current())).toBeUndefined();
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0][0]).toContain('AsyncLocalStorage is unavailable');
        });
      } finally {
        registry[slot] = saved;
      }
    });
  });

  describe('carry / withCarried', () => {
    it('round-trips through a JSON job payload', async () => {
      const payload = withContext({ customer: 'cus_9', feature: 'jobs.enrich', user: 'usr_1', runId: 'run_7', entityRef: 'contract:123', tags: { region: 'eu' } }, () =>
        JSON.stringify({ jobData: 1, aiSpend: carry() }),
      );
      const parsed = JSON.parse(payload) as { aiSpend: unknown };

      expect(current()).toBeUndefined();

      const restored = await withCarried(parsed.aiSpend, async () => {
        await tick();

        return current();
      });

      expect(restored).toEqual({ customer: 'cus_9', feature: 'jobs.enrich', user: 'usr_1', runId: 'run_7', entityRef: 'contract:123', tags: { region: 'eu' } });
      expect(JSON.parse(payload).aiSpend.v).toBe(1);
    });

    it('carry() is undefined outside a context and withCarried tolerates garbage', () => {
      expect(carry()).toBeUndefined();
      expect(withCarried(undefined, () => current())).toBeUndefined();
      expect(withCarried('garbage', () => current())).toBeUndefined();
      expect(withCarried({ v: 1, customer: 42, feature: 'ok.feature' }, () => current())).toEqual({ feature: 'ok.feature' });
    });
  });

  describe('validation', () => {
    it('drops invalid values instead of throwing', () => {
      const { attribution, issues } = validateAttribution({
        customer: 'c'.repeat(257),
        feature: 'Checkout.Summarize',
        runId: 'r'.repeat(129),
        user: 'usr_1',
        tags: { Region: 'eu', ok: 'v'.repeat(129), fine: 'yes' },
      });

      expect(attribution).toEqual({ user: 'usr_1', tags: { fine: 'yes' } });
      expect(issues.map((i) => i.field)).toEqual(['customer', 'feature', 'runId', 'tags', 'tags.ok']);
    });

    it('keeps at most 10 tags', () => {
      const tags = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i}`, 'v']));
      const { attribution, issues } = validateAttribution({ tags });

      expect(Object.keys(attribution.tags ?? {})).toHaveLength(10);
      expect(issues).toHaveLength(1);
    });

    it('accepts feature paths of up to 6 segments', () => {
      expect(validateAttribution({ feature: 'a.b.c.d.e.f' }).attribution.feature).toBe('a.b.c.d.e.f');
      expect(validateAttribution({ feature: 'a.b.c.d.e.f.g' }).attribution.feature).toBeUndefined();
    });
  });

  describe('strict mode', () => {
    it('throws AiSpendAttributionError synchronously from record() — even with no ingest key', () => {
      const client = createAiSpend({ strict: true, disabled: true });

      expect(() => client.record({ provider: 'openai', model: 'gpt-5' })).toThrow(AiSpendAttributionError);
      expect(() => client.record({ provider: 'openai', model: 'gpt-5', customer: 'c', feature: 'Bad Feature' })).toThrow(/feature/);
      expect(() => client.record({ provider: 'openai', model: 'gpt-5', customer: 'c', feature: 'good.feature', usage: { inputTokens: 1 } })).not.toThrow();
    });

    it('lists every issue', () => {
      const client = createAiSpend({ strict: true, disabled: true });

      try {
        client.record({ provider: 'openai', model: 'gpt-5', user: 'jane@example.com' });
        fail('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AiSpendAttributionError);
        expect((error as AiSpendAttributionError).issues.map((i) => i.code)).toEqual(['email_like', 'missing_customer', 'missing_feature']);
      }
    });
  });

  describe('development warnings', () => {
    it('does not burn a rate-limited warning: suppressed keys warn once the window resets', () => {
      jest.useFakeTimers({ now: Date.UTC(2026, 8, 30) });

      try {
        const { client, logger } = capture({ warnOnMissingAttribution: true, defaultCustomer: 'cus_1' });
        const call = (feature: string) => client.record({ provider: 'openai', model: 'gpt-5', feature, user: `${feature}@example.com`, usage: { inputTokens: 1 } });
        const features = Array.from({ length: 12 }, (_, i) => `feature.f${i}`);

        features.forEach(call);
        expect(logger.warn).toHaveBeenCalledTimes(1); // email_like is keyed by field: one key, one warning

        logger.warn.mockClear();

        const { client: second, logger: secondLogger } = capture({ warnOnMissingAttribution: true });
        const missing = (feature: string) => second.record({ provider: 'openai', model: 'gpt-5', feature, usage: { inputTokens: 1 } });

        features.forEach(missing); // 12 distinct keys → only 10 warn in this window
        expect(secondLogger.warn).toHaveBeenCalledTimes(10);

        features.forEach(missing); // same window: the 2 suppressed keys stay suppressed, the 10 are seen
        expect(secondLogger.warn).toHaveBeenCalledTimes(10);

        jest.advanceTimersByTime(60_001);
        features.forEach(missing); // new window: only the 2 never-logged keys warn
        expect(secondLogger.warn).toHaveBeenCalledTimes(12);
      } finally {
        jest.useRealTimers();
      }
    });


    it('warn once per call site for missing attribution', () => {
      const { client, logger } = capture({ warnOnMissingAttribution: true });

      for (let i = 0; i < 5; i++) {
        client.record({ provider: 'openai', model: 'gpt-5' });
      }

      const missing = logger.warn.mock.calls.map(([message]) => message as string);

      expect(missing.filter((m) => m.includes('no customer'))).toHaveLength(1);
      expect(missing.filter((m) => m.includes('no feature'))).toHaveLength(1);
    });

    it('warns again for a different feature or call site, never twice for the same one', () => {
      const { client, logger } = capture({ warnOnMissingAttribution: true });
      const call = (feature: string) => client.record({ provider: 'openai', model: 'gpt-5', feature });

      call('one.feature');
      call('one.feature');
      call('two.feature');
      client.record({ provider: 'openai', model: 'gpt-5', feature: 'one.feature' }); // another call site

      expect(logger.warn.mock.calls.filter(([m]) => (m as string).includes('no customer'))).toHaveLength(3);
    });

    it('flags an email-like customer without echoing it', () => {
      const { client, logger } = capture({ warnOnMissingAttribution: true });

      client.record({ provider: 'openai', model: 'gpt-5', feature: 'x.y', customer: 'jane.doe@example.com' });

      const messages = logger.warn.mock.calls.map(([m]) => m as string);

      expect(messages.some((m) => m.includes('looks like an email'))).toBe(true);
      expect(messages.join('\n')).not.toContain('jane.doe@example.com');
    });

    it('is silent when disabled (the production default)', () => {
      const { client, logger } = capture({ warnOnMissingAttribution: false });

      client.record({ provider: 'openai', model: 'gpt-5', feature: 'BAD', usage: { inputTokens: 1 } });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('drops an invalid defaultFeature with one warning', () => {
      const { logger } = capture({ defaultFeature: 'Not Valid' });

      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });
});
