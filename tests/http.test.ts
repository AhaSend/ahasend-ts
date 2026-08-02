import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  AhaSendPromise,
  AhaSendResponse,
  IdempotencyRequestOptions,
  NonEmptyArray,
  RequestOptions,
  RetryConfig,
} from "../src/index.js";
import { MAX_TIMER_DELAY_MS, resolveConfig } from "../src/config.js";
import {
  AhaSendAbortError,
  AhaSendAuthenticationError,
  AhaSendConflictError,
  AhaSendConfigurationError,
  AhaSendConnectionError,
  AhaSendIdempotencyConflictError,
  AhaSendIdempotencyMismatchError,
  AhaSendNotFoundError,
  AhaSendRateLimitError,
  AhaSendTimeoutError,
  AhaSendUnprocessableEntityError,
} from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { OperationExecutor } from "../src/operations.js";
import { ACCOUNT_ID } from "./helpers/resource-call.js";

type FetchImpl = typeof fetch;

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchImpl {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as FetchImpl;
}

function makeAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function makeClient(
  fetchImpl: FetchImpl,
  options: Partial<Parameters<typeof resolveConfig>[0]> = {},
): HttpClient {
  return new HttpClient(
    resolveConfig({
      apiKey: "aha-sk-test",
      fetch: fetchImpl,
      baseUrl: "https://api.test",
      ...options,
    }),
  );
}

