import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  IdempotencyRequestOptions,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import { createFrozenFacade, forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import { createListContactsClient } from "./list-contacts.js";
import type { EmbeddedContactList, ListContactsClient } from "./list-contacts.js";

/** A static, private, single opt-in container of contacts, and what a campaign targets. */
export interface ContactList extends EmbeddedContactList {
  /**
   * The members a campaign to this list would reach: confirmed memberships
   * whose contact is enabled, not unsubscribed account-wide, and not found
   * invalid by validation.
   */
  contact_count: number;
}

/** Fields accepted when creating a list. Values are trimmed before they are stored. */
export interface CreateContactListRequest {
  /** 1–255 characters after trimming; names are not unique within an account. */
  name: string;
  /** At most 1,000 characters. Null and omission both store an empty description. */
  description?: string | null | undefined;
  /** Trimmed, de-duplicated, and capped at 50. Null and omission both store none. */
  tags?: readonly string[] | null | undefined;
}

/**
 * A partial list update. An omitted or null field is left unchanged; `""`
 * clears the description and `[]` clears the tags. A name that is empty after
 * trimming is rejected with 400.
 */
export interface UpdateContactListRequest {
  name?: string | null | undefined;
  description?: string | null | undefined;
  tags?: readonly string[] | null | undefined;
}

/** Filters and cursor controls accepted by the list listing. */
export type ListListsParams = PaginationParams & {
  /** Case-insensitive substring match on the list name. */
  name?: string | undefined;
};

/** Manage the account's contact lists and their memberships. */
export interface ListsClient {
  /**
   * Fetch one newest-first page of lists using mutually exclusive cursors.
   * Authorization requires `lists:read`.
   */
  list(
    params?: ListListsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<ContactList>>;

  /** Iterate through every matching list, fetching cursor pages lazily. */
  iterate(
    params?: ListListsParams,
    options?: RequestOptions,
  ): AsyncGenerator<ContactList, void, undefined>;

  /** Retrieve one list by UUID. Authorization requires `lists:read`. */
  get(listId: UUID, options?: RequestOptions): AhaSendPromise<ContactList>;

  /** Create an empty list. Authorization requires `lists:write`. */
  create(
    body: CreateContactListRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<ContactList>;

  /** Partially update one list. Authorization requires `lists:write`. */
  update(
    listId: UUID,
    body: UpdateContactListRequest,
    options?: RequestOptions,
  ): AhaSendPromise<ContactList>;

  /**
   * Delete one list. Its memberships are kept, so an unsubscribe survives the
   * list. A list an unfinished campaign still needs answers 409.
   * Authorization requires `lists:delete`.
   */
  delete(listId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /** Manage the contacts on a list. */
  readonly contacts: Readonly<ListContactsClient>;
}

class ListsClientImplementation implements ListsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;
  readonly #contacts: Readonly<ListContactsClient>;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
    this.#contacts = createFrozenFacade(createListContactsClient(operations, accountId));
  }

  list(
    params: ListListsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<ContactList>> {
    return this.#operations.execute(
      "getLists",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListListsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<ContactList, void, undefined> {
    return paginate<ContactList, ListListsParams>((page) => this.list(page, options), params);
  }

  get(listId: UUID, options: RequestOptions = {}): AhaSendPromise<ContactList> {
    return this.#operations.execute(
      "getList",
      { path: { account_id: this.#accountId, list_id: listId } },
      forwardOptions(options),
    );
  }

  create(
    body: CreateContactListRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<ContactList> {
    return this.#operations.execute(
      "createList",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  update(
    listId: UUID,
    body: UpdateContactListRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<ContactList> {
    return this.#operations.execute(
      "updateList",
      { path: { account_id: this.#accountId, list_id: listId }, body },
      forwardOptions(options),
    );
  }

  delete(listId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteList",
      { path: { account_id: this.#accountId, list_id: listId } },
      forwardOptions(options),
    );
  }

  /** Manage the contacts on a list. */
  get contacts(): Readonly<ListContactsClient> {
    return this.#contacts;
  }
}

/** @internal Construct the lists resource implementation for the root client. */
export function createListsClient(operations: OperationExecutor, accountId: UUID): ListsClient {
  return new ListsClientImplementation(operations, accountId);
}
