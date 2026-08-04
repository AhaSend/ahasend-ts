import type { IdempotencyExecutionRecord } from "./idempotency.js";
// Type-only: erased at build time, so this does not create a runtime cycle with
// rate-limit.ts, which imports this module's error classes.
import type { RateLimitCategory } from "./rate-limit.js";

const AHASEND_ERROR_BRAND = Symbol.for("@ahasend/sdk.error");
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");
/** Depth past which a `cause` chain is redacted rather than followed. */
const MAX_CAUSE_DEPTH = 4;

const REDACTED = "[REDACTED]" as const;
const HTTP_MONTHS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const HTTP_SHORT_WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HTTP_LONG_WEEKDAYS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export type AhaSendErrorCode =
  | "ahasend_error"
  | "configuration_error"
  | "connection_error"
  | "abort_error"
  | "timeout_error"
  | "response_parse_error"
  | "api_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "bad_request_error"
  | "conflict_error"
  | "idempotency_conflict_error"
  | "unprocessable_entity_error"
  | "idempotency_mismatch_error"
  | "rate_limit_error"
  | "rate_limit_queue_full_error"
  | "response_too_large_error"
  | "server_error"
  | "webhook_verification_error";

const AHASEND_API_ERROR_CODES: ReadonlySet<AhaSendErrorCode> = new Set([
  "api_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "bad_request_error",
  "conflict_error",
  "idempotency_conflict_error",
  "unprocessable_entity_error",
  "idempotency_mismatch_error",
  "rate_limit_error",
  "server_error",
]);

export interface ApiErrorBody {
  message: string;
}

export interface SerializedAhaSendError {
  name: string;
  code: AhaSendErrorCode;
  message: string;
  status?: number;
  requestId?: string;
  retryAfterSeconds?: number;
  reason?: string;
  category?: string;
  maxQueue?: number;
  maxBytes?: number;
  body?: "[REDACTED]";
  headers?: "[REDACTED]";
  cause?: "[REDACTED]" | SerializedAhaSendError;
}

export type WebhookVerificationReason =
  | "missing_webhook_id"
  | "missing_webhook_timestamp"
  | "missing_webhook_signature"
  | "invalid_timestamp"
  | "timestamp_outside_tolerance"
  | "signature_mismatch"
  | "invalid_json"
  | "invalid_payload"
  | "invalid_event"
  | "body_too_large";

/** Base class for every error this SDK throws. */
export class AhaSendError extends Error {
  public readonly code!: AhaSendErrorCode;

  /** Safely identifies SDK errors across duplicate ESM/CJS package instances. */
  static is(value: unknown): value is AhaSendError {
    return isAhaSendError(value);
  }

  constructor(message: string, cause?: unknown) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    defineHidden(this, "name", new.target.name);
    defineHidden(this, "code", "ahasend_error");
    defineHidden(this, AHASEND_ERROR_BRAND, true);
    if (cause !== undefined) defineHidden(this, "cause", cause);
  }

  toJSON(depth = 0): SerializedAhaSendError {
    const serialized: SerializedAhaSendError = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    copySafeNumber(this, serialized, "status");
    copySafeString(this, serialized, "requestId");
    copySafeNumber(this, serialized, "retryAfterSeconds");
    copySafeString(this, serialized, "reason");
    copySafeString(this, serialized, "category");
    copySafeNumber(this, serialized, "maxQueue");
    copySafeNumber(this, serialized, "maxBytes");
    if ("body" in this) serialized.body = REDACTED;
    if ("headers" in this) serialized.headers = REDACTED;
    if ("cause" in this) {
      // A cause is redacted because it usually holds a transport object whose
      // contents are unreviewed. Another SDK error is not that: its own
      // toJSON() is already redaction-safe, and hiding it loses the only
      // record of what happened first — a retry-time pacing refusal, for
      // instance, would otherwise report nothing about the API error that
      // caused the retry.
      const cause: unknown = (this as { cause?: unknown }).cause;
      serialized.cause = serializeCause(cause, depth);
    }
    return serialized;
  }
}

defineHidden(AhaSendError.prototype, INSPECT_CUSTOM, function (this: AhaSendError) {
  return this.toJSON();
});

/** Safely identifies SDK errors across duplicate ESM/CJS package instances. */
export function isAhaSendError(value: unknown): value is AhaSendError {
  if (typeof value !== "object" || value === null) return false;
  try {
    return (value as { [AHASEND_ERROR_BRAND]?: unknown })[AHASEND_ERROR_BRAND] === true;
  } catch {
    return false;
  }
}

