import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AhaSendBadRequestError,
  AhaSendConflictError,
  AhaSendIdempotencyConflictError,
  AhaSendNotFoundError,
  AhaSendPermissionError,
} from "../src/errors.js";
import type {
  BatchAddListContactsResponse,
  ListContact,
  ListListContactsParams,
  UpsertListContactRequest,
} from "../src/resources/list-contacts.js";
import type { ListContactListsParams } from "../src/resources/contact-lists.js";
import type {
  ContactList,
  ListListsParams,
  UpdateContactListRequest,
} from "../src/resources/lists.js";
import { ACCOUNT_ID, captureFetch, LIST_ID, makeClient } from "./helpers/resource-call.js";

const CONTACT_ID = "12121212-1212-4212-8212-121212121212";
const LIST_PATH = `/v2/accounts/${ACCOUNT_ID}/lists`;
const RAW_EMAIL = "User+Tag/Segment%50@Example.COM";
const ENCODED_EMAIL = "User%2BTag%2FSegment%2550%40Example.COM";

const LIST_RESPONSE = {
  object: "contact_list",
  id: LIST_ID,
  created_at: "2026-09-20T10:00:00Z",
  updated_at: "2026-09-20T11:00:00Z",
  name: "Product updates",
  description: "Monthly release notes",
  tags: ["product"],
  contact_count: 2,
} as const;

const { contact_count: _contactCount, ...EMBEDDED_LIST } = LIST_RESPONSE;

const CONTACT = {
  object: "contact",
  id: CONTACT_ID,
  created_at: "2026-09-10T10:00:00Z",
  updated_at: "2026-09-10T11:00:00Z",
  email: "user+tag@example.com",
  first_name: "Pat",
  last_name: "Example",
  status: "enabled",
  status_reason: "",
  unsubscribed: false,
  unsubscribed_at: null,
  attributes: {},
  validation_status: "valid",
  last_validated_at: "2026-09-11T00:00:00Z",
} as const;

