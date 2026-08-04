import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
import { resolveConfig } from "../src/config.js";
import {
  AhaSendAbortError,
  AhaSendConfigurationError,
  AhaSendError,
  AhaSendRateLimitError,
  AhaSendRateLimitQueueFullError,
  AhaSendServerError,
} from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import {
  DEFAULT_MAX_QUEUE,
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
      standard: { requestsPerSecond: 100, burst: 200, enabled: true, maxQueue: DEFAULT_MAX_QUEUE },
      statistics: { requestsPerSecond: 1, burst: 1, enabled: true, maxQueue: DEFAULT_MAX_QUEUE },
    });
  });

  it("merges category overrides without enabling pacing", () => {
    const resolved = resolveRateLimitConfig({ statistics: { requestsPerSecond: 0.5 } });
    expect(resolved.enabled).toBe(false);
    expect(resolved.statistics).toEqual({
      requestsPerSecond: 0.5,
      burst: 1,
      enabled: true,
      maxQueue: DEFAULT_MAX_QUEUE,
    });
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

describe("pacing queue capacity", () => {
  // The cap bounds memory when work is offered faster than the configured rate
  // drains it. It had no test at all, so neither the refusal nor its
  // configurability was pinned — and the default silently rejected the tail of
  // any fan-out wider than burst + 1,000.
  it("refuses past maxQueue with an identifiable, actionable error", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1, maxQueue: 2 },
      }),
      { now: () => 0, sleep: vi.fn(() => new Promise<void>(() => {})) },
    );

    await limiter.acquire("POST", "/v2/accounts/a/messages");
    const queued = [
      limiter.acquire("POST", "/v2/accounts/a/messages"),
      limiter.acquire("POST", "/v2/accounts/a/messages"),
    ];
    queued.forEach((promise) => void promise.catch(() => undefined));

    const refused = limiter.acquire("POST", "/v2/accounts/a/messages");
    await expect(refused).rejects.toBeInstanceOf(AhaSendRateLimitQueueFullError);

    const error = await refused.then(
      () => {
        throw new Error("expected the acquisition to be refused");
      },
      (reason: unknown) => reason as AhaSendRateLimitQueueFullError,
    );
    // Distinguishable from a server 429 by class AND by code, and it names the
    // knob that fixes it rather than only reporting that something is full.
    expect(error.code).toBe("rate_limit_queue_full_error");
    expect(error).not.toBeInstanceOf(AhaSendRateLimitError);
    expect(error.category).toBe("standard");
    expect(error.maxQueue).toBe(2);
    expect(error.message).toContain("rateLimit.standard.maxQueue");
  });

  it("admits a fan-out wider than the default once maxQueue is raised", async () => {
    // The reported case: Promise.all over 1,300 sends against burst 200 leaves
    // 1,100 waiting, so the 1,000 default rejects 100 of them.
    const fanOut = 1_300;
    const burst = 200;
    const paced = (maxQueue: number) => {
      const limiter = new RateLimiter(
        resolveRateLimitConfig({
          enabled: true,
          standard: { requestsPerSecond: 100, burst, maxQueue },
        }),
        { now: () => 0, sleep: vi.fn(() => new Promise<void>(() => {})) },
      );
      return Array.from({ length: fanOut }, () =>
        limiter.acquire("POST", "/v2/accounts/a/messages"),
      );
    };

    // Calls that are admitted or refused settle immediately; the rest stay
    // queued for a token that this frozen clock never grants, so each is raced
    // against an already-resolved sentinel rather than awaited.
    const settle = async (promises: Promise<void>[]) =>
      Promise.all(
        promises.map((promise) =>
          Promise.race([
            promise.then(
              () => "admitted" as const,
              (reason: unknown) =>
                reason instanceof AhaSendRateLimitQueueFullError
                  ? ("refused" as const)
                  : ("errored" as const),
            ),
            Promise.resolve().then(() => "queued" as const),
          ]),
        ),
      );

    const atDefault = await settle(paced(DEFAULT_MAX_QUEUE));
    expect(atDefault.filter((outcome) => outcome === "refused")).toHaveLength(
      fanOut - burst - DEFAULT_MAX_QUEUE,
    );

    const raised = await settle(paced(fanOut));
    expect(raised.filter((outcome) => outcome === "refused")).toHaveLength(0);
    expect(raised.filter((outcome) => outcome === "errored")).toHaveLength(0);
    // Assert the positive half too: without this the test passes on a bucket
    // that admits nothing and queues everything.
    expect(raised.filter((outcome) => outcome === "admitted")).toHaveLength(burst);
  });

  it("keeps the two buckets' capacity independent", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1, maxQueue: 1 },
        statistics: { requestsPerSecond: 1, burst: 1, maxQueue: 5 },
      }),
      { now: () => 0, sleep: vi.fn(() => new Promise<void>(() => {})) },
    );

    await limiter.acquire("POST", "/v2/accounts/a/messages");
    await limiter.acquire("GET", "/v2/accounts/a/statistics/deliverability");

    const standardQueued = limiter.acquire("POST", "/v2/accounts/a/messages");
    void standardQueued.catch(() => undefined);
    await expect(limiter.acquire("POST", "/v2/accounts/a/messages")).rejects.toBeInstanceOf(
      AhaSendRateLimitQueueFullError,
    );

    // The statistics bucket still has room, and reports its own limit.
    const statisticsQueued = Array.from({ length: 5 }, () =>
      limiter.acquire("GET", "/v2/accounts/a/statistics/deliverability"),
    );
    statisticsQueued.forEach((promise) => void promise.catch(() => undefined));
    const refused = limiter.acquire("GET", "/v2/accounts/a/statistics/deliverability").then(
      () => {
        throw new Error("expected the acquisition to be refused");
      },
      (reason: unknown) => reason as AhaSendRateLimitQueueFullError,
    );
    expect((await refused).category).toBe("statistics");
    expect((await refused).maxQueue).toBe(5);
  });
});

