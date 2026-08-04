import { inspect } from "node:util";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  AhaSendClient,
  AhaSendConfigurationError,
  DEFAULT_MAX_QUEUE,
  AhaSendRateLimitQueueFullError,
  isAhaSendError,
} from "../src/index.js";
import type {
  APIKeysClient,
  AccountsClient,
  AhaSendClientOptions,
  AhaSendErrorCode,
  AhaSendPromise,
  AhaSendResponse,
  CategoryRateLimit,
  ClientOptions,
  DomainsClient,
  IdempotencyConfig,
  IdempotencyRequestOptions,
  Message,
  MessagesClient,
  RateLimitConfig,
  RequestEvent,
  RequestOptions,
  RetryConfig,
  RoutesClient,
  SMTPCredentialsClient,
  StatisticsClient,
  SubAccountAPIKeysClient,
  SubAccountsClient,
  SuppressionsClient,
  TelemetryHooks,
  WebhooksClient,
} from "../src/index.js";
// @ts-expect-error DomainRequestOptions was never released from the public API.
import type { DomainRequestOptions as RemovedDomainRequestOptions } from "../src/index.js";
// @ts-expect-error APIKeyRequestOptions was never released from the public API.
import type { APIKeyRequestOptions as RemovedAPIKeyRequestOptions } from "../src/index.js";
// @ts-expect-error ListMembersParams is not part of the public API.
import type { ListMembersParams as RemovedListMembersParams } from "../src/index.js";
// @ts-expect-error Rate-limit categories are internal transport policy.
import type { EndpointCategory as InternalEndpointCategory } from "../src/index.js";
import * as publicApi from "../src/index.js";
import { forwardOptions, forwardWithIdempotency } from "../src/resources/_helpers.js";

type FetchImpl = typeof fetch;

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchImpl {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as FetchImpl;
}

