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
import { assertNonEmptyArray, forwardOptions, forwardWithIdempotency } from "./_helpers.js";
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
      sandbox?: boolean | undefined;
      scope: "global";
      domains?: readonly string[] | null | undefined;
    }
  | {
      name: string;
      sandbox?: boolean | undefined;
      scope: "scoped";
      domains: readonly string[];
    };

/**
 * Manage SMTP credentials for apps that send via SMTP relay instead of
 * the HTTP API. The created credential's `password` is returned once.
 */
export interface SMTPCredentialsClient {
  /**
   * Fetch one page of SMTP credentials.
   *
   * `smtp-credentials:read:all` returns every SMTP credential;
   * `smtp-credentials:read:{domain}` returns only credentials with at least one
   * authorized `domains` entry.
   */
  list(
    params?: PaginationParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<SMTPCredential>>;

  /** Iterate through every visible SMTP credential, fetching cursor pages lazily. */
  iterate(
    params?: PaginationParams,
    options?: RequestOptions,
  ): AsyncGenerator<SMTPCredential, void, undefined>;

  /**
   * Create an SMTP credential.
   *
   * A `scoped` SMTP credential requires `smtp-credentials:write:{domain}` for
   * every `domains` entry; `scope: "global"` requires
   * `smtp-credentials:write:all`.
   *
   * The response is the only time the SMTP `password` is exposed. SMTP
   * credentials have no update operation.
   */
  create(
    body: CreateSMTPCredentialRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CreatedSMTPCredential>;

  /**
   * Fetch an SMTP credential by ID.
   *
   * Authorization requires `smtp-credentials:read:all` or
   * `smtp-credentials:read:{domain}` matching at least one credential `domains`
   * entry.
   */
  get(credentialId: UUID, options?: RequestOptions): AhaSendPromise<SMTPCredential>;

  /**
   * Delete an SMTP credential by ID.
   *
   * Authorization requires `smtp-credentials:delete:all` or
   * `smtp-credentials:delete:{domain}` matching at least one credential
   * `domains` entry.
   */
  delete(credentialId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;
}

class SMTPCredentialsClientImplementation implements SMTPCredentialsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /**
   * Fetch one page of SMTP credentials.
   *
   * `smtp-credentials:read:all` returns every SMTP credential;
   * `smtp-credentials:read:{domain}` returns only credentials with at least one
   * authorized `domains` entry.
   */
  list(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<SMTPCredential>> {
    return this.#operations.execute(
      "getSMTPCredentials",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /** Iterate through every visible SMTP credential, fetching cursor pages lazily. */
  iterate(
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<SMTPCredential, void, undefined> {
    return paginate<SMTPCredential, PaginationParams>((p) => this.list(p, options), params);
  }

  /**
   * Create an SMTP credential.
   *
   * A `scoped` SMTP credential requires `smtp-credentials:write:{domain}` for
   * every `domains` entry; `scope: "global"` requires
   * `smtp-credentials:write:all`.
   *
   * The response is the only time the SMTP `password` is exposed. SMTP
   * credentials have no update operation.
   */
  create(
    body: CreateSMTPCredentialRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CreatedSMTPCredential> {
    const forwarded = forwardWithIdempotency(options);
    if (body?.scope === "scoped") assertNonEmptyArray(body.domains, "domains");
    return this.#operations.execute(
      "createSMTPCredential",
      { path: { account_id: this.#accountId }, body },
      forwarded,
    );
  }

  /**
   * Fetch an SMTP credential by ID.
   *
   * Authorization requires `smtp-credentials:read:all` or
   * `smtp-credentials:read:{domain}` matching at least one credential `domains`
   * entry.
   */
  get(credentialId: UUID, options: RequestOptions = {}): AhaSendPromise<SMTPCredential> {
    return this.#operations.execute(
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
   * Delete an SMTP credential by ID.
   *
   * Authorization requires `smtp-credentials:delete:all` or
   * `smtp-credentials:delete:{domain}` matching at least one credential
   * `domains` entry.
   */
  delete(credentialId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
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

/** @internal Construct the SMTP credential resource implementation for the root client. */
export function createSMTPCredentialsClient(
  operations: OperationExecutor,
  accountId: UUID,
): SMTPCredentialsClient {
  return new SMTPCredentialsClientImplementation(operations, accountId);
}
