import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  UUID,
} from "../types/common.js";
import type { SegmentContact } from "./segments.js";
import { forwardOptions } from "./_helpers.js";

/** Cursor controls accepted when listing one segment's members, which takes no filters. */
export type ListSegmentContactsParams = PaginationParams;

/** Read the members of a segment. */
export interface SegmentContactsClient {
  /**
   * Fetch one page of a segment's members by contact ID, from the lowest, using mutually
   * exclusive cursors. A member matches the rules whatever its consent. While the segment is
   * `building`, its members may still follow its previous rules.
   * Authorization requires `segments:read` and `contacts:read`.
   */
  list(
    segmentId: UUID,
    params?: ListSegmentContactsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<SegmentContact>>;

  /** Iterate through every member of a segment, fetching cursor pages lazily. */
  iterate(
    segmentId: UUID,
    params?: ListSegmentContactsParams,
    options?: RequestOptions,
  ): AsyncGenerator<SegmentContact, void, undefined>;
}

class SegmentContactsClientImplementation implements SegmentContactsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    segmentId: UUID,
    params: ListSegmentContactsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<SegmentContact>> {
    return this.#operations.execute(
      "getSegmentContacts",
      {
        path: { account_id: this.#accountId, segment_id: segmentId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    segmentId: UUID,
    params: ListSegmentContactsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<SegmentContact, void, undefined> {
    return paginate<SegmentContact, ListSegmentContactsParams>(
      (page) => this.list(segmentId, page, options),
      params,
    );
  }
}

/** @internal Construct the segment members resource implementation for the segments client. */
export function createSegmentContactsClient(
  operations: OperationExecutor,
  accountId: UUID,
): SegmentContactsClient {
  return new SegmentContactsClientImplementation(operations, accountId);
}
