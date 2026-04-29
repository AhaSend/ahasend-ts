export interface ApiErrorBody {
  message?: string;
  code?: string;
  details?: unknown;
  [key: string]: unknown;
}

export class AhaSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AhaSendError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AhaSendConnectionError extends AhaSendError {
  public override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AhaSendConnectionError";
    this.cause = cause;
  }
}

export class AhaSendTimeoutError extends AhaSendConnectionError {
  constructor(message = "Request timed out", cause?: unknown) {
    super(message, cause);
    this.name = "AhaSendTimeoutError";
  }
}

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

export class AhaSendAuthenticationError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendAuthenticationError";
  }
}

export class AhaSendPermissionError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendPermissionError";
  }
}

export class AhaSendNotFoundError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendNotFoundError";
  }
}

export class AhaSendBadRequestError extends AhaSendAPIError {
  constructor(params: ConstructorParameters<typeof AhaSendAPIError>[0]) {
    super(params);
    this.name = "AhaSendBadRequestError";
  }
}

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

  if (params.status === 400 || params.status === 422) return new AhaSendBadRequestError(base);
  if (params.status === 401) return new AhaSendAuthenticationError(base);
  if (params.status === 403) return new AhaSendPermissionError(base);
  if (params.status === 404) return new AhaSendNotFoundError(base);
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
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
