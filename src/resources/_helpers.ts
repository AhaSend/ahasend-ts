import type { IdempotencyRequestOptions, RequestOptions } from "../types/common.js";
import { assertRequestOptions } from "../config.js";
export type { IdempotencyRequestOptions } from "../types/common.js";

interface ForwardedOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  autoIdempotency?: true;
}

export function forwardOptions(options: RequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options);
  const out: ForwardedOptions = {};
  if (options.signal) out.signal = options.signal;
  if (options.headers) out.headers = options.headers;
  return out;
}

/**
 * For the 9 spec-documented idempotency endpoints. Sets `autoIdempotency`
 * so the HTTP layer will inject an `Idempotency-Key` when the caller has
 * not supplied one; everything else (e.g. `domains.checkDns()`) opts out
 * by using `forwardOptions()` instead.
 */
export function forwardWithIdempotency(options: IdempotencyRequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options, true);
  const base: ForwardedOptions = {};
  if (options.signal) base.signal = options.signal;
  if (options.headers) base.headers = options.headers;
  base.autoIdempotency = true;
  if (options.idempotencyKey !== undefined) {
    base.headers = { ...(base.headers ?? {}), "Idempotency-Key": options.idempotencyKey };
  }
  return base;
}
