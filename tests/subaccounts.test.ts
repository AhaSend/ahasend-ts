import { inspect } from "node:util";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  APIKey,
  CreatedAPIKey,
  IdempotencyRequestOptions,
  PaginationParams,
  RequestOptions,
  SubAccountAPIKeysClient,
} from "../src/index.js";
import type {
  ListSubAccountsParams,
  SubAccount,
  SubAccountsClient,
  SubAccountUsageResponse,
  UpdateSubAccountRequest,
} from "../src/resources/sub-accounts.js";
import {
  ACCOUNT_ID,
  API_KEY_ID,
  captureFetch,
  makeClient,
  SUB_ACCOUNT_ID,
} from "./helpers/resource-call.js";

describe("SubAccountsClient declarations", () => {
  it("models lifecycle and refined usage responses from the generated contract", () => {
    expectTypeOf<SubAccount>().toEqualTypeOf<{
      object: "sub_account";
      id: string;
      parent_account_id: string;
      created_at: string;
      name: string;
      website: string;
      status: "active" | "suspended" | "parent-suspended" | "deleted";
      monthly_credit: number;
      domain_count: number;
      member_count: number;
      last_activity_at: string | null;
    }>();
    expectTypeOf<SubAccountUsageResponse["parent"]["account_id"]>().toEqualTypeOf<string>();
    expectTypeOf<
      SubAccountUsageResponse["sub_accounts"][number]["account_id"]
    >().toEqualTypeOf<string>();
    expectTypeOf<SubAccountUsageResponse["sub_accounts"][number]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<SubAccountUsageResponse["parent"]["reception_count"]>().toEqualTypeOf<number>();
  });

  it("requires at least one non-null update field", () => {
    const name: UpdateSubAccountRequest = { name: "Renamed", website: null };
    const website: UpdateSubAccountRequest = { website: "child.example.com" };
    const credit: UpdateSubAccountRequest = { monthly_credit: 50_000, name: null };
    // @ts-expect-error At least one non-null update field is required.
    const empty: UpdateSubAccountRequest = {};
    // @ts-expect-error Null fields are unchanged and do not satisfy the update requirement.
    const allNull: UpdateSubAccountRequest = { name: null, monthly_credit: null };

    expect([name, website, credit, empty, allNull]).toHaveLength(5);
  });

  it("retains limit with exactly one cursor on list and iterate", () => {
    const after: ListSubAccountsParams = { limit: 25, after: "next" };
    const before: ListSubAccountsParams = { limit: 25, before: "previous" };
    // @ts-expect-error Sub-account list cursors are mutually exclusive.
    const both: ListSubAccountsParams = { limit: 25, after: "next", before: "previous" };

    expectTypeOf<Parameters<SubAccountsClient["list"]>[0]>().toEqualTypeOf<
      ListSubAccountsParams | undefined
    >();
    expectTypeOf<Parameters<SubAccountsClient["iterate"]>[0]>().toEqualTypeOf<
      ListSubAccountsParams | undefined
    >();
    expect([after, before, both]).toHaveLength(3);
  });

  it("accepts idempotency options only on create", () => {
    expectTypeOf<Parameters<SubAccountsClient["create"]>[1]>().toEqualTypeOf<
      IdempotencyRequestOptions | undefined
    >();
    expectTypeOf<Parameters<SubAccountsClient["usage"]>[0]>().toEqualTypeOf<
      RequestOptions | undefined
    >();
    expectTypeOf<Parameters<SubAccountsClient["get"]>[1]>().toEqualTypeOf<
      RequestOptions | undefined
    >();
    expectTypeOf<Parameters<SubAccountsClient["update"]>[2]>().toEqualTypeOf<
      RequestOptions | undefined
    >();
    expectTypeOf<Parameters<SubAccountsClient["delete"]>[1]>().toEqualTypeOf<
      RequestOptions | undefined
    >();
    expectTypeOf<Parameters<SubAccountsClient["suspend"]>[2]>().toEqualTypeOf<
      RequestOptions | undefined
    >();
    expectTypeOf<Parameters<SubAccountsClient["unsuspend"]>[1]>().toEqualTypeOf<
      RequestOptions | undefined
    >();
  });
});

