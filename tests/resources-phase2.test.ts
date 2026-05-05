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
    return new Response(JSON.stringify({ object: "list", data: [] }), {
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

describe("WebhooksClient (domain-scoped)", () => {
  it("list() hits /domains/{domain}/webhooks", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.list("example.com", { limit: 25 });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v2/accounts/acc_1/domains/example.com/webhooks?");
    expect(calls[0]!.url).toContain("limit=25");
  });

  it("create() POSTs the body and includes Idempotency-Key when provided", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.create(
      "example.com",
      {
        name: "delivery hook",
        url: "https://hooks.example/aha",
        scope: "global",
        on_delivered: true,
      },
      { idempotencyKey: "wh-1" },
    );
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.test/v2/accounts/acc_1/domains/example.com/webhooks");
    expect(call.body).toContain(`"name":"delivery hook"`);
    expect(call.headers["idempotency-key"]).toBe("wh-1");
  });

  it("update() PUTs to /webhooks/{id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.update("example.com", "wh_42", { enabled: false });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(
      "https://api.test/v2/accounts/acc_1/domains/example.com/webhooks/wh_42",
    );
  });

  it("delete() DELETEs", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.delete("example.com", "wh_42");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://api.test/v2/accounts/acc_1/domains/example.com/webhooks/wh_42",
    );
  });
});

describe("StatisticsClient", () => {
  it("deliverability() hits /statistics/transactional/deliverability with from/to/granularity", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.deliverability({
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-30T00:00:00Z",
      granularity: "day",
      domain: "example.com",
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(
      "/v2/accounts/acc_1/statistics/transactional/deliverability",
    );
    expect(url.searchParams.get("from")).toBe("2026-04-01T00:00:00Z");
    expect(url.searchParams.get("to")).toBe("2026-04-30T00:00:00Z");
    expect(url.searchParams.get("granularity")).toBe("day");
    expect(url.searchParams.get("domain")).toBe("example.com");
  });

  it("bounces() hits /statistics/transactional/bounces", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.bounces({
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-30T00:00:00Z",
    });
    expect(calls[0]!.url).toContain("/statistics/transactional/bounces");
  });

  it("deliveryTimes() hits /statistics/transactional/delivery-times", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.deliveryTimes({
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-30T00:00:00Z",
    });
    expect(calls[0]!.url).toContain("/statistics/transactional/delivery-times");
  });
});

describe("SuppressionsClient", () => {
  it("list() GETs /suppressions with pagination", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.list({ limit: 50 });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v2/accounts/acc_1/suppressions?");
    expect(calls[0]!.url).toContain("limit=50");
  });

  it("create() POSTs body", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.create({
      email: "blocked@example.com",
      reason: "manual",
      expires_at: "2027-01-01T00:00:00Z",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toContain(`"email":"blocked@example.com"`);
  });

  it("delete() targets /suppressions/{id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.delete("sup_1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/suppressions/sup_1");
  });

  it("wipe() POSTs to /suppressions/wipe (dangerous)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.wipe();
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/suppressions/wipe");
  });
});

describe("RoutesClient", () => {
  it("list() supports a domain filter", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.routes.list({ domain: "example.com", limit: 10 });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("domain")).toBe("example.com");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("create() POSTs the route body", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.routes.create({
      name: "Inbound replies",
      url: "https://hooks.example/inbound",
      domain: "example.com",
      recipient: "support@example.com",
      attachments: true,
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toContain(`"recipient":"support@example.com"`);
    expect(calls[0]!.body).toContain(`"attachments":true`);
  });

  it("update() PUTs to /routes/{id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.routes.update("rt_1", { enabled: false });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/routes/rt_1");
  });
});

describe("AccountsClient", () => {
  it("get() hits /accounts/{id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.get();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1");
  });

  it("update() PUTs to /accounts/{id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.update({ name: "New Name" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toBe(`{"name":"New Name"}`);
  });

  it("listMembers() hits /members with pagination", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.listMembers({ limit: 5 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/members");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("addMember() POSTs and supports Idempotency-Key", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.addMember(
      { email: "new@example.com", role: "Developer" },
      { idempotencyKey: "mem-1" },
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["idempotency-key"]).toBe("mem-1");
  });

  it("removeMember() DELETEs the user", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.removeMember("usr_42");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/members/usr_42");
  });
});

describe("SMTPCredentialsClient", () => {
  it("list() hits /smtp-credentials", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.smtpCredentials.list();
    expect(calls[0]!.url).toContain("/v2/accounts/acc_1/smtp-credentials");
  });

  it("create() POSTs body", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.smtpCredentials.create({ name: "ci-cred", scope: "global" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toContain(`"scope":"global"`);
  });

  it("delete() targets /smtp-credentials/{id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.smtpCredentials.delete("cred_1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://api.test/v2/accounts/acc_1/smtp-credentials/cred_1",
    );
  });
});

describe("AhaSendClient surface", () => {
  it("exposes all 9 resource clients + ping", () => {
    const client = makeClient(captureFetch().fetch);
    expect(client.messages).toBeDefined();
    expect(client.domains).toBeDefined();
    expect(client.apiKeys).toBeDefined();
    expect(client.webhooks).toBeDefined();
    expect(client.statistics).toBeDefined();
    expect(client.suppressions).toBeDefined();
    expect(client.routes).toBeDefined();
    expect(client.accounts).toBeDefined();
    expect(client.smtpCredentials).toBeDefined();
    expect(typeof client.ping).toBe("function");
  });
});
