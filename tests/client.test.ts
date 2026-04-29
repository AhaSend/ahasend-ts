import { describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";

type FetchImpl = typeof fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchImpl {
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
    expect(() =>
      AhaSendClient.fromEnv({ AHASEND_API_KEY: "aha-sk-test" }),
    ).toThrow(/AHASEND_ACCOUNT_ID/);
  });

  it("fromEnv builds a client from env vars", () => {
    const client = AhaSendClient.fromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_ACCOUNT_ID: "acc_1",
    });
    expect(client.accountId).toBe("acc_1");
  });
});
