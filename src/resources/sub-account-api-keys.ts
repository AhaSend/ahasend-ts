import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
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
  forwardOptions,
  forwardWithIdempotency,
  type IdempotencyRequestOptions,
} from "./_helpers.js";

/** Manage API keys owned by a child account. */
export class SubAccountAPIKeysClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    subAccountId: UUID,
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<APIKey>> {
    return this.#operations.execute<PaginatedResponse<APIKey>>(
      "listSubAccountAPIKeys",
      {
        path: { account_id: this.#accountId, sub_account_id: subAccountId },
        query: params as Readonly<Record<string, unknown>>,
      },
      forwardOptions(options),
    );
  }

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

  /** Create a child key whose `secret_key` is visible only in this response. */
  create(
    subAccountId: UUID,
    body: CreateAPIKeyRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreatedAPIKey> {
    return this.#operations.execute<CreatedAPIKey>(
      "createSubAccountAPIKey",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId }, body },
      forwardWithIdempotency(options),
    );
  }

  get(subAccountId: UUID, keyId: UUID, options: RequestOptions = {}): Promise<APIKey> {
    return this.#operations.execute<APIKey>(
      "getSubAccountAPIKey",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId, key_id: keyId } },
      forwardOptions(options),
    );
  }

  update(
    subAccountId: UUID,
    keyId: UUID,
    body: UpdateAPIKeyRequest,
    options: RequestOptions = {},
  ): Promise<APIKey> {
    return this.#operations.execute<APIKey>(
      "updateSubAccountAPIKey",
      {
        path: { account_id: this.#accountId, sub_account_id: subAccountId, key_id: keyId },
        body,
      },
      forwardOptions(options),
    );
  }

  delete(subAccountId: UUID, keyId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "deleteSubAccountAPIKey",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId, key_id: keyId } },
      forwardOptions(options),
    );
  }
}
