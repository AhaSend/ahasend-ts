import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  UUID,
} from "../types/common.js";
import type { Segment } from "./segments.js";
import { forwardOptions } from "./_helpers.js";

/** Cursor controls accepted when listing one contact's segments, which takes no filters. */
export type ListContactSegmentsParams = PaginationParams;

/** Read the segments one contact is a member of. */
export interface ContactSegmentsClient {
  /**
   * Fetch one newest-first page of the segments one contact is a member of, by UUID or raw email.
   * The SDK encodes the path segment once. A segment that is `building` may still list the
   * contact by its previous rules. Authorization requires `segments:read` and `contacts:read`.
   */
  list(
    idOrEmail: string,
    params?: ListContactSegmentsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Segment>>;

  /** Iterate through every segment one contact is a member of, fetching cursor pages lazily. */
  iterate(
    idOrEmail: string,
    params?: ListContactSegmentsParams,
    options?: RequestOptions,
  ): AsyncGenerator<Segment, void, undefined>;
}

class ContactSegmentsClientImplementation implements ContactSegmentsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    idOrEmail: string,
    params: ListContactSegmentsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<Segment>> {
    return this.#operations.execute(
      "getContactSegments",
      {
        path: { account_id: this.#accountId, id_or_email: idOrEmail },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    idOrEmail: string,
    params: ListContactSegmentsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Segment, void, undefined> {
    return paginate<Segment, ListContactSegmentsParams>(
      (page) => this.list(idOrEmail, page, options),
      params,
    );
  }
}

/** @internal Construct the contact-segments resource implementation for the contacts client. */
export function createContactSegmentsClient(
  operations: OperationExecutor,
  accountId: UUID,
): ContactSegmentsClient {
  return new ContactSegmentsClientImplementation(operations, accountId);
}
