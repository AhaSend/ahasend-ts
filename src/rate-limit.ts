import {
  AhaSendAbortError,
  AhaSendConfigurationError,
  AhaSendRateLimitQueueFullError,
} from "./errors.js";
import { sleep } from "./retry.js";

/** The two documented server rate-limit tiers, each paced by its own bucket. */
export type RateLimitCategory = "standard" | "statistics";

type EndpointCategory = RateLimitCategory;

/**
 * Default ceiling on calls waiting in one bucket.
 *
 * A bound is required: without one, offering work faster than the configured
 * rate drains it grows the queue until the process runs out of memory. 1,000 is
 * a backstop, not a tuned value — a fan-out wider than this should raise
 * `maxQueue` deliberately rather than discover the limit as a rejection.
 */
export const DEFAULT_MAX_QUEUE = 1_000;
/** @internal Smallest pacing rate whose token wait fits in a Node.js timer. */
export const MIN_REQUESTS_PER_SECOND = 1000 / 2_147_483_647;

export interface CategoryRateLimit {
  requestsPerSecond: number;
  burst: number;
  enabled?: boolean | undefined;
  /**
   * Calls that may wait in this bucket before further calls are refused with
   * {@link AhaSendRateLimitQueueFullError}. Defaults to
   * {@link DEFAULT_MAX_QUEUE}. Size it to the widest fan-out you dispatch at
   * once: `Promise.all` over N calls needs `maxQueue >= N - burst`.
   */
  maxQueue?: number | undefined;
}

export interface RateLimitConfig {
  enabled?: boolean | undefined;
  standard?: Partial<CategoryRateLimit> | undefined;
  statistics?: Partial<CategoryRateLimit> | undefined;
}

export interface ResolvedCategoryRateLimit {
  requestsPerSecond: number;
  burst: number;
  enabled: boolean;
  maxQueue: number;
}

export interface ResolvedRateLimitConfig {
  enabled: boolean;
  standard: ResolvedCategoryRateLimit;
  statistics: ResolvedCategoryRateLimit;
}

export const DEFAULT_RATE_LIMIT_CONFIG: ResolvedRateLimitConfig = {
  enabled: false,
  standard: { requestsPerSecond: 100, burst: 200, enabled: true, maxQueue: DEFAULT_MAX_QUEUE },
  statistics: { requestsPerSecond: 1, burst: 1, enabled: true, maxQueue: DEFAULT_MAX_QUEUE },
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
    maxQueue: override?.maxQueue ?? base.maxQueue,
  };
}

/**
 * @internal Validate one bucket's rate settings.
 *
 * Shared by construction-time config validation and the runtime controller so
 * the same mistake produces the same error whichever door it comes through.
 * The runtime path exists because `client.rateLimiter.setLimit` is public: a
 * `burst` of 0 wedges a bucket (tokens can never reach 1) and a `maxQueue` of 0
 * refuses every call before it can queue, and neither reports anything at the
 * point of the mistake.
 *
 * Lives here rather than in config.ts because config.ts already depends on this
 * module; the reverse would be a runtime cycle.
 */
export function assertRequestsPerSecond(value: unknown, name: string): asserts value is number {
  assertPositiveFinite(value, name);
  if (value < MIN_REQUESTS_PER_SECOND) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}\` must be greater than or equal to ${MIN_REQUESTS_PER_SECOND}.`,
    );
  }
}

/** @internal See {@link assertRequestsPerSecond}. */
export function assertBurst(value: unknown, name: string): asserts value is number {
  assertPositiveFinite(value, name);
  if (value < 1) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be greater than or equal to 1.`);
  }
}

/**
 * @internal See {@link assertRequestsPerSecond}.
 *
 * Safe-integer rather than merely integer: `Number.isInteger(Number.MAX_VALUE)`
 * is true, and beyond 2^53 a count stops behaving like one, so
 * `queue.length >= maxQueue` silently stops bounding anything — removing the
 * bound this option exists to provide.
 */
export function assertMaxQueue(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}\` must be a safe integer greater than or equal to 1.`,
    );
  }
}

