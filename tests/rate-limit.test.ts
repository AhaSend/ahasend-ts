import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { AhaSendAbortError, AhaSendError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  MIN_REQUESTS_PER_SECOND,
  RateLimiter,
  detectCategory,
  resolveRateLimitConfig,
} from "../src/rate-limit.js";
import { isRetryableError } from "../src/retry.js";

interface ScheduledRateLimitSleep {
  delay: number;
  dueAt: number;
  signal: AbortSignal | undefined;
  wake: () => void;
  woke: boolean;
}

function createRateLimitClock() {
  let now = 0;
  const scheduled: ScheduledRateLimitSleep[] = [];
  const sleep = vi.fn(
    (delay: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        scheduled.push({
          delay,
          dueAt: now + delay,
          signal,
          wake: resolve,
          woke: false,
        });
      }),
  );

  return {
    clock: { now: () => now, sleep },
    scheduled,
    async advanceBy(elapsedMs: number): Promise<void> {
      now += elapsedMs;
      let woke: boolean;
      do {
        woke = false;
        for (const pending of scheduled) {
          if (!pending.woke && pending.dueAt <= now) {
            pending.woke = true;
            pending.wake();
            woke = true;
          }
        }
        await Promise.resolve();
      } while (woke && scheduled.some((pending) => !pending.woke && pending.dueAt <= now));
    },
  };
}

function trackSettlements(promises: Promise<void>[]): ReturnType<typeof vi.fn>[] {
  return promises.map((promise) => {
    const settlement = vi.fn();
    void promise.then(settlement, settlement);
    return settlement;
  });
}

describe("detectCategory", () => {
  it("uses the statistics tier only for statistics paths", () => {
    expect(detectCategory("GET", "/v2/accounts/abc/statistics/deliverability")).toBe("statistics");
    expect(detectCategory("POST", "/v2/accounts/abc/messages")).toBe("standard");
    expect(detectCategory("GET", "/v2/ping")).toBe("standard");
  });
});