const MEMBERSHIP = {
  object: "list_contact",
  list_id: LIST_ID,
  contact_id: CONTACT_ID,
  email: "user+tag@example.com",
  subscription_status: "confirmed",
  subscribed_at: "2026-09-20T12:00:00Z",
  unsubscribed_at: null,
  created_at: "2026-09-20T12:00:00Z",
  updated_at: "2026-09-20T12:00:00Z",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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

describe("ListsClient", () => {
  it("list() sends the name filter and one cursor, and types contact_count", async () => {
    const { fetch, calls } = captureFetch(() =>
      page([LIST_RESPONSE], { has_more: true, next_cursor: "next-list", previous_cursor: null }),
    );
    const client = makeClient(fetch);
    const params: ListListsParams = { limit: 25, before: "previous-page", name: "news" };

    const result = await client.lists.list(params, { headers: { "x-trace-id": "lists-1" } });

    const url = new URL(calls[0]!.url);
    expect(calls[0]!.operationId).toBe("getLists");
    expect(calls[0]!.method).toBe("GET");
    expect(url.pathname).toBe(LIST_PATH);
    expect(url.search).toBe("?limit=25&before=previous-page&name=news");
    expect(calls[0]!.headers["x-trace-id"]).toBe("lists-1");
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
    expect(calls[0]!.body).toBeUndefined();
    expect(result.data[0]!.contact_count).toBe(2);
    expectTypeOf(result.data[0]!).toEqualTypeOf<ContactList>();
    expect(result.pagination).toEqual({
      has_more: true,
      next_cursor: "next-list",
      previous_cursor: null,
    });
  });

  it("list() sends no query at all when the caller passes none", async () => {
    const { fetch, calls } = captureFetch(() => page([], { has_more: false }));

    await makeClient(fetch).lists.list();

    expect(new URL(calls[0]!.url).search).toBe("");
  });

  it("list() refuses both cursors before dispatch", () => {
    const { fetch, calls } = captureFetch();
    const both = { after: "a", before: "b" } as unknown as ListListsParams;

    expect(() => makeClient(fetch).lists.list(both)).toThrow(/after.*before|before.*after/);
    expect(calls).toHaveLength(0);
  });

  it("iterate() follows next_cursor and keeps the filter and options on every page", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      page(
        [{ ...LIST_RESPONSE, name: `list-${index}` }],
        index === 0
          ? { has_more: true, next_cursor: "second-page", previous_cursor: null }
          : { has_more: false, next_cursor: null, previous_cursor: "first-page" },
      ),
    );
    const client = makeClient(fetch);

    const names: string[] = [];
    for await (const list of client.lists.iterate(
      { limit: 1, name: "list" },
      { headers: { "x-trace-id": "lists-iterator" } },
    )) {
      names.push(list.name);
    }

    expect(names).toEqual(["list-0", "list-1"]);
    expect(calls.map(({ operationId }) => operationId)).toEqual(["getLists", "getLists"]);
    expect(new URL(calls[0]!.url).search).toBe("?limit=1&name=list");
    expect(new URL(calls[1]!.url).search).toBe("?limit=1&after=second-page&name=list");
    expect(calls.map(({ headers }) => headers["x-trace-id"])).toEqual([
      "lists-iterator",
      "lists-iterator",
    ]);
  });

  it("get() addresses the list UUID and rejects anything else before dispatch", async () => {
    const { fetch, calls } = captureFetch(() => json(LIST_RESPONSE));
    const client = makeClient(fetch);

    const list = await client.lists.get(LIST_ID);

    expect(calls[0]!.url).toBe(`https://api.test${LIST_PATH}/${LIST_ID}`);
    expect(calls[0]!.operationId).toBe("getList");
    expect(list).toEqual(LIST_RESPONSE);
    expect(() => client.lists.get("../contacts")).toThrow(/expected uuid/);
    expect(calls).toHaveLength(1);
  });

  it("create() sends the body with the caller's idempotency key", async () => {
    const { fetch, calls } = captureFetch(() => json({ ...LIST_RESPONSE, contact_count: 0 }, 201));
    const client = makeClient(fetch);

    const list = await client.lists.create(
      { name: "Product updates", description: null, tags: ["product"] },
      { idempotencyKey: "list-create-1" },
    );

    expect(calls[0]!.operationId).toBe("createList");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`https://api.test${LIST_PATH}`);
    expect(calls[0]!.headers["idempotency-key"]).toBe("list-create-1");
    expect(calls[0]!.body).toBe('{"name":"Product updates","description":null,"tags":["product"]}');
    expect(list.contact_count).toBe(0);
  });

  it("create() generates an idempotency key when the caller supplies none", async () => {
    const { fetch, calls } = captureFetch(() => json(LIST_RESPONSE, 201));

    await makeClient(fetch).lists.create({ name: "Generated key" });

    expect(calls[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each<[string, UpdateContactListRequest, string]>([
    ["an empty body changes nothing", {}, "{}"],
    [
      "null leaves each field unchanged",
      { name: null, description: null, tags: null },
      '{"name":null,"description":null,"tags":null}',
    ],
    [
      "an empty description and tags clear them",
      { description: "", tags: [] },
      '{"description":"","tags":[]}',
    ],
    ["a new name alone", { name: "Renamed" }, '{"name":"Renamed"}'],
  ])("update() sends %s exactly as given", async (_label, body, wire) => {
    const { fetch, calls } = captureFetch(() => json(LIST_RESPONSE));

    await makeClient(fetch).lists.update(LIST_ID, body);

    expect(calls[0]!.operationId).toBe("updateList");
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://api.test${LIST_PATH}/${LIST_ID}`);
    expect(calls[0]!.body).toBe(wire);
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
  });

  it("update() surfaces the server's blank-name rejection as a bad request", async () => {
    const { fetch } = captureFetch(() => json({ message: "name must not be empty" }, 400));

    const error = await rejectionOf(makeClient(fetch).lists.update(LIST_ID, { name: "   " }));

    expect(error).toBeInstanceOf(AhaSendBadRequestError);
    expect((error as AhaSendBadRequestError).message).toBe("name must not be empty");
  });

  it("delete() dispatches deleteList and maps a campaign conflict and a missing list", async () => {
    const responses = [
      json({ message: "list deleted" }),
      json({ message: "list is used by a campaign that still needs it" }, 409),
      json({ message: "list not found" }, 404),
    ];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const client = makeClient(fetch);

    await expect(client.lists.delete(LIST_ID)).resolves.toEqual({ message: "list deleted" });
    const conflict = await rejectionOf(client.lists.delete(LIST_ID));
    const missing = await rejectionOf(client.lists.delete(LIST_ID));

    expect(calls.map(({ method, operationId }) => `${method} ${operationId}`)).toEqual([
      "DELETE deleteList",
      "DELETE deleteList",
      "DELETE deleteList",
    ]);
    expect(conflict).toBeInstanceOf(AhaSendConflictError);
    expect(conflict).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect(missing).toBeInstanceOf(AhaSendNotFoundError);
  });

  it("exposes one frozen, stable contacts facade", () => {
    const client = makeClient(captureFetch().fetch);

    expect(client.lists.contacts).toBe(client.lists.contacts);
    expect(Object.isFrozen(client.lists.contacts)).toBe(true);
    expect(Object.isFrozen(client.lists)).toBe(true);
  });
});

describe("ListContactsClient", () => {
  it.each<[boolean, string]>([
    [true, "true"],
    [false, "false"],
  ])("list() sends include_contacts=%s as the literal %s", async (include, literal) => {
    const { fetch, calls } = captureFetch(() =>
      page([include ? { ...MEMBERSHIP, contact: CONTACT } : MEMBERSHIP], { has_more: false }),
    );
    const params: ListListContactsParams = {
      subscription_status: "complained",
      email: "User+Tag@Example.COM",
      include_contacts: include,
      limit: 10,
      after: "cursor",
    };

    const result = await makeClient(fetch).lists.contacts.list(LIST_ID, params);

    const url = new URL(calls[0]!.url);
    expect(calls[0]!.operationId).toBe("getListContacts");
    expect(url.pathname).toBe(`${LIST_PATH}/${LIST_ID}/contacts`);
    expect(url.searchParams.get("include_contacts")).toBe(literal);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "10",
      after: "cursor",
      subscription_status: "complained",
      email: "User+Tag@Example.COM",
      include_contacts: literal,
    });
    expect(result.data[0]!.contact).toEqual(include ? CONTACT : undefined);
  });

  it("list() leaves include_contacts off the wire when the caller omits it", async () => {
    const { fetch, calls } = captureFetch(() => page([], { has_more: false }));

    await makeClient(fetch).lists.contacts.list(LIST_ID);

    expect(new URL(calls[0]!.url).search).toBe("");
  });

  it("list() surfaces a missing contacts:read on include_contacts as a permission error", async () => {
    const { fetch } = captureFetch(() =>
      json({ message: "include_contacts requires the contacts:read scope" }, 403),
    );

    const error = await rejectionOf(
      makeClient(fetch).lists.contacts.list(LIST_ID, { include_contacts: true }),
    );

    expect(error).toBeInstanceOf(AhaSendPermissionError);
    expect((error as AhaSendPermissionError).message).toBe(
      "include_contacts requires the contacts:read scope",
    );
  });

  it("iterate() pages a list's members and keeps the list path on every page", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      page(
        [{ ...MEMBERSHIP, email: `member-${index}@example.com` }],
        index === 0
          ? { has_more: true, next_cursor: "members-2", previous_cursor: null }
          : { has_more: false, next_cursor: null, previous_cursor: null },
      ),
    );

    const emails: string[] = [];
    for await (const membership of makeClient(fetch).lists.contacts.iterate(LIST_ID, {
      subscription_status: "confirmed",
    })) {
      emails.push(membership.email);
    }

    expect(emails).toEqual(["member-0@example.com", "member-1@example.com"]);
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      `${LIST_PATH}/${LIST_ID}/contacts`,
      `${LIST_PATH}/${LIST_ID}/contacts`,
    ]);
    expect(new URL(calls[1]!.url).search).toBe("?after=members-2&subscription_status=confirmed");
  });

  it("list() rejects a list id that is not a UUID before dispatch", () => {
    const { fetch, calls } = captureFetch();

    expect(() => makeClient(fetch).lists.contacts.list("newsletter")).toThrow(/expected uuid/);
    expect(calls).toHaveLength(0);
  });

  it.each<[string, UpsertListContactRequest | undefined, string]>([
    ["no body as an empty object", undefined, "{}"],
    ["an empty object unchanged", {}, "{}"],
    ["a null status", { subscription_status: null }, '{"subscription_status":null}'],
    [
      "an unsubscribe",
      { subscription_status: "unsubscribed" },
      '{"subscription_status":"unsubscribed"}',
    ],
  ])("upsert() sends %s", async (_label, body, wire) => {
    const { fetch, calls } = captureFetch(() => json(MEMBERSHIP));

    const membership = await makeClient(fetch).lists.contacts.upsert(LIST_ID, RAW_EMAIL, body);

    expect(calls[0]!.operationId).toBe("upsertListContact");
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://api.test${LIST_PATH}/${LIST_ID}/contacts/${ENCODED_EMAIL}`);
    expect(calls[0]!.body).toBe(wire);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
    expect(membership).toEqual(MEMBERSHIP);
  });

  it("upsert() forwards request options alongside an explicit body", async () => {
    const { fetch, calls } = captureFetch(() => json(MEMBERSHIP));

    await makeClient(fetch).lists.contacts.upsert(
      LIST_ID,
      CONTACT_ID,
      {},
      { headers: { "x-trace-id": "upsert-1" } },
    );

    expect(calls[0]!.url).toBe(`https://api.test${LIST_PATH}/${LIST_ID}/contacts/${CONTACT_ID}`);
    expect(calls[0]!.headers["x-trace-id"]).toBe("upsert-1");
  });

  it("upsert() and delete() surface a complained membership as a plain conflict", async () => {
    const responses = [
      json(
        {
          message: "contact reported this list as spam and their membership cannot be changed",
        },
        409,
      ),
      json(
        {
          message: "contact reported this list as spam and their membership cannot be removed",
        },
        409,
      ),
    ];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const client = makeClient(fetch);

    const upsert = await rejectionOf(
      client.lists.contacts.upsert(LIST_ID, RAW_EMAIL, { subscription_status: "confirmed" }),
    );
    const removal = await rejectionOf(client.lists.contacts.delete(LIST_ID, RAW_EMAIL));

    expect(calls.map(({ operationId }) => operationId)).toEqual([
      "upsertListContact",
      "deleteListContact",
    ]);
    for (const error of [upsert, removal]) {
      expect(error).toBeInstanceOf(AhaSendConflictError);
      expect(error).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
      expect((error as AhaSendConflictError).status).toBe(409);
    }
    expect((removal as AhaSendConflictError).message).toContain("cannot be removed");
  });

  it("upsert() surfaces a complained status in the body as the server's bad request", async () => {
    const { fetch } = captureFetch(() =>
      json(
        { message: "subscription_status must be confirmed, unconfirmed, unsubscribed, or null" },
        400,
      ),
    );
    const complained = { subscription_status: "complained" } as unknown as UpsertListContactRequest;

    const error = await rejectionOf(
      makeClient(fetch).lists.contacts.upsert(LIST_ID, CONTACT_ID, complained),
    );

    expect(error).toBeInstanceOf(AhaSendBadRequestError);
  });

  it.each([
    ["list", "list not found"],
    ["contact", "contact not found"],
    ["membership", "list membership not found"],
  ])("delete() maps a missing %s to the not-found error", async (_label, message) => {
    const { fetch, calls } = captureFetch(() => json({ message }, 404));

    const error = await rejectionOf(makeClient(fetch).lists.contacts.delete(LIST_ID, RAW_EMAIL));

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`https://api.test${LIST_PATH}/${LIST_ID}/contacts/${ENCODED_EMAIL}`);
    expect(calls[0]!.body).toBeUndefined();
    expect(error).toBeInstanceOf(AhaSendNotFoundError);
    expect((error as AhaSendNotFoundError).message).toBe(message);
  });

  it("delete() resolves with the server's success message", async () => {
    const { fetch, calls } = captureFetch(() => json({ message: "contact removed from list" }));

    const result = await makeClient(fetch).lists.contacts.delete(LIST_ID, CONTACT_ID);

    expect(calls[0]!.operationId).toBe("deleteListContact");
    expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
    expect(result).toEqual({ message: "contact removed from list" });
  });

  it("batchAdd() sends the entries with the caller's key and returns one result per entry", async () => {
    const response: BatchAddListContactsResponse = {
      object: "list",
      added: 1,
      skipped: 1,
      failed: 3,
      data: [
        { position: 0, email: "new@example.com", outcome: "added", membership: MEMBERSHIP },
        {
          position: 1,
          id: CONTACT_ID,
          outcome: "already_member",
          membership: { ...MEMBERSHIP, subscription_status: "unsubscribed" },
        },
        {
          position: 2,
          email: "nobody@example.com",
          outcome: "not_found",
          reason: "no contact in this account matches this identifier",
        },
        {
          position: 3,
          outcome: "invalid",
          reason: "entry must name exactly one of email or id, not both",
        },
        {
          position: 4,
          email: "not-an-address",
          outcome: "invalid",
          reason: "email must be a valid email address",
        },
      ],
    };
    const { fetch, calls } = captureFetch(() => json(response));
    const body = {
      data: [
        { email: "New@Example.com" },
        { id: CONTACT_ID },
        { email: "nobody@example.com" },
        { email: "both@example.com", id: CONTACT_ID },
        { email: "not-an-address" },
      ],
    };

    const result = await makeClient(fetch).lists.contacts.batchAdd(LIST_ID, body, {
      idempotencyKey: "list-batch-1",
    });

    expect(calls[0]!.operationId).toBe("batchAddListContacts");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`https://api.test${LIST_PATH}/${LIST_ID}/contacts/batch`);
    expect(calls[0]!.headers["idempotency-key"]).toBe("list-batch-1");
    expect(calls[0]!.body).toBe(JSON.stringify(body));
    expect(result).toEqual(response);
    expect(result.data).toHaveLength(body.data.length);
    expect(result.data.map(({ position }) => position)).toEqual([0, 1, 2, 3, 4]);
    expect(result.added + result.skipped + result.failed).toBe(body.data.length);
    expectTypeOf(result.data[0]!.membership).toEqualTypeOf<ListContact | undefined>();
  });

  it("batchAdd() rejects an empty or missing data array before dispatch", () => {
    const { fetch, calls } = captureFetch();
    const contacts = makeClient(fetch).lists.contacts;

    expect(() => contacts.batchAdd(LIST_ID, { data: [] })).toThrow(
      /`data` must contain at least one item/,
    );
    expect(() =>
      contacts.batchAdd(LIST_ID, {} as unknown as Parameters<typeof contacts.batchAdd>[1]),
    ).toThrow(/`data` must be an array/);
    expect(calls).toHaveLength(0);
  });

  it("batchAdd() maps a missing list to the not-found error", async () => {
    const { fetch } = captureFetch(() => json({ message: "list not found" }, 404));

    const error = await rejectionOf(
      makeClient(fetch).lists.contacts.batchAdd(LIST_ID, { data: [{ id: CONTACT_ID }] }),
    );

    expect(error).toBeInstanceOf(AhaSendNotFoundError);
  });
});

