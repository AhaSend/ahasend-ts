import type { HttpClient } from "../http.js";
import type {
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";

export type APIKeyScope = string;

export interface APIKey {
  object: "api_key";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  last_used_at?: ISODateTime;
  account_id: UUID;
  label: string;
  public_key: string;
  secret_key?: string;
  scopes: APIKeyScope[];
}

export interface CreateAPIKeyRequest {
  label: string;
  scopes: APIKeyScope[];
}

export interface UpdateAPIKeyRequest {
  label?: string;
  scopes?: APIKeyScope[];
}

export interface APIKeyRequestOptions extends RequestOptions {
  idempotencyKey?: string;
}

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
      ...forward(options),
    });
  }

  create(body: CreateAPIKeyRequest, options: APIKeyRequestOptions = {}): Promise<APIKey> {
    return this.http.request<APIKey>({
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
      ...forward(options),
    });
  }

  update(keyId: UUID, body: UpdateAPIKeyRequest, options: RequestOptions = {}): Promise<APIKey> {
    return this.http.request<APIKey>({
      method: "PUT",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/api-keys/${encodeURIComponent(keyId)}`,
      body,
      ...forward(options),
    });
  }

  delete(keyId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/api-keys/${encodeURIComponent(keyId)}`,
      ...forward(options),
    });
  }
}

function forward(options: RequestOptions): { signal?: AbortSignal; headers?: Record<string, string> } {
  const out: { signal?: AbortSignal; headers?: Record<string, string> } = {};
  if (options.signal) out.signal = options.signal;
  if (options.headers) out.headers = options.headers;
  return out;
}

function forwardWithIdempotency(
  options: APIKeyRequestOptions,
): { signal?: AbortSignal; headers?: Record<string, string> } {
  const base = forward(options);
  if (options.idempotencyKey) {
    base.headers = { ...(base.headers ?? {}), "Idempotency-Key": options.idempotencyKey };
  }
  return base;
}
