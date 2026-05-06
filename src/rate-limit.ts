import { sleep } from "./retry.js";

export type EndpointCategory = "general" | "statistics" | "sendMessage";

export interface CategoryRateLimit {
  requestsPerSecond: number;
  burst: number;
  enabled?: boolean;
}

export interface RateLimitConfig {
  enabled?: boolean;
  general?: Partial<CategoryRateLimit>;
  statistics?: Partial<CategoryRateLimit>;
  sendMessage?: Partial<CategoryRateLimit>;
}

export interface ResolvedCategoryRateLimit {
  requestsPerSecond: number;
  burst: number;
  enabled: boolean;
}

export interface ResolvedRateLimitConfig {
  enabled: boolean;
  general: ResolvedCategoryRateLimit;
  statistics: ResolvedCategoryRateLimit;
  sendMessage: ResolvedCategoryRateLimit;
}

export const DEFAULT_RATE_LIMIT_CONFIG: ResolvedRateLimitConfig = {
  enabled: true,
  general: { requestsPerSecond: 100, burst: 200, enabled: true },
  statistics: { requestsPerSecond: 1, burst: 1, enabled: true },
  sendMessage: { requestsPerSecond: 100, burst: 200, enabled: true },
};

export function resolveRateLimitConfig(override?: RateLimitConfig): ResolvedRateLimitConfig {
  return {
    enabled: override?.enabled ?? DEFAULT_RATE_LIMIT_CONFIG.enabled,
    general: mergeCategory(DEFAULT_RATE_LIMIT_CONFIG.general, override?.general),
    statistics: mergeCategory(DEFAULT_RATE_LIMIT_CONFIG.statistics, override?.statistics),
    sendMessage: mergeCategory(DEFAULT_RATE_LIMIT_CONFIG.sendMessage, override?.sendMessage),
  };
}

function mergeCategory(
  base: ResolvedCategoryRateLimit,
  override?: Partial<CategoryRateLimit>,
): ResolvedCategoryRateLimit {
  return {
    requestsPerSecond: override?.requestsPerSecond ?? base.requestsPerSecond,
    burst: override?.burst ?? base.burst,
    enabled: override?.enabled ?? base.enabled,
  };
}

export function detectCategory(method: string, path: string): EndpointCategory {
  if (path.includes("/statistics/")) return "statistics";
  if (
    method === "POST" &&
    path.includes("/messages") &&
    !path.includes("/messages/")
  ) {
    return "sendMessage";
  }
  return "general";
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private rps: number,
    private burst: number,
    private enabled: boolean,
    private now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.lastRefill = now();
  }

  setLimit(rps: number, burst: number): void {
    this.rps = rps;
    this.burst = burst;
    if (this.tokens > burst) this.tokens = burst;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Adjust the bucket to reflect the server's reported remaining quota.
   * Only ever lowers the local tokens — never inflates beyond what we have,
   * because the server is the source of truth on its own remaining budget.
   */
  reconcile(remaining: number): void {
    if (!Number.isFinite(remaining) || remaining < 0) return;
    this.refill();
    if (remaining < this.tokens) {
      this.tokens = remaining;
    }
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const next = this.chain.then(() => this.acquireOnce(signal));
    this.chain = next.catch(() => {});
    return next;
  }

  private async acquireOnce(signal?: AbortSignal): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const need = 1 - this.tokens;
    const waitMs = Math.ceil((need / this.rps) * 1000);
    await sleep(waitMs, signal);
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = this.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rps);
    this.lastRefill = now;
  }
}

export class RateLimiter {
  private buckets: Record<EndpointCategory, TokenBucket>;
  private masterEnabled: boolean;

  constructor(config: ResolvedRateLimitConfig, now: () => number = Date.now) {
    this.masterEnabled = config.enabled;
    this.buckets = {
      general: new TokenBucket(
        config.general.requestsPerSecond,
        config.general.burst,
        config.general.enabled,
        now,
      ),
      statistics: new TokenBucket(
        config.statistics.requestsPerSecond,
        config.statistics.burst,
        config.statistics.enabled,
        now,
      ),
      sendMessage: new TokenBucket(
        config.sendMessage.requestsPerSecond,
        config.sendMessage.burst,
        config.sendMessage.enabled,
        now,
      ),
    };
  }

  acquire(method: string, path: string, signal?: AbortSignal): Promise<void> {
    if (!this.masterEnabled) return Promise.resolve();
    const category = detectCategory(method, path);
    return this.buckets[category].acquire(signal);
  }

  detectCategory(method: string, path: string): EndpointCategory {
    return detectCategory(method, path);
  }

  setLimit(category: EndpointCategory, rps: number, burst: number): void {
    this.buckets[category].setLimit(rps, burst);
  }

  setCategoryEnabled(category: EndpointCategory, enabled: boolean): void {
    this.buckets[category].setEnabled(enabled);
  }

  setEnabled(enabled: boolean): void {
    this.masterEnabled = enabled;
  }

  isEnabled(): boolean {
    return this.masterEnabled;
  }

  available(category: EndpointCategory): number {
    return this.buckets[category].available();
  }

  /**
   * Inspect a response's rate-limit headers and reconcile the matching
   * bucket. No-op if the response has no recognised rate-limit headers.
   */
  recordResponseHeaders(
    method: string,
    path: string,
    headers: Headers | Record<string, string>,
  ): void {
    if (!this.masterEnabled) return;
    const remaining = parseRateLimitRemaining(headers);
    if (remaining === undefined) return;
    const category = detectCategory(method, path);
    this.buckets[category].reconcile(remaining);
  }
}

function parseRateLimitRemaining(
  headers: Headers | Record<string, string>,
): number | undefined {
  const candidates = [
    "x-ratelimit-remaining",
    "ratelimit-remaining",
    "x-rate-limit-remaining",
  ];
  for (const name of candidates) {
    const raw = readHeader(headers, name);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function readHeader(
  headers: Headers | Record<string, string>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()];
}
