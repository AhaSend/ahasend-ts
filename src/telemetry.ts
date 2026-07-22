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
  return {
    onRequest: (event) => deferCall(hooks?.onRequest, event),
    onResponse: (event) => deferCall(hooks?.onResponse, event),
    onRetry: (event) => deferCall(hooks?.onRetry, event),
    onError: (event) => deferCall(hooks?.onError, event),
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

  return {
    onRequest: (event) => {
      for (const set of sets) safeCall(set.onRequest, event);
    },
    onResponse: (event) => {
      for (const set of sets) safeCall(set.onResponse, event);
    },
    onRetry: (event) => {
      for (const set of sets) safeCall(set.onRetry, event);
    },
    onError: (event) => {
      for (const set of sets) safeCall(set.onError, event);
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
