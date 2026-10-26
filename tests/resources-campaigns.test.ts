import { describe, expect, expectTypeOf, it } from "vitest";
import { AhaSendClient } from "../src/client.js";
import {
  AhaSendBadRequestError,
  AhaSendConflictError,
  AhaSendIdempotencyConflictError,
  AhaSendRateLimitError,
} from "../src/errors.js";
import type { MarkupErrorResponse } from "../src/errors.js";
import type {
  CampaignRecipient,
  ListCampaignRecipientsParams,
} from "../src/resources/campaign-recipients.js";
import type {
  CampaignTemplate,
  UpdateCampaignTemplateRequest,
} from "../src/resources/campaign-templates.js";
import type {
  Campaign,
  CampaignListItem,
  CampaignNotReady,
  CampaignSend,
  CampaignStats,
  CampaignTest,
  CreateCampaignRequest,
  ListCampaignsParams,
  UpdateCampaignRequest,
} from "../src/resources/campaigns.js";
import type { PaginatedResponse } from "../src/types/common.js";
import {
  ACCOUNT_ID,
  CAMPAIGN_ID,
  CAMPAIGN_TEMPLATE_ID,
  captureFetch,
  LIST_ID,
  makeClient,
} from "./helpers/resource-call.js";

const CONTACT_ID = "13131313-1313-4313-8313-131313131313";
const SEGMENT_ID = "14141414-1414-4414-8414-141414141414";
const EXCLUDED_LIST_ID = "15151515-1515-4515-8515-151515151515";
const ACCOUNT_PATH = `https://api.test/v2/accounts/${ACCOUNT_ID}`;
const CAMPAIGN_PATH = `${ACCOUNT_PATH}/campaigns/${CAMPAIGN_ID}`;

const CONTENT = {
  html: '<p>Hello</p><a href="{{ unsubscribe_url }}">Unsubscribe</a>',
  text: "Hello",
  text_is_custom: false,
} as const;

const CAMPAIGN_TEMPLATE = {
  object: "campaign_template",
  id: CAMPAIGN_TEMPLATE_ID,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T11:00:00Z",
  name: "Newsletter",
  editor: "html",
  content: CONTENT,
} as const;

const CAMPAIGN_LIST_ITEM = {
  object: "campaign",
  id: CAMPAIGN_ID,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T11:00:00Z",
  name: "October newsletter",
  subject: null,
  preheader: null,
  from: { email: "news@example.com", name: "" },
  reply_to: null,
  status: "draft",
  status_reason: null,
  send_at: null,
  send_resumes_at: null,
  finished_at: null,
} as const;

