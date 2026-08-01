import { describe, expect, it, vi } from "vitest";
import { AhaSendError, isAhaSendError } from "../src/index.js";
import { collect, paginate } from "../src/pagination.js";
import type { PaginatedResponse } from "../src/types/common.js";
import { AhaSendClient } from "../src/client.js";

type FetchImpl = typeof fetch;

describe("paginate", () => {
  it("walks through every page until has_more is false", async () => {
    const pages: PaginatedResponse<number>[] = [
      { object: "list", data: [1, 2, 3], pagination: { has_more: true, next_cursor: "p2" } },
      { object: "list", data: [4, 5], pagination: { has_more: true, next_cursor: "p3" } },
      { object: "list", data: [6], pagination: { has_more: false } },
    ];
    let i = 0;
    const fetchPage = vi.fn(async () => pages[i++]!);

    const out: number[] = [];
    for await (const item of paginate(fetchPage, {})) out.push(item);

    expect(out).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("stops when next_cursor is missing even if has_more is true", async () => {
    const fetchPage = vi.fn(async () => ({
      object: "list" as const,
      data: [1],
      pagination: { has_more: true },
    }));

    const out: number[] = [];
    for await (const item of paginate(fetchPage, {})) out.push(item);

    expect(out).toEqual([1]);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("stops when has_more is false even if a stale cursor is present", async () => {
    const fetchPage = vi.fn(async () => ({
      object: "list" as const,
      data: [1],
      pagination: { has_more: false, next_cursor: "stale-next-page" },
    }));

    const out: number[] = [];
    for await (const item of paginate(fetchPage, {})) out.push(item);

    expect(out).toEqual([1]);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("advances forward while preserving the limit and filters", async () => {
    const seen: Array<{ status?: string; limit?: number; after?: string; before?: string }> = [];
    const pages = [
      { object: "list" as const, data: ["a"], pagination: { has_more: true, next_cursor: "c1" } },
      { object: "list" as const, data: ["b"], pagination: { has_more: true, next_cursor: "c2" } },
      { object: "list" as const, data: ["c"], pagination: { has_more: false } },
    ];
    let i = 0;
    const fetchPage = vi.fn(
      async (params: { status?: string; limit?: number; after?: string; before?: string }) => {
        seen.push(params);
        return pages[i++]!;
      },
    );

    const out: string[] = [];
    for await (const item of paginate(fetchPage, { status: "queued", limit: 5 })) out.push(item);

    expect(out).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([
      { status: "queued", limit: 5 },
      { status: "queued", limit: 5, after: "c1" },
      { status: "queued", limit: 5, after: "c2" },
    ]);
  });

  it("advances backward while preserving the limit and filters", async () => {
    const seen: Array<{ status?: string; limit?: number; after?: string; before?: string }> = [];
    const pages = [
      {
        object: "list" as const,
        data: ["c"],
        pagination: { has_more: true, previous_cursor: "c1" },
      },
      {
        object: "list" as const,
        data: ["b"],
        pagination: { has_more: true, previous_cursor: "c0" },
      },
      { object: "list" as const, data: ["a"], pagination: { has_more: false } },
    ];
    let i = 0;
    const fetchPage = vi.fn(
      async (params: { status?: string; limit?: number; after?: string; before?: string }) => {
        seen.push(params);
        return pages[i++]!;
      },
    );

    const out: string[] = [];
    for await (const item of paginate(fetchPage, {
      status: "queued",
      limit: 5,
      before: "c2",
    })) {
      out.push(item);
    }

    expect(out).toEqual(["c", "b", "a"]);
    expect(seen).toEqual([
      { status: "queued", limit: 5, before: "c2" },
      { status: "queued", limit: 5, before: "c1" },
      { status: "queued", limit: 5, before: "c0" },
    ]);
  });

  it("rejects dual cursors before fetching a page", async () => {
    const fetchPage = vi.fn(async () => ({
      object: "list" as const,
      data: [1],
      pagination: { has_more: false },
    }));
    const drain = async () => {
      for await (const _item of paginate(fetchPage, {
        after: "next",
        before: "previous",
      } as never)) {
        // drain
      }
    };

    await expect(drain()).rejects.toThrow(
      'Pagination parameters must not include both "after" and "before"',
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("rejects a cursor that would revisit a page", async () => {
    const pages = [
      { object: "list" as const, data: ["a"], pagination: { has_more: true, next_cursor: "c1" } },
      { object: "list" as const, data: ["b"], pagination: { has_more: true, next_cursor: "c1" } },
    ];
    let i = 0;
    const fetchPage = vi.fn(async () => pages[i++]!);

    const drain = async () => {
      for await (const _item of paginate(fetchPage, {})) {
        // drain
      }
    };

    const error = await drain().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AhaSendError);
    expect(isAhaSendError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "ahasend_error",
      message: "Pagination cursor did not advance",
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("collect() drains and respects an explicit limit", async () => {
    const pages = [
      {
        object: "list" as const,
        data: [1, 2, 3],
        pagination: { has_more: true, next_cursor: "x" },
      },
      { object: "list" as const, data: [4, 5], pagination: { has_more: false } },
    ];
    let i = 0;
    const fetchPage = vi.fn(async () => pages[i++]!);

    expect(await collect(fetchPage, {})).toEqual([1, 2, 3, 4, 5]);

    i = 0;
    expect(await collect(fetchPage, {}, 2)).toEqual([1, 2]);
  });
});

describe("Resource client iterators", () => {
  function makeClient(
    handler: (call: number, input: RequestInfo | URL, init?: RequestInit) => Response,
  ): AhaSendClient {
    let n = 0;
    const fetchImpl: FetchImpl = vi.fn(async (input, init) =>
      handler(++n, input, init),
    ) as unknown as FetchImpl;
    return new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      fetch: fetchImpl,
    });
  }

  it("client.messages.iterate() walks all pages", async () => {
    const client = makeClient((call) => {
      if (call === 1) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { object: "message", id: "m1" },
              { object: "message", id: "m2" },
            ],
            pagination: { has_more: true, next_cursor: "p2" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "message", id: "m3" }],
          pagination: { has_more: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const ids: Array<string | null> = [];
    for await (const msg of client.messages.iterate()) ids.push(msg.id);
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });

  it("client.suppressions.iterate() can be drained with collect-like loop", async () => {
    const client = makeClient(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "suppression", id: "s1", email: "a@b.com" }],
            pagination: { has_more: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const out: string[] = [];
    for await (const s of client.suppressions.iterate()) out.push(s.id);
    expect(out).toEqual(["s1"]);
  });

  it("preserves request options and remains cancellable between pages", async () => {
    const requestHeaders: string[] = [];
    const client = makeClient((call, _input, init) => {
      requestHeaders.push(new Headers(init?.headers).get("x-trace-id") ?? "");
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "message", id: "m1" }],
          pagination: { has_more: true, next_cursor: call === 1 ? "p2" : "p3" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const controller = new AbortController();
    const iterator = client.messages.iterate(
      { limit: 1, status: "queued" },
      { headers: { "x-trace-id": "trace-1" }, signal: controller.signal },
    );

    await expect(iterator.next()).resolves.toMatchObject({ value: { id: "m1" }, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ value: { id: "m1" }, done: false });
    controller.abort("stop pagination");
    await expect(iterator.next()).rejects.toMatchObject({
      name: "AhaSendAbortError",
      code: "abort_error",
    });
    expect(requestHeaders).toEqual(["trace-1", "trace-1"]);
  });
});
