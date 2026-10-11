import type { ApiErrorBody } from "../errors.js";
import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  Address,
  AhaSendPromise,
  IdempotencyRequestOptions,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import {
  assertNonEmptyArray,
  createFrozenFacade,
  forwardOptions,
  forwardWithIdempotency,
} from "./_helpers.js";
import { createCampaignRecipientsClient } from "./campaign-recipients.js";
import type { CampaignRecipientsClient } from "./campaign-recipients.js";
import type { TemplateContent, TemplateContentInput, TemplateEditor } from "./templates.js";

/**
 * Where a campaign is in its life. Only a `draft` can be changed or deleted.
 *
 * - `draft`: being prepared.
 * - `validating`: scheduled, and its lists are being checked.
 * - `waiting_for_review`: held for a review before it sends.
 * - `scheduled`: accepted, waiting for its send time.
 * - `sending`: sending now.
 * - `paused`: sending stopped for now; `status_reason` says why.
 * - `sent`: every message was sent.
 * - `canceled`: stopped before it finished; `status_reason` says why.
 * - `failed`: could not be sent; `status_reason` says why.
 */
export type CampaignStatus =
  | "draft"
  | "validating"
  | "waiting_for_review"
  | "scheduled"
  | "sending"
  | "paused"
  | "sent"
  | "canceled"
  | "failed";

/**
 * The reason a campaign cannot be sent yet.
 *
 * - `sender_missing`: the campaign has no complete sender, or its domain was deleted.
 * - `lists_missing`: the campaign has no list that still exists.
 * - `subject_missing`: the campaign has no subject.
 * - `preheader_missing`: the campaign has no preview text.
 * - `design_missing`: the campaign has no design, or its design has no HTML.
 * - `text_broken`: the subject, the preview text or the design holds template syntax that cannot
 *   be rendered, so every message would fail.
 * - `unsubscribe_link_missing`: the HTML uses neither `{{ unsubscribe_url }}` nor
 *   `{{ unsubscribe_link }}`, with or without filters.
 */
export type CampaignIssueCode =
  | "sender_missing"
  | "lists_missing"
  | "subject_missing"
  | "preheader_missing"
  | "design_missing"
  | "text_broken"
  | "unsubscribe_link_missing";

/** A reason the campaign cannot be sent yet. */
export interface CampaignIssue {
  code: CampaignIssueCode;
  /** What to do, in the words the dashboard uses. */
  message: string;
}

/** A campaign as `list()` and `iterate()` return it, without its lists, content and issues. */
export interface CampaignListItem {
  object: "campaign";
  id: UUID;
  created_at: ISODateTime;
  /** When the campaign's own fields last changed. */
  updated_at: ISODateTime;
  /** The name, as it appears in the dashboard. Recipients do not see it. */
  name: string;
  /** `null` until a subject is set. */
  subject: string | null;
  /** The preview text, which most inboxes show after the subject. `null` until one is set. */
  preheader: string | null;
  /**
   * The sender. `null` until a complete sender is set, and when its domain was deleted. `name` is
   * an empty string when the campaign has no sender name, so the object can be sent back as it is.
   */
  from: Address | null;
  /** The reply-to address; `null` when none is set. */
  reply_to: string | null;
  status: CampaignStatus;
  /** Why the campaign is in its status, when there is a reason to give; `null` otherwise. */
  status_reason: string | null;
  /** When the campaign sends or sent, in UTC. `null` until it is scheduled. */
  send_at: ISODateTime | null;
  /**
   * When a send that reached the account's daily marketing limit continues, in UTC. `null`
   * otherwise.
   */
  send_resumes_at: ISODateTime | null;
  /** When the send ended, in UTC. `null` until then. */
  finished_at: ISODateTime | null;
}