describe("pacing failure during a retry", () => {
  const slowPacing = {
    enabled: true,
    standard: { requestsPerSecond: MIN_REQUESTS_PER_SECOND, burst: 1, maxQueue: 1 },
  } as const;

  const respond503 = () =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "upstream exploded" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

  it("reports the refusal and carries the API error that caused the retry", async () => {
    let attempts = 0;
    let client: HttpClient | undefined;
    const config = resolveConfig({
      apiKey: "aha-sk-test",
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      rateLimit: slowPacing,
      fetch: () => {
        attempts += 1;
        // Saturate the bucket while attempt 1 is in flight, so the retry's
        // re-acquisition finds the queue full.
        if (attempts === 1) {
          void client?.rateLimiter.acquire("GET", "/v2/ping").catch(() => undefined);
        }
        return respond503();
      },
    });
    client = new HttpClient(config);

    const failure = await client.request({ method: "GET", path: "/v2/ping" }).then(
      () => {
        throw new Error("expected the request to fail");
      },
      (reason: unknown) => reason as Error,
    );

    expect(attempts).toBe(1);
    // The refusal is what actually ended the call, and unlike the 503 it is
    // NOT retryable — reporting the 503 would tell an outer retry layer to
    // re-queue into the queue that just refused it.
    expect(failure).toBeInstanceOf(AhaSendRateLimitQueueFullError);
    expect(isRetryableError(failure)).toBe(false);
    // The API error survives for diagnosis rather than being discarded.
    expect((failure as { cause?: unknown }).cause).toBeInstanceOf(AhaSendServerError);
  });

  it("leaves a caller's cancellation with its own identity", async () => {
    // `acquire` rejects with AhaSendAbortError as well as queue-full. Wrapping
    // by attempt number rather than by error type relabelled a cancellation as
    // the previous attempt's 503 — which is both wrong and retryable, so an
    // outer retry layer would re-issue a request the caller had cancelled.
    const controller = new AbortController();
    let attempts = 0;
    const config = resolveConfig({
      apiKey: "aha-sk-test",
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      rateLimit: { ...slowPacing, standard: { ...slowPacing.standard, maxQueue: 10 } },
      fetch: () => {
        attempts += 1;
        // Late enough to clear the 0ms backoff and land inside the pacing wait.
        if (attempts === 1) setTimeout(() => controller.abort("caller gave up"), 40);
        return respond503();
      },
    });
    const client = new HttpClient(config);

    const failure = await client
      .request({ method: "GET", path: "/v2/ping", signal: controller.signal })
      .then(
        () => {
          throw new Error("expected the request to fail");
        },
        (reason: unknown) => reason as Error,
      );

    expect(failure).toBeInstanceOf(AhaSendAbortError);
    expect(isRetryableError(failure)).toBe(false);
  });

  it("still surfaces a pacing refusal on the very first attempt", async () => {
    const config = resolveConfig({
      apiKey: "aha-sk-test",
      rateLimit: slowPacing,
      fetch: () => new Promise<Response>(() => {}),
    });
    const client = new HttpClient(config);

    void client.rateLimiter.acquire("GET", "/v2/ping").catch(() => undefined);
    void client.rateLimiter.acquire("GET", "/v2/ping").catch(() => undefined);

    // Nothing earlier went wrong, so there is no cause to attach.
    const failure = await client.request({ method: "GET", path: "/v2/ping" }).then(
      () => {
        throw new Error("expected the request to fail");
      },
      (reason: unknown) => reason as Error,
    );
    expect(failure).toBeInstanceOf(AhaSendRateLimitQueueFullError);
    expect("cause" in failure).toBe(false);
  });
});

