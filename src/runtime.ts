/**
 * Runtime probing. The SDK is compiled to CommonJS AND ESM from the same source, may be
 * bundled by any toolchain, and must not crash when a browser bundle pulls it in
 * (it disables itself there) — so Node built-ins are never imported statically.
 */

interface ProcessLike {
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (id: string) => unknown;
}

function processRef() {
  return typeof process === 'undefined' ? undefined : (process as unknown as ProcessLike);
}

/**
 * Loads a Node built-in WITHOUT a static import or a `require()` call, via
 * `process.getBuiltinModule` (Node ≥ 20.16 / 22.3; works from ESM and CJS). Bundlers never
 * see a `node:` specifier, so a browser or edge bundle that pulls the SDK in still builds.
 * Returns undefined anywhere else (browser, edge runtimes, Node < 20.16) — callers degrade.
 */
export function loadNodeBuiltin<T>(id: string) {
  try {
    const loaded = processRef()?.getBuiltinModule?.(id);

    return loaded ? (loaded as T) : undefined;
  } catch {
    return undefined;
  }
}

export function readEnv(name: string) {
  try {
    const value = processRef()?.env?.[name];

    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A real browser page (not a server runtime that happens to polyfill `window`). */
export function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** Never let a timer keep the process alive. */
export function unrefTimer(timer: unknown) {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const unref = (timer as { unref?: unknown }).unref;

    if (typeof unref === 'function') {
      unref.call(timer);
    }
  }
}

/** UTF-8 byte length of a string without allocating (no Buffer/TextEncoder dependency). */
export function utf8Length(value: string) {
  let bytes = 0;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}
