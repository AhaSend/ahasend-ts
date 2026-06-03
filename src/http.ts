import type { ResolvedConfig } from "./config.js";
import {
  AhaSendConnectionError,
  AhaSendResponseParseError,
  AhaSendTimeoutError,
  createApiError,
} from "./errors.js";
import type { ApiErrorBody } from "./errors.js";
import { generateIdempotencyKey, IDEMPOTENCY_HEADER } from "./idempotency.js";
import { RateLimiter } from "./rate-limit.js";
import { computeRetryDelayMs, isRetryableError, sleep } from "./retry.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Resource clients set this on the 9 spec-documented idempotency
   * endpoints (every `create*` operation) so the transport layer will
   * inject an `Idempotency-Key` when the caller hasn't supplied one.
   * Other POSTs — notably `domains.checkDns()` and inbound webhook
   * handlers — leave this unset and never receive an auto-generated key.
   */
  autoIdempotency?: boolean;
}

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<string | number | boolean>;

const REQUEST_ID_HEADER = "x-request-id";

export class HttpClient {
  public readonly rateLimiter: RateLimiter;

  constructor(private readonly config: ResolvedConfig) {
    this.rateLimiter = new RateLimiter(config.rateLimit);
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query);
    const init = this.buildRequestInit(options);

    const retry = this.config.retry;
    const maxAttempts = retry.enabled ? retry.maxRetries + 1 : 1;
    const hooks = this.config.hooks;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Acquire a token on every attempt — including retries — so the
      // local bucket stays in sync with the server-reconciled state
      // updated by `recordResponseHeaders` on each response. Without
      // this, a 429 retry would bypass the local limiter entirely.
      await this.rateLimiter.acquire(options.method, options.path, options.signal);
      try {
        return await this.executeOnce<T>(url, init, options, attempt);
      } catch (err) {
        lastError = err;
        const requestId = extractRequestId(err);
        const errorEvent: import("./telemetry.js").ErrorEvent = {
          method: options.method,
          path: options.path,
          url,
          attempt,
          error: err,
        };
        if (requestId) errorEvent.requestId = requestId;
        hooks.onError(errorEvent);
        if (attempt === maxAttempts) throw err;
        if (!isRetryableError(err)) throw err;
        const delayMs = computeRetryDelayMs(err, attempt, retry);
        const retryEvent: import("./telemetry.js").RetryEvent = {
          method: options.method,
          path: options.path,
          url,
          attempt,
          delayMs,
          error: err,
        };
        if (requestId) retryEvent.requestId = requestId;
        hooks.onRetry(retryEvent);
        await sleep(delayMs, options.signal);
      }
    }
    throw lastError;
  }

  private async executeOnce<T>(
    url: string,
    init: RequestInit,
    options: RequestOptions,
    attempt: number,
  ): Promise<T> {
    const controller = this.linkAbortSignal(options.signal, this.config.timeout);
    const startedAt = Date.now();

    this.config.hooks.onRequest({
      method: options.method,
      path: options.path,
      url,
      attempt,
    });

    let response: Response;
    try {
      response = await this.config.fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      controller.cleanup();
      if (controller.timedOut) {
        throw new AhaSendTimeoutError(
          `Request to ${options.method} ${options.path} timed out after ${this.config.timeout}ms`,
          err,
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new AhaSendConnectionError("Request aborted", err);
      }
      throw new AhaSendConnectionError(
        `Network error while calling ${options.method} ${options.path}`,
        err,
      );
    }

    // Keep the timer armed until the body has been fully read. A
    // misbehaving server that sends headers quickly then stalls on the
    // body would otherwise escape the configured `timeout`.
    try {
      this.rateLimiter.recordResponseHeaders(options.method, options.path, response.headers);
      const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
      const responseEvent: import("./telemetry.js").ResponseEvent = {
        method: options.method,
        path: options.path,
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        attempt,
      };
      if (requestId) responseEvent.requestId = requestId;
      this.config.hooks.onResponse(responseEvent);

      return await this.parseResponse<T>(response, requestId);
    } catch (err) {
      if (controller.timedOut) {
        throw new AhaSendTimeoutError(
          `Response body read for ${options.method} ${options.path} timed out after ${this.config.timeout}ms`,
          err,
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new AhaSendConnectionError("Request aborted during body read", err);
      }
      throw err;
    } finally {
      controller.cleanup();
    }
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.baseUrl}${normalizedPath}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item === undefined || item === null) continue;
            url.searchParams.append(key, String(item));
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private buildRequestInit(options: RequestOptions): RequestInit {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.config.userAgent,
      authorization: `Bearer ${this.config.apiKey}`,
      ...lowercaseHeaders(this.config.defaultHeaders),
      ...lowercaseHeaders(options.headers),
    };

    const init: RequestInit = {
      method: options.method,
      headers,
    };

    if (options.body !== undefined && options.method !== "GET") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    if (this.shouldAutoIdempotency(options, headers)) {
      headers[IDEMPOTENCY_HEADER.toLowerCase()] = generateIdempotencyKey(
        this.config.idempotency.prefix,
      );
    }

    return init;
  }

  private shouldAutoIdempotency(
    options: RequestOptions,
    headers: Record<string, string>,
  ): boolean {
    if (!options.autoIdempotency) return false;
    if (!this.config.idempotency.autoGenerate) return false;
    if (options.method !== "POST") return false;
    return headers[IDEMPOTENCY_HEADER.toLowerCase()] === undefined;
  }

  private async parseResponse<T>(
    response: Response,
    requestIdFromHeader?: string,
  ): Promise<T> {
    const requestId =
      requestIdFromHeader ?? response.headers.get(REQUEST_ID_HEADER) ?? undefined;

    if (response.status === 204 || response.status === 205) {
      if (response.ok) return undefined as T;
    }

    const rawText = await response.text();
    const parsed = rawText.length > 0 ? safeJsonParse(rawText) : null;

    if (!response.ok) {
      throw createApiError({
        status: response.status,
        body: (parsed ?? rawText ?? null) as ApiErrorBody | string | null,
        requestId,
        headers: headersToRecord(response.headers),
      });
    }

    if (parsed === null) {
      // 2xx with empty body → return undefined.
      if (rawText.length === 0) return undefined as T;
      // 2xx with non-JSON body is suspicious (typically an HTML error page
      // from a misconfigured load balancer or a captive-portal redirect).
      // Surface it as a transport-layer parse error rather than as an
      // `AhaSendAPIError` carrying a 2xx status code — otherwise `catch`
      // blocks checking `status >= 500` will silently swallow it.
      throw new AhaSendResponseParseError({
        status: response.status,
        body: rawText,
        requestId,
      });
    }

    if (typeof parsed === "object" && parsed !== null) {
      // Attach observability metadata non-enumerably so it doesn't
      // change the shape of typed responses but is still available
      // for logging / tracing.
      if (requestId) {
        Object.defineProperty(parsed, "_requestId", {
          value: requestId,
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }
      const replayed = response.headers.get("idempotent-replayed");
      if (replayed !== null) {
        // The server emits `Idempotent-Replayed: true` on a 2xx response
        // when the result is a cached replay of a prior idempotent
        // request. Surfacing this lets callers decide whether to treat
        // the response as a true new-side-effect or a confirmation that
        // the side-effect already happened.
        Object.defineProperty(parsed, "_idempotentReplayed", {
          value: replayed === "true",
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }
    }

    return parsed as T;
  }

  private linkAbortSignal(
    userSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): { signal: AbortSignal; cleanup: () => void; timedOut: boolean } {
    const controller = new AbortController();
    let timedOut = false;

    const onUserAbort = () => controller.abort(userSignal?.reason);
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else userSignal.addEventListener("abort", onUserAbort, { once: true });
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;

    return {
      signal: controller.signal,
      cleanup: () => {
        if (timer) clearTimeout(timer);
        if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
      },
      get timedOut() {
        return timedOut;
      },
    };
  }
}

function lowercaseHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractRequestId(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { requestId?: unknown }).requestId;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Read the observability metadata attached non-enumerably by the
 * transport layer on successful responses. Returns `{}` if the response
 * is not an object or carries no metadata.
 *
 * Example:
 * ```ts
 * const msg = await client.messages.send({ ... });
 * const { requestId, idempotentReplayed } = getResponseMetadata(msg);
 * ```
 */
export function getResponseMetadata(
  response: unknown,
): { requestId?: string; idempotentReplayed?: boolean } {
  if (typeof response !== "object" || response === null) return {};
  const r = response as { _requestId?: string; _idempotentReplayed?: boolean };
  const out: { requestId?: string; idempotentReplayed?: boolean } = {};
  if (typeof r._requestId === "string") out.requestId = r._requestId;
  if (typeof r._idempotentReplayed === "boolean") out.idempotentReplayed = r._idempotentReplayed;
  return out;
}

/**
 * Serialise a single query-param value with predictable wire format.
 * `String(true)`/`String(false)` already produces `"true"`/`"false"`,
 * but `Date` objects would round-trip through a locale string. Keep
 * everything else as-is so callers retain control.
 */
function serializeQueryValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
