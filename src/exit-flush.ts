/**
 * Natural-exit delivery (Node only). The SDK's timers are unref'd — they never keep a process
 * alive — so a script, cron job, CLI or k8s Job that ends WITHOUT calling `shutdown()` would
 * exit with its last events still buffered. Node emits `beforeExit` when the event loop runs
 * dry; on it, every live client flushes, and the in-flight request keeps the loop alive until
 * it is delivered. On `exit` (synchronous — nothing can be sent any more) a client that still
 * holds events logs ONE warning, so a remaining loss is never silent.
 *
 * ONE pair of process listeners serves every client (registered on first use, shared across the
 * CommonJS and ESM builds through a registry symbol). A client is held STRONGLY while it has
 * something to send (`hold()` on every enqueue, `releaseIfIdle()` once its queues are empty), so a
 * client created in a function and dropped without `shutdown()` cannot be garbage-collected with
 * events still buffered; an idle client is held weakly, so the hooks never keep it alive. A client
 * leaves on `shutdown()`. Signals are untouched: SIGTERM / SIGINT handling stays the application's.
 */

/** What a client exposes to the exit hooks. */
export interface ExitFlushTarget {
  /** Events + customer names still buffered (not yet acknowledged). */
  pending(): number;
  /** Send what is buffered now (never throws). */
  flush(): Promise<void>;
  /** Called on `exit` when `pending() > 0`. */
  warnUnsent(count: number): void;
}

interface ProcessEvents {
  on(event: string, listener: () => void): unknown;
}

interface WeakRefLike<T> {
  deref(): T | undefined;
}

type WeakRefCtor = new <T extends object>(target: T) => WeakRefLike<T>;

interface Entry {
  ref: WeakRefLike<ExitFlushTarget>;
  /** Set while the target has pending work: keeps a client the application dropped alive until it is delivered. */
  strong: ExitFlushTarget | undefined;
  /** `pending()` when its last `beforeExit` flush started — no progress since → no new attempt. */
  lastAttemptPending: number | undefined;
}

interface Registry {
  entries: Set<Entry>;
}

const REGISTRY_KEY = Symbol.for('@bluefyn/ai-spend-sdk.exit-flush');

function processEvents() {
  try {
    const proc = typeof process === 'undefined' ? undefined : (process as unknown as Partial<ProcessEvents>);

    return proc && typeof proc.on === 'function' ? (proc as ProcessEvents) : undefined;
  } catch {
    return undefined;
  }
}

function liveTargets(registry: Registry) {
  const live: Array<{ entry: Entry; target: ExitFlushTarget }> = [];

  for (const entry of registry.entries) {
    const target = entry.ref.deref();

    if (target) {
      live.push({ entry, target });
    } else {
      registry.entries.delete(entry);
    }
  }

  return live;
}

function onBeforeExit(registry: Registry) {
  for (const { entry, target } of liveTargets(registry)) {
    try {
      const pending = target.pending();

      // Nothing to send — or the last attempt made no progress (a pause, backoff): exit.
      if (pending === 0 || pending === entry.lastAttemptPending) continue;

      entry.lastAttemptPending = pending;
      void target.flush();
    } catch {
      // never let an exit hook throw
    }
  }
}

function onExit(registry: Registry) {
  for (const { target } of liveTargets(registry)) {
    try {
      const pending = target.pending();

      if (pending > 0) target.warnUnsent(pending);
    } catch {
      // never let an exit hook throw
    }
  }
}

function registry() {
  const slots = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = slots[REGISTRY_KEY];

  if (existing) return existing;

  const events = processEvents();

  if (!events) return undefined;

  const created: Registry = { entries: new Set() };

  slots[REGISTRY_KEY] = created;
  events.on('beforeExit', () => onBeforeExit(created));
  events.on('exit', () => onExit(created));

  return created;
}

/** What the `beforeExit` listener runs (exported for specs — emitting a real `exit` is not an option there). */
export function handleBeforeExit() {
  const reg = (globalThis as unknown as Record<symbol, Registry | undefined>)[REGISTRY_KEY];

  if (reg) onBeforeExit(reg);
}

/** What the `exit` listener runs (exported for specs). */
export function handleExit() {
  const reg = (globalThis as unknown as Record<symbol, Registry | undefined>)[REGISTRY_KEY];

  if (reg) onExit(reg);
}

/** Targets currently held strongly (exported for specs). */
export function heldExitFlushTargets() {
  const reg = (globalThis as unknown as Record<symbol, Registry | undefined>)[REGISTRY_KEY];
  let held = 0;

  for (const entry of reg?.entries ?? []) {
    if (entry.strong) held++;
  }

  return held;
}

/** A client's membership of the natural-exit flush. Every method is a no-op outside Node and never throws. */
export interface ExitFlushRegistration {
  /** Leave the exit hooks (`shutdown()`). */
  unregister(): void;
  /** Something was queued: hold the target strongly until it is idle again. */
  hold(): void;
  /** Drop the strong hold once nothing is pending (the target stays registered, weakly). */
  releaseIfIdle(): void;
}

const NO_REGISTRATION: ExitFlushRegistration = {
  unregister: () => undefined,
  hold: () => undefined,
  releaseIfIdle: () => undefined,
};

/**
 * Flush `target` when the process runs out of work, and warn at exit if events are left.
 * Returns the registration (`unregister()` is called by `shutdown()`); a no-op outside Node.
 */
export function registerExitFlush(target: ExitFlushTarget) {
  try {
    const WeakRefImpl = (globalThis as { WeakRef?: unknown }).WeakRef;
    const reg = typeof WeakRefImpl === 'function' ? registry() : undefined;

    if (!reg) return NO_REGISTRATION;

    const entry: Entry = { ref: new (WeakRefImpl as WeakRefCtor)(target), strong: undefined, lastAttemptPending: undefined };

    reg.entries.add(entry);

    const registration: ExitFlushRegistration = {
      unregister: () => {
        entry.strong = undefined;
        reg.entries.delete(entry);
      },
      hold: () => {
        if (!entry.strong && reg.entries.has(entry)) entry.strong = entry.ref.deref();
      },
      releaseIfIdle: () => {
        try {
          if (entry.strong && entry.strong.pending() === 0) entry.strong = undefined;
        } catch {
          // keep holding: a target that cannot say is treated as busy
        }
      },
    };

    return registration;
  } catch {
    return NO_REGISTRATION;
  }
}
