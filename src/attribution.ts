import { AiSpendAttributionIssueCode } from './errors';
import type { AiSpendAttributionIssue } from './errors';
import { loadNodeBuiltin } from './runtime';
import { isRecord, isStorableText } from './util';
import { AI_SPEND_LIMITS } from './wire';
import type { AiSpendAttribution } from './wire';

/**
 * Ambient attribution: ONE AsyncLocalStorage for the whole process (stored on `globalThis`
 * under a registry symbol, so the CommonJS and ESM builds — or two copies of the package —
 * share it). `withContext` scopes attribution around a unit of work; model calls anywhere
 * below it pick it up. Resolution for an event: per-call → ambient → client defaults;
 * nested contexts override field by field and tags merge.
 */

/** JSON-serialisable snapshot of the ambient attribution, for queue job payloads. */
export interface AiSpendCarrier extends AiSpendAttribution {
  /** Carrier format version. */
  v: 1;
}

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

type AsyncLocalStorageCtor = new <T>() => AsyncLocalStorageLike<T>;

const STORAGE_KEY = Symbol.for('@bluefyn/ai-spend-sdk.attribution-storage');
const CARRIER_VERSION = 1;
const STRING_FIELDS = ['customer', 'feature', 'user', 'runId', 'entityRef'] as const;
/** Tag keys the server refuses (they would reach `Object.prototype` machinery). */
const RESERVED_TAG_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

type StringField = (typeof STRING_FIELDS)[number];
type StorageSlot = { storage: AsyncLocalStorageLike<AiSpendAttribution> | null };

