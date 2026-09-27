import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import type { Contact } from "./contacts.js";
import {
  assertNonEmptyArray,
  forwardOptions,
  forwardWithIdempotency,
  type IdempotencyRequestOptions,
} from "./_helpers.js";

/**
 * A membership's per-list consent, independent of the contact's account-wide
 * `unsubscribed` flag. `complained` is the mailbox provider's verdict and is
 * never writable.
 */
export type ListContactSubscriptionStatus =
  | "unconfirmed"
  | "confirmed"
  | "unsubscribed"
  | "complained";

/** A list as a membership carries it: a `contact_list` without `contact_count`. */
export interface EmbeddedContactList {
  object: "contact_list";
  id: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  /** Names are not unique within an account. */
  name: string;
  /** Empty when none was given. */
  description: string;
  /** Always present; empty when the list carries no tags. */
  tags: string[];
}

/** One contact's membership of one list, addressed by the `(list_id, contact_id)` pair. */
export interface ListContact {
  object: "list_contact";
  list_id: string;
  contact_id: string;
  /** The contact's normalized email address. */
  email: string;
  subscription_status: ListContactSubscriptionStatus;
  /** When the membership last became `confirmed`; kept when it later changes. */
  subscribed_at: ISODateTime | null;
  /** When the membership became `unsubscribed`, or when a complaint landed. */
  unsubscribed_at: ISODateTime | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  /** The whole contact; present only on a member listing with `include_contacts: true`. */
  contact?: Contact;
  /** The list; present only on the reverse read, `client.contacts.lists`. */
  list?: EmbeddedContactList;
}

/**
 * The membership write. `{}` names no status: a new membership is then
 * `confirmed`, and an existing one keeps the status it holds.
 */
export interface UpsertListContactRequest {
  /** Null and omission are one case. `complained` is rejected with 400. */
  subscription_status?: Exclude<ListContactSubscriptionStatus, "complained"> | null | undefined;
}

/**
 * One batch entry naming exactly one existing contact by `email` or `id`. An
 * entry naming neither, both, or anything else is reported `invalid` at its
 * own position rather than failing the request.
 */
export interface BatchAddListContactInput {
  email?: string | null | undefined;
  id?: string | null | undefined;
}

/** A synchronous batch of one through 1,000 existing contacts to add to one list. */
export interface BatchAddListContactsRequest {
  data: ReadonlyArray<BatchAddListContactInput>;
}

/** One entry's outcome, at the entry's index in the request array. */
export interface BatchListContactResult {
  position: number;
  /** The normalized input email, echoed when the entry named one usable email. */
  email?: string;
  /** The input contact ID, echoed when the entry named one that parsed as a UUID. */
  id?: string;
  /**
   * `added` created the membership, `already_member` left an existing one
   * untouched whatever its status, `not_found` matched no contact in this
   * account, and `invalid` was decidable from the entry alone.
   */
  outcome: "added" | "already_member" | "not_found" | "invalid";
  /** Present on `added` and `already_member`: the membership as it stands. */
  membership?: ListContact;
  /** Present only on `not_found` and `invalid`. */
  reason?: string;
}

/** Counts and ordered per-entry outcomes from a batch add. */
export interface BatchAddListContactsResponse {
  object: "list";
  /** Entries whose membership this request created. */
  added: number;
  /** Entries reported `already_member`. */
  skipped: number;
  /** Entries reported `not_found` or `invalid`. */
  failed: number;
  data: BatchListContactResult[];
}

/** Filters and cursor controls accepted when listing one list's members. */
export type ListListContactsParams = PaginationParams & {
  subscription_status?: ListContactSubscriptionStatus | undefined;
  /** Exact match on the normalized address. */
  email?: string | undefined;
  /** Embed the whole contact in every item. Also requires the `contacts:read` scope. */
  include_contacts?: boolean | undefined;
};

/** Manage the contacts on a list. */
export interface ListContactsClient {
  /**
   * Fetch one newest-first page of a list's members using mutually exclusive
   * cursors. Authorization requires `lists:read`, plus `contacts:read` when
   * `include_contacts` is true.
   */
  list(
    listId: UUID,
    params?: ListListContactsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<ListContact>>;

  /** Iterate through every matching member of a list, fetching cursor pages lazily. */
  iterate(
    listId: UUID,
    params?: ListListContactsParams,
    options?: RequestOptions,
  ): AsyncGenerator<ListContact, void, undefined>;

  /**
   * Add one existing contact to a list, or change the membership already there,
   * by UUID or raw email; the SDK encodes the path segment once. Omitting the
   * body sends `{}`, which never changes an existing membership's status. A
   * `complained` membership is frozen and answers 409. Authorization requires
   * `lists:write`.
   */
  upsert(
    listId: UUID,
    idOrEmail: string,
    body?: UpsertListContactRequest,
    options?: RequestOptions,
  ): AhaSendPromise<ListContact>;

  /**
   * Remove one contact from a list by UUID or raw email, discarding the
   * membership and any unsubscribe it recorded. Prefer `upsert` with
   * `subscription_status: "unsubscribed"` to stop marketing mail reversibly. A
   * `complained` membership cannot be removed and answers 409. Authorization
   * requires `lists:write`.
   */
  delete(
    listId: UUID,
    idOrEmail: string,
    options?: RequestOptions,
  ): AhaSendPromise<SuccessResponse>;

  /**
   * Synchronously add one through 1,000 existing contacts to a list. The
   * response is a 200 carrying one outcome per entry in input order; an
   * existing membership is never changed. Authorization requires `lists:write`.
   */
  batchAdd(
    listId: UUID,
    body: BatchAddListContactsRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<BatchAddListContactsResponse>;
}

class ListContactsClientImplementation implements ListContactsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    listId: UUID,
    params: ListListContactsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<ListContact>> {
    return this.#operations.execute(
      "getListContacts",
      {
        path: { account_id: this.#accountId, list_id: listId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    listId: UUID,
    params: ListListContactsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<ListContact, void, undefined> {
    return paginate<ListContact, ListListContactsParams>(
      (page) => this.list(listId, page, options),
      params,
    );
  }

  upsert(
    listId: UUID,
    idOrEmail: string,
    body: UpsertListContactRequest = {},
    options: RequestOptions = {},
  ): AhaSendPromise<ListContact> {
    return this.#operations.execute(
      "upsertListContact",
      {
        path: { account_id: this.#accountId, list_id: listId, id_or_email: idOrEmail },
        body,
      },
      forwardOptions(options),
    );
  }

  delete(
    listId: UUID,
    idOrEmail: string,
    options: RequestOptions = {},
  ): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteListContact",
      {
        path: { account_id: this.#accountId, list_id: listId, id_or_email: idOrEmail },
      },
      forwardOptions(options),
    );
  }

  batchAdd(
    listId: UUID,
    body: BatchAddListContactsRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<BatchAddListContactsResponse> {
    assertNonEmptyArray(body?.data, "data");
    return this.#operations.execute(
      "batchAddListContacts",
      { path: { account_id: this.#accountId, list_id: listId }, body },
      forwardWithIdempotency(options),
    );
  }
}

/** @internal Construct the list membership resource implementation for the lists client. */
export function createListContactsClient(
  operations: OperationExecutor,
  accountId: UUID,
): ListContactsClient {
  return new ListContactsClientImplementation(operations, accountId);
}