/** Invalid SDK construction, environment, per-request configuration, or request body. */
export class AhaSendConfigurationError extends AhaSendError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    defineHidden(this, "code", "configuration_error");
  }
}

/** Network-level failure such as DNS, connection refusal, or connection reset. */
export class AhaSendConnectionError extends AhaSendError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    defineHidden(this, "code", "connection_error");
  }
}

/** A caller-provided AbortSignal cancelled SDK work in any execution phase. */
export class AhaSendAbortError extends AhaSendError {
  constructor(message = "Request aborted", cause?: unknown) {
    super(message, cause);
    defineHidden(this, "code", "abort_error");
  }
}

/**
 * Local pacing refused a call because its bucket already has `maxQueue` calls
 * waiting. Raised only when `rateLimit.enabled` is set — it is a client-side
 * backpressure signal, not a server 429 (that is {@link AhaSendRateLimitError}).
 *
 * The cap bounds memory for a client that is offered work faster than its
 * configured rate drains it. Reaching it means the offered load exceeds the
 * configured rate by more than the queue can absorb, so the fixes are to raise
 * `rateLimit.<category>.maxQueue`, raise the rate, or apply backpressure
 * upstream — retrying immediately will not help.
 */
export class AhaSendRateLimitQueueFullError extends AhaSendError {
  /** Bucket that refused the call. Survives `toJSON()` for log aggregation. */
  public readonly category!: RateLimitCategory;
  /** Value of `maxQueue` for that bucket at the time of the refusal. */
  public readonly maxQueue!: number;

  constructor(category: RateLimitCategory, maxQueue: number, cause?: unknown) {
    super(
      `AhaSend: local rate pacing refused the call — the ${category} queue is full ` +
        `(${String(maxQueue)} waiting). Raise \`rateLimit.${category}.maxQueue\`, raise the ` +
        `rate, or slow the caller.`,
      cause,
    );
    defineHidden(this, "code", "rate_limit_queue_full_error");
    defineHidden(this, "category", category);
    defineHidden(this, "maxQueue", maxQueue);
  }
}

/** The per-attempt `timeoutMs` elapsed during fetch or response-body reading. */
export class AhaSendTimeoutError extends AhaSendConnectionError {
  constructor(message = "Request timed out", cause?: unknown) {
    super(message, cause);
    defineHidden(this, "code", "timeout_error");
  }
}

/**
 * A response body exceeded the transport's byte ceiling and was abandoned
 * mid-read.
 *
 * Deliberately not retryable: the response was received, so re-requesting can
 * only reproduce it. A compressed body is counted after decompression, so this
 * also bounds a decompression bomb — a few hundred kilobytes on the wire can
 * otherwise inflate to hundreds of megabytes, and without a ceiling the retry
 * policy would repeat that several times over.
 */
export class AhaSendResponseTooLargeError extends AhaSendError {
  /** Ceiling that was exceeded, in bytes. */
  public readonly maxBytes!: number;

  constructor(maxBytes: number, method: string, path: string) {
    super(
      `AhaSend: the response body for ${method} ${path} exceeded the ${String(maxBytes)}-byte ` +
        `limit and was discarded.`,
    );
    defineHidden(this, "code", "response_too_large_error");
    defineHidden(this, "maxBytes", maxBytes);
  }
}

/** A 2xx response body could not be parsed as JSON. */
export class AhaSendResponseParseError extends AhaSendError {
  public readonly status!: number;
  public readonly body!: string;
  public readonly requestId: string | undefined;

  constructor(params: {
    status: number;
    body: string;
    requestId?: string | undefined;
    cause?: unknown;
  }) {
    super(
      `AhaSend: HTTP ${params.status} response body could not be parsed as JSON.`,
      params.cause,
    );
    defineHidden(this, "code", "response_parse_error");
    defineHidden(this, "status", params.status);
    defineHidden(this, "body", params.body);
    defineHidden(this, "requestId", params.requestId);
  }
}

/** Base class for any non-2xx HTTP response from the AhaSend API. */
export class AhaSendAPIError extends AhaSendError {
  public readonly status!: number;
  public readonly body!: ApiErrorBody | string | null;
  public readonly requestId: string | undefined;
  public readonly headers!: Record<string, string>;

