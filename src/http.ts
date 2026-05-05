import type { ResolvedConfig } from "./config.js";
import { AhaSendConnectionError, AhaSendTimeoutError, createApiError } from "./errors.js";
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
    await this.rateLimiter.acquire(options.method, options.path, options.signal);

    const url = this.buildUrl(options.path, options.query);
    const init = this.buildRequestInit(options);

    const retry = this.config.retry;
    const maxAttempts = retry.enabled ? retry.maxRetries + 1 : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.executeOnce<T>(url, init, options);
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts) throw err;
        if (!isRetryableError(err)) throw err;
        const delayMs = computeRetryDelayMs(err, attempt, retry);
        await sleep(delayMs, options.signal);
      }
    }
    throw lastError;
  }

  private async executeOnce<T>(
    url: string,
    init: RequestInit,
    options: RequestOptions,
  ): Promise<T> {
    const controller = this.linkAbortSignal(options.signal, this.config.timeout);

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
    controller.cleanup();

    return this.parseResponse<T>(response);
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

    if (this.shouldAutoIdempotency(options.method, headers)) {
      headers[IDEMPOTENCY_HEADER.toLowerCase()] = generateIdempotencyKey(
        this.config.idempotency.prefix,
      );
    }

    return init;
  }

  private shouldAutoIdempotency(
    method: HttpMethod,
    headers: Record<string, string>,
  ): boolean {
    if (!this.config.idempotency.autoGenerate) return false;
    if (method !== "POST") return false;
    return headers[IDEMPOTENCY_HEADER.toLowerCase()] === undefined;
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;

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

    return (parsed ?? (rawText as unknown)) as T;
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