describe("AhaSendClient", () => {
  it("requires apiKey and accountId", () => {
    expect(
      () => new AhaSendClient({ apiKey: "", accountId: "11111111-1111-4111-8111-111111111111" }),
    ).toThrow(/apiKey/);
    // @ts-expect-error testing runtime validation
    expect(() => new AhaSendClient({ apiKey: "aha-sk-test" })).toThrow(/accountId/);
  });

  it("rejects a non-UUID accountId at construction, not at first call", () => {
    // Every account_id path parameter is declared format: uuid, so a bad value
    // can only ever fail. Before this check a client built from a dashboard
    // slug or a .env typo looked healthy — ping() takes no account_id and
    // still succeeded — and then threw a bare TypeError from the transport,
    // which isAhaSendError() does not match.
    for (const accountId of ["acc_123", "not-a-uuid", "11111111-1111-4111-8111-11111111111"]) {
      let caught: unknown;
      try {
        new AhaSendClient({ apiKey: "aha-sk-test", accountId });
      } catch (error) {
        caught = error;
      }
      expect(caught, accountId).toBeInstanceOf(AhaSendConfigurationError);
      expect(isAhaSendError(caught), accountId).toBe(true);
      expect((caught as Error).message).toMatch(/accountId` must be a UUID/);
    }

    // A padded value is accepted AND stored trimmed. Validating the trimmed
    // form while keeping the raw one would let a trailing newline through — the
    // classic file-backed-secret case — and reproduce the very late TypeError
    // this check exists to prevent.
    const padded = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: " 11111111-1111-4111-8111-111111111111\n",
    });
    expect(padded.accountId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("does not echo the accountId value in the rejection message", () => {
    // A swapped AHASEND_ACCOUNT_ID / AHASEND_API_KEY pair is a common mistake,
    // and this message reaches logs — so it must not carry the value.
    const secret = "aha-sk-super-secret-key-value";
    let caught: unknown;
    try {
      new AhaSendClient({ apiKey: "aha-sk-test", accountId: secret });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AhaSendConfigurationError);
    const rendered = `${(caught as Error).message}${inspect(caught)}${JSON.stringify(caught)}`;
    expect(rendered).not.toContain(secret);
  });

  it("exposes messages, domains, and apiKeys resource clients", () => {
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: mockFetch(() => new Response("{}", { status: 200 })),
    });
    expect(client.messages).toBeDefined();
    expect(client.domains).toBeDefined();
    expect(client.apiKeys).toBeDefined();
    expect(client.accountId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("ping() hits GET /v2/ping and exposes the public response promise", async () => {
    let seenUrl = "";
    let fetchCalls = 0;
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: mockFetch((url) => {
        fetchCalls++;
        seenUrl = url;
        return new Response(JSON.stringify({ message: "pong" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": "req_ping" },
        });
      }),
    });

    const ping = client.ping();
    expectTypeOf(ping).toEqualTypeOf<AhaSendPromise<import("../src/index.js").PingResponse>>();

    const [res, envelope] = await Promise.all([ping, ping.withResponse()]);
    expect(seenUrl).toMatch(/\/v2\/ping$/);
    expect(res.message).toBe("pong");
    expect(envelope.data).toBe(res);
    expect(envelope.requestId).toBe("req_ping");
    expect(fetchCalls).toBe(1);
  });

  it("keeps client state private and serializes a redacted diagnostic view", () => {
    const apiKey = "aha-sk-private-client-secret";
    const sensitiveHeader = "private-default-header-value";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "33333333-3333-4333-8333-333333333333",
      defaultHeaders: { "x-private-header": sensitiveHeader },
      fetch: transport,
    });

    expect(Object.getOwnPropertyNames(client)).toEqual([]);
    expect(JSON.parse(JSON.stringify(client))).toEqual({
      name: "AhaSendClient",
      accountId: "33333333-3333-4333-8333-333333333333",
      apiKey: "[REDACTED]",
    });

    const serialized = JSON.stringify(client);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(sensitiveHeader);
    expect(serialized).not.toContain("x-private-header");
    expect(serialized).not.toContain("HttpClient");
    expect(serialized).not.toContain("MessagesClient");
  });

  it("provides redacted util.inspect output even when hidden properties are requested", () => {
    const apiKey = "aha-sk-private-inspect-secret";
    const sensitiveHeader = "private-inspect-header-value";
    const client = new AhaSendClient({
      apiKey,
      accountId: "55555555-5555-4555-8555-555555555555",
      defaultHeaders: { "x-private-header": sensitiveHeader },
      fetch: mockFetch(() => new Response("{}", { status: 200 })),
    });

    const inspected = inspect(client, { showHidden: true });
    expect(inspected).toContain("AhaSendClient");
    expect(inspected).toContain("55555555-5555-4555-8555-555555555555");
    expect(inspected).toContain("[REDACTED]");
    expect(inspected).not.toContain(apiKey);
    expect(inspected).not.toContain(sensitiveHeader);
    expect(inspected).not.toContain("HttpClient");
    expect(inspected).not.toContain("MessagesClient");
  });

  it("exposes stable frozen resource facades", () => {
    const apiKey = "aha-sk-facade-secret";
    const sensitiveHeader = "private-facade-header-value";
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      defaultHeaders: { "x-private-header": sensitiveHeader },
      fetch: mockFetch(() => new Response("{}", { status: 200 })),
    });
    const facades = [
      client.messages,
      client.domains,
      client.apiKeys,
      client.webhooks,
      client.statistics,
      client.suppressions,
      client.routes,
      client.accounts,
      client.smtpCredentials,
      client.subAccounts,
      client.subAccounts.apiKeys,
    ];

    expect(client.messages).toBe(client.messages);
    for (const facade of facades) {
      expect(Object.isFrozen(facade)).toBe(true);
      expect(Object.getOwnPropertyNames(facade)).not.toContain("http");
      expect(Object.getOwnPropertyNames(facade)).not.toContain("accountId");
      const inspected = inspect(facade, { showHidden: true });
      expect(inspected).not.toContain(apiKey);
      expect(inspected).not.toContain(sensitiveHeader);
      expect(inspected).not.toContain("HttpClient");
    }
  });

  it("keeps the message executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-message-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.messages;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "send",
      "sendConversation",
      "list",
      "iterate",
      "get",
      "cancel",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the domain executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-domain-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.domains;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "list",
      "iterate",
      "create",
      "get",
      "update",
      "delete",
      "checkDns",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the API-key executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-api-key-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.apiKeys;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "list",
      "iterate",
      "create",
      "get",
      "update",
      "delete",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the configured-webhook executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-webhook-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.webhooks;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "list",
      "iterate",
      "create",
      "get",
      "update",
      "delete",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the statistics executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-statistics-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.statistics;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "deliverability",
      "bounces",
      "deliveryTimes",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the suppression executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-suppression-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.suppressions;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "list",
      "iterate",
      "create",
      "delete",
      "wipe",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the route executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-route-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.routes;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "list",
      "iterate",
      "create",
      "get",
      "update",
      "delete",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the account executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-account-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.accounts;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "get",
      "update",
      "listMembers",
      "addMember",
      "removeMember",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the SMTP credential executor private during facade inspection and serialization", () => {
    const apiKey = "aha-sk-smtp-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.smtpCredentials;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "list",
      "iterate",
      "create",
      "get",
      "delete",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the sub-account executor and nested resource private during facade inspection", () => {
    const apiKey = "aha-sk-sub-account-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.subAccounts;

    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "list",
      "iterate",
      "create",
      "usage",
      "get",
      "update",
      "delete",
      "suspend",
      "unsuspend",
      "apiKeys",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("SubAccountsClient");
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("keeps the nested sub-account API-key executor private during facade inspection", () => {
    const apiKey = "aha-sk-child-api-key-facade-secret";
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const client = new AhaSendClient({
      apiKey,
      accountId: "11111111-1111-4111-8111-111111111111",
      fetch: transport,
    });
    const facade = client.subAccounts.apiKeys;

    expect(client.subAccounts.apiKeys).toBe(facade);
    expect(Object.getOwnPropertyNames(facade)).toEqual([
      "list",
      "iterate",
      "create",
      "get",
      "update",
      "delete",
    ]);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(JSON.stringify(facade)).toBe("{}");

    for (const rendered of [inspect(facade), inspect(facade, { showHidden: true })]) {
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });

  it("fromEnv requires AHASEND_ACCOUNT_ID", () => {
    expect(() => AhaSendClient.fromEnv({ AHASEND_API_KEY: "aha-sk-test" })).toThrow(
      /AHASEND_ACCOUNT_ID/,
    );
  });

  it("fromEnv builds a client from env vars", () => {
    const client = AhaSendClient.fromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_ACCOUNT_ID: "11111111-1111-4111-8111-111111111111",
    });
    expect(client.accountId).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("root public exports", () => {
  it("exposes only the curated runtime surface", () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        "AhaSendAbortError",
        "AhaSendAPIError",
        "AhaSendAuthenticationError",
        "AhaSendBadRequestError",
        "AhaSendClient",
        "AhaSendConfigurationError",
        "AhaSendConflictError",
        "AhaSendConnectionError",
        "AhaSendError",
        "AhaSendIdempotencyConflictError",
        "AhaSendIdempotencyMismatchError",
        "AhaSendNotFoundError",
        "AhaSendPermissionError",
        "AhaSendRateLimitError",
        "AhaSendRateLimitQueueFullError",
        "AhaSendResponseParseError",
        "AhaSendResponseTooLargeError",
        "AhaSendServerError",
        "AhaSendTimeoutError",
        "AhaSendUnprocessableEntityError",
        "DEFAULT_MAX_QUEUE",
        "IdempotencyKeyBuilder",
        "SDK_VERSION",
        "generateIdempotencyKey",
        "isAhaSendError",
        "optionsFromEnv",
      ].sort(),
    );
  });

  it("does not expose transport, resource constructors, or policy internals", () => {
    for (const internal of [
      "HttpClient",
      "AccountsClient",
      "APIKeysClient",
      "DomainsClient",
      "MessagesClient",
      "RoutesClient",
      "SMTPCredentialsClient",
      "StatisticsClient",
      "SubAccountAPIKeysClient",
      "SubAccountsClient",
      "SuppressionsClient",
      "WebhooksClient",
      "DEFAULT_BASE_URL",
      "DEFAULT_IDEMPOTENCY_CONFIG",
      "DEFAULT_TIMEOUT_MS",
      "IDEMPOTENCY_HEADER",
      "IDEMPOTENT_REPLAYED_HEADER",
      "resolveConfig",
      "DEFAULT_RETRY_CONFIG",
      "DEFAULT_RATE_LIMIT_CONFIG",
      "RateLimiter",
      "detectCategory",
      "computeBackoffMs",
      "computeRetryDelayMs",
      "isRetryableError",
      "collect",
      "paginate",
      "composeHooks",
      "debugConsoleHooks",
      "resolveTelemetryHooks",
    ]) {
      expect(publicApi).not.toHaveProperty(internal);
    }
  });

  it("retains public options, promises, telemetry, models, and resource client types", () => {
    expectTypeOf<AhaSendClientOptions>().toExtend<ClientOptions>();
    expectTypeOf<IdempotencyRequestOptions>().toExtend<RequestOptions>();
    expectTypeOf<RequestOptions>().toHaveProperty("retry");
    expectTypeOf<IdempotencyConfig>().toHaveProperty("autoGenerate");
    expectTypeOf<RetryConfig>().toHaveProperty("maxRetries");
    expectTypeOf<RateLimitConfig["standard"]>().toEqualTypeOf<
      Partial<CategoryRateLimit> | undefined
    >();
    expectTypeOf<TelemetryHooks["onRequest"]>().parameter(0).toEqualTypeOf<RequestEvent>();
    expectTypeOf<AhaSendPromise<Message>["withResponse"]>().returns.toEqualTypeOf<
      Promise<AhaSendResponse<Message>>
    >();
    expectTypeOf<AhaSendErrorCode>().toMatchTypeOf<string>();

    expectTypeOf<AhaSendClient["accounts"]>().toEqualTypeOf<Readonly<AccountsClient>>();
    expectTypeOf<AhaSendClient["apiKeys"]>().toEqualTypeOf<Readonly<APIKeysClient>>();
    expectTypeOf<AhaSendClient["domains"]>().toEqualTypeOf<Readonly<DomainsClient>>();
    expectTypeOf<AhaSendClient["messages"]>().toEqualTypeOf<Readonly<MessagesClient>>();
    expectTypeOf<AhaSendClient["routes"]>().toEqualTypeOf<Readonly<RoutesClient>>();
    expectTypeOf<AhaSendClient["smtpCredentials"]>().toEqualTypeOf<
      Readonly<SMTPCredentialsClient>
    >();
    expectTypeOf<AhaSendClient["statistics"]>().toEqualTypeOf<Readonly<StatisticsClient>>();
    expectTypeOf<AhaSendClient["subAccounts"]>().toEqualTypeOf<Readonly<SubAccountsClient>>();
    expectTypeOf<AhaSendClient["subAccounts"]["apiKeys"]>().toEqualTypeOf<
      Readonly<SubAccountAPIKeysClient>
    >();
    expectTypeOf<AhaSendClient["suppressions"]>().toEqualTypeOf<Readonly<SuppressionsClient>>();
    expectTypeOf<AhaSendClient["webhooks"]>().toEqualTypeOf<Readonly<WebhooksClient>>();
  });

  it("does not expose the unreleased DomainRequestOptions type alias", () => {
    expectTypeOf<RemovedDomainRequestOptions>().toEqualTypeOf<RemovedDomainRequestOptions>();
  });

  it("does not expose the unreleased APIKeyRequestOptions type alias", () => {
    expectTypeOf<RemovedAPIKeyRequestOptions>().toEqualTypeOf<RemovedAPIKeyRequestOptions>();
  });

  it("does not expose the account-specific ListMembersParams type alias", () => {
    expectTypeOf<RemovedListMembersParams>().toEqualTypeOf<RemovedListMembersParams>();
  });
});

describe("resource option forwarding", () => {
  it("returns frozen snapshots without freezing or retaining caller headers", () => {
    const headers = { "x-trace-id": "trace-1" };
    const retry = { maxRetries: 1 };
    const forwarded = forwardOptions({ headers, timeoutMs: 2_000, retry });
    const idempotent = forwardWithIdempotency({
      headers,
      timeoutMs: 3_000,
      retry: { maxRetries: 0 },
      idempotencyKey: "operation-1",
    });
    const generatedIdempotency = forwardWithIdempotency({ headers });

    headers["x-trace-id"] = "changed";
    retry.maxRetries = 2;

    expect(Object.isFrozen(forwarded)).toBe(true);
    expect(Object.isFrozen(forwarded.headers)).toBe(true);
    expect(Object.isFrozen(forwarded.retry)).toBe(true);
    expect(forwarded).toEqual({
      headers: { "x-trace-id": "trace-1" },
      timeoutMs: 2_000,
      retry: { maxRetries: 1 },
    });
    expect(Object.isFrozen(idempotent)).toBe(true);
    expect(Object.isFrozen(idempotent.headers)).toBe(true);
    expect(Object.isFrozen(idempotent.retry)).toBe(true);
    expect(idempotent).toEqual({
      headers: { "x-trace-id": "trace-1" },
      timeoutMs: 3_000,
      retry: { maxRetries: 0 },
      idempotencyKey: "operation-1",
    });
    expect(generatedIdempotency).toEqual({ headers: { "x-trace-id": "trace-1" } });
    expect(forwardOptions({ retry: false })).toEqual({ retry: false });
  });

  it("forwards retry restrictions through idempotency-aware resource methods", async () => {
    const transport = mockFetch(() => new Response("server error", { status: 500 }));
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "11111111-1111-4111-8111-111111111111",
      baseUrl: "https://api.test",
      fetch: transport,
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        strategy: "constant",
        jitter: false,
      },
    });

    await expect(
      client.domains.create(
        { domain: "example.com" },
        { idempotencyKey: "domain-create-1", retry: { maxRetries: 0 } },
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe("AhaSendClient rate limiter", () => {
  const options = {
    apiKey: "aha-sk-test",
    accountId: "11111111-1111-4111-8111-111111111111",
  } as const;

  // The limiter's mutation API hung off HttpClient, which the client never
  // exposed, so none of it was reachable by a consumer — 13 of the rate-limit
  // suite's assertions exercised code no user could call.
  it("reaches the limiter's runtime controls from the public client", () => {
    const client = new AhaSendClient(options);

    expect(client.rateLimiter.isEnabled()).toBe(false);
    client.rateLimiter.setEnabled(true);
    expect(client.rateLimiter.isEnabled()).toBe(true);

    client.rateLimiter.setLimit("standard", { requestsPerSecond: 5, burst: 3 });
    expect(client.rateLimiter.available("standard")).toBeLessThanOrEqual(3);

    client.rateLimiter.setCategoryEnabled("statistics", false);
    // A disabled bucket still reports its tokens; only admission changes.
    expect(client.rateLimiter.available("statistics")).toBeTypeOf("number");
    expect(client.rateLimiter.isCategoryEnabled("statistics")).toBe(false);
  });

  it("re-enabling a category restores a full burst rather than stale tokens", async () => {
    const client = new AhaSendClient({
      ...options,
      rateLimit: { enabled: true, standard: { requestsPerSecond: 1, burst: 4 } },
      fetch: () => new Promise<Response>(() => {}),
    });

    // Spend two tokens through the real request path.
    void client.messages.list().catch(() => undefined);
    void client.messages.list().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.rateLimiter.available("standard")).toBeLessThan(4);

    // Off, then on: calls made while the bucket was off bypassed it, so
    // carrying the old token count forward would under-admit afterwards.
    client.rateLimiter.setCategoryEnabled("standard", false);
    expect(client.rateLimiter.isCategoryEnabled("standard")).toBe(false);
    client.rateLimiter.setCategoryEnabled("standard", true);

    expect(client.rateLimiter.isCategoryEnabled("standard")).toBe(true);
    expect(client.rateLimiter.available("standard")).toBe(4);
  });

  it("rejects an unusable rate through the public controller", () => {
    const client = new AhaSendClient(options);

    expect(() =>
      client.rateLimiter.setLimit("standard", { requestsPerSecond: 0, burst: 1 }),
    ).toThrow(AhaSendConfigurationError);
  });

  // Construction and the runtime controller are two doors to the same settings.
  // The controller was published by this change; before it, its missing
  // validation was inert. `maxQueue: 0` refuses every call before it can queue
  // and `burst: 0` never admits one, so both silently brick a client that looks
  // healthy.
  it.each([
    ["maxQueue: 0", { requestsPerSecond: 100, burst: 200, maxQueue: 0 }],
    ["maxQueue: -1", { requestsPerSecond: 100, burst: 200, maxQueue: -1 }],
    ["maxQueue: 1.5", { requestsPerSecond: 100, burst: 200, maxQueue: 1.5 }],
    ["maxQueue: MAX_VALUE", { requestsPerSecond: 100, burst: 200, maxQueue: Number.MAX_VALUE }],
    ["burst: 0", { requestsPerSecond: 100, burst: 0 }],
    ["burst: NaN", { requestsPerSecond: 100, burst: Number.NaN }],
    ["requestsPerSecond: NaN", { requestsPerSecond: Number.NaN, burst: 200 }],
    ["requestsPerSecond: Infinity", { requestsPerSecond: Number.POSITIVE_INFINITY, burst: 200 }],
  ])("refuses %s through the controller, exactly as construction does", (_label, limit) => {
    const viaConstruction = () =>
      new AhaSendClient({ ...options, rateLimit: { enabled: true, standard: limit } });
    const viaController = () => new AhaSendClient(options).rateLimiter.setLimit("standard", limit);

    expect(viaConstruction).toThrow(AhaSendConfigurationError);
    expect(viaController).toThrow(AhaSendConfigurationError);

    // Same mistake, same words, whichever door it came through.
    let constructionMessage = "";
    let controllerMessage = "";
    try {
      viaConstruction();
    } catch (error) {
      constructionMessage = (error as Error).message;
    }
    try {
      viaController();
    } catch (error) {
      controllerMessage = (error as Error).message;
    }
    expect(controllerMessage).toBe(constructionMessage);
  });

  it("reads limits back and applies a maxQueue-only change", () => {
    const client = new AhaSendClient({
      ...options,
      rateLimit: { enabled: true, standard: { requestsPerSecond: 20, burst: 20 } },
    });

    expect(client.rateLimiter.getLimit("standard")).toEqual({
      requestsPerSecond: 20,
      burst: 20,
      enabled: true,
      maxQueue: DEFAULT_MAX_QUEUE,
    });

    // The remedy a queue-full error prescribes, expressed on its own. Restating
    // a rate you cannot read back is how a backpressure fix becomes an
    // accidental rate change.
    client.rateLimiter.setLimit("standard", { maxQueue: 4_000 });

    expect(client.rateLimiter.getLimit("standard")).toEqual({
      requestsPerSecond: 20,
      burst: 20,
      enabled: true,
      maxQueue: 4_000,
    });
  });

  it("reports per-bucket enablement, not just the master switch", () => {
    const client = new AhaSendClient(options);

    expect(client.rateLimiter.isCategoryEnabled("standard")).toBe(true);
    client.rateLimiter.setCategoryEnabled("standard", false);
    expect(client.rateLimiter.isCategoryEnabled("standard")).toBe(false);
    // Independent of the master switch and of the other bucket.
    expect(client.rateLimiter.isEnabled()).toBe(false);
    expect(client.rateLimiter.isCategoryEnabled("statistics")).toBe(true);
  });

  it("freezes the controller like every other client facade", () => {
    const client = new AhaSendClient(options);

    expect(Object.isFrozen(client.rateLimiter)).toBe(true);
    expect(() => {
      (client.rateLimiter as { isEnabled: unknown }).isEnabled = () => true;
    }).toThrow(TypeError);
  });

  it("carries a configured maxQueue through to the limiter", async () => {
    const client = new AhaSendClient({
      ...options,
      rateLimit: { enabled: true, standard: { requestsPerSecond: 1, burst: 1, maxQueue: 1 } },
      fetch: () => new Promise<Response>(() => {}),
    });

    // burst 1 admits the first call; maxQueue 1 admits one waiter; the third is
    // refused. `acquire` rejects before awaiting anything, so the refusal is
    // available on the first microtask — race it against a resolved sentinel so
    // a regression that queues instead fails here rather than by timing out.
    void client.messages.list().catch(() => undefined);
    void client.messages.list().catch(() => undefined);

    const third = client.messages.list().then(
      () => "resolved" as const,
      (reason: unknown) => reason,
    );
    // One macrotask turn: enough for the request plumbing to reach the
    // limiter, far short of a token becoming available at 1/s.
    const outcome = await Promise.race([
      third,
      new Promise<"queued">((resolve) => setTimeout(() => resolve("queued"), 0)),
    ]);

    expect(outcome, "the over-capacity call must be refused, not queued").toBeInstanceOf(
      AhaSendRateLimitQueueFullError,
    );
    expect((outcome as AhaSendRateLimitQueueFullError).maxQueue).toBe(1);
  });
});