  /** Safely identifies API error subclasses across duplicate ESM/CJS package instances. */
  static override is(value: unknown): value is AhaSendAPIError {
    if (!AhaSendError.is(value)) return false;
    try {
      return AHASEND_API_ERROR_CODES.has(value.code);
    } catch {
      return false;
    }
  }

  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params.message, params.cause);
    defineHidden(this, "code", "api_error");
    defineHidden(this, "status", params.status);
    defineHidden(this, "body", params.body);
    defineHidden(this, "requestId", params.requestId);
    defineHidden(this, "headers", params.headers ?? {});
  }
}

/** 401 — missing or invalid API key. Not retried. */
export class AhaSendAuthenticationError extends AhaSendAPIError {
  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params);
    defineHidden(this, "code", "authentication_error");
  }
}

/** 403 — the API key lacks the required scope or its IP allow list rejects the caller. Not retried. */
export class AhaSendPermissionError extends AhaSendAPIError {
  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params);
    defineHidden(this, "code", "permission_error");
  }
}

/** 404 — the resource does not exist. Not retried. */
export class AhaSendNotFoundError extends AhaSendAPIError {
  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params);
    defineHidden(this, "code", "not_found_error");
  }
}

/** 400 — malformed request. Not retried. */
export class AhaSendBadRequestError extends AhaSendAPIError {
  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params);
    defineHidden(this, "code", "bad_request_error");
  }
}

/** Generic 409 Conflict. */
export class AhaSendConflictError extends AhaSendAPIError {
  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params);
    defineHidden(this, "code", "conflict_error");
  }
}

/** 409 Conflict for an idempotent request still in progress. */
export class AhaSendIdempotencyConflictError extends AhaSendConflictError {
  public readonly retryAfterSeconds: number | undefined;
  /** Stable key for reconciling the operation after automatic retries are exhausted. */
  public readonly idempotencyKey: string | undefined;

  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
    retryAfterSeconds?: number | undefined;
    idempotencyKey?: string | undefined;
  }) {
    super(params);
    defineHidden(this, "code", "idempotency_conflict_error");
    defineHidden(this, "retryAfterSeconds", params.retryAfterSeconds);
    defineHidden(this, "idempotencyKey", params.idempotencyKey);
  }
}

/** Generic 422 validation failure. */
export class AhaSendUnprocessableEntityError extends AhaSendAPIError {
  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params);
    defineHidden(this, "code", "unprocessable_entity_error");
  }
}

/** 422 for an idempotency key reused with a different request body. */
export class AhaSendIdempotencyMismatchError extends AhaSendUnprocessableEntityError {
  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params);
    defineHidden(this, "code", "idempotency_mismatch_error");
  }
}

/** 429 after retries are exhausted. */
export class AhaSendRateLimitError extends AhaSendAPIError {
  public readonly retryAfterSeconds: number | undefined;

  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
    retryAfterSeconds?: number | undefined;
  }) {
    super(params);
    defineHidden(this, "code", "rate_limit_error");
    defineHidden(this, "retryAfterSeconds", params.retryAfterSeconds);
  }
}

/** 5xx after retries are exhausted. */
export class AhaSendServerError extends AhaSendAPIError {
  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(params);
    defineHidden(this, "code", "server_error");
  }
}

/** Standard-Webhooks signature, timestamp, or payload verification failure. */
export class AhaSendWebhookVerificationError extends AhaSendError {
  public readonly reason!: WebhookVerificationReason;

  constructor(reason: WebhookVerificationReason, message?: string, cause?: unknown) {
    super(message ?? `Webhook verification failed: ${reason}`, cause);
    defineHidden(this, "code", "webhook_verification_error");
    defineHidden(this, "reason", reason);
  }
}

export function createApiError(params: {
  status: number;
  body: ApiErrorBody | string | null;
  requestId?: string | undefined;
  headers?: Record<string, string>;
  idempotency?: IdempotencyExecutionRecord;
  cause?: unknown;
}): AhaSendAPIError {
  const message = extractMessage(params.body) ?? `AhaSend API error (HTTP ${params.status})`;
  const base = { ...params, message };
  const eligibleKeyedExecution =
    params.idempotency?.eligible === true && params.idempotency.key !== undefined;

  if (params.status === 400) return new AhaSendBadRequestError(base);
  if (params.status === 401) return new AhaSendAuthenticationError(base);
  if (params.status === 403) return new AhaSendPermissionError(base);
  if (params.status === 404) return new AhaSendNotFoundError(base);
  if (params.status === 409) {
    const retryAfterSeconds = parsePositiveIntegerRetryAfter(params.headers?.["retry-after"]);
    if (
      eligibleKeyedExecution &&
      params.headers?.["idempotent-replayed"] === "false" &&
      retryAfterSeconds !== undefined
    ) {
      return new AhaSendIdempotencyConflictError({ ...base, retryAfterSeconds });
    }
    return new AhaSendConflictError(base);
  }
  if (params.status === 422) {
    const hasLifecycleHeader =
      params.headers?.["idempotent-replayed"] !== undefined ||
      params.headers?.["retry-after"] !== undefined;
    return eligibleKeyedExecution && !hasLifecycleHeader
      ? new AhaSendIdempotencyMismatchError(base)
      : new AhaSendUnprocessableEntityError(base);
  }
  if (params.status === 429) {
    const retryAfter = parseRetryAfter(params.headers?.["retry-after"]);
    return new AhaSendRateLimitError({ ...base, retryAfterSeconds: retryAfter });
  }
  if (params.status >= 500) return new AhaSendServerError(base);

  return new AhaSendAPIError(base);
}

