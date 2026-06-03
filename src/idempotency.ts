import { randomUUID } from "node:crypto";

export interface IdempotencyConfig {
  autoGenerate?: boolean;
  prefix?: string;
}

export interface ResolvedIdempotencyConfig {
  autoGenerate: boolean;
  prefix: string;
}

export const DEFAULT_IDEMPOTENCY_CONFIG: ResolvedIdempotencyConfig = {
  autoGenerate: true,
  prefix: "",
};

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

export function resolveIdempotencyConfig(
  override?: IdempotencyConfig,
): ResolvedIdempotencyConfig {
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
  const uuid = randomUUID();
  return prefix && prefix.length > 0 ? `${prefix}${uuid}` : uuid;
}

export class IdempotencyKeyBuilder {
  private used = false;

  constructor(private readonly baseKey: string) {
    if (!baseKey || baseKey.length === 0) {
      throw new Error("IdempotencyKeyBuilder: baseKey must be a non-empty string");
    }
  }

  next(): string {
    if (!this.used) {
      this.used = true;
      return this.baseKey;
    }
    return `${this.baseKey}-${randomShortId()}`;
  }

  withSuffix(suffix: string): string {
    if (!suffix || suffix.length === 0) {
      throw new Error("IdempotencyKeyBuilder.withSuffix: suffix must be a non-empty string");
    }
    return `${this.baseKey}-${suffix}`;
  }
}

function randomShortId(): string {
  return randomUUID().split("-")[0]!;
}
