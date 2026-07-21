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
import {
  forwardOptions,
  forwardWithIdempotency,
  type IdempotencyRequestOptions,
} from "./_helpers.js";

/**
 * Scope identifier as written in requests — a plain string like
 * `"messages:send:all"` or `"messages:send:example.com"`.
 */
export type APIKeyScopeName = string;

/**
 * Scope record returned in API key responses. The server attaches
 * provenance metadata (id, timestamps, optional `domain_id` for
 * domain-scoped grants), so responses are objects rather than strings.
 */
export interface APIKeyScope {
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  api_key_id: UUID;
  scope: APIKeyScopeName;
  domain_id: UUID | null;
}

export interface APIKey {
  object: "api_key";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  last_used_at: ISODateTime | null;
  account_id: UUID;
  label: string;
  public_key: string;
  scopes: APIKeyScope[];
  ip_allow_list: string[];
}

/**
 * API key returned by `apiKeys.create()` — extends `APIKey` with the
 * one-time-visible `secret_key`. Matches the pattern used by
 * `CreatedRoute`, `CreatedWebhook`, and `CreatedSMTPCredential`.
 */
export interface CreatedAPIKey extends APIKey {
  /**
   * Returned only on creation. Persist this immediately — the API does
   * not expose the secret again on subsequent reads.
   */
  secret_key: string;
}

export interface CreateAPIKeyRequest {
  label: string;
  /** At least one scope is required by the API. */
  scopes: [APIKeyScopeName, ...APIKeyScopeName[]];
  ip_allow_list?: string[];
}

export interface UpdateAPIKeyRequest {
  label?: string | null;
  scopes?: APIKeyScopeName[] | null;
  ip_allow_list?: string[] | null;
}

/**
 * Manage API keys and their scopes. Scope strings follow
 * `resource:action:target`, e.g. `messages:send:all` or
 * `messages:send:example.com` (domain-scoped).
 */
export class APIKeysClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<APIKey>> {
    return this.#operations.execute<PaginatedResponse<APIKey>>(
      "getAPIKeys",
      {
        path: { account_id: this.#accountId },
        query: params as Readonly<Record<string, unknown>>,
      },
      forwardOptions(options),
    );
  }

  iterate(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<APIKey, void, undefined> {
    return paginate<APIKey, PaginationParams>((p) => this.list(p, options), params);
  }

  /**
   * Create a key. The response is the only time `secret_key` is
   * visible — persist it immediately.
   */
  create(
    body: CreateAPIKeyRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreatedAPIKey> {
    return this.#operations.execute<CreatedAPIKey>(
      "createAPIKey",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  get(keyId: UUID, options: RequestOptions = {}): Promise<APIKey> {
    return this.#operations.execute<APIKey>(
      "getAPIKey",
      { path: { account_id: this.#accountId, key_id: keyId } },
      forwardOptions(options),
    );
  }

  update(keyId: UUID, body: UpdateAPIKeyRequest, options: RequestOptions = {}): Promise<APIKey> {
    return this.#operations.execute<APIKey>(
      "updateAPIKey",
      { path: { account_id: this.#accountId, key_id: keyId }, body },
      forwardOptions(options),
    );
  }

  delete(keyId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "deleteAPIKey",
      { path: { account_id: this.#accountId, key_id: keyId } },
      forwardOptions(options),
    );
  }
}
