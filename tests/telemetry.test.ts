import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
import { composeHooks, debugConsoleHooks, resolveTelemetryHooks } from "../src/telemetry.js";
import type {
  ErrorEvent,
  RequestEvent,
  ResponseEvent,
  RetryEvent,
  TelemetryHooks,
} from "../src/telemetry.js";

type FetchImpl = typeof fetch;

const REQUEST_EVENT = {
  operationId: "ping" as const,
  method: "GET",
  routeTemplate: "/v2/ping",
  attempt: 1,
};

const ERROR = new Error("x");

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchImpl {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as FetchImpl;
}

describe("resolveTelemetryHooks", () => {
  it("types every public callback as synchronous or asynchronous", () => {
    expectTypeOf<
      NonNullable<TelemetryHooks["onRequest"]>
    >().returns.toEqualTypeOf<void | Promise<void>>();
    expectTypeOf<
      NonNullable<TelemetryHooks["onResponse"]>
    >().returns.toEqualTypeOf<void | Promise<void>>();
    expectTypeOf<
      NonNullable<TelemetryHooks["onRetry"]>
    >().returns.toEqualTypeOf<void | Promise<void>>();
    expectTypeOf<
      NonNullable<TelemetryHooks["onError"]>
    >().returns.toEqualTypeOf<void | Promise<void>>();
  });

  it("returns no-op handlers when no hooks are provided", () => {
    const hooks = resolveTelemetryHooks();
    expect(typeof hooks.onRequest).toBe("function");
    expect(typeof hooks.onResponse).toBe("function");
    expect(typeof hooks.onRetry).toBe("function");
    expect(typeof hooks.onError).toBe("function");
    // None should throw
    hooks.onRequest(REQUEST_EVENT);
    hooks.onResponse({ ...REQUEST_EVENT, status: 200, durationMs: 1 });
    hooks.onError({ ...REQUEST_EVENT, durationMs: 1, error: ERROR });
    hooks.onRetry({ ...REQUEST_EVENT, durationMs: 1, delayMs: 1, error: ERROR });
  });

  it("executes resolved async callbacks asynchronously", async () => {
    let completed = false;
    const onRequest = vi.fn(async () => {
      await Promise.resolve();
      completed = true;
    });
    const hooks = resolveTelemetryHooks({ onRequest });
    hooks.onRequest(REQUEST_EVENT);
    expect(onRequest).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onRequest).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(completed).toBe(true);
  });

  it("snapshots callbacks instead of re-reading a mutable hook container", async () => {
    const onRequest = vi.fn();
    const configured: TelemetryHooks = { onRequest };
    const hooks = resolveTelemetryHooks(configured);
    Object.defineProperty(configured, "onRequest", {
      get: () => {
        throw new Error("hook container was re-read");
      },
    });

    expect(() => hooks.onRequest(REQUEST_EVENT)).not.toThrow();
    await Promise.resolve();
    expect(onRequest).toHaveBeenCalledOnce();
  });
});

