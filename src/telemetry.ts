import type { OperationId } from "./generated/operations.js";

export interface RequestEvent {
  /** Generated OpenAPI operation identity, when the request uses a known operation. */
  operationId: OperationId | undefined;
  method: string;
  /** OpenAPI route template. Path parameters are never expanded with caller values. */
  routeTemplate: string;
  attempt: number;
}

export interface ResponseEvent extends RequestEvent {
  status: number;
  durationMs: number;
  /** AhaSend's `x-request-id`, when the server returned one. */
  requestId?: string;
}

export interface RetryEvent extends RequestEvent {
  delayMs: number;
  durationMs: number;
  error: unknown;
  /** HTTP status from the failed response, when a response was received. */
  status?: number;
  /** AhaSend's `x-request-id` from the failed response, when present. */
  requestId?: string;
}

export interface ErrorEvent extends RequestEvent {
  durationMs: number;
  error: unknown;
  /** HTTP status from the failed response, when a response was received. */
  status?: number;
  /** AhaSend's `x-request-id` from the failed response, when present. */
  requestId?: string;
}

export interface TelemetryHooks {
  onRequest?(event: RequestEvent): void;
  onResponse?(event: ResponseEvent): void;
  onRetry?(event: RetryEvent): void;
  onError?(event: ErrorEvent): void;
}

export type ResolvedTelemetryHooks = Required<{
  [K in keyof TelemetryHooks]: TelemetryHooks[K];
}>;

const NOOP = () => {};

export function resolveTelemetryHooks(hooks?: TelemetryHooks): ResolvedTelemetryHooks {
  // Snapshot the callback references once. Re-reading a caller-owned hook
  // container during a request would let later mutation (including a throwing
  // property accessor) escape the telemetry isolation boundary.
  const onRequest = hooks?.onRequest;
  const onResponse = hooks?.onResponse;
  const onRetry = hooks?.onRetry;
  const onError = hooks?.onError;

  return {
    onRequest: (event) => deferCall(onRequest, event),
    onResponse: (event) => deferCall(onResponse, event),
    onRetry: (event) => deferCall(onRetry, event),
    onError: (event) => deferCall(onError, event),
  };
}

/**
 * Compose multiple hook sets so each registered handler is invoked.
 * Errors thrown inside a hook are swallowed so a noisy logger can never
 * break the request pipeline.
 */
export function composeHooks(...hookSets: Array<TelemetryHooks | undefined>): TelemetryHooks {
  const sets = hookSets.filter((h): h is TelemetryHooks => h !== undefined);
  if (sets.length === 0) return {};
  const onRequestHooks = sets.map((set) => set.onRequest);
  const onResponseHooks = sets.map((set) => set.onResponse);
  const onRetryHooks = sets.map((set) => set.onRetry);
  const onErrorHooks = sets.map((set) => set.onError);

  return {
    onRequest: (event) => {
      for (const hook of onRequestHooks) safeCall(hook, event);
    },
    onResponse: (event) => {
      for (const hook of onResponseHooks) safeCall(hook, event);
    },
    onRetry: (event) => {
      for (const hook of onRetryHooks) safeCall(hook, event);
    },
    onError: (event) => {
      for (const hook of onErrorHooks) safeCall(hook, event);
    },
  };
}

function deferCall<T>(fn: ((event: T) => void) | undefined, event: T): void {
  if (!fn) return;
  queueMicrotask(() => safeCall(fn, event));
}

function safeCall<T>(fn: ((event: T) => void) | undefined, event: T): void {
  if (!fn) return;
  try {
    // A callback typed as returning void may still return a Promise in TypeScript.
    // Observe that promise solely to prevent a rejected hook from becoming unhandled.
    const result = (fn as (value: T) => unknown)(event);
    if (result) void Promise.resolve(result).catch(NOOP);
  } catch {
    // hooks must never throw into the request pipeline
  }
}

/**
 * Console-logging hook set, attached automatically when `debug: true`
 * is set on the client.
 */
export function debugConsoleHooks(out?: (msg: string) => void): TelemetryHooks {
  const write = (msg: string): void => {
    if (out) {
      out(msg);
      return;
    }
    // Lazy lookup so test stubs of console.error are honoured.
    console.error(msg);
  };

  return {
    onRequest: (e) => write(`[ahasend] -> ${e.method} ${e.routeTemplate} (attempt ${e.attempt})`),
    onResponse: (e) =>
      write(
        `[ahasend] <- ${e.method} ${e.routeTemplate} ${e.status} (${e.durationMs}ms, attempt ${e.attempt})`,
      ),
    onError: (e) =>
      write(
        `[ahasend] !! ${e.method} ${e.routeTemplate} attempt ${e.attempt}: ${describeError(e.error)}`,
      ),
    onRetry: (e) =>
      write(
        `[ahasend] ?? ${e.method} ${e.routeTemplate} retrying after ${e.delayMs}ms (attempt ${e.attempt} failed: ${describeError(e.error)})`,
      ),
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
