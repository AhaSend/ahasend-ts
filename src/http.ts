import type { ResolvedConfig } from "./config.js";
import { assertHeaders } from "./config.js";
import {
  AhaSendAbortError,
  AhaSendConnectionError,
  AhaSendResponseParseError,
  AhaSendTimeoutError,
  createApiError,
} from "./errors.js";
import type { ApiErrorBody } from "./errors.js";
import {
  createIdempotencyExecutionRecord,
  generateIdempotencyKey,
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  assertValidIdempotencyKey,
} from "./idempotency.js";
import type { IdempotencyExecutionRecord } from "./idempotency.js";
import { OPERATION_DESCRIPTORS } from "./generated/operations.js";
import type { OperationId, RetryMode } from "./generated/operations.js";
import type { OperationExecutionRecord } from "./operations.js";
import { RateLimiter } from "./rate-limit.js";
import { computeRetryDelayMs, isRetryableError, sleep } from "./retry.js";
import type { AhaSendPromise, AhaSendResponse } from "./types/common.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Validated explicit key forwarded separately from caller-controlled headers. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /**
   * Resource clients set this on the 11 spec-documented idempotency
   * endpoints (every `create*` operation) so the transport layer will
   * inject an `Idempotency-Key` when the caller hasn't supplied one.
   * Other POSTs — notably `domains.checkDns()` and inbound webhook
   * handlers — leave this unset and never receive an auto-generated key.
   */
  autoIdempotency?: boolean;
  /** Generated operation identity for policy and diagnostic consumers. */
  operationId?: OperationId;
  /** Generated retry-safety classification for this operation. */
  retryMode?: RetryMode;
  /** Immutable generated policy for operation-aware response handling. */
  execution?: OperationExecutionRecord;
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

  request<T>(options: RequestOptions): AhaSendPromise<T> {
    assertHeaders(options.headers, "request headers");
    if (options.idempotencyKey !== undefined) {
      assertValidIdempotencyKey(options.idempotencyKey, "request idempotency key");
    }
    let responseEnvelope: AhaSendResponse<T>;
    const bodyPromise = this.requestWithResponse<T>(options).then((envelope) => {
      responseEnvelope = envelope;
      return envelope.data;
    }) as AhaSendPromise<T>;
    // Derive the envelope view from the public body promise. Consuming either
    // view observes the same rejection, while an entirely ignored failed
    // request remains an unhandled rejection as callers expect from a Promise.
    bodyPromise.withResponse = () => bodyPromise.then(() => responseEnvelope);
    return bodyPromise;
  }

  private async requestWithResponse<T>(options: RequestOptions): Promise<AhaSendResponse<T>> {
    const url = this.buildUrl(options.path, options.query);
    const init = this.buildRequestInit(options);
    const execution = this.buildExecutionRecord(options, url, init);

    const retry = this.config.retry;
    const maxAttempts = retry.enabled && this.isRetryAllowed(execution) ? retry.maxRetries + 1 : 1;
    const hooks = this.config.hooks;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let startedAt: number | undefined;
      try {
        const envelope = await this.executeAttempt<T>(
          execution,
          options,
          () => {
            startedAt = Date.now();
            hooks.onRequest(this.buildAttemptEvent(execution, options, attempt));
          },
          (response, requestId) => {
            const responseEvent: import("./telemetry.js").ResponseEvent = {
              ...this.buildAttemptEvent(execution, options, attempt),
              status: response.status,
              durationMs: elapsedSince(startedAt),
            };
            if (requestId) responseEvent.requestId = requestId;
            hooks.onResponse(Object.freeze(responseEvent));
          },
        );
        return envelope;
      } catch (err) {
        lastError = err;
        const durationMs = elapsedSince(startedAt);
        const requestId = extractRequestId(err);
        const status = extractStatus(err);
        const errorEvent: import("./telemetry.js").ErrorEvent = {
          ...this.buildAttemptEvent(execution, options, attempt),
          durationMs,
          error: err,
        };
        if (status !== undefined) errorEvent.status = status;
        if (requestId) errorEvent.requestId = requestId;
        hooks.onError(Object.freeze(errorEvent));
        if (attempt === maxAttempts) throw err;
        if (!isRetryableError(err)) throw err;
        const delayMs = computeRetryDelayMs(err, attempt, retry);
        const retryEvent: import("./telemetry.js").RetryEvent = {
          ...this.buildAttemptEvent(execution, options, attempt),
          delayMs,
          durationMs,
          error: err,
        };
        if (status !== undefined) retryEvent.status = status;
        if (requestId) retryEvent.requestId = requestId;
        hooks.onRetry(Object.freeze(retryEvent));
        await sleep(delayMs, options.signal);
      }
    }
    throw lastError;
  }

  private async executeAttempt<T>(
    execution: HttpExecutionRecord,
    options: RequestOptions,
    onStarted: () => void,
    onResponseComplete: (response: Response, requestId: string | undefined) => void,
  ): Promise<AhaSendResponse<T>> {
    // Local pacing is part of the total call, so it observes caller cancellation,
    // but it is outside the per-attempt network timeout budget.
    await this.rateLimiter.acquire(options.method, options.path, options.signal);

    const controller = this.linkAbortSignal(options.signal, this.config.timeoutMs);
    onStarted();

    return this.executeOnce<T>(execution, options, controller, onResponseComplete);
  }

  private async executeOnce<T>(
    execution: HttpExecutionRecord,
    options: RequestOptions,
    controller: LinkedAbortSignal,
    onResponseComplete: (response: Response, requestId: string | undefined) => void,
  ): Promise<AhaSendResponse<T>> {
    const { url, init } = execution;
    try {
      this.throwIfAttemptAborted(controller, options, "before fetch");

      let response: Response;
      try {
        response = await this.config.fetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string>) },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw this.createAttemptAbortError(controller, options, "during fetch", err);
        }
        if (err instanceof AhaSendAbortError || err instanceof AhaSendTimeoutError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new AhaSendAbortError("Request aborted", err);
        }
        throw new AhaSendConnectionError(
          `Network error while calling ${options.method} ${options.path}`,
          err,
        );
      }
      this.throwIfAttemptAborted(controller, options, "during fetch");

      // Keep the timer armed until the body has been fully read. A server
      // that sends headers quickly and then stalls remains inside this
      // attempt's timeout budget.
      const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;

      try {
        let data: T;
        try {
          data = await this.parseResponse<T>(response, execution.idempotency, requestId);
        } catch (err) {
          if (controller.signal.aborted) {
            throw this.createAttemptAbortError(controller, options, "during body read", err);
          }
          if (err instanceof AhaSendAbortError || err instanceof AhaSendTimeoutError) throw err;
          if (err instanceof Error && err.name === "AbortError") {
            throw new AhaSendAbortError("Request aborted during body read", err);
          }
          throw err;
        }
        this.throwIfAttemptAborted(controller, options, "during body read");

        return {
          data,
          response,
          ...(requestId ? { requestId } : {}),
          ...(response.headers.get(IDEMPOTENT_REPLAYED_HEADER) === "true"
            ? { idempotentReplayed: true as const }
            : {}),
        };
      } finally {
        onResponseComplete(response, requestId);
      }
    } finally {
      controller.cleanup();
    }
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(this.config.baseUrl);
    url.pathname = `/${path.replace(/^\/+/, "")}`;

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item === undefined || item === null) continue;
            url.searchParams.append(key, serializeQueryValue(item));
          }
        } else {
          url.searchParams.set(key, serializeQueryValue(value));
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
      redirect: "error",
    };

    if (options.body !== undefined && options.method !== "GET") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    if (options.idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_HEADER.toLowerCase()] = options.idempotencyKey;
    } else if (this.shouldAutoIdempotency(options)) {
      headers[IDEMPOTENCY_HEADER.toLowerCase()] = generateIdempotencyKey(
        this.config.idempotency.prefix,
      );
    }

    Object.freeze(headers);
    return Object.freeze(init);
  }

  private shouldAutoIdempotency(options: RequestOptions): boolean {
    if (!(options.execution?.idempotency ?? options.autoIdempotency)) return false;
    if (!this.config.idempotency.autoGenerate) return false;
    return options.method === "POST";
  }

  private buildExecutionRecord(
    options: RequestOptions,
    url: string,
    init: RequestInit,
  ): HttpExecutionRecord {
    const headers = init.headers as Record<string, string>;
    const key = headers[IDEMPOTENCY_HEADER.toLowerCase()];
    return Object.freeze({
      url,
      init,
      operationId: options.execution?.operationId ?? options.operationId,
      routeTemplate: options.execution
        ? OPERATION_DESCRIPTORS[options.execution.operationId].path
        : options.path,
      retryMode: options.execution?.retryMode ?? options.retryMode,
      idempotency: createIdempotencyExecutionRecord(options.execution?.idempotency ?? null, key),
    });
  }

  private buildAttemptEvent(
    execution: HttpExecutionRecord,
    options: RequestOptions,
    attempt: number,
  ): import("./telemetry.js").RequestEvent {
    return Object.freeze({
      operationId: execution.operationId,
      method: options.method,
      routeTemplate: execution.routeTemplate,
      attempt,
    });
  }

  private isRetryAllowed(execution: HttpExecutionRecord): boolean {
    if (execution.retryMode === "never") return false;
    if (execution.retryMode !== "idempotency_key") return true;
    return execution.idempotency.key !== undefined;
  }

  private async parseResponse<T>(
    response: Response,
    idempotency: IdempotencyExecutionRecord,
    requestIdFromHeader?: string,
  ): Promise<T> {
    const requestId = requestIdFromHeader ?? response.headers.get(REQUEST_ID_HEADER) ?? undefined;

    if (response.status === 204 || response.status === 205) {
      if (response.ok) return undefined as T;
    }

    const rawText = await response.text();
    const parsed = rawText.length > 0 ? safeJsonParse(rawText) : undefined;

    if (!response.ok) {
      throw createApiError({
        status: response.status,
        body: (parsed?.ok ? parsed.value : rawText) as ApiErrorBody | string | null,
        requestId,
        headers: headersToRecord(response.headers),
        idempotency,
      });
    }

    if (rawText.length === 0) return undefined as T;

    if (!parsed?.ok) {
      // 2xx with non-JSON body is suspicious (typically an HTML error page
      // from a misconfigured load balancer or a captive-portal redirect).
      // Surface it as a transport-layer parse error rather than as an
      // `AhaSendAPIError` carrying a 2xx status code — otherwise `catch`
      // blocks checking `status >= 500` will silently swallow it.
      throw new AhaSendResponseParseError({
        status: response.status,
        body: rawText,
        requestId,
        cause: parsed!.error,
      });
    }

    return parsed.value as T;
  }

  private linkAbortSignal(
    userSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): LinkedAbortSignal {
    const controller = new AbortController();
    let source: AbortSource | undefined;

    const abort = (nextSource: AbortSource, reason?: unknown) => {
      // The first cancellation source wins. In particular, a timeout that
      // fires after caller cancellation must not relabel the public error.
      if (controller.signal.aborted) return;
      source = nextSource;
      controller.abort(reason);
    };
    const onUserAbort = () => abort("caller", userSignal?.reason);
    if (userSignal) {
      if (userSignal.aborted) abort("caller", userSignal.reason);
      else userSignal.addEventListener("abort", onUserAbort, { once: true });
    }

    const timer =
      timeoutMs > 0 && !controller.signal.aborted
        ? setTimeout(() => {
            abort("timeout");
          }, timeoutMs)
        : null;

    return {
      signal: controller.signal,
      cleanup: () => {
        if (timer) clearTimeout(timer);
        if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
      },
      get source() {
        return source;
      },
    };
  }

  private throwIfAttemptAborted(
    controller: LinkedAbortSignal,
    options: RequestOptions,
    phase: AttemptPhase,
  ): void {
    if (controller.signal.aborted) {
      throw this.createAttemptAbortError(controller, options, phase, controller.signal.reason);
    }
  }

  private createAttemptAbortError(
    controller: LinkedAbortSignal,
    options: RequestOptions,
    phase: AttemptPhase,
    cause?: unknown,
  ): AhaSendAbortError | AhaSendTimeoutError {
    if (controller.source === "timeout") {
      const bodyRead = phase === "during body read" ? " response body read" : "";
      return new AhaSendTimeoutError(
        `Request${bodyRead} to ${options.method} ${options.path} timed out after ${this.config.timeoutMs}ms`,
        cause,
      );
    }
    const bodyRead = phase === "during body read" ? " during body read" : "";
    return new AhaSendAbortError(`Request aborted${bodyRead}`, cause);
  }
}

type AbortSource = "caller" | "timeout";
type AttemptPhase = "before fetch" | "during fetch" | "during body read";

interface LinkedAbortSignal {
  readonly signal: AbortSignal;
  readonly source: AbortSource | undefined;
  cleanup(): void;
}

interface HttpExecutionRecord {
  readonly url: string;
  readonly init: RequestInit;
  readonly operationId: OperationId | undefined;
  readonly routeTemplate: string;
  readonly retryMode: RetryMode | undefined;
  readonly idempotency: IdempotencyExecutionRecord;
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

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function extractRequestId(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { requestId?: unknown }).requestId;
  return typeof candidate === "string" ? candidate : undefined;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { status?: unknown }).status;
  return typeof candidate === "number" ? candidate : undefined;
}

function elapsedSince(startedAt: number | undefined): number {
  return startedAt === undefined ? 0 : Date.now() - startedAt;
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
