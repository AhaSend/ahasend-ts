import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { AhaSendClient } from "../src/index.js";
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
  SuppressionsClient,
  TelemetryHooks,
  WebhooksClient,
} from "../src/index.js";
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
    expect(() => new AhaSendClient({ apiKey: "", accountId: "acc_1" })).toThrow(/apiKey/);
    // @ts-expect-error testing runtime validation
    expect(() => new AhaSendClient({ apiKey: "aha-sk-test" })).toThrow(/accountId/);
  });

  it("exposes messages, domains, and apiKeys resource clients", () => {
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      fetch: mockFetch(() => new Response("{}", { status: 200 })),
    });
    expect(client.messages).toBeDefined();
    expect(client.domains).toBeDefined();
    expect(client.apiKeys).toBeDefined();
    expect(client.accountId).toBe("acc_1");
  });

  it("ping() hits GET /v2/ping", async () => {
    let seenUrl = "";
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      fetch: mockFetch((url) => {
        seenUrl = url;
        return new Response(JSON.stringify({ message: "pong" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });

    const res = await client.ping();
    expect(seenUrl).toMatch(/\/v2\/ping$/);
    expect(res.message).toBe("pong");
  });

  it("fromEnv requires AHASEND_ACCOUNT_ID", () => {
    expect(() => AhaSendClient.fromEnv({ AHASEND_API_KEY: "aha-sk-test" })).toThrow(
      /AHASEND_ACCOUNT_ID/,
    );
  });

  it("fromEnv builds a client from env vars", () => {
    const client = AhaSendClient.fromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_ACCOUNT_ID: "acc_1",
    });
    expect(client.accountId).toBe("acc_1");
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
        "AhaSendResponseParseError",
        "AhaSendServerError",
        "AhaSendTimeoutError",
        "AhaSendUnprocessableEntityError",
        "DEFAULT_BASE_URL",
        "DEFAULT_IDEMPOTENCY_CONFIG",
        "DEFAULT_TIMEOUT_MS",
        "IDEMPOTENCY_HEADER",
        "IDEMPOTENT_REPLAYED_HEADER",
        "IdempotencyKeyBuilder",
        "SDK_VERSION",
        "composeHooks",
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
      "SuppressionsClient",
      "WebhooksClient",
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
      "debugConsoleHooks",
      "resolveTelemetryHooks",
    ]) {
      expect(publicApi).not.toHaveProperty(internal);
    }
  });

  it("retains public options, promises, telemetry, models, and resource client types", () => {
    expectTypeOf<AhaSendClientOptions>().toExtend<ClientOptions>();
    expectTypeOf<IdempotencyRequestOptions>().toExtend<RequestOptions>();
    expectTypeOf<IdempotencyConfig>().toHaveProperty("autoGenerate");
    expectTypeOf<RetryConfig>().toHaveProperty("maxRetries");
    expectTypeOf<RateLimitConfig["general"]>().toEqualTypeOf<
      Partial<CategoryRateLimit> | undefined
    >();
    expectTypeOf<TelemetryHooks["onRequest"]>().parameter(0).toEqualTypeOf<RequestEvent>();
    expectTypeOf<AhaSendPromise<Message>["withResponse"]>().returns.toEqualTypeOf<
      Promise<AhaSendResponse<Message>>
    >();
    expectTypeOf<AhaSendErrorCode>().toMatchTypeOf<string>();

    expectTypeOf<AhaSendClient["accounts"]>().toEqualTypeOf<AccountsClient>();
    expectTypeOf<AhaSendClient["apiKeys"]>().toEqualTypeOf<APIKeysClient>();
    expectTypeOf<AhaSendClient["domains"]>().toEqualTypeOf<DomainsClient>();
    expectTypeOf<AhaSendClient["messages"]>().toEqualTypeOf<MessagesClient>();
    expectTypeOf<AhaSendClient["routes"]>().toEqualTypeOf<RoutesClient>();
    expectTypeOf<AhaSendClient["smtpCredentials"]>().toEqualTypeOf<SMTPCredentialsClient>();
    expectTypeOf<AhaSendClient["statistics"]>().toEqualTypeOf<StatisticsClient>();
    expectTypeOf<AhaSendClient["suppressions"]>().toEqualTypeOf<SuppressionsClient>();
    expectTypeOf<AhaSendClient["webhooks"]>().toEqualTypeOf<WebhooksClient>();
  });
});

describe("resource option forwarding", () => {
  it("returns frozen snapshots without freezing or retaining caller headers", () => {
    const headers = { "x-trace-id": "trace-1" };
    const forwarded = forwardOptions({ headers });
    const idempotent = forwardWithIdempotency({ headers, idempotencyKey: "operation-1" });
    const generatedIdempotency = forwardWithIdempotency({ headers });

    headers["x-trace-id"] = "changed";

    expect(Object.isFrozen(forwarded)).toBe(true);
    expect(Object.isFrozen(forwarded.headers)).toBe(true);
    expect(forwarded.headers).toEqual({ "x-trace-id": "trace-1" });
    expect(Object.isFrozen(idempotent)).toBe(true);
    expect(Object.isFrozen(idempotent.headers)).toBe(true);
    expect(idempotent).toEqual({
      headers: { "x-trace-id": "trace-1", "Idempotency-Key": "operation-1" },
      autoIdempotency: true,
    });
    expect(generatedIdempotency).toEqual({
      headers: { "x-trace-id": "trace-1" },
      autoIdempotency: true,
    });
  });
});
