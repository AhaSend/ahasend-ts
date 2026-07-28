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
  dkim_selector: string | null;
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

/** Manage sending domains and their DNS verification state. */
export class DomainsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /** Fetch one page of domains. Filter with `dns_valid` to find broken setups. */
  list(
    params: ListDomainsParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Domain>> {
    return this.#operations.execute<PaginatedResponse<Domain>>(
      "getDomains",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListDomainsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Domain, void, undefined> {
    return paginate<Domain, ListDomainsParams>((p) => this.list(p, options), params);
  }

  /**
   * Register a domain for sending. The response's `dns_records` lists
   * the records you must publish; poll {@link checkDns} afterwards to
   * confirm propagation.
   */
  create(body: CreateDomainRequest, options: IdempotencyRequestOptions = {}): Promise<Domain> {
    return this.#operations.execute<Domain>(
      "createDomain",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  get(domain: string, options: RequestOptions = {}): Promise<Domain> {
    return this.#operations.execute<Domain>(
      "getDomain",
      { path: { account_id: this.#accountId, domain } },
      forwardOptions(options),
    );
  }

  update(domain: string, body: UpdateDomainRequest, options: RequestOptions = {}): Promise<Domain> {
    return this.#operations.execute<Domain>(
      "updateDomain",
      { path: { account_id: this.#accountId, domain }, body },
      forwardOptions(options),
    );
  }

  delete(domain: string, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "deleteDomain",
      { path: { account_id: this.#accountId, domain } },
      forwardOptions(options),
    );
  }

  /**
   * Trigger an immediate DNS re-check and return the refreshed domain,
   * including per-record `propagated` status. (POST, but intentionally
   * not idempotency-keyed — the spec does not model it.)
   */
  checkDns(domain: string, options: RequestOptions = {}): Promise<Domain> {
    return this.#operations.execute<Domain>(
      "checkDomainDNS",
      { path: { account_id: this.#accountId, domain } },
      forwardOptions(options),
    );
  }
}
