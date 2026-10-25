import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
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
import { createSegmentContactsClient } from "./segment-contacts.js";
import type { SegmentContactsClient } from "./segment-contacts.js";

/**
 * Where a segment's members stand.
 *
 * - `building`: the members are being found for the current definition. A campaign that uses
 *   the segment cannot be sent until it is `ready`.
 * - `ready`: the members follow the current definition.
 * - `failed`: the members could not be found; `failure_reason` says why. Any update of the
 *   segment, `{}` included, builds it again.
 */
export type SegmentState = "building" | "ready" | "failed";

/** Whether a contact must match all of the conditions or any of them. */
export type SegmentMatch = "all" | "any";

/**
 * A condition's operator. Which operators a field takes, and the value each one compares with,
 * are described on {@link SegmentCondition}; the API refuses any other pair.
 */
export type SegmentOperator =
  | "equal"
  | "not_equal"
  | "contains"
  | "not_contains"
  | "begins_with"
  | "not_begins_with"
  | "ends_with"
  | "not_ends_with"
  | "is_empty"
  | "is_not_empty"
  | "less"
  | "less_or_equal"
  | "greater"
  | "greater_or_equal"
  | "before"
  | "before_or_on"
  | "after"
  | "after_or_on"
  | "is_null"
  | "is_not_null"
  | "is_true"
  | "is_false"
  | "month_is"
  | "anniversary_within"
  | "in"
  | "not_in"
  | "received"
  | "not_received"
  | "opened"
  | "not_opened"
  | "clicked"
  | "not_clicked"
  | "received_at_least"
  | "received_fewer_than"
  | "opened_at_least"
  | "opened_fewer_than"
  | "clicked_at_least"
  | "clicked_fewer_than";

/** The value of a `campaign_count` condition. A missing or unknown property is refused. */
export interface SegmentCampaignCount {
  /**
   * The number of campaigns, a whole number from 1 to 1000, or from 2 for
   * `received_fewer_than`.
   */
  count: number;
  /**
   * When the window starts: `M days ago`, `M weeks ago`, `M months ago` or `M years ago`, with M
   * from 1 to 365 days, 52 weeks, 12 months or 1 year. It starts at the beginning of its day in
   * the segment's time zone.
   */
  since: string;
}

/**
 * The value a condition's operator compares with: a string, a number, a boolean, `null` for an
 * operator that takes none, or a {@link SegmentCampaignCount} for `campaign_count`.
 */
export type SegmentConditionValue = string | number | boolean | null | SegmentCampaignCount;

/**
 * One rule. `field` names what it reads:
 *
 * - `email`, `first_name`, `last_name`, `created_at`, or `attributes.<key>` for a contact field
 *   of the account, with the operators of the field's type. Dates take a date such as
 *   `2024-06-15` or a relative time such as `today` or `30 days ago`.
 * - `list` with `in` or `not_in` and a list ID. `in` means a `confirmed` membership.
 * - `campaign` with `received`, `not_received`, `opened`, `not_opened`, `clicked` or
 *   `not_clicked` and a campaign ID.
 * - `any_campaign` with `received`, `opened`, `clicked`, `not_opened` or `not_clicked` and a
 *   relative time such as `14 days ago`.
 * - `campaign_count` with `received_at_least`, `received_fewer_than`, `opened_at_least`,
 *   `opened_fewer_than`, `clicked_at_least` or `clicked_fewer_than` and a
 *   {@link SegmentCampaignCount}.
 *
 * The API checks each field, operator and value, and answers 400 with a message that names each
 * problem by its path, such as `conditions[3].value`. Opens and clicks by bots do not count.
 */
export interface SegmentCondition {
  /**
   * `email`, `first_name`, `last_name`, `created_at`, `attributes.<key>`, `list`, `campaign`,
   * `any_campaign` or `campaign_count`.
   */
  field: string;
  /** The operator, one that applies to `field`. */
  op: SegmentOperator;
  /**
   * Left out, or `null`, for an operator that takes none, such as `is_empty`. A whole number for
   * `month_is` (1–12) and `anniversary_within` (0–365 days).
   */
  value?: SegmentConditionValue | undefined;
}

/** A nested group of conditions. A group cannot hold another group. */
export interface SegmentGroup {
  match: SegmentMatch;
  /** One or more conditions. */
  conditions: readonly SegmentCondition[];
}

/**
 * The rules of a segment. The root holds conditions and groups; a group holds conditions only,
 * so groups nest one level deep. A definition has at most 50 conditions in all, and at most 5 of
 * them are `campaign`, `any_campaign` or `campaign_count` conditions. An unknown key is refused.
 */
