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
import { forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { IdempotencyRequestOptions } from "./_helpers.js";

export type SMTPCredentialScope = "global" | "scoped";

export interface SMTPCredential {
  object: "credential_smtp";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  username: string;
  sandbox: boolean;
  scope: SMTPCredentialScope;
  domains?: string[];
}

export interface CreatedSMTPCredential extends SMTPCredential {
  password: string;
}

/**
 * Discriminated union: when `scope: "scoped"`, `domains` is required and
 * lists the domains the credential may send from. When `scope: "global"`,
 * `domains` must not be present.
 */
export type CreateSMTPCredentialRequest =
  | {
      name: string;
      sandbox?: boolean;
      scope: "global";
      domains?: never;
    }
  | {
      name: string;
      sandbox?: boolean;
      scope: "scoped";
      domains: string[];
    };

export class SMTPCredentialsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  list(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<SMTPCredential>> {
    return this.http.request<PaginatedResponse<SMTPCredential>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/smtp-credentials`,
      query: params as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  iterate(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<SMTPCredential, void, undefined> {
    return paginate<SMTPCredential, PaginationParams>(
      (p) => this.list(p, options),
      params,
    );
  }

  create(
    body: CreateSMTPCredentialRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreatedSMTPCredential> {
    return this.http.request<CreatedSMTPCredential>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/smtp-credentials`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  get(credentialId: UUID, options: RequestOptions = {}): Promise<SMTPCredential> {
    return this.http.request<SMTPCredential>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/smtp-credentials/${encodeURIComponent(credentialId)}`,
      ...forwardOptions(options),
    });
  }

  delete(credentialId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/smtp-credentials/${encodeURIComponent(credentialId)}`,
      ...forwardOptions(options),
    });
  }
}
