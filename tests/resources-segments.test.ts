import { describe, expect, expectTypeOf, it } from "vitest";
import { AhaSendClient } from "../src/client.js";
import {
  AhaSendConfigurationError,
  AhaSendConflictError,
  AhaSendIdempotencyConflictError,
  AhaSendNotFoundError,
} from "../src/errors.js";
import type {
  CreateSegmentRequest,
  Segment,
  SegmentContact,
  SegmentDefinition,
  SegmentDetail,
  SegmentPreview,
  UpdateSegmentRequest,
} from "../src/resources/segments.js";
import {
  ACCOUNT_ID,
  captureFetch,
  LIST_ID,
  makeClient,
  SEGMENT_ID,
} from "./helpers/resource-call.js";

const CONTACT_ID = "16161616-1616-4616-8616-161616161616";
const SEGMENT_PATH = `/v2/accounts/${ACCOUNT_ID}/segments`;
const RAW_EMAIL = "User+Tag/Segment%50@Example.COM";
const ENCODED_EMAIL = "User%2BTag%2FSegment%2550%40Example.COM";

const DEFINITION = {
  schema_version: 1,
  match: "all",
  conditions: [
    { field: "attributes.country", op: "equal", value: "DE" },
    { field: "list", op: "in", value: LIST_ID },
    {
      match: "any",
      conditions: [
        { field: "any_campaign", op: "clicked", value: "14 days ago" },
        {
          field: "campaign_count",
          op: "opened_at_least",
          value: { count: 3, since: "90 days ago" },
        },
        { field: "first_name", op: "is_empty", value: null },
      ],
    },
  ],
} as const satisfies SegmentDefinition;

const SEGMENT = {
  object: "segment",
  id: SEGMENT_ID,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:00:00Z",
  name: "Engaged customers",
  description: "",
  definition: DEFINITION,
  timezone: "Europe/Berlin",
  state: "building",
  failure_reason: null,
  member_count: 0,
  last_evaluated_at: null,
} as const;

