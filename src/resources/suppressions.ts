import type { HttpClient } from "../http.js";
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
  domain?: string | null;
  reason?: string | null;
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

export class SuppressionsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  list(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Suppression>> {
    return this.http.request<PaginatedResponse<Suppression>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/suppressions`,
      query: params as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  create(
    body: CreateSuppressionRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreateSuppressionResponse> {
    return this.http.request<CreateSuppressionResponse>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/suppressions`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  delete(suppressionId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/suppressions/${encodeURIComponent(suppressionId)}`,
      ...forwardOptions(options),
    });
  }

  /**
   * Dangerous: deletes ALL suppressions for the account. Cannot be undone.
   */
  wipe(options: IdempotencyRequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/suppressions/wipe`,
      ...forwardWithIdempotency(options),
    });
  }
}