describe("SubAccountAPIKeysClient declarations", () => {
  it("freezes sub-account and key identifier order in each signature", () => {
    expectTypeOf<Parameters<SubAccountAPIKeysClient["list"]>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<SubAccountAPIKeysClient["get"]>>().toEqualTypeOf<
      [subAccountId: string, keyId: string, options?: RequestOptions]
    >();
    expectTypeOf<Parameters<SubAccountAPIKeysClient["update"]>>().toEqualTypeOf<
      [
        subAccountId: string,
        keyId: string,
        body: import("../src/index.js").UpdateAPIKeyRequest,
        options?: RequestOptions,
      ]
    >();
    expectTypeOf<Parameters<SubAccountAPIKeysClient["delete"]>>().toEqualTypeOf<
      [subAccountId: string, keyId: string, options?: RequestOptions]
    >();
  });

  it("uses PaginationParams directly and retains cursor XOR", () => {
    const after: PaginationParams = { limit: 25, after: "next" };
    const before: PaginationParams = { limit: 25, before: "previous" };
    // @ts-expect-error Child API-key list cursors are mutually exclusive.
    const both: PaginationParams = { limit: 25, after: "next", before: "previous" };

    expectTypeOf<Parameters<SubAccountAPIKeysClient["list"]>[1]>().toEqualTypeOf<
      PaginationParams | undefined
    >();
    expectTypeOf<Parameters<SubAccountAPIKeysClient["iterate"]>[1]>().toEqualTypeOf<
      PaginationParams | undefined
    >();
    expect([after, before, both]).toHaveLength(3);
  });

  it("returns the one-time secret only from create and accepts idempotency there", () => {
    expectTypeOf<ReturnType<SubAccountAPIKeysClient["create"]>>().toEqualTypeOf<
      Promise<CreatedAPIKey>
    >();
    expectTypeOf<ReturnType<SubAccountAPIKeysClient["list"]>>().toEqualTypeOf<
      Promise<import("../src/index.js").PaginatedResponse<APIKey>>
    >();
    expectTypeOf<ReturnType<SubAccountAPIKeysClient["get"]>>().toEqualTypeOf<Promise<APIKey>>();
    expectTypeOf<ReturnType<SubAccountAPIKeysClient["update"]>>().toEqualTypeOf<Promise<APIKey>>();
    expectTypeOf<Parameters<SubAccountAPIKeysClient["create"]>[2]>().toEqualTypeOf<
      IdempotencyRequestOptions | undefined
    >();
  });
});

describe("SubAccountsClient operations", () => {
  it("list() dispatches listSubAccounts with limit, one cursor, and trailing options", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.list(
      { limit: 25, before: "previous" },
      { headers: { "x-trace-id": "sub-list-1" } },
    );

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/sub-accounts`);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
    expect(calls[0]!.headers["x-trace-id"]).toBe("sub-list-1");
    expect(calls[0]!.operationId).toBe("listSubAccounts");
  });

  it("iterate() preserves the limit and backward direction while advancing", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      index === 0
        ? new Response(
            JSON.stringify({
              object: "list",
              data: [{ object: "sub_account", id: "sub_1", name: "First" }],
              pagination: { has_more: true, previous_cursor: "page-2" },
            }),
            { headers: { "content-type": "application/json" } },
          )
        : new Response(
            JSON.stringify({
              object: "list",
              data: [{ object: "sub_account", id: "sub_2", name: "Second" }],
              pagination: { has_more: false },
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    const client = makeClient(fetch);

    const items: SubAccount[] = [];
    for await (const item of client.subAccounts.iterate({ limit: 10, before: "page-1" })) {
      items.push(item);
    }

    expect(items.map(({ id }) => id)).toEqual(["sub_1", "sub_2"]);
    expect(calls).toHaveLength(2);
    expect(calls.map(({ operationId }) => operationId)).toEqual([
      "listSubAccounts",
      "listSubAccounts",
    ]);
    const first = new URL(calls[0]!.url);
    const second = new URL(calls[1]!.url);
    expect(first.searchParams.get("limit")).toBe("10");
    expect(first.searchParams.get("before")).toBe("page-1");
    expect(first.searchParams.has("after")).toBe(false);
    expect(second.searchParams.get("limit")).toBe("10");
    expect(second.searchParams.get("before")).toBe("page-2");
    expect(second.searchParams.has("after")).toBe(false);
  });

  it("create() sends the body and its explicit idempotency key", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.create(
      { name: "Child", website: "child.example.com", monthly_credit: 50_000 },
      { idempotencyKey: "sub-create-1" },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      name: "Child",
      website: "child.example.com",
      monthly_credit: 50_000,
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("sub-create-1");
    expect(calls[0]!.operationId).toBe("createSubAccount");
  });

  it("usage() dispatches getSubAccountsUsage with trailing options", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.usage({ headers: { "x-trace-id": "sub-usage-1" } });

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts/usage`);
    expect(calls[0]!.headers["x-trace-id"]).toBe("sub-usage-1");
    expect(calls[0]!.operationId).toBe("getSubAccountsUsage");
  });

  it("get(), update(), and delete() dispatch the generated lifecycle operations", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.get(SUB_ACCOUNT_ID);
    await client.subAccounts.update(SUB_ACCOUNT_ID, { monthly_credit: 75_000 });
    await client.subAccounts.delete(SUB_ACCOUNT_ID);

    expect(calls.map(({ method, url, operationId }) => ({ method, url, operationId }))).toEqual([
      {
        method: "GET",
        url: `https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}`,
        operationId: "getSubAccount",
      },
      {
        method: "PUT",
        url: `https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}`,
        operationId: "updateSubAccount",
      },
      {
        method: "DELETE",
        url: `https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}`,
        operationId: "deleteSubAccount",
      },
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ monthly_credit: 75_000 });
  });

  it("suspend() sends a reason body and unsuspend() sends no body", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.suspend(
      SUB_ACCOUNT_ID,
      { reason: "Customer requested a pause" },
      { headers: { "x-trace-id": "sub-suspend-1" } },
    );
    await client.subAccounts.unsuspend(SUB_ACCOUNT_ID);

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}/suspend`,
    );
    expect(JSON.parse(calls[0]!.body!)).toEqual({ reason: "Customer requested a pause" });
    expect(calls[0]!.headers["x-trace-id"]).toBe("sub-suspend-1");
    expect(calls[0]!.operationId).toBe("suspendSubAccount");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}/unsuspend`,
    );
    expect(calls[1]!.body).toBeUndefined();
    expect(calls[1]!.operationId).toBe("unsuspendSubAccount");
  });
});