function loadStorageCtor() {
  const fromNode = loadNodeBuiltin<{ AsyncLocalStorage?: AsyncLocalStorageCtor }>('node:async_hooks');

  if (typeof fromNode?.AsyncLocalStorage === 'function') {
    return fromNode.AsyncLocalStorage;
  }

  // Edge runtimes (Vercel Edge, Cloudflare with nodejs_compat) expose it globally.
  const fromGlobal = (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage;

  return typeof fromGlobal === 'function' ? (fromGlobal as AsyncLocalStorageCtor) : undefined;
}

function storage() {
  const registry = globalThis as unknown as Record<symbol, StorageSlot | undefined>;
  let slot = registry[STORAGE_KEY];

  if (!slot) {
    let created: AsyncLocalStorageLike<AiSpendAttribution> | null = null;

    try {
      const Ctor = loadStorageCtor();

      created = Ctor ? new Ctor<AiSpendAttribution>() : null;
    } catch {
      created = null;
    }

    slot = { storage: created };
    registry[STORAGE_KEY] = slot;
  }

  return slot.storage;
}

/** True when ambient context can propagate (Node ≥ 20.16 / 22.3, or a runtime with a global AsyncLocalStorage). */
export function isAmbientContextSupported() {
  return storage() !== null;
}

/** Keeps only well-typed fields (non-empty strings; string-valued tags). No length/pattern checks. */
export function pickAttribution(value: unknown) {
  const out: AiSpendAttribution = {};

  if (!isRecord(value)) {
    return out;
  }

  for (const field of STRING_FIELDS) {
    const raw = value[field];

    if (typeof raw === 'string' && raw.length > 0) {
      out[field] = raw;
    }
  }

  if (isRecord(value['tags'])) {
    const tags: Record<string, string> = {};

    for (const [key, tagValue] of Object.entries(value['tags'])) {
      if (typeof tagValue === 'string') {
        tags[key] = tagValue;
      }
    }

    if (Object.keys(tags).length > 0) {
      out.tags = tags;
    }
  }

  return out;
}

/** `override` wins field by field; tags merge (override's keys win). */
export function mergeAttribution(base: AiSpendAttribution | undefined, override: AiSpendAttribution | undefined) {
  const out: AiSpendAttribution = { ...(base ?? {}) };

  if (!override) {
    return out;
  }

  for (const field of STRING_FIELDS) {
    const value = override[field];

    if (value !== undefined) {
      out[field] = value;
    }
  }

  if (override.tags) {
    out.tags = { ...(base?.tags ?? {}), ...override.tags };
  }

  return out;
}

function copyAttribution(value: AiSpendAttribution) {
  const out: AiSpendAttribution = { ...value };

  if (value.tags) {
    out.tags = { ...value.tags };
  }

  return out;
}

/**
 * The ambient store itself — NOT a copy, so it must never be mutated or handed out. For the
 * SDK's own merges, which only ever pass it as `mergeAttribution`'s `override` (that copies it).
 */
export function ambientAttribution() {
  try {
    return storage()?.getStore();
  } catch {
    return undefined;
  }
}

/** The ambient attribution of the current async flow (a copy), or undefined outside any context. */
export function current() {
  const store = ambientAttribution();

  return store ? copyAttribution(store) : undefined;
}

/**
 * Run `fn` with `attrs` merged over the enclosing context. Errors from `fn` propagate
 * untouched; the SDK itself never throws here (without AsyncLocalStorage `fn` just runs).
 */
export function withContext<T>(attrs: AiSpendAttribution, fn: () => T) {
  let merged: AiSpendAttribution | undefined;
  let als: AsyncLocalStorageLike<AiSpendAttribution> | null = null;

  try {
    als = storage();
    merged = mergeAttribution(current(), pickAttribution(attrs));

    if (!als) warnAmbientUnavailable();
  } catch {
    als = null;
  }

  return als && merged ? als.run(merged, fn) : fn();
}

// ---------------------------------------------------------------- "no AsyncLocalStorage" warning

type AmbientWarner = (message: string) => void;

const AMBIENT_UNAVAILABLE_MESSAGE =
  'AI Spend: AsyncLocalStorage is unavailable in this runtime (needs Node ≥ 20.16 / 22.3), so withContext / withCarried attribution does not propagate — pass customer/feature per call instead';
let ambientWarner: AmbientWarner | undefined;
let ambientWarned = false;

/** The first client's logger receives the one-time "no AsyncLocalStorage" warning (else `console`). */
export function registerAmbientWarner(warn: AmbientWarner) {
  ambientWarner ??= warn;
}

/** Warn ONCE per process that ambient attribution cannot propagate here. */
function warnAmbientUnavailable() {
  if (ambientWarned) return;

  ambientWarned = true;

  try {
    if (ambientWarner) {
      ambientWarner(AMBIENT_UNAVAILABLE_MESSAGE);
    } else {
      // Standalone package: no logger was registered yet, so the documented default (console) is used.
      console.warn(`[ai-spend] ${AMBIENT_UNAVAILABLE_MESSAGE}`);
    }
  } catch {
    // warning is best-effort
  }
}

/** Serialisable snapshot of the ambient attribution (`undefined` outside any context). */
export function carry() {
  const ambient = current();

  if (!ambient) {
    return undefined;
  }

  const carrier: AiSpendCarrier = { v: CARRIER_VERSION, ...ambient };

  return carrier;
}

/** Parse a carrier that went through JSON (tolerant: unknown fields ignored, garbage → undefined). */
function parseCarrier(carrier: unknown) {
  if (!isRecord(carrier) || typeof carrier['v'] !== 'number') {
    return undefined;
  }

  return pickAttribution(carrier);
}

/** Restore a carried attribution (e.g. in a queue worker) around `fn`. A missing/invalid carrier just runs `fn`. */
export function withCarried<T>(carrier: AiSpendCarrier | null | undefined | unknown, fn: () => T) {
  let attrs: AiSpendAttribution | undefined;

  try {
    attrs = parseCarrier(carrier);
  } catch {
    attrs = undefined;
  }

  return attrs ? withContext(attrs, fn) : fn();
}

// ---------------------------------------------------------------- validation

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The PII guard on `customer` / `user` ids (attribution warns; `nameCustomer()` refuses the id). */
export function looksLikeEmail(value: string) {
  return EMAIL_PATTERN.test(value);
}

export function isValidFeature(feature: string) {
  return feature.length <= AI_SPEND_LIMITS.FEATURE_MAX_LENGTH && AI_SPEND_LIMITS.FEATURE_PATTERN.test(feature);
}

const MAX_LENGTH: Record<StringField, number> = {
  customer: AI_SPEND_LIMITS.CUSTOMER_MAX_LENGTH,
  feature: AI_SPEND_LIMITS.FEATURE_MAX_LENGTH,
  user: AI_SPEND_LIMITS.USER_MAX_LENGTH,
  runId: AI_SPEND_LIMITS.RUN_ID_MAX_LENGTH,
  entityRef: AI_SPEND_LIMITS.ENTITY_REF_MAX_LENGTH,
};

function issue(code: AiSpendAttributionIssueCode, field: string, message: string) {
  const result: AiSpendAttributionIssue = { code, field, message };

  return result;
}

/**
 * Validate a resolved attribution against the wire limits. Invalid values are DROPPED (the
 * event is still sent, just less attributed) and reported as issues; values are never echoed
 * into messages (they may be PII).
 */
export function validateAttribution(attribution: AiSpendAttribution) {
  const valid: AiSpendAttribution = {};
  const issues: AiSpendAttributionIssue[] = [];

  for (const field of STRING_FIELDS) {
    const value = attribution[field];

    if (value === undefined) {
      continue;
    }

    if (!isStorableText(value)) {
      issues.push(issue(AiSpendAttributionIssueCode.INVALID_VALUE, field, `${field} contains a NUL character or malformed text (a lone surrogate) and was dropped`));
      continue;
    }

    if (value.length > MAX_LENGTH[field]) {
      issues.push(issue(AiSpendAttributionIssueCode.INVALID_VALUE, field, `${field} is longer than ${MAX_LENGTH[field]} characters and was dropped`));
      continue;
    }

    if (field === 'feature' && !isValidFeature(value)) {
      issues.push(
        issue(
          AiSpendAttributionIssueCode.INVALID_VALUE,
          field,
          'feature must be a lowercase dot-path of ≤6 segments of [a-z0-9_-] (e.g. "support.chat.summarize") and was dropped',
        ),
      );
      continue;
    }

    if ((field === 'customer' || field === 'user') && looksLikeEmail(value)) {
      issues.push(issue(AiSpendAttributionIssueCode.EMAIL_LIKE, field, `${field} looks like an email address — send an opaque id, never PII`));
    }

    valid[field] = value;
  }

  if (attribution.tags) {
    const tags: Record<string, string> = {};
    let kept = 0;

    for (const [key, value] of Object.entries(attribution.tags)) {
      if (!AI_SPEND_LIMITS.TAG_KEY_PATTERN.test(key) || RESERVED_TAG_KEYS.has(key)) {
        issues.push(issue(AiSpendAttributionIssueCode.INVALID_VALUE, 'tags', 'a tag key must match [a-z0-9_.-]{1,40} and not be __proto__ / constructor / prototype; the tag was dropped'));
        continue;
      }

      if (typeof value !== 'string' || !isStorableText(value)) {
        issues.push(issue(AiSpendAttributionIssueCode.INVALID_VALUE, `tags.${key}`, 'tag value is not a string, or contains a NUL character or malformed text, and was dropped'));
        continue;
      }

      if (value.length > AI_SPEND_LIMITS.TAG_VALUE_MAX_LENGTH) {
        issues.push(issue(AiSpendAttributionIssueCode.INVALID_VALUE, `tags.${key}`, `tag value is longer than ${AI_SPEND_LIMITS.TAG_VALUE_MAX_LENGTH} characters and was dropped`));
        continue;
      }

      if (kept >= AI_SPEND_LIMITS.MAX_TAGS) {
        issues.push(issue(AiSpendAttributionIssueCode.INVALID_VALUE, 'tags', `more than ${AI_SPEND_LIMITS.MAX_TAGS} tags; the extra tags were dropped`));
        break;
      }

      tags[key] = value;
      kept++;
    }

    if (kept > 0) {
      valid.tags = tags;
    }
  }

  return { attribution: valid, issues };
}

/** Missing-attribution issues (the call is still recorded — it lands in "Unattributed"). */
export function missingAttributionIssues(attribution: AiSpendAttribution) {
  const issues: AiSpendAttributionIssue[] = [];

  if (!attribution.customer) {
    issues.push(issue(AiSpendAttributionIssueCode.MISSING_CUSTOMER, 'customer', 'no customer on this AI call — wrap the work in withContext({ customer }) or pass customer per call'));
  }

  if (!attribution.feature) {
    issues.push(issue(AiSpendAttributionIssueCode.MISSING_FEATURE, 'feature', 'no feature on this AI call — set defaultFeature, withContext({ feature }) or a per-call feature'));
  }

  return issues;
}
