import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  AhaSendPromise,
  AhaSendResponse,
  IdempotencyRequestOptions,
  NonEmptyArray,
  RequestOptions,
} from "../src/index.js";
import { resolveConfig } from "../src/config.js";
import {
  AhaSendAbortError,
  AhaSendAuthenticationError,
  AhaSendConflictError,
  AhaSendConnectionError,
  AhaSendIdempotencyConflictError,
  AhaSendIdempotencyMismatchError,
  AhaSendNotFoundError,
  AhaSendRateLimitError,
  AhaSendUnprocessableEntityError,
} from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { OperationExecutor } from "../src/operations.js";

type FetchImpl = typeof fetch;

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchImpl {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as FetchImpl;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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
      path: "/v2/accounts/acc_1/messages",
      query: { limit: 10, after: "cursor", skip_me: undefined, also_skip: null, tag: "welcome" },
    });

    expect(seenUrl).toContain("https://api.test/v2/accounts/acc_1/messages?");
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
      path: "/v2/accounts/acc_1/domains",
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

  it("blocks cross-origin redirects before owned headers can reach the target", async () => {
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const redirector = createServer((_request, response) => {
      const targetAddress = target.address() as AddressInfo;
      response.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/stolen` });
      response.end();
    });

    await Promise.all([listen(target), listen(redirector)]);
    try {
      const redirectAddress = redirector.address() as AddressInfo;
      const client = makeClient(globalThis.fetch, {
        baseUrl: `http://127.0.0.1:${redirectAddress.port}`,
        retry: { enabled: false },
      });

      await expect(
        client.request({
          method: "POST",
          path: "/redirect",
          body: { secret: true },
          idempotencyKey: "redirect-key",
        }),
      ).rejects.toBeInstanceOf(AhaSendConnectionError);
      expect(targetRequests).toBe(0);
    } finally {
      await Promise.all([close(target), close(redirector)]);
    }
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

describe("HttpClient — closing the four high-value P1 test gaps", () => {
  it("fires AhaSendTimeoutError when the configured timeout elapses", async () => {
    // Signal-aware mock: reject with AbortError when the SDK's timeout
    // fires, matching real `fetch` behaviour. Without this the mock
    // sits forever and the SDK timeout never gets a chance to surface.
    const client = makeClient(
      mockFetch(
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
      { timeoutMs: 30, retry: { enabled: false } },
    );
    const { AhaSendTimeoutError } = await import("../src/errors.js");
    await expect(client.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(
      AhaSendTimeoutError,
    );
  });

  it("AbortSignal cancels an in-flight request and wraps as AhaSendAbortError", async () => {
    const ctrl = new AbortController();
    const client = makeClient(
      mockFetch(
        () =>
          new Promise<Response>((_, reject) => {
            setTimeout(() => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            }, 10);
          }),
      ),
      { retry: { enabled: false } },
    );

    setTimeout(() => ctrl.abort(), 5);
    await expect(
      client.request({ method: "GET", path: "/x", signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(AhaSendAbortError);
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
  it("exports the shared promise, request-option, and non-empty-array types", () => {
    expectTypeOf<NonEmptyArray<string>>().toEqualTypeOf<readonly [string, ...string[]]>();
    expectTypeOf<IdempotencyRequestOptions>().toExtend<RequestOptions>();
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
      path: { account_id: "acc_1" },
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
        hooks: { onRetry: ({ delayMs }) => retryDelays.push(delayMs) },
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
        { path: { account_id: "acc_1" }, body },
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
        { path: { account_id: "acc_1" }, body: { domain: "example.com" } },
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
        { path: { account_id: "acc_1" }, body: { domain: "example.com" } },
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
        { path: { account_id: "acc_1" }, body: { domain: "example.com" } },
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
        { path: { account_id: "acc_1" }, body: { email: "person@example.com" } },
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
        { path: { account_id: "acc_1" }, body: { label: "key", scopes: ["invalid"] } },
        { idempotencyKey: "secret-create-key" },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