const SEGMENT_CONTACT = {
  object: "segment_contact",
  segment_id: SEGMENT_ID,
  contact_id: CONTACT_ID,
  email: "user+tag@example.com",
  entered_at: "2026-10-20T10:05:00Z",
} as const;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function page(data: unknown[], pagination: Record<string, unknown>): Response {
  return json({ object: "list", data, pagination });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function retryingClient(fetch: typeof globalThis.fetch): AhaSendClient {
  return new AhaSendClient({
    apiKey: "aha-sk-test",
    accountId: ACCOUNT_ID,
    baseUrl: "https://api.test",
    fetch,
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
  });
}

describe("SegmentsClient", () => {
  it("list() sends one cursor and the limit, and returns segments", async () => {
    const { fetch, calls } = captureFetch(() =>
      page([SEGMENT], { has_more: true, next_cursor: "next-segment", previous_cursor: null }),
    );

    const result = await makeClient(fetch).segments.list(
      { limit: 25, before: "previous-page" },
      { headers: { "x-trace-id": "segments-1" } },
    );

    const url = new URL(calls[0]!.url);
    expect(calls[0]!.operationId).toBe("getSegments");
    expect(calls[0]!.method).toBe("GET");
    expect(url.pathname).toBe(SEGMENT_PATH);
    expect(url.search).toBe("?limit=25&before=previous-page");
    expect(calls[0]!.headers["x-trace-id"]).toBe("segments-1");
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
    expect(calls[0]!.body).toBeUndefined();
    expect(result.data[0]!.definition).toEqual(DEFINITION);
    expectTypeOf(result.data[0]!).toEqualTypeOf<Segment>();
  });

  it("list() sends no query at all when the caller passes none", async () => {
    const { fetch, calls } = captureFetch(() => page([], { has_more: false }));

    await makeClient(fetch).segments.list();

    expect(new URL(calls[0]!.url).search).toBe("");
  });

  it("iterate() follows next_cursor and keeps the limit and options on every page", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      page(
        [{ ...SEGMENT, name: `segment-${index}` }],
        index === 0
          ? { has_more: true, next_cursor: "second-page", previous_cursor: null }
          : { has_more: false, next_cursor: null, previous_cursor: "first-page" },
      ),
    );
    const names: string[] = [];

    for await (const segment of makeClient(fetch).segments.iterate(
      { limit: 1 },
      { headers: { "x-trace-id": "segments-2" } },
    )) {
      names.push(segment.name);
    }

    expect(names).toEqual(["segment-0", "segment-1"]);
    expect(calls.map(({ url }) => new URL(url).search)).toEqual([
      "?limit=1",
      "?limit=1&after=second-page",
    ]);
    expect(calls.every(({ headers }) => headers["x-trace-id"] === "segments-2")).toBe(true);
  });

  it("create() sends the definition with the caller's idempotency key", async () => {
    const { fetch, calls } = captureFetch(() => json(SEGMENT, 201));
    const body: CreateSegmentRequest = {
      name: "Engaged customers",
      description: null,
      definition: DEFINITION,
      timezone: "Europe/Berlin",
    };

    const segment = await makeClient(fetch).segments.create(body, {
      idempotencyKey: "segment-create-1",
    });

    expect(calls[0]!.operationId).toBe("createSegment");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`https://api.test${SEGMENT_PATH}`);
    expect(calls[0]!.headers["idempotency-key"]).toBe("segment-create-1");
    expect(JSON.parse(calls[0]!.body!)).toEqual(body);
    expect(segment.state).toBe("building");
  });

  it("create() retries a 5xx with the key it generated", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      index === 0 ? json({ message: "bad gateway" }, 502) : json(SEGMENT, 201),
    );

    await expect(
      retryingClient(fetch).segments.create({ name: "Retried", definition: DEFINITION }),
    ).resolves.toEqual(SEGMENT);

    expect(calls).toHaveLength(2);
    const generated = calls[0]!.headers["idempotency-key"];
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.headers["idempotency-key"]).toBe(generated);
  });

  it("create() maps a refusal and an in-progress key to different 409 errors", async () => {
    const responses = [
      json({ message: "An account can have at most 100 segments." }, 409),
      json({ message: "request in progress" }, 409, {
        "idempotent-replayed": "false",
        "retry-after": "3",
      }),
    ];
    const { fetch } = captureFetch((_call, index) => responses[index]!);
    const client = makeClient(fetch);
    const body = { name: "One too many", definition: DEFINITION };

    const refused = await rejectionOf(client.segments.create(body));
    // The client retries an in-progress key, so this call turns retries off.
    const inProgress = await rejectionOf(client.segments.create(body, { retry: false }));

    expect(refused).toBeInstanceOf(AhaSendConflictError);
    expect(refused).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect(inProgress).toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect((inProgress as AhaSendIdempotencyConflictError).retryAfterSeconds).toBe(3);
  });

  it("preview() posts the definition without an idempotency key and is not retried", async () => {
    const preview = {
      object: "segment_preview",
      count: null,
      contacts: [{ contact_id: CONTACT_ID, email: "user+tag@example.com" }],
    } as const;
    const responses = [json(preview), json({ message: "bad gateway" }, 502)];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const client = retryingClient(fetch);
    const body = { definition: DEFINITION, timezone: null };

    const result = await client.segments.preview(body);
    const failure = await rejectionOf(client.segments.preview(body));

    expect(calls[0]!.operationId).toBe("previewSegment");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`https://api.test${SEGMENT_PATH}/preview`);
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
    expect(JSON.parse(calls[0]!.body!)).toEqual(body);
    expect(result.count).toBeNull();
    expectTypeOf(result).toEqualTypeOf<SegmentPreview>();
    expect(failure).toMatchObject({ status: 502 });
    expect(calls).toHaveLength(2);
  });

  it("get() addresses the segment UUID and returns its marketable count", async () => {
    const detail = { ...SEGMENT, state: "ready", member_count: 4, marketable_count: 3 } as const;
    const { fetch, calls } = captureFetch(() => json(detail));
    const client = makeClient(fetch);

    const segment = await client.segments.get(SEGMENT_ID);

    expect(calls[0]!.operationId).toBe("getSegment");
    expect(calls[0]!.url).toBe(`https://api.test${SEGMENT_PATH}/${SEGMENT_ID}`);
    expect(segment.marketable_count).toBe(3);
    expectTypeOf(segment).toEqualTypeOf<SegmentDetail>();
    expect(() => client.segments.get("../contacts")).toThrow(/expected uuid/);
    expect(calls).toHaveLength(1);
  });

  it.each<[string, UpdateSegmentRequest, string]>([
    ["an empty body, which builds a failed segment again", {}, "{}"],
    [
      "null leaves each field unchanged",
      { name: null, description: null, definition: null, timezone: null },
      '{"name":null,"description":null,"definition":null,"timezone":null}',
    ],
    ["a new name alone", { name: "Renamed" }, '{"name":"Renamed"}'],
  ])("update() sends %s exactly as given", async (_label, body, wire) => {
    const { fetch, calls } = captureFetch(() => json(SEGMENT));

    await makeClient(fetch).segments.update(SEGMENT_ID, body);

    expect(calls[0]!.operationId).toBe("updateSegment");
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://api.test${SEGMENT_PATH}/${SEGMENT_ID}`);
    expect(calls[0]!.body).toBe(wire);
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
  });

  it("update() and delete() return a busy segment's 409 without retrying it", async () => {
    const busy = () =>
      json({ message: "The segment is being updated. Try again in a minute." }, 409);
    const { fetch, calls } = captureFetch(busy);
    const client = retryingClient(fetch);

    const updated = await rejectionOf(client.segments.update(SEGMENT_ID, { name: "Renamed" }));
    const deleted = await rejectionOf(client.segments.delete(SEGMENT_ID));

    expect(updated).toBeInstanceOf(AhaSendConflictError);
    expect(updated).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect(deleted).toBeInstanceOf(AhaSendConflictError);
    expect(calls.map(({ method, operationId }) => `${method} ${operationId}`)).toEqual([
      "PUT updateSegment",
      "DELETE deleteSegment",
    ]);
  });

  it("delete() dispatches deleteSegment with no key and maps a missing segment", async () => {
    const responses = [json({ message: "segment deleted" }), json({ message: "not found" }, 404)];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const client = makeClient(fetch);

    await expect(client.segments.delete(SEGMENT_ID)).resolves.toEqual({
      message: "segment deleted",
    });
    const missing = await rejectionOf(client.segments.delete(SEGMENT_ID));

    expect(calls[0]!.url).toBe(`https://api.test${SEGMENT_PATH}/${SEGMENT_ID}`);
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
    expect(calls[0]!.body).toBeUndefined();
    expect(missing).toBeInstanceOf(AhaSendNotFoundError);
  });

  it("create(), preview() and update() refuse empty conditions before dispatch", () => {
    const { fetch, calls } = captureFetch();
    const client = makeClient(fetch);
    const empty = { schema_version: 1, match: "all", conditions: [] } as const;
    const emptyGroup = {
      schema_version: 1,
      match: "all",
      conditions: [{ match: "any", conditions: [] }],
    } as const;

    expect(() => client.segments.create({ name: "Empty", definition: empty })).toThrow(
      AhaSendConfigurationError,
    );
    expect(() => client.segments.preview({ definition: emptyGroup })).toThrow(
      "`definition.conditions[0].conditions` must contain at least one item",
    );
    expect(() => client.segments.update(SEGMENT_ID, { definition: empty })).toThrow(
      "`definition.conditions` must contain at least one item",
    );
    expect(calls).toHaveLength(0);
  });

  it("exposes one frozen, stable contacts facade", () => {
    const client = makeClient(captureFetch().fetch);

    expect(client.segments.contacts).toBe(client.segments.contacts);
    expect(Object.isFrozen(client.segments.contacts)).toBe(true);
    expect(Object.isFrozen(client.segments)).toBe(true);
  });
});

