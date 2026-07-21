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

export interface DNSRecord {
  type: string;
  host: string;
  content: string;
  required: boolean;
  propagated: boolean;
  label?: string | null;
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
  last_dns_check_at?: ISODateTime | null;
  tracking_subdomain?: string | null;
  return_path_subdomain?: string | null;
  subscription_subdomain?: string | null;
  media_subdomain?: string | null;
  dkim_rotation_interval_days?: number | null;
  rotation_ready?: boolean;
  dsn_recipient?: string | null;
}

export type ListDomainsParams = PaginationParams & {
  dns_valid?: boolean;
};

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

/** @deprecated Use `IdempotencyRequestOptions` from the public API. */
export type DomainRequestOptions = IdempotencyRequestOptions;

/** Manage sending domains and their DNS verification state. */
export class DomainsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  /** Fetch one page of domains. Filter with `dns_valid` to find broken setups. */
  list(
    params: ListDomainsParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Domain>> {
    return this.http.request<PaginatedResponse<Domain>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains`,
      query: params as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  iterate(
    params: ListDomainsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Domain, void, undefined> {
    return paginate<Domain, ListDomainsParams>(
      (p) => this.list(p, options),
      params,
    );
  }

  /**
   * Register a domain for sending. The response's `dns_records` lists
   * the records you must publish; poll {@link checkDns} afterwards to
   * confirm propagation.
   */
  create(body: CreateDomainRequest, options: IdempotencyRequestOptions = {}): Promise<Domain> {
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
      ...forwardOptions(options),
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
      ...forwardOptions(options),
    });
  }

  delete(domain: string, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}`,
      ...forwardOptions(options),
    });
  }

  /**
   * Trigger an immediate DNS re-check and return the refreshed domain,
   * including per-record `propagated` status. (POST, but intentionally
   * not idempotency-keyed — the spec does not model it.)
   */
  checkDns(domain: string, options: RequestOptions = {}): Promise<Domain> {
    return this.http.request<Domain>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}/check-dns`,
      ...forwardOptions(options),
    });
  }
}
