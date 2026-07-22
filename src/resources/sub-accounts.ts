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
import { createFrozenFacade, forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { IdempotencyRequestOptions } from "./_helpers.js";
import { SubAccountAPIKeysClient } from "./sub-account-api-keys.js";

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
  website: string;
  /** OpenAPI `int64`, represented as a JavaScript number. Valid values are 0 to 1 billion. */
  monthly_credit?: number;
}

type SubAccountUpdateFields = {
  name?: string | null;
  website?: string | null;
  /** OpenAPI `int64`, represented as a JavaScript number. Valid values are 0 to 1 billion. */
  monthly_credit?: number | null;
};

/** At least one non-null field is required; omitted or null fields are left unchanged. */
export type UpdateSubAccountRequest = SubAccountUpdateFields &
  ({ name: string } | { website: string } | { monthly_credit: number });

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
export class SubAccountsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;
  readonly #apiKeys: Readonly<SubAccountAPIKeysClient>;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
    this.#apiKeys = createFrozenFacade(new SubAccountAPIKeysClient(operations, accountId));
  }

  list(
    params: ListSubAccountsParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<SubAccount>> {
    return this.#operations.execute<PaginatedResponse<SubAccount>>(
      "listSubAccounts",
      {
        path: { account_id: this.#accountId },
        query: params as Readonly<Record<string, unknown>>,
      },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListSubAccountsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<SubAccount, void, undefined> {
    return paginate<SubAccount, ListSubAccountsParams>((p) => this.list(p, options), params);
  }

  create(
    body: CreateSubAccountRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<SubAccount> {
    return this.#operations.execute<SubAccount>(
      "createSubAccount",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  usage(options: RequestOptions = {}): Promise<SubAccountUsageResponse> {
    return this.#operations.execute<SubAccountUsageResponse>(
      "getSubAccountsUsage",
      { path: { account_id: this.#accountId } },
      forwardOptions(options),
    );
  }

  get(subAccountId: UUID, options: RequestOptions = {}): Promise<SubAccount> {
    return this.#operations.execute<SubAccount>(
      "getSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId } },
      forwardOptions(options),
    );
  }

  update(
    subAccountId: UUID,
    body: UpdateSubAccountRequest,
    options: RequestOptions = {},
  ): Promise<SubAccount> {
    return this.#operations.execute<SubAccount>(
      "updateSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId }, body },
      forwardOptions(options),
    );
  }

  delete(subAccountId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "deleteSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId } },
      forwardOptions(options),
    );
  }

  suspend(
    subAccountId: UUID,
    body: SuspendSubAccountRequest,
    options: RequestOptions = {},
  ): Promise<SubAccount> {
    return this.#operations.execute<SubAccount>(
      "suspendSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId }, body },
      forwardOptions(options),
    );
  }

  unsuspend(subAccountId: UUID, options: RequestOptions = {}): Promise<SubAccount> {
    return this.#operations.execute<SubAccount>(
      "unsuspendSubAccount",
      { path: { account_id: this.#accountId, sub_account_id: subAccountId } },
      forwardOptions(options),
    );
  }

  get apiKeys(): Readonly<SubAccountAPIKeysClient> {
    return this.#apiKeys;
  }
}
