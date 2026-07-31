import type { IdempotencyExecutionRecord } from "./idempotency.js";

const AHASEND_ERROR_BRAND = Symbol.for("@ahasend/sdk.error");
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");
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
  | "server_error"
  | "webhook_verification_error";

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
  body?: typeof REDACTED;
  headers?: typeof REDACTED;
  cause?: typeof REDACTED;
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

  constructor(message: string, cause?: unknown) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    defineHidden(this, "name", new.target.name);
    defineHidden(this, "code", "ahasend_error");
    defineHidden(this, AHASEND_ERROR_BRAND, true);
    if (cause !== undefined) defineHidden(this, "cause", cause);
  }

  toJSON(): SerializedAhaSendError {
    const serialized: SerializedAhaSendError = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    copySafeNumber(this, serialized, "status");
    copySafeString(this, serialized, "requestId");
    copySafeNumber(this, serialized, "retryAfterSeconds");
    copySafeString(this, serialized, "reason");
    if ("body" in this) serialized.body = REDACTED;
    if ("headers" in this) serialized.headers = REDACTED;
    if ("cause" in this) serialized.cause = REDACTED;
    return serialized;
  }

  [INSPECT_CUSTOM](): SerializedAhaSendError {
    return this.toJSON();
  }
}

/** Safely identifies SDK errors across duplicate ESM/CJS package instances. */
export function isAhaSendError(value: unknown): value is AhaSendError {
  if (typeof value !== "object" || value === null) return false;
  try {
    return (value as { [AHASEND_ERROR_BRAND]?: unknown })[AHASEND_ERROR_BRAND] === true;
  } catch {
    return false;
  }
}

/** Invalid SDK construction, environment, or per-request configuration. */
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

/** The per-attempt `timeoutMs` elapsed during fetch or response-body reading. */
export class AhaSendTimeoutError extends AhaSendConnectionError {
  constructor(message = "Request timed out", cause?: unknown) {
    super(message, cause);
    defineHidden(this, "code", "timeout_error");
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

type APIErrorParams = ConstructorParameters<typeof AhaSendAPIError>[0];

/** 401 — missing or invalid API key. Not retried. */
export class AhaSendAuthenticationError extends AhaSendAPIError {
  constructor(params: APIErrorParams) {
    super(params);
    defineHidden(this, "code", "authentication_error");
  }
}

/** 403 — the API key lacks the required scope or its IP allow list rejects the caller. Not retried. */
export class AhaSendPermissionError extends AhaSendAPIError {
  constructor(params: APIErrorParams) {
    super(params);
    defineHidden(this, "code", "permission_error");
  }
}

/** 404 — the resource does not exist. Not retried. */
export class AhaSendNotFoundError extends AhaSendAPIError {
  constructor(params: APIErrorParams) {
    super(params);
    defineHidden(this, "code", "not_found_error");
  }
}

/** 400 — malformed request. Not retried. */
export class AhaSendBadRequestError extends AhaSendAPIError {
  constructor(params: APIErrorParams) {
    super(params);
    defineHidden(this, "code", "bad_request_error");
  }
}

/** Generic 409 Conflict. */
export class AhaSendConflictError extends AhaSendAPIError {
  constructor(params: APIErrorParams) {
    super(params);
    defineHidden(this, "code", "conflict_error");
  }
}

/** 409 Conflict for an idempotent request still in progress. */
export class AhaSendIdempotencyConflictError extends AhaSendConflictError {
  public readonly retryAfterSeconds: number | undefined;

  constructor(params: APIErrorParams & { retryAfterSeconds?: number | undefined }) {
    super(params);
    defineHidden(this, "code", "idempotency_conflict_error");
    defineHidden(this, "retryAfterSeconds", params.retryAfterSeconds);
  }
}

/** Generic 422 validation failure. */
export class AhaSendUnprocessableEntityError extends AhaSendAPIError {
  constructor(params: APIErrorParams) {
    super(params);
    defineHidden(this, "code", "unprocessable_entity_error");
  }
}

/** 422 for an idempotency key reused with a different request body. */
export class AhaSendIdempotencyMismatchError extends AhaSendUnprocessableEntityError {
  constructor(params: APIErrorParams) {
    super(params);
    defineHidden(this, "code", "idempotency_mismatch_error");
  }
}

/** 429 after retries are exhausted. */
export class AhaSendRateLimitError extends AhaSendAPIError {
  public readonly retryAfterSeconds: number | undefined;

  constructor(params: APIErrorParams & { retryAfterSeconds?: number | undefined }) {
    super(params);
    defineHidden(this, "code", "rate_limit_error");
    defineHidden(this, "retryAfterSeconds", params.retryAfterSeconds);
  }
}

/** 5xx after retries are exhausted. */
export class AhaSendServerError extends AhaSendAPIError {
  constructor(params: APIErrorParams) {
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

function extractMessage(body: ApiErrorBody | string | null): string | undefined {
  if (typeof body === "string") return body.length > 0 ? body : undefined;
  if (body && typeof body === "object" && typeof body.message === "string") return body.message;
  return undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = parsePositiveIntegerRetryAfter(value);
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
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
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

function copySafeString(
  source: object,
  target: SerializedAhaSendError,
  key: "requestId" | "reason",
): void {
  const value = (source as Record<typeof key, unknown>)[key];
  if (typeof value === "string") target[key] = value;
}

function copySafeNumber(
  source: object,
  target: SerializedAhaSendError,
  key: "status" | "retryAfterSeconds",
): void {
  const value = (source as Record<typeof key, unknown>)[key];
  if (typeof value === "number") target[key] = value;
}
