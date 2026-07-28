import { describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
import { resolveConfig } from "../src/config.js";
import { HttpClient } from "../src/http.js";
import { OperationExecutor } from "../src/operations.js";

type FetchImpl = typeof fetch;

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchImpl {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as FetchImpl;
}

function makeHttp(fetchImpl: FetchImpl): HttpClient {
  return new HttpClient(
    resolveConfig({
      apiKey: "aha-sk-test",
      baseUrl: "https://api.test",
      fetch: fetchImpl,
      retry: { enabled: false },
    }),
  );
}

describe("OperationExecutor", () => {
  it("resolves generated paths and independently encodes every path value", async () => {
    let seenUrl = "";
    const http = makeHttp(
      mockFetch((url) => {
        seenUrl = url;
        return new Response("{}", { status: 200 });
      }),
    );
    const request = vi.spyOn(http, "request");
    const executor = new OperationExecutor(http);

    await executor.execute("getDomain", {
      path: {
        account_id: "account/sentinel",
        domain: "mail/{sentinel}%example.com",
      },
    });

    expect(new URL(seenUrl).pathname).toBe(
      "/v2/accounts/account%2Fsentinel/domains/mail%2F%7Bsentinel%7D%25example.com",
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: {
          operationId: "getDomain",
          retryMode: "safe",
          idempotency: null,
        },
      }),
    );
  });

  it("places only descriptor-declared query and body inputs", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const http = makeHttp(
      mockFetch((url, init) => {
        seenUrl = url;
        seenInit = init;
        return new Response("{}", { status: 201 });
      }),
    );
    const request = vi.spyOn(http, "request");
    const executor = new OperationExecutor(http);
    const body = { domain: "example.com" };

    await executor.execute("createDomain", {
      path: { account_id: "acc_1" },
      query: { undeclared_sentinel: "must-not-be-sent" },
      body,
    });

    expect(new URL(seenUrl).search).toBe("");
    expect(seenInit?.body).toBe(JSON.stringify(body));
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v2/accounts/acc_1/domains",
      body,
      execution: {
        operationId: "createDomain",
        retryMode: "idempotency_key",
        idempotency: { completion: "automatic" },
      },
    });
  });

  it("passes deeply frozen automatic and manual-secret execution records", async () => {
    const http = makeHttp(mockFetch(() => new Response("{}", { status: 201 })));
    const request = vi.spyOn(http, "request");
    const executor = new OperationExecutor(http);

    await executor.execute("createDomain", {
      path: { account_id: "acc_1" },
      body: { domain: "example.com" },
    });
    await executor.execute("createAPIKey", {
      path: { account_id: "acc_1" },
      body: { label: "key", scopes: [] },
    });

    const automatic = request.mock.calls[0]![0].execution!;
    const manual = request.mock.calls[1]![0].execution!;
    expect(Object.isFrozen(automatic)).toBe(true);
    expect(Object.isFrozen(automatic.idempotency)).toBe(true);
    expect(Object.isFrozen(manual)).toBe(true);
    expect(Object.isFrozen(manual.idempotency)).toBe(true);
    expect(automatic.idempotency?.completion).toBe("automatic");
    expect(manual.idempotency?.completion).toBe("manual_secret");
  });

  it("filters query values to the names declared by the descriptor", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const executor = new OperationExecutor(
      makeHttp(
        mockFetch((url, init) => {
          seenUrl = url;
          seenInit = init;
          return new Response("{}", { status: 200 });
        }),
      ),
    );

    await executor.execute("deleteSuppression", {
      path: { account_id: "acc_1" },
      query: {
        email: "person+tag@example.com",
        domain: "example.com",
        undeclared_sentinel: "must-not-be-sent",
      },
      body: { undeclared_sentinel: "must-not-be-sent" },
    });

    const url = new URL(seenUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      email: "person+tag@example.com",
      domain: "example.com",
    });
    expect(seenInit?.body).toBeUndefined();
  });

  it("rejects missing path values before dispatch", () => {
    const transport = mockFetch(() => new Response("{}", { status: 200 }));
    const executor = new OperationExecutor(makeHttp(transport));

    expect(() =>
      executor.execute("getDomain", {
        path: { account_id: "acc_1" },
      }),
    ).toThrow('Missing path parameter "domain" for getDomain');
    expect(transport).not.toHaveBeenCalled();
  });

  it("prevents retries for operations generated as unsafe", async () => {
    const transport = mockFetch(() => new Response("server error", { status: 500 }));
    const http = new HttpClient(
      resolveConfig({
        apiKey: "aha-sk-test",
        baseUrl: "https://api.test",
        fetch: transport,
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      }),
    );
    const executor = new OperationExecutor(http);

    await expect(
      executor.execute("checkDomainDNS", {
        path: { account_id: "acc_1", domain: "example.com" },
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("prevents conditional retries when no idempotency key is available", async () => {
    const transport = mockFetch(() => new Response("server error", { status: 500 }));
    const http = new HttpClient(
      resolveConfig({
        apiKey: "aha-sk-test",
        baseUrl: "https://api.test",
        fetch: transport,
        idempotency: { autoGenerate: false },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      }),
    );
    const executor = new OperationExecutor(http);

    await expect(
      executor.execute("createDomain", {
        path: { account_id: "acc_1" },
        body: { domain: "example.com" },
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("client-bound operation execution", () => {
  it("keeps two clients' ping dispatches isolated to their own transports", async () => {
    const firstTransport = mockFetch(() =>
      Response.json({ message: "first-pong" }, { headers: { "x-request-id": "first" } }),
    );
    const secondTransport = mockFetch(() =>
      Response.json({ message: "second-pong" }, { headers: { "x-request-id": "second" } }),
    );
    const first = new AhaSendClient({
      apiKey: "aha-sk-first",
      accountId: "acc_first",
      baseUrl: "https://first.test",
      fetch: firstTransport,
    });
    const second = new AhaSendClient({
      apiKey: "aha-sk-second",
      accountId: "acc_second",
      baseUrl: "https://second.test",
      fetch: secondTransport,
    });

    const [firstResult, secondResult] = await Promise.all([first.ping(), second.ping()]);

    expect(firstResult).toEqual({ message: "first-pong" });
    expect(secondResult).toEqual({ message: "second-pong" });
    expect(firstTransport).toHaveBeenCalledTimes(1);
    expect(secondTransport).toHaveBeenCalledTimes(1);
    expect(firstTransport).toHaveBeenCalledWith(
      "https://first.test/v2/ping",
      expect.objectContaining({ method: "GET" }),
    );
    expect(secondTransport).toHaveBeenCalledWith(
      "https://second.test/v2/ping",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
