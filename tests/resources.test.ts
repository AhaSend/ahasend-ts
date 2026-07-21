import { describe, expect, it } from "vitest";
import type { ListDomainsParams } from "../src/resources/domains.js";
import type { ListMessagesParams } from "../src/resources/messages.js";
import type { PaginationParams } from "../src/types/common.js";
import { captureFetch, makeClient } from "./helpers/resource-call.js";

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

    expect(messages.status).toBe("queued");
    expect(domains.dns_valid).toBe(true);
  });
});

describe("MessagesClient", () => {
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
                recipient: { email: "x@y.com" },
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
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.test/v2/accounts/acc_1/messages");
    expect(call.body).toContain(`"recipients":[{"email":"x@y.com"}]`);
    expect(call.operationId).toBe("createMessage");
    expect(message.data[0]!.id).toBe("createMessage");
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

    await client.messages.list({ limit: 25, after: "next", status: "queued" });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/messages");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("after")).toBe("next");
    expect(url.searchParams.has("before")).toBe(false);
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

    await client.domains.list({ dns_valid: true, limit: 50, before: "previous" });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("dns_valid")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
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
