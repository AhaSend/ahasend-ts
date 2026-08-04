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
import { forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { IdempotencyRequestOptions } from "./_helpers.js";

export interface Suppression {
  object: "suppression";
  id: UUID;
  created_at: ISODateTime;
  email: string;
  domain: string;
  reason: string;
  expires_at: ISODateTime;
}

export interface CreateSuppressionRequest {
  email: string;
  domain?: string | undefined;
  reason?: string | undefined;
  expires_at: ISODateTime;
}

export interface CreateSuppressionResponse {
  object: "list";
  data: Suppression[];
}

export type ListSuppressionsParams = PaginationParams & {
  domain?: string | undefined;
  email?: string | undefined;
  from_time?: ISODateTime | undefined;
  to_time?: ISODateTime | undefined;
};

export interface DeleteSuppressionParams {
  email: string;
  domain?: string | undefined;
}

export interface WipeSuppressionsParams {
  domain?: string | undefined;
}

/**
 * Manage the suppression list — addresses the platform will refuse to
 * send to (after hard bounces, complaints, or manual additions).
 * Suppressions are identified by `(email, domain)`, not by id.
 */
export interface SuppressionsClient {
  /**
   * Fetch one cursor-paginated page of suppressions, optionally filtered by domain,
   * email address, or creation time. Authorization requires `suppressions:read`.
   */
  list(
    params?: ListSuppressionsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Suppression>>;

  /** Iterate through every matching suppression, fetching cursor pages lazily. */
  iterate(
    params?: ListSuppressionsParams,
    options?: RequestOptions,
  ): AsyncGenerator<Suppression, void, undefined>;

  /**
   * Add an email address to the suppression list, optionally scoped to a domain.
   * Authorization requires `suppressions:write`.
   */
  create(
    body: CreateSuppressionRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CreateSuppressionResponse>;

  /**
   * Delete suppressions for an email address, optionally scoped to a domain.
   * Authorization requires `suppressions:delete`.
   */
  delete(
    params: DeleteSuppressionParams,
    options?: RequestOptions,
  ): AhaSendPromise<SuccessResponse>;

  /**
   * Delete every suppression for the account, optionally scoped to a domain.
   * This operation cannot be undone. Authorization requires `suppressions:wipe`.
   */
  wipe(params?: WipeSuppressionsParams, options?: RequestOptions): AhaSendPromise<SuccessResponse>;
}

class SuppressionsClientImplementation implements SuppressionsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /**
   * Fetch one cursor-paginated page of suppressions, optionally filtered by domain,
   * email address, or creation time. Authorization requires `suppressions:read`.
   */
  list(
    params: ListSuppressionsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<Suppression>> {
    return this.#operations.execute(
      "getSuppressions",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /** Iterate through every matching suppression, fetching cursor pages lazily. */
  iterate(
    params: ListSuppressionsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Suppression, void, undefined> {
    return paginate<Suppression, ListSuppressionsParams>((p) => this.list(p, options), params);
  }

  /**
   * Add an email address to the suppression list, optionally scoped to a domain.
   * Authorization requires `suppressions:write`.
   */
  create(
    body: CreateSuppressionRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CreateSuppressionResponse> {
    return this.#operations.execute(
      "createSuppression",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  /**
   * Delete suppressions for an email address, optionally scoped to a domain.
   * Authorization requires `suppressions:delete`.
   */
  delete(
    params: DeleteSuppressionParams,
    options: RequestOptions = {},
  ): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteSuppression",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /**
   * Delete every suppression for the account, optionally scoped to a domain.
   * This operation cannot be undone. Authorization requires `suppressions:wipe`.
   */
  wipe(
    params: WipeSuppressionsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteAllSuppressions",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the suppression resource implementation for the root client. */
export function createSuppressionsClient(
  operations: OperationExecutor,
  accountId: UUID,
): SuppressionsClient {
  return new SuppressionsClientImplementation(operations, accountId);
}
