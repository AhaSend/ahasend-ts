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

export interface Route {
  object: "route";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  url: string;
  recipient: string | null;
  attachments: boolean;
  headers: boolean;
  group_by_message_id: boolean;
  strip_replies: boolean;
  enabled: boolean;
  success_count?: number;
  error_count?: number;
  errors_since_last_success?: number;
  last_request_at?: ISODateTime | null;
}

export interface CreatedRoute extends Route {
  secret: string;
}

export interface CreateRouteRequest {
  name: string;
  url: string;
  domain: string;
  recipient: string;
  attachments?: boolean;
  headers?: boolean;
  group_by_message_id?: boolean;
  strip_replies?: boolean;
  enabled?: boolean;
}

export interface UpdateRouteRequest {
  name?: string | null;
  url?: string | null;
  recipient?: string | null;
  attachments?: boolean | null;
  headers?: boolean | null;
  group_by_message_id?: boolean | null;
  strip_replies?: boolean | null;
  enabled?: boolean | null;
}

export interface ListRoutesParams extends PaginationParams {
  domain?: string;
}

export class RoutesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  list(
    params: ListRoutesParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Route>> {
    return this.http.request<PaginatedResponse<Route>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/routes`,
      query: params as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  create(body: CreateRouteRequest, options: IdempotencyRequestOptions = {}): Promise<CreatedRoute> {
    return this.http.request<CreatedRoute>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/routes`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  get(routeId: UUID, options: RequestOptions = {}): Promise<Route> {
    return this.http.request<Route>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/routes/${encodeURIComponent(routeId)}`,
      ...forwardOptions(options),
    });
  }

  update(
    routeId: UUID,
    body: UpdateRouteRequest,
    options: RequestOptions = {},
  ): Promise<Route> {
    return this.http.request<Route>({
      method: "PUT",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/routes/${encodeURIComponent(routeId)}`,
      body,
      ...forwardOptions(options),
    });
  }

  delete(routeId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/routes/${encodeURIComponent(routeId)}`,
      ...forwardOptions(options),
    });
  }
}
