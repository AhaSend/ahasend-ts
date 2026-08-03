import type { OperationExecutor } from "../operations.js";
import type {
  AhaSendPromise,
  ISODateTime,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import { forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { IdempotencyRequestOptions } from "./_helpers.js";

export type AccountMemberRole = "Administrator" | "Developer" | "Analyst" | "Billing Manager";

export interface Account {
  object: "account";
  id: UUID;
  parent_account_id: UUID | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  website: string;
  about: string;
  track_opens: boolean;
  track_clicks: boolean;
  reject_bad_recipients: boolean;
  reject_mistyped_recipients: boolean;
  message_metadata_retention: number;
  message_data_retention: number;
  owner_id: UUID;
}

export interface UpdateAccountRequest {
  name?: string | undefined;
  website?: string | undefined;
  about?: string | undefined;
  track_opens?: boolean | undefined;
  track_clicks?: boolean | undefined;
  reject_bad_recipients?: boolean | undefined;
  reject_mistyped_recipients?: boolean | undefined;
  message_metadata_retention?: number | undefined;
  message_data_retention?: number | undefined;
}

export interface UserAccount {
  created_at: ISODateTime;
  updated_at: ISODateTime;
  user_id: UUID;
  account_id: UUID;
  role: AccountMemberRole;
}

export interface ListAccountMembersResponse {
  object: "list";
  data: UserAccount[];
}

export interface AddAccountMemberRequest {
  email: string;
  name?: string | undefined;
  role: AccountMemberRole;
}

/** Account settings and member management. */
export interface AccountsClient {
  /** Retrieve the account's current settings. */
  get(options?: RequestOptions): AhaSendPromise<Account>;

  /** Update the supplied account settings, leaving omitted settings unchanged. */
  update(body: UpdateAccountRequest, options?: RequestOptions): AhaSendPromise<Account>;

  /** List every user who belongs to the account and each user's account role. */
  listMembers(options?: RequestOptions): AhaSendPromise<ListAccountMembersResponse>;

  /** Add a user to the account by email address and assign their account role. */
  addMember(
    body: AddAccountMemberRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<UserAccount>;

  /** Remove a user from the account by user ID. */
  removeMember(userId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;
}

class AccountsClientImplementation implements AccountsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  get(options: RequestOptions = {}): AhaSendPromise<Account> {
    return this.#operations.execute(
      "getAccount",
      { path: { account_id: this.#accountId } },
      forwardOptions(options),
    );
  }

  update(body: UpdateAccountRequest, options: RequestOptions = {}): AhaSendPromise<Account> {
    return this.#operations.execute(
      "updateAccount",
      { path: { account_id: this.#accountId }, body },
      forwardOptions(options),
    );
  }

  listMembers(options: RequestOptions = {}): AhaSendPromise<ListAccountMembersResponse> {
    return this.#operations.execute(
      "getAccountMembers",
      { path: { account_id: this.#accountId } },
      forwardOptions(options),
    );
  }

  addMember(
    body: AddAccountMemberRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<UserAccount> {
    return this.#operations.execute(
      "addAccountMember",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  removeMember(userId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "removeAccountMember",
      { path: { account_id: this.#accountId, user_id: userId } },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the account resource implementation for the root client. */
export function createAccountsClient(
  operations: OperationExecutor,
  accountId: UUID,
): AccountsClient {
  return new AccountsClientImplementation(operations, accountId);
}