describe("queue cancellation at scale", () => {
  const frozen = () => ({ now: () => 0, sleep: vi.fn(() => new Promise<void>(() => undefined)) });

  it("aborts a whole fan-out without a quadratic stall", () => {
    // Cancelling used to indexOf + splice per waiter, and one shared signal
    // across a fan-out made that O(n²) *synchronously*. At 20,000 waiters it
    // blocked the event loop for over a second — and the guide now tells
    // people to size maxQueue to their widest fan-out, so this is the
    // documented path, not an exotic one.
    //
    // Asserted as a shape rather than a wall-clock budget: doubling the queue
    // must not quadruple the cost. A quadratic implementation gives a ratio
    // near 4; a linear one stays near 2.
    const timeAbort = (waiters: number): number => {
      const limiter = new RateLimiter(
        resolveRateLimitConfig({
          enabled: true,
          standard: { requestsPerSecond: 1, burst: 1, maxQueue: waiters + 10 },
        }),
        frozen(),
      );
      const controller = new AbortController();
      for (let index = 0; index < waiters; index += 1) {
        void limiter.acquire("GET", "/v2/ping", controller.signal).catch(() => undefined);
      }
      const startedAt = performance.now();
      controller.abort();
      return performance.now() - startedAt;
    };

    timeAbort(2_000); // warm up, so JIT state is not attributed to the ratio
    const small = timeAbort(4_000);
    const large = timeAbort(16_000);

    // 4x the waiters. Linear predicts ~4x; quadratic predicts ~16x.
    expect(large / Math.max(small, 0.5)).toBeLessThan(9);
  });

  it("reuses a cancelled waiter's slot without disturbing the rest of the queue", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1, maxQueue: 3 },
      }),
      frozen(),
    );
    await limiter.acquire("GET", "/v2/ping");

    const controllers = [0, 1, 2].map(() => new AbortController());
    const queued = controllers.map((controller) => {
      const pending = limiter.acquire("GET", "/v2/ping", controller.signal);
      void pending.catch(() => undefined);
      return pending;
    });

    await expect(limiter.acquire("GET", "/v2/ping")).rejects.toBeInstanceOf(
      AhaSendRateLimitQueueFullError,
    );

    // Cancelling the middle waiter frees exactly one slot — the tombstone it
    // leaves behind must not count against capacity.
    controllers[1]!.abort();
    await expect(queued[1]).rejects.toBeInstanceOf(AhaSendAbortError);

    const readmitted = limiter.acquire("GET", "/v2/ping");
    void readmitted.catch(() => undefined);
    await expect(limiter.acquire("GET", "/v2/ping")).rejects.toBeInstanceOf(
      AhaSendRateLimitQueueFullError,
    );
  });

  it("serves survivors in order and does not resurrect a cancelled waiter", async () => {
    const clock = createRateLimitClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1, maxQueue: 10 },
      }),
      clock.clock,
    );
    await limiter.acquire("GET", "/v2/ping");

    const served: number[] = [];
    const controller = new AbortController();
    const outcomes = [1, 2, 3, 4].map((id) => {
      const signal = id === 2 ? controller.signal : undefined;
      const pending = limiter.acquire("GET", "/v2/ping", signal).then(
        () => served.push(id),
        () => undefined,
      );
      return pending;
    });

    controller.abort();
    for (let tick = 0; tick < 4; tick += 1) await clock.advanceBy(1000);
    await Promise.all(outcomes);

    expect(served).toEqual([1, 3, 4]);
  });
});

