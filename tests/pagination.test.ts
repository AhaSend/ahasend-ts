import { describe, expect, it, vi } from "vitest";
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

  it("threads the cursor into subsequent calls", async () => {
    const seenAfter: Array<string | undefined> = [];
    const pages = [
      { object: "list" as const, data: ["a"], pagination: { has_more: true, next_cursor: "c1" } },
      { object: "list" as const, data: ["b"], pagination: { has_more: false } },
    ];
    let i = 0;
    const fetchPage = vi.fn(async (params: { after?: string; limit?: number }) => {
      seenAfter.push(params.after);
      return pages[i++]!;
    });

    const out: string[] = [];
    for await (const item of paginate(fetchPage, { limit: 5 })) out.push(item);

    expect(out).toEqual(["a", "b"]);
    expect(seenAfter).toEqual([undefined, "c1"]);
  });

  it("preserves filter params from the initial call across pages", async () => {
    const seen: Array<{ status?: string; limit?: number; after?: string }> = [];
    const pages = [
      { object: "list" as const, data: ["m1"], pagination: { has_more: true, next_cursor: "x" } },
      { object: "list" as const, data: ["m2"], pagination: { has_more: false } },
    ];
    let i = 0;
    const fetchPage = vi.fn(
      async (params: { status?: string; limit?: number; after?: string }) => {
        seen.push(params);
        return pages[i++]!;
      },
    );

    for await (const _ of paginate(fetchPage, { status: "queued", limit: 50 })) {
      // drain
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ status: "queued", limit: 50 });
    expect(seen[1]).toEqual({ status: "queued", limit: 50, after: "x" });
  });

  it("collect() drains and respects an explicit limit", async () => {
    const pages = [
      { object: "list" as const, data: [1, 2, 3], pagination: { has_more: true, next_cursor: "x" } },
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
  function makeClient(handler: (call: number) => Response): AhaSendClient {
    let n = 0;
    const fetchImpl: FetchImpl = vi.fn(async () => handler(++n)) as unknown as FetchImpl;
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
            data: [{ object: "message", id: "m1" }, { object: "message", id: "m2" }],
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

    const ids: string[] = [];
    for await (const msg of client.messages.iterate()) ids.push(msg.id);
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });

  it("client.suppressions.iterate() can be drained with collect-like loop", async () => {
    const client = makeClient(() =>
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
});
