import { describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";

type FetchImpl = typeof fetch;

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

function captureFetch(): { fetch: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      else if (Array.isArray(h)) for (const [k, v] of h) headers[k.toLowerCase()] = v;
      else for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v as string;
    }
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : undefined,
      headers,
    });
    return new Response(JSON.stringify({ object: "message", id: "msg_1" }), {
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
  });
}

describe("MessagesClient", () => {
  it("send() POSTs /v2/accounts/{account_id}/messages with the request body", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.messages.send({
      from: { email: "a@b.com" },
      recipients: [{ email: "x@y.com" }],
      subject: "hi",
      text_content: "hi",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.test/v2/accounts/acc_1/messages");
    expect(call.body).toContain(`"recipients":[{"email":"x@y.com"}]`);
  });

  it("sendConversation() hits /messages/conversation", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.messages.sendConversation({
      from: { email: "a@b.com" },
      to: [{ email: "x@y.com" }],
      subject: "hi",
      text_content: "hi",
    });

    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/messages/conversation");
  });

  it("list() GETs /messages with query params", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.messages.list({ limit: 25, status: "queued" });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/messages");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("status")).toBe("queued");
  });

  it("get() GETs a single message", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.messages.get("msg_42");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/messages/msg_42");
  });

  it("cancel() DELETEs /{id}/cancel (per spec)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.messages.cancel("msg_42");

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/messages/msg_42/cancel");
  });
});

describe("DomainsClient", () => {
  it("create() passes Idempotency-Key header when provided", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.create({ domain: "example.com" }, { idempotencyKey: "key-1" });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains");
    expect(calls[0]!.headers["idempotency-key"]).toBe("key-1");
  });

  it("update() PUTs /domains/{domain}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.update("example.com", { tracking_subdomain: "track" });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains/example.com");
  });

  it("delete() DELETEs /domains/{domain}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.delete("example.com");

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains/example.com");
  });

  it("checkDns() POSTs /domains/{domain}/check-dns", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.checkDns("example.com");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains/example.com/check-dns");
  });

  it("list() passes dns_valid filter", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.list({ dns_valid: true, limit: 50 });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("dns_valid")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("50");
  });
});

describe("APIKeysClient", () => {
  it("create() posts label + scopes and supports idempotencyKey", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.apiKeys.create(
      { label: "ci", scopes: ["messages:send:all"] },
      { idempotencyKey: "key-2" },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/api-keys");
    expect(calls[0]!.body).toBe(
      JSON.stringify({ label: "ci", scopes: ["messages:send:all"] }),
    );
    expect(calls[0]!.headers["idempotency-key"]).toBe("key-2");
  });

  it("update() PUTs /api-keys/{key_id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.apiKeys.update("key_1", { label: "renamed" });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/api-keys/key_1");
  });
});