/**
 * Longest error message derived from a response body.
 *
 * A non-JSON error body is whatever sat in front of the API — a proxy's HTML
 * page, a load balancer's plaintext. Using it verbatim made `error.message`
 * grow to the size of that page, and the message is repeated per retry attempt
 * and printed by every default logger, so one 502 could emit hundreds of
 * kilobytes. The full body remains on `error.body`.
 */
const MAX_DERIVED_MESSAGE_LENGTH = 200;

function extractMessage(body: ApiErrorBody | string | null): string | undefined {
  if (typeof body === "string") return truncateMessage(body);
  if (body && typeof body === "object" && typeof body.message === "string") {
    return truncateMessage(body.message);
  }
  return undefined;
}

/**
 * Reduce a server-supplied string to something safe to put in `error.message`.
 *
 * Returns `undefined` when nothing survives, so the caller's status fallback
 * still applies — a body of a bare newline or a lone BOM is common from
 * misconfigured intermediaries, and an empty message would otherwise replace
 * `AhaSend API error (HTTP 502)` with nothing at all.
 */
function truncateMessage(value: string): string | undefined {
  // Control and formatting characters go first, and cannot be left to the
  // whitespace pass: JavaScript's `\s` covers only the whitespace C0 controls
  // (TAB, LF, VT, FF, CR) — not ESC, BEL or NUL, and not NEL or the bidi
  // overrides, none of which it matches. Left in, a proxy's error
  // page could carry terminal escape sequences into `console.error` through
  // the debug logger — clearing the screen, or reversing the rest of the line.
  // Scan only a bounded prefix. Collapsing the whole body allocated a
  // near-full-size copy, and the sliced result then PINNED it — V8 keeps a
  // slice as a view over its parent — so a 229-character message retained the
  // entire page a second time, on top of `error.body`. Measured on a 371 KB
  // 502: 6.1 MB retained across 20 errors and 3.9 ms each, against ~0 and
  // 0.22 ms once bounded. The budget here is 32x the output, so even a heavily
  // indented page still yields a full-length message.
  const source =
    value.length > MAX_DERIVED_MESSAGE_LENGTH * 32
      ? value.slice(0, MAX_DERIVED_MESSAGE_LENGTH * 32)
      : value;
  const collapsed = source
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    // Then collapse: an HTML page is mostly newlines and indentation, so a raw
    // slice would spend the budget on whitespace and span many log lines.
    .replace(/\s+/gu, " ")
    .trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_DERIVED_MESSAGE_LENGTH) return collapsed;

  let cut = collapsed.slice(0, MAX_DERIVED_MESSAGE_LENGTH);
  // Never end on half a surrogate pair. A lone surrogate is lossy through
  // UTF-8 — it becomes U+FFFD on the wire — and strict JSON readers reject the
  // unpaired escape outright, so a log line can be dropped rather than shortened.
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return `${cut}… (truncated; full text on the caught error\u2019s \`body\`, not in logs)`;
}

