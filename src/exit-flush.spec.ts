import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { createAiSpend } from './client';
import type { AiSpendOptions } from './client';
import type { AiSpendFetch, AiSpendFetchResponse } from './delivery';
import { handleBeforeExit, handleExit, heldExitFlushTargets } from './exit-flush';
import type { AiSpendWireBatch, AiSpendWireEvent } from './wire';

function setup(reply: (body: string) => AiSpendFetchResponse, options: AiSpendOptions = {}) {
  const events: AiSpendWireEvent[] = [];
  const fetch = jest.fn<ReturnType<AiSpendFetch>, Parameters<AiSpendFetch>>(async (_url, init) => {
    events.push(...(JSON.parse(init.body) as AiSpendWireBatch).events);

    return reply(init.body);
  });
  const logger = { debug: jest.fn(), warn: jest.fn() };
  const client = createAiSpend({ apiKey: 'bfu_test', fetch, logger, warnOnMissingAttribution: false, ...options });

  return { client, events, fetch, logger };
}

const accepted = (body: string): AiSpendFetchResponse => {
  const count = (JSON.parse(body) as AiSpendWireBatch).events.length;

  return { status: 202, text: async () => JSON.stringify({ accepted: count, duplicates: 0, rejected: [] }) };
};

/** The SDK's TypeScript source, compiled on require by the package's own `typescript` (for spawned Node processes). */
const TS_REQUIRE_HOOK = `
  const ts = require('typescript');
  const fs = require('node:fs');
  require.extensions['.ts'] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    module._compile(outputText, filename);
  };
`;

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe('natural-exit flush', () => {
  it('flushes buffered events when the event loop runs dry (beforeExit) — a script that never calls shutdown()', async () => {
    const { client, events } = setup(accepted);

    client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 3 } });
    expect(events).toHaveLength(0);

    handleBeforeExit();
    await settle();

    expect(events).toHaveLength(1);
    expect(client.stats().queued).toBe(0);
    await client.shutdown();
  });

  it('does not retry on every beforeExit when the last attempt made no progress (auth pause)', async () => {
    const { client, fetch } = setup(() => ({ status: 401, text: async () => '' }));

    client.record({ provider: 'openai', model: 'gpt-5' });
    handleBeforeExit();
    await settle();
    handleBeforeExit();
    await settle();

    expect(fetch).toHaveBeenCalledTimes(1);
    await client.shutdown({ timeoutMs: 0 });
  });

  it('warns at exit when events are still unsent', async () => {
    const { client, logger } = setup(() => ({ status: 401, text: async () => '' }));

    client.record({ provider: 'openai', model: 'gpt-5' });
    handleExit();

    expect(logger.warn.mock.calls.filter(([m]) => (m as string).includes('still unsent'))).toHaveLength(1);
    await client.shutdown({ timeoutMs: 0 });
  });

  it('a client that was shut down leaves the exit hooks', async () => {
    const { client, fetch, logger } = setup(accepted);

    await client.shutdown();
    handleBeforeExit();
    handleExit();
    await settle();

    expect(fetch).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('holds a client strongly only while it has something to send: on record / nameCustomer, released once delivered, gone after shutdown()', async () => {
    const before = heldExitFlushTargets();
    const { client } = setup(accepted, { flushIntervalMs: 1 });

    expect(heldExitFlushTargets()).toBe(before);

    client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 3 } });
    expect(heldExitFlushTargets()).toBe(before + 1);

    await client.flush();
    expect(heldExitFlushTargets()).toBe(before);

    // Background delivery (no flush() call) releases it too.
    client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 3 } });
    expect(heldExitFlushTargets()).toBe(before + 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    expect(client.stats().queued).toBe(0);
    expect(heldExitFlushTargets()).toBe(before);

    client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 3 } });
    await client.shutdown();
    expect(heldExitFlushTargets()).toBe(before);

    // A pending customer name holds the client as well.
    const names = setup(accepted);

    names.client.nameCustomer('cus_1', 'Acme');
    expect(heldExitFlushTargets()).toBe(before + 1);
    await names.client.shutdown({ timeoutMs: 0 });
    expect(heldExitFlushTargets()).toBe(before);
  });

  it('end to end: a client created in a function and dropped without shutdown() is not garbage-collected with its events unsent', () => {
    const script = `${TS_REQUIRE_HOOK}
      const { createAiSpend } = require('./src/client.ts');
      createAiSpend({ disabled: true }); // an earlier client: nothing else may keep the second one alive
      let posts = 0;
      function main() {
        const client = createAiSpend({
          apiKey: 'bfu_test',
          logger: {},
          fetch: async (_url, init) => {
            posts += JSON.parse(init.body).events.length;
            return { status: 202, text: async () => '{"accepted":1,"duplicates":0,"rejected":[]}' };
          },
        });
        client.record({ provider: 'openai', model: 'gpt-5', usage: { inputTokens: 1 } });
      }
      main();
      setImmediate(() => { global.gc(); global.gc(); });
      process.on('exit', () => process.stdout.write('posts=' + posts));
    `;
    const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], { cwd: join(__dirname, '..'), encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('posts=1');
  });

  it('end to end: a real Node process that records and simply ends delivers its event', () => {
    const script = `${TS_REQUIRE_HOOK}
      const { createAiSpend } = require('./src/client.ts');
      let posts = 0;
      const client = createAiSpend({
        apiKey: 'bfu_test',
        logger: {},
        fetch: async (_url, init) => {
          posts += JSON.parse(init.body).events.length;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { status: 202, text: async () => '{"accepted":1,"duplicates":0,"rejected":[]}' };
        },
      });
      client.record({ provider: 'openai', model: 'gpt-5' });
      process.on('exit', () => process.stdout.write('posts=' + posts));
    `;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: join(__dirname, '..'), encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('posts=1');
  });
});