export interface SegmentDefinition {
  /** The version of this format. */
  schema_version: 1;
  match: SegmentMatch;
  /** One or more conditions and groups. */
  conditions: readonly (SegmentCondition | SegmentGroup)[];
}

/** A saved set of rules over the account's contacts, and the contacts that match them. */
export interface Segment {
  object: "segment";
  id: UUID;
  created_at: ISODateTime;
  /** When the segment was last saved. */
  updated_at: ISODateTime;
  /** Names are not unique within an account. */
  name: string;
  /** Empty when none was given. */
  description: string;
  definition: SegmentDefinition;
  /** The IANA time zone that relative times and days in the definition are read in. */
  timezone: string;
  state: SegmentState;
  /** Why the segment failed; `null` unless `state` is `failed`. */
  failure_reason: string | null;
  /**
   * The contacts that match the rules, whatever their consent. A campaign reaches only those of
   * them who may get marketing email; `get()` counts them as `marketable_count`.
   */
  member_count: number;
  /**
   * When the members were last checked against the whole account; `null` until the first build
   * ends.
   */
  last_evaluated_at: ISODateTime | null;
}

/** A segment as `get()` returns it, with `marketable_count`. */
export interface SegmentDetail extends Segment {
  /**
   * The members a campaign to this segment alone would reach: enabled, not unsubscribed, not
   * found invalid, and either confirmed on at least one list or on no list at all. `null` while
   * `state` is not `ready`, and when they cannot be counted within 10 seconds.
   */
  marketable_count: number | null;
}

/** A new segment. */
export interface CreateSegmentRequest {
  /** 1–255 characters after trimming; names are not unique within an account. */
  name: string;
  /** At most 1,000 characters after trimming. Null and omission both store an empty description. */
  description?: string | null | undefined;
  definition: SegmentDefinition;
  /**
   * The IANA time zone, such as `Europe/Berlin`, that relative times and days are read in. Null,
   * omission and an empty string all store `UTC`.
   */
  timezone?: string | null | undefined;
}

/**
 * A partial segment update. An omitted or null field is left unchanged. A change of `definition`
 * or `timezone` builds the members again, and the segment is `building` until that ends; a change
 * of only `name` or `description` leaves its members and its state as they are.
 */
export interface UpdateSegmentRequest {
  /** Trimmed and bounded as on create. */
  name?: string | null | undefined;
  /** Trimmed and bounded as on create. */
  description?: string | null | undefined;
  /** The new rules, which replace the stored ones as a whole. */
  definition?: SegmentDefinition | null | undefined;
  /**
   * The IANA time zone, as on create. Null and omission keep the stored zone; `""` stores
   * `UTC`.
   */
  timezone?: string | null | undefined;
}

/** A definition to try. Nothing is saved. */
export interface PreviewSegmentRequest {
  definition: SegmentDefinition;
  /**
   * The IANA time zone that relative times and days are read in. Null, omission and an empty
   * string all read them in `UTC`.
   */
  timezone?: string | null | undefined;
}

/** One contact a preview matches. */
export interface SegmentPreviewContact {
  contact_id: UUID;
  /** The contact's normalized email address. */
  email: string;
}

/** What a definition matches now. */
export interface SegmentPreview {
  object: "segment_preview";
  /**
   * The contacts the definition matches, whatever their consent; `null` when they cannot be
   * counted within 10 seconds.
   */
  count: number | null;
  /**
   * Up to 10 of the matching contacts, in no particular order. They are returned also when
   * `count` is `null`, and are empty when they cannot be read within 10 seconds.
   */
  contacts: SegmentPreviewContact[];
}

/** One member of a segment. */
export interface SegmentContact {
  object: "segment_contact";
  segment_id: UUID;
  contact_id: UUID;
  /** The contact's normalized email address. */
  email: string;
  /** When the contact became a member. */
  entered_at: ISODateTime;
}

/** Cursor controls accepted by the segment list operation, which takes no filters. */
export type ListSegmentsParams = PaginationParams;

/**
 * Manage the account's segments: saved rules over its contacts, which campaigns can send to or
 * exclude. A segment that is being changed, such as by a member update that holds it, answers
 * `update()` and `delete()` with 409 (`AhaSendConflictError`); nothing was changed, so try again
 * later.
 */
