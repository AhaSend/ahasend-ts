import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AhaSendAbortError,
  AhaSendAuthenticationError,
  AhaSendBadRequestError,
  AhaSendConnectionError,
  AhaSendIdempotencyConflictError,
  AhaSendNotFoundError,
  AhaSendRateLimitError,
  AhaSendServerError,
  AhaSendTimeoutError,
  createApiError,
} from "../src/errors.js";
import { createIdempotencyExecutionRecord } from "../src/idempotency.js";
import {
  DEFAULT_RETRY_CONFIG,
  computeBackoffMs,
  computeRetryDelayMs,
  isRetryableError,
  resolveRetryConfig,
  sleep,
} from "../src/retry.js";

const NO_JITTER = { ...DEFAULT_RETRY_CONFIG, jitter: false };
const lifecycleFixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/fixtures/idempotency-responses.json"), "utf8"),
) as {
  classifications: Array<{
    name: string;
    status: number;
    headers: Record<string, string>;
    eligible: boolean;
    keyed: boolean;
    expectedCode: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  }>;
};

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
  it("retries on Timeout, Connection, RateLimit, in-progress, and Server", () => {
    expect(isRetryableError(new AhaSendTimeoutError())).toBe(true);
    expect(isRetryableError(new AhaSendConnectionError("net"))).toBe(true);
    expect(isRetryableError(new AhaSendRateLimitError({ ...params, status: 429 }))).toBe(true);
    expect(
      isRetryableError(
        new AhaSendIdempotencyConflictError({
          ...params,
          status: 409,
          retryAfterSeconds: 1,
        }),
      ),
    ).toBe(true);
    expect(isRetryableError(new AhaSendServerError({ ...params, status: 500 }))).toBe(true);
  });

  it("does NOT retry on 4xx client errors", () => {
    expect(isRetryableError(new AhaSendBadRequestError({ ...params, status: 400 }))).toBe(false);
    expect(isRetryableError(new AhaSendAuthenticationError({ ...params, status: 401 }))).toBe(
      false,
    );
    expect(isRetryableError(new AhaSendNotFoundError({ ...params, status: 404 }))).toBe(false);
  });

  it("does NOT retry caller aborts", () => {
    expect(isRetryableError(new AhaSendAbortError())).toBe(false);
  });

  it("does NOT retry on plain Error", () => {
    expect(isRetryableError(new Error("nope"))).toBe(false);
    expect(isRetryableError("string")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe("fixture-driven idempotency lifecycle policy", () => {
  it.each(lifecycleFixtures.classifications)(
    "$name has stable status/header classification and retry policy",
    (fixture) => {
      const policy = fixture.eligible ? Object.freeze({ completion: "automatic" as const }) : null;
      const idempotency = createIdempotencyExecutionRecord(
        policy,
        fixture.keyed ? "fixture-key" : undefined,
      );
      const error = createApiError({
        status: fixture.status,
        body: { message: "message text is deliberately not a classifier" },
        headers: fixture.headers,
        idempotency,
      });

      expect(error.code).toBe(fixture.expectedCode);
      expect(isRetryableError(error)).toBe(fixture.retryable);
      expect((error as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(
        fixture.retryAfterSeconds,
      );
    },
  );
});

describe("computeBackoffMs", () => {
  const random = () => 0; // deterministic — when jitter is on, multiplies by 0.5

  it("constant strategy returns the base delay", () => {
    const delay = computeBackoffMs(3, { ...NO_JITTER, strategy: "constant", baseDelayMs: 500 });
    expect(delay).toBe(500);
  });

  it("linear strategy returns base * attempt", () => {
    expect(computeBackoffMs(1, { ...NO_JITTER, strategy: "linear", baseDelayMs: 100 })).toBe(100);
    expect(computeBackoffMs(3, { ...NO_JITTER, strategy: "linear", baseDelayMs: 100 })).toBe(300);
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
  it("returns plain backoff for a server error without Retry-After", () => {
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

  it("uses a valid Retry-After as the authority even below backoff", () => {
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
    expect(delay).toBe(1000);
  });

  it("caps a server Retry-After at the configured maximum", () => {
    const err = new AhaSendRateLimitError({
      status: 429,
      message: "rate limit",
      body: null,
      retryAfterSeconds: 999,
    });
    const delay = computeRetryDelayMs(err, 1, { ...NO_JITTER, maxDelayMs: 5000 });
    expect(delay).toBe(5000);
  });

  it("accepts the maximum boundary without changing it", () => {
    const err = new AhaSendRateLimitError({
      status: 429,
      message: "rate limit",
      body: null,
      retryAfterSeconds: 5,
    });
    expect(computeRetryDelayMs(err, 1, { ...NO_JITTER, maxDelayMs: 5000 })).toBe(5000);
  });

  it.each([
    [408, "2", 2000],
    [429, "0", 0],
    [503, "3", 3000],
  ])("honours bounded Retry-After timing for HTTP %i", async (status, retryAfter, expectedMs) => {
    vi.useFakeTimers();
    try {
      const error = createApiError({
        status,
        body: null,
        headers: { "retry-after": retryAfter },
      });
      const delayed = sleep(
        computeRetryDelayMs(error, 1, {
          ...NO_JITTER,
          baseDelayMs: 100,
          maxDelayMs: 5000,
        }),
      );
      let settled = false;
      void delayed.then(() => {
        settled = true;
      });

      if (expectedMs > 0) {
        await vi.advanceTimersByTimeAsync(expectedMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      } else {
        await vi.advanceTimersByTimeAsync(0);
      }

      await delayed;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps an oversized Retry-After before sleeping", async () => {
    vi.useFakeTimers();
    try {
      const error = createApiError({
        status: 503,
        body: null,
        headers: { "retry-after": "999" },
      });
      const delayed = sleep(
        computeRetryDelayMs(error, 1, {
          ...NO_JITTER,
          baseDelayMs: 100,
          maxDelayMs: 5000,
        }),
      );
      let settled = false;
      void delayed.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await delayed;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, -1, 1.5, Number.POSITIVE_INFINITY])(
    "falls back to bounded backoff for malformed/negative server delay %s",
    (retryAfterSeconds) => {
      const err = new AhaSendRateLimitError({
        status: 429,
        message: "rate limit",
        body: null,
        retryAfterSeconds,
      });
      expect(
        computeRetryDelayMs(err, 1, { ...NO_JITTER, baseDelayMs: 100, maxDelayMs: 5000 }),
      ).toBe(100);
    },
  );

  it("uses the same bounded authority for idempotency in-progress", () => {
    const err = new AhaSendIdempotencyConflictError({
      status: 409,
      message: "any message",
      body: null,
      retryAfterSeconds: 10,
    });
    expect(computeRetryDelayMs(err, 1, { ...NO_JITTER, maxDelayMs: 3000 })).toBe(3000);
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
