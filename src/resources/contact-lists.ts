import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  UUID,
} from "../types/common.js";
import type { ListContact, ListContactSubscriptionStatus } from "./list-contacts.js";
import { forwardOptions } from "./_helpers.js";

/** Filters and cursor controls accepted when listing one contact's memberships. */
export type ListContactListsParams = PaginationParams & {
  subscription_status?: ListContactSubscriptionStatus | undefined;
};

/** Read the lists one contact is on. */
export interface ContactListsClient {
  /**
   * Fetch one newest-first page of the memberships one contact holds, by UUID
   * or raw email, each with its list embedded. The SDK encodes the path segment
   * once. Deleted lists are excluded. Authorization requires `lists:read`.
   */
  list(
    idOrEmail: string,
    params?: ListContactListsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<ListContact>>;

  /** Iterate through every membership one contact holds, fetching cursor pages lazily. */
  iterate(
    idOrEmail: string,
    params?: ListContactListsParams,
    options?: RequestOptions,
  ): AsyncGenerator<ListContact, void, undefined>;
}

class ContactListsClientImplementation implements ContactListsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    idOrEmail: string,
    params: ListContactListsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<ListContact>> {
    return this.#operations.execute(
      "getContactLists",
      {
        path: { account_id: this.#accountId, id_or_email: idOrEmail },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    idOrEmail: string,
    params: ListContactListsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<ListContact, void, undefined> {
    return paginate<ListContact, ListContactListsParams>(
      (page) => this.list(idOrEmail, page, options),
      params,
    );
  }
}

/** @internal Construct the contact-memberships resource implementation for the contacts client. */
export function createContactListsClient(
  operations: OperationExecutor,
  accountId: UUID,
): ContactListsClient {
  return new ContactListsClientImplementation(operations, accountId);
}
