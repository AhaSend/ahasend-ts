import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BatchUpsertContactInput,
  Contact,
  ContactJSONValue,
  CreateContactRequest,
  ListContactsParams,
  UpdateContactRequest,
} from "../src/resources/contacts.js";
import type {
  CreatedRoute,
  CreateRouteRequest,
  ListRoutesParams,
  Route,
} from "../src/resources/routes.js";
import type {
  BounceClassificationCount,
  DeliverabilityStatistics,
  DeliveryTimeStatistics,
} from "../src/resources/statistics.js";
import type { ListSuppressionsParams, Suppression } from "../src/resources/suppressions.js";
import type {
  CreatedWebhook,
  CreateWebhookRequest,
  ListWebhooksParams,
  UpdateWebhookRequest,
  Webhook,
} from "../src/resources/webhooks.js";
import {
  ACCOUNT_ID,
  captureFetch,
  makeClient,
  ROUTE_ID,
  SMTP_CREDENTIAL_ID,
  USER_ID,
  WEBHOOK_ID,
} from "./helpers/resource-call.js";

describe("Filtered pagination parameter declarations", () => {
  it("retains each resource filter alongside limit and one cursor", () => {
    const webhooks: ListWebhooksParams = { limit: 25, after: "next", enabled: true };
    const suppressions: ListSuppressionsParams = {
      limit: 50,
      before: "previous",
      domain: "example.com",
    };
    // @ts-expect-error Suppression list cursors are mutually exclusive.
    const invalidSuppressions: ListSuppressionsParams = {
      limit: 50,
      after: "next",
      before: "previous",
      email: "blocked@example.com",
    };
    const routes: ListRoutesParams = { limit: 10, after: "next", domain: "example.com" };
    // @ts-expect-error Route list cursors are mutually exclusive.
    const invalidRoutes: ListRoutesParams = {
      limit: 10,
      after: "next",
      before: "previous",
      domain: "example.com",
    };

    expect(webhooks.enabled).toBe(true);
    expect(suppressions.domain).toBe("example.com");
    expect(routes.domain).toBe("example.com");
    void [invalidSuppressions, invalidRoutes];
  });
});