const CAMPAIGN = {
  ...CAMPAIGN_LIST_ITEM,
  list_ids: [LIST_ID],
  segment_ids: [],
  exclude_list_ids: [],
  exclude_segment_ids: [],
  editor: "html",
  content: CONTENT,
  ready: false,
  issues: [
    { code: "subject_missing", message: "Add a subject before you send the campaign." },
    { code: "preheader_missing", message: "Add a preview text before you send the campaign." },
  ],
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

const MARKUP = `<Email version="1">
  <Paragraph>Hello</Paragraph>
</Email>
`;

const SIMPLE_CONTENT = { ...CONTENT, markup: MARKUP } as const;

// The text of the paragraph starts with `{{`, which stays text, so the write warns about it.
const WARNED_MARKUP = `<Email version="1">
  <Paragraph>{{ first_name }}, hello</Paragraph>
</Email>
`;

const MARKUP_WARNINGS = [
  {
    code: "jinja_in_text",
    message: "Text holds {{, which stays text",
    line: 2,
    column: 14,
    path: "Email > Paragraph[1]",
  },
];

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("CampaignTemplatesClient", () => {
  it("list() sends one cursor and returns items without content", async () => {
    const { content: _content, ...listed } = CAMPAIGN_TEMPLATE;
    const { fetch, calls } = captureFetch(() => page([listed], { has_more: false }));
    const client = makeClient(fetch);

    const result: PaginatedResponse<CampaignTemplate> = await client.campaignTemplates.list({
      limit: 10,
      after: "cursor-1",
    });

    expect(calls[0]!.operationId).toBe("listCampaignTemplates");
    expect(calls[0]!.url).toBe(`${ACCOUNT_PATH}/campaign-templates?limit=10&after=cursor-1`);
    expect(result.data[0]).not.toHaveProperty("content");
  });

  it("iterate() follows next_cursor across pages", async () => {
    const responses = [
      page([{ ...CAMPAIGN_TEMPLATE, id: "first" }], { has_more: true, next_cursor: "next" }),
      page([{ ...CAMPAIGN_TEMPLATE, id: "second" }], { has_more: false }),
    ];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const ids: string[] = [];

    for await (const template of makeClient(fetch).campaignTemplates.iterate({ limit: 1 })) {
      ids.push(template.id);
    }

    expect(ids).toEqual(["first", "second"]);
    expect(calls.map(({ url }) => new URL(url).search)).toEqual([
      "?limit=1",
      "?limit=1&after=next",
    ]);
  });

  it("create() posts the design with an idempotency key", async () => {
    const { fetch, calls } = captureFetch(() => json(CAMPAIGN_TEMPLATE, 201));
    const body = { name: "Newsletter", content: { html: CONTENT.html } };

    const template = await makeClient(fetch).campaignTemplates.create(body, {
      idempotencyKey: "campaign-template-create-1",
    });

    expect(calls[0]!.operationId).toBe("createCampaignTemplate");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${ACCOUNT_PATH}/campaign-templates`);
    expect(calls[0]!.headers["idempotency-key"]).toBe("campaign-template-create-1");
    expect(JSON.parse(calls[0]!.body!)).toEqual(body);
    expect(template.content).toEqual(CONTENT);
  });

  it("update() sends an automatic idempotency key and accepts no editor", async () => {
    const { fetch, calls } = captureFetch(() => json(CAMPAIGN_TEMPLATE));
    const body: UpdateCampaignTemplateRequest = { content: { text: null } };
    const withEditor: UpdateCampaignTemplateRequest = {
      // @ts-expect-error The editor never changes after create.
      editor: "html",
    };

    await makeClient(fetch).campaignTemplates.update(CAMPAIGN_TEMPLATE_ID, body);

    expect(calls[0]!.operationId).toBe("updateCampaignTemplate");
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`${ACCOUNT_PATH}/campaign-templates/${CAMPAIGN_TEMPLATE_ID}`);
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(calls[0]!.body).toBe('{"content":{"text":null}}');
    expect(withEditor).toBeDefined();
  });

  it("create() sends content.markup and returns the AhaML with its warnings", async () => {
    const { fetch, calls } = captureFetch(() =>
      json(
        {
          ...CAMPAIGN_TEMPLATE,
          editor: "simple",
          content: { ...CONTENT, markup: WARNED_MARKUP },
          markup_warnings: MARKUP_WARNINGS,
        },
        201,
      ),
    );
    const body = { name: "Newsletter", content: { markup: WARNED_MARKUP } };

    const template = await makeClient(fetch).campaignTemplates.create(body);

    expect(JSON.parse(calls[0]!.body!)).toEqual(body);
    expect(template.editor).toBe("simple");
    expect(template.content?.markup).toBe(WARNED_MARKUP);
    expect(template.markup_warnings).toEqual(MARKUP_WARNINGS);
  });

  it("get() and delete() address one campaign template", async () => {
    const responses = [json(CAMPAIGN_TEMPLATE), json({ message: "campaign template deleted" })];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const client = makeClient(fetch);

    await expect(client.campaignTemplates.get(CAMPAIGN_TEMPLATE_ID)).resolves.toEqual(
      CAMPAIGN_TEMPLATE,
    );
    await expect(client.campaignTemplates.delete(CAMPAIGN_TEMPLATE_ID)).resolves.toEqual({
      message: "campaign template deleted",
    });

    const path = `${ACCOUNT_PATH}/campaign-templates/${CAMPAIGN_TEMPLATE_ID}`;
    expect(calls.map(({ operationId, method, url }) => [operationId, method, url])).toEqual([
      ["getCampaignTemplate", "GET", path],
      ["deleteCampaignTemplate", "DELETE", path],
    ]);
    expect(calls[1]!.headers).not.toHaveProperty("idempotency-key");
  });
});

describe("CampaignsClient", () => {
  it("list() sends the status filter and returns list items", async () => {
    const { fetch, calls } = captureFetch(() =>
      page([CAMPAIGN_LIST_ITEM], { has_more: true, next_cursor: "next" }),
    );
    const params: ListCampaignsParams = { status: "scheduled", limit: 5 };

    const result = await makeClient(fetch).campaigns.list(params);

    expect(calls[0]!.operationId).toBe("listCampaigns");
    expect(calls[0]!.url).toBe(`${ACCOUNT_PATH}/campaigns?status=scheduled&limit=5`);
    expectTypeOf(result.data).toEqualTypeOf<CampaignListItem[]>();
    expect(result.data[0]).not.toHaveProperty("issues");
  });

  it("iterate() keeps the status filter on every page", async () => {
    const responses = [
      page([CAMPAIGN_LIST_ITEM], { has_more: true, next_cursor: "next" }),
      page([CAMPAIGN_LIST_ITEM], { has_more: false }),
    ];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    let count = 0;

    for await (const _campaign of makeClient(fetch).campaigns.iterate({ status: "sent" })) {
      count += 1;
    }

    expect(count).toBe(2);
    expect(calls.map(({ url }) => new URL(url).search)).toEqual([
      "?status=sent",
      "?status=sent&after=next",
    ]);
  });

  it("create() posts the campaign with an idempotency key and returns its issues", async () => {
    const { fetch, calls } = captureFetch(() => json(CAMPAIGN, 201));
    const body = {
      name: "October newsletter",
      from: { email: "news@example.com" },
      list_ids: [LIST_ID],
      template_id: CAMPAIGN_TEMPLATE_ID,
    };

    const campaign: Campaign = await makeClient(fetch).campaigns.create(body, {
      idempotencyKey: "campaign-create-1",
    });

    expect(calls[0]!.operationId).toBe("createCampaign");
    expect(calls[0]!.url).toBe(`${ACCOUNT_PATH}/campaigns`);
    expect(calls[0]!.headers["idempotency-key"]).toBe("campaign-create-1");
    expect(JSON.parse(calls[0]!.body!)).toEqual(body);
    expect(campaign.ready).toBe(false);
    expect(campaign.issues?.map(({ code }) => code)).toEqual([
      "subject_missing",
      "preheader_missing",
    ]);
  });

  it("create() and update() send an empty list_ids with segment_ids as given", async () => {
    const segmentCampaign = { ...CAMPAIGN, list_ids: [], segment_ids: [SEGMENT_ID] };
    const { fetch, calls } = captureFetch((call) =>
      json(segmentCampaign, call.method === "POST" ? 201 : 200),
    );
    const client = makeClient(fetch);

    const created = await client.campaigns.create({
      name: "Segment campaign",
      list_ids: [],
      segment_ids: [SEGMENT_ID],
    });
    await client.campaigns.update(CAMPAIGN_ID, { list_ids: [], segment_ids: [SEGMENT_ID] });

    expect(calls.map(({ body }) => JSON.parse(body!))).toEqual([
      { name: "Segment campaign", list_ids: [], segment_ids: [SEGMENT_ID] },
      { list_ids: [], segment_ids: [SEGMENT_ID] },
    ]);
    expect(created.segment_ids).toEqual([SEGMENT_ID]);
  });

  it("update() sends an empty exclusion to clear it and leaves out absent audience fields", async () => {
    const { fetch, calls } = captureFetch(() => json(CAMPAIGN));

    await makeClient(fetch).campaigns.update(CAMPAIGN_ID, {
      exclude_list_ids: [],
      segment_ids: undefined,
    });

    expect(calls[0]!.operationId).toBe("updateCampaign");
    expect(calls[0]!.body).toBe('{"exclude_list_ids":[]}');
  });

  it("accepts audiences built from readonly arrays", async () => {
    const lists = [LIST_ID] as const;
    const segments = [SEGMENT_ID] as const;
    const excludedLists = [EXCLUDED_LIST_ID] as const;
    const { fetch, calls } = captureFetch(() => json(CAMPAIGN, 201));
    const body: CreateCampaignRequest = {
      name: "Readonly audience",
      list_ids: lists,
      segment_ids: segments,
      exclude_list_ids: excludedLists,
      exclude_segment_ids: [],
    };
    const update: UpdateCampaignRequest = {
      list_ids: lists,
      segment_ids: segments,
      exclude_list_ids: excludedLists,
      exclude_segment_ids: segments,
    };

    await makeClient(fetch).campaigns.create(body);

    expect(JSON.parse(calls[0]!.body!)).toEqual({
      name: "Readonly audience",
      list_ids: [LIST_ID],
      segment_ids: [SEGMENT_ID],
      exclude_list_ids: [EXCLUDED_LIST_ID],
      exclude_segment_ids: [],
    });
    expect(update.exclude_segment_ids).toEqual([SEGMENT_ID]);
  });

  it("update() sends null to clear a field and accepts no editor or template", async () => {
    const { fetch, calls } = captureFetch(() => json(CAMPAIGN));
    const body: UpdateCampaignRequest = { subject: null, reply_to: null, preheader: undefined };
    const withEditor: UpdateCampaignRequest = {
      // @ts-expect-error The design's editor never changes.
      editor: "html",
    };
    const withTemplate: UpdateCampaignRequest = {
      // @ts-expect-error A template is copied only on create.
      template_id: CAMPAIGN_TEMPLATE_ID,
    };

    await makeClient(fetch).campaigns.update(CAMPAIGN_ID, body);

    expect(calls[0]!.operationId).toBe("updateCampaign");
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(CAMPAIGN_PATH);
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(calls[0]!.body).toBe('{"subject":null,"reply_to":null}');
    expect(withEditor).toBeDefined();
    expect(withTemplate).toBeDefined();
  });

  it("update() sends content.markup and returns the AhaML with its warnings", async () => {
    const { fetch, calls } = captureFetch(() =>
      json({ ...CAMPAIGN, editor: "simple", content: SIMPLE_CONTENT, markup_warnings: [] }),
    );

    const campaign = await makeClient(fetch).campaigns.update(CAMPAIGN_ID, {
      content: { markup: MARKUP },
    });

    expect(calls[0]!.body).toBe(JSON.stringify({ content: { markup: MARKUP } }));
    expect(campaign.content?.markup).toBe(MARKUP);
    expect(campaign.markup_warnings).toEqual([]);
  });

  it("update() surfaces every problem of refused AhaML", async () => {
    const refusal = {
      message: "content.markup has 2 problems",
      errors: [
        {
          code: "unknown_tag",
          message: "Unknown tag <Paragrph>",
          line: 2,
          column: 3,
          path: "Email > Paragrph[1]",
          hint: "use <Paragraph>",
        },
        {
          code: "missing_attribute",
          message: "Button needs href",
          line: 3,
          column: 3,
          path: "Email > Button[1]",
        },
      ],
    } satisfies MarkupErrorResponse;
    const { fetch } = captureFetch(() => json(refusal, 400));

    const error = await rejectionOf(
      makeClient(fetch).campaigns.update(CAMPAIGN_ID, { content: { markup: MARKUP } }),
    );

    expect(error).toBeInstanceOf(AhaSendBadRequestError);
    expect((error as AhaSendBadRequestError).errors).toEqual(refusal.errors);
  });

  it("maps a status refusal and an in-progress key to different 409 errors", async () => {
    const responses = [
      json({ message: "campaign is not a draft" }, 409),
      json({ message: "campaign is not a draft" }, 409, { "idempotent-replayed": "true" }),
      json({ message: "request in progress" }, 409, {
        "idempotent-replayed": "false",
        "retry-after": "3",
      }),
    ];
    const { fetch } = captureFetch((_call, index) => responses[index]!);
    const client = makeClient(fetch);

    const fresh = await rejectionOf(client.campaigns.update(CAMPAIGN_ID, { name: "Renamed" }));
    const replayed = await rejectionOf(client.campaigns.update(CAMPAIGN_ID, { name: "Renamed" }));
    const inProgress = await rejectionOf(
      client.campaigns.update(CAMPAIGN_ID, { name: "Renamed" }, { retry: false }),
    );

    expect(fresh).toBeInstanceOf(AhaSendConflictError);
    expect(fresh).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect(replayed).toBeInstanceOf(AhaSendConflictError);
    expect(replayed).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect(inProgress).toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect((inProgress as AhaSendIdempotencyConflictError).retryAfterSeconds).toBe(3);
  });

  it("get(), delete() and getStats() address one campaign", async () => {
    const stats = {
      object: "campaign_stats",
      campaign_id: CAMPAIGN_ID,
      recipients: 0,
      delivered: 0,
      opens: 0,
      clicks: 0,
      unsubscribes: 0,
      complaints: 0,
      report: null,
      rates: { open_rate: null, click_rate: null, bounce_rate: null, deferral_rate: null },
      recount_failed: false,
    } as const;
    const responses = [json(CAMPAIGN), json({ message: "campaign deleted" }), json(stats)];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const client = makeClient(fetch);

    await client.campaigns.get(CAMPAIGN_ID);
    await client.campaigns.delete(CAMPAIGN_ID);
    const result: CampaignStats = await client.campaigns.getStats(CAMPAIGN_ID);

    expect(calls.map(({ operationId, method, url }) => [operationId, method, url])).toEqual([
      ["getCampaign", "GET", CAMPAIGN_PATH],
      ["deleteCampaign", "DELETE", CAMPAIGN_PATH],
      ["getCampaignStats", "GET", `${CAMPAIGN_PATH}/stats`],
    ]);
    expect(result.report).toBeNull();
    expect(result.rates.open_rate).toBeNull();
  });

  it("duplicate() and send() send no body unless the caller gives one", async () => {
    const send = { ...CAMPAIGN, status: "validating", ready: null, issues: null, warnings: [] };
    const responses = [json(CAMPAIGN, 201), json(CAMPAIGN, 201), json(send, 202), json(send, 202)];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const client = makeClient(fetch);

    await client.campaigns.duplicate(CAMPAIGN_ID);
    await client.campaigns.duplicate(CAMPAIGN_ID, { name: "Copy" }, { idempotencyKey: "dup-1" });
    await client.campaigns.send(CAMPAIGN_ID);
    const accepted: CampaignSend = await client.campaigns.send(CAMPAIGN_ID, {
      send_at: "2030-01-01T09:00:00Z",
    });

    expect(calls.map(({ operationId, method, url }) => [operationId, method, url])).toEqual([
      ["duplicateCampaign", "POST", `${CAMPAIGN_PATH}/duplicate`],
      ["duplicateCampaign", "POST", `${CAMPAIGN_PATH}/duplicate`],
      ["sendCampaign", "POST", `${CAMPAIGN_PATH}/send`],
      ["sendCampaign", "POST", `${CAMPAIGN_PATH}/send`],
    ]);
    expect(calls.map(({ body }) => body)).toEqual([
      undefined,
      '{"name":"Copy"}',
      undefined,
      '{"send_at":"2030-01-01T09:00:00Z"}',
    ]);
    expect(calls.every(({ headers }) => headers["idempotency-key"] !== undefined)).toBe(true);
    expect(calls[1]!.headers["idempotency-key"]).toBe("dup-1");
    expect(accepted.status).toBe("validating");
    expect(accepted.warnings).toEqual([]);
  });

  it("send() surfaces the issues of a campaign that is not ready", async () => {
    const refusal = {
      message: "campaign is not ready to send",
      issues: [{ code: "lists_missing", message: "Choose at least one list." }],
    } satisfies CampaignNotReady;
    const { fetch } = captureFetch(() => json(refusal, 400));

    const error = await rejectionOf(makeClient(fetch).campaigns.send(CAMPAIGN_ID));

    expect(error).toBeInstanceOf(AhaSendBadRequestError);
    expect((error as AhaSendBadRequestError).message).toBe("campaign is not ready to send");
    expect(((error as AhaSendBadRequestError).body as CampaignNotReady).issues).toEqual(
      refusal.issues,
    );
  });

  it("unschedule() posts no body with an idempotency key", async () => {
    const { fetch, calls } = captureFetch(() => json(CAMPAIGN));

    await makeClient(fetch).campaigns.unschedule(CAMPAIGN_ID, { idempotencyKey: "unschedule-1" });

    expect(calls[0]!.operationId).toBe("unscheduleCampaign");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${CAMPAIGN_PATH}/unschedule`);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["idempotency-key"]).toBe("unschedule-1");
  });

  it("test() posts the addresses and returns what the mail server did", async () => {
    const result = {
      object: "campaign_test",
      sent_to: ["ann@example.com"],
      failed: [{ email: "bob@example.com", message: "mailbox unavailable" }],
      result_unknown: false,
    } as const;
    const { fetch, calls } = captureFetch(() => json(result));

    const test: CampaignTest = await makeClient(fetch).campaigns.test(CAMPAIGN_ID, {
      to: ["Ann <ann@example.com>", "bob@example.com"],
    });

    expect(calls[0]!.operationId).toBe("testCampaign");
    expect(calls[0]!.url).toBe(`${CAMPAIGN_PATH}/test`);
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(calls[0]!.body).toBe('{"to":["Ann <ann@example.com>","bob@example.com"]}');
    expect(test).toEqual(result);
  });

  it("test() refuses an empty address list before dispatch and maps the daily limit", async () => {
    const { fetch, calls } = captureFetch(() =>
      json({ message: "daily test send limit reached" }, 429),
    );
    const client = makeClient(fetch);

    expect(() => client.campaigns.test(CAMPAIGN_ID, { to: [] })).toThrow(
      "`to` must contain at least one item",
    );
    expect(calls).toHaveLength(0);
    const limited = await rejectionOf(client.campaigns.test(CAMPAIGN_ID, { to: ["a@b.test"] }));
    expect(limited).toBeInstanceOf(AhaSendRateLimitError);
  });

  it("exposes one frozen, stable recipients facade", () => {
    const client = makeClient(captureFetch().fetch);

    expect(client.campaigns.recipients).toBe(client.campaigns.recipients);
    expect(Object.isFrozen(client.campaigns.recipients)).toBe(true);
    expect(Object.isFrozen(client.campaigns)).toBe(true);
    expect(Object.isFrozen(client.campaignTemplates)).toBe(true);
  });
});