/** @internal Parse a Retry-After value for retry timing policy. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = parseNonNegativeIntegerRetryAfter(value);
  if (seconds !== undefined) return seconds;
  const now = Date.now();
  const date = parseHttpDate(value, now);
  if (date !== undefined) {
    const dateSeconds = Math.ceil((date - now) / 1000);
    return Number.isSafeInteger(dateSeconds) && dateSeconds > 0 ? dateSeconds : undefined;
  }
  return undefined;
}

function parsePositiveIntegerRetryAfter(value: string | undefined): number | undefined {
  const seconds = parseNonNegativeIntegerRetryAfter(value);
  return seconds !== undefined && seconds > 0 ? seconds : undefined;
}

function parseNonNegativeIntegerRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/** Parse the three HTTP-date forms required by RFC 9110 without Date.parse's permissive extensions. */
function parseHttpDate(value: string, now: number): number | undefined {
  const imfFixdate =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
      value,
    );
  if (imfFixdate) {
    return validatedHttpDate(
      Number(imfFixdate[4]),
      monthIndex(imfFixdate[3]),
      Number(imfFixdate[2]),
      Number(imfFixdate[5]),
      Number(imfFixdate[6]),
      Number(imfFixdate[7]),
      weekdayIndex(imfFixdate[1], HTTP_SHORT_WEEKDAYS),
    );
  }

  const rfc850Date =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
      value,
    );
  if (rfc850Date) {
    const currentYear = new Date(now).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850Date[4]);
    const candidate = httpDateTimestamp(
      year,
      monthIndex(rfc850Date[3]),
      Number(rfc850Date[2]),
      Number(rfc850Date[5]),
      Number(rfc850Date[6]),
      Number(rfc850Date[7]),
    );
    const rolloverBoundary = new Date(now);
    rolloverBoundary.setUTCFullYear(currentYear + 50);
    if (candidate > rolloverBoundary.getTime()) year -= 100;
    return validatedHttpDate(
      year,
      monthIndex(rfc850Date[3]),
      Number(rfc850Date[2]),
      Number(rfc850Date[5]),
      Number(rfc850Date[6]),
      Number(rfc850Date[7]),
      weekdayIndex(rfc850Date[1], HTTP_LONG_WEEKDAYS),
    );
  }

  const asctimeDate =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:([0-9]{2})| ([0-9])) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(
      value,
    );
  if (!asctimeDate) return undefined;
  return validatedHttpDate(
    Number(asctimeDate[8]),
    monthIndex(asctimeDate[2]),
    Number(asctimeDate[3] ?? asctimeDate[4]),
    Number(asctimeDate[5]),
    Number(asctimeDate[6]),
    Number(asctimeDate[7]),
    weekdayIndex(asctimeDate[1], HTTP_SHORT_WEEKDAYS),
  );
}

function monthIndex(value: string | undefined): number {
  return value === undefined ? -1 : HTTP_MONTHS.indexOf(value);
}

function weekdayIndex(value: string | undefined, weekdays: readonly string[]): number {
  return value === undefined ? -1 : weekdays.indexOf(value);
}

function validatedHttpDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  weekday: number,
): number | undefined {
  if (second > 60) return undefined;
  const normalizedSecond = Math.min(second, 59);
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, normalizedSecond, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== normalizedSecond ||
    date.getUTCDay() !== weekday
  ) {
    return undefined;
  }
  return date.getTime() + (second === 60 ? 1000 : 0);
}

function httpDateTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  return date.getTime() + (second === 60 ? 1000 : 0);
}

function defineHidden(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    writable: false,
    value,
  });
}

/**
 * Serialise an error's `cause`, or redact it.
 *
 * Everything here is defensive because this runs inside a consumer's `catch`
 * and inside their logger: a serializer that throws turns a handled failure
 * into an unhandled crash in the handler meant to contain it. The brand is a
 * global-registry symbol that any code can set, so a branded value is not
 * guaranteed to have `toJSON`, and a `cause` chain is not guaranteed acyclic.
 */
function serializeCause(cause: unknown, depth: number): SerializedAhaSendError | "[REDACTED]" {
  if (depth >= MAX_CAUSE_DEPTH) return REDACTED;
  if (!isAhaSendError(cause)) return REDACTED;
  const serialize = (cause as { toJSON?: unknown }).toJSON;
  if (typeof serialize !== "function") return REDACTED;
  try {
    return (cause as { toJSON: (depth: number) => SerializedAhaSendError }).toJSON(depth + 1);
  } catch {
    return REDACTED;
  }
}

function copySafeString(
  source: object,
  target: SerializedAhaSendError,
  key: "requestId" | "reason" | "category",
): void {
  const value = (source as Record<typeof key, unknown>)[key];
  if (typeof value === "string") target[key] = value;
}

function copySafeNumber(
  source: object,
  target: SerializedAhaSendError,
  key: "status" | "retryAfterSeconds" | "maxQueue" | "maxBytes",
): void {
  const value = (source as Record<typeof key, unknown>)[key];
  if (typeof value === "number") target[key] = value;
}