describe("generated hostname path validation", () => {
  it.each(["invalid_hostname.example", "-leading-hyphen.example", "double..dot.example"])(
    "rejects %s without dispatching a domain request",
    (domain) => {
      const { fetch, calls } = captureFetch();
      const client = makeClient(fetch);

      expect(() => client.domains.get(domain)).toThrow(/expected hostname/);
      expect(calls).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("WebhooksClient (account-scoped per spec)", () => {
  it("rejects a scoped webhook with no domains", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    expect(() =>
      client.webhooks.create({
        name: "empty scoped",
        url: "https://hooks.example/empty-scoped",
        scope: "scoped",
        domains: [],
      }),
    ).toThrow(/`domains` must contain at least one item/);

    // A global webhook needs no domains at all.
    await client.webhooks.create({
      name: "global",
      url: "https://hooks.example/g",
      scope: "global",
    });
    expect(calls).toHaveLength(1);
  });

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
      domains: [],
    };
    const globalDomains: CreateWebhookRequest = {
      name: "global domains",
      url: "https://hooks.example/domains",
      scope: "global",
      domains: ["ignored.example"],
    };
    const scoped: CreateWebhookRequest = {
      name: "scoped",
      url: "https://hooks.example/scoped",
      scope: "scoped",
      domains: ["example.com"],
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
    const clear: UpdateWebhookRequest = { domains: [] };
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
    void [requestWithSecret, missingDomains, hiddenSecret, _domains];
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
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/webhooks`);
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
    expect(call.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/webhooks`);
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

  it("get() dispatches getWebhook with the webhook ID", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.webhooks.get(WEBHOOK_ID);

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/webhooks/${WEBHOOK_ID}`);
    expect(calls[0]!.operationId).toBe("getWebhook");
  });

  it("update() dispatches updateWebhook and preserves null or sends an empty domain list", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.webhooks.update(WEBHOOK_ID, { name: null, scope: null, domains: null });
    await client.webhooks.update(WEBHOOK_ID, { domains: [] });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/webhooks/${WEBHOOK_ID}`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: null, scope: null, domains: null });
    expect(calls[0]!.operationId).toBe("updateWebhook");
    expect(JSON.parse(calls[1]!.body!)).toEqual({ domains: [] });
    expect(calls[1]!.operationId).toBe("updateWebhook");
  });

  it("delete() dispatches deleteWebhook", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.webhooks.delete(WEBHOOK_ID);

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/webhooks/${WEBHOOK_ID}`);
    expect(calls[0]!.operationId).toBe("deleteWebhook");
  });
});

describe("StatisticsClient", () => {
  it("retains required response counters and delivery-time breakdowns", () => {
    expectTypeOf<DeliverabilityStatistics>().toEqualTypeOf<{
      from_timestamp: string;
      to_timestamp: string;
      reception_count: number;
      delivered_count: number;
      deferred_count: number;
      bounced_count: number;
      failed_count: number;
      suppressed_count: number;
      opened_count: number;
      clicked_count: number;
    }>();
    expectTypeOf<BounceClassificationCount>().toEqualTypeOf<{
      classification: string;
      count: number;
    }>();
    expectTypeOf<DeliveryTimeStatistics["delivered_count"]>().toEqualTypeOf<number>();
    expectTypeOf<DeliveryTimeStatistics["delivery_times"]>().toEqualTypeOf<
      Array<{ recipient_domain: string; delivery_time: number; count: number }>
    >();
  });

  it("deliverability() dispatches generated operation facts with spec-named params", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.deliverability(
      {
        from_time: "2026-04-01T00:00:00Z",
        to_time: "2026-04-30T00:00:00Z",
        group_by: "day",
        sender_domain: "example.com",
      },
      { headers: { "x-trace-id": "stats-1" } },
    );
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/statistics/transactional/deliverability`);
    expect(url.searchParams.get("from_time")).toBe("2026-04-01T00:00:00Z");
    expect(url.searchParams.get("to_time")).toBe("2026-04-30T00:00:00Z");
    expect(url.searchParams.get("group_by")).toBe("day");
    expect(url.searchParams.get("sender_domain")).toBe("example.com");
    expect(calls[0]!.headers["x-trace-id"]).toBe("stats-1");
    expect(calls[0]!.operationId).toBe("getDeliverabilityStatistics");
  });

  it("bounces() dispatches getBounceStatistics", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.bounces({
      from_time: "2026-04-01T00:00:00Z",
      to_time: "2026-04-30T00:00:00Z",
    });
    expect(calls[0]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/statistics/transactional/bounce?from_time=2026-04-01T00%3A00%3A00Z&to_time=2026-04-30T00%3A00%3A00Z`,
    );
    expect(calls[0]!.operationId).toBe("getBounceStatistics");
  });

  it("deliveryTimes() dispatches getDeliveryTimeStatistics", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.statistics.deliveryTimes({
      from_time: "2026-04-01T00:00:00Z",
      to_time: "2026-04-30T00:00:00Z",
    });
    expect(calls[0]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/statistics/transactional/delivery-time?from_time=2026-04-01T00%3A00%3A00Z&to_time=2026-04-30T00%3A00%3A00Z`,
    );
    expect(calls[0]!.operationId).toBe("getDeliveryTimeStatistics");
  });

  it("defaults each statistics parameter object to an empty query", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.statistics.deliverability();
    await client.statistics.bounces();
    await client.statistics.deliveryTimes();

    expect(calls.map(({ url }) => url)).toEqual([
      `https://api.test/v2/accounts/${ACCOUNT_ID}/statistics/transactional/deliverability`,
      `https://api.test/v2/accounts/${ACCOUNT_ID}/statistics/transactional/bounce`,
      `https://api.test/v2/accounts/${ACCOUNT_ID}/statistics/transactional/delivery-time`,
    ]);
    expect(calls.map(({ operationId }) => operationId)).toEqual([
      "getDeliverabilityStatistics",
      "getBounceStatistics",
      "getDeliveryTimeStatistics",
    ]);
  });
});