describe("CampaignRecipientsClient", () => {
  const RECIPIENT = {
    object: "campaign_recipient",
    contact_id: CONTACT_ID,
    email: "ann@example.com",
    list_name: "Newsletter",
    segment_id: null,
    segment_name: null,
    status: "Bounced",
    bounce_classification: "Mailbox Full",
    bounce_reason: "mailbox full",
    bounce_message: "552 mailbox full",
    attempts: 2,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T11:00:00Z",
  } as const;

  it("list() sends one filter and reads a page with no previous_cursor", async () => {
    const { fetch, calls } = captureFetch(() => page([], { has_more: false }));

    const result = await makeClient(fetch).campaigns.recipients.list(CAMPAIGN_ID, {
      status: "Administratively Bounced",
      before: "cursor",
    });

    expect(calls[0]!.operationId).toBe("listCampaignRecipients");
    expect(new URL(calls[0]!.url).pathname).toBe(
      `/v2/accounts/${ACCOUNT_ID}/campaigns/${CAMPAIGN_ID}/recipients`,
    );
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({
      status: "Administratively Bounced",
      before: "cursor",
    });
    expect(result.pagination).not.toHaveProperty("previous_cursor");
  });

  it("iterate() keeps the bounce classification filter on every page", async () => {
    const responses = [
      page([RECIPIENT], { has_more: true, next_cursor: CONTACT_ID }),
      page([RECIPIENT], { has_more: false }),
    ];
    const { fetch, calls } = captureFetch((_call, index) => responses[index]!);
    const recipients: CampaignRecipient[] = [];

    for await (const recipient of makeClient(fetch).campaigns.recipients.iterate(CAMPAIGN_ID, {
      bounce_classification: "Mailbox Full",
    })) {
      recipients.push(recipient);
    }

    expect(recipients).toHaveLength(2);
    expect(calls.map(({ url }) => Object.fromEntries(new URL(url).searchParams))).toEqual([
      { bounce_classification: "Mailbox Full" },
      { bounce_classification: "Mailbox Full", after: CONTACT_ID },
    ]);
  });

  it("decodes a recipient sent to from a segment, whose list_name is null", async () => {
    const fromSegment = {
      ...RECIPIENT,
      list_name: null,
      segment_id: SEGMENT_ID,
      segment_name: "Engaged customers",
    };
    const { fetch } = captureFetch(() => page([fromSegment], { has_more: false }));

    const result = await makeClient(fetch).campaigns.recipients.list(CAMPAIGN_ID, {
      status: "Delivered",
    });
    const recipient: CampaignRecipient = result.data[0]!;

    expect(recipient.list_name).toBeNull();
    expect(recipient.segment_id).toBe(SEGMENT_ID);
    expect(recipient.segment_name).toBe("Engaged customers");
    expectTypeOf(recipient.list_name).toEqualTypeOf<string | null>();
    expectTypeOf(recipient.segment_id).toEqualTypeOf<string | null>();
    expectTypeOf(recipient.segment_name).toEqualTypeOf<string | null>();
  });

  it("types exactly one filter as required", () => {
    expectTypeOf<{ status: string }>().toExtend<ListCampaignRecipientsParams>();
    expectTypeOf<{ bounce_classification: string }>().toExtend<ListCampaignRecipientsParams>();
    expectTypeOf<{ limit: number }>().not.toExtend<ListCampaignRecipientsParams>();
    expectTypeOf<{
      status: string;
      bounce_classification: string;
    }>().not.toExtend<ListCampaignRecipientsParams>();
  });
});

