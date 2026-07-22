import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { AhaSendAbortError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  RateLimiter,
  detectCategory,
  resolveRateLimitConfig,
} from "../src/rate-limit.js";

class FakeClock {
  private current = 0;
  private sleepers: Array<{
    deadline: number;
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  now = (): number => this.current;

  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const sleeper: (typeof this.sleepers)[number] = {
        deadline: this.current + ms,
        resolve,
        reject,
      };
      if (signal) {
        sleeper.signal = signal;
        sleeper.onAbort = () => {
          this.remove(sleeper);
          reject(signal.reason);
        };
        signal.addEventListener("abort", sleeper.onAbort, { once: true });
      }
      this.sleepers.push(sleeper);
    });

  pendingDelays(): number[] {
    return this.sleepers.map(({ deadline }) => deadline - this.current);
  }

  async advance(ms: number): Promise<void> {
    this.current += ms;
    for (const sleeper of [...this.sleepers]) {
      if (sleeper.deadline > this.current) continue;
      this.remove(sleeper);
      sleeper.resolve();
    }
    await Promise.resolve();
  }

  private remove(sleeper: (typeof this.sleepers)[number]): void {
    const index = this.sleepers.indexOf(sleeper);
    if (index >= 0) this.sleepers.splice(index, 1);
    if (sleeper.signal && sleeper.onAbort) {
      sleeper.signal.removeEventListener("abort", sleeper.onAbort);
    }
  }
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
  it("bypasses all buckets until pacing is explicitly enabled", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ standard: { requestsPerSecond: 1, burst: 1 } }),
      clock,
    );

    await Promise.all(Array.from({ length: 20 }, () => limiter.acquire("GET", "/v2/ping")));
    expect(clock.pendingDelays()).toEqual([]);
  });

  it("paces a deterministic FIFO queue and bounds tokens at the burst", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      clock,
    );
    const completed: number[] = [];

    const acquisitions = [1, 2, 3].map((id) =>
      limiter.acquire("GET", "/v2/ping").then(() => completed.push(id)),
    );
    await Promise.resolve();
    expect(completed).toEqual([1]);
    expect(clock.pendingDelays()).toEqual([1000]);
    expect(limiter.available("standard")).toBe(0);

    await clock.advance(1000);
    expect(completed).toEqual([1, 2]);
    expect(clock.pendingDelays()).toEqual([1000]);

    await clock.advance(1000);
    await Promise.all(acquisitions);
    expect(completed).toEqual([1, 2, 3]);

    await clock.advance(10_000);
    expect(limiter.available("standard")).toBe(1);
  });

  it("removes an aborted acquisition from the queue immediately", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      clock,
    );
    await limiter.acquire("GET", "/v2/ping");

    const controller = new AbortController();
    const cancelled = limiter.acquire("GET", "/v2/ping", controller.signal);
    const next = limiter.acquire("GET", "/v2/ping");
    controller.abort("caller stopped waiting");

    await expect(cancelled).rejects.toBeInstanceOf(AhaSendAbortError);
    expect(clock.pendingDelays()).toEqual([1000]);

    await clock.advance(1000);
    await next;
  });

  it("does not spend the per-attempt timeout while queued for pacing", async () => {
    vi.useFakeTimers();
    try {
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
    } finally {
      vi.useRealTimers();
    }
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
    const clock = new FakeClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ enabled: true, standard: { burst: 1 } }),
      clock,
    );
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire("GET", "/v2/ping", controller.signal)).rejects.toBeInstanceOf(
      AhaSendAbortError,
    );
    expect(clock.pendingDelays()).toEqual([]);
  });

  it("releases queued acquisitions when master pacing is disabled", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      clock,
    );
    await limiter.acquire("GET", "/v2/ping");
    const queued = [limiter.acquire("GET", "/v2/ping"), limiter.acquire("GET", "/v2/ping")];
    expect(clock.pendingDelays()).toEqual([1000]);

    limiter.setEnabled(false);
    await Promise.all(queued);
    expect(clock.pendingDelays()).toEqual([]);
    await limiter.acquire("GET", "/v2/ping");

    limiter.setEnabled(true);
    await limiter.acquire("GET", "/v2/ping");
    expect(clock.pendingDelays()).toEqual([]);
  });

  it("disables one category without releasing another category's queue", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
        statistics: { requestsPerSecond: 1, burst: 1 },
      }),
      clock,
    );
    await Promise.all([
      limiter.acquire("GET", "/v2/ping"),
      limiter.acquire("GET", "/v2/accounts/a/statistics/bounce"),
    ]);
    const standard = limiter.acquire("GET", "/v2/ping");
    const statistics = limiter.acquire("GET", "/v2/accounts/a/statistics/bounce");
    expect(clock.pendingDelays()).toEqual([1000, 1000]);

    limiter.setCategoryEnabled("standard", false);
    await standard;
    expect(clock.pendingDelays()).toEqual([1000]);

    let statisticsComplete = false;
    void statistics.then(() => {
      statisticsComplete = true;
    });
    await Promise.resolve();
    expect(statisticsComplete).toBe(false);
    await clock.advance(1000);
    await statistics;
  });

  it("reschedules queued work when a category limit changes", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      clock,
    );
    await limiter.acquire("GET", "/v2/ping");
    const queued = limiter.acquire("GET", "/v2/ping");
    expect(clock.pendingDelays()).toEqual([1000]);

    limiter.setLimit("standard", 2, 1);
    expect(clock.pendingDelays()).toEqual([500]);
    await clock.advance(500);
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
    const clock = new FakeClock();
    const sleep = vi.fn().mockRejectedValue(new Error("clock failed"));
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: true,
        standard: { requestsPerSecond: 1, burst: 1 },
      }),
      { now: clock.now, sleep },
    );
    await limiter.acquire("GET", "/v2/ping");

    const queued = [limiter.acquire("GET", "/v2/ping"), limiter.acquire("GET", "/v2/ping")];
    await expect(Promise.all(queued)).rejects.toThrow("clock failed");
  });
});
