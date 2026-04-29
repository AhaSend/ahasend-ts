import type { HttpClient } from "../http.js";
import type {
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";

export interface DNSRecord {
  name: string;
  type: string;
  content: string;
  valid?: boolean;
  [key: string]: unknown;
}

export interface Domain {
  object: "domain";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  domain: string;
  account_id: UUID;
  dns_records: DNSRecord[];
  dns_valid: boolean;
  last_dns_check_at?: ISODateTime;
  tracking_subdomain?: string;
  return_path_subdomain?: string;
  subscription_subdomain?: string;
  media_subdomain?: string;
  dkim_rotation_interval_days?: number;
  rotation_ready?: boolean;
  dsn_recipient?: string;
}

export interface ListDomainsParams extends PaginationParams {
  dns_valid?: boolean;
}

export interface CreateDomainRequest {
  domain: string;
  dkim_private_key?: string;
  tracking_subdomain?: string;
  return_path_subdomain?: string;
  subscription_subdomain?: string;
  media_subdomain?: string;
  dkim_rotation_interval_days?: number;
}

export interface UpdateDomainRequest {
  tracking_subdomain?: string;
  return_path_subdomain?: string;
  subscription_subdomain?: string;
  media_subdomain?: string;
  dkim_rotation_interval_days?: number;
}

export interface DomainRequestOptions extends RequestOptions {
  idempotencyKey?: string;
}

export class DomainsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  list(
    params: ListDomainsParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Domain>> {
    return this.http.request<PaginatedResponse<Domain>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains`,
      query: params as Record<string, unknown>,
      ...forward(options),
    });
  }

  create(body: CreateDomainRequest, options: DomainRequestOptions = {}): Promise<Domain> {
    return this.http.request<Domain>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  get(domain: string, options: RequestOptions = {}): Promise<Domain> {
    return this.http.request<Domain>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}`,
      ...forward(options),
    });
  }

  update(
    domain: string,
    body: UpdateDomainRequest,
    options: RequestOptions = {},
  ): Promise<Domain> {
    return this.http.request<Domain>({
      method: "PUT",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}`,
      body,
      ...forward(options),
    });
  }

  delete(domain: string, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}`,
      ...forward(options),
    });
  }

  checkDns(domain: string, options: RequestOptions = {}): Promise<Domain> {
    return this.http.request<Domain>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}/check-dns`,
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
  options: DomainRequestOptions,
): { signal?: AbortSignal; headers?: Record<string, string> } {
  const base = forward(options);
  if (options.idempotencyKey) {
    base.headers = { ...(base.headers ?? {}), "Idempotency-Key": options.idempotencyKey };
  }
  return base;
}
