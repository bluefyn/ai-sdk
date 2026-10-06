import { loadNodeBuiltin } from './runtime';

/**
 * RFC 9562 UUIDv7: 48-bit Unix-ms timestamp, version 7, 12-bit `rand_a`, variant `10`,
 * 62-bit `rand_b`. Ids from the process clock (`uuidv7()`) are monotonic (RFC 9562 §6.2
 * method 1, "fixed bit-length dedicated counter"): inside one millisecond a 26-bit counter
 * (`rand_a` + the top 14 bits of `rand_b`) seeded at a random 24-bit value is incremented;
 * when it overflows, or the clock steps backwards, the timestamp is advanced by 1 ms instead. An explicit `uuidv7(ms)` embeds exactly that (clamped) timestamp, is ordered
 * only within that millisecond, and never touches the process clock state.
 */

type FillRandom = (bytes: Uint8Array) => void;

interface CryptoLike {
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
  randomFillSync?: (bytes: Uint8Array) => Uint8Array;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/** 26-bit counter: 12 bits of `rand_a` + 14 bits of `rand_b`. */
const COUNTER_MAX = 2 ** 26 - 1;
const SEED_MASK = 0xffffff;
const MAX_TIMESTAMP_MS = 2 ** 48 - 1;

interface Clock {
  lastMs: number;
  counter: number;
}

let fillRandom: FillRandom | undefined;
/** Process-wide monotonic state of `uuidv7()`. */
const processClock: Clock = { lastMs: -1, counter: 0 };
/** Separate state for explicit timestamps (in-millisecond ordering only). */
const explicitClock: Clock = { lastMs: -1, counter: 0 };

function resolveRandom() {
  const web = (globalThis as { crypto?: CryptoLike }).crypto;
  let fill: FillRandom;

  if (typeof web?.getRandomValues === 'function') {
    const getRandomValues = web.getRandomValues.bind(web);

    fill = (bytes) => {
      getRandomValues(bytes);
    };

    return fill;
  }

  const nodeCrypto = loadNodeBuiltin<CryptoLike>('node:crypto');

  if (typeof nodeCrypto?.randomFillSync === 'function') {
    const randomFillSync = nodeCrypto.randomFillSync.bind(nodeCrypto);

    fill = (bytes) => {
      randomFillSync(bytes);
    };

    return fill;
  }

  // Last resort (no Web Crypto, no Node ≥ 20.16): uniqueness, not secrecy, is what event ids need.
  fill = (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  };

  return fill;
}

function randomBytes(length: number) {
  fillRandom ??= resolveRandom();

  const bytes = new Uint8Array(length);

  fillRandom(bytes);

  return bytes;
}

/** Next (timestamp, counter) of the process clock — strictly increasing across calls. */
function nextMonotonic(nowMs: number, seed: number) {
  const clock = processClock;

  if (nowMs > clock.lastMs) {
    clock.lastMs = nowMs;
    clock.counter = seed & SEED_MASK; // ≤ 2^24: leaves ≥ 50M increments before overflow
  } else if (clock.counter < COUNTER_MAX) {
    clock.counter++;
  } else if (clock.lastMs < MAX_TIMESTAMP_MS) {
    clock.lastMs++;
    clock.counter = seed & SEED_MASK;
  } else {
    clock.counter = seed & SEED_MASK; // 48-bit timestamp exhausted (year 10889): random only
  }

  return { ms: clock.lastMs, counter: clock.counter };
}

/** Explicit timestamp: kept as given; ordered only against the previous call for the same millisecond. */
function nextExplicit(ms: number, seed: number) {
  const clock = explicitClock;

  if (ms === clock.lastMs && clock.counter < COUNTER_MAX) {
    clock.counter++;
  } else {
    clock.lastMs = ms;
    clock.counter = seed & SEED_MASK;
  }

  return { ms, counter: clock.counter };
}

function clampTimestamp(ms: number) {
  return Number.isFinite(ms) ? Math.min(Math.max(0, Math.floor(ms)), MAX_TIMESTAMP_MS) : 0;
}

/**
 * A new RFC 9562 version-7 UUID string (lowercase, hyphenated). Without an argument it uses
 * the process clock (monotonic); with `nowMs` it embeds that timestamp (clamped to 48 bits).
 */
export function uuidv7(nowMs?: number) {
  const bytes = randomBytes(16);
  const seed = (bytes[10] << 16) | (bytes[11] << 8) | bytes[12];
  const { ms, counter: sequence } =
    nowMs === undefined ? nextMonotonic(clampTimestamp(Date.now()), seed) : nextExplicit(clampTimestamp(nowMs), seed);

  // 48-bit big-endian timestamp (split: bit ops are 32-bit in JS).
  const high = Math.floor(ms / 0x100000000);
  const low = ms >>> 0;

  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;
  bytes[6] = 0x70 | ((sequence >>> 22) & 0x0f); // version 7 + counter bits 25..22
  bytes[7] = (sequence >>> 14) & 0xff; // counter bits 21..14 (rest of rand_a)
  bytes[8] = 0x80 | ((sequence >>> 8) & 0x3f); // variant 10 + counter bits 13..8
  bytes[9] = sequence & 0xff; // counter bits 7..0

  let out = '';

  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i]];

    if (i === 3 || i === 5 || i === 7 || i === 9) {
      out += '-';
    }
  }

  return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
