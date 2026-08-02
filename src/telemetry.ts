export interface RequestEvent {
  /** Generated OpenAPI operation identity, when the request uses a known operation. */
  operationId: string | undefined;
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

/** Isolated observability callbacks for the request attempt lifecycle. */
export interface TelemetryHooks {
  /** Runs when an attempt starts. The request does not wait for the returned promise. */
  onRequest?(event: RequestEvent): void | Promise<void>;
  /** Runs after a response is read. The request does not wait for the returned promise. */
  onResponse?(event: ResponseEvent): void | Promise<void>;
  /** Runs before a retry delay. The request does not wait for the returned promise. */
  onRetry?(event: RetryEvent): void | Promise<void>;
  /** Runs after the operation fails. The request does not wait for the returned promise. */
  onError?(event: ErrorEvent): void | Promise<void>;
}

export type ResolvedTelemetryHooks = Required<{
  [K in keyof TelemetryHooks]: TelemetryHooks[K];
}>;

const NOOP = () => {};

export function resolveTelemetryHooks(hooks?: TelemetryHooks): ResolvedTelemetryHooks {
  // Snapshot the callback references once. Re-reading a caller-owned hook
  // container during a request would let later mutation (including a throwing
  // property accessor) escape the telemetry isolation boundary.
  const onRequest = hooks?.onRequest?.bind(undefined);
  const onResponse = hooks?.onResponse?.bind(undefined);
  const onRetry = hooks?.onRetry?.bind(undefined);
  const onError = hooks?.onError?.bind(undefined);

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
  const onRequestHooks = sets.map((set) => set.onRequest?.bind(undefined));
  const onResponseHooks = sets.map((set) => set.onResponse?.bind(undefined));
  const onRetryHooks = sets.map((set) => set.onRetry?.bind(undefined));
  const onErrorHooks = sets.map((set) => set.onError?.bind(undefined));

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

function deferCall<T>(fn: ((event: T) => void | Promise<void>) | undefined, event: T): void {
  if (!fn) return;
  queueMicrotask(() => safeCall(fn, event));
}

function safeCall<T>(fn: ((event: T) => void | Promise<void>) | undefined, event: T): void {
  if (!fn) return;
  try {
    // Observe returned promises solely to prevent a rejected hook from becoming unhandled.
    const result = fn(event);
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