export interface SegmentsClient {
  /**
   * Fetch one newest-first page of segments using mutually exclusive cursors.
   * Authorization requires `segments:read`.
   */
  list(
    params?: ListSegmentsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Segment>>;

  /** Iterate through every segment, fetching cursor pages lazily. */
  iterate(
    params?: ListSegmentsParams,
    options?: RequestOptions,
  ): AsyncGenerator<Segment, void, undefined>;

  /**
   * Create a segment and start finding its members. A new segment is `building` until they are
   * found; a large account can take some minutes. An account has at most 100 segments; one more,
   * or a list or campaign the definition names that is being changed, answers 409. Unlike most
   * creates, a 4xx answer is not stored for the idempotency key, so a retry with the same key runs
   * again, for example after a segment is deleted. Authorization requires `segments:write`.
   */
  create(body: CreateSegmentRequest, options?: IdempotencyRequestOptions): AhaSendPromise<Segment>;

  /**
   * Count the contacts a definition matches now, and return up to 10 of them, without saving
   * anything. The request takes no idempotency key, so the SDK does not retry it.
   * Authorization requires `segments:read` and `contacts:read`.
   */
  preview(body: PreviewSegmentRequest, options?: RequestOptions): AhaSendPromise<SegmentPreview>;

  /**
   * Retrieve one segment by UUID, with `marketable_count`. Authorization requires `segments:read`.
   */
  get(segmentId: UUID, options?: RequestOptions): AhaSendPromise<SegmentDetail>;

  /**
   * Partially update one segment. Any update of a failed segment, `{}` included, builds it again.
   * Authorization requires `segments:write`.
   */
  update(
    segmentId: UUID,
    body: UpdateSegmentRequest,
    options?: RequestOptions,
  ): AhaSendPromise<Segment>;

  /**
   * Delete one segment; its members are removed shortly after. A segment that an unfinished
   * campaign still needs, as an included or an excluded segment, answers 409.
   * Authorization requires `segments:delete`.
   */
  delete(segmentId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /** Read the members of a segment. */
  readonly contacts: Readonly<SegmentContactsClient>;
}

/**
 * Enforce the spec's `minItems: 1` on the root's conditions and on each group's conditions. The
 * API checks everything else in a definition and names each problem by its path.
 */
function assertDefinitionConditions(definition: SegmentDefinition | undefined): void {
  assertNonEmptyArray(definition?.conditions, "definition.conditions");
  definition.conditions.forEach((rule, index) => {
    if (rule !== null && typeof rule === "object" && "match" in rule) {
      assertNonEmptyArray(rule.conditions, `definition.conditions[${index}].conditions`);
    }
  });
}

class SegmentsClientImplementation implements SegmentsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;
  readonly #contacts: Readonly<SegmentContactsClient>;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
    this.#contacts = createFrozenFacade(createSegmentContactsClient(operations, accountId));
  }

  list(
    params: ListSegmentsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<Segment>> {
    return this.#operations.execute(
      "getSegments",
      { path: { account_id: this.#accountId }, query: params },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListSegmentsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Segment, void, undefined> {
    return paginate<Segment, ListSegmentsParams>((page) => this.list(page, options), params);
  }

  create(
    body: CreateSegmentRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<Segment> {
    const forwarded = forwardWithIdempotency(options);
    assertDefinitionConditions(body?.definition);
    return this.#operations.execute(
      "createSegment",
      { path: { account_id: this.#accountId }, body },
      forwarded,
    );
  }

  preview(
    body: PreviewSegmentRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<SegmentPreview> {
    const forwarded = forwardOptions(options);
    assertDefinitionConditions(body?.definition);
    return this.#operations.execute(
      "previewSegment",
      { path: { account_id: this.#accountId }, body },
      forwarded,
    );
  }

  get(segmentId: UUID, options: RequestOptions = {}): AhaSendPromise<SegmentDetail> {
    return this.#operations.execute(
      "getSegment",
      { path: { account_id: this.#accountId, segment_id: segmentId } },
      forwardOptions(options),
    );
  }

  update(
    segmentId: UUID,
    body: UpdateSegmentRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<Segment> {
    const forwarded = forwardOptions(options);
    if (body?.definition !== undefined && body.definition !== null) {
      assertDefinitionConditions(body.definition);
    }
    return this.#operations.execute(
      "updateSegment",
      { path: { account_id: this.#accountId, segment_id: segmentId }, body },
      forwarded,
    );
  }

  delete(segmentId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteSegment",
      { path: { account_id: this.#accountId, segment_id: segmentId } },
      forwardOptions(options),
    );
  }

  /** Read the members of a segment. */
  get contacts(): Readonly<SegmentContactsClient> {
    return this.#contacts;
  }
}

/** @internal Construct the segments resource implementation for the root client. */
export function createSegmentsClient(
  operations: OperationExecutor,
  accountId: UUID,
): SegmentsClient {
  return new SegmentsClientImplementation(operations, accountId);
}