/** A campaign with its lists, its content and, for a draft, what keeps it from being sent. */
export interface Campaign extends CampaignListItem {
  /** The lists the campaign sends to, in the order they were saved. A deleted list is left out. */
  list_ids: UUID[];
  /** The editor of the campaign's design; `null` while the campaign has no design. */
  editor: TemplateEditor | null;
  /** The content of the design; `null` while it has no design, or neither HTML nor text. */
  content: TemplateContent | null;
  /** Whether the draft has no issue, so it can be sent. `null` unless the campaign is a draft. */
  ready: boolean | null;
  /**
   * The reasons the draft cannot be sent yet, in a fixed order; empty when it is ready. `null`
   * unless the campaign is a draft.
   */
  issues: CampaignIssue[] | null;
}

/** The campaign a send accepted, in `validating`, with what the send wants you to know. */
export interface CampaignSend extends Campaign {
  /**
   * Things the send accepted but you should know, such as an account that cannot send right now
   * while the campaign is sent later, or a design its view-in-browser page cannot show. Empty
   * when there is none.
   */
  warnings: string[];
}

/**
 * A new draft campaign. Every field but `name` can be set later with `update()`. The design
 * comes from at most one source: an `editor`, `content`, both, or a `template_id`; with none of
 * them the campaign has no design yet.
 */
export interface CreateCampaignRequest {
  /** 1–255 characters after trimming. */
  name: string;
  /** Line breaks become spaces and spaces around it are dropped; an empty subject is no subject. */
  subject?: string | null | undefined;
  /** The preview text, cleaned as `subject` is. */
  preheader?: string | null | undefined;
  /**
   * The sender. `email` must be on a domain of this account with valid DNS. A paused domain is
   * accepted here and refused when the campaign is sent.
   */
  from?: Address | null | undefined;
  /** The reply-to address, an address only, without a display name. */
  reply_to?: string | null | undefined;
  /** 1–50 lists of this account to send to, in order. A list named twice counts once. */
  list_ids?: readonly UUID[] | undefined;
  /**
   * The editor of the design. Without `content` the campaign gets an empty design of this
   * editor, which the dashboard's editor opens. With `content`, it is required when the content
   * holds neither `mjml` nor `html`, and must agree with it otherwise. Not accepted with
   * `template_id`.
   */
  editor?: TemplateEditor | undefined;
  /**
   * The content of the design, by the rules of {@link TemplateContentInput}, where the draft
   * means the campaign's design. Not accepted with `template_id`.
   */
  content?: TemplateContentInput | undefined;
  /**
   * A campaign template whose design the campaign copies. The copy is the campaign's own; later
   * changes to the template do not reach it. A campaign template with no HTML is refused.
   */
  template_id?: UUID | undefined;
}

/**
 * Changes to a draft campaign. A field left out is neither changed nor checked, and `null`
 * clears `subject`, `preheader`, `from` and `reply_to`. The design's editor never changes.
 */
export interface UpdateCampaignRequest {
  /** 1–255 characters after trimming. */
  name?: string | undefined;
  /** Cleaned as on create; `null` clears it. */
  subject?: string | null | undefined;
  /** Cleaned as on create; `null` clears it. */
  preheader?: string | null | undefined;
  /** The sender, as on create. `null` clears the sender; `reply_to` stays as it is. */
  from?: Address | null | undefined;
  /** The reply-to address, as on create. `null` clears it. */
  reply_to?: string | null | undefined;
  /** 1–50 lists, which replace the campaign's lists, as on create. */
  list_ids?: readonly UUID[] | undefined;
  /**
   * The content of the design, by the rules of {@link TemplateContentInput}, in the design's
   * editor. For a `simple` design, send only `text`. A campaign with no design yet needs `mjml`
   * or `html`, which sets its editor.
   */
  content?: TemplateContentInput | undefined;
}

/** The copy's name. Without one the copy is named `Copy of` and the source's name. */
export interface DuplicateCampaignRequest {
  /** 1–255 characters after trimming. */
  name?: string | undefined;
}

/** When to send a campaign. Without `send_at` the campaign is sent now. */
export interface SendCampaignRequest {
  /** The time to send, in RFC 3339, at least 1 minute ahead. */
  send_at?: ISODateTime | undefined;
}

