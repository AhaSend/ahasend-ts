import type { RequestOptions } from "../types/common.js";

export interface IdempotencyRequestOptions extends RequestOptions {
  idempotencyKey?: string;
}

export function forwardOptions(
  options: RequestOptions = {},
): { signal?: AbortSignal; headers?: Record<string, string> } {
  const out: { signal?: AbortSignal; headers?: Record<string, string> } = {};
  if (options.signal) out.signal = options.signal;
  if (options.headers) out.headers = options.headers;
  return out;
}

export function forwardWithIdempotency(
  options: IdempotencyRequestOptions = {},
): { signal?: AbortSignal; headers?: Record<string, string> } {
  const base = forwardOptions(options);
  if (options.idempotencyKey) {
    base.headers = { ...(base.headers ?? {}), "Idempotency-Key": options.idempotencyKey };
  }
  return base;
}
