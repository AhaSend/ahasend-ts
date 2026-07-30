import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
import { resolveConfig } from "../src/config.js";
import { AhaSendAbortError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { OperationExecutor } from "../src/operations.js";

type FetchImpl = typeof fetch;

interface LifecycleFixture {
  name: string;
  status: number;
  headers: Record<string, string>;
}

const lifecycleFixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/fixtures/idempotency-responses.json"), "utf8"),
) as { classifications: LifecycleFixture[] };

function fixture(name: string): LifecycleFixture {
  const found = lifecycleFixtures.classifications.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing idempotency lifecycle fixture ${JSON.stringify(name)}`);
  return found;
}

function mockFetch(
  handler: (url: string, init: RequestInit, attempt: number) => Response | Promise<Response>,
): FetchImpl {
  let attempt = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    attempt++;
    return handler(input.toString(), init ?? {}, attempt);
  }) as unknown as FetchImpl;
}

describe("deterministic execution state machines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one keyed execution through in-progress and released retry states", async () => {
    const inProgress = fixture("in-progress execution");
    const released = fixture("released server failure");
    const calls: Array<{ url: string; body: BodyInit | null | undefined; key?: string }> = [];
    const events: string[] = [];
    const fetch = mockFetch((url, init, attempt) => {
      const key = (init.headers as Record<string, string>)["idempotency-key"];
      calls.push({ url, body: init.body, ...(key ? { key } : {}) });

      if (attempt === 1) {
        return new Response(JSON.stringify({ message: "still running" }), {
          status: inProgress.status,
          headers: inProgress.headers,
        });
      }
      if (attempt === 2) {
        return new Response(JSON.stringify({ message: "lease released" }), {
          status: released.status,
          headers: released.headers,
        });
      }
      return new Response(JSON.stringify({ object: "domain", domain: "example.com" }), {
        status: 201,
        headers: { "idempotent-replayed": "true" },
      });
    });
    const client = new HttpClient(
      resolveConfig({
        apiKey: "aha-sk-test",
        baseUrl: "https://api.test",
        fetch,
        retry: {
          maxRetries: 2,
          baseDelayMs: 100,
          maxDelayMs: 2000,
          strategy: "constant",
          jitter: false,
        },
        hooks: {
          onRequest: ({ attempt }) => {
            events.push(`request:${attempt}`);
          },
          onResponse: ({ attempt, status }) => {
            events.push(`response:${attempt}:${status}`);
          },
          onError: ({ attempt, status }) => {
            events.push(`error:${attempt}:${status}`);
          },
          onRetry: ({ attempt, delayMs }) => {
            events.push(`retry:${attempt}:${delayMs}`);
          },
        },
      }),
    );
    const executor = new OperationExecutor(client);
    const body = { domain: "example.com" };
    const request = executor
      .execute<{
        object: string;
        domain: string;
      }>(
        "createDomain",
        { path: { account_id: "acc_1" }, body },
        { idempotencyKey: "execution-key" },
      )
      .withResponse();

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(99);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    const result = await request;
    expect(result.data).toEqual({ object: "domain", domain: "example.com" });
    expect(result.idempotentReplayed).toBe(true);
    expect(calls).toEqual([
      {
        url: "https://api.test/v2/accounts/acc_1/domains",
        body: JSON.stringify(body),
        key: "execution-key",
      },
      {
        url: "https://api.test/v2/accounts/acc_1/domains",
        body: JSON.stringify(body),
        key: "execution-key",
      },
      {
        url: "https://api.test/v2/accounts/acc_1/domains",
        body: JSON.stringify(body),
        key: "execution-key",
      },
    ]);
    expect(events).toEqual([
      "request:1",
      `response:1:${inProgress.status}`,
      `error:1:${inProgress.status}`,
      "retry:1:2000",
      "request:2",
      `response:2:${released.status}`,
      `error:2:${released.status}`,
      "retry:2:100",
      "request:3",
      "response:3:201",
    ]);
  });

  it("removes caller-cancelled work from a paced FIFO without starting its timeout", async () => {
    const events: string[] = [];
    const fetch = mockFetch(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new HttpClient(
      resolveConfig({
        apiKey: "aha-sk-test",
        baseUrl: "https://api.test",
        fetch,
        timeoutMs: 100,
        retry: { enabled: false },
        rateLimit: { enabled: true, standard: { requestsPerSecond: 1, burst: 1 } },
        hooks: {
          onRequest: ({ routeTemplate }) => {
            events.push(`request:${routeTemplate}`);
          },
          onResponse: ({ routeTemplate }) => {
            events.push(`response:${routeTemplate}`);
          },
          onError: ({ routeTemplate }) => {
            events.push(`error:${routeTemplate}`);
          },
        },
      }),
    );

    await client.request({ method: "GET", path: "/first" });
    const controller = new AbortController();
    const cancelled = client.request({
      method: "GET",
      path: "/cancelled",
      signal: controller.signal,
    });
    const survivor = client.request({ method: "GET", path: "/survivor" });

    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);

    controller.abort("consumer stopped waiting");
    await expect(cancelled).rejects.toBeInstanceOf(AhaSendAbortError);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(survivor).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "request:/first",
      "response:/first",
      "error:/cancelled",
      "request:/survivor",
      "response:/survivor",
    ]);
  });

  it("keeps pagination lazy and honors cancellation before the next page transition", async () => {
    const urls: string[] = [];
    const fetch = mockFetch((url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { object: "message", id: "m1" },
            { object: "message", id: "m2" },
          ],
          pagination: { has_more: true, next_cursor: "page-2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "acc_1",
      baseUrl: "https://api.test",
      fetch,
      retry: { enabled: false },
    });
    const controller = new AbortController();
    const iterator = client.messages.iterate(
      { limit: 2, status: "queued" },
      { signal: controller.signal },
    );

    await expect(iterator.next()).resolves.toMatchObject({ value: { id: "m1" }, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ value: { id: "m2" }, done: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    const firstPageQuery = new URL(urls[0]!).searchParams;
    expect(Object.fromEntries(firstPageQuery)).toEqual({ limit: "2", status: "queued" });

    controller.abort("stop before page 2");
    await expect(iterator.next()).rejects.toBeInstanceOf(AhaSendAbortError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
