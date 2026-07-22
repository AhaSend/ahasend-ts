import type { IdempotencyRequestOptions, RequestOptions } from "../types/common.js";
import { assertRequestOptions } from "../config.js";
export type { IdempotencyRequestOptions } from "../types/common.js";

interface ForwardedOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
  readonly idempotencyKey?: string;
}

export function forwardOptions(options: RequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options);
  return Object.freeze({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.headers ? { headers: Object.freeze({ ...options.headers }) } : {}),
  });
}

/** Validate and freeze idempotency-aware request options for executor dispatch. */
export function forwardWithIdempotency(options: IdempotencyRequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options, true);
  return Object.freeze({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.headers ? { headers: Object.freeze({ ...options.headers }) } : {}),
    ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
  });
}
