import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
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
  domain?: string;
  reason?: string;
  expires_at: ISODateTime;
}

export interface CreateSuppressionResponse {
  object: "list";
  data: Suppression[];
}

export type ListSuppressionsParams = PaginationParams & {
  domain?: string;
  email?: string;
  from_time?: ISODateTime;
  to_time?: ISODateTime;
};

export interface DeleteSuppressionParams {
  email: string;
  domain?: string;
}

export interface WipeSuppressionsParams {
  domain?: string;
}

/**
 * Manage the suppression list — addresses the platform will refuse to
 * send to (after hard bounces, complaints, or manual additions).
 * Suppressions are identified by `(email, domain)`, not by id.
 */
export class SuppressionsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    params: ListSuppressionsParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Suppression>> {
    return this.#operations.execute<PaginatedResponse<Suppression>>(
      "getSuppressions",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListSuppressionsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Suppression, void, undefined> {
    return paginate<Suppression, ListSuppressionsParams>((p) => this.list(p, options), params);
  }

  create(
    body: CreateSuppressionRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreateSuppressionResponse> {
    return this.#operations.execute<CreateSuppressionResponse>(
      "createSuppression",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  /**
   * Delete a suppression. The AhaSend API identifies suppressions by
   * `(email, domain)` — there is no suppression-by-id endpoint — so this
   * method accepts those fields directly as query parameters.
   */
  delete(params: DeleteSuppressionParams, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "deleteSuppression",
      {
        path: { account_id: this.#accountId },
        query: params as unknown as Readonly<Record<string, unknown>>,
      },
      forwardOptions(options),
    );
  }

  /**
   * Dangerous: deletes ALL suppressions for the account, optionally
   * scoped to a single domain. Cannot be undone.
   */
  wipe(
    params: WipeSuppressionsParams = {},
    options: RequestOptions = {},
  ): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "deleteAllSuppressions",
      {
        path: { account_id: this.#accountId },
        query: params as unknown as Readonly<Record<string, unknown>>,
      },
      forwardOptions(options),
    );
  }
}
