import type { IdempotencyRequestOptions, RequestOptions } from "../types/common.js";
import { assertRequestOptions } from "../config.js";
export type { IdempotencyRequestOptions } from "../types/common.js";

interface ForwardedOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
  readonly autoIdempotency?: true;
}

export function forwardOptions(options: RequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options);
  return Object.freeze({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.headers ? { headers: Object.freeze({ ...options.headers }) } : {}),
  });
}

/**
 * For the 9 spec-documented idempotency endpoints. Sets `autoIdempotency`
 * so the HTTP layer will inject an `Idempotency-Key` when the caller has
 * not supplied one; everything else (e.g. `domains.checkDns()`) opts out
 * by using `forwardOptions()` instead.
 */
export function forwardWithIdempotency(options: IdempotencyRequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options, true);
  const headers =
    options.headers || options.idempotencyKey !== undefined
      ? Object.freeze({
          ...(options.headers ?? {}),
          ...(options.idempotencyKey !== undefined
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
        })
      : undefined;
  return Object.freeze({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(headers ? { headers } : {}),
    autoIdempotency: true,
  });
}
