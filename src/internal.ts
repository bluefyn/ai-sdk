import type { AiSpendClient } from './client';
import type { AiSpendAttribution, AiSpendUsageRecord } from './wire';

/**
 * Adapter ↔ client handshake, NOT public API. Stored under a registry symbol on the client
 * object (`Symbol.for`), so an adapter loaded from the ESM build still finds a client created
 * by the CommonJS build. A client that is not ours (a test double) has no handle — adapters
 * then fall back to its public `record()`.
 */
export interface AiSpendClientInternal {
  recordFrom(adapter: string, usage: AiSpendUsageRecord, warnKey?: string): void;
  /**
   * Throws `AiSpendAttributionError` in strict mode when the resolved attribution is
   * incomplete/invalid. `ambient` is the ambient attribution the adapter read in this same
   * synchronous turn (so it is not read twice).
   */
  assertAttribution(perCall: AiSpendAttribution, ambient: AiSpendAttribution | undefined): void;
  /** A data-quality warning through the client's logger, once per `key` for the client's lifetime. */
  warnOnce(key: string, message: string): void;
  /** A debug line through the client's logger. */
  debug(message: string, meta?: Record<string, unknown>): void;
  readonly strict: boolean;
}

const INTERNAL = Symbol.for('@bluefyn/ai-spend-sdk.internal');

export function registerInternal(client: object, internal: AiSpendClientInternal) {
  Object.defineProperty(client, INTERNAL, { value: internal, enumerable: false });
}

function isInternal(value: unknown): value is AiSpendClientInternal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { recordFrom?: unknown }).recordFrom === 'function' &&
    typeof (value as { assertAttribution?: unknown }).assertAttribution === 'function'
  );
}

export function internalOf(client: unknown) {
  if (typeof client !== 'object' || client === null) return undefined;

  const handle = (client as Record<symbol, unknown>)[INTERNAL];

  return isInternal(handle) ? handle : undefined;
}

/** Record an adapter's event: through the internal handle (so it carries `adapter`), else — a client that is not ours — its public `record()`. */
export function recordVia(client: AiSpendClient, internal: AiSpendClientInternal | undefined, adapter: string, usage: AiSpendUsageRecord, warnKey: string) {
  if (internal) {
    internal.recordFrom(adapter, usage, warnKey);
  } else {
    client.record(usage);
  }
}
