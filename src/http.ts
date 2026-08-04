import { Buffer } from "node:buffer";
import type { ReadableStreamReadResult } from "node:stream/web";
import type { ResolvedConfig } from "./config.js";
import { assertHeaders, assertRequestRetryOverride, assertTimeoutMs } from "./config.js";
import {
  AhaSendAbortError,
  AhaSendConfigurationError,
  AhaSendConnectionError,
  AhaSendError,
  AhaSendIdempotencyConflictError,
  AhaSendRateLimitQueueFullError,
  AhaSendResponseParseError,
  AhaSendResponseTooLargeError,
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
import { computeRetryDelayMs, isRetryableError, resolveRetryOverride, sleep } from "./retry.js";
import type { ResolvedRetryConfig, RetryConfig } from "./retry.js";
import type { AhaSendPromise, AhaSendResponse } from "./types/common.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  /** Validated explicit key forwarded separately from caller-controlled headers. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Per-attempt override for the configured timeout. */
  timeoutMs?: number;
  /** Per-call restriction of the configured retry policy. */
  retry?: false | Partial<RetryConfig>;
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

/**
 * Ceiling on a buffered API response body, counted AFTER decompression.
 *
 * Deliberately the same number as the inbound webhook ceiling
 * (`MAX_WEBHOOK_BODY_BYTES`): the SDK should not cap attacker-adjacent inbound
 * data at 30 MB while accepting unbounded data on the path that carries the
 * bearer token. The largest legitimate response is a `limit=100` page, orders
 * of magnitude below this.
 *
 * A `content-length` precheck would not do: under `content-encoding: gzip` the
 * header reports the compressed size, and under chunked encoding there is no
 * header at all.
 */
export const MAX_RESPONSE_BYTES = 30_000_000;

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
    if (options.timeoutMs !== undefined) {
      assertTimeoutMs(options.timeoutMs, "request timeoutMs");
    }
    if (options.retry !== undefined) {
      assertRequestRetryOverride(options.retry);
    }
    const retry = resolveRetryOverride(this.config.retry, options.retry);
    let responseEnvelope: AhaSendResponse<T>;
    const bodyPromise = this.requestWithResponse<T>(options, retry).then((envelope) => {
      responseEnvelope = envelope;
      return envelope.data;
    }) as AhaSendPromise<T>;
    // Derive the envelope view from the public body promise. Consuming either
    // view observes the same rejection, while an entirely ignored failed
    // request remains an unhandled rejection as callers expect from a Promise.
    bodyPromise.withResponse = () => bodyPromise.then(() => responseEnvelope);
    return bodyPromise;
  }

  private async requestWithResponse<T>(
    options: RequestOptions,
    retry: ResolvedRetryConfig,
  ): Promise<AhaSendResponse<T>> {
    const url = this.buildUrl(options.path, options.query);
    const init = this.buildRequestInit(options);
    this.assertRequestConstructible(url, init, options);
    const execution = this.buildExecutionRecord(options, url, init);

    const maxAttempts = retry.enabled && this.isRetryAllowed(execution) ? retry.maxRetries + 1 : 1;
    const hooks = this.config.hooks;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptEvent = this.buildAttemptEvent(execution, options, attempt);
      const pacingStartedAt = performance.now();
      try {
        await this.rateLimiter.acquire(options.method, options.path, options.signal);
      } catch (err) {
        // A pacing refusal on a retry means the API error that caused the retry
        // is also worth reporting. Carry it as the refusal's `cause` rather than
        // reporting it instead: queue-full is deliberately non-retryable, while
        // the API error that preceded it usually is, and handing the caller the
        // retryable one tells them to re-queue into the queue that just refused
        // them.
        //
        // Only queue-full is wrapped. `acquire` also rejects with
        // AhaSendAbortError, and a caller's cancellation must keep its own
        // identity — relabelling it would both contradict the cancellation
        // contract and make an aborted call look retryable.
        const reported =
          err instanceof AhaSendRateLimitQueueFullError && lastError !== undefined
            ? new AhaSendRateLimitQueueFullError(err.category, err.maxQueue, lastError)
            : err;
        const errorEvent: import("./telemetry.js").ErrorEvent = {
          ...attemptEvent,
          phase: "pacing",
          durationMs: elapsedSince(pacingStartedAt),
          error: reported,
        };
        void hooks.onError(Object.freeze(errorEvent));
        throw reported;
      }

      const controller = this.linkAbortSignal(
        options.signal,
        options.timeoutMs ?? this.config.timeoutMs,
      );
      const attemptStartedAt = performance.now();
      void hooks.onRequest(attemptEvent);

      try {
        const envelope = await this.executeOnce<T>(execution, options, controller);
        const responseEvent: import("./telemetry.js").ResponseEvent = {
          ...attemptEvent,
          status: envelope.response.status,
          durationMs: elapsedSince(attemptStartedAt),
        };
        if (envelope.requestId) responseEvent.requestId = envelope.requestId;
        void hooks.onResponse(Object.freeze(responseEvent));
        return envelope;
      } catch (err) {
        lastError = err;
        const durationMs = elapsedSince(attemptStartedAt);
        const requestId = extractRequestId(err);
        const status = extractStatus(err);
        const errorEvent: import("./telemetry.js").ErrorEvent = {
          ...attemptEvent,
          phase: "attempt",
          durationMs,
          error: err,
        };
        if (status !== undefined) errorEvent.status = status;
        if (requestId) errorEvent.requestId = requestId;
        void hooks.onError(Object.freeze(errorEvent));
        if (attempt === maxAttempts) {
          throw finalizeIdempotencyConflict(err, execution.idempotency.key);
        }
        if (!isRetryableError(err)) throw err;
        const delayMs = computeRetryDelayMs(err, attempt, retry);
        const retryEvent: import("./telemetry.js").RetryEvent = {
          ...attemptEvent,
          delayMs,
          durationMs,
          error: err,
        };
        if (status !== undefined) retryEvent.status = status;
        if (requestId) retryEvent.requestId = requestId;
        void hooks.onRetry(Object.freeze(retryEvent));
        const backoffStartedAt = performance.now();
        try {
          await sleep(delayMs, options.signal);
        } catch (backoffError) {
          const backoffEvent: import("./telemetry.js").ErrorEvent = {
            ...attemptEvent,
            phase: "backoff",
            durationMs: elapsedSince(backoffStartedAt),
            error: backoffError,
          };
          if (status !== undefined) backoffEvent.status = status;
          if (requestId) backoffEvent.requestId = requestId;
          void hooks.onError(Object.freeze(backoffEvent));
          throw backoffError;
        }
      }
    }
    throw lastError;
  }

  private async executeOnce<T>(
    execution: HttpExecutionRecord,
    options: RequestOptions,
    controller: LinkedAbortSignal,
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
        if (AhaSendError.is(err)) throw err;
        if (isAbortError(err)) {
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

      let data: T;
      try {
        data = await this.parseResponse<T>(response, execution.idempotency, options, requestId);
      } catch (err) {
        if (controller.signal.aborted) {
          throw this.createAttemptAbortError(controller, options, "during body read", err);
        }
        if (AhaSendError.is(err)) throw err;
        if (isAbortError(err)) {
          throw new AhaSendAbortError("Request aborted during body read", err);
        }
        throw new AhaSendConnectionError(
          `Network error while reading the response body for ${options.method} ${options.path}`,
          err,
        );
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

  private assertRequestConstructible(
    url: string,
    init: RequestInit,
    options: RequestOptions,
  ): void {
    try {
      // Native fetch reports both invalid Request inputs and network failures
      // as rejected TypeErrors. Validate the stable request inputs before the
      // retry loop so deterministic construction failures cannot be mistaken
      // for retryable connection failures.
      //
      // The body is dropped deliberately: nothing being checked here depends
      // on it, and passing it makes `Request` encode a second copy of the
      // payload on every call — measured at 8ms and 5MB of garbage for a 5MB
      // attachment send, against 0.01ms without.
      //
      // `Request` is also not required. A caller who supplies `options.fetch`
      // may be doing so precisely because the global fetch stack is absent or
      // unusable (a fetch-only polyfill, or `--no-experimental-fetch` — which
      // Node 22 still accepts and 24 rejects outright, so the flag reaches only
      // the minimum supported leg), and
      // hard-requiring the constructor would break the escape hatch in exactly
      // the environments it exists for.
      //
      // Skipping it there costs nothing that is reachable: every input this
      // would examine is already validated earlier — the URL by `new URL` in
      // buildUrl, `apiKey` and `userAgent` by resolveConfig, `defaultHeaders`
      // by resolveConfig storing the *snapshot* assertHeaders returns rather
      // than re-reading the caller's object, and per-call headers and
      // idempotency keys at the top of `request`. This check is a backstop
      // against a future input that skips those, not the primary guard.
      //
      // A sentinel body rather than none: `Request` rejects a body on a
      // bodyless method, and that is the one check here that needs a body
      // present. An empty string preserves it for 0.03ms instead of the 8ms
      // the real payload costs.
      const { body, ...bodylessInit } = init;
      if (typeof Request === "function") {
        void new Request(url, body === undefined ? bodylessInit : { ...bodylessInit, body: "" });
      }
    } catch (err) {
      throw new AhaSendConfigurationError(
        `AhaSend: failed to construct request for ${options.method} ${options.path}.`,
        err,
      );
    }
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

  /**
   * Buffer a response body, refusing to grow past {@link MAX_RESPONSE_BYTES}.
   *
   * `response.text()` reads to completion with no ceiling, so a compressed body
   * could inflate a few hundred kilobytes on the wire into hundreds of
   * megabytes resident — and because that surfaced as a generic failure the
   * retry policy repeated it. The stream yields decompressed bytes, so counting
   * here is what bounds the amplification.
   */
  private async readBoundedText(response: Response, options: RequestOptions): Promise<string> {
    const body = response.body;
    // A null-body response (204/205/304) or an injected fetch returning a
    // Response built without a stream: nothing to bound.
    if (!body) return response.text();

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          // Stop pulling immediately rather than reading to the end and then
          // rejecting — that is the whole point of the ceiling.
          void reader.cancel().catch(() => undefined);
          throw new AhaSendResponseTooLargeError(MAX_RESPONSE_BYTES, options.method, options.path);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  }

  private async parseResponse<T>(
    response: Response,
    idempotency: IdempotencyExecutionRecord,
    options: RequestOptions,
    requestIdFromHeader?: string,
  ): Promise<T> {
    const requestId = requestIdFromHeader ?? response.headers.get(REQUEST_ID_HEADER) ?? undefined;

    if (response.status === 204 || response.status === 205) {
      if (response.ok) return undefined as T;
    }

    const rawText = await this.readBoundedText(response, options);
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
      timeoutMs,
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
        `Request${bodyRead} to ${options.method} ${options.path} timed out after ${controller.timeoutMs}ms`,
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
  readonly timeoutMs: number;
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

function lowercaseHeaders(headers?: Readonly<Record<string, string>>): Record<string, string> {
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

function isAbortError(error: unknown): boolean {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
  try {
    return Reflect.get(error, "name") === "AbortError";
  } catch {
    return false;
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

function finalizeIdempotencyConflict(error: unknown, key: string | undefined): unknown {
  if (!(error instanceof AhaSendIdempotencyConflictError) || key === undefined) return error;

  return new AhaSendIdempotencyConflictError({
    status: error.status,
    message: error.message,
    body: error.body,
    requestId: error.requestId,
    headers: error.headers,
    cause: error.cause,
    retryAfterSeconds: error.retryAfterSeconds,
    idempotencyKey: key,
  });
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
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
