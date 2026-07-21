const AHASEND_ERROR_BRAND = Symbol.for("@ahasend/sdk.error");
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");
const REDACTED = "[REDACTED]" as const;

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
  message?: string;
  code?: string;
  details?: unknown;
  [key: string]: unknown;
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

/** A caller-provided AbortSignal cancelled SDK work. */
export class AhaSendAbortError extends AhaSendError {
  constructor(message = "Request aborted", cause?: unknown) {
    super(message, cause);
    defineHidden(this, "code", "abort_error");
  }
}

/** The configured `timeoutMs` elapsed before the response body completed. */
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

/** 403 — the API key lacks the required scope. Not retried. */
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
  constructor(params: APIErrorParams) {
    super(params);
    defineHidden(this, "code", "idempotency_conflict_error");
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
  public readonly reason!: string;

  constructor(reason: string, message?: string, cause?: unknown) {
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
  cause?: unknown;
}): AhaSendAPIError {
  const message = extractMessage(params.body) ?? `AhaSend API error (HTTP ${params.status})`;
  const base = { ...params, message };
  const isIdempotencyReplay = params.headers?.["idempotent-replayed"] !== undefined;

  if (params.status === 400) return new AhaSendBadRequestError(base);
  if (params.status === 401) return new AhaSendAuthenticationError(base);
  if (params.status === 403) return new AhaSendPermissionError(base);
  if (params.status === 404) return new AhaSendNotFoundError(base);
  if (params.status === 409) {
    return isIdempotencyReplay
      ? new AhaSendIdempotencyConflictError(base)
      : new AhaSendConflictError(base);
  }
  if (params.status === 422) {
    return isIdempotencyReplay
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

const MAX_RETRY_AFTER_SECONDS = 60 * 60;

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return clampRetryAfter(seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return clampRetryAfter(Math.max(0, Math.ceil((date - Date.now()) / 1000)));
  }
  return undefined;
}

function clampRetryAfter(seconds: number): number {
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
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
