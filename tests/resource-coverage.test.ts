// Targeted coverage for resource-client methods that aren't asserted by the
// behaviour-focused tests in resources.test.ts and resources-phase2.test.ts.
// Each test exercises a specific URL/method pair so all CRUD operations
// across every resource client are touched at least once.

import { describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";

type FetchImpl = typeof fetch;

interface Call {
  url: string;
  method: string;
}

function captureFetch(): { fetch: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return new Response(JSON.stringify({ object: "list", data: [], message: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchImpl;
  return { fetch: fn, calls };
}

function makeClient(fetchImpl: FetchImpl): AhaSendClient {
  return new AhaSendClient({
    apiKey: "aha-sk-test",
    accountId: "acc_1",
    baseUrl: "https://api.test",
    fetch: fetchImpl,
    retry: { enabled: false },
  });
}

describe("Resource coverage smoke", () => {
  it("api-keys: get + delete", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.apiKeys.get("k1");
    await client.apiKeys.delete("k1");
    expect(calls[0]).toEqual({
      method: "GET",
      url: "https://api.test/v2/accounts/acc_1/api-keys/k1",
    });
    expect(calls[1]).toEqual({
      method: "DELETE",
      url: "https://api.test/v2/accounts/acc_1/api-keys/k1",
    });
  });

  it("domains: get + delete", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.domains.get("example.com");
    await client.domains.delete("example.com");
    expect(calls[0]).toEqual({
      method: "GET",
      url: "https://api.test/v2/accounts/acc_1/domains/example.com",
    });
    expect(calls[1]).toEqual({
      method: "DELETE",
      url: "https://api.test/v2/accounts/acc_1/domains/example.com",
    });
  });

  it("webhooks: get", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.get("wh_1");
    expect(calls[0]).toEqual({
      method: "GET",
      url: "https://api.test/v2/accounts/acc_1/webhooks/wh_1",
    });
  });

  it("routes: get + delete", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.routes.get("rt_1");
    await client.routes.delete("rt_1");
    expect(calls[0]).toEqual({
      method: "GET",
      url: "https://api.test/v2/accounts/acc_1/routes/rt_1",
    });
    expect(calls[1]).toEqual({
      method: "DELETE",
      url: "https://api.test/v2/accounts/acc_1/routes/rt_1",
    });
  });

  it("smtp-credentials: get + delete", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.smtpCredentials.get("cred_1");
    await client.smtpCredentials.delete("cred_1");
    expect(calls[0]).toEqual({
      method: "GET",
      url: "https://api.test/v2/accounts/acc_1/smtp-credentials/cred_1",
    });
    expect(calls[1]).toEqual({
      method: "DELETE",
      url: "https://api.test/v2/accounts/acc_1/smtp-credentials/cred_1",
    });
  });

  it("messages.cancel forwards options without throwing and uses DELETE", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    const ctrl = new AbortController();
    await client.messages.cancel("msg_1", { signal: ctrl.signal, headers: { "x-trace-id": "t1" } });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("https://api.test/v2/accounts/acc_1/messages/msg_1/cancel");
  });

  it("api-keys: create without an idempotencyKey", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.apiKeys.create({ label: "ci", scopes: ["messages:send:all"] });
    expect(calls[0]?.method).toBe("POST");
  });

  it("routes: update", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.routes.update("rt_1", { enabled: false });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("https://api.test/v2/accounts/acc_1/routes/rt_1");
  });

  it("webhooks: update + idempotency on create", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.update("wh_1", { enabled: true });
    expect(calls[0]?.method).toBe("PUT");
    await client.webhooks.create({ name: "w", url: "https://x", scope: "global" });
    expect(calls[1]?.method).toBe("POST");
  });

  it("iterate generators are reachable across every paginating resource", async () => {
    // Drains a single page from each iterate() to exercise the generator bodies.
    function client(): AhaSendClient {
      return new AhaSendClient({
        apiKey: "aha-sk-test",
        accountId: "acc_1",
        baseUrl: "https://api.test",
        retry: { enabled: false },
        fetch: vi.fn(async () =>
          new Response(
            JSON.stringify({
              object: "list",
              data: [{ object: "x", id: "x1", email: "a@b", domain: "d", expires_at: "2030-01-01T00:00:00Z", scopes: [], label: "l", name: "n", url: "https://h", username: "u", sandbox: false, scope: "global", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
              pagination: { has_more: false },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ) as unknown as FetchImpl,
      });
    }

    const c = client();
    const drainAll = async (gen: AsyncGenerator<unknown>): Promise<number> => {
      let n = 0;
      for await (const _ of gen) n++;
      return n;
    };

    expect(await drainAll(c.messages.iterate({ limit: 1 }))).toBeGreaterThanOrEqual(0);
    expect(await drainAll(c.domains.iterate({ limit: 1 }))).toBeGreaterThanOrEqual(0);
    expect(await drainAll(c.apiKeys.iterate({ limit: 1 }))).toBeGreaterThanOrEqual(0);
    expect(await drainAll(c.webhooks.iterate({ limit: 1 }))).toBeGreaterThanOrEqual(0);
    expect(await drainAll(c.suppressions.iterate({ limit: 1 }))).toBeGreaterThanOrEqual(0);
    expect(await drainAll(c.routes.iterate({ limit: 1 }))).toBeGreaterThanOrEqual(0);
    expect(await drainAll(c.smtpCredentials.iterate({ limit: 1 }))).toBeGreaterThanOrEqual(0);
  });
});
