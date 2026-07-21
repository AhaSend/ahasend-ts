import { randomUUID } from "node:crypto";

export interface IdempotencyConfig {
  autoGenerate?: boolean;
  prefix?: string;
}

export interface ResolvedIdempotencyConfig {
  readonly autoGenerate: boolean;
  readonly prefix: string;
}

export const DEFAULT_IDEMPOTENCY_CONFIG: ResolvedIdempotencyConfig = Object.freeze({
  autoGenerate: true,
  prefix: "",
});

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const UUID_LENGTH = 36;
const INVALID_HEADER_VALUE_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f]|[^\u0000-\u00ff]/;
const HTTP_EDGE_WHITESPACE_PATTERN = /^[\t ]|[\t ]$/;

export function resolveIdempotencyConfig(override?: IdempotencyConfig): ResolvedIdempotencyConfig {
  if (override !== undefined) {
    if (typeof override !== "object" || override === null || Array.isArray(override)) {
      throw new Error("AhaSend: `idempotency` must be an object.");
    }
    const prototype = Object.getPrototypeOf(override) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("AhaSend: `idempotency` must be a plain object.");
    }
    for (const key of Object.keys(override)) {
      if (key !== "autoGenerate" && key !== "prefix") {
        throw new Error(`AhaSend: unknown \`idempotency.${key}\` option.`);
      }
    }
    if (override.autoGenerate !== undefined && typeof override.autoGenerate !== "boolean") {
      throw new Error("AhaSend: `idempotency.autoGenerate` must be a boolean.");
    }
    if (override.prefix !== undefined) assertValidPrefix(override.prefix);
  }

  return {
    autoGenerate: override?.autoGenerate ?? DEFAULT_IDEMPOTENCY_CONFIG.autoGenerate,
    prefix: override?.prefix ?? DEFAULT_IDEMPOTENCY_CONFIG.prefix,
  };
}

/**
 * Generate a fresh idempotency key.
 *
 * If `prefix` is provided it is **literally prepended** to a UUID v4 —
 * no separator is inserted. Set `prefix` to `"myapp-"` if you want a
 * dash between the prefix and the UUID; passing `"myapp"` produces
 * `"myapp<uuid>"` with no separator. (Earlier versions of this SDK
 * inserted a `-`, which produced `"myapp--<uuid>"` for callers who
 * already included their own.)
 */
export function generateIdempotencyKey(prefix?: string): string {
  if (prefix !== undefined) assertValidPrefix(prefix);
  const uuid = randomUUID();
  return prefix && prefix.length > 0 ? `${prefix}${uuid}` : uuid;
}

/** @internal Validate caller-provided keys before they reach fetch. */
export function assertValidIdempotencyKey(
  key: unknown,
  name = "idempotency key",
): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(`AhaSend: \`${name}\` must be a non-empty string.`);
  }
  if (HTTP_EDGE_WHITESPACE_PATTERN.test(key)) {
    throw new Error(`AhaSend: \`${name}\` must not start or end with spaces or tabs.`);
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(
      `AhaSend: \`${name}\` must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
  if (INVALID_HEADER_VALUE_PATTERN.test(key)) {
    throw new Error(`AhaSend: \`${name}\` contains characters that are invalid in an HTTP header.`);
  }
}

export class IdempotencyKeyBuilder {
  private used = false;

  constructor(private readonly baseKey: string) {
    assertValidIdempotencyKey(baseKey, "IdempotencyKeyBuilder.baseKey");
  }

  next(): string {
    if (!this.used) {
      this.used = true;
      return this.baseKey;
    }
    const key = `${this.baseKey}-${randomUUID()}`;
    assertValidIdempotencyKey(key, "IdempotencyKeyBuilder.next() result");
    return key;
  }

  withSuffix(suffix: string): string {
    assertValidIdempotencyKey(suffix, "IdempotencyKeyBuilder.withSuffix suffix");
    const key = `${this.baseKey}-${suffix}`;
    assertValidIdempotencyKey(key, "IdempotencyKeyBuilder.withSuffix() result");
    return key;
  }
}

function assertValidPrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== "string") {
    throw new Error("AhaSend: `idempotency.prefix` must be a string.");
  }
  if (prefix.length > MAX_IDEMPOTENCY_KEY_LENGTH - UUID_LENGTH) {
    throw new Error(
      `AhaSend: \`idempotency.prefix\` must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH - UUID_LENGTH} characters so generated keys fit the API limit.`,
    );
  }
  if (/^[\t ]/.test(prefix)) {
    throw new Error("AhaSend: `idempotency.prefix` must not start with spaces or tabs.");
  }
  if (INVALID_HEADER_VALUE_PATTERN.test(prefix)) {
    throw new Error(
      "AhaSend: `idempotency.prefix` contains characters that are invalid in an HTTP header.",
    );
  }
}
