import type { HttpClient } from "../http.js";
import type { ISODateTime, RequestOptions, SuccessResponse, UUID } from "../types/common.js";
import { forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { IdempotencyRequestOptions } from "./_helpers.js";

export type AccountMemberRole = "Administrator" | "Developer" | "Analyst" | "Billing Manager";

export interface Account {
  object: "account";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  website?: string | null;
  about?: string | null;
  track_opens?: boolean;
  track_clicks?: boolean;
  reject_bad_recipients?: boolean;
  reject_mistyped_recipients?: boolean;
  message_metadata_retention?: number;
  message_data_retention?: number;
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

export interface ListMembersParams {
  // The AhaSend API does not accept query parameters on GET /members.
  // Reserved for forward compatibility.
}

/** Account settings and member management. */
export class AccountsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  get(options: RequestOptions = {}): Promise<Account> {
    return this.http.request<Account>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}`,
      ...forwardOptions(options),
    });
  }

  update(body: UpdateAccountRequest, options: RequestOptions = {}): Promise<Account> {
    return this.http.request<Account>({
      method: "PUT",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}`,
      body,
      ...forwardOptions(options),
    });
  }

  listMembers(options: RequestOptions = {}): Promise<ListAccountMembersResponse> {
    return this.http.request<ListAccountMembersResponse>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/members`,
      ...forwardOptions(options),
    });
  }

  addMember(
    body: AddAccountMemberRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<UserAccount> {
    return this.http.request<UserAccount>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/members`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  removeMember(userId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/members/${encodeURIComponent(userId)}`,
      ...forwardOptions(options),
    });
  }
}
