import { describe, expect, it } from "vitest";
import {
  AhaSendAuthenticationError,
  AhaSendBadRequestError,
  AhaSendConnectionError,
  AhaSendNotFoundError,
  AhaSendRateLimitError,
  AhaSendServerError,
  AhaSendTimeoutError,
} from "../src/errors.js";
import {
  DEFAULT_RETRY_CONFIG,
  computeBackoffMs,
  computeRetryDelayMs,
  isRetryableError,
  resolveRetryConfig,
  sleep,
} from "../src/retry.js";

const NO_JITTER = { ...DEFAULT_RETRY_CONFIG, jitter: false };

describe("resolveRetryConfig", () => {
  it("returns defaults when no override is provided", () => {
    expect(resolveRetryConfig()).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it("merges overrides on top of defaults", () => {
    const r = resolveRetryConfig({ maxRetries: 5, strategy: "linear" });
    expect(r.maxRetries).toBe(5);
    expect(r.strategy).toBe("linear");
    expect(r.baseDelayMs).toBe(DEFAULT_RETRY_CONFIG.baseDelayMs);
    expect(r.enabled).toBe(true);
  });
});

describe("isRetryableError", () => {
  const params = { status: 0, body: null, message: "x" };
  it("retries on Timeout, Connection, RateLimit, Server", () => {
    expect(isRetryableError(new AhaSendTimeoutError())).toBe(true);
    expect(isRetryableError(new AhaSendConnectionError("net"))).toBe(true);
    expect(isRetryableError(new AhaSendRateLimitError({ ...params, status: 429 }))).toBe(true);
    expect(isRetryableError(new AhaSendServerError({ ...params, status: 500 }))).toBe(true);
  });

  it("does NOT retry on 4xx client errors", () => {
    expect(isRetryableError(new AhaSendBadRequestError({ ...params, status: 400 }))).toBe(false);
    expect(isRetryableError(new AhaSendAuthenticationError({ ...params, status: 401 }))).toBe(false);
    expect(isRetryableError(new AhaSendNotFoundError({ ...params, status: 404 }))).toBe(false);
  });

  it("does NOT retry on plain Error", () => {
    expect(isRetryableError(new Error("nope"))).toBe(false);
    expect(isRetryableError("string")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe("computeBackoffMs", () => {
  const random = () => 0; // deterministic — when jitter is on, multiplies by 0.5

  it("constant strategy returns the base delay", () => {
    const delay = computeBackoffMs(3, { ...NO_JITTER, strategy: "constant", baseDelayMs: 500 });
    expect(delay).toBe(500);
  });

  it("linear strategy returns base * attempt", () => {
    expect(
      computeBackoffMs(1, { ...NO_JITTER, strategy: "linear", baseDelayMs: 100 }),
    ).toBe(100);
    expect(
      computeBackoffMs(3, { ...NO_JITTER, strategy: "linear", baseDelayMs: 100 }),
    ).toBe(300);
  });

  it("exponential strategy returns base * 2^(attempt-1)", () => {
    const cfg = { ...NO_JITTER, strategy: "exponential" as const, baseDelayMs: 100 };
    expect(computeBackoffMs(1, cfg)).toBe(100);
    expect(computeBackoffMs(2, cfg)).toBe(200);
    expect(computeBackoffMs(3, cfg)).toBe(400);
    expect(computeBackoffMs(4, cfg)).toBe(800);
  });

  it("caps at maxDelayMs", () => {
    const delay = computeBackoffMs(10, {
      ...NO_JITTER,
      strategy: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 5000,
    });
    expect(delay).toBe(5000);
  });

  it("jitter scales delay between 0.5x and 1x", () => {
    const cfg = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 1000, jitter: true };
    // random() = 0 → 0.5x, random() = 1 → 1.0x
    expect(computeBackoffMs(1, cfg, () => 0)).toBe(500);
    expect(computeBackoffMs(1, cfg, () => 1)).toBe(1000);
  });
});

describe("computeRetryDelayMs", () => {
  it("returns plain backoff for non-RateLimit errors", () => {
    const delay = computeRetryDelayMs(
      new AhaSendServerError({ status: 500, message: "boom", body: null }),
      1,
      { ...NO_JITTER, baseDelayMs: 100 },
      () => 0,
    );
    expect(delay).toBe(100);
  });

  it("honours Retry-After when it exceeds the backoff", () => {
    const err = new AhaSendRateLimitError({
      status: 429,
      message: "rate limit",
      body: null,
      retryAfterSeconds: 10,
    });
    const delay = computeRetryDelayMs(err, 1, {
      ...NO_JITTER,
      baseDelayMs: 100,
      maxDelayMs: 60_000,
    });
    expect(delay).toBe(10_000);
  });

  it("uses backoff when it exceeds Retry-After", () => {
    const err = new AhaSendRateLimitError({
      status: 429,
      message: "rate limit",
      body: null,
      retryAfterSeconds: 1,
    });
    const delay = computeRetryDelayMs(
      err,
      5,
      { ...NO_JITTER, baseDelayMs: 100, strategy: "exponential" },
      () => 0,
    );
    expect(delay).toBe(1600); // 100 * 2^4 = 1600 > 1000ms (Retry-After)
  });

  it("caps Retry-After at maxDelayMs", () => {
    const err = new AhaSendRateLimitError({
      status: 429,
      message: "rate limit",
      body: null,
      retryAfterSeconds: 999,
    });
    const delay = computeRetryDelayMs(err, 1, { ...NO_JITTER, maxDelayMs: 5000 });
    expect(delay).toBe(5000);
  });
});

describe("sleep", () => {
  it("resolves after the given duration", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("rejects when the abort signal fires", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    await expect(sleep(1000, ctrl.signal)).rejects.toBeDefined();
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(100, ctrl.signal)).rejects.toBeDefined();
  });
});
