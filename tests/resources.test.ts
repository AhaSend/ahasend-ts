import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { components } from "../src/generated/rest-types.js";
import type { APIKey, APIKeyScope, CreatedAPIKey } from "../src/resources/api-keys.js";
// @ts-expect-error APIKeyRequestOptions was never released from the API-key module.
import type { APIKeyRequestOptions as RemovedAPIKeyRequestOptions } from "../src/resources/api-keys.js";
import type { Account } from "../src/resources/accounts.js";
// @ts-expect-error ListMembersParams is not part of the account resource surface.
import type { ListMembersParams as RemovedListMembersParams } from "../src/resources/accounts.js";
import type { Domain, ListDomainsParams } from "../src/resources/domains.js";
// @ts-expect-error DomainRequestOptions was never released from the domain module.
import type { DomainRequestOptions as RemovedDomainRequestOptions } from "../src/resources/domains.js";
import type {
  CreateConversationMessageRequest,
  CreateMessageRequest,
  ListMessagesParams,
  Message,
  MessageSummary,
  SendMessageResult,
} from "../src/resources/messages.js";
import type {
  CreateSMTPCredentialRequest,
  SMTPCredential,
  SMTPCredentialsClient,
} from "../src/resources/smtp-credentials.js";
import type { Route, UpdateRouteRequest } from "../src/resources/routes.js";
import type { PaginationParams } from "../src/types/common.js";
import { captureFetch, makeClient } from "./helpers/resource-call.js";

