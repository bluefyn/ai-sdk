/**
 * Small helpers shared across the SDK. NOT public API. A leaf module (it imports nothing), so
 * any module can use it without creating an import cycle.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a record, or an empty one — for defensive bracket reads of provider payloads. */
export function rec(value: unknown) {
  const out: Record<string, unknown> = isRecord(value) ? value : {};

  return out;
}

/** The value when it is a non-empty string, else undefined. */
export function str(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Run `fn`, swallowing anything it throws: the recording path must never fail — or slow — the caller's AI call. */
export function safe(fn: () => void) {
  try {
    fn();
  } catch {
    // swallowed on purpose
  }
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Text the server can store (Postgres refuses both): no NUL, no unpaired UTF-16 surrogate —
 * `JSON.stringify` escapes a lone surrogate to `\ud800`, which JSONB rejects.
 */
export function isStorableText(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code === 0 || isLowSurrogate(code)) return false;

    if (isHighSurrogate(code)) {
      if (!isLowSurrogate(value.charCodeAt(i + 1))) return false;
      i += 1;
    }
  }

  return true;
}

/**
 * `value` made storable and cut so that BOTH it and its lower-cased form are at most `maxLength`
 * UTF-16 code units (the server bounds lower-cased forms: `'İ'.toLowerCase()` is two units) —
 * NUL and lone surrogates dropped, a surrogate pair never split.
 */
export function clipText(value: string, maxLength: number) {
  let out = '';

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    let char: string;

    if (isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(i + 1))) {
      char = value.slice(i, i + 2);
      i += 1;
    } else if (code === 0 || isHighSurrogate(code) || isLowSurrogate(code)) {
      continue;
    } else {
      char = value[i];
    }

    const next = out + char;

    if (next.length > maxLength || next.toLowerCase().length > maxLength) break;

    out = next;
  }

  return out;
}
