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

/**
 * The type of email sent from a domain. It affects deliverability: marketing email sent from a
 * transactional domain can get the account paused.
 */
export type DomainSendingType = "transactional" | "marketing";

/**
 * Why sending from a domain is paused. `bounce_rate` means too many recent emails from the domain
 * bounced. The set is open: handle values added after this release as an unknown reason.
 */
export type DomainPauseReason = "bounce_rate" | (string & {});

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
  sending_type: DomainSendingType;
  /**
   * Whether sending from the domain is paused. While it is paused, new email from it is refused
   * and the domain cannot be deleted or renamed; the account's other domains keep sending.
   */
  paused: boolean;
  /** When sending from the domain was paused; null when it is not paused. */
  paused_at: ISODateTime | null;
  /** Why sending from the domain was paused; null when it is not paused. */
  pause_reason: DomainPauseReason | null;
}

export type ListDomainsParams = PaginationParams & {
  /** Filter by DNS validation state; null or omitted returns every domain. */
  dns_valid?: boolean | null | undefined;
  /** Return only domains of this sending type; omitted returns every domain. */
  sending_type?: DomainSendingType | undefined;
};

export interface CreateDomainRequest {
  domain: string;
  dkim_private_key?: string | undefined;
  tracking_subdomain?: string | undefined;
  return_path_subdomain?: string | undefined;
  subscription_subdomain?: string | undefined;
  media_subdomain?: string | undefined;
  dkim_rotation_interval_days?: number | undefined;
  /** Custom selector; null, empty, or whitespace-only uses the default selector on create. */
  dkim_selector?: string | null | undefined;
  /** Omit to create a transactional domain. */
  sending_type?: DomainSendingType | undefined;
}

export interface UpdateDomainRequest {
  tracking_subdomain?: string | undefined;
  return_path_subdomain?: string | undefined;
  subscription_subdomain?: string | undefined;
  media_subdomain?: string | undefined;
  dkim_rotation_interval_days?: number | undefined;
  /** Null leaves the selector unchanged; empty or whitespace-only clears the current override. */
  dkim_selector?: string | null | undefined;
  /**
   * Omit to leave the sending type unchanged. A change applies to new messages within five
   * minutes.
   */
  sending_type?: DomainSendingType | undefined;
}

/** Manage sending domains and their DNS verification state. */
export interface DomainsClient {
  /** Fetch one page of domains, optionally filtering by DNS verification state or sending type. */
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
   * whitespace-only `dkim_selector` selects the default selector on creation. Without
   * `sending_type`, the domain is transactional.
   */
  create(body: CreateDomainRequest, options?: IdempotencyRequestOptions): AhaSendPromise<Domain>;

  /** Retrieve a domain and its current DNS verification state by domain name. */
  get(domain: string, options?: RequestOptions): AhaSendPromise<Domain>;

  /**
   * Update a domain's optional subdomains, DKIM rotation interval, DKIM selector, or sending type.
   *
   * A null `dkim_selector` leaves the selector unchanged; an empty or whitespace-only
   * selector clears the current override.
   */
  update(
    domain: string,
    body: UpdateDomainRequest,
    options?: RequestOptions,
  ): AhaSendPromise<Domain>;

  /**
   * Delete a domain by domain name. While sending from the domain is paused, the API refuses the
   * delete with HTTP 403 (`AhaSendPermissionError`).
   */
  delete(domain: string, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /**
   * Trigger a DNS validation check and return the per-record propagation state.
   *
   * If the domain was checked within the last 60 seconds, the API returns the cached validation
   * result instead of performing a fresh lookup.
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
