export interface RequestEvent {
  method: string;
  path: string;
  url: string;
  attempt: number;
}

export interface ResponseEvent {
  method: string;
  path: string;
  url: string;
  status: number;
  durationMs: number;
  attempt: number;
}

export interface RetryEvent {
  method: string;
  path: string;
  url: string;
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface ErrorEvent {
  method: string;
  path: string;
  url: string;
  attempt: number;
  error: unknown;
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
    onRequest: hooks?.onRequest ?? NOOP,
    onResponse: hooks?.onResponse ?? NOOP,
    onRetry: hooks?.onRetry ?? NOOP,
    onError: hooks?.onError ?? NOOP,
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
  if (sets.length === 1) return sets[0]!;

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

function safeCall<T>(fn: ((event: T) => void) | undefined, event: T): void {
  if (!fn) return;
  try {
    fn(event);
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
    onRequest: (e) => write(`[ahasend] -> ${e.method} ${e.path} (attempt ${e.attempt})`),
    onResponse: (e) =>
      write(
        `[ahasend] <- ${e.method} ${e.path} ${e.status} (${e.durationMs}ms, attempt ${e.attempt})`,
      ),
    onError: (e) =>
      write(
        `[ahasend] !! ${e.method} ${e.path} attempt ${e.attempt}: ${describeError(e.error)}`,
      ),
    onRetry: (e) =>
      write(
        `[ahasend] ?? ${e.method} ${e.path} retrying after ${e.delayMs}ms (attempt ${e.attempt} failed: ${describeError(e.error)})`,
      ),
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
