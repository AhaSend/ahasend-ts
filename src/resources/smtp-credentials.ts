import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  ISODateTime,
  NonEmptyArray,
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
  /** Always present. Global credentials return an empty array. */
  domains: string[];
}

export interface CreatedSMTPCredential extends SMTPCredential {
  password: string;
}

/**
 * Discriminated union mirroring the spec: `scope: "scoped"` requires a
 * non-empty `domains` array. Global credentials may omit `domains` or send
 * any array or `null`; the API accepts and ignores supplied values.
 */
export type CreateSMTPCredentialRequest =
  | {
      name: string;
      sandbox?: boolean;
      scope: "global";
      domains?: readonly string[] | null;
    }
  | {
      name: string;
      sandbox?: boolean;
      scope: "scoped";
      domains: NonEmptyArray<string>;
    };

/**
 * Manage SMTP credentials for apps that send via SMTP relay instead of
 * the HTTP API. The created credential's `password` is returned once.
 */
export class SMTPCredentialsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /**
   * Fetch one page of SMTP credentials. The global read role sees all
   * credentials; domain-scoped read roles see credentials associated with at
   * least one authorized domain.
   */
  list(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<SMTPCredential>> {
    return this.#operations.execute<PaginatedResponse<SMTPCredential>>(
      "getSMTPCredentials",
      {
        path: { account_id: this.#accountId },
        query: params as Readonly<Record<string, unknown>>,
      },
      forwardOptions(options),
    );
  }

  iterate(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<SMTPCredential, void, undefined> {
    return paginate<SMTPCredential, PaginationParams>((p) => this.list(p, options), params);
  }

  /**
   * Create an SMTP credential. Scoped credentials require at least one domain
   * and write permission for every supplied domain. Global credentials require
   * `smtp-credentials:write:all`; supplied domains are accepted but ignored.
   *
   * The response is the only time the SMTP `password` is exposed. SMTP
   * credentials have no update operation.
   */
  create(
    body: CreateSMTPCredentialRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreatedSMTPCredential> {
    return this.#operations.execute<CreatedSMTPCredential>(
      "createSMTPCredential",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  /**
   * Fetch an SMTP credential. Requires the global read role or a read role
   * matching at least one associated domain.
   */
  get(credentialId: UUID, options: RequestOptions = {}): Promise<SMTPCredential> {
    return this.#operations.execute<SMTPCredential>(
      "getSMTPCredential",
      {
        path: {
          account_id: this.#accountId,
          smtp_credential_id: credentialId,
        },
      },
      forwardOptions(options),
    );
  }

  /**
   * Delete an SMTP credential. Requires the global delete role or a delete
   * role matching at least one associated domain.
   */
  delete(credentialId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "deleteSMTPCredential",
      {
        path: {
          account_id: this.#accountId,
          smtp_credential_id: credentialId,
        },
      },
      forwardOptions(options),
    );
  }
}