function assertPositiveFinite(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a positive finite number.`);
  }
}

/** The category names `client.rateLimiter` accepts, in message order. */
const RATE_LIMIT_CATEGORIES: readonly RateLimitCategory[] = ["standard", "statistics"];

const RATE_LIMIT_SETTING_KEYS = new Set(["requestsPerSecond", "burst", "maxQueue"]);

/**
 * @internal Guard the runtime controller's category argument.
 *
 * `client.rateLimiter` is reachable from JavaScript, where the compiler is not
 * enforcing the union. Every method indexes a bucket record by this value, so
 * an unrecognised name produced `Cannot read properties of undefined` from
 * inside the limiter — an error `isAhaSendError()` does not match and which
 * names none of the accepted values.
 */
export function assertRateLimitCategory(
  value: unknown,
  name: string,
): asserts value is RateLimitCategory {
  if (!RATE_LIMIT_CATEGORIES.includes(value as RateLimitCategory)) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}\` must be one of ${RATE_LIMIT_CATEGORIES.map((c) => `"${c}"`).join(", ")}.`,
    );
  }
}

/**
 * @internal Guard the runtime controller's boolean arguments.
 *
 * A non-boolean was stored verbatim, so `setEnabled("false")` — an ordinary
 * mistake when the value comes from an environment variable or parsed JSON —
 * left pacing enabled, because a non-empty string is truthy, while
 * `isEnabled()` returned that string in place of the `boolean` it declares.
 * The caller sees "false" everywhere they look and is still being paced.
 */
