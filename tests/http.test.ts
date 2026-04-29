import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  AhaSendAuthenticationError,
  AhaSendConnectionError,
  AhaSendNotFoundError,
} from "../src/errors.js";
import { HttpClient } from "../src/http.js";

type FetchImpl = typeof fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchImpl {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as FetchImpl;
}

function makeClient(fetchImpl: FetchImpl): HttpClient {
  return new HttpClient(
    resolveConfig({ apiKey: "aha-sk-test", fetch: fetchImpl, baseUrl: "https://api.test" }),
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

  it("passes through custom headers with lowercase keys", async () => {
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
      headers: { "Idempotency-Key": "key-1" },
    });

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("key-1");
  });

  it("maps non-2xx responses to typed errors", async () => {
    const client = makeClient(
      mockFetch(() =>
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
      mockFetch(() =>
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
    );

    await expect(client.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(
      AhaSendConnectionError,
    );
  });
});
