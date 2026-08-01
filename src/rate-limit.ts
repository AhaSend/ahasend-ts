import { AhaSendAbortError, AhaSendRateLimitQueueFullError } from "./errors.js";
import { sleep } from "./retry.js";

type EndpointCategory = "standard" | "statistics";

const MAX_PENDING_ACQUISITIONS_PER_BUCKET = 1_000;

export interface CategoryRateLimit {
  requestsPerSecond: number;
  burst: number;
  enabled?: boolean;
}

export interface RateLimitConfig {
  enabled?: boolean;
  standard?: Partial<CategoryRateLimit>;
  statistics?: Partial<CategoryRateLimit>;
}

export interface ResolvedCategoryRateLimit {
  requestsPerSecond: number;
  burst: number;
  enabled: boolean;
}

export interface ResolvedRateLimitConfig {
  enabled: boolean;
  standard: ResolvedCategoryRateLimit;
  statistics: ResolvedCategoryRateLimit;
}

export const DEFAULT_RATE_LIMIT_CONFIG: ResolvedRateLimitConfig = {
  enabled: false,
  standard: { requestsPerSecond: 100, burst: 200, enabled: true },
  statistics: { requestsPerSecond: 1, burst: 1, enabled: true },
};

export function resolveRateLimitConfig(override?: RateLimitConfig): ResolvedRateLimitConfig {
  return {
    enabled: override?.enabled ?? DEFAULT_RATE_LIMIT_CONFIG.enabled,
    standard: mergeCategory(DEFAULT_RATE_LIMIT_CONFIG.standard, override?.standard),
    statistics: mergeCategory(DEFAULT_RATE_LIMIT_CONFIG.statistics, override?.statistics),
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

/** Map an API path to one of the two documented rate-limit tiers. */
export function detectCategory(_method: string, path: string): EndpointCategory {
  return path.includes("/statistics/") ? "statistics" : "standard";
}

interface RateLimitClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const MONOTONIC_CLOCK: RateLimitClock = {
  now: () => performance.now(),
  sleep,
};

interface PendingAcquisition {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly queue: PendingAcquisition[] = [];
  private waitController: AbortController | undefined;

  constructor(
    private rps: number,
    private burst: number,
    private enabled: boolean,
    private readonly clock: RateLimitClock,
  ) {
    this.tokens = burst;
    this.lastRefill = clock.now();
  }

  setLimit(rps: number, burst: number): void {
    this.refill();
    this.rps = rps;
    this.burst = burst;
    this.tokens = Math.min(this.tokens, burst);
    this.restartWait();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.releaseQueued();
      return;
    }

    // Calls made while pacing was disabled bypassed this bucket, so resume
    // from a fresh burst instead of carrying stale local state forward.
    this.tokens = this.burst;
    this.lastRefill = this.clock.now();
  }

  releaseQueued(): void {
    this.cancelWait();
    for (const pending of this.queue.splice(0)) {
      this.cleanup(pending);
      pending.resolve();
    }
  }

  reset(): void {
    if (!this.enabled) return;
    this.tokens = this.burst;
    this.lastRefill = this.clock.now();
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(new AhaSendAbortError("Request aborted", signal.reason));
    }
    if (this.queue.length >= MAX_PENDING_ACQUISITIONS_PER_BUCKET) {
      return Promise.reject(new AhaSendRateLimitQueueFullError());
    }

    return new Promise<void>((resolve, reject) => {
      const pending: PendingAcquisition = { resolve, reject };
      if (signal) {
        pending.signal = signal;
        pending.onAbort = () => this.cancel(pending);
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.processQueue();
    });
  }

  private cancel(pending: PendingAcquisition): void {
    const index = this.queue.indexOf(pending);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.cleanup(pending);
    pending.reject(new AhaSendAbortError("Request aborted", pending.signal?.reason));
    if (this.queue.length === 0) this.cancelWait();
  }

  private processQueue(): void {
    if (!this.enabled) {
      this.releaseQueued();
      return;
    }

    this.refill();
    while (this.tokens >= 1 && this.queue.length > 0) {
      const pending = this.queue.shift();
      if (!pending) break;
      this.tokens -= 1;
      this.cleanup(pending);
      pending.resolve();
    }

    if (this.queue.length === 0 || this.waitController) return;
    const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.rps) * 1000));
    const controller = new AbortController();
    this.waitController = controller;
    void this.clock.sleep(waitMs, controller.signal).then(
      () => {
        if (this.waitController !== controller) return;
        this.waitController = undefined;
        this.processQueue();
      },
      (error: unknown) => {
        if (this.waitController !== controller) return;
        this.waitController = undefined;
        if (controller.signal.aborted) return;
        for (const pending of this.queue.splice(0)) {
          this.cleanup(pending);
          pending.reject(error);
        }
      },
    );
  }

  private restartWait(): void {
    this.cancelWait();
    this.processQueue();
  }

  private cancelWait(): void {
    this.waitController?.abort();
    this.waitController = undefined;
  }

  private cleanup(pending: PendingAcquisition): void {
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1000) * this.rps);
    this.lastRefill = Math.max(this.lastRefill, now);
  }
}

export class RateLimiter {
  private readonly buckets: Record<EndpointCategory, TokenBucket>;
  private masterEnabled: boolean;

  constructor(config: ResolvedRateLimitConfig, clock: RateLimitClock = MONOTONIC_CLOCK) {
    this.masterEnabled = config.enabled;
    this.buckets = {
      standard: new TokenBucket(
        config.standard.requestsPerSecond,
        config.standard.burst,
        config.standard.enabled,
        clock,
      ),
      statistics: new TokenBucket(
        config.statistics.requestsPerSecond,
        config.statistics.burst,
        config.statistics.enabled,
        clock,
      ),
    };
  }

  acquire(method: string, path: string, signal?: AbortSignal): Promise<void> {
    if (!this.masterEnabled) return Promise.resolve();
    return this.buckets[detectCategory(method, path)].acquire(signal);
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
    if (this.masterEnabled === enabled) return;
    this.masterEnabled = enabled;
    if (!enabled) {
      for (const bucket of Object.values(this.buckets)) bucket.releaseQueued();
    } else {
      for (const bucket of Object.values(this.buckets)) bucket.reset();
    }
  }

  isEnabled(): boolean {
    return this.masterEnabled;
  }

  available(category: EndpointCategory): number {
    return this.buckets[category].available();
  }
}