describe("SubAccountAPIKeysClient operations", () => {
  it("list() substitutes the child ID and forwards pagination and options", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.apiKeys.list(
      SUB_ACCOUNT_ID,
      { limit: 25, before: "previous" },
      { headers: { "x-trace-id": "child-key-list-1" } },
    );

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys`);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
    expect(calls[0]!.headers["x-trace-id"]).toBe("child-key-list-1");
    expect(calls[0]!.operationId).toBe("listSubAccountAPIKeys");
  });

  it("iterate() preserves the child id, limit, and backward direction", async () => {
    const { fetch, calls } = captureFetch(
      (_call, index) =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "api_key", id: index === 0 ? "key_1" : "key_2" }],
            pagination:
              index === 0 ? { has_more: true, previous_cursor: "page-2" } : { has_more: false },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);

    const items: APIKey[] = [];
    for await (const item of client.subAccounts.apiKeys.iterate(SUB_ACCOUNT_ID, {
      limit: 10,
      before: "page-1",
    })) {
      items.push(item);
    }

    expect(items.map(({ id }) => id)).toEqual(["key_1", "key_2"]);
    expect(calls).toHaveLength(2);
    expect(calls.map(({ operationId }) => operationId)).toEqual([
      "listSubAccountAPIKeys",
      "listSubAccountAPIKeys",
    ]);
    for (const call of calls) {
      expect(new URL(call.url).pathname).toBe(
        `/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys`,
      );
      expect(new URL(call.url).searchParams.get("limit")).toBe("10");
    }
    expect(new URL(calls[0]!.url).searchParams.get("before")).toBe("page-1");
    expect(new URL(calls[1]!.url).searchParams.get("before")).toBe("page-2");
    expect(new URL(calls[1]!.url).searchParams.has("after")).toBe(false);
  });

  it("create() returns the one-time secret and forwards idempotency", async () => {
    const { fetch, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({ object: "api_key", id: "key_1", secret_key: "aha-sk-child" }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const client = makeClient(fetch);

    const created = await client.subAccounts.apiKeys.create(
      SUB_ACCOUNT_ID,
      { label: "Bootstrap", scopes: ["messages:send:all"] },
      { idempotencyKey: "child-key-create-1" },
    );

    expect(created.secret_key).toBe("aha-sk-child");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys`,
    );
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      label: "Bootstrap",
      scopes: ["messages:send:all"],
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("child-key-create-1");
    expect(calls[0]!.operationId).toBe("createSubAccountAPIKey");
  });

  it("get(), update(), and delete() preserve sub-account then key identifier order", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.apiKeys.get(SUB_ACCOUNT_ID, API_KEY_ID);
    await client.subAccounts.apiKeys.update(SUB_ACCOUNT_ID, API_KEY_ID, { label: "Rotated" });
    await client.subAccounts.apiKeys.delete(SUB_ACCOUNT_ID, API_KEY_ID);

    const expectedUrl = `https://api.test/v2/accounts/${ACCOUNT_ID}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys/${API_KEY_ID}`;
    expect(calls.map(({ method, url, operationId }) => ({ method, url, operationId }))).toEqual([
      { method: "GET", url: expectedUrl, operationId: "getSubAccountAPIKey" },
      { method: "PUT", url: expectedUrl, operationId: "updateSubAccountAPIKey" },
      { method: "DELETE", url: expectedUrl, operationId: "deleteSubAccountAPIKey" },
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ label: "Rotated" });
  });

  it("keeps child executor and transport state out of inspection and serialization", () => {
    const { fetch } = captureFetch();
    const facade = makeClient(fetch).subAccounts.apiKeys;

    expect(Object.isFrozen(facade)).toBe(true);
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
      expect(rendered).not.toContain("OperationExecutor");
      expect(rendered).not.toContain("HttpClient");
      expect(rendered).not.toContain("transport");
      expect(rendered).not.toContain("#operations");
    }
  });
});