describe("SuppressionsClient", () => {
  it("models required suppression response fields", () => {
    expectTypeOf<Suppression>().toEqualTypeOf<{
      object: "suppression";
      id: string;
      created_at: string;
      email: string;
      domain: string;
      reason: string;
      expires_at: string;
    }>();
  });

  it("list() dispatches getSuppressions with filters, limit, and one cursor", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.list(
      {
        limit: 50,
        before: "previous",
        domain: "example.com",
        email: "blocked@example.com",
        from_time: "2026-01-01T00:00:00Z",
        to_time: "2026-06-01T00:00:00Z",
      },
      { headers: { "x-trace-id": "suppression-list-1" } },
    );
    expect(calls[0]!.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/suppressions`);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
    expect(url.searchParams.get("domain")).toBe("example.com");
    expect(url.searchParams.get("email")).toBe("blocked@example.com");
    expect(url.searchParams.get("from_time")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("to_time")).toBe("2026-06-01T00:00:00Z");
    expect(calls[0]!.headers["x-trace-id"]).toBe("suppression-list-1");
    expect(calls[0]!.operationId).toBe("getSuppressions");
  });

  it("iterate() fetches the first page through getSuppressions", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "suppression",
                id: "sup_1",
                created_at: "2026-01-02T00:00:00Z",
                email: "blocked@example.com",
                domain: "example.com",
                reason: "manual",
                expires_at: "2027-01-01T00:00:00Z",
              },
            ],
            pagination: { has_more: false },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);
    const suppressions = client.suppressions.iterate({
      email: "blocked@example.com",
      limit: 25,
      after: "next",
    });

    await expect(suppressions.next()).resolves.toMatchObject({
      done: false,
      value: { id: "sup_1", reason: "manual" },
    });
    await expect(suppressions.next()).resolves.toEqual({ done: true, value: undefined });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("email")).toBe("blocked@example.com");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("after")).toBe("next");
    expect(calls[0]!.operationId).toBe("getSuppressions");
  });

  it("create() dispatches createSuppression with body and idempotency options", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.create(
      {
        email: "blocked@example.com",
        reason: "manual",
        expires_at: "2027-01-01T00:00:00Z",
      },
      { idempotencyKey: "suppression-create-1" },
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBe(
      `{"email":"blocked@example.com","reason":"manual","expires_at":"2027-01-01T00:00:00Z"}`,
    );
    expect(calls[0]!.headers["idempotency-key"]).toBe("suppression-create-1");
    expect(calls[0]!.operationId).toBe("createSuppression");
  });

  it("delete() dispatches deleteSuppression with its required email query", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.delete(
      { email: "blocked@example.com", domain: "example.com" },
      { headers: { "x-trace-id": "suppression-delete-1" } },
    );
    expect(calls[0]!.method).toBe("DELETE");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/suppressions`);
    expect(url.searchParams.get("email")).toBe("blocked@example.com");
    expect(url.searchParams.get("domain")).toBe("example.com");
    expect(calls[0]!.headers["x-trace-id"]).toBe("suppression-delete-1");
    expect(calls[0]!.operationId).toBe("deleteSuppression");
  });

  it("wipe() dispatches deleteAllSuppressions with default parameters", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.wipe();
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/suppressions/all`);
    expect(calls[0]!.operationId).toBe("deleteAllSuppressions");
  });

  it("wipe({ domain }) forwards the optional generated query parameter", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.suppressions.wipe({ domain: "example.com" });
    expect(new URL(calls[0]!.url).searchParams.get("domain")).toBe("example.com");
    expect(calls[0]!.operationId).toBe("deleteAllSuppressions");
  });
});

const CONTACT_RESPONSE = {
  object: "contact",
  id: "88888888-8888-4888-8888-888888888888",
  created_at: "2026-09-10T10:00:00Z",
  updated_at: "2026-09-10T11:00:00Z",
  email: "User+Tag/Segment@Example.COM",
  first_name: "Pat",
  last_name: "Example",
  status: "enabled",
  status_reason: "",
  unsubscribed: false,
  unsubscribed_at: null,
  attributes: { legacy: { nested: [true, 12.5, null] } },
  validation_status: "unvalidated",
  last_validated_at: null,
} as const;

describe("ContactsClient", () => {
  it("keeps recursive response attributes broader than create attributes", () => {
    const recursive: ContactJSONValue = {
      nested: [null, true, 12.5, "legacy", { deeper: false }],
    };
    const contact: Contact = { ...CONTACT_RESPONSE, attributes: { recursive } };
    const create: CreateContactRequest = {
      email: "new@example.com",
      attributes: { string: "value", number: 12.5, boolean: false },
    };
    const update: UpdateContactRequest = { attributes: { obsolete: null } };
    const batch: BatchUpsertContactInput = {
      email: "existing@example.com",
      attributes: { obsolete: null },
    };
    const invalidCreate: CreateContactRequest = {
      email: "new@example.com",
      attributes: {
        // @ts-expect-error Null attribute members are mutation semantics, not create values.
        obsolete: null,
      },
    };

    expect(contact.attributes.recursive).toEqual(recursive);
    expect(create.attributes).toEqual({ string: "value", number: 12.5, boolean: false });
    expect(update.attributes).toEqual({ obsolete: null });
    expect(batch.attributes).toEqual({ obsolete: null });
    void invalidCreate;
  });

  it("list() forwards all filters and returns recursive contact values", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [CONTACT_RESPONSE],
            pagination: {
              has_more: true,
              next_cursor: "next-contact",
              previous_cursor: "previous-contact",
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);
    const params: ListContactsParams = {
      limit: 25,
      before: "previous",
      email: "person+filter@example.com",
      status: "enabled",
      subscribed: false,
      from_time: "2026-09-01T00:00:00Z",
      to_time: "2026-09-11T00:00:00Z",
    };

    const page = await client.contacts.list(params, {
      headers: { "x-trace-id": "contact-list-1" },
    });

    const url = new URL(calls[0]!.url);
    expect(calls[0]!.operationId).toBe("getContacts");
    expect(calls[0]!.method).toBe("GET");
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/contacts`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "25",
      before: "previous",
      email: "person+filter@example.com",
      status: "enabled",
      subscribed: "false",
      from_time: "2026-09-01T00:00:00Z",
      to_time: "2026-09-11T00:00:00Z",
    });
    expect(calls[0]!.headers["x-trace-id"]).toBe("contact-list-1");
    expect(page.data[0]!.attributes).toEqual({ legacy: { nested: [true, 12.5, null] } });
    expect(page.pagination).toEqual({
      has_more: true,
      next_cursor: "next-contact",
      previous_cursor: "previous-contact",
    });
  });

  it("iterate() uses the shared cursor paginator and preserves filters and options", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ ...CONTACT_RESPONSE, email: `contact-${index}@example.com` }],
            pagination:
              index === 0
                ? { has_more: true, next_cursor: "second-page", previous_cursor: null }
                : { has_more: false, next_cursor: null, previous_cursor: null },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const client = makeClient(fetch);

    const contacts: Contact[] = [];
    for await (const contact of client.contacts.iterate(
      { limit: 1, email: "contact@example.com" },
      { headers: { "x-trace-id": "contact-iterator-1" } },
    )) {
      contacts.push(contact);
    }

    expect(contacts.map(({ email }) => email)).toEqual([
      "contact-0@example.com",
      "contact-1@example.com",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.map(({ operationId }) => operationId)).toEqual(["getContacts", "getContacts"]);
    expect(calls.map(({ headers }) => headers["x-trace-id"])).toEqual([
      "contact-iterator-1",
      "contact-iterator-1",
    ]);
    expect(new URL(calls[1]!.url).searchParams.get("after")).toBe("second-page");
    expect(new URL(calls[1]!.url).searchParams.get("email")).toBe("contact@example.com");
  });

  it.each([
    {
      name: "get",
      method: "GET",
      operationId: "getContact",
      call: async (client: ReturnType<typeof makeClient>, rawEmail: string) =>
        await client.contacts.get(rawEmail, { headers: { "x-contact-option": "get" } }),
      expectedBody: undefined,
    },
    {
      name: "update",
      method: "PUT",
      operationId: "updateContact",
      call: async (client: ReturnType<typeof makeClient>, rawEmail: string) =>
        await client.contacts.update(
          rawEmail,
          { unsubscribed: false, attributes: { obsolete: null } },
          { headers: { "x-contact-option": "update" } },
        ),
      expectedBody: '{"unsubscribed":false,"attributes":{"obsolete":null}}',
    },
    {
      name: "delete",
      method: "DELETE",
      operationId: "deleteContact",
      call: async (client: ReturnType<typeof makeClient>, rawEmail: string) =>
        await client.contacts.delete(rawEmail, { headers: { "x-contact-option": "delete" } }),
      expectedBody: undefined,
    },
  ])("$name() passes raw path emails to generated one-time encoding", async (testCase) => {
    const { fetch, calls } = captureFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(CONTACT_RESPONSE), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = makeClient(fetch);
    const rawEmail = "User+Tag/Segment@Example.COM";

    await testCase.call(client, rawEmail);

    expect(calls[0]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/contacts/User%2BTag%2FSegment%40Example.COM`,
    );
    expect(calls[0]!.method).toBe(testCase.method);
    expect(calls[0]!.operationId).toBe(testCase.operationId);
    expect(calls[0]!.headers["x-contact-option"]).toBe(testCase.name);
    expect(calls[0]!.body).toBe(testCase.expectedBody);
  });

  it("create() and batchUpsert() forward idempotency and preserve complete batch results", async () => {
    const batchResponse = {
      object: "list",
      created: 1,
      updated: 1,
      failed: 1,
      data: [
        { position: 0, email: "new@example.com", outcome: "created", contact: CONTACT_RESPONSE },
        {
          position: 1,
          email: "existing@example.com",
          outcome: "updated",
          contact: { ...CONTACT_RESPONSE, email: "existing@example.com" },
        },
        { position: 2, email: "bad@example.com", outcome: "failed", reason: "invalid attribute" },
      ],
    };
    const { fetch, calls } = captureFetch((_call, index) =>
      Promise.resolve(
        new Response(JSON.stringify(index === 0 ? CONTACT_RESPONSE : batchResponse), {
          status: index === 0 ? 201 : 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = makeClient(fetch);

    await client.contacts.create(
      {
        email: "new@example.com",
        unsubscribed: false,
        attributes: { customer: true },
      },
      { idempotencyKey: "contact-create-1" },
    );
    const batch = await client.contacts.batchUpsert(
      {
        data: [
          {
            email: "existing@example.com",
            unsubscribed: false,
            attributes: { obsolete: null },
          },
        ],
      },
      { idempotencyKey: "contact-batch-1" },
    );

    expect(calls.map(({ operationId }) => operationId)).toEqual([
      "createContact",
      "batchUpsertContacts",
    ]);
    expect(calls.map(({ headers }) => headers["idempotency-key"])).toEqual([
      "contact-create-1",
      "contact-batch-1",
    ]);
    expect(calls[0]!.body).toBe(
      '{"email":"new@example.com","unsubscribed":false,"attributes":{"customer":true}}',
    );
    expect(calls[1]!.body).toBe(
      '{"data":[{"email":"existing@example.com","unsubscribed":false,"attributes":{"obsolete":null}}]}',
    );
    expect(batch).toEqual(batchResponse);
    expect(batch.data[0]!.contact?.attributes).toEqual({
      legacy: { nested: [true, 12.5, null] },
    });
  });

  it("batchUpsert() rejects an empty data array before dispatch", () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    expect(() => client.contacts.batchUpsert({ data: [] })).toThrow(
      /`data` must contain at least one item/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("RoutesClient", () => {
  it("keeps the route secret response-only in its public types", () => {
    const requestWithSecret: CreateRouteRequest = {
      name: "Selected secret",
      url: "https://hooks.example/inbound",
      recipient: "support@example.com",
      // @ts-expect-error The server selects and returns the route signing secret.
      secret: "client-selected",
    };
    const route: Route = {
      object: "route",
      id: "rt_1",
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      name: "Inbound replies",
      url: "https://hooks.example/inbound",
      recipient: "support@example.com",
      attachments: true,
      headers: false,
      group_by_message_id: false,
      strip_replies: true,
      enabled: true,
      success_count: 1,
      error_count: 0,
      errors_since_last_success: 0,
      last_request_at: null,
    };
    const created: CreatedRoute = { ...route, secret: "rtsec_created" };
    // @ts-expect-error Ordinary route responses never expose the signing secret.
    const hiddenSecret = route.secret;

    expectTypeOf<CreatedRoute["secret"]>().toEqualTypeOf<string>();
    expect(created).toMatchObject({ id: "rt_1", secret: "rtsec_created" });
    void [requestWithSecret, hiddenSecret];
  });

  it("list() dispatches getRoutes with its domain filter, limit, and one cursor", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.routes.list(
      { domain: "example.com", limit: 10, after: "next" },
      { headers: { "x-trace-id": "route-list-1" } },
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("domain")).toBe("example.com");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("after")).toBe("next");
    expect(url.searchParams.has("before")).toBe(false);
    expect(calls[0]!.headers["x-trace-id"]).toBe("route-list-1");
    expect(calls[0]!.operationId).toBe("getRoutes");
  });

  it("iterate() fetches the first page through getRoutes", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "route", id: "rt_1", recipient: "support@example.com" }],
            pagination: { has_more: false },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);
    const routes = client.routes.iterate({ domain: "example.com", limit: 10, before: "previous" });

    await expect(routes.next()).resolves.toMatchObject({
      done: false,
      value: { id: "rt_1", recipient: "support@example.com" },
    });
    await expect(routes.next()).resolves.toEqual({ done: true, value: undefined });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("domain")).toBe("example.com");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(calls[0]!.operationId).toBe("getRoutes");
  });

  it("create() dispatches createRoute and returns its one-time secret", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ object: "route", id: "rt_1", secret: "rtsec_created" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = makeClient(fetch);
    const created = await client.routes.create(
      {
        name: "Inbound replies",
        url: "https://hooks.example/inbound",
        recipient: "support@example.com",
        attachments: true,
      },
      { idempotencyKey: "route-create-1" },
    );
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      name: "Inbound replies",
      url: "https://hooks.example/inbound",
      recipient: "support@example.com",
      attachments: true,
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("route-create-1");
    expect(calls[0]!.operationId).toBe("createRoute");
    expect(created).toEqual({ object: "route", id: "rt_1", secret: "rtsec_created" });
  });

  it("get() dispatches getRoute with the route ID", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.routes.get(ROUTE_ID);

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/routes/${ROUTE_ID}`);
    expect(calls[0]!.operationId).toBe("getRoute");
  });

  it("update() dispatches updateRoute with body and request options", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.routes.update(
      ROUTE_ID,
      { recipient: "replies@example.net", enabled: false },
      { headers: { "x-trace-id": "route-update-1" } },
    );
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/routes/${ROUTE_ID}`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      recipient: "replies@example.net",
      enabled: false,
    });
    expect(calls[0]!.headers["x-trace-id"]).toBe("route-update-1");
    expect(calls[0]!.operationId).toBe("updateRoute");
  });

  it("delete() dispatches deleteRoute", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.routes.delete(ROUTE_ID);

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/routes/${ROUTE_ID}`);
    expect(calls[0]!.operationId).toBe("deleteRoute");
  });
});