describe("rateLimiter controller input validation", () => {
  // `client.rateLimiter` is a public runtime boundary. TypeScript callers are
  // held to the declared types, but JavaScript callers are not — and these
  // arguments routinely come from environment variables or parsed JSON, where
  // the value is a string whatever the type says. Everything here reached the
  // limiter unchecked and surfaced as a bare TypeError from inside it, or
  // worse, silently corrupted state.
  const controller = (): AhaSendClient["rateLimiter"] =>
    new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "11111111-1111-4111-8111-111111111111",
    }).rateLimiter;

  it("rejects a non-boolean enabled flag rather than storing it", () => {
    const rateLimiter = controller();
    // The motivating case: "false" from an env var is truthy, so pacing stayed
    // ON while isEnabled() returned the string "false" in place of a boolean.
    expect(() => rateLimiter.setEnabled("false" as unknown as boolean)).toThrow(
      AhaSendConfigurationError,
    );
    expect(rateLimiter.isEnabled()).toBe(false);
    expect(typeof rateLimiter.isEnabled()).toBe("boolean");

    expect(() => rateLimiter.setCategoryEnabled("standard", 1 as unknown as boolean)).toThrow(
      AhaSendConfigurationError,
    );
    expect(rateLimiter.isCategoryEnabled("standard")).toBe(true);
  });

  it("names the accepted categories instead of throwing from inside the limiter", () => {
    const rateLimiter = controller();
    const calls: (() => unknown)[] = [
      () => rateLimiter.getLimit("bogus" as never),
      () => rateLimiter.available("bogus" as never),
      () => rateLimiter.isCategoryEnabled("bogus" as never),
      () => rateLimiter.setCategoryEnabled("bogus" as never, true),
      () => rateLimiter.setLimit("bogus" as never, { burst: 5 }),
    ];
    for (const call of calls) {
      expect(call).toThrow(AhaSendConfigurationError);
      expect(call).toThrow(/must be one of "standard", "statistics"/);
    }
  });

  it("rejects a limit that is not an object before reading fields off it", () => {
    const rateLimiter = controller();
    for (const bad of [null, undefined, 5, "burst", [1]]) {
      expect(() => rateLimiter.setLimit("standard", bad as never)).toThrow(
        AhaSendConfigurationError,
      );
    }
    expect(rateLimiter.getLimit("standard").burst).toBe(DEFAULT_RATE_LIMIT_CONFIG.standard.burst);
  });

  it("rejects an unrecognized limit key rather than silently ignoring it", () => {
    // A misspelling used to be dropped, so the caller believed a ceiling had
    // been raised while the old one stayed in force.
    const rateLimiter = controller();
    expect(() => rateLimiter.setLimit("standard", { maxQueueSize: 10 } as never)).toThrow(
      /`limit.maxQueueSize` is not a recognized option/,
    );
    expect(rateLimiter.getLimit("standard").maxQueue).toBe(DEFAULT_MAX_QUEUE);
  });

  it("still applies a valid runtime change", () => {
    const rateLimiter = controller();
    rateLimiter.setLimit("statistics", { requestsPerSecond: 5, burst: 10, maxQueue: 25 });
    expect(rateLimiter.getLimit("statistics")).toMatchObject({
      requestsPerSecond: 5,
      burst: 10,
      maxQueue: 25,
    });
    rateLimiter.setEnabled(true);
    expect(rateLimiter.isEnabled()).toBe(true);
  });
});
