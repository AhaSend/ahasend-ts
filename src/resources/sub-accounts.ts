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
import { createFrozenFacade, forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { IdempotencyRequestOptions } from "./_helpers.js";
import { createSubAccountAPIKeysClient } from "./sub-account-api-keys.js";
import type { SubAccountAPIKeysClient } from "./sub-account-api-keys.js";

export type SubAccountStatus = "active" | "suspended" | "parent-suspended" | "deleted";

export interface SubAccount {
  object: "sub_account";
  id: UUID;
  parent_account_id: UUID;
  created_at: ISODateTime;
  name: string;
  website: string;
  status: SubAccountStatus;
  /** OpenAPI `int64`, represented as a number and only exact within the safe-integer range. */
  monthly_credit: number;
  /** OpenAPI `int64`, represented as a number and only exact within the safe-integer range. */
  domain_count: number;
  /** OpenAPI `int64`, represented as a number and only exact within the safe-integer range. */
  member_count: number;
  last_activity_at: ISODateTime | null;
}

export interface CreateSubAccountRequest {
  name: string;
  /**
   * A bare fully-qualified domain name (`acme.example.com`), **not** a URL —
   * the API validates `format: fqdn` and rejects `https://…` with HTTP 400.
   */
  website: string;
  /** OpenAPI `int64`, represented as a JavaScript number. Valid values are 0 to 1 billion. */
  monthly_credit?: number | undefined;
}

/** At least one non-null field is required; omitted or null fields are left unchanged. */
export type UpdateSubAccountRequest = {
  name?: string | null | undefined;
  /** Bare FQDN, not a URL — see {@link CreateSubAccountRequest.website}. */
  website?: string | null | undefined;
  /** OpenAPI `int64`, represented as a JavaScript number. Valid values are 0 to 1 billion. */
  monthly_credit?: number | null | undefined;
} & ({ name: string } | { website: string } | { monthly_credit: number });

export interface SuspendSubAccountRequest {
  reason: string;
}

export interface SubAccountUsageBreakdown {
  account_id?: UUID;
  name?: string;
  /** OpenAPI `int64`, represented as a number and only exact within the safe-integer range. */
  reception_count: number;
  allocated_cost: number;
}

export interface SubAccountUsageResponse {
  billing_period: {
    start: ISODateTime;
    end: ISODateTime;
  };
  currency: string;
  allocation_method: "proportional";
  allocation_note: string;
  parent: SubAccountUsageBreakdown & { account_id: UUID };
  sub_accounts: Array<SubAccountUsageBreakdown & { account_id: UUID; name: string }>;
  removed_sub_accounts: SubAccountUsageBreakdown;
  total: SubAccountUsageBreakdown;
}

export type ListSubAccountsParams = PaginationParams;

/** Manage child accounts and inspect their pooled billing usage. */
export interface SubAccountsClient {
  /**
   * Fetch one cursor-paginated page of child accounts.
   * Soft-deleted child accounts are omitted.
   * Authorization requires `sub-accounts:read`.
   */
  list(
    params?: ListSubAccountsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<SubAccount>>;

  /** Iterate through every visible child account, fetching cursor pages lazily. */
  iterate(
    params?: ListSubAccountsParams,
    options?: RequestOptions,
  ): AsyncGenerator<SubAccount, void, undefined>;

  /**
   * Create a child account under the parent account.
   * Authorization requires `sub-accounts:write`.
   */
  create(
    body: CreateSubAccountRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<SubAccount>;

  /**
   * Return current billing-period usage and proportionally allocated costs for
   * the parent and its child accounts. Authorization requires `sub-accounts:usage`.
   */
  usage(options?: RequestOptions): AhaSendPromise<SubAccountUsageResponse>;

  /** Fetch a child account by ID. Authorization requires `sub-accounts:read`. */
  get(subAccountId: UUID, options?: RequestOptions): AhaSendPromise<SubAccount>;

  /**
   * Update a child account's editable settings. Omitted and `null` fields remain unchanged.
   * Authorization requires `sub-accounts:write`.
   */
  update(
    subAccountId: UUID,
    body: UpdateSubAccountRequest,
    options?: RequestOptions,
  ): AhaSendPromise<SubAccount>;

  /**
   * Soft-delete a child account. Authorization requires `sub-accounts:delete`.
   * Usage from a child account deleted during the current billing period remains
   * represented in the usage report's `removed_sub_accounts` aggregate.
   */
  delete(subAccountId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /**
   * Suspend a child account with the supplied reason.
   * Authorization requires `sub-accounts:suspend`.
   */
  suspend(
    subAccountId: UUID,
    body: SuspendSubAccountRequest,
    options?: RequestOptions,
  ): AhaSendPromise<SubAccount>;

  /**
   * Restore a suspended child account. Authorization requires `sub-accounts:suspend`.
   */
  unsuspend(subAccountId: UUID, options?: RequestOptions): AhaSendPromise<SubAccount>;

  /** Manage API keys owned by child accounts through the parent account. */
  readonly apiKeys: Readonly<SubAccountAPIKeysClient>;
}

class SubAccountsClientImplementation implements SubAccountsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;
  readonly #apiKeys: Readonly<SubAccountAPIKeysClient>;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
    this.#apiKeys = createFrozenFacade(createSubAccountAPIKeysClient(operations, accountId));
  }

  /**
   * Fetch one cursor-paginated page of child accounts.
   * Soft-deleted child accounts are omitted.
   * Authorization requires `sub-accounts:read`.
   */
  list(
    params: ListSubAccountsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<SubAccount>> {
    return this.#operations.execute(
      "listSubAccounts",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /** Iterate through every visible child account, fetching cursor pages lazily. */
  iterate(
    params: ListSubAccountsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<SubAccount, void, undefined> {
    return paginate<SubAccount, ListSubAccountsParams>((p) => this.list(p, options), params);
  }

  /**
   * Create a child account under the parent account.
   * Authorization requires `sub-accounts:write`.
   */
  create(
    body: CreateSubAccountRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<SubAccount> {
    return this.#operations.execute(
      "createSubAccount",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  /**
   * Return current billing-period usage and proportionally allocated costs for
   * the parent and its child accounts. Authorization requires `sub-accounts:usage`.
   */
  usage(options: RequestOptions = {}): AhaSendPromise<SubAccountUsageResponse> {
    return this.#operations.execute(
      "getSubAccountsUsage",
      { path: { account_id: this.#accountId } },
      forwardOptions(options),
    );
  }

  /** Fetch a child account by ID. Authorization requires `sub-accounts:read`. */
  get(subAccountId: UUID, options: RequestOptions = {}): AhaSendPromise<SubAccount> {
    return this.#operations.execute(
      "getSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId } },
      forwardOptions(options),
    );
  }

  /**
   * Update a child account's editable settings. Omitted and `null` fields remain unchanged.
   * Authorization requires `sub-accounts:write`.
   */
  update(
    subAccountId: UUID,
    body: UpdateSubAccountRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<SubAccount> {
    return this.#operations.execute(
      "updateSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId }, body },
      forwardOptions(options),
    );
  }

  /**
   * Soft-delete a child account. Authorization requires `sub-accounts:delete`.
   * Usage from a child account deleted during the current billing period remains
   * represented in the usage report's `removed_sub_accounts` aggregate.
   */
  delete(subAccountId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId } },
      forwardOptions(options),
    );
  }

  /**
   * Suspend a child account with the supplied reason.
   * Authorization requires `sub-accounts:suspend`.
   */
  suspend(
    subAccountId: UUID,
    body: SuspendSubAccountRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<SubAccount> {
    return this.#operations.execute(
      "suspendSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId }, body },
      forwardOptions(options),
    );
  }

  /**
   * Restore a suspended child account. Authorization requires `sub-accounts:suspend`.
   */
  unsuspend(subAccountId: UUID, options: RequestOptions = {}): AhaSendPromise<SubAccount> {
    return this.#operations.execute(
      "unsuspendSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId } },
      forwardOptions(options),
    );
  }

  /** Manage API keys owned by child accounts through the parent account. */
  get apiKeys(): Readonly<SubAccountAPIKeysClient> {
    return this.#apiKeys;
  }
}

/** @internal Construct the sub-account resource implementation for the root client. */
export function createSubAccountsClient(
  operations: OperationExecutor,
  accountId: UUID,
): SubAccountsClient {
  return new SubAccountsClientImplementation(operations, accountId);
}
