export interface ApiErrorBody {
  message?: string;
  code?: string;
  details?: unknown;
  [key: string]: unknown;
}

/** Base class for every error this SDK throws. */
export class AhaSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AhaSendError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Network-level failure — DNS, connection refused/reset, or an aborted
 * request. The request may or may not have reached the server; safe to
 * retry only if the operation is idempotent. The SDK retries these
 * automatically (idempotency key preserved).
 */
export class AhaSendConnectionError extends AhaSendError {
  public override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AhaSendConnectionError";
    this.cause = cause;
  }
}

/** The configured `timeout` elapsed before the response (headers + body) completed. */
export class AhaSendTimeoutError extends AhaSendConnectionError {
  constructor(message = "Request timed out", cause?: unknown) {
    super(message, cause);
    this.name = "AhaSendTimeoutError";
  }
}

/**
 * Raised when the server returned a 2xx status but the response body
 * could not be parsed as JSON (typical of a misconfigured load balancer
 * serving an HTML 200 page). Surfaces as a transport-layer error so
 * that `catch (AhaSendAPIError)` blocks looking for 5xx responses don't
 * inadvertently swallow it.
 */
export class AhaSendResponseParseError extends AhaSendError {
  public readonly status: number;
  public readonly body: string;
  public readonly requestId: string | undefined;

  constructor(params: { status: number; body: string; requestId?: string | undefined }) {
    super(
      `AhaSend: HTTP ${params.status} response body could not be parsed as JSON.`,
    );
    this.name = "AhaSendResponseParseError";
    this.status = params.status;
    this.body = params.body;
    this.requestId = params.requestId;
  }
}

/**
 * Base class for any non-2xx HTTP response from the AhaSend API.
 * Carries the `status`, parsed error `body`, response `headers`, and
 * the server's `x-request-id` (quote it in support requests).
 */
export class AhaSendAPIError extends AhaSendError {
  public readonly status: number;
  public readonly body: ApiErrorBody | string | null;
  public readonly requestId: string | undefined;
  public readonly headers: Record<string, string>;

  constructor(params: {
    status: number;
    message: string;
    body: ApiErrorBody | string | null;
    requestId?: string | undefined;
    headers?: Record<string, string>;
  }) {
    super(params.message);
    this.name = "AhaSendAPIError";
    this.status = params.status;
    this.body = params.body;
    this.requestId = params.requestId;
    this.headers = params.headers ?? {};
  }
}

/** 401 — missing or invalid API key. Not retried. */
export class AhaSendAuthenticationError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendAuthenticationError";
  }
}

/** 403 — the API key lacks the required scope for this operation. Not retried. */
export class AhaSendPermissionError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendPermissionError";
  }
}

/** 404 — the resource does not exist (or belongs to another account). Not retried. */
export class AhaSendNotFoundError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendNotFoundError";
  }
}

/** 400 — malformed request. Inspect `body` for field-level details. Not retried. */
export class AhaSendBadRequestError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendBadRequestError";
  }
}

/**
 * Generic 409 Conflict — used for non-idempotency conflicts such as
 * "domain already exists". When the response carries an
 * `Idempotent-Replayed` header, the more specific
 * `AhaSendIdempotencyConflictError` subclass is raised instead.
 */
export class AhaSendConflictError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendConflictError";
  }
}

/**
 * 409 Conflict raised specifically because an Idempotency-Key matched a
 * request that is still in progress on the server.
 */
export class AhaSendIdempotencyConflictError extends AhaSendConflictError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendIdempotencyConflictError";
  }
}

/**
 * 412 — the original request that used this Idempotency-Key failed, so
 * the key cannot be replayed. Generate a fresh key and resubmit.
 */
export class AhaSendIdempotencyPreconditionFailedError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendIdempotencyPreconditionFailedError";
  }
}

/**
 * Generic 422 Unprocessable Entity — used for validation failures.
 *
 * Extends `AhaSendAPIError` directly (not `AhaSendBadRequestError`) so
 * that `catch (AhaSendBadRequestError)` cannot silently swallow a 422.
 * `AhaSendIdempotencyMismatchError` is raised instead when the response
 * carries an `Idempotent-Replayed` header.
 */
export class AhaSendUnprocessableEntityError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendUnprocessableEntityError";
  }
}

/**
 * 422 raised specifically because an Idempotency-Key was reused with a
 * different request body than the original.
 */
export class AhaSendIdempotencyMismatchError extends AhaSendUnprocessableEntityError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendIdempotencyMismatchError";
  }
}

/**
 * 429 — rate limited. The SDK retries automatically, honouring the
 * server's `Retry-After`; you only see this error after retries are
 * exhausted. `retryAfterSeconds` carries the server's hint when present.
 */
export class AhaSendRateLimitError extends AhaSendAPIError {
  public readonly retryAfterSeconds: number | undefined;

  constructor(
    params: ConstructorParameters<typeof AhaSendAPIError>[0] & {
      retryAfterSeconds?: number | undefined;
    },
  ) {
    super(params);
    this.name = "AhaSendRateLimitError";
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

/** 5xx — AhaSend server error. Retried automatically with backoff. */
export class AhaSendServerError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendServerError";
  }
}

export function createApiError(params: {
  status: number;
  body: ApiErrorBody | string | null;
  requestId?: string | undefined;
  headers?: Record<string, string>;
}): AhaSendAPIError {
  const message = extractMessage(params.body) ?? `AhaSend API error (HTTP ${params.status})`;
  const base = { ...params, message };

  const isIdempotencyReplay =
    params.headers?.["idempotent-replayed"] !== undefined;

  if (params.status === 400) return new AhaSendBadRequestError(base);
  if (params.status === 401) return new AhaSendAuthenticationError(base);
  if (params.status === 403) return new AhaSendPermissionError(base);
  if (params.status === 404) return new AhaSendNotFoundError(base);
  if (params.status === 409) {
    return isIdempotencyReplay
      ? new AhaSendIdempotencyConflictError(base)
      : new AhaSendConflictError(base);
  }
  if (params.status === 412) return new AhaSendIdempotencyPreconditionFailedError(base);
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

/**
 * Sane ceiling on `Retry-After`. Real production rate-limits don't ask
 * clients to sleep for hours; clamping to one hour blocks
 * `Retry-After: 1e308` style abuse from causing the SDK to sleep
 * effectively forever, while still respecting legitimate long backoffs.
 */
const MAX_RETRY_AFTER_SECONDS = 60 * 60;

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  // RFC 9110 §10.2.3 allows two forms: delta-seconds (an integer count
  // of seconds) or an HTTP-date.
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
