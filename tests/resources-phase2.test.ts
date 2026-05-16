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

describe("WebhooksClient (account-scoped per spec)", () => {
  it("list() hits /v2/accounts/{id}/webhooks with event-filter query params", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.list({ limit: 25, enabled: true, on_delivered: true });
    expect(calls[0]!.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/webhooks");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("enabled")).toBe("true");
    expect(url.searchParams.get("on_delivered")).toBe("true");
  });

  it("create() POSTs the body and includes Idempotency-Key when provided", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.create(
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
    expect(call.url).toBe("https://api.test/v2/accounts/acc_1/webhooks");
    expect(call.body).toContain(`"name":"delivery hook"`);
    expect(call.headers["idempotency-key"]).toBe("wh-1");
  });

  it("update() PUTs to /webhooks/{id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.update("wh_42", { enabled: false });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/webhooks/wh_42");
  });

  it("delete() DELETEs /webhooks/{id}", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.delete("wh_42");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/webhooks/wh_42");
  });
});

describe("StatisticsClient", () => {
  it("deliverability() hits /transactional/deliverability with spec-named params", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.deliverability({
      from_time: "2026-04-01T00:00:00Z",
      to_time: "2026-04-30T00:00:00Z",
      group_by: "day",
      sender_domain: "example.com",
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(
      "/v2/accounts/acc_1/statistics/transactional/deliverability",
    );
    expect(url.searchParams.get("from_time")).toBe("2026-04-01T00:00:00Z");
    expect(url.searchParams.get("to_time")).toBe("2026-04-30T00:00:00Z");
    expect(url.searchParams.get("group_by")).toBe("day");
    expect(url.searchParams.get("sender_domain")).toBe("example.com");
  });

  it("bounces() hits /statistics/transactional/bounce (singular per spec)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.bounces({
      from_time: "2026-04-01T00:00:00Z",
      to_time: "2026-04-30T00:00:00Z",
    });
    expect(calls[0]!.url).toContain("/statistics/transactional/bounce");
    expect(calls[0]!.url).not.toContain("/bounces");
  });

  it("deliveryTimes() hits /statistics/transactional/delivery-time (singular)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.deliveryTimes({
      from_time: "2026-04-01T00:00:00Z",
      to_time: "2026-04-30T00:00:00Z",
    });
    expect(calls[0]!.url).toContain("/statistics/transactional/delivery-time");
    expect(calls[0]!.url).not.toContain("/delivery-times");
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

  it("delete() DELETEs /suppressions with email+domain query (per spec)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.delete({ email: "blocked@example.com", domain: "example.com" });
    expect(calls[0]!.method).toBe("DELETE");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/suppressions");
    expect(url.searchParams.get("email")).toBe("blocked@example.com");
    expect(url.searchParams.get("domain")).toBe("example.com");
  });

  it("wipe() DELETEs /suppressions/all (per spec — dangerous)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.wipe();
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/suppressions/all");
  });

  it("wipe({domain}) sends optional domain query param", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.wipe({ domain: "example.com" });
    expect(new URL(calls[0]!.url).searchParams.get("domain")).toBe("example.com");
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

  it("create() POSTs the route body (no `domain` field — per spec)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.routes.create({
      name: "Inbound replies",
      url: "https://hooks.example/inbound",
      recipient: "support@example.com",
      attachments: true,
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toContain(`"recipient":"support@example.com"`);
    expect(calls[0]!.body).toContain(`"attachments":true`);
    expect(calls[0]!.body).not.toContain(`"domain"`);
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

  it("listMembers() hits /members (spec does not document pagination params)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.listMembers();
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/members");
    // Spec exposes no query params; SDK must not append them.
    expect(url.search).toBe("");
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