describe("HttpClient", () => {
  it("attaches Bearer auth, User-Agent, and Accept headers on GET", async () => {
    let seenInit: RequestInit | undefined;
    const client = makeClient(
      mockFetch((_url, init) => {
        seenInit = init;
        return new Response(JSON.stringify({ message: "pong" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await client.request<{ message: string }>({ method: "GET", path: "/v2/ping" });

    expect(result).toEqual({ message: "pong" });
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer aha-sk-test");
    expect(headers["accept"]).toBe("application/json");
    expect(headers["user-agent"]).toMatch(/^ahasend-node\//);
  });

  it("builds URLs with query params and skips undefined/null values", async () => {
    let seenUrl = "";
    const client = makeClient(
      mockFetch((url) => {
        seenUrl = url;
        return new Response("{}", { status: 200 });
      }),
    );

    await client.request({
      method: "GET",
      path: `/v2/accounts/${ACCOUNT_ID}/messages`,
      query: { limit: 10, after: "cursor", skip_me: undefined, also_skip: null, tag: "welcome" },
    });

    expect(seenUrl).toContain(`https://api.test/v2/accounts/${ACCOUNT_ID}/messages?`);
    expect(seenUrl).toContain("limit=10");
    expect(seenUrl).toContain("after=cursor");
    expect(seenUrl).toContain("tag=welcome");
    expect(seenUrl).not.toContain("skip_me");
    expect(seenUrl).not.toContain("also_skip");
  });

  it.each([
    ["http://localhost:4010", "http://localhost:4010/v2/ping"],
    ["http://127.0.0.1:4010", "http://127.0.0.1:4010/v2/ping"],
    ["http://[::1]:4010", "http://[::1]:4010/v2/ping"],
  ])("joins a generated route to the local origin %s", async (baseUrl, expectedUrl) => {
    let seenUrl = "";
    const client = makeClient(
      mockFetch((url) => {
        seenUrl = url;
        return new Response("{}", { status: 200 });
      }),
      { baseUrl },
    );

    await client.request({ method: "GET", path: "/v2/ping" });

    expect(seenUrl).toBe(expectedUrl);
  });

  it("keeps even network-path-like routes on the configured origin", async () => {
    let seenUrl = "";
    const client = makeClient(
      mockFetch((url) => {
        seenUrl = url;
        return new Response("{}", { status: 200 });
      }),
    );

    await client.request({ method: "GET", path: "//attacker.test/v2/ping" });

    expect(seenUrl).toBe("https://api.test/attacker.test/v2/ping");
  });

  it("repeats array query params", async () => {
    let seenUrl = "";
    const client = makeClient(
      mockFetch((url) => {
        seenUrl = url;
        return new Response("{}", { status: 200 });
      }),
    );

    await client.request({
      method: "GET",
      path: "/x",
      query: { tag: ["welcome", "onboarding"] },
    });

    const url = new URL(seenUrl);
    expect(url.searchParams.getAll("tag")).toEqual(["welcome", "onboarding"]);
  });

  it("serializes a JSON body and sets content-type on POST", async () => {
    let seenInit: RequestInit | undefined;
    const client = makeClient(
      mockFetch((_url, init) => {
        seenInit = init;
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }),
    );

    await client.request({
      method: "POST",
      path: `/v2/accounts/${ACCOUNT_ID}/domains`,
      body: { domain: "example.com" },
    });

    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.body).toBe(JSON.stringify({ domain: "example.com" }));
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("passes through non-owned custom headers with lowercase keys", async () => {
    let seenInit: RequestInit | undefined;
    const client = makeClient(
      mockFetch((_url, init) => {
        seenInit = init;
        return new Response("{}", { status: 200 });
      }),
    );

    await client.request({
      method: "POST",
      path: "/x",
      body: {},
      headers: { "X-Trace-Id": "trace-1" },
    });

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["x-trace-id"]).toBe("trace-1");
  });

  it("maps non-2xx responses to typed errors", async () => {
    const client = makeClient(
      mockFetch(
        () =>
          new Response(JSON.stringify({ message: "missing" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(client.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(
      AhaSendNotFoundError,
    );
  });

  it("exposes status/body/requestId on API errors", async () => {
    const client = makeClient(
      mockFetch(
        () =>
          new Response(JSON.stringify({ message: "nope" }), {
            status: 401,
            headers: { "content-type": "application/json", "x-request-id": "req_123" },
          }),
      ),
    );

    try {
      await client.request({ method: "GET", path: "/x" });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AhaSendAuthenticationError);
      const e = err as AhaSendAuthenticationError;
      expect(e.status).toBe(401);
      expect(e.requestId).toBe("req_123");
      expect(e.body).toEqual({ message: "nope" });
    }
  });

  it("returns undefined for 204 No Content", async () => {
    const client = makeClient(mockFetch(() => new Response(null, { status: 204 })));
    const result = await client.request({ method: "DELETE", path: "/x" });
    expect(result).toBeUndefined();
  });

  it("wraps network failures as AhaSendConnectionError", async () => {
    const client = makeClient(
      mockFetch(() => {
        throw new TypeError("network fail");
      }),
      { retry: { enabled: false } },
    );

    await expect(client.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(
      AhaSendConnectionError,
    );
  });

  it("classifies native request-construction failures without retrying them", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = makeClient(fetchImpl, {
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    });

    const request = client.request({ method: "CONNECT" as "GET", path: "/x" });

    await expect(request).rejects.toBeInstanceOf(AhaSendConfigurationError);
    await expect(request).rejects.not.toBeInstanceOf(AhaSendConnectionError);
    await expect(request).rejects.toMatchObject({
      code: "configuration_error",
      cause: expect.any(TypeError),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("auto-injects Idempotency-Key only when autoIdempotency:true is set (POST allowlist)", async () => {
    let seenInit: RequestInit | undefined;
    const client = makeClient(
      mockFetch((_url, init) => {
        seenInit = init;
        return new Response("{}", { status: 200 });
      }),
    );

    // POST without the opt-in flag — should NOT get an auto key.
    // This is the new, narrower contract: the resource client opts in
    // via `forwardWithIdempotency()` for the 9 spec-documented endpoints.
    await client.request({ method: "POST", path: "/x", body: {} });
    let headers = seenInit?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeUndefined();

    // POST WITH the opt-in flag — gets an auto key.
    await client.request({
      method: "POST",
      path: "/x",
      body: {},
      autoIdempotency: true,
    });
    headers = seenInit?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("does NOT auto-inject Idempotency-Key on GET", async () => {
    let seenInit: RequestInit | undefined;
    const client = makeClient(
      mockFetch((_url, init) => {
        seenInit = init;
        return new Response("{}", { status: 200 });
      }),
    );

    await client.request({ method: "GET", path: "/x" });

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeUndefined();
  });

  it("does NOT overwrite an explicitly provided idempotency option", async () => {
    let seenInit: RequestInit | undefined;
    const client = makeClient(
      mockFetch((_url, init) => {
        seenInit = init;
        return new Response("{}", { status: 200 });
      }),
    );

    await client.request({
      method: "POST",
      path: "/x",
      body: {},
      idempotencyKey: "user-supplied-key",
      autoIdempotency: true,
    });

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("user-supplied-key");
  });

  it("configures fetch to block redirects before owned headers can reach another origin", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      seenInit = init;
      throw new TypeError("redirect mode prevented following the response");
    });
    const client = makeClient(fetchImpl, { retry: { enabled: false } });

    await expect(
      client.request({
        method: "POST",
        path: "/redirect",
        body: { secret: true },
        idempotencyKey: "redirect-key",
      }),
    ).rejects.toBeInstanceOf(AhaSendConnectionError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seenInit?.redirect).toBe("error");
  });

  it("does NOT auto-inject when idempotency.autoGenerate is disabled", async () => {
    let seenInit: RequestInit | undefined;
    const client = makeClient(
      mockFetch((_url, init) => {
        seenInit = init;
        return new Response("{}", { status: 200 });
      }),
      { idempotency: { autoGenerate: false } },
    );

    await client.request({ method: "POST", path: "/x", body: {} });

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeUndefined();
  });

  it("respects the idempotency.prefix when generating keys (literal prepend, no separator)", async () => {
    let seenInit: RequestInit | undefined;
    const client = makeClient(
      mockFetch((_url, init) => {
        seenInit = init;
        return new Response("{}", { status: 200 });
      }),
      { idempotency: { prefix: "myapp-" } },
    );

    await client.request({
      method: "POST",
      path: "/x",
      body: {},
      autoIdempotency: true,
    });

    const headers = seenInit?.headers as Record<string, string>;
    // Prefix is literal — caller controls separator. "myapp-" produces
    // "myapp-<uuid>" (single dash). Old behavior produced "myapp--<uuid>".
    expect(headers["idempotency-key"]).toMatch(
      /^myapp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe("HttpClient cancellation and attempt timeouts", () => {
  it.each([
    ["fractional", 0.5],
    ["one millisecond", 1],
    ["the timer maximum", MAX_TIMER_DELAY_MS],
  ])("accepts a per-call timeout at %s", async (_label, timeoutMs) => {
    const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
    const client = makeClient(fetchImpl, { retry: { enabled: false } });

    await expect(client.request({ method: "GET", path: "/x", timeoutMs })).resolves.toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["zero", 0],
    ["a negative value", -1],
    ["above the timer maximum", MAX_TIMER_DELAY_MS + 1],
  ])("rejects a per-call timeout of %s before fetch", (_label, timeoutMs) => {
    const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
    const client = makeClient(fetchImpl, { retry: { enabled: false } });

    expect(() => client.request({ method: "GET", path: "/x", timeoutMs })).toThrow(/timeoutMs/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted consumer signal before fetch starts", async () => {
    const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
    const client = makeClient(fetchImpl, { retry: { enabled: false } });
    const controller = new AbortController();
    controller.abort("consumer cancelled before dispatch");

    await expect(
      client.request({ method: "GET", path: "/x", signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "abort_error",
      cause: "consumer cancelled before dispatch",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the attempt timeout stopped in the pacing queue and lets caller abort win", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
      const client = makeClient(fetchImpl, {
        timeoutMs: 5_000,
        retry: { enabled: false },
        rateLimit: { enabled: true, standard: { requestsPerSecond: 1, burst: 1 } },
      });
      await client.request({ method: "GET", path: "/x" });

      const controller = new AbortController();
      const queued = client.request({
        method: "GET",
        path: "/x",
        signal: controller.signal,
        timeoutMs: 100,
      });
      let settled = false;
      void queued.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(250);
      expect(settled).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      controller.abort("caller cancelled while queued");
      await expect(queued).rejects.toMatchObject({ code: "abort_error" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the per-call timeout while fetch is pending", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetch(
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(makeAbortError()), { once: true });
          }),
      );
      const client = makeClient(fetchImpl, {
        timeoutMs: 5_000,
        retry: { enabled: false },
      });
      const request = client.request({ method: "GET", path: "/x", timeoutMs: 100 });
      const rejected = expect(request).rejects.toMatchObject({
        code: "timeout_error",
        message: expect.stringContaining("100ms"),
      });

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timeout precedence when the caller aborts before a timed-out fetch settles", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = mockFetch(
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => setTimeout(() => reject(makeAbortError()), 150),
              { once: true },
            );
          }),
      );
      const client = makeClient(fetchImpl, {
        timeoutMs: 100,
        retry: { enabled: false },
      });
      const request = client.request({ method: "GET", path: "/x", signal: controller.signal });
      const rejected = expect(request).rejects.toBeInstanceOf(AhaSendTimeoutError);

      await vi.advanceTimersByTimeAsync(100);
      controller.abort("caller cancelled after timeout");
      await vi.advanceTimersByTimeAsync(150);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps caller abort precedence when fetch rejects with its timeout-typed reason", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = mockFetch(
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => {
                const reason = init.signal?.reason;
                setTimeout(() => reject(reason), 150);
              },
              { once: true },
            );
          }),
      );
      const client = makeClient(fetchImpl, {
        timeoutMs: 100,
        retry: { maxRetries: 2, baseDelayMs: 1, jitter: false },
      });
      const request = client.request({ method: "GET", path: "/x", signal: controller.signal });
      const rejected = expect(request).rejects.toBeInstanceOf(AhaSendAbortError);

      await vi.advanceTimersByTimeAsync(25);
      controller.abort(new AhaSendTimeoutError("caller-provided abort reason"));
      await vi.advanceTimersByTimeAsync(150);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes response-body reading in the per-attempt timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetch((_url, init) => {
        const response = new Response("{}", { status: 200 });
        vi.spyOn(response, "text").mockImplementation(
          () =>
            new Promise<string>((_, reject) => {
              init.signal?.addEventListener("abort", () => reject(makeAbortError()), {
                once: true,
              });
            }),
        );
        return response;
      });
      const client = makeClient(fetchImpl, {
        timeoutMs: 5_000,
        retry: { enabled: false },
      });
      const request = client.request({ method: "GET", path: "/x", timeoutMs: 100 });
      const rejected = expect(request).rejects.toBeInstanceOf(AhaSendTimeoutError);

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps caller abort precedence when body reading rejects with its timeout-typed reason", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = mockFetch((_url, init) => {
        const response = new Response("{}", { status: 200 });
        vi.spyOn(response, "text").mockImplementation(
          () =>
            new Promise<string>((_, reject) => {
              init.signal?.addEventListener(
                "abort",
                () => {
                  const reason = init.signal?.reason;
                  setTimeout(() => reject(reason), 150);
                },
                { once: true },
              );
            }),
        );
        return response;
      });
      const client = makeClient(fetchImpl, {
        timeoutMs: 100,
        retry: { maxRetries: 2, baseDelayMs: 1, jitter: false },
      });
      const request = client.request({ method: "GET", path: "/x", signal: controller.signal });
      const rejected = expect(request).rejects.toBeInstanceOf(AhaSendAbortError);

      await vi.advanceTimersByTimeAsync(25);
      controller.abort(new AhaSendTimeoutError("caller-provided abort reason"));
      await vi.advanceTimersByTimeAsync(150);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spend the per-attempt timeout during retry backoff", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fetchImpl = mockFetch(() => {
        attempts++;
        return attempts === 1
          ? new Response("server error", { status: 500 })
          : new Response("{}", { status: 200 });
      });
      const client = makeClient(fetchImpl, {
        timeoutMs: 5_000,
        retry: { maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 1000, jitter: false },
      });
      const request = client.request({ method: "GET", path: "/x", timeoutMs: 100 });

      await vi.advanceTimersByTimeAsync(250);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(750);
      await expect(request).resolves.toEqual({});
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels retry backoff with a non-retryable public abort error", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = mockFetch(() => new Response("server error", { status: 500 }));
      const client = makeClient(fetchImpl, {
        timeoutMs: 100,
        retry: { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 1000, jitter: false },
      });
      const request = client.request({ method: "GET", path: "/x", signal: controller.signal });
      const rejected = expect(request).rejects.toBeInstanceOf(AhaSendAbortError);

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      controller.abort("caller cancelled during backoff");

      await rejected;
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours HTTP-date form of Retry-After (RFC 9110 §10.2.3)", async () => {
    // Surface the parsed Retry-After through the error envelope rather
    // than driving it through the retry loop (a 60-second backoff would
    // be unmistakably real but unfriendly to fast unit tests).
    const httpDate = new Date(Date.now() + 60_000).toUTCString();
    const client = makeClient(
      mockFetch(
        () =>
          new Response("rate limit", {
            status: 429,
            headers: { "retry-after": httpDate },
          }),
      ),
      { retry: { enabled: false } },
    );
    let captured: unknown;
    try {
      await client.request({ method: "GET", path: "/x" });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(AhaSendRateLimitError);
    const rate = captured as AhaSendRateLimitError;
    // The HTTP-date should parse to roughly 60 seconds in the future.
    expect(rate.retryAfterSeconds).toBeGreaterThanOrEqual(55);
    expect(rate.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe("HttpClient response promises", () => {
  it("exports the shared promise, response, request-option, and non-empty-array types", () => {
    expectTypeOf<NonEmptyArray<string>>().toEqualTypeOf<readonly [string, ...string[]]>();
    expectTypeOf<IdempotencyRequestOptions>().toExtend<RequestOptions>();
    expectTypeOf<AhaSendResponse<string>>().toEqualTypeOf<{
      data: string;
      response: Response;
      requestId?: string;
      idempotentReplayed?: boolean;
    }>();
    expectTypeOf<AhaSendPromise<string>>().toExtend<Promise<string>>();
    expectTypeOf<AhaSendPromise<string>["withResponse"]>().returns.toEqualTypeOf<
      Promise<AhaSendResponse<string>>
    >();
  });

  it("returns an object body and its response envelope with one fetch", async () => {
    const response = new Response(JSON.stringify({ object: "message", id: "m1" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_123",
        "idempotent-replayed": "true",
      },
    });
    const fetchImpl = mockFetch(() => response);
    const client = makeClient(fetchImpl, { retry: { enabled: false } });

    const request = client.request<{ object: string; id: string }>({
      method: "POST",
      path: "/x",
      body: {},
      autoIdempotency: true,
    });
    const envelope = await request.withResponse();
    const body = await request;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ object: "message", id: "m1" });
    expect(envelope.data).toBe(body);
    expect(envelope.response).toBe(response);
    expect(envelope.requestId).toBe("req_123");
    expect(envelope.idempotentReplayed).toBe(true);
  });

  it("distinguishes fresh keyed success from an exact stored success replay", async () => {
    const calls: Array<{ body: BodyInit | null | undefined; key: string | undefined }> = [];
    let attempt = 0;
    const responseBody = { object: "domain", domain: "example.com" };
    const executor = new OperationExecutor(
      makeClient(
        mockFetch((_url, init) => {
          calls.push({
            body: init.body,
            key: (init.headers as Record<string, string>)["idempotency-key"],
          });
          attempt++;
          return new Response(JSON.stringify(responseBody), {
            status: 201,
            headers: attempt === 2 ? { "idempotent-replayed": "true" } : {},
          });
        }),
        { retry: { enabled: false } },
      ),
    );
    const parameters = {
      path: { account_id: ACCOUNT_ID },
      body: { domain: "example.com" },
    };
    const options = { idempotencyKey: "stable-domain-key" };

    const fresh = await executor.execute("createDomain", parameters, options).withResponse();
    const stored = await executor.execute("createDomain", parameters, options).withResponse();

    expect(fresh.response.status).toBe(201);
    expect(fresh.data).toEqual(responseBody);
    expect(fresh.idempotentReplayed).toBeUndefined();
    expect(stored.response.status).toBe(201);
    expect(stored.data).toEqual(responseBody);
    expect(stored.idempotentReplayed).toBe(true);
    expect(calls).toEqual([
      { body: JSON.stringify(parameters.body), key: "stable-domain-key" },
      { body: JSON.stringify(parameters.body), key: "stable-domain-key" },
    ]);
  });

  it("returns primitive JSON through both promise views", async () => {
    const client = makeClient(
      mockFetch(
        () =>
          new Response("42", {
            status: 200,
            headers: { "idempotent-replayed": "True" },
          }),
      ),
      { retry: { enabled: false } },
    );

    const request = client.request<number>({ method: "GET", path: "/x" });

    await expect(request).resolves.toBe(42);
    const envelope = await request.withResponse();
    expect(envelope.data).toBe(42);
    expect(envelope.idempotentReplayed).toBeUndefined();
  });

  it("returns empty successes through both promise views", async () => {
    const response = new Response(null, {
      status: 204,
      headers: { "x-request-id": "req_empty" },
    });
    const client = makeClient(
      mockFetch(() => response),
      { retry: { enabled: false } },
    );

    const request = client.request<void>({ method: "DELETE", path: "/x" });
    const [body, envelope] = await Promise.all([request, request.withResponse()]);

    expect(body).toBeUndefined();
    expect(envelope.data).toBeUndefined();
    expect(envelope.response).toBe(response);
    expect(envelope.requestId).toBe("req_empty");
    expect(envelope.idempotentReplayed).toBeUndefined();
  });

  it("rejects through withResponse without creating an unobserved body rejection", async () => {
    const client = makeClient(
      mockFetch(() => new Response("server error", { status: 500 })),
      { retry: { enabled: false } },
    );

    const request = client.request({ method: "GET", path: "/x" });

    await expect(request.withResponse()).rejects.toMatchObject({ status: 500 });
  });

  it("reports an ignored failed request as an unhandled rejection", async () => {
    const existingListeners = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");

    try {
      const unhandled = new Promise<{ promise: Promise<unknown>; reason: unknown }>((resolve) => {
        process.once("unhandledRejection", (reason, promise) => resolve({ promise, reason }));
      });
      const client = makeClient(
        mockFetch(() => new Response("server error", { status: 500 })),
        { retry: { enabled: false } },
      );

      const request = client.request({ method: "GET", path: "/x" });
      const event = await Promise.race([
        unhandled,
        new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
      ]);

      expect(event?.promise).toBe(request);
      expect(event?.reason).toMatchObject({ status: 500 });
    } finally {
      process.removeAllListeners("unhandledRejection");
      for (const listener of existingListeners) {
        process.on("unhandledRejection", listener);
      }
    }
  });

  it("does not expose legacy magic metadata fields or getResponseMetadata", async () => {
    const client = makeClient(
      mockFetch(
        () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "x-request-id": "req_legacy",
              "idempotent-replayed": "true",
            },
          }),
      ),
      { retry: { enabled: false } },
    );

    const body = await client.request<{ ok: boolean }>({ method: "GET", path: "/x" });
    const publicApi = await import("../src/index.js");

    expect(body).not.toHaveProperty("_requestId");
    expect(body).not.toHaveProperty("_idempotentReplayed");
    expect(publicApi).not.toHaveProperty("getResponseMetadata");
  });
});

describe("HttpClient retry behaviour", () => {
  const fastRetry = { baseDelayMs: 1, maxDelayMs: 5, jitter: false };

  it.each([
    ["false", false, 1],
    ["enabled:false", { enabled: false }, 1],
    ["enabled:true", { enabled: true }, 3],
    ["maxRetries", { maxRetries: 1 }, 2],
    ["strategy", { strategy: "constant" as const }, 3],
    ["jitter", { jitter: false }, 3],
  ])(
    "applies the per-call %s override against enabled client retries",
    async (_name, retry, attempts) => {
      const fetchImpl = mockFetch(() => new Response("server error", { status: 500 }));
      const client = makeClient(fetchImpl, {
        retry: {
          enabled: true,
          maxRetries: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          strategy: "constant",
          jitter: false,
        },
      });

      await expect(
        client.request({
          method: "GET",
          path: "/x",
          retry: retry as false | Partial<RetryConfig>,
        }),
      ).rejects.toMatchObject({ status: 500 });
      expect(fetchImpl).toHaveBeenCalledTimes(attempts);
    },
  );

  it("applies a per-call baseDelayMs decrease", async () => {
    const retryDelays: number[] = [];
    const fetchImpl = mockFetch(() => new Response("server error", { status: 500 }));
    const client = makeClient(fetchImpl, {
      hooks: {
        onRetry: ({ delayMs }) => {
          retryDelays.push(delayMs);
        },
      },
      retry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 4,
        maxDelayMs: 8,
        strategy: "constant",
        jitter: false,
      },
    });

    await expect(
      client.request({ method: "GET", path: "/x", retry: { baseDelayMs: 1 } }),
    ).rejects.toMatchObject({ status: 500 });
    expect(retryDelays).toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("applies a per-call maxDelayMs decrease", async () => {
    const retryDelays: number[] = [];
    const fetchImpl = mockFetch(() => new Response("server error", { status: 500 }));
    const client = makeClient(fetchImpl, {
      hooks: {
        onRetry: ({ delayMs }) => {
          retryDelays.push(delayMs);
        },
      },
      retry: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 4,
        strategy: "exponential",
        jitter: false,
      },
    });

    await expect(
      client.request({ method: "GET", path: "/x", retry: { maxDelayMs: 2 } }),
    ).rejects.toMatchObject({ status: 500 });
    expect(retryDelays).toEqual([1, 2, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["false", false],
    ["enabled:false", { enabled: false }],
    ["maxRetries", { maxRetries: 1 }],
    ["baseDelayMs", { baseDelayMs: 0 }],
    ["maxDelayMs", { maxDelayMs: 0 }],
    ["strategy", { strategy: "constant" as const }],
    ["jitter", { jitter: false }],
  ])("keeps retries disabled for a per-call %s override", async (_name, retry) => {
    const fetchImpl = mockFetch(() => new Response("server error", { status: 500 }));
    const client = makeClient(fetchImpl, {
      retry: {
        enabled: false,
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        strategy: "constant",
        jitter: false,
      },
    });

    await expect(
      client.request({
        method: "GET",
        path: "/x",
        retry: retry as false | Partial<RetryConfig>,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["enabled", { enabled: true }, { enabled: false }],
    ["maxRetries", { maxRetries: 3 }, { enabled: true, maxRetries: 2 }],
    ["baseDelayMs", { baseDelayMs: 6 }, { enabled: true, baseDelayMs: 5, maxDelayMs: 10 }],
    ["maxDelayMs", { maxDelayMs: 11 }, { enabled: true, baseDelayMs: 5, maxDelayMs: 10 }],
    ["strategy", { strategy: "linear" as const }, { enabled: true }],
    ["jitter", { jitter: false }, { enabled: true }],
  ])("rejects a per-call %s policy increase before fetch", (field, retry, configured) => {
    const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
    const client = makeClient(fetchImpl, {
      retry: {
        maxRetries: 2,
        baseDelayMs: 5,
        maxDelayMs: 10,
        strategy: "exponential",
        jitter: true,
        ...configured,
      },
    });

    expect(() => client.request({ method: "GET", path: "/x", retry })).toThrow(
      new RegExp(`request options\\.retry\\.${field}`),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a per-call delay cap below the resolved base delay before fetch", () => {
    const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
    const client = makeClient(fetchImpl, {
      retry: { baseDelayMs: 5, maxDelayMs: 10 },
    });

    expect(() => client.request({ method: "GET", path: "/x", retry: { maxDelayMs: 4 } })).toThrow(
      /request options\.retry\.maxDelayMs.*greater than or equal to.*baseDelayMs/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown field", { extra: true }],
    ["non-boolean enabled", { enabled: "yes" }],
    ["invalid maxRetries", { maxRetries: 1.5 }],
    ["invalid baseDelayMs", { baseDelayMs: -1 }],
    ["invalid maxDelayMs", { maxDelayMs: Number.NaN }],
    ["invalid strategy", { strategy: "random" }],
    ["non-boolean jitter", { jitter: 1 }],
  ])("rejects a malformed per-call retry override with %s before fetch", (_name, retry) => {
    const fetchImpl = mockFetch(() => new Response("{}", { status: 200 }));
    const client = makeClient(fetchImpl);

    expect(() => client.request({ method: "GET", path: "/x", retry } as never)).toThrow(
      /request options\.retry/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps generated never-retry safety final after resolving a per-call override", async () => {
    const fetchImpl = mockFetch(() => new Response("server error", { status: 500 }));
    const client = makeClient(fetchImpl, {
      retry: { ...fastRetry, enabled: true, maxRetries: 2 },
    });

    await expect(
      client.request({
        method: "POST",
        path: "/x",
        retryMode: "never",
        retry: { enabled: true, maxRetries: 2 },
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries on a 500 then succeeds", async () => {
    let attempts = 0;
    const client = makeClient(
      mockFetch(() => {
        attempts++;
        if (attempts === 1) return new Response("server error", { status: 500 });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
      { retry: fastRetry },
    );

    const result = await client.request<{ ok: boolean }>({ method: "GET", path: "/x" });
    expect(attempts).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("does NOT retry on a 400", async () => {
    let attempts = 0;
    const client = makeClient(
      mockFetch(() => {
        attempts++;
        return new Response(JSON.stringify({ message: "bad" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }),
      { retry: fastRetry },
    );

    await expect(client.request({ method: "GET", path: "/x" })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("does NOT retry on a 401", async () => {
    let attempts = 0;
    const client = makeClient(
      mockFetch(() => {
        attempts++;
        return new Response("unauthorized", { status: 401 });
      }),
      { retry: fastRetry },
    );

    await expect(client.request({ method: "GET", path: "/x" })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("retries on 429 and honours Retry-After", async () => {
    let attempts = 0;
    const client = makeClient(
      mockFetch(() => {
        attempts++;
        if (attempts === 1) {
          return new Response("rate limit", { status: 429, headers: { "retry-after": "0" } });
        }
        return new Response("{}", { status: 200 });
      }),
      { retry: fastRetry },
    );

    await client.request({ method: "GET", path: "/x" });
    expect(attempts).toBe(2);
  });

  it("falls back to backoff for a malformed date-like Retry-After", async () => {
    let attempts = 0;
    const retryDelays: number[] = [];
    const client = makeClient(
      mockFetch(() => {
        attempts++;
        if (attempts === 1) {
          return new Response("rate limit", {
            status: 429,
            headers: { "retry-after": "Sun, 31 Feb 2099 00:00:00 GMT" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
      {
        hooks: {
          onRetry: ({ delayMs }) => {
            retryDelays.push(delayMs);
          },
        },
        retry: fastRetry,
      },
    );

    await client.request({ method: "GET", path: "/x" });
    expect(attempts).toBe(2);
    expect(retryDelays).toEqual([1]);
  });

  it("throws the last error after exhausting retries", async () => {
    let attempts = 0;
    const client = makeClient(
      mockFetch(() => {
        attempts++;
        return new Response("boom", { status: 500 });
      }),
      { retry: { ...fastRetry, maxRetries: 2 } },
    );

    await expect(client.request({ method: "GET", path: "/x" })).rejects.toThrow();
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it("retry disabled → only one attempt", async () => {
    let attempts = 0;
    const client = makeClient(
      mockFetch(() => {
        attempts++;
        return new Response("boom", { status: 500 });
      }),
      { retry: { enabled: false } },
    );

    await expect(client.request({ method: "GET", path: "/x" })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("CRITICAL: reuses the same Idempotency-Key across retries", async () => {
    const seenKeys: string[] = [];
    let attempts = 0;
    const client = makeClient(
      mockFetch((_url, init) => {
        attempts++;
        const headers = init.headers as Record<string, string>;
        const key = headers["idempotency-key"];
        if (key) seenKeys.push(key);
        if (attempts < 3) return new Response("server error", { status: 503 });
        return new Response("{}", { status: 200 });
      }),
      { retry: { ...fastRetry, maxRetries: 3 } },
    );

    await client.request({
      method: "POST",
      path: "/x",
      body: { a: 1 },
      autoIdempotency: true,
      retryMode: "idempotency_key",
    });

    expect(attempts).toBe(3);
    expect(seenKeys).toHaveLength(3);
    expect(new Set(seenKeys).size).toBe(1); // all the same key
  });

  it("recovers an exact in-progress tuple with the unchanged keyed execution", async () => {
    const bodies: BodyInit[] = [];
    const keys: string[] = [];
    let attempts = 0;
    const client = makeClient(
      mockFetch((_url, init) => {
        attempts++;
        bodies.push(init.body!);
        keys.push((init.headers as Record<string, string>)["idempotency-key"]!);
        if (attempts === 1) {
          return new Response(JSON.stringify({ message: "text may change" }), {
            status: 409,
            headers: { "idempotent-replayed": "false", "retry-after": "10" },
          });
        }
        return new Response(JSON.stringify({ object: "domain", domain: "example.com" }), {
          status: 201,
        });
      }),
      { retry: { ...fastRetry, maxRetries: 1 } },
    );
    const executor = new OperationExecutor(client);
    const body = { domain: "example.com" };

    await expect(
      executor.execute(
        "createDomain",
        { path: { account_id: ACCOUNT_ID }, body },
        {
          idempotencyKey: "stable-domain-key",
        },
      ),
    ).resolves.toMatchObject({ domain: "example.com" });

    expect(attempts).toBe(2);
    expect(bodies).toEqual([JSON.stringify(body), JSON.stringify(body)]);
    expect(keys).toEqual(["stable-domain-key", "stable-domain-key"]);
  });

  it.each([
    ["missing retry", { "idempotent-replayed": "false" }],
    ["malformed retry", { "idempotent-replayed": "false", "retry-after": "0" }],
    ["wrong replay", { "idempotent-replayed": "true", "retry-after": "1" }],
  ])("does not retry an incomplete in-progress tuple: %s", async (_name, headers) => {
    const fetchImpl = mockFetch(
      () => new Response(JSON.stringify({ message: "in progress" }), { status: 409, headers }),
    );
    const executor = new OperationExecutor(
      makeClient(fetchImpl, { retry: { ...fastRetry, maxRetries: 2 } }),
    );

    await expect(
      executor.execute(
        "createDomain",
        { path: { account_id: ACCOUNT_ID }, body: { domain: "example.com" } },
        { idempotencyKey: "stable-domain-key" },
      ),
    ).rejects.toBeInstanceOf(AhaSendConflictError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("specializes eligible keyed headerless 422 without retrying", async () => {
    const fetchImpl = mockFetch(
      () => new Response(JSON.stringify({ message: "wording is irrelevant" }), { status: 422 }),
    );
    const executor = new OperationExecutor(
      makeClient(fetchImpl, { retry: { ...fastRetry, maxRetries: 2 } }),
    );

    await expect(
      executor.execute(
        "createDomain",
        { path: { account_id: ACCOUNT_ID }, body: { domain: "example.com" } },
        { idempotencyKey: "stable-domain-key" },
      ),
    ).rejects.toBeInstanceOf(AhaSendIdempotencyMismatchError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a replay header", { "idempotent-replayed": "true" }],
    ["a retry header", { "retry-after": "3" }],
  ])("keeps an eligible keyed 422 with %s generic", async (_name, headers) => {
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify({ message: "wording is irrelevant" }), {
          status: 422,
          headers,
        }),
    );
    const executor = new OperationExecutor(
      makeClient(fetchImpl, { retry: { ...fastRetry, maxRetries: 2 } }),
    );

    let captured: unknown;
    try {
      await executor.execute(
        "createDomain",
        { path: { account_id: ACCOUNT_ID }, body: { domain: "example.com" } },
        { idempotencyKey: "stable-domain-key" },
      );
    } catch (error) {
      captured = error;
    }

    expect(captured?.constructor).toBe(AhaSendUnprocessableEntityError);
    expect(captured).not.toBeInstanceOf(AhaSendIdempotencyMismatchError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves a stored deterministic 4xx replay status, body, and exact replay header", async () => {
    const responseBody = { message: "suppression already exists", marker: "stored-body" };
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify(responseBody), {
          status: 409,
          headers: { "idempotent-replayed": "true" },
        }),
    );
    const executor = new OperationExecutor(makeClient(fetchImpl));

    let captured: unknown;
    try {
      await executor.execute(
        "createSuppression",
        {
          path: { account_id: ACCOUNT_ID },
          body: { email: "person@example.com", expires_at: "2027-01-01T00:00:00Z" },
        },
        { idempotencyKey: "stored-suppression-key" },
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(AhaSendConflictError);
    expect(captured).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect(captured).toMatchObject({
      status: 409,
      body: responseBody,
      headers: { "idempotent-replayed": "true" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves a secret-create controller 4xx terminal for manual lease completion", async () => {
    const fetchImpl = mockFetch(
      () => new Response(JSON.stringify({ message: "invalid scope" }), { status: 400 }),
    );
    const executor = new OperationExecutor(
      makeClient(fetchImpl, { retry: { ...fastRetry, maxRetries: 2 } }),
    );

    await expect(
      executor.execute(
        "createAPIKey",
        { path: { account_id: ACCOUNT_ID }, body: { label: "key", scopes: ["invalid"] } },
        { idempotencyKey: "secret-create-key" },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
