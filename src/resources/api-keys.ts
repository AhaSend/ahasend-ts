import type { HttpClient } from "../http.js";
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
  domain_id?: UUID | null;
}

export interface APIKey {
  object: "api_key";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  last_used_at?: ISODateTime | null;
  account_id: UUID;
  label: string;
  public_key: string;
  scopes: APIKeyScope[];
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
}

export interface UpdateAPIKeyRequest {
  label?: string;
  scopes?: APIKeyScopeName[];
}

/** @deprecated Use `IdempotencyRequestOptions` from the public API. */
export type APIKeyRequestOptions = IdempotencyRequestOptions;

/**
 * Manage API keys and their scopes. Scope strings follow
 * `resource:action:target`, e.g. `messages:send:all` or
 * `messages:send:example.com` (domain-scoped).
 */
export class APIKeysClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  list(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<APIKey>> {
    return this.http.request<PaginatedResponse<APIKey>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/api-keys`,
      query: params as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  iterate(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<APIKey, void, undefined> {
    return paginate<APIKey, PaginationParams>(
      (p) => this.list(p, options),
      params,
    );
  }

  /**
   * Create a key. The response is the only time `secret_key` is
   * visible — persist it immediately.
   */
  create(
    body: CreateAPIKeyRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreatedAPIKey> {
    return this.http.request<CreatedAPIKey>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/api-keys`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  get(keyId: UUID, options: RequestOptions = {}): Promise<APIKey> {
    return this.http.request<APIKey>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/api-keys/${encodeURIComponent(keyId)}`,
      ...forwardOptions(options),
    });
  }

  update(keyId: UUID, body: UpdateAPIKeyRequest, options: RequestOptions = {}): Promise<APIKey> {
    return this.http.request<APIKey>({
      method: "PUT",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/api-keys/${encodeURIComponent(keyId)}`,
      body,
      ...forwardOptions(options),
    });
  }

  delete(keyId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/api-keys/${encodeURIComponent(keyId)}`,
      ...forwardOptions(options),
    });
  }
}
