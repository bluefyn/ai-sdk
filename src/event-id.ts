/**
 * Deterministic event ids: RFC 9562 UUIDv5 (SHA-1 name-based). Pure JavaScript and synchronous,
 * so it behaves the same in Node, edge runtimes and bundles (Web Crypto's digest is async-only).
 * SHA-1 is used for its RFC-mandated id derivation here, not for security.
 */

/**
 * The SDK's own UUIDv5 namespace for event ids: `uuidv5(NAMESPACE_URL,
 * 'https://bluefyn.ai/ai-spend-sdk/event-id')`. Never change it — every id derived from a key
 * would change with it, and replays would stop deduplicating.
 */
export const AI_SPEND_EVENT_ID_NAMESPACE = '2fceca2d-7953-5842-90e7-c6d0858cb006';

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, like `TextEncoder`). */
function utf8Bytes(value: string) {
  const bytes: number[] = [];

  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }

  return bytes;
}

function rotl(value: number, bits: number) {
  return (value << bits) | (value >>> (32 - bits));
}

/** SHA-1 (FIPS 180-4) of `message` → 20 bytes. */
export function sha1(message: readonly number[]) {
  const bitLength = message.length * 8;
  const padded = [...message, 0x80];

  while (padded.length % 64 !== 56) padded.push(0);

  // 64-bit big-endian length (messages here are far below 2^32 bits).
  padded.push(0, 0, 0, 0, (bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t++) {
      const j = offset + t * 4;

      w[t] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
    }

    for (let t = 16; t < 80; t++) {
      w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;

      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotl(a, 5) + f + e + k + w[t]) | 0;

      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const digest: number[] = [];

  for (const word of [h0, h1, h2, h3, h4]) {
    digest.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }

  return digest;
}

function uuidBytes(uuid: string) {
  const hex = uuid.replace(/-/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < 32; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }

  return bytes;
}

/** RFC 9562 UUIDv5 of `name` in `namespace` (a UUID string). Lowercase, hyphenated. */
export function uuidv5(name: string, namespace: string) {
  const hash = sha1([...uuidBytes(namespace), ...utf8Bytes(name)]);

  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant 10

  let out = '';

  for (let i = 0; i < 16; i++) {
    out += HEX[hash[i]];

    if (i === 3 || i === 5 || i === 7 || i === 9) {
      out += '-';
    }
  }

  return out;
}

/**
 * A deterministic event id for YOUR idempotency key: the same key always gives the same UUID, so
 * a replayed `record({ eventId: eventIdFrom(`${job.id}:${step}`), occurredAt, … })` is counted
 * once — the server dedupes on the id across its 30-day ingest window (resend the original
 * `occurredAt` too, so the event is booked on the day of the call). A key that
 * already is a UUID is returned as is (lower-cased). `record()` applies this to any non-UUID
 * `eventId` by itself; use it where you need the id up front (e.g. to store it with the job).
 */
export function eventIdFrom(key: string) {
  if (UUID_PATTERN.test(key)) return key.toLowerCase();

  return uuidv5(key, AI_SPEND_EVENT_ID_NAMESPACE);
}
