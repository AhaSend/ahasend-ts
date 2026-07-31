import type { OperationExecutor } from "../operations.js";
import type { ISODateTime, RequestOptions, SuccessResponse, UUID } from "../types/common.js";
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
  name?: string;
  website?: string;
  about?: string;
  track_opens?: boolean;
  track_clicks?: boolean;
  reject_bad_recipients?: boolean;
  reject_mistyped_recipients?: boolean;
  message_metadata_retention?: number;
  message_data_retention?: number;
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
  name?: string;
  role: AccountMemberRole;
}

/** Account settings and member management. */
export class AccountsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  get(options: RequestOptions = {}): Promise<Account> {
    return this.#operations.execute<Account>(
      "getAccount",
      { path: { account_id: this.#accountId } },
      forwardOptions(options),
    );
  }

  update(body: UpdateAccountRequest, options: RequestOptions = {}): Promise<Account> {
    return this.#operations.execute<Account>(
      "updateAccount",
      { path: { account_id: this.#accountId }, body },
      forwardOptions(options),
    );
  }

  listMembers(options: RequestOptions = {}): Promise<ListAccountMembersResponse> {
    return this.#operations.execute<ListAccountMembersResponse>(
      "getAccountMembers",
      { path: { account_id: this.#accountId } },
      forwardOptions(options),
    );
  }

  addMember(
    body: AddAccountMemberRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<UserAccount> {
    return this.#operations.execute<UserAccount>(
      "addAccountMember",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  removeMember(userId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "removeAccountMember",
      { path: { account_id: this.#accountId, user_id: userId } },
      forwardOptions(options),
    );
  }
}