describe("keyed campaign writes", () => {
  const TEST_RESULT = {
    object: "campaign_test",
    sent_to: ["ann@example.com"],
    failed: [],
    result_unknown: false,
  } as const;
  const CASES = [
    {
      operationId: "updateCampaign",
      success: CAMPAIGN,
      call: (client: AhaSendClient, idempotencyKey?: string) =>
        client.campaigns.update(CAMPAIGN_ID, { subject: "Hello" }, { idempotencyKey }),
    },
    {
      operationId: "updateCampaignTemplate",
      success: CAMPAIGN_TEMPLATE,
      call: (client: AhaSendClient, idempotencyKey?: string) =>
        client.campaignTemplates.update(
          CAMPAIGN_TEMPLATE_ID,
          { name: "Newsletter v2" },
          { idempotencyKey },
        ),
    },
    {
      operationId: "testCampaign",
      success: TEST_RESULT,
      call: (client: AhaSendClient, idempotencyKey?: string) =>
        client.campaigns.test(CAMPAIGN_ID, { to: ["ann@example.com"] }, { idempotencyKey }),
    },
  ] as const;
  const FAILURES = [
    ["a 502", () => json({ message: "the test could not be sent" }, 502)],
    [
      "an in-progress 409",
      () =>
        json({ message: "request in progress" }, 409, {
          "idempotent-replayed": "false",
          "retry-after": "1",
        }),
    ],
  ] as const;

  function retryingClient(fetch: typeof globalThis.fetch, autoGenerate = true): AhaSendClient {
    return new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: ACCOUNT_ID,
      baseUrl: "https://api.test",
      fetch,
      idempotency: { autoGenerate },
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
    });
  }

  for (const { operationId, success, call } of CASES) {
    for (const [label, failure] of FAILURES) {
      it(`${operationId} retries ${label} with the same key`, async () => {
        const { fetch, calls } = captureFetch((_call, index) =>
          index % 2 === 0 ? failure() : json(success),
        );
        const client = retryingClient(fetch);

        await expect(call(client)).resolves.toEqual(success);
        await expect(call(client, `${operationId}-key`)).resolves.toEqual(success);

        expect(calls.map((entry) => entry.operationId)).toEqual([
          operationId,
          operationId,
          operationId,
          operationId,
        ]);
        const generated = calls[0]!.headers["idempotency-key"];
        expect(generated).toMatch(/^[0-9a-f-]{36}$/);
        expect(calls[1]!.headers["idempotency-key"]).toBe(generated);
        expect(calls[2]!.headers["idempotency-key"]).toBe(`${operationId}-key`);
        expect(calls[3]!.headers["idempotency-key"]).toBe(`${operationId}-key`);
      });
    }

    it(`${operationId} is not retried when automatic keys are off and the caller gives none`, async () => {
      const { fetch, calls } = captureFetch(() => json({ message: "bad gateway" }, 502));

      await expect(call(retryingClient(fetch, false))).rejects.toMatchObject({ status: 502 });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers).not.toHaveProperty("idempotency-key");
    });
  }

  it("testCampaign retries a busy template check with the same key", async () => {
    const { fetch, calls } = captureFetch((_call, index) =>
      index === 0
        ? json(
            { message: "the message could not be checked right now; try again in a moment" },
            503,
            { "retry-after": "2" },
          )
        : json(TEST_RESULT),
    );

    await expect(
      retryingClient(fetch).campaigns.test(CAMPAIGN_ID, { to: ["ann@example.com"] }),
    ).resolves.toEqual(TEST_RESULT);

    expect(calls.map((entry) => entry.operationId)).toEqual(["testCampaign", "testCampaign"]);
    expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
  });
});
