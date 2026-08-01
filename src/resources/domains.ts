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
  label?: string;
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
  last_dns_check_at: ISODateTime | null;
  tracking_subdomain: string | null;
  return_path_subdomain: string | null;
  subscription_subdomain: string | null;
  media_subdomain: string | null;
  dkim_rotation_interval_days: number | null;
  dkim_selector: string | null;
  rotation_ready: boolean;
  dsn_recipient: string | null;
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
  /** Custom selector; null, empty, or whitespace-only uses the default selector on create. */
  dkim_selector?: string | null;
}

export interface UpdateDomainRequest {
  tracking_subdomain?: string;
  return_path_subdomain?: string;
  subscription_subdomain?: string;
  media_subdomain?: string;
  dkim_rotation_interval_days?: number;
  /** Null leaves the selector unchanged; empty or whitespace-only clears the current override. */
  dkim_selector?: string | null;
}

/** Manage sending domains and their DNS verification state. */
export interface DomainsClient {
  /** Fetch one page of domains, optionally filtering by DNS verification state. */
  list(
    params?: ListDomainsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Domain>>;

  /** Iterate through every domain, following cursor pagination until exhausted. */
  iterate(
    params?: ListDomainsParams,
    options?: RequestOptions,
  ): AsyncGenerator<Domain, void, undefined>;

  /**
   * Register a domain for sending.
   *
   * The returned `dns_records` are the records to publish. A null, empty, or
   * whitespace-only `dkim_selector` selects the default selector on creation.
   */
  create(body: CreateDomainRequest, options?: IdempotencyRequestOptions): AhaSendPromise<Domain>;

  /** Retrieve a domain and its current DNS verification state by domain name. */
  get(domain: string, options?: RequestOptions): AhaSendPromise<Domain>;

  /**
   * Update a domain's optional subdomains, DKIM rotation interval, or DKIM selector.
   *
   * A null `dkim_selector` leaves the selector unchanged; an empty or whitespace-only
   * selector clears the current override.
   */
  update(
    domain: string,
    body: UpdateDomainRequest,
    options?: RequestOptions,
  ): AhaSendPromise<Domain>;

  /** Delete a domain by domain name. */
  delete(domain: string, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /**
   * Trigger an immediate DNS re-check and return the refreshed per-record propagation state.
   *
   * This POST operation does not accept an idempotency key because the API contract does not
   * model it as idempotency-keyed.
   */
  checkDns(domain: string, options?: RequestOptions): AhaSendPromise<Domain>;
}

class DomainsClientImplementation implements DomainsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    params: ListDomainsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<Domain>> {
    return this.#operations.execute(
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

  create(
    body: CreateDomainRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<Domain> {
    return this.#operations.execute(
      "createDomain",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  get(domain: string, options: RequestOptions = {}): AhaSendPromise<Domain> {
    return this.#operations.execute(
      "getDomain",
      { path: { account_id: this.#accountId, domain } },
      forwardOptions(options),
    );
  }

  update(
    domain: string,
    body: UpdateDomainRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<Domain> {
    return this.#operations.execute(
      "updateDomain",
      { path: { account_id: this.#accountId, domain }, body },
      forwardOptions(options),
    );
  }

  delete(domain: string, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteDomain",
      { path: { account_id: this.#accountId, domain } },
      forwardOptions(options),
    );
  }

  checkDns(domain: string, options: RequestOptions = {}): AhaSendPromise<Domain> {
    return this.#operations.execute(
      "checkDomainDNS",
      { path: { account_id: this.#accountId, domain } },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the domain resource implementation for the root client. */
export function createDomainsClient(operations: OperationExecutor, accountId: UUID): DomainsClient {
  return new DomainsClientImplementation(operations, accountId);
}