describe("AccountsClient", () => {
  it("get() dispatches getAccount with request options", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.get({ headers: { "x-trace-id": "account-get-1" } });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}`);
    expect(calls[0]!.headers["x-trace-id"]).toBe("account-get-1");
    expect(calls[0]!.operationId).toBe("getAccount");
  });

  it("update() dispatches updateAccount with the request body", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.update(
      { name: "New Name" },
      { headers: { "x-trace-id": "account-update-1" } },
    );
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toBe(`{"name":"New Name"}`);
    expect(calls[0]!.headers["x-trace-id"]).toBe("account-update-1");
    expect(calls[0]!.operationId).toBe("updateAccount");
  });

  it("listMembers() dispatches getAccountMembers without query parameters", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.listMembers({ headers: { "x-trace-id": "members-list-1" } });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/members`);
    expect(url.search).toBe("");
    expect(calls[0]!.headers["x-trace-id"]).toBe("members-list-1");
    expect(calls[0]!.operationId).toBe("getAccountMembers");
  });

  it("addMember() dispatches addAccountMember with its body and idempotency key", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.addMember(
      { email: "new@example.com", role: "Developer" },
      { idempotencyKey: "mem-1" },
    );
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      email: "new@example.com",
      role: "Developer",
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("mem-1");
    expect(calls[0]!.operationId).toBe("addAccountMember");
  });

  it("removeMember() dispatches removeAccountMember with the user ID", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.accounts.removeMember(USER_ID, {
      headers: { "x-trace-id": "member-remove-1" },
    });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/members/${USER_ID}`);
    expect(calls[0]!.headers["x-trace-id"]).toBe("member-remove-1");
    expect(calls[0]!.operationId).toBe("removeAccountMember");
  });
});

describe("SMTPCredentialsClient", () => {
  it("rejects a scoped SMTP credential with no domains", () => {
    const { fetch } = captureFetch();
    const client = makeClient(fetch);

    expect(() =>
      client.smtpCredentials.create({ name: "empty scoped", scope: "scoped", domains: [] }),
    ).toThrow(/`domains` must contain at least one item/);
  });

  it("list() dispatches getSMTPCredentials with pagination and request options", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    await client.smtpCredentials.list(
      { limit: 25, before: "previous" },
      { headers: { "x-trace-id": "smtp-list-1" } },
    );

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/smtp-credentials`);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
    expect(calls[0]!.headers["x-trace-id"]).toBe("smtp-list-1");
    expect(calls[0]!.operationId).toBe("getSMTPCredentials");
  });

  it("iterate() fetches the first page through getSMTPCredentials", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "credential_smtp", id: "cred_1", domains: [] }],
            pagination: { has_more: false },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);
    const credentials = client.smtpCredentials.iterate({ limit: 10, after: "next" });

    await expect(credentials.next()).resolves.toMatchObject({
      done: false,
      value: { id: "cred_1", domains: [] },
    });
    await expect(credentials.next()).resolves.toEqual({ done: true, value: undefined });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("after")).toBe("next");
    expect(calls[0]!.operationId).toBe("getSMTPCredentials");
  });

  it("create() dispatches createSMTPCredential and returns the one-time password", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "credential_smtp",
            id: "cred_1",
            scope: "global",
            domains: [],
            password: "smtp-password",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);
    const created = await client.smtpCredentials.create(
      { name: "ci-cred", scope: "global", domains: ["ignored.example"] },
      { idempotencyKey: "smtp-create-1" },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      name: "ci-cred",
      scope: "global",
      domains: ["ignored.example"],
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("smtp-create-1");
    expect(calls[0]!.operationId).toBe("createSMTPCredential");
    expect(created).toMatchObject({ domains: [], password: "smtp-password" });
  });

  it("get() dispatches getSMTPCredential with the credential ID", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.smtpCredentials.get(SMTP_CREDENTIAL_ID, {
      headers: { "x-trace-id": "smtp-get-1" },
    });

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/smtp-credentials/${SMTP_CREDENTIAL_ID}`,
    );
    expect(calls[0]!.headers["x-trace-id"]).toBe("smtp-get-1");
    expect(calls[0]!.operationId).toBe("getSMTPCredential");
  });

  it("delete() dispatches deleteSMTPCredential", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.smtpCredentials.delete(SMTP_CREDENTIAL_ID, {
      headers: { "x-trace-id": "smtp-delete-1" },
    });

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/smtp-credentials/${SMTP_CREDENTIAL_ID}`,
    );
    expect(calls[0]!.headers["x-trace-id"]).toBe("smtp-delete-1");
    expect(calls[0]!.operationId).toBe("deleteSMTPCredential");
  });
});
