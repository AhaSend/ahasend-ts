import type { IdempotencyRequestOptions, RequestOptions } from "../types/common.js";
import { assertRequestOptions } from "../config.js";
export type { IdempotencyRequestOptions } from "../types/common.js";

interface ForwardedOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
}

/** Build a public facade whose methods and getters remain bound to private resource state. */
export function createFrozenFacade<T extends object>(resource: T): Readonly<T> {
  const facade: Record<PropertyKey, unknown> = {};
  const prototype = Object.getPrototypeOf(resource) as object | null;

  if (prototype) {
    for (const key of Reflect.ownKeys(prototype)) {
      if (key === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      const descriptorValue: unknown = descriptor?.value;
      const boundGetter = descriptor?.get?.bind(resource);
      if (typeof descriptorValue === "function") {
        const method = descriptorValue as (...args: unknown[]) => unknown;
        Object.defineProperty(facade, key, {
          value: method.bind(resource),
          writable: false,
          enumerable: false,
          configurable: false,
        });
      } else if (boundGetter !== undefined) {
        Object.defineProperty(facade, key, {
          get: boundGetter,
          enumerable: false,
          configurable: false,
        });
      }
    }
  }

  return Object.freeze(facade) as Readonly<T>;
}

export function forwardOptions(options: RequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options);
  return Object.freeze({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.headers ? { headers: Object.freeze({ ...options.headers }) } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/** Validate and freeze idempotency-aware request options for executor dispatch. */
export function forwardWithIdempotency(options: IdempotencyRequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options, true);
  return Object.freeze({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.headers ? { headers: Object.freeze({ ...options.headers }) } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
  });
}