describe("Resource helper boundary", () => {
  it("contains no generated route, path encoding, method, or transport idempotency policy", () => {
    const source = readFileSync(resolve(process.cwd(), "src/resources/_helpers.ts"), "utf8");

    expect(source).not.toMatch(/["'`]\/v2\//);
    expect(source).not.toContain("encodeURIComponent");
    expect(source).not.toMatch(/\b(?:method|path)\s*:/);
    expect(source).not.toContain("autoIdempotency");
    expect(source).not.toContain("Idempotency-Key");
  });
});

describe("Pagination parameter declarations", () => {
  it("accepts limit with at most one cursor", () => {
    const limitOnly: PaginationParams = { limit: 25 };
    const after: PaginationParams = { limit: 25, after: "next" };
    const before: PaginationParams = { limit: 25, before: "previous" };
    // @ts-expect-error Pagination cursors are mutually exclusive.
    const both: PaginationParams = { limit: 25, after: "next", before: "previous" };
    if (false) {
      // @ts-expect-error Pagination primitives are readonly.
      after.limit = 50;
    }

    expect([limitOnly, after, before, both]).toHaveLength(4);
  });

  it("retains filters on named list parameter aliases", () => {
    const messages: ListMessagesParams = { limit: 25, after: "next", status: "queued" };
    const domains: ListDomainsParams = { limit: 50, before: "previous", dns_valid: true };
    // @ts-expect-error Domain list cursors are mutually exclusive.
    const invalidDomains: ListDomainsParams = {
      limit: 50,
      after: "next",
      before: "previous",
      dns_valid: false,
    };

    expect(messages.status).toBe("queued");
    expect(domains.dns_valid).toBe(true);
    expect(invalidDomains.dns_valid).toBe(false);
  });
});

describe("Account declarations", () => {
  it("matches authoritative response requiredness and nullability", () => {
    const account: Account = {
      object: "account",
      id: "acc_1",
      parent_account_id: null,
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      name: "Primary account",
      website: "https://example.com",
      about: "Primary transactional email account",
      track_opens: true,
      track_clicks: false,
      reject_bad_recipients: true,
      reject_mistyped_recipients: false,
      message_metadata_retention: 30,
      message_data_retention: 7,
      owner_id: "usr_1",
    };
    const { website: _website, ...withoutWebsite } = account;
    // @ts-expect-error website is a required response key.
    const missingWebsite: Account = withoutWebsite;
    // @ts-expect-error website is not nullable in the response schema.
    const nullWebsite: Account = { ...account, website: null };

    expectTypeOf<Account>().toEqualTypeOf<components["schemas"]["Account"]>();
    expect(account.parent_account_id).toBeNull();
    expect(account.website).toBe("https://example.com");
    void [missingWebsite, nullWebsite, _website];
  });

  it("does not expose the account-specific ListMembersParams alias", () => {
    expectTypeOf<RemovedListMembersParams>().toEqualTypeOf<RemovedListMembersParams>();
  });
});

describe("Route declarations", () => {
  it("matches authoritative response requiredness and nullability", () => {
    const route: Route = {
      object: "route",
      id: "route_1",
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      name: "Inbound support",
      url: "https://example.com/routes/support",
      recipient: "support@example.com",
      attachments: true,
      headers: false,
      group_by_message_id: true,
      strip_replies: false,
      enabled: true,
      success_count: 42,
      error_count: 2,
      errors_since_last_success: 0,
      last_request_at: null,
    };
    const { success_count: _successCount, ...withoutSuccessCount } = route;
    // @ts-expect-error success_count is a required response key.
    const missingSuccessCount: Route = withoutSuccessCount;
    // @ts-expect-error recipient is not nullable in the response schema.
    const nullRecipient: Route = { ...route, recipient: null };

    expectTypeOf<Route>().toEqualTypeOf<components["schemas"]["Route"]>();
    expect(route.last_request_at).toBeNull();
    expect(route.recipient).toBe("support@example.com");
    void [missingSuccessCount, nullRecipient, _successCount];
  });

  it("accepts every nullable update field without widening other values", () => {
    const clearable: UpdateRouteRequest = {
      name: null,
      url: null,
      recipient: null,
      attachments: null,
      headers: null,
      group_by_message_id: null,
      strip_replies: null,
      enabled: null,
    };
    // @ts-expect-error Route update fields retain their declared primitive types.
    const invalidName: UpdateRouteRequest = { name: 42 };

    expectTypeOf<UpdateRouteRequest>().toEqualTypeOf<components["schemas"]["UpdateRouteRequest"]>();
    expect(Object.values(clearable).every((value) => value === null)).toBe(true);
    void invalidName;
  });
});

describe("SMTP credential declarations", () => {
  it("models every global domain form and requires non-empty scoped domains", () => {
    const globalOmitted: CreateSMTPCredentialRequest = {
      name: "global omitted",
      scope: "global",
    };
    const globalNull: CreateSMTPCredentialRequest = {
      name: "global null",
      scope: "global",
      domains: null,
    };
    const globalEmpty: CreateSMTPCredentialRequest = {
      name: "global empty",
      scope: "global",
      domains: [],
    };
    const globalNonEmpty: CreateSMTPCredentialRequest = {
      name: "global supplied",
      scope: "global",
      domains: ["ignored.example"],
    };
    const scoped: CreateSMTPCredentialRequest = {
      name: "scoped",
      scope: "scoped",
      domains: ["example.com"],
    };
    // @ts-expect-error Scoped credentials require domains.
    const scopedMissing: CreateSMTPCredentialRequest = {
      name: "scoped missing",
      scope: "scoped",
    };
    // @ts-expect-error Scoped credential domains must be non-empty.
    const scopedEmpty: CreateSMTPCredentialRequest = {
      name: "scoped empty",
      scope: "scoped",
      domains: [],
    };
    if (false) {
      // @ts-expect-error Request domain arrays are readonly.
      scoped.domains.push("another.example");
    }

    expect(globalOmitted).not.toHaveProperty("domains");
    expect(globalNull.domains).toBeNull();
    expect(globalEmpty.domains).toEqual([]);
    expect(globalNonEmpty.domains).toEqual(["ignored.example"]);
    expect(scoped.domains).toEqual(["example.com"]);
    void [scopedMissing, scopedEmpty];
  });

  it("requires non-null response domains and exposes no update method", () => {
    const credential: SMTPCredential = {
      object: "credential_smtp",
      id: "cred_1",
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      name: "Production SMTP",
      username: "smtp-user",
      sandbox: false,
      scope: "global",
      domains: [],
    };
    const { domains: _domains, ...withoutDomains } = credential;
    // @ts-expect-error domains is a required SMTP credential response field.
    const missingDomains: SMTPCredential = withoutDomains;
    // @ts-expect-error SMTP credential response domains cannot be null.
    const nullDomains: SMTPCredential = { ...credential, domains: null };
    if (false) {
      const client = {} as SMTPCredentialsClient;
      // @ts-expect-error SMTP credentials have no update operation.
      client.update;
    }

    expectTypeOf<SMTPCredential["domains"]>().toEqualTypeOf<string[]>();
    expect(credential.domains).toEqual([]);
    void [missingDomains, nullDomains, _domains];
  });
});

describe("MessagesClient", () => {
  it("matches nested substitution, nullability, non-empty array, and response declarations", () => {
    const recipients = [
      {
        email: "recipient@example.com",
        substitutions: {
          customer: { preferences: ["email", { digest: true }] },
        },
      },
    ] as const;
    const attachments = [
      { data: "hello", content_type: "text/plain", file_name: "hello.txt" },
    ] as const;
    const tags = ["transactional"] as const;
    const request: CreateMessageRequest = {
      from: { email: "sender@example.com" },
      recipients,
      subject: "Nested substitutions",
      attachments,
      tags,
      substitutions: { campaign: { sequence: [1, 2, 3] } },
      tracking: null,
      retention: null,
    };
    const conversation: CreateConversationMessageRequest = {
      from: { email: "sender@example.com" },
      to: [{ email: "to@example.com" }] as const,
      cc: [{ email: "cc@example.com" }] as const,
      bcc: [{ email: "bcc@example.com" }] as const,
      subject: "Conversation",
      attachments,
      tags,
      tracking: null,
      retention: null,
    };
    // @ts-expect-error recipients has minItems: 1.
    const emptyRecipients: CreateMessageRequest = { ...request, recipients: [] };
    // @ts-expect-error to has minItems: 1.
    const emptyTo: CreateConversationMessageRequest = { ...conversation, to: [] };
    // @ts-expect-error cc has minItems: 1 when present.
    const emptyCc: CreateConversationMessageRequest = { ...conversation, cc: [] };
    // @ts-expect-error bcc has minItems: 1 when present.
    const emptyBcc: CreateConversationMessageRequest = { ...conversation, bcc: [] };
    if (false) {
      // @ts-expect-error request arrays are readonly.
      request.recipients.push({ email: "another@example.com" });
      // @ts-expect-error request arrays are readonly.
      conversation.cc?.push({ email: "another@example.com" });
    }

    const result: SendMessageResult = {
      object: "message",
      id: null,
      recipient: { email: "recipient@example.com", name: "Recipient" },
      status: "error",
      error: "rejected",
    };
    const { id: _id, ...withoutId } = result;
    const { error: _error, ...withoutError } = result;
    // @ts-expect-error id is a required response key.
    const missingId: SendMessageResult = withoutId;
    // @ts-expect-error error is a required response key.
    const missingError: SendMessageResult = withoutError;

    const summary: MessageSummary = {
      object: "message",
      id: null,
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      sent_at: null,
      delivered_at: null,
      retain_until: "2026-08-21T08:00:00Z",
      direction: "outbound",
      is_bounce_notification: false,
      bounce_classification: "",
      delivery_attempts: [],
      message_id: "<message@example.com>",
      subject: "Subject",
      tags: [],
      sender: "sender@example.com",
      recipient: "recipient@example.com",
      status: "queued",
      num_attempts: 0,
      click_count: 0,
      open_count: 0,
      reference_message_id: null,
      domain_id: "domain_1",
      account_id: "acc_1",
    };
    const message: Message = { ...summary, content: "raw message" };
    const { sent_at: _sentAt, ...withoutSentAt } = summary;
    const { reference_message_id: _referenceId, ...withoutReferenceId } = summary;
    // @ts-expect-error sent_at is a required serialized timestamp.
    const missingSentAt: MessageSummary = withoutSentAt;
    // @ts-expect-error reference_message_id is a required nullable key.
    const missingReferenceId: MessageSummary = withoutReferenceId;

    expectTypeOf<
      Awaited<ReturnType<import("../src/index.js").MessagesClient["list"]>>
    >().toEqualTypeOf<import("../src/types/common.js").PaginatedResponse<MessageSummary>>();
    expectTypeOf<
      Awaited<ReturnType<import("../src/index.js").MessagesClient["get"]>>
    >().toEqualTypeOf<Message>();
    expect(request.recipients[0]?.substitutions).toEqual({
      customer: { preferences: ["email", { digest: true }] },
    });
    expect(conversation).toMatchObject({ tracking: null, retention: null });
    expect(result).toMatchObject({ id: null, error: "rejected" });
    expect(message).toMatchObject({
      created_at: "2026-07-21T08:00:00Z",
      sent_at: null,
      reference_message_id: null,
    });

    // Keep compile-only negative cases referenced without treating their runtime values as evidence.
    void [
      emptyRecipients,
      emptyTo,
      emptyCc,
      emptyBcc,
      missingId,
      missingError,
      missingSentAt,
      missingReferenceId,
      _id,
      _error,
      _sentAt,
      _referenceId,
    ];
  });

  it("send() POSTs /v2/accounts/{account_id}/messages with the request body", async () => {
    const { fetch, calls } = captureFetch(
      (call) =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "message",
                id: call.operationId,
                recipient: { email: "x@y.com", name: "Recipient" },
                status: "queued",
                error: null,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);

    const message = await client.messages.send({
      from: { email: "a@b.com" },
      recipients: [{ email: "x@y.com" }],
      subject: "hi",
      text_content: "hi",
      substitutions: { customer: { tier: "gold", preferences: ["email"] } },
      tracking: null,
      retention: null,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.test/v2/accounts/acc_1/messages");
    expect(call.body).toContain(`"recipients":[{"email":"x@y.com"}]`);
    expect(JSON.parse(call.body!)).toMatchObject({
      substitutions: { customer: { tier: "gold", preferences: ["email"] } },
      tracking: null,
      retention: null,
    });
    expect(call.operationId).toBe("createMessage");
    expect(message.data[0]).toMatchObject({
      id: "createMessage",
      error: null,
    });
    expect(message.data[0]).toHaveProperty("id");
    expect(message.data[0]).toHaveProperty("error");
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
    expect(calls[0]!.operationId).toBe("createConversationMessage");
  });

  it("list() GETs /messages with query params", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.messages.list({ limit: 25, after: "next", status: "queued" });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/messages");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("after")).toBe("next");
    expect(url.searchParams.has("before")).toBe(false);
    expect(url.searchParams.get("status")).toBe("queued");
    expect(calls[0]!.operationId).toBe("getMessages");
  });

  it("get() GETs a single message", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "message",
            id: "opaque/message:id",
            created_at: "2026-07-21T08:00:00Z",
            updated_at: "2026-07-21T08:01:00Z",
            sent_at: "2026-07-21T08:02:00Z",
            delivered_at: null,
            retain_until: "2026-08-21T08:00:00Z",
            direction: "outbound",
            is_bounce_notification: false,
            bounce_classification: "",
            delivery_attempts: [],
            message_id: "<opaque/message:id>",
            subject: "Subject",
            tags: [],
            sender: "sender@example.com",
            recipient: "recipient@example.com",
            status: "delivered",
            num_attempts: 1,
            click_count: 0,
            open_count: 1,
            reference_message_id: 42,
            domain_id: "domain_1",
            account_id: "acc_1",
            content: "raw message",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);

    const message = await client.messages.get("opaque/message:id");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/messages/opaque%2Fmessage%3Aid");
    expect(calls[0]!.operationId).toBe("getMessage");
    expect(message).toMatchObject({
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      sent_at: "2026-07-21T08:02:00Z",
      delivered_at: null,
      retain_until: "2026-08-21T08:00:00Z",
      reference_message_id: 42,
    });
    expect(message).toHaveProperty("created_at");
    expect(message).toHaveProperty("updated_at");
    expect(message).toHaveProperty("sent_at");
    expect(message).toHaveProperty("delivered_at");
    expect(message).toHaveProperty("retain_until");
    expect(message).toHaveProperty("reference_message_id");
  });

  it("cancel() DELETEs /{id}/cancel (per spec)", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.messages.cancel("opaque/message:id");

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://api.test/v2/accounts/acc_1/messages/opaque%2Fmessage%3Aid/cancel",
    );
    expect(calls[0]!.operationId).toBe("cancelMessage");
  });
});