/**
 * The body of a `send()` or `test()` refusal (an `AhaSendBadRequestError`'s `body`). A campaign
 * with issues is refused with `campaign is not ready to send` and the issues that block the
 * request; every other refusal has only `message`.
 */
export interface CampaignNotReady extends ApiErrorBody {
  /**
   * The issues that block the request, in the order of {@link CampaignIssueCode}. For a test,
   * every issue but `unsubscribe_link_missing`.
   */
  issues?: CampaignIssue[];
}

/** The addresses to send a test to. */
export interface TestCampaignRequest {
  /**
   * 1–5 addresses, counted after addresses that differ only in case are dropped. An entry may
   * carry a display name, such as `Ann <ann@example.com>`; the test goes to the address alone.
   */
  to: readonly string[];
}

/** An address the mail server refused. */
export interface CampaignTestFailure {
  /** The address as the mail server reported it, which can be one the request did not hold. */
  email: string;
  message: string;
}

/** What a test send did. */
export interface CampaignTest {
  object: "campaign_test";
  /** The addresses the mail server accepted. */
  sent_to: string[];
  /** The addresses the mail server refused. */
  failed: CampaignTestFailure[];
  /**
   * True when the mail server took the request but its answer could not be read. The test may
   * have gone out; `sent_to` and `failed` are empty. Check the inboxes before you send another.
   */
  result_unknown: boolean;
}

/** A campaign's stored report, which is recounted from its recipients from time to time. */
export interface CampaignStatsReport {
  /** When the report was counted. */
  computed_at: ISODateTime;
  /** The recipients the report counted, the base of `bounce_rate` and `deferral_rate`. */
  recipients: number;
  /** Contacts who opened, each once, without bots. */
  openers: number;
  /** Contacts who clicked, each once, without bots. */
  clickers: number;
  /** Recipients that bounced or failed. */
  bounces: number;
  /** Recipients whose delivery was deferred. */
  deferrals: number;
  /**
   * Recipients by status, under the names the dashboard's report shows, such as `Queued`,
   * `Delivered`, `Bounced` or `Administratively Bounced`. Each name is a `status` filter of
   * `campaigns.recipients.list()`.
   */
  by_status: Record<string, number>;
  /**
   * Bounces by bounce classification. `Unknown` counts the bounces with no classification and
   * has no recipient page; every other key is a `bounce_classification` filter of
   * `campaigns.recipients.list()`.
   */
  by_bounce_classification: Record<string, number>;
}

/**
 * Percentages from 0 to 100 with two decimals. Each is `null` while `report` is `null` or its
 * base is zero.
 */
export interface CampaignStatsRates {
  /** Openers out of `delivered`, at most 100. */
  open_rate: number | null;
  /** Clickers out of `delivered`, at most 100. */
  click_rate: number | null;
  /** Bounces out of `report.recipients`. */
  bounce_rate: number | null;
  /** Deferrals out of `report.recipients`. */
  deferral_rate: number | null;
}

/**
 * The numbers of a campaign. The counters are live; `report` is the stored report, which is
 * recounted from time to time. A read never counts: when the report is missing or old, it asks
 * for a recount and answers what is stored, so read again later for the new numbers.
 */
export interface CampaignStats {
  object: "campaign_stats";
  campaign_id: UUID;
  /** Recipients the campaign sends to. */
  recipients: number;
  /** Messages delivered. */
  delivered: number;
  /** Opens, without bots. */
  opens: number;
  /** Clicks, without bots. */
  clicks: number;
  /** Recipients who unsubscribed. */
  unsubscribes: number;
  /** Recipients who marked the message as spam. */
  complaints: number;
  /** The stored report; `null` until the campaign's first recount. */
  report: CampaignStatsReport | null;
  rates: CampaignStatsRates;
  /** True while the last recount of the report failed, so `report` may be old. */
  recount_failed: boolean;
}

/** The status filter and cursor controls accepted when listing campaigns. */
export type ListCampaignsParams = PaginationParams & {
  /** Only campaigns in this status. */
  status?: CampaignStatus | undefined;
};