export function assertRateLimitBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a boolean.`);
  }
}

/**
 * @internal Guard the shape of `setLimit`'s second argument.
 *
 * Its fields were already validated, but only after being read off the object:
 * `null` threw a bare `TypeError` before any of that ran, and a misspelled key
 * was silently ignored, leaving the caller believing a limit had been raised.
 */
export function assertRateLimitSetting(
  value: unknown,
  name: string,
): asserts value is RateLimitSetting {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!RATE_LIMIT_SETTING_KEYS.has(key)) {
      throw new AhaSendConfigurationError(
        `AhaSend: \`${name}.${key}\` is not a recognized option. Expected ${[
          ...RATE_LIMIT_SETTING_KEYS,
        ]
          .map((k) => `\`${k}\``)
          .join(", ")}.`,
      );
    }
  }
}

/** Map an API path to one of the two documented rate-limit tiers. */
export function detectCategory(_method: string, path: string): EndpointCategory {
  return path.includes("/statistics/") ? "statistics" : "standard";
}

interface RateLimitClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function createProductionClock(): RateLimitClock {
  return {
    // Token refill needs elapsed time, not civil time. The supported runtimes
    // expose this monotonic clock, and the workerd conformance burst proves its
    // timer-driven queue makes progress. Date.now() is deliberately excluded:
    // a corrected NTP step must not pin a bucket at a future timestamp.
    now: () => performance.now(),
    sleep,
  };
}

interface PendingAcquisition {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** Set when the caller aborted; the entry stays put until the drain skips it. */
  cancelled?: boolean;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  // A ring-ish queue rather than a plain array used as one.
  //
  // Cancelling used to `indexOf` + `splice`, and draining used `shift()` —
  // both O(n) on the entry count. Aborting a whole fan-out through one shared
  // signal was therefore O(n²) *synchronously*, blocking the event loop for
  // over a second at 20,000 waiters. That was tolerable only while the cap was
  // a hard-coded 1,000; making `maxQueue` configurable — and then documenting
  // "size it to your widest fan-out" — is what made it reachable.
  //
  // Now cancelling marks a tombstone and the head index walks past it, so both
  // operations are O(1) amortised.
  private readonly queue: (PendingAcquisition | undefined)[] = [];
  private head = 0;
  private pendingCount = 0;
  /** Cancelled entries still occupying queue slots at or past `head`. */
  private tombstones = 0;
  private waitController: AbortController | undefined;

  constructor(
    private readonly category: RateLimitCategory,
    private rps: number,
    private burst: number,
    private enabled: boolean,
    private maxQueue: number,
    private readonly clock: RateLimitClock,
  ) {
    this.tokens = burst;
    this.lastRefill = clock.now();
  }

  setLimit(rps: number, burst: number, maxQueue?: number): void {
    this.refill();
    this.rps = rps;
    this.burst = burst;
    if (maxQueue !== undefined) this.maxQueue = maxQueue;
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
    const waiting = this.drainAll();
    for (const pending of waiting) {
      this.cleanup(pending);
      pending.resolve();
    }
  }

  /** Remove and return every live waiter, resetting the queue to empty. */
  private drainAll(): PendingAcquisition[] {
    const waiting: PendingAcquisition[] = [];
    for (let index = this.head; index < this.queue.length; index++) {
      const pending = this.queue[index];
      if (pending && !pending.cancelled) waiting.push(pending);
    }
    this.queue.length = 0;
    this.head = 0;
    this.pendingCount = 0;
    this.tombstones = 0;
    return waiting;
  }

  /** Next live waiter, skipping tombstones left by cancellation. */
  private dequeue(): PendingAcquisition | undefined {
    while (this.head < this.queue.length) {
      const pending = this.queue[this.head];
      this.queue[this.head] = undefined;
      this.head += 1;
      this.compact();
      if (pending && !pending.cancelled) {
        this.pendingCount -= 1;
        return pending;
      }
      if (pending?.cancelled) this.tombstones -= 1;
    }
    return undefined;
  }

  /**
   * Drop the consumed prefix once it is most of the array, so the backing
   * store cannot grow without bound across a long-lived client.
   */
  private compact(): void {
    if (this.head < 32 || this.head * 2 < this.queue.length) return;
    this.queue.splice(0, this.head);
    this.head = 0;
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

  isEnabled(): boolean {
    return this.enabled;
  }

  settings(): RateLimitSnapshot {
    return {
      requestsPerSecond: this.rps,
      burst: this.burst,
      enabled: this.enabled,
      maxQueue: this.maxQueue,
    };
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(new AhaSendAbortError("Request aborted", signal.reason));
    }
    // Counts live waiters, not array slots, so a cancelled entry frees its slot
    // immediately even though its tombstone is still in the backing store.
    if (this.pendingCount >= this.maxQueue) {
      return Promise.reject(new AhaSendRateLimitQueueFullError(this.category, this.maxQueue));
    }

    return new Promise<void>((resolve, reject) => {
      const pending: PendingAcquisition = { resolve, reject };
      if (signal) {
        pending.signal = signal;
        pending.onAbort = () => this.cancel(pending);
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.pendingCount += 1;
      this.processQueue();
    });
  }

  /**
   * Reached only from the `{ once: true }` abort listener, which the platform
   * has already removed by the time it runs — so this must NOT call
   * `cleanup()`. Removing a listener scans the signal's listener list, and one
   * signal shared across a whole fan-out holds one per waiter, which turns an
   * abort storm back into O(n²) even with an O(1) queue.
   */
  private cancel(pending: PendingAcquisition): void {
    if (pending.cancelled) return;
    pending.cancelled = true;
    delete pending.onAbort;
    this.pendingCount -= 1;
    this.tombstones += 1;
    pending.reject(new AhaSendAbortError("Request aborted", pending.signal?.reason));
    if (this.pendingCount === 0) this.cancelWait();
    this.sweep();
  }

  /**
   * Rebuild the queue without cancelled entries once they outnumber the live
   * ones. `dequeue` reclaims a tombstone only when a token grant walks past
   * it, so a token-starved bucket whose queued callers keep aborting — a
   * fan-out whose per-request timeouts are shorter than the pacing wait —
   * would otherwise retain every aborted waiter, its signal, and its closures
   * indefinitely, unbounded by `maxQueue`, which counts live waiters only.
   * The thresholds mirror `compact`: amortised O(1) per cancellation.
   */
  private sweep(): void {
    if (this.tombstones < 32 || this.tombstones * 2 < this.queue.length - this.head) return;
    const live: PendingAcquisition[] = [];
    for (let index = this.head; index < this.queue.length; index++) {
      const pending = this.queue[index];
      if (pending && !pending.cancelled) live.push(pending);
    }
    this.queue.length = 0;
    for (const pending of live) this.queue.push(pending);
    this.head = 0;
    this.tombstones = 0;
  }

  private processQueue(): void {
    if (!this.enabled) {
      this.releaseQueued();
      return;
    }

    this.refill();
    while (this.tokens >= 1 && this.pendingCount > 0) {
      const pending = this.dequeue();
      if (!pending) break;
      this.tokens -= 1;
      this.cleanup(pending);
      pending.resolve();
    }

    if (this.pendingCount === 0 || this.waitController) return;
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
        for (const pending of this.drainAll()) {
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
    const controller = this.waitController;
    this.waitController = undefined;
    controller?.abort();
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

  constructor(config: ResolvedRateLimitConfig, clock: RateLimitClock = createProductionClock()) {
    this.masterEnabled = config.enabled;
    this.buckets = {
      standard: new TokenBucket(
        "standard",
        config.standard.requestsPerSecond,
        config.standard.burst,
        config.standard.enabled,
        config.standard.maxQueue,
        clock,
      ),
      statistics: new TokenBucket(
        "statistics",
        config.statistics.requestsPerSecond,
        config.statistics.burst,
        config.statistics.enabled,
        config.statistics.maxQueue,
        clock,
      ),
    };
  }

  acquire(method: string, path: string, signal?: AbortSignal): Promise<void> {
    if (!this.masterEnabled) return Promise.resolve();
    return this.buckets[detectCategory(method, path)].acquire(signal);
  }

  setLimit(category: EndpointCategory, rps: number, burst: number, maxQueue?: number): void {
    assertRequestsPerSecond(rps, `rateLimit.${category}.requestsPerSecond`);
    assertBurst(burst, `rateLimit.${category}.burst`);
    if (maxQueue !== undefined) assertMaxQueue(maxQueue, `rateLimit.${category}.maxQueue`);
    this.buckets[category].setLimit(rps, burst, maxQueue);
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

  isCategoryEnabled(category: EndpointCategory): boolean {
    return this.buckets[category].isEnabled();
  }

  settings(category: EndpointCategory): RateLimitSnapshot {
    return this.buckets[category].settings();
  }

  available(category: EndpointCategory): number {
    return this.buckets[category].available();
  }
}

/**
 * Changes to apply to one bucket, as accepted by
 * {@link RateLimiterController.setLimit}. Every field is optional and an
 * omitted one keeps its current value, so the remedy a queue-full error
 * prescribes is expressible on its own:
 *
 * ```ts
 * client.rateLimiter.setLimit(error.category, { maxQueue: error.maxQueue * 4 });
 * ```
 *
 * Restating a rate you cannot read back would otherwise be the only way to
 * widen a queue, which is how a fix for backpressure turns into an accidental
 * rate change.
 */
export interface RateLimitSetting {
  requestsPerSecond?: number | undefined;
  burst?: number | undefined;
  maxQueue?: number | undefined;
}

/** One bucket's current settings, as reported by {@link RateLimiterController.getLimit}. */
export interface RateLimitSnapshot {
  requestsPerSecond: number;
  burst: number;
  /** Whether this bucket admits calls. Independent of the master switch. */
  enabled: boolean;
  maxQueue: number;
}

/**
 * Runtime control over local pacing, reachable as `client.rateLimiter`.
 *
 * Changes apply to the client that owns it and take effect immediately;
 * pacing is process-local, so they do not coordinate across instances or hosts.
 * Use this when the effective limits are only known at runtime — after reading
 * a plan, or when backing off in response to sustained 429s.
 */
export interface RateLimiterController {
  /**
   * Every method here validates its arguments and throws
   * {@link AhaSendConfigurationError} on anything it cannot use — an
   * unrecognised category, a non-boolean flag, a limit that is not an object,
   * or an unknown key on one. This is a public runtime boundary reachable from
   * JavaScript, where the declared types are not enforced and these values
   * often arrive from environment variables or parsed JSON.
   */

  /** Whether local pacing is running at all. Mirrors `rateLimit.enabled`. */
  isEnabled(): boolean;
  /**
   * Turn pacing on or off. Turning it off releases every waiting call
   * immediately; turning it on resumes from a full burst rather than from
   * stale token state.
   */
  setEnabled(enabled: boolean): void;
  /** Turn one bucket on or off, leaving the other and the master switch alone. */
  setCategoryEnabled(category: RateLimitCategory, enabled: boolean): void;
  /** Whether one bucket admits calls, independent of the master switch. */
  isCategoryEnabled(category: RateLimitCategory): boolean;
  /** Read one bucket's current settings — the values `setLimit` merges into. */
  getLimit(category: RateLimitCategory): RateLimitSnapshot;
  /**
   * Change one bucket's settings, keeping any field left out.
   *
   * Validates the category, the object, and each field exactly as construction
   * does, and throws {@link AhaSendConfigurationError} on an unusable value —
   * including an unrecognised key, which was previously dropped in silence and
   * left the caller believing a ceiling had been raised, and a `null` field,
   * which the keep-current merge would otherwise silently treat as omitted.
   * Only `undefined` means keep-current. Note that raising
   * `burst` raises the ceiling but does not mint tokens: they accrue at
   * `requestsPerSecond` and are capped at the new `burst`.
   */
  setLimit(category: RateLimitCategory, limit: RateLimitSetting): void;
  /**
   * Tokens currently available in a bucket, fractional between refills.
   *
   * Reports the bucket's state whether or not pacing is running — a disabled
   * bucket admits everything regardless of this number, so pair it with
   * {@link RateLimiterController.isEnabled} and
   * {@link RateLimiterController.isCategoryEnabled} before reading it as
   * headroom.
   */
  available(category: RateLimitCategory): number;
}

/**
 * @internal Narrow the limiter to the surface `client.rateLimiter` publishes.
 *
 * Frozen here rather than through `createFrozenFacade`: that helper rebinds
 * prototype methods for class instances, while these are closures over
 * `limiter` and are already bound.
 */
export function createRateLimiterController(limiter: RateLimiter): Readonly<RateLimiterController> {
  const controller: RateLimiterController = {
    isEnabled: () => limiter.isEnabled(),
    setEnabled: (enabled) => {
      assertRateLimitBoolean(enabled, "enabled");
      limiter.setEnabled(enabled);
    },
    setCategoryEnabled: (category, enabled) => {
      assertRateLimitCategory(category, "category");
      assertRateLimitBoolean(enabled, "enabled");
      limiter.setCategoryEnabled(category, enabled);
    },
    isCategoryEnabled: (category) => {
      assertRateLimitCategory(category, "category");
      return limiter.isCategoryEnabled(category);
    },
    getLimit: (category) => {
      assertRateLimitCategory(category, "category");
      return limiter.settings(category);
    },
    setLimit: (category, limit) => {
      assertRateLimitCategory(category, "category");
      assertRateLimitSetting(limit, "limit");
      // Read each field exactly once, then validate the values that will be
      // applied. Validating through the object would leave two holes: an
      // accessor could answer differently on the second read, and `??` — which
      // implements "an omitted field keeps its current value" — also coalesces
      // `null`, so a `null` field would silently mean keep-current instead of
      // being refused like every other unusable value.
      const requested = {
        requestsPerSecond: limit.requestsPerSecond,
        burst: limit.burst,
        maxQueue: limit.maxQueue,
      };
      // Field names match construction's (`rateLimit.<category>.<field>`):
      // the same mistake produces the same words whichever door it came
      // through — a property tests/client.test.ts pins.
      if (requested.requestsPerSecond !== undefined) {
        assertRequestsPerSecond(
          requested.requestsPerSecond,
          `rateLimit.${category}.requestsPerSecond`,
        );
      }
      if (requested.burst !== undefined) {
        assertBurst(requested.burst, `rateLimit.${category}.burst`);
      }
      if (requested.maxQueue !== undefined) {
        assertMaxQueue(requested.maxQueue, `rateLimit.${category}.maxQueue`);
      }
      const current = limiter.settings(category);
      limiter.setLimit(
        category,
        requested.requestsPerSecond ?? current.requestsPerSecond,
        requested.burst ?? current.burst,
        requested.maxQueue ?? current.maxQueue,
      );
    },
    available: (category) => {
      assertRateLimitCategory(category, "category");
      return limiter.available(category);
    },
  };
  return Object.freeze(controller);
}
