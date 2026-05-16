import {
  AhaSendAPIError,
  AhaSendConnectionError,
  AhaSendRateLimitError,
  AhaSendServerError,
  AhaSendTimeoutError,
} from "./errors.js";

export type RetryStrategy = "exponential" | "linear" | "constant";

export interface RetryConfig {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  strategy?: RetryStrategy;
  jitter?: boolean;
}

export interface ResolvedRetryConfig {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  strategy: RetryStrategy;
  jitter: boolean;
}

export const DEFAULT_RETRY_CONFIG: ResolvedRetryConfig = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  strategy: "exponential",
  jitter: true,
};

export function resolveRetryConfig(override?: RetryConfig): ResolvedRetryConfig {
  return {
    enabled: override?.enabled ?? DEFAULT_RETRY_CONFIG.enabled,
    maxRetries: override?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    baseDelayMs: override?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
    maxDelayMs: override?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    strategy: override?.strategy ?? DEFAULT_RETRY_CONFIG.strategy,
    jitter: override?.jitter ?? DEFAULT_RETRY_CONFIG.jitter,
  };
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof AhaSendTimeoutError) return true;
  if (err instanceof AhaSendConnectionError) return true;
  if (err instanceof AhaSendRateLimitError) return true;
  if (err instanceof AhaSendServerError) return true;
  // 408 Request Timeout is retryable per RFC 9110.
  if (err instanceof AhaSendAPIError && err.status === 408) return true;
  return false;
}

export function computeBackoffMs(
  attempt: number,
  config: ResolvedRetryConfig,
  random: () => number = Math.random,
): number {
  let delay: number;
  switch (config.strategy) {
    case "constant":
      delay = config.baseDelayMs;
      break;
    case "linear":
      delay = config.baseDelayMs * attempt;
      break;
    case "exponential":
    default:
      delay = config.baseDelayMs * Math.pow(2, attempt - 1);
      break;
  }

  delay = Math.min(delay, config.maxDelayMs);

  if (config.jitter) {
    delay = delay * (0.5 + random() * 0.5);
  }

  return Math.round(delay);
}

export function computeRetryDelayMs(
  err: unknown,
  attempt: number,
  config: ResolvedRetryConfig,
  random: () => number = Math.random,
): number {
  const backoff = computeBackoffMs(attempt, config, random);

  if (err instanceof AhaSendRateLimitError && err.retryAfterSeconds !== undefined) {
    // Honour the server's Retry-After hint in full. We do NOT clamp the
    // server hint to `maxDelayMs` — the server's pacing is the source of
    // truth, and clamping causes the SDK to retry too soon and get
    // re-rate-limited. `maxDelayMs` only bounds the local backoff.
    const serverHint = err.retryAfterSeconds * 1000;
    return Math.max(backoff, serverHint);
  }

  return backoff;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
