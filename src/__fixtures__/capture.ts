import { createAiSpend } from '../client';
import type { AiSpendClient, AiSpendOptions } from '../client';
import type { AiSpendFetch } from '../delivery';
import type { AiSpendUsageRecord, AiSpendWireBatch, AiSpendWireEvent } from '../wire';

/** A real AI Spend client whose deliveries are captured in memory (spec helper). */
export function captureClient(options: AiSpendOptions = {}) {
  const events: AiSpendWireEvent[] = [];

  const fetch: AiSpendFetch = async (_url, init) => {
    const batch = JSON.parse(init.body) as AiSpendWireBatch;

    events.push(...batch.events);

    return { status: 202, text: async () => JSON.stringify({ accepted: batch.events.length, duplicates: 0, rejected: [] }) };
  };

  const client = createAiSpend({ apiKey: 'bfu_test', fetch, logger: {}, warnOnMissingAttribution: false, ...options });

  /** Flush, then return every event delivered so far. */
  const flushed = async () => {
    await client.flush();

    return events;
  };

  return { client, events, flushed };
}

/** A structural AI Spend client double whose `record()` captures (or throws). */
export function recordingDouble(options: { throwOnRecord?: boolean; enabled?: boolean } = {}) {
  const records: AiSpendUsageRecord[] = [];
  const client: AiSpendClient = {
    enabled: options.enabled ?? true,
    record: (usage) => {
      if (options.throwOnRecord) {
        throw new TypeError('record blew up');
      }

      records.push(usage);
    },
    nameCustomer: () => undefined,
    flush: async () => undefined,
    shutdown: async () => undefined,
    stats: () => ({
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
      customerNames: { queued: 0, acknowledged: 0, rejected: 0, dropped: 0 },
    }),
    withContext: (_attrs, fn) => fn(),
    current: () => undefined,
    carry: () => undefined,
    withCarried: (_carrier, fn) => fn(),
  };

  return { client, records };
}

/** Collect an async iterable. */
export async function drain<T>(iterable: AsyncIterable<T>) {
  const out: T[] = [];

  for await (const item of iterable) {
    out.push(item);
  }

  return out;
}

/** Read a web ReadableStream of newline-separated JSON (a Stainless `toReadableStream()`) back into items. */
export async function readJsonLines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  for (;;) {
    const { value, done } = await reader.read();

    if (done) break;

    text += decoder.decode(value, { stream: true });
  }

  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