describe("DomainsClient", () => {
  it("requires the nullable selector and keeps the request-options alias absent", () => {
    const domain: Domain = {
      object: "domain",
      id: "domain_1",
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      domain: "example.com",
      account_id: "acc_1",
      dns_records: [],
      dns_valid: true,
      dkim_selector: null,
    };
    const { dkim_selector: _selector, ...withoutSelector } = domain;
    // @ts-expect-error dkim_selector is a required nullable response key.
    const missingSelector: Domain = withoutSelector;

    expectTypeOf<Domain["dkim_selector"]>().toEqualTypeOf<string | null>();
    expectTypeOf<RemovedDomainRequestOptions>().toEqualTypeOf<RemovedDomainRequestOptions>();
    expect(domain).toHaveProperty("dkim_selector", null);
    void [missingSelector, _selector];
  });

  it("create() dispatches createDomain with its body and idempotency key", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.create({ domain: "example.com" }, { idempotencyKey: "key-1" });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains");
    expect(calls[0]!.body).toBe(JSON.stringify({ domain: "example.com" }));
    expect(calls[0]!.headers["idempotency-key"]).toBe("key-1");
    expect(calls[0]!.operationId).toBe("createDomain");
  });

  it("list() dispatches getDomains with filters, limit, and one cursor", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.list({ dns_valid: true, limit: 50, before: "previous" });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/domains");
    expect(url.searchParams.get("dns_valid")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
    expect(calls[0]!.operationId).toBe("getDomains");
  });

  it("iterate() fetches domains through getDomains", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "domain", domain: "example.com", dkim_selector: "selector-1" }],
            pagination: { has_more: false },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);

    const domains = client.domains.iterate({ dns_valid: true, limit: 25 });

    await expect(domains.next()).resolves.toMatchObject({
      done: false,
      value: { domain: "example.com", dkim_selector: "selector-1" },
    });
    await expect(domains.next()).resolves.toEqual({ done: true, value: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operationId).toBe("getDomains");
  });

  it("get() dispatches getDomain, encodes the domain, and preserves its selector", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ dkim_selector: null }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const client = makeClient(fetch);

    const domain = await client.domains.get("example.com/path");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains/example.com%2Fpath");
    expect(calls[0]!.operationId).toBe("getDomain");
    expect(domain).toHaveProperty("dkim_selector", null);
  });

  it("update() dispatches updateDomain with its arguments in order", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.update("example.com/path", { tracking_subdomain: "track" });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains/example.com%2Fpath");
    expect(calls[0]!.body).toBe(JSON.stringify({ tracking_subdomain: "track" }));
    expect(calls[0]!.operationId).toBe("updateDomain");
  });

  it("delete() dispatches deleteDomain", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.delete("example.com");

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains/example.com");
    expect(calls[0]!.operationId).toBe("deleteDomain");
  });

  it("checkDns() dispatches checkDomainDNS without an idempotency key", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.domains.checkDns("example.com");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/domains/example.com/check-dns");
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
    expect(calls[0]!.operationId).toBe("checkDomainDNS");
  });
});

