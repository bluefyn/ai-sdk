/**
 * Every error the SDK surfaces (via `onError`, or thrown by strict mode) extends
 * {@link AiSpendSdkError}, so a caller can tell SDK problems apart from its own.
 *
 * The SDK NEVER throws into application code on its own initiative — the only
 * synchronous throws are {@link AiSpendAttributionError} and {@link AiSpendInvalidUsageError}
 * from `record()` when the client was created with `strict: true` (meant for test suites).
 */
export class AiSpendSdkError extends Error {
  public override readonly name: string = 'AiSpendSdkError';

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message);

    if (options && 'cause' in options) {
      // Assigned rather than passed to `super` so ES2020 targets (no ErrorOptions) still carry it.
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false, writable: true, configurable: true });
    }
  }
}

/** Why an attribution value was flagged. */
export const AiSpendAttributionIssueCode = {
  MISSING_CUSTOMER: 'missing_customer',
  MISSING_FEATURE: 'missing_feature',
  INVALID_VALUE: 'invalid_value',
  EMAIL_LIKE: 'email_like',
} as const;
export type AiSpendAttributionIssueCode = (typeof AiSpendAttributionIssueCode)[keyof typeof AiSpendAttributionIssueCode];

export interface AiSpendAttributionIssue {
  code: AiSpendAttributionIssueCode;
  /** The attribution field concerned (`customer`, `feature`, `tags.region`, …). */
  field: string;
  message: string;
}

/** Thrown (strict mode only) when a recorded call is missing customer/feature or carries an invalid value. */
export class AiSpendAttributionError extends AiSpendSdkError {
  public override readonly name: string = 'AiSpendAttributionError';
  public readonly issues: readonly AiSpendAttributionIssue[];

  public constructor(issues: readonly AiSpendAttributionIssue[]) {
    super(`AI Spend attribution: ${issues.map((issue) => issue.message).join('; ')}`);
    this.issues = issues;
  }
}

/** Why a manual `record()` usage was flagged. */
export const AiSpendUsageIssueCode = {
  /** `usage` has keys the SDK does not know (e.g. `input` for `inputTokens`) — their values were ignored. */
  UNKNOWN_KEY: 'unknown_usage_key',
  /** `usage` is not an object. */
  NOT_AN_OBJECT: 'usage_not_an_object',
  /** A `success` event with no tokens of any kind, no tool requests and no cost — stored unpriced at $0. */
  EMPTY: 'empty_usage',
} as const;
export type AiSpendUsageIssueCode = (typeof AiSpendUsageIssueCode)[keyof typeof AiSpendUsageIssueCode];

export interface AiSpendUsageIssue {
  code: AiSpendUsageIssueCode;
  /** The offending `usage` keys (`unknown_usage_key` only). */
  keys: readonly string[];
  message: string;
}

/**
 * Thrown (strict mode only) by a manual `record()` whose `usage` has unknown keys, is not an
 * object, or reports nothing billable on a `success` event. Outside strict mode the same problems
 * are warned once per call site and counted in `stats().invalidUsage`; the event is still sent.
 */
export class AiSpendInvalidUsageError extends AiSpendSdkError {
  public override readonly name: string = 'AiSpendInvalidUsageError';
  public readonly issues: readonly AiSpendUsageIssue[];

  public constructor(issues: readonly AiSpendUsageIssue[]) {
    super(`AI Spend usage: ${issues.map((issue) => issue.message).join('; ')}`);
    this.issues = issues;
  }
}

/**
 * A batch of events — or a request of customer names (`nameCustomer()`) — could not be
 * delivered (auth failure, retries exhausted, unexpected HTTP status, shutdown deadline).
 */
export class AiSpendDeliveryError extends AiSpendSdkError {
  public override readonly name: string = 'AiSpendDeliveryError';
  /** HTTP status when the server answered; undefined for network errors. */
  public readonly status: number | undefined;
  /** Events in the affected batch (0 for a customer-names request). */
  public readonly eventCount: number;
  /** Customer names in the affected request (0 for an event batch). */
  public readonly customerNameCount: number;

  public constructor(message: string, details: { status?: number; eventCount: number; customerNameCount?: number; cause?: unknown }) {
    super(message, { cause: details.cause });
    this.status = details.status;
    this.eventCount = details.eventCount;
    this.customerNameCount = details.customerNameCount ?? 0;
  }
}

/**
 * The server (or the SDK's own pre-flight check) refused an event. `code` is one of the
 * wire rejection codes (`invalid_schema`, `occurred_at_out_of_range`, …) or `http_<status>` when a
 * whole batch was refused without a per-event code.
 */
export class AiSpendRejectedEventError extends AiSpendSdkError {
  public override readonly name: string = 'AiSpendRejectedEventError';
  public readonly code: string;
  public readonly eventId: string | undefined;
  /** Index of the event in its batch, when the server reported one. */
  public readonly index: number | undefined;
  public readonly detail: string;

  public constructor(details: { code: string; detail: string; eventId?: string; index?: number }) {
    super(`AI Spend rejected event${details.eventId ? ` ${details.eventId}` : ''}: ${details.code} — ${details.detail}`);
    this.code = details.code;
    this.detail = details.detail;
    this.eventId = details.eventId;
    this.index = details.index;
  }
}

/**
 * The server STORED events but dropped invalid attribution / diagnostic fields from them (the
 * `202` `warnings`: `field_dropped`, `tags_truncated`). Their usage and cost were kept — never
 * resend them; fix the field in later events. Reported at most once a minute, carrying every
 * warning since the previous report; the latest one is described by `code` / `field` / `detail`.
 */
export class AiSpendFieldWarningError extends AiSpendSdkError {
  public override readonly name: string = 'AiSpendFieldWarningError';
  /** Field warnings since the previous report (an event can carry several). */
  public readonly count: number;
  /** Distinct wire fields concerned since the previous report (`feature`, `tags.region`, …; at most 20). */
  public readonly fields: readonly string[];
  public readonly code: string;
  public readonly field: string;
  public readonly detail: string;
  /** The latest warned event's id, when the server reported one. */
  public readonly eventId: string | undefined;

  public constructor(details: { count: number; fields: readonly string[]; code: string; field: string; detail: string; eventId?: string }) {
    super(`AI Spend dropped ${details.count} invalid field${details.count === 1 ? '' : 's'} from stored events (${details.fields.join(', ')}): ${details.code} — ${details.detail}`);
    this.count = details.count;
    this.fields = details.fields;
    this.code = details.code;
    this.field = details.field;
    this.detail = details.detail;
    this.eventId = details.eventId;
  }
}

/**
 * A customer name (`nameCustomer()`) was refused — by the server, or by the SDK's own check
 * before sending. `code` is the server's reason, `http_<status>` when a whole request was
 * refused without one, or the SDK's own `invalid_customer` / `customer_email_like` /
 * `invalid_display_name`. The refused value is never part of the message (it may be PII).
 */
export class AiSpendRejectedCustomerNameError extends AiSpendSdkError {
  public override readonly name: string = 'AiSpendRejectedCustomerNameError';
  public readonly code: string;
  /** The customer id the name was sent for, when the server identified the entry. */
  public readonly customer: string | undefined;
  /** Index of the entry in its request, when the server reported one. */
  public readonly index: number | undefined;
  public readonly detail: string;

  public constructor(details: { code: string; detail: string; customer?: string; index?: number }) {
    super(`AI Spend rejected a customer name: ${details.code} — ${details.detail}`);
    this.code = details.code;
    this.detail = details.detail;
    this.customer = details.customer;
    this.index = details.index;
  }
}
