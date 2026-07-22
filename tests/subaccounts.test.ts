import { describe, expect, expectTypeOf, it } from "vitest";
import type { IdempotencyRequestOptions, RequestOptions } from "../src/index.js";
import type {
  ListSubAccountsParams,
  SubAccount,
  SubAccountsClient,
  SubAccountUsageResponse,
  UpdateSubAccountRequest,
} from "../src/resources/sub-accounts.js";
import { captureFetch, makeClient } from "./helpers/resource-call.js";

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

describe("SubAccountsClient operations", () => {
  it("list() dispatches listSubAccounts with limit, one cursor, and trailing options", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.list(
      { limit: 25, before: "previous" },
      { headers: { "x-trace-id": "sub-list-1" } },
    );

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/accounts/acc_1/sub-accounts");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("before")).toBe("previous");
    expect(url.searchParams.has("after")).toBe(false);
    expect(calls[0]!.headers["x-trace-id"]).toBe("sub-list-1");
    expect(calls[0]!.operationId).toBe("listSubAccounts");
  });

  it("iterate() preserves the limit while advancing the cursor", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      index === 0
        ? new Response(
            JSON.stringify({
              object: "list",
              data: [{ object: "sub_account", id: "sub_1", name: "First" }],
              pagination: { has_more: true, next_cursor: "page-2" },
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
    for await (const item of client.subAccounts.iterate({ limit: 10, after: "page-1" })) {
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
    expect(first.searchParams.get("after")).toBe("page-1");
    expect(first.searchParams.has("before")).toBe(false);
    expect(second.searchParams.get("limit")).toBe("10");
    expect(second.searchParams.get("after")).toBe("page-2");
    expect(second.searchParams.has("before")).toBe(false);
  });

  it("create() sends the body and its explicit idempotency key", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.create(
      { name: "Child", website: "child.example.com", monthly_credit: 50_000 },
      { idempotencyKey: "sub-create-1" },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/sub-accounts");
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
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/sub-accounts/usage");
    expect(calls[0]!.headers["x-trace-id"]).toBe("sub-usage-1");
    expect(calls[0]!.operationId).toBe("getSubAccountsUsage");
  });

  it("get(), update(), and delete() dispatch the generated lifecycle operations", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.get("sub/42");
    await client.subAccounts.update("sub/42", { monthly_credit: 75_000 });
    await client.subAccounts.delete("sub/42");

    expect(calls.map(({ method, url, operationId }) => ({ method, url, operationId }))).toEqual([
      {
        method: "GET",
        url: "https://api.test/v2/accounts/acc_1/sub-accounts/sub%2F42",
        operationId: "getSubAccount",
      },
      {
        method: "PUT",
        url: "https://api.test/v2/accounts/acc_1/sub-accounts/sub%2F42",
        operationId: "updateSubAccount",
      },
      {
        method: "DELETE",
        url: "https://api.test/v2/accounts/acc_1/sub-accounts/sub%2F42",
        operationId: "deleteSubAccount",
      },
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ monthly_credit: 75_000 });
  });

  it("suspend() sends a reason body and unsuspend() sends no body", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);

    await client.subAccounts.suspend(
      "sub/42",
      { reason: "Customer requested a pause" },
      { headers: { "x-trace-id": "sub-suspend-1" } },
    );
    await client.subAccounts.unsuspend("sub/42");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v2/accounts/acc_1/sub-accounts/sub%2F42/suspend");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ reason: "Customer requested a pause" });
    expect(calls[0]!.headers["x-trace-id"]).toBe("sub-suspend-1");
    expect(calls[0]!.operationId).toBe("suspendSubAccount");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toBe(
      "https://api.test/v2/accounts/acc_1/sub-accounts/sub%2F42/unsuspend",
    );
    expect(calls[1]!.body).toBeUndefined();
    expect(calls[1]!.operationId).toBe("unsuspendSubAccount");
  });
});