describe("APIKeysClient", () => {
  it("requires response IP lists and scopes while exposing the secret only after create", () => {
    const scope: APIKeyScope = {
      id: "scope_1",
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      api_key_id: "key_1",
      scope: "messages:send:all",
      domain_id: null,
    };
    const apiKey: APIKey = {
      object: "api_key",
      id: "key_1",
      created_at: "2026-07-21T08:00:00Z",
      updated_at: "2026-07-21T08:01:00Z",
      last_used_at: null,
      account_id: "acc_1",
      label: "CI",
      public_key: "aha-pk-test",
      scopes: [scope],
      ip_allow_list: ["203.0.113.0/24"],
    };
    const created: CreatedAPIKey = { ...apiKey, secret_key: "aha-sk-created" };
    const { ip_allow_list: _ipAllowList, ...withoutIPAllowList } = apiKey;
    // @ts-expect-error ip_allow_list is a required API-key response field.
    const missingIPAllowList: APIKey = withoutIPAllowList;
    const { domain_id: _domainId, ...withoutDomainId } = scope;
    // @ts-expect-error domain_id is a required nullable API-key scope field.
    const missingDomainId: APIKeyScope = withoutDomainId;
    // @ts-expect-error secret_key is only exposed by CreatedAPIKey.
    const hiddenSecret = apiKey.secret_key;

    expectTypeOf<APIKey["ip_allow_list"]>().toEqualTypeOf<string[]>();
    expectTypeOf<APIKey["scopes"]>().toEqualTypeOf<APIKeyScope[]>();
    expectTypeOf<CreatedAPIKey["secret_key"]>().toEqualTypeOf<string>();
    expectTypeOf<RemovedAPIKeyRequestOptions>().toEqualTypeOf<RemovedAPIKeyRequestOptions>();
    expect(created.secret_key).toBe("aha-sk-created");
    void [missingIPAllowList, missingDomainId, hiddenSecret, _ipAllowList, _domainId];
  });

  it("create() dispatches createAPIKey with IPs, scopes, and an idempotency key", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ secret_key: "aha-sk-created" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = makeClient(fetch);

    const created = await client.apiKeys.create(
      {
        label: "ci",
        scopes: ["messages:send:all"],
        ip_allow_list: ["203.0.113.7"],
      },
      { idempotencyKey: "key-2" },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/api-keys");
    expect(calls[0]!.body).toBe(
      JSON.stringify({
        label: "ci",
        scopes: ["messages:send:all"],
        ip_allow_list: ["203.0.113.7"],
      }),
    );
    expect(calls[0]!.headers["idempotency-key"]).toBe("key-2");
    expect(calls[0]!.operationId).toBe("createAPIKey");
    expect(created.secret_key).toBe("aha-sk-created");
  });

  it("list() dispatches getAPIKeys with direct pagination parameters", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.apiKeys.list({ limit: 50, before: "previous" });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/api-keys");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
    expect(calls[0]!.operationId).toBe("getAPIKeys");
  });

  it("iterate() fetches API keys through getAPIKeys", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "api_key",
                id: "key_1",
                scopes: [],
                ip_allow_list: [],
              },
            ],
            pagination: { has_more: false },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);

    const apiKeys = client.apiKeys.iterate({ limit: 25, after: "next" });

    await expect(apiKeys.next()).resolves.toMatchObject({
      done: false,
      value: { id: "key_1", scopes: [], ip_allow_list: [] },
    });
    await expect(apiKeys.next()).resolves.toEqual({ done: true, value: undefined });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("25");
    expect(calls[0]!.operationId).toBe("getAPIKeys");
  });

  it("get() dispatches getAPIKey and encodes the key ID", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.apiKeys.get("key/1");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/api-keys/key%2F1");
    expect(calls[0]!.operationId).toBe("getAPIKey");
  });

  it("update() dispatches updateAPIKey with its arguments in order", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.apiKeys.update("key/1", {
      label: null,
      scopes: ["domains:read"],
      ip_allow_list: [],
    });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/api-keys/key%2F1");
    expect(calls[0]!.body).toBe(
      JSON.stringify({ label: null, scopes: ["domains:read"], ip_allow_list: [] }),
    );
    expect(calls[0]!.operationId).toBe("updateAPIKey");
  });

  it("delete() dispatches deleteAPIKey", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.apiKeys.delete("key_1");

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/api-keys/key_1");
    expect(calls[0]!.operationId).toBe("deleteAPIKey");
  });
});