describe("SegmentContactsClient", () => {
  it("list() addresses the segment and sends no query when the caller passes none", async () => {
    const { fetch, calls } = captureFetch(() => page([SEGMENT_CONTACT], { has_more: false }));

    const result = await makeClient(fetch).segments.contacts.list(SEGMENT_ID);

    expect(calls[0]!.operationId).toBe("getSegmentContacts");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`https://api.test${SEGMENT_PATH}/${SEGMENT_ID}/contacts`);
    expectTypeOf(result.data).toEqualTypeOf<SegmentContact[]>();
    expect(result.data[0]!.entered_at).toBe("2026-10-20T10:05:00Z");
  });

  it("iterate() follows next_cursor and keeps the segment path on every page", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      page(
        [SEGMENT_CONTACT],
        index === 0 ? { has_more: true, next_cursor: CONTACT_ID } : { has_more: false },
      ),
    );
    let count = 0;

    for await (const _member of makeClient(fetch).segments.contacts.iterate(SEGMENT_ID, {
      limit: 50,
    })) {
      count += 1;
    }

    expect(count).toBe(2);
    expect(calls.map(({ url }) => url)).toEqual([
      `https://api.test${SEGMENT_PATH}/${SEGMENT_ID}/contacts?limit=50`,
      `https://api.test${SEGMENT_PATH}/${SEGMENT_ID}/contacts?limit=50&after=${CONTACT_ID}`,
    ]);
  });

  it("list() rejects a segment id that is not a UUID before dispatch", () => {
    const { fetch, calls } = captureFetch();

    expect(() => makeClient(fetch).segments.contacts.list("not-a-segment")).toThrow(
      /expected uuid/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("ContactSegmentsClient", () => {
  it("list() encodes a raw email once and returns segments", async () => {
    const { fetch, calls } = captureFetch(() => page([SEGMENT], { has_more: false }));

    const result = await makeClient(fetch).contacts.segments.list(RAW_EMAIL);

    expect(calls[0]!.operationId).toBe("getContactSegments");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      `https://api.test/v2/accounts/${ACCOUNT_ID}/contacts/${ENCODED_EMAIL}/segments`,
    );
    expectTypeOf(result.data).toEqualTypeOf<Segment[]>();
  });

  it("iterate() pages one contact's segments lazily", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      page([SEGMENT], index === 0 ? { has_more: true, next_cursor: "next" } : { has_more: false }),
    );
    const iterator = makeClient(fetch).contacts.segments.iterate(CONTACT_ID);

    expect(calls).toHaveLength(0);
    let count = 0;
    for await (const _segment of iterator) count += 1;

    expect(count).toBe(2);
    expect(calls.map(({ url }) => new URL(url).search)).toEqual(["", "?after=next"]);
    expect(new URL(calls[0]!.url).pathname).toBe(
      `/v2/accounts/${ACCOUNT_ID}/contacts/${CONTACT_ID}/segments`,
    );
  });

  it("list() maps an unknown contact to the not-found error", async () => {
    const { fetch } = captureFetch(() => json({ message: "Contact not found" }, 404));

    const error = await rejectionOf(makeClient(fetch).contacts.segments.list(RAW_EMAIL));

    expect(error).toBeInstanceOf(AhaSendNotFoundError);
  });

  it("hangs one frozen, stable facade off the contacts client", () => {
    const client = makeClient(captureFetch().fetch);

    expect(client.contacts.segments).toBe(client.contacts.segments);
    expect(Object.isFrozen(client.contacts.segments)).toBe(true);
  });
});