/**
 * Manage the account's marketing campaigns. A campaign changes only while it is a `draft`: a
 * change, a delete, a send or a test of a campaign in any other status answers 409
 * (`AhaSendConflictError`).
 */
export interface CampaignsClient {
  /**
   * Fetch one newest-first page of campaigns using mutually exclusive cursors. The items carry no
   * lists, content or issues. Authorization requires `campaigns:read`.
   */
  list(
    params?: ListCampaignsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<CampaignListItem>>;

  /** Iterate through every matching campaign, fetching cursor pages lazily. */
  iterate(
    params?: ListCampaignsParams,
    options?: RequestOptions,
  ): AsyncGenerator<CampaignListItem, void, undefined>;

  /**
   * Create a draft campaign. Its `issues` say what it needs before it can be sent. MJML is
   * compiled in strict mode, and images and stylesheets must use `https://` URLs.
   * Authorization requires `campaigns:write`.
   */
  create(
    body: CreateCampaignRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<Campaign>;

  /**
   * Retrieve one campaign with its lists, its content and, for a draft, its issues.
   * Authorization requires `campaigns:read`.
   */
  get(campaignId: UUID, options?: RequestOptions): AhaSendPromise<Campaign>;

  /**
   * Change a draft campaign. The design of a `simple` campaign can be changed only in the
   * dashboard: send only `content.text` for one. Authorization requires `campaigns:write`.
   */
  update(
    campaignId: UUID,
    body: UpdateCampaignRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<Campaign>;

  /**
   * Delete a draft campaign with its design and its list choices.
   * Authorization requires `campaigns:delete`.
   */
  delete(campaignId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /**
   * Make a new draft from a campaign in any status: a copy of its design, subject, preview text,
   * sender, reply-to address, and its lists that still exist. Authorization requires
   * `campaigns:write`.
   */
  duplicate(
    campaignId: UUID,
    body?: DuplicateCampaignRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<Campaign>;

  /**
   * Send a draft campaign now, or at `send_at`. The campaign moves to `validating` and goes
   * through the same list validation and review as a send from the dashboard; read `status` and
   * `status_reason` with `get()`. A campaign with issues, or one the send's checks stop, is
   * refused with an `AhaSendBadRequestError` whose `body` is a {@link CampaignNotReady}. To
   * change the send time, unschedule the campaign and send it again.
   * Authorization requires `campaigns:send`.
   */
  send(
    campaignId: UUID,
    body?: SendCampaignRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CampaignSend>;

  /**
   * Return a `validating` or `scheduled` campaign to `draft`. A campaign that has queued mail, or
   * that is in any other status, such as `waiting_for_review`, answers 409.
   * Authorization requires `campaigns:send`.
   */
  unschedule(campaignId: UUID, options?: IdempotencyRequestOptions): AhaSendPromise<Campaign>;

  /**
   * Send a test of a draft campaign to 1–5 addresses. A campaign with any issue but
   * `unsubscribe_link_missing` is refused with an `AhaSendBadRequestError` whose `body` is a
   * {@link CampaignNotReady}. The account can send 50 test emails a day (UTC), counted per
   * address and shared with the dashboard. A test whose addresses would take the day's total over
   * 50 is refused with a 429 (`AhaSendRateLimitError`) and counts nothing, so a test to fewer
   * addresses can still fit; its message currently reads `daily test send limit reached`. The SDK
   * retries that 429 like any other, with the same addresses, and the count starts again when the
   * UTC day changes. A retry with the same idempotency key replays a success and sends nothing
   * again. A 4xx refusal is not stored and releases the key; an in-progress 409 leaves the key to
   * the request that holds it. Authorization requires `campaigns:send`.
   */
  test(
    campaignId: UUID,
    body: TestCampaignRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CampaignTest>;

  /**
   * Retrieve a campaign's live counters, its stored report and the rates from both.
   * Authorization requires `campaigns:read`.
   */
  getStats(campaignId: UUID, options?: RequestOptions): AhaSendPromise<CampaignStats>;

  /** Read the recipients of a campaign. */
  readonly recipients: Readonly<CampaignRecipientsClient>;
}

class CampaignsClientImplementation implements CampaignsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;
  readonly #recipients: Readonly<CampaignRecipientsClient>;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
    this.#recipients = createFrozenFacade(createCampaignRecipientsClient(operations, accountId));
  }

  list(
    params: ListCampaignsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<CampaignListItem>> {
    return this.#operations.execute(
      "listCampaigns",
      { path: { account_id: this.#accountId }, query: params },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListCampaignsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<CampaignListItem, void, undefined> {
    return paginate<CampaignListItem, ListCampaignsParams>(
      (page) => this.list(page, options),
      params,
    );
  }

  create(
    body: CreateCampaignRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<Campaign> {
    const forwarded = forwardWithIdempotency(options);
    if (body?.list_ids !== undefined) assertNonEmptyArray(body.list_ids, "list_ids");
    return this.#operations.execute(
      "createCampaign",
      { path: { account_id: this.#accountId }, body },
      forwarded,
    );
  }

  get(campaignId: UUID, options: RequestOptions = {}): AhaSendPromise<Campaign> {
    return this.#operations.execute(
      "getCampaign",
      { path: { account_id: this.#accountId, campaign_id: campaignId } },
      forwardOptions(options),
    );
  }

  update(
    campaignId: UUID,
    body: UpdateCampaignRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<Campaign> {
    const forwarded = forwardWithIdempotency(options);
    if (body?.list_ids !== undefined) assertNonEmptyArray(body.list_ids, "list_ids");
    return this.#operations.execute(
      "updateCampaign",
      { path: { account_id: this.#accountId, campaign_id: campaignId }, body },
      forwarded,
    );
  }

  delete(campaignId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteCampaign",
      { path: { account_id: this.#accountId, campaign_id: campaignId } },
      forwardOptions(options),
    );
  }

  duplicate(
    campaignId: UUID,
    body?: DuplicateCampaignRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<Campaign> {
    return this.#operations.execute(
      "duplicateCampaign",
      {
        path: { account_id: this.#accountId, campaign_id: campaignId },
        ...(body !== undefined ? { body } : {}),
      },
      forwardWithIdempotency(options),
    );
  }

  send(
    campaignId: UUID,
    body?: SendCampaignRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CampaignSend> {
    return this.#operations.execute(
      "sendCampaign",
      {
        path: { account_id: this.#accountId, campaign_id: campaignId },
        ...(body !== undefined ? { body } : {}),
      },
      forwardWithIdempotency(options),
    );
  }

  unschedule(campaignId: UUID, options: IdempotencyRequestOptions = {}): AhaSendPromise<Campaign> {
    return this.#operations.execute(
      "unscheduleCampaign",
      { path: { account_id: this.#accountId, campaign_id: campaignId } },
      forwardWithIdempotency(options),
    );
  }

  test(
    campaignId: UUID,
    body: TestCampaignRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CampaignTest> {
    const forwarded = forwardWithIdempotency(options);
    assertNonEmptyArray(body?.to, "to");
    return this.#operations.execute(
      "testCampaign",
      { path: { account_id: this.#accountId, campaign_id: campaignId }, body },
      forwarded,
    );
  }

  getStats(campaignId: UUID, options: RequestOptions = {}): AhaSendPromise<CampaignStats> {
    return this.#operations.execute(
      "getCampaignStats",
      { path: { account_id: this.#accountId, campaign_id: campaignId } },
      forwardOptions(options),
    );
  }

  /** Read the recipients of a campaign. */
  get recipients(): Readonly<CampaignRecipientsClient> {
    return this.#recipients;
  }
}

/** @internal Construct the campaigns resource implementation for the root client. */
export function createCampaignsClient(
  operations: OperationExecutor,
  accountId: UUID,
): CampaignsClient {
  return new CampaignsClientImplementation(operations, accountId);
}
