import { describe, expect, expectTypeOf, it } from "vitest";
import type { ListDomainsParams } from "../src/resources/domains.js";
import type {
  CreateConversationMessageRequest,
  CreateMessageRequest,
  ListMessagesParams,
  Message,
  MessageSummary,
  SendMessageResult,
} from "../src/resources/messages.js";
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
    expect([
      request,
      conversation,
      emptyRecipients,
      emptyTo,
      emptyCc,
      emptyBcc,
      result,
      missingId,
      missingError,
      _id,
      _error,
      message,
      missingSentAt,
      missingReferenceId,
      _sentAt,
      _referenceId,
    ]).toHaveLength(16);
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
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.messages.get("opaque/message:id");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/messages/opaque%2Fmessage%3Aid");
    expect(calls[0]!.operationId).toBe("getMessage");
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
    expect(calls[0]!.body).toBe(JSON.stringify({ label: "ci", scopes: ["messages:send:all"] }));
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
