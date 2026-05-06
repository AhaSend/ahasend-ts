import { describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
import { composeHooks, debugConsoleHooks, resolveTelemetryHooks } from "../src/telemetry.js";
import type { TelemetryHooks } from "../src/telemetry.js";

type FetchImpl = typeof fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchImpl {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as FetchImpl;
}

describe("resolveTelemetryHooks", () => {
  it("returns no-op handlers when no hooks are provided", () => {
    const hooks = resolveTelemetryHooks();
    expect(typeof hooks.onRequest).toBe("function");
    expect(typeof hooks.onResponse).toBe("function");
    expect(typeof hooks.onRetry).toBe("function");
    expect(typeof hooks.onError).toBe("function");
    // None should throw
    hooks.onRequest({ method: "GET", path: "/x", url: "/x", attempt: 1 });
    hooks.onResponse({ method: "GET", path: "/x", url: "/x", status: 200, durationMs: 1, attempt: 1 });
    hooks.onError({ method: "GET", path: "/x", url: "/x", attempt: 1, error: new Error("x") });
    hooks.onRetry({ method: "GET", path: "/x", url: "/x", attempt: 1, delayMs: 1, error: new Error("x") });
  });

  it("preserves provided callbacks", () => {
    const onRequest = vi.fn();
    const hooks = resolveTelemetryHooks({ onRequest });
    hooks.onRequest({ method: "GET", path: "/x", url: "/x", attempt: 1 });
    expect(onRequest).toHaveBeenCalledOnce();
  });
});

describe("composeHooks", () => {
  it("invokes every registered handler in order", () => {
    const a = vi.fn();
    const b = vi.fn();
    const composed = composeHooks({ onRequest: a }, { onRequest: b });
    composed.onRequest!({ method: "GET", path: "/x", url: "/x", attempt: 1 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("swallows errors thrown by hooks so the pipeline keeps running", () => {
    const noisy = vi.fn(() => {
      throw new Error("boom");
    });
    const quiet = vi.fn();
    const composed = composeHooks({ onRequest: noisy }, { onRequest: quiet });
    expect(() =>
      composed.onRequest!({ method: "GET", path: "/x", url: "/x", attempt: 1 }),
    ).not.toThrow();
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
      onRequest: (e) => events.push(`req ${e.method} ${e.path} attempt=${e.attempt}`),
      onResponse: (e) => events.push(`res ${e.status} attempt=${e.attempt}`),
    };

    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      hooks,
      fetch: mockFetch(() =>
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
    const hooks: TelemetryHooks = {
      onRequest: (e) => events.push(`req attempt=${e.attempt}`),
      onResponse: (e) => events.push(`res ${e.status}`),
      onRetry: (e) => events.push(`retry attempt=${e.attempt} delay=${e.delayMs}`),
      onError: (e) => events.push(`err`),
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
        if (attempts === 1) return new Response("err", { status: 503 });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    });

    await client.ping();
    expect(events[0]).toBe("req attempt=1");
    expect(events).toContain("err");
    expect(events.some((e) => e.startsWith("retry attempt=1"))).toBe(true);
    expect(events).toContain("req attempt=2");
    expect(events[events.length - 1]).toBe("res 200");
  });

  it("fires onError but not onRetry on a non-retryable 400", async () => {
    const events: string[] = [];
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      hooks: {
        onError: () => events.push("error"),
        onRetry: () => events.push("retry"),
      },
      retry: { baseDelayMs: 1, maxDelayMs: 5 },
      fetch: mockFetch(() => new Response("bad", { status: 400 })),
    });

    await expect(client.ping()).rejects.toThrow();
    expect(events).toEqual(["error"]);
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

    hooks.onRequest!({ method: "GET", path: "/x", url: "/x", attempt: 1 });
    hooks.onResponse!({
      method: "GET",
      path: "/x",
      url: "/x",
      status: 200,
      durationMs: 12,
      attempt: 1,
    });
    hooks.onError!({
      method: "GET",
      path: "/x",
      url: "/x",
      attempt: 1,
      error: new Error("boom"),
    });
    hooks.onRetry!({
      method: "GET",
      path: "/x",
      url: "/x",
      attempt: 1,
      delayMs: 100,
      error: new Error("boom"),
    });

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/-> GET \/x/);
    expect(lines[1]).toMatch(/<- GET \/x 200/);
    expect(lines[2]).toMatch(/!! GET \/x/);
    expect(lines[3]).toMatch(/\?\? GET \/x/);
  });
});