describe("ContactListsClient", () => {
  it("list() encodes a raw email once and returns memberships with the list embedded", async () => {
    const { fetch, calls } = captureFetch(() =>
      page([{ ...MEMBERSHIP, list: EMBEDDED_LIST }], {
        has_more: false,
        next_cursor: null,
        previous_cursor: null,
      }),
    );
    const params: ListContactListsParams = { subscription_status: "unsubscribed", limit: 5 };

    const result = await makeClient(fetch).contacts.lists.list(RAW_EMAIL, params);

    const url = new URL(calls[0]!.url);
    expect(calls[0]!.operationId).toBe("getContactLists");
    expect(url.pathname).toBe(`/v2/accounts/${ACCOUNT_ID}/contacts/${ENCODED_EMAIL}/lists`);
    expect(url.search).toBe("?limit=5&subscription_status=unsubscribed");
    expect(result.data[0]!.list).toEqual(EMBEDDED_LIST);
    expect(result.data[0]!.list).not.toHaveProperty("contact_count");
    expect(result.data[0]).not.toHaveProperty("contact");
  });

  it("iterate() pages one contact's memberships lazily", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      page(
        [{ ...MEMBERSHIP, list: { ...EMBEDDED_LIST, name: `list-${index}` } }],
        index === 0
          ? { has_more: true, next_cursor: "memberships-2", previous_cursor: null }
          : { has_more: false, next_cursor: null, previous_cursor: null },
      ),
    );

    const names: string[] = [];
    for await (const membership of makeClient(fetch).contacts.lists.iterate(CONTACT_ID)) {
      names.push(membership.list!.name);
    }

    expect(names).toEqual(["list-0", "list-1"]);
    expect(calls.map(({ operationId }) => operationId)).toEqual([
      "getContactLists",
      "getContactLists",
    ]);
    expect(new URL(calls[0]!.url).pathname).toBe(
      `/v2/accounts/${ACCOUNT_ID}/contacts/${CONTACT_ID}/lists`,
    );
    expect(new URL(calls[1]!.url).search).toBe("?after=memberships-2");
  });

  it("list() maps an unknown contact to the not-found error", async () => {
    const { fetch } = captureFetch(() => json({ message: "contact not found" }, 404));

    const error = await rejectionOf(makeClient(fetch).contacts.lists.list("nobody@example.com"));

    expect(error).toBeInstanceOf(AhaSendNotFoundError);
    expect((error as AhaSendNotFoundError).body).toEqual({ message: "contact not found" });
  });

  it("hangs one frozen, stable facade off the contacts client", () => {
    const client = makeClient(captureFetch().fetch);

    expect(client.contacts.lists).toBe(client.contacts.lists);
    expect(Object.isFrozen(client.contacts.lists)).toBe(true);
  });
});
