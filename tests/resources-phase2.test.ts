import { describe, expect, expectTypeOf, it } from "vitest";
import type { ListRoutesParams } from "../src/resources/routes.js";
import type { ListSuppressionsParams } from "../src/resources/suppressions.js";
import type {
  CreatedWebhook,
  CreateWebhookRequest,
  ListWebhooksParams,
  UpdateWebhookRequest,
  Webhook,
} from "../src/resources/webhooks.js";
import { captureFetch, makeClient } from "./helpers/resource-call.js";

describe("Filtered pagination parameter declarations", () => {
  it("retains each resource filter alongside limit and one cursor", () => {
    const webhooks: ListWebhooksParams = { limit: 25, after: "next", enabled: true };
    const suppressions: ListSuppressionsParams = {
      limit: 50,
      before: "previous",
      domain: "example.com",
    };
    const routes: ListRoutesParams = { limit: 10, after: "next", domain: "example.com" };

    expect(webhooks.enabled).toBe(true);
    expect(suppressions.domain).toBe("example.com");
    expect(routes.domain).toBe("example.com");
  });
});

describe("WebhooksClient (account-scoped per spec)", () => {
  it("models scoped/global creates, partial updates, and required response fields", () => {
    const globalOmitted: CreateWebhookRequest = {
      name: "global omitted",
      url: "https://hooks.example/omitted",
      scope: "global",
    };
    const globalNull: CreateWebhookRequest = {
      name: "global null",
      url: "https://hooks.example/null",
      scope: "global",
      domains: null,
    };
    const globalEmpty: CreateWebhookRequest = {
      name: "global empty",
      url: "https://hooks.example/empty",
      scope: "global",
      domains: [] as const,
    };
    const globalDomains: CreateWebhookRequest = {
      name: "global domains",
      url: "https://hooks.example/domains",
      scope: "global",
      domains: ["ignored.example"] as const,
    };
    const scoped: CreateWebhookRequest = {
      name: "scoped",
      url: "https://hooks.example/scoped",
      scope: "scoped",
      domains: ["example.com"] as const,
    };
    // @ts-expect-error Scoped creates require at least one domain.
    const emptyScoped: CreateWebhookRequest = {
      name: "empty scoped",
      url: "https://hooks.example/empty-scoped",
      scope: "scoped",
      domains: [],
    };
    const requestWithSecret: CreateWebhookRequest = {
      name: "selected secret",
      url: "https://hooks.example/secret",
      scope: "global",
      // @ts-expect-error The server selects and returns the signing secret.
      secret: "client-selected",
    };
    if (false) {
      // @ts-expect-error Scoped create domains are readonly.
      scoped.domains.push("another.example");
    }

    const preserve: UpdateWebhookRequest = {
      name: null,
      url: null,
      enabled: null,
      scope: null,
      domains: null,
    };
    const clear: UpdateWebhookRequest = { domains: [] as const };
    const webhook: Webhook = {
      object: "webhook",
      id: "wh_1",
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      name: "Delivery hook",
      url: "https://hooks.example/aha",
      enabled: true,
      on_reception: false,
      on_delivered: true,
      on_transient_error: false,
      on_failed: false,
      on_bounced: false,
      on_suppressed: false,
      on_opened: false,
      on_clicked: false,
      on_suppression_created: false,
      on_dns_error: false,
      scope: "global",
      domains: [],
      success_count: 1,
      error_count: 0,
      errors_since_last_success: 0,
      last_request_at: null,
    };
    const created: CreatedWebhook = { ...webhook, secret: "whsec_created" };
    const { domains: _domains, ...withoutDomains } = webhook;
    // @ts-expect-error Response domains are required.
    const missingDomains: Webhook = withoutDomains;
    // @ts-expect-error The base webhook response never exposes the signing secret.
    const hiddenSecret = webhook.secret;

    expectTypeOf<Webhook["domains"]>().toEqualTypeOf<string[]>();
    expectTypeOf<Webhook["last_request_at"]>().toEqualTypeOf<string | null>();
    expectTypeOf<CreatedWebhook["secret"]>().toEqualTypeOf<string>();
    expect([globalOmitted, globalNull, globalEmpty, globalDomains, scoped]).toHaveLength(5);
    expect(preserve).toMatchObject({ name: null, scope: null, domains: null });
    expect(clear.domains).toEqual([]);
    expect(created).toMatchObject({ domains: [], secret: "whsec_created" });
    void [emptyScoped, requestWithSecret, missingDomains, hiddenSecret, _domains];
  });

  it("list() hits /v2/accounts/{id}/webhooks with event-filter query params", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.webhooks.list({
      limit: 25,
      after: "next",
      enabled: true,
      on_delivered: true,
    });
    expect(calls[0]!.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/webhooks");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("after")).toBe("next");
    expect(url.searchParams.has("before")).toBe(false);
    expect(url.searchParams.get("enabled")).toBe("true");
    expect(url.searchParams.get("on_delivered")).toBe("true");
    expect(calls[0]!.operationId).toBe("getWebhooks");
  });

  it("iterate() fetches configured webhooks through getWebhooks", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "webhook", id: "wh_1", domains: [] }],
            pagination: { has_more: false },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);
    const webhooks = client.webhooks.iterate({ enabled: true, limit: 25 });

    await expect(webhooks.next()).resolves.toMatchObject({
      done: false,
      value: { id: "wh_1", domains: [] },
    });
    await expect(webhooks.next()).resolves.toEqual({ done: true, value: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operationId).toBe("getWebhooks");
  });

  it("create() dispatches createWebhook and returns its one-time secret", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ domains: [], secret: "whsec_created" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = makeClient(fetch);
    const created = await client.webhooks.create(
      {
        name: "delivery hook",
        url: "https://hooks.example/aha",
        scope: "global",
        domains: ["ignored.example"],
        on_delivered: true,
      },
      { idempotencyKey: "wh-1" },
    );
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.test/v2/accounts/acc_1/webhooks");
    expect(JSON.parse(call.body!)).toEqual({
      name: "delivery hook",
      url: "https://hooks.example/aha",
      scope: "global",
      domains: ["ignored.example"],
      on_delivered: true,
    });
    expect(call.headers["idempotency-key"]).toBe("wh-1");
    expect(call.operationId).toBe("createWebhook");
    expect(created).toEqual({ domains: [], secret: "whsec_created" });
  });

  it("get() dispatches getWebhook and encodes the webhook ID", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.webhooks.get("wh/42");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/webhooks/wh%2F42");
    expect(calls[0]!.operationId).toBe("getWebhook");
  });

  it("update() dispatches updateWebhook and preserves null or sends an empty domain list", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.webhooks.update("wh/42", { name: null, scope: null, domains: null });
    await client.webhooks.update("wh/42", { domains: [] });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/webhooks/wh%2F42");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: null, scope: null, domains: null });
    expect(calls[0]!.operationId).toBe("updateWebhook");
    expect(JSON.parse(calls[1]!.body!)).toEqual({ domains: [] });
    expect(calls[1]!.operationId).toBe("updateWebhook");
  });

  it("delete() dispatches deleteWebhook", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.webhooks.delete("wh/42");

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/webhooks/wh%2F42");
    expect(calls[0]!.operationId).toBe("deleteWebhook");
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
    await client.suppressions.list({
      limit: 50,
      before: "previous",
      domain: "example.com",
    });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v2/accounts/acc_1/suppressions?");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
    expect(url.searchParams.get("domain")).toBe("example.com");
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
    await client.routes.list({ domain: "example.com", limit: 10, after: "next" });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("domain")).toBe("example.com");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("after")).toBe("next");
    expect(url.searchParams.has("before")).toBe(false);
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