describe("resolveRateLimitConfig", () => {
  it("is default-off with the documented standard and statistics tiers", () => {
    expect(resolveRateLimitConfig()).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
    expect(DEFAULT_RATE_LIMIT_CONFIG).toEqual({
      enabled: false,
      standard: { requestsPerSecond: 100, burst: 200, enabled: true },
      statistics: { requestsPerSecond: 1, burst: 1, enabled: true },
    });
  });

  it("merges category overrides without enabling pacing", () => {
    const resolved = resolveRateLimitConfig({ statistics: { requestsPerSecond: 0.5 } });
    expect(resolved.enabled).toBe(false);
    expect(resolved.statistics).toEqual({ requestsPerSecond: 0.5, burst: 1, enabled: true });
    expect(resolved.standard).toEqual(DEFAULT_RATE_LIMIT_CONFIG.standard);
  });
});

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bypasses all buckets until pacing is explicitly enabled", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ standard: { requestsPerSecond: 1, burst: 1 } }),
    );

    await Promise.all(Array.from({ length: 20 }, () => limiter.acquire("GET", "/v2/ping")));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("paces a deterministic FIFO queue and bounds tokens at the burst", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
    );
    const completed: number[] = [];

    const acquisitions = [1, 2, 3].map((id) =>
      limiter.acquire("GET", "/v2/ping").then(() => completed.push(id)),
    );
    await Promise.resolve();
    expect(completed).toEqual([1]);
    expect(vi.getTimerCount()).toBe(1);
    expect(limiter.available("standard")).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(acquisitions);
    expect(completed).toEqual([1, 2, 3]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(limiter.available("standard")).toBe(1);
  });

  it("removes an aborted acquisition from the queue immediately", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
    );
    await limiter.acquire("GET", "/v2/ping");

    const controller = new AbortController();
    const cancelled = limiter.acquire("GET", "/v2/ping", controller.signal);
    const next = limiter.acquire("GET", "/v2/ping");
    controller.abort("caller stopped waiting");

    await expect(cancelled).rejects.toBeInstanceOf(AhaSendAbortError);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await next;
  });

  it.each([
    ["standard", "/v2/ping"],
    ["statistics", "/v2/accounts/a/statistics/bounce"],
  ] as const)(
    "bounds the %s bucket without installing an overload abort listener",
    async (_category, path) => {
      const limiter = new RateLimiter(
        resolveRateLimitConfig({
          enabled: true,
          standard: { requestsPerSecond: 1, burst: 1 },
          statistics: { requestsPerSecond: 1, burst: 1 },
        }),
      );
      await limiter.acquire("GET", path);
      const admitted = Array.from({ length: 1_000 }, () => limiter.acquire("GET", path));
      const overloadController = new AbortController();
      const addEventListener = vi.spyOn(overloadController.signal, "addEventListener");

      const overload = await limiter.acquire("GET", path, overloadController.signal).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(overload).toBeInstanceOf(Error);
      expect(AhaSendError.is(overload)).toBe(true);
      expect(isRetryableError(overload)).toBe(false);
      expect(addEventListener).not.toHaveBeenCalled();

      limiter.setCategoryEnabled(_category, false);
      await Promise.all(admitted);
    },
  );

  it("settles a cancelled admitted acquisition once and reuses its capacity", async () => {
    const sleep = vi.fn(() => new Promise<void>(() => undefined));
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      { now: () => 0, sleep },
    );
    await limiter.acquire("GET", "/v2/ping");

    const admitted = Array.from({ length: 999 }, () => limiter.acquire("GET", "/v2/ping"));
    const controller = new AbortController();
    const settlement = vi.fn();
    const cancelled = limiter.acquire("GET", "/v2/ping", controller.signal);
    void cancelled.then(settlement, settlement);

    controller.abort("caller stopped waiting");
    await expect(cancelled).rejects.toBeInstanceOf(AhaSendAbortError);
    await Promise.resolve();
    expect(settlement).toHaveBeenCalledOnce();

    controller.abort("ignored second cancellation");
    await Promise.resolve();
    expect(settlement).toHaveBeenCalledOnce();

    const replacement = limiter.acquire("GET", "/v2/ping");
    limiter.setCategoryEnabled("standard", false);
    await Promise.all([...admitted, replacement]);
    expect(settlement).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not spend the per-attempt timeout while queued for pacing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new HttpClient(
      resolveConfig({
        apiKey: "test-key",
        fetch,
        timeoutMs: 100,
        retry: { enabled: false },
        rateLimit: { enabled: true, standard: { requestsPerSecond: 1, burst: 1 } },
      }),
    );

    await client.request({ method: "GET", path: "/v2/ping" });
    const queued = client.request({ method: "GET", path: "/v2/ping" });

    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(900);
    await queued;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves caller cancellation while a transport request waits for a token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new HttpClient(
      resolveConfig({
        apiKey: "test-key",
        fetch,
        retry: { enabled: false },
        rateLimit: { enabled: true, standard: { requestsPerSecond: 1, burst: 1 } },
      }),
    );
    await client.request({ method: "GET", path: "/v2/ping" });

    const controller = new AbortController();
    const queued = client.request({ method: "GET", path: "/v2/ping", signal: controller.signal });
    controller.abort("caller stopped waiting");

    await expect(queued).rejects.toBeInstanceOf(AhaSendAbortError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-aborted acquisition without entering the queue", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ enabled: true, standard: { burst: 1 } }),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire("GET", "/v2/ping", controller.signal)).rejects.toBeInstanceOf(
      AhaSendAbortError,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases both queues once and invalidates stale wakeups on master disablement", async () => {
    const fakeClock = createRateLimitClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
        statistics: { requestsPerSecond: 1, burst: 1 },
      }),
      fakeClock.clock,
    );
    await Promise.all([
      limiter.acquire("GET", "/v2/ping"),
      limiter.acquire("GET", "/v2/accounts/a/statistics/bounce"),
    ]);
    const queued = [
      limiter.acquire("GET", "/v2/ping"),
      limiter.acquire("GET", "/v2/ping"),
      limiter.acquire("GET", "/v2/accounts/a/statistics/bounce"),
      limiter.acquire("GET", "/v2/accounts/a/statistics/bounce"),
    ];
    const settlements = trackSettlements(queued);
    expect(fakeClock.scheduled).toHaveLength(2);

    limiter.setEnabled(false);
    await Promise.all(queued);
    expect(fakeClock.scheduled.every(({ signal }) => signal?.aborted)).toBe(true);
    expect(settlements.every((settlement) => settlement.mock.calls.length === 1)).toBe(true);

    // This fake deliberately wakes aborted sleeps so the stale callback guard is exercised.
    await fakeClock.advanceBy(1_000);
    expect(settlements.every((settlement) => settlement.mock.calls.length === 1)).toBe(true);
    expect(fakeClock.scheduled).toHaveLength(2);
  });

  it("releases one category once without invalidating another category's timer", async () => {
    const fakeClock = createRateLimitClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
        statistics: { requestsPerSecond: 1, burst: 1 },
      }),
      fakeClock.clock,
    );
    await Promise.all([
      limiter.acquire("GET", "/v2/ping"),
      limiter.acquire("GET", "/v2/accounts/a/statistics/bounce"),
    ]);
    const standard = [limiter.acquire("GET", "/v2/ping"), limiter.acquire("GET", "/v2/ping")];
    const statistics = limiter.acquire("GET", "/v2/accounts/a/statistics/bounce");
    const standardSettlements = trackSettlements(standard);
    const statisticsSettlement = trackSettlements([statistics])[0];
    const [standardSleep, statisticsSleep] = fakeClock.scheduled;
    expect(standardSleep).toBeDefined();
    expect(statisticsSleep).toBeDefined();

    limiter.setCategoryEnabled("standard", false);
    await Promise.all(standard);
    expect(standardSleep?.signal?.aborted).toBe(true);
    expect(statisticsSleep?.signal?.aborted).toBe(false);
    expect(standardSettlements.every((settlement) => settlement.mock.calls.length === 1)).toBe(
      true,
    );
    expect(statisticsSettlement).not.toHaveBeenCalled();

    await fakeClock.advanceBy(1_000);
    await statistics;
    expect(standardSettlements.every((settlement) => settlement.mock.calls.length === 1)).toBe(
      true,
    );
    expect(statisticsSettlement).toHaveBeenCalledOnce();
  });

  it.each([
    { direction: "lower", initialRps: 2, nextRps: 1, oldDelay: 500, nextDelay: 800 },
    { direction: "higher", initialRps: 1, nextRps: 2, oldDelay: 1_000, nextDelay: 450 },
  ])(
    "retains queued work and recomputes its wakeup after a $direction rate change",
    async ({ initialRps, nextRps, oldDelay, nextDelay }) => {
      const fakeClock = createRateLimitClock();
      const limiter = new RateLimiter(
        resolveRateLimitConfig({
          enabled: true,
          standard: { requestsPerSecond: initialRps, burst: 1 },
        }),
        fakeClock.clock,
      );
      await limiter.acquire("GET", "/v2/ping");
      const queued = [limiter.acquire("GET", "/v2/ping"), limiter.acquire("GET", "/v2/ping")];
      const settlements = trackSettlements(queued);
      const initialSleep = fakeClock.scheduled[0];
      expect(initialSleep?.delay).toBe(oldDelay);

      await fakeClock.advanceBy(100);
      limiter.setLimit("standard", nextRps, 1);

      expect(initialSleep?.signal?.aborted).toBe(true);
      expect(fakeClock.scheduled[1]?.delay).toBe(nextDelay);
      expect(settlements.every((settlement) => settlement.mock.calls.length === 0)).toBe(true);

      await fakeClock.advanceBy(nextDelay - 1);
      expect(settlements.every((settlement) => settlement.mock.calls.length === 0)).toBe(true);
      await fakeClock.advanceBy(1);
      expect(settlements.map((settlement) => settlement.mock.calls.length)).toEqual([1, 0]);

      const oldWakeRemaining = oldDelay - (100 + nextDelay);
      if (oldWakeRemaining > 0) {
        await fakeClock.advanceBy(oldWakeRemaining);
        expect(settlements.map((settlement) => settlement.mock.calls.length)).toEqual([1, 0]);
      }

      await fakeClock.advanceBy(1_000 / nextRps - Math.max(0, oldWakeRemaining));
      await Promise.all(queued);
      expect(settlements.map((settlement) => settlement.mock.calls.length)).toEqual([1, 1]);
    },
  );

  it("retains every queued acquisition and invalidates the old wakeup after a burst change", async () => {
    const fakeClock = createRateLimitClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      fakeClock.clock,
    );
    await limiter.acquire("GET", "/v2/ping");
    const queued = [
      limiter.acquire("GET", "/v2/ping"),
      limiter.acquire("GET", "/v2/ping"),
      limiter.acquire("GET", "/v2/ping"),
    ];
    const settlements = trackSettlements(queued);
    const initialSleep = fakeClock.scheduled[0];

    await fakeClock.advanceBy(250);
    limiter.setLimit("standard", 1, 3);

    expect(initialSleep?.signal?.aborted).toBe(true);
    expect(fakeClock.scheduled[1]?.delay).toBe(750);
    expect(settlements.every((settlement) => settlement.mock.calls.length === 0)).toBe(true);

    await fakeClock.advanceBy(750);
    expect(settlements.map((settlement) => settlement.mock.calls.length)).toEqual([1, 0, 0]);
    await fakeClock.advanceBy(1_000);
    expect(settlements.map((settlement) => settlement.mock.calls.length)).toEqual([1, 1, 0]);
    await fakeClock.advanceBy(1_000);
    await Promise.all(queued);
    expect(settlements.map((settlement) => settlement.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("schedules a timer-safe integer delay at the minimum live pacing rate", async () => {
    const sleep = vi.fn((_ms: number, _signal?: AbortSignal) => new Promise<void>(() => undefined));
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      { now: () => 0, sleep },
    );
    await limiter.acquire("GET", "/v2/ping");
    limiter.setLimit("standard", MIN_REQUESTS_PER_SECOND, 1);

    const queued = limiter.acquire("GET", "/v2/ping");

    expect(sleep).toHaveBeenCalledOnce();
    const delay = sleep.mock.calls[0]?.[0] ?? Number.NaN;
    expect(delay).toBe(2_147_483_647);
    expect(Number.isFinite(delay)).toBe(true);
    expect(Number.isInteger(delay)).toBe(true);
    expect(delay).toBeLessThanOrEqual(2_147_483_647);

    limiter.setCategoryEnabled("standard", false);
    await queued;
  });

  it("rejects a live pacing rate below the minimum without changing bucket behavior", async () => {
    let now = 0;
    const sleep = vi.fn(() => new Promise<void>(() => undefined));
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 2, burst: 1 },
      }),
      { now: () => now, sleep },
    );
    await limiter.acquire("GET", "/v2/ping");
    const immediatelyBelowMinimum = MIN_REQUESTS_PER_SECOND * (1 - Number.EPSILON);

    expect(() => limiter.setLimit("standard", immediatelyBelowMinimum, 2)).toThrow(
      /requestsPerSecond.*greater than or equal/i,
    );
    expect(sleep).not.toHaveBeenCalled();

    now = 500;
    await limiter.acquire("GET", "/v2/ping");
    expect(sleep).not.toHaveBeenCalled();

    now = 1_500;
    expect(limiter.available("standard")).toBe(1);
  });

  it("ignores remaining-like response headers returned by the transport", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "ratelimit-remaining": "0",
          "x-rate-limit-remaining": "0",
          "x-ratelimit-remaining": "0",
        },
      }),
    );
    const client = new HttpClient(
      resolveConfig({
        apiKey: "test-key",
        fetch,
        rateLimit: { enabled: true, standard: { requestsPerSecond: 1, burst: 10 } },
      }),
    );

    await client.request({ method: "GET", path: "/v2/ping" });
    expect(client.rateLimiter.available("standard")).toBeGreaterThan(8);
  });

  it("propagates an unexpected clock failure to every queued acquisition", async () => {
    const sleep = vi.fn().mockRejectedValue(new Error("clock failed"));
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      { now: () => performance.now(), sleep },
    );
    await limiter.acquire("GET", "/v2/ping");

    const queued = [limiter.acquire("GET", "/v2/ping"), limiter.acquire("GET", "/v2/ping")];
    await expect(Promise.all(queued)).rejects.toThrow("clock failed");
  });
});