describe("composeHooks", () => {
  it("invokes every registered handler in order", () => {
    const a = vi.fn();
    const b = vi.fn();
    const composed = composeHooks({ onRequest: a }, { onRequest: b });
    composed.onRequest!(REQUEST_EVENT);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("snapshots registered handlers before composing them", () => {
    const onRequest = vi.fn();
    const configured: TelemetryHooks = { onRequest };
    const composed = composeHooks(configured);
    Object.defineProperty(configured, "onRequest", {
      get: () => {
        throw new Error("composed hook container was re-read");
      },
    });

    expect(() => composed.onRequest!(REQUEST_EVENT)).not.toThrow();
    expect(onRequest).toHaveBeenCalledOnce();
  });

  it("swallows errors thrown by hooks so the pipeline keeps running", () => {
    const noisy = vi.fn(() => {
      throw new Error("boom");
    });
    const quiet = vi.fn();
    const composed = composeHooks({ onRequest: noisy }, { onRequest: quiet });
    expect(() => composed.onRequest!(REQUEST_EVENT)).not.toThrow();
    expect(quiet).toHaveBeenCalledOnce();
  });

  it("observes rejected async handlers without an unhandled rejection", async () => {
    const quiet = vi.fn();
    const composed = composeHooks(
      { onRequest: async () => Promise.reject(new Error("boom")) },
      { onRequest: quiet },
    );

    composed.onRequest!(REQUEST_EVENT);
    await Promise.resolve();
    expect(quiet).toHaveBeenCalledOnce();
  });

  it("returns an empty hookset when nothing is provided", () => {
    expect(composeHooks()).toEqual({});
    expect(composeHooks(undefined, undefined)).toEqual({});
  });
});

describe("HttpClient telemetry integration", () => {
  it("fires onRequest then onResponse on a successful call", async () => {
    const events: string[] = [];
    const hooks: TelemetryHooks = {
      onRequest: (e) => {
        events.push(`req ${e.method} ${e.routeTemplate} attempt=${e.attempt}`);
      },
      onResponse: (e) => {
        events.push(`res ${e.status} attempt=${e.attempt}`);
      },
    };

    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      hooks,
      fetch: mockFetch(
        () =>
          new Response(JSON.stringify({ message: "pong" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    await client.ping();
    expect(events).toEqual(["req GET /v2/ping attempt=1", "res 200 attempt=1"]);
  });

  it("fires onError, onRetry, then onResponse when a 503 is retried successfully", async () => {
    const events: string[] = [];
    const errors: ErrorEvent[] = [];
    const retries: RetryEvent[] = [];
    const hooks: TelemetryHooks = {
      onRequest: (e) => {
        events.push(`req attempt=${e.attempt}`);
      },
      onResponse: (e) => {
        events.push(`res ${e.status}`);
      },
      onRetry: (e) => {
        retries.push(e);
        events.push(`retry attempt=${e.attempt} delay=${e.delayMs}`);
      },
      onError: (e) => {
        errors.push(e);
        events.push(`err`);
      },
    };

    let attempts = 0;
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      hooks,
      retry: { baseDelayMs: 1, maxDelayMs: 5, jitter: false, maxRetries: 1 },
      fetch: mockFetch(() => {
        attempts++;
        if (attempts === 1) {
          return new Response("err", {
            status: 503,
            headers: { "x-request-id": "req_retry" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    });

    await client.ping();
    expect(events[0]).toBe("req attempt=1");
    expect(events).toContain("res 503");
    expect(events).toContain("err");
    expect(events.some((e) => e.startsWith("retry attempt=1"))).toBe(true);
    expect(events).toContain("req attempt=2");
    expect(events[events.length - 1]).toBe("res 200");
    expect(errors[0]).toMatchObject({
      operationId: "ping",
      method: "GET",
      routeTemplate: "/v2/ping",
      attempt: 1,
      status: 503,
      requestId: "req_retry",
    });
    expect(errors[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(retries[0]).toMatchObject({
      operationId: "ping",
      method: "GET",
      routeTemplate: "/v2/ping",
      attempt: 1,
      status: 503,
      requestId: "req_retry",
    });
    expect(retries[0]!.durationMs).toBe(errors[0]!.durationMs);
  });

  it("fires onError but not onRetry on a non-retryable 400", async () => {
    const events: string[] = [];
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      hooks: {
        onError: () => {
          events.push("error");
        },
        onRetry: () => {
          events.push("retry");
        },
      },
      retry: { baseDelayMs: 1, maxDelayMs: 5 },
      fetch: mockFetch(() => new Response("bad", { status: 400 })),
    });

    await expect(client.ping()).rejects.toThrow();
    expect(events).toEqual(["error"]);
  });

  it("does not await pending hooks or let rejected hooks replace the API result", async () => {
    const pending = new Promise<void>(() => {});
    const rejected = async (): Promise<void> => Promise.reject(new Error("telemetry failed"));
    let attempts = 0;
    const fetch = mockFetch(() => {
      attempts++;
      if (attempts === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ message: "pong" }), { status: 200 });
    });
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      retry: { baseDelayMs: 1, maxDelayMs: 1, jitter: false, maxRetries: 1 },
      hooks: {
        onRequest: () => pending,
        onResponse: rejected,
        onError: rejected,
        onRetry: rejected,
      },
      fetch,
    });

    await expect(client.ping()).resolves.toEqual({ message: "pong" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the original API error when an async error hook rejects", async () => {
    const fetch = mockFetch(
      () =>
        new Response(JSON.stringify({ message: "invalid" }), {
          status: 400,
          headers: { "x-request-id": "req_bad" },
        }),
    );
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      hooks: {
        onError: async () => Promise.reject(new Error("telemetry failed")),
      },
      fetch,
    });

    await expect(client.ping()).rejects.toMatchObject({ status: 400, requestId: "req_bad" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not re-read mutable hook properties while executing requests", async () => {
    const observedRequest = vi.fn();
    const observedError = vi.fn();
    const hooks: TelemetryHooks = {
      onRequest: observedRequest,
      onError: observedError,
    };
    const fetch = mockFetch(
      () =>
        new Response(JSON.stringify({ message: "invalid" }), {
          status: 400,
          headers: { "x-request-id": "req_original" },
        }),
    );
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      hooks,
      fetch,
    });

    for (const name of ["onRequest", "onError"] as const) {
      Object.defineProperty(hooks, name, {
        get: () => {
          throw new Error(`${name} was re-read`);
        },
      });
    }

    await expect(client.ping()).rejects.toMatchObject({
      status: 400,
      requestId: "req_original",
    });
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    expect(observedRequest).toHaveBeenCalledOnce();
    expect(observedError).toHaveBeenCalledOnce();
  });

  it("reports generated operation facts and measures through response parsing", async () => {
    vi.useFakeTimers();
    try {
      let resolveBody!: (body: string) => void;
      const body = new Promise<string>((resolve) => {
        resolveBody = resolve;
      });
      const response = new Response(null, {
        status: 200,
        headers: { "x-request-id": "req_123" },
      });
      const readBody = vi.spyOn(response, "text").mockImplementation(() => body);
      let requestedUrl = "";
      const requests: RequestEvent[] = [];
      const responses: ResponseEvent[] = [];
      const client = new AhaSendClient({
        apiKey: "aha-sk-test",
        accountId: "acc_1",
        baseUrl: "https://api.test",
        hooks: {
          onRequest: (event) => {
            requests.push(event);
          },
          onResponse: (event) => {
            responses.push(event);
          },
        },
        fetch: mockFetch((url) => {
          requestedUrl = url;
          return response;
        }),
      });

      const result = client.messages.list({ limit: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(readBody).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(37);
      resolveBody("{}");
      await result;
      await Promise.resolve();

      expect(requestedUrl).toContain("?limit=1");
      expect(requests).toEqual([
        {
          operationId: "getMessages",
          method: "GET",
          routeTemplate: "/v2/accounts/{account_id}/messages",
          attempt: 1,
        },
      ]);
      expect(responses).toEqual([
        {
          operationId: "getMessages",
          method: "GET",
          routeTemplate: "/v2/accounts/{account_id}/messages",
          attempt: 1,
          status: 200,
          requestId: "req_123",
          durationMs: 37,
        },
      ]);
      expect(requests[0]).not.toHaveProperty("url");
      expect(responses[0]).not.toHaveProperty("url");
      expect(requests[0]).not.toHaveProperty("path");
    } finally {
      vi.useRealTimers();
    }
  });

  it("debug=true attaches a console-based hookset on top of user hooks", async () => {
    const lines: string[] = [];
    const userHook = vi.fn();

    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      debug: true,
      hooks: { onRequest: userHook },
      fetch: mockFetch(() => new Response("{}", { status: 200 })),
    });

    // Replace console.error temporarily to capture debug output
    const origError = console.error;
    console.error = (msg: string) => lines.push(String(msg));
    try {
      await client.ping();
    } finally {
      console.error = origError;
    }

    expect(userHook).toHaveBeenCalled();
    expect(lines.some((line) => line.startsWith("[ahasend]"))).toBe(true);
  });
});

describe("debugConsoleHooks", () => {
  it("captures request/response/error/retry into the provided sink", () => {
    const lines: string[] = [];
    const hooks = debugConsoleHooks((m) => lines.push(m));

    hooks.onRequest!(REQUEST_EVENT);
    hooks.onResponse!({
      ...REQUEST_EVENT,
      status: 200,
      durationMs: 12,
    });
    hooks.onError!({
      ...REQUEST_EVENT,
      durationMs: 12,
      error: new Error("boom"),
    });
    hooks.onRetry!({
      ...REQUEST_EVENT,
      delayMs: 100,
      durationMs: 12,
      error: new Error("boom"),
    });

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/-> GET \/v2\/ping/);
    expect(lines[1]).toMatch(/<- GET \/v2\/ping 200/);
    expect(lines[2]).toMatch(/!! GET \/v2\/ping/);
    expect(lines[3]).toMatch(/\?\? GET \/v2\/ping/);
  });
});
