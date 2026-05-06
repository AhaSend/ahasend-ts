import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  RateLimiter,
  detectCategory,
  resolveRateLimitConfig,
} from "../src/rate-limit.js";

describe("detectCategory", () => {
  it("classifies GET /v2/ping as general", () => {
    expect(detectCategory("GET", "/v2/ping")).toBe("general");
  });

  it("classifies POST .../messages as sendMessage", () => {
    expect(detectCategory("POST", "/v2/accounts/abc/messages")).toBe("sendMessage");
  });

  it("classifies POST .../messages/{id}/cancel as general (path has /messages/)", () => {
    expect(detectCategory("POST", "/v2/accounts/abc/messages/m1/cancel")).toBe("general");
  });

  it("classifies GET .../messages as general (not POST)", () => {
    expect(detectCategory("GET", "/v2/accounts/abc/messages")).toBe("general");
  });

  it("classifies any /statistics/ path as statistics", () => {
    expect(detectCategory("GET", "/v2/accounts/abc/statistics/deliverability")).toBe(
      "statistics",
    );
    expect(detectCategory("GET", "/v2/accounts/abc/statistics/bounce")).toBe("statistics");
  });

  it("classifies domain create as general", () => {
    expect(detectCategory("POST", "/v2/accounts/abc/domains")).toBe("general");
  });
});

describe("resolveRateLimitConfig", () => {
  it("returns defaults when no override is provided", () => {
    expect(resolveRateLimitConfig()).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
  });

  it("preserves the master switch when overriding individual categories", () => {
    const r = resolveRateLimitConfig({ statistics: { requestsPerSecond: 5 } });
    expect(r.enabled).toBe(true);
    expect(r.statistics.requestsPerSecond).toBe(5);
    expect(r.statistics.burst).toBe(1);
    expect(r.general).toEqual(DEFAULT_RATE_LIMIT_CONFIG.general);
  });

  it("disables master switch when requested", () => {
    expect(resolveRateLimitConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("permits up to `burst` tokens without waiting", async () => {
    let now = 0;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 1, burst: 5 } }),
      () => now,
    );

    const start = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire("GET", "/x")));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("blocks once the bucket is exhausted, then refills as time passes", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 100, burst: 1 } }),
      () => now,
    );

    await limiter.acquire("GET", "/x");
    expect(limiter.available("general")).toBeLessThan(1);

    now += 1000;
    expect(limiter.available("general")).toBeGreaterThanOrEqual(1);
  });

  it("master enabled=false bypasses all categories", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        enabled: false,
        general: { requestsPerSecond: 0, burst: 0 },
      }),
    );
    const start = Date.now();
    await Promise.all(Array.from({ length: 50 }, () => limiter.acquire("GET", "/x")));
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("category enabled=false bypasses that category only", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        general: { requestsPerSecond: 0, burst: 0, enabled: false },
      }),
    );
    const start = Date.now();
    await Promise.all(Array.from({ length: 50 }, () => limiter.acquire("GET", "/x")));
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("setLimit updates rate and clamps tokens to new burst", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 10, burst: 100 } }),
      () => now,
    );
    expect(limiter.available("general")).toBe(100);
    limiter.setLimit("general", 5, 10);
    expect(limiter.available("general")).toBeLessThanOrEqual(10);
  });

  it("setEnabled toggles the master switch", async () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        general: { requestsPerSecond: 0.001, burst: 1 },
      }),
    );
    await limiter.acquire("GET", "/x");
    limiter.setEnabled(false);
    const start = Date.now();
    await limiter.acquire("GET", "/x");
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("recordResponseHeaders reduces tokens to match server-reported remaining", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 1, burst: 100 } }),
      () => now,
    );
    expect(limiter.available("general")).toBe(100);

    limiter.recordResponseHeaders("GET", "/x", { "x-ratelimit-remaining": "5" });
    expect(limiter.available("general")).toBeLessThanOrEqual(5);
  });

  it("recordResponseHeaders honours the standardised RateLimit-Remaining header too", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 1, burst: 100 } }),
      () => now,
    );

    limiter.recordResponseHeaders("GET", "/x", { "ratelimit-remaining": "3" });
    expect(limiter.available("general")).toBeLessThanOrEqual(3);
  });

  it("recordResponseHeaders never inflates tokens above the local count", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 1, burst: 10 } }),
      () => now,
    );

    limiter.recordResponseHeaders("GET", "/x", { "x-ratelimit-remaining": "9999" });
    expect(limiter.available("general")).toBeLessThanOrEqual(10);
  });

  it("recordResponseHeaders is a no-op when the response has no rate-limit header", () => {
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 1, burst: 100 } }),
    );
    const before = limiter.available("general");
    limiter.recordResponseHeaders("GET", "/x", { "content-type": "application/json" });
    expect(limiter.available("general")).toBe(before);
  });

  it("recordResponseHeaders accepts a Headers instance", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 1, burst: 50 } }),
      () => now,
    );
    const headers = new Headers({ "x-ratelimit-remaining": "7" });
    limiter.recordResponseHeaders("GET", "/x", headers);
    expect(limiter.available("general")).toBeLessThanOrEqual(7);
  });

  it("recordResponseHeaders applies to the right category by method+path", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({
        general: { requestsPerSecond: 1, burst: 100 },
        sendMessage: { requestsPerSecond: 1, burst: 100 },
      }),
      () => now,
    );

    limiter.recordResponseHeaders(
      "POST",
      "/v2/accounts/abc/messages",
      { "x-ratelimit-remaining": "2" },
    );
    expect(limiter.available("sendMessage")).toBeLessThanOrEqual(2);
    expect(limiter.available("general")).toBe(100);
  });

  it("serializes concurrent acquires (no over-spending)", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      resolveRateLimitConfig({ general: { requestsPerSecond: 1000, burst: 3 } }),
      () => now,
    );

    // 3 burst tokens — start 5 parallel acquires; the bucket should never go negative
    let satisfied = 0;
    const promises = Array.from({ length: 5 }, () =>
      limiter.acquire("GET", "/x").then(() => satisfied++),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(satisfied).toBeGreaterThanOrEqual(3);
    expect(satisfied).toBeLessThanOrEqual(5);

    // Advance time enough to refill remaining tokens, then await all
    now += 10_000;
    await Promise.all(promises);
    expect(satisfied).toBe(5);
  });
});
