import {
  AhaSendAbortError,
  AhaSendAPIError,
  AhaSendConfigurationError,
  AhaSendConnectionError,
  AhaSendIdempotencyConflictError,
  AhaSendRateLimitError,
  AhaSendServerError,
  AhaSendTimeoutError,
} from "./errors.js";

export type RetryStrategy = "exponential" | "linear" | "constant";

export const MAX_RETRIES = 20;

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

/** Resolve a per-call retry restriction without broadening the client policy. */
export function resolveRetryOverride(
  configured: ResolvedRetryConfig,
  override?: false | Partial<RetryConfig>,
): ResolvedRetryConfig {
  if (override === undefined) return configured;
  if (override === false) return { ...configured, enabled: false };

  if (override.enabled === true && !configured.enabled) {
    throw new AhaSendConfigurationError(
      "AhaSend: `request options.retry.enabled` cannot enable retries disabled by the client.",
    );
  }

  assertRetryLimitDoesNotIncrease("maxRetries", override.maxRetries, configured.maxRetries);
  assertRetryLimitDoesNotIncrease("baseDelayMs", override.baseDelayMs, configured.baseDelayMs);
  assertRetryLimitDoesNotIncrease("maxDelayMs", override.maxDelayMs, configured.maxDelayMs);

  if (override.strategy !== undefined && override.strategy !== configured.strategy) {
    throw new AhaSendConfigurationError(
      "AhaSend: `request options.retry.strategy` cannot change the client retry strategy.",
    );
  }
  if (override.jitter !== undefined && override.jitter !== configured.jitter) {
    throw new AhaSendConfigurationError(
      "AhaSend: `request options.retry.jitter` cannot change the client retry jitter setting.",
    );
  }

  const resolved: ResolvedRetryConfig = {
    enabled: override.enabled ?? configured.enabled,
    maxRetries: override.maxRetries ?? configured.maxRetries,
    baseDelayMs: override.baseDelayMs ?? configured.baseDelayMs,
    maxDelayMs: override.maxDelayMs ?? configured.maxDelayMs,
    strategy: override.strategy ?? configured.strategy,
    jitter: override.jitter ?? configured.jitter,
  };
  if (resolved.maxDelayMs < resolved.baseDelayMs) {
    throw new AhaSendConfigurationError(
      "AhaSend: resolved `request options.retry.maxDelayMs` must be greater than or equal to `baseDelayMs`.",
    );
  }
  return resolved;
}

function assertRetryLimitDoesNotIncrease(
  field: "maxRetries" | "baseDelayMs" | "maxDelayMs",
  override: number | undefined,
  configured: number,
): void {
  if (override !== undefined && override > configured) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`request options.retry.${field}\` cannot exceed the client value (${configured}).`,
    );
  }
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof AhaSendAbortError) return false;
  if (err instanceof AhaSendTimeoutError) return true;
  if (err instanceof AhaSendConnectionError) return true;
  if (err instanceof AhaSendIdempotencyConflictError) return true;
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

  if (
    (err instanceof AhaSendRateLimitError || err instanceof AhaSendIdempotencyConflictError) &&
    err.retryAfterSeconds !== undefined &&
    Number.isSafeInteger(err.retryAfterSeconds) &&
    err.retryAfterSeconds > 0
  ) {
    // A valid server delay is authoritative, while the caller's configured
    // maximum remains the upper bound on how long one retry can sleep.
    return Math.min(err.retryAfterSeconds * 1000, config.maxDelayMs);
  }

  return backoff;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AhaSendAbortError("Request aborted", signal.reason));
      return;
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new AhaSendAbortError("Request aborted", signal?.reason));
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
