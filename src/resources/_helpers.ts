import type { IdempotencyRequestOptions, RequestOptions } from "../types/common.js";
import type { RetryConfig } from "../retry.js";
import { assertRequestOptions } from "../config.js";
import { AhaSendConfigurationError } from "../errors.js";
export type { IdempotencyRequestOptions } from "../types/common.js";

/**
 * Enforce the spec's `minItems: 1` on a request-body array.
 *
 * These fields are typed `readonly T[]` rather than a non-empty tuple so that
 * arrays built at runtime (`rows.map(...)`) assign without a cast — the tuple
 * form rejected them with an error that never mentioned emptiness. The
 * guarantee moves here, where it also covers JavaScript callers, and fails
 * before the request goes out instead of as a server-side 422.
 */
export function assertNonEmptyArray(
  value: unknown,
  field: string,
): asserts value is readonly [unknown, ...unknown[]] {
  if (!Array.isArray(value)) {
    throw new AhaSendConfigurationError(`AhaSend: \`${field}\` must be an array.`);
  }
  if (value.length === 0) {
    throw new AhaSendConfigurationError(`AhaSend: \`${field}\` must contain at least one item.`);
  }
}

interface ForwardedOptions {
  readonly signal?: AbortSignal | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly retry?: false | Readonly<Partial<RetryConfig>> | undefined;
  readonly idempotencyKey?: string | undefined;
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
    ...(options.retry !== undefined ? { retry: freezeRetryOverride(options.retry) } : {}),
  });
}

/** Validate and freeze idempotency-aware request options for executor dispatch. */
export function forwardWithIdempotency(options: IdempotencyRequestOptions = {}): ForwardedOptions {
  assertRequestOptions(options, true);
  return Object.freeze({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.headers ? { headers: Object.freeze({ ...options.headers }) } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.retry !== undefined ? { retry: freezeRetryOverride(options.retry) } : {}),
    ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
  });
}

function freezeRetryOverride(
  retry: false | Partial<RetryConfig>,
): false | Readonly<Partial<RetryConfig>> {
  return retry === false ? false : Object.freeze({ ...retry });
}
