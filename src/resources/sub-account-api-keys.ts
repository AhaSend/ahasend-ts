import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import type {
  APIKey,
  CreateAPIKeyRequest,
  CreatedAPIKey,
  UpdateAPIKeyRequest,
} from "./api-keys.js";
import {
  assertNonEmptyArray,
  forwardOptions,
  forwardWithIdempotency,
  type IdempotencyRequestOptions,
} from "./_helpers.js";

/** Manage API keys owned by a child account. */
export interface SubAccountAPIKeysClient {
  /**
   * Fetch one cursor-paginated page of API keys owned by a child account.
   * The one-time `secret_key` is not included in list responses.
   *
   * Authorization requires `sub-account-api-keys:read` on the parent account.
   */
  list(
    subAccountId: UUID,
    params?: PaginationParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<APIKey>>;

  /** Iterate through every API key owned by a child account, fetching cursor pages lazily. */
  iterate(
    subAccountId: UUID,
    params?: PaginationParams,
    options?: RequestOptions,
  ): AsyncGenerator<APIKey, void, undefined>;

  /**
   * Create an API key owned by a child account.
   *
   * Authorization requires `sub-account-api-keys:write` on the parent account.
   * The response is the only time the child key's `secret_key` is exposed, except
   * for exact idempotent replays within the API's replay window.
   */
  create(
    subAccountId: UUID,
    body: CreateAPIKeyRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CreatedAPIKey>;

  /**
   * Fetch an API key owned by a child account. The one-time `secret_key` is not included.
   * Authorization requires `sub-account-api-keys:read` on the parent account.
   */
  get(subAccountId: UUID, keyId: UUID, options?: RequestOptions): AhaSendPromise<APIKey>;

  /**
   * Update the label, scopes, or IP allow list of an API key owned by a child account.
   * Authorization requires `sub-account-api-keys:write` on the parent account.
   */
  update(
    subAccountId: UUID,
    keyId: UUID,
    body: UpdateAPIKeyRequest,
    options?: RequestOptions,
  ): AhaSendPromise<APIKey>;

  /**
   * Delete an API key owned by a child account.
   * Authorization requires `sub-account-api-keys:delete` on the parent account.
   */
  delete(
    subAccountId: UUID,
    keyId: UUID,
    options?: RequestOptions,
  ): AhaSendPromise<SuccessResponse>;
}

class SubAccountAPIKeysClientImplementation implements SubAccountAPIKeysClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /**
   * Fetch one cursor-paginated page of API keys owned by a child account.
   * The one-time `secret_key` is not included in list responses.
   *
   * Authorization requires `sub-account-api-keys:read` on the parent account.
   */
  list(
    subAccountId: UUID,
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<APIKey>> {
    return this.#operations.execute(
      "listSubAccountAPIKeys",
      {
        path: { account_id: this.#accountId, sub_account_id: subAccountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /** Iterate through every API key owned by a child account, fetching cursor pages lazily. */
  iterate(
    subAccountId: UUID,
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<APIKey, void, undefined> {
    return paginate<APIKey, PaginationParams>(
      (page) => this.list(subAccountId, page, options),
      params,
    );
  }

  /**
   * Create an API key owned by a child account.
   *
   * Authorization requires `sub-account-api-keys:write` on the parent account.
   * The response is the only time the child key's `secret_key` is exposed, except
   * for exact idempotent replays within the API's replay window.
   */
  create(
    subAccountId: UUID,
    body: CreateAPIKeyRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CreatedAPIKey> {
    const forwarded = forwardWithIdempotency(options);
    assertNonEmptyArray(body?.scopes, "scopes");
    return this.#operations.execute(
      "createSubAccountAPIKey",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId }, body },
      forwarded,
    );
  }

  /**
   * Fetch an API key owned by a child account. The one-time `secret_key` is not included.
   * Authorization requires `sub-account-api-keys:read` on the parent account.
   */
  get(subAccountId: UUID, keyId: UUID, options: RequestOptions = {}): AhaSendPromise<APIKey> {
    return this.#operations.execute(
      "getSubAccountAPIKey",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId, key_id: keyId } },
      forwardOptions(options),
    );
  }

  /**
   * Update the label, scopes, or IP allow list of an API key owned by a child account.
   * Authorization requires `sub-account-api-keys:write` on the parent account.
   */
  update(
    subAccountId: UUID,
    keyId: UUID,
    body: UpdateAPIKeyRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<APIKey> {
    const forwarded = forwardOptions(options);
    if (body?.scopes !== undefined && body.scopes !== null) {
      assertNonEmptyArray(body.scopes, "scopes");
    }
    return this.#operations.execute(
      "updateSubAccountAPIKey",
      {
        path: { account_id: this.#accountId, sub_account_id: subAccountId, key_id: keyId },
        body,
      },
      forwarded,
    );
  }

  /**
   * Delete an API key owned by a child account.
   * Authorization requires `sub-account-api-keys:delete` on the parent account.
   */
  delete(
    subAccountId: UUID,
    keyId: UUID,
    options: RequestOptions = {},
  ): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteSubAccountAPIKey",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId, key_id: keyId } },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the nested API-key resource implementation. */
export function createSubAccountAPIKeysClient(
  operations: OperationExecutor,
  accountId: UUID,
): SubAccountAPIKeysClient {
  return new SubAccountAPIKeysClientImplementation(operations, accountId);
}
