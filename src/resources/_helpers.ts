import type { RequestOptions } from "../types/common.js";

export interface IdempotencyRequestOptions extends RequestOptions {
  idempotencyKey?: string;
}

interface ForwardedOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  autoIdempotency?: true;
}

export function forwardOptions(options: RequestOptions = {}): ForwardedOptions {
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
export function forwardWithIdempotency(
  options: IdempotencyRequestOptions = {},
): ForwardedOptions {
  const base = forwardOptions(options);
  base.autoIdempotency = true;
  if (options.idempotencyKey) {
    base.headers = { ...(base.headers ?? {}), "Idempotency-Key": options.idempotencyKey };
  }
  return base;
}
