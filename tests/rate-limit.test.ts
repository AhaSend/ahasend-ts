import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { AhaSendAbortError, AhaSendError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  RateLimiter,
  detectCategory,
  resolveRateLimitConfig,
} from "../src/rate-limit.js";
import { isRetryableError } from "../src/retry.js";

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

  it("releases queued acquisitions when master pacing is disabled", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
    );
    await limiter.acquire("GET", "/v2/ping");
    const queued = [limiter.acquire("GET", "/v2/ping"), limiter.acquire("GET", "/v2/ping")];
    expect(vi.getTimerCount()).toBe(1);

    limiter.setEnabled(false);
    await Promise.all(queued);
    expect(vi.getTimerCount()).toBe(0);
    await limiter.acquire("GET", "/v2/ping");

    limiter.setEnabled(true);
    await limiter.acquire("GET", "/v2/ping");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disables one category without releasing another category's queue", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
        statistics: { requestsPerSecond: 1, burst: 1 },
      }),
    );
    await Promise.all([
      limiter.acquire("GET", "/v2/ping"),
      limiter.acquire("GET", "/v2/accounts/a/statistics/bounce"),
    ]);
    const standard = limiter.acquire("GET", "/v2/ping");
    const statistics = limiter.acquire("GET", "/v2/accounts/a/statistics/bounce");
    expect(vi.getTimerCount()).toBe(2);

    limiter.setCategoryEnabled("standard", false);
    await standard;
    expect(vi.getTimerCount()).toBe(1);

    let statisticsComplete = false;
    void statistics.then(() => {
      statisticsComplete = true;
    });
    await Promise.resolve();
    expect(statisticsComplete).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await statistics;
  });

  it("reschedules queued work when a category limit changes", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
    );
    await limiter.acquire("GET", "/v2/ping");
    const queued = limiter.acquire("GET", "/v2/ping");
    expect(vi.getTimerCount()).toBe(1);

    limiter.setLimit("standard", 2, 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await queued;
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
