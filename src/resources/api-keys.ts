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
import {
  assertNonEmptyArray,
  forwardOptions,
  forwardWithIdempotency,
  type IdempotencyRequestOptions,
} from "./_helpers.js";

/**
 * Scope identifier as written in requests — a plain string like
 * `"messages:send:all"` or `"messages:send:{example.com}"` — the curly
 * braces around the domain are part of the scope string.
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
  scopes: readonly APIKeyScopeName[];
  ip_allow_list?: readonly string[] | undefined;
}

/** At least one field must select a non-null update value. */
export type UpdateAPIKeyRequest = {
  label?: string | null | undefined;
  scopes?: readonly APIKeyScopeName[] | null | undefined;
  ip_allow_list?: readonly string[] | null | undefined;
} & (
  | { label: string }
  | { scopes: readonly APIKeyScopeName[] }
  | { ip_allow_list: readonly string[] }
);

/**
 * Manage API keys and their scopes. Scope strings follow
 * `resource:action:target`, e.g. `messages:send:all` or
 * `messages:send:{example.com}` (domain-scoped; the curly braces are part
 * of the scope string).
 */
export interface APIKeysClient {
  /** List API keys for the account using cursor pagination. */
  list(
    params?: PaginationParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<APIKey>>;

  /** Iterate through every API key, following cursor pagination until exhausted. */
  iterate(
    params?: PaginationParams,
    options?: RequestOptions,
  ): AsyncGenerator<APIKey, void, undefined>;

  /**
   * Create an API key with one or more scopes.
   *
   * The response is the only time `secret_key` is visible; persist it immediately.
   */
  create(
    body: CreateAPIKeyRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CreatedAPIKey>;

  /** Retrieve an API key by its ID without exposing its secret key. */
  get(keyId: UUID, options?: RequestOptions): AhaSendPromise<APIKey>;

  /** Update at least one field to a non-null value; omitted or null fields remain unchanged. */
  update(keyId: UUID, body: UpdateAPIKeyRequest, options?: RequestOptions): AhaSendPromise<APIKey>;

  /** Delete an API key by its ID. */
  delete(keyId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;
}

class APIKeysClientImplementation implements APIKeysClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<APIKey>> {
    return this.#operations.execute(
      "getAPIKeys",
      {
        path: { account_id: this.#accountId },
        query: params,
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

  create(
    body: CreateAPIKeyRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CreatedAPIKey> {
    const forwarded = forwardWithIdempotency(options);
    assertNonEmptyArray(body?.scopes, "scopes");
    return this.#operations.execute(
      "createAPIKey",
      { path: { account_id: this.#accountId }, body },
      forwarded,
    );
  }

  get(keyId: UUID, options: RequestOptions = {}): AhaSendPromise<APIKey> {
    return this.#operations.execute(
      "getAPIKey",
      { path: { account_id: this.#accountId, key_id: keyId } },
      forwardOptions(options),
    );
  }

  update(
    keyId: UUID,
    body: UpdateAPIKeyRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<APIKey> {
    const forwarded = forwardOptions(options);
    if (body?.scopes !== undefined && body.scopes !== null) {
      assertNonEmptyArray(body.scopes, "scopes");
    }
    return this.#operations.execute(
      "updateAPIKey",
      { path: { account_id: this.#accountId, key_id: keyId }, body },
      forwarded,
    );
  }

  delete(keyId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteAPIKey",
      { path: { account_id: this.#accountId, key_id: keyId } },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the API-key resource implementation for the root client. */
export function createAPIKeysClient(operations: OperationExecutor, accountId: UUID): APIKeysClient {
  return new APIKeysClientImplementation(operations, accountId);
}
