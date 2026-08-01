import type { ClientOptions } from "./config.js";
import { assertPlainRecord, optionsFromEnv, resolveConfig } from "./config.js";
import { AhaSendConfigurationError } from "./errors.js";
import { HttpClient } from "./http.js";
import { OperationExecutor } from "./operations.js";
import { createAccountsClient } from "./resources/accounts.js";
import type { AccountsClient } from "./resources/accounts.js";
import { createAPIKeysClient } from "./resources/api-keys.js";
import type { APIKeysClient } from "./resources/api-keys.js";
import { createDomainsClient } from "./resources/domains.js";
import type { DomainsClient } from "./resources/domains.js";
import { createMessagesClient } from "./resources/messages.js";
import type { MessagesClient } from "./resources/messages.js";
import { createRoutesClient } from "./resources/routes.js";
import type { RoutesClient } from "./resources/routes.js";
import { createSMTPCredentialsClient } from "./resources/smtp-credentials.js";
import type { SMTPCredentialsClient } from "./resources/smtp-credentials.js";
import { createStatisticsClient } from "./resources/statistics.js";
import type { StatisticsClient } from "./resources/statistics.js";
import { createSubAccountsClient } from "./resources/sub-accounts.js";
import type { SubAccountsClient } from "./resources/sub-accounts.js";
import { createSuppressionsClient } from "./resources/suppressions.js";
import type { SuppressionsClient } from "./resources/suppressions.js";
import { createWebhooksClient } from "./resources/webhooks.js";
import type { WebhooksClient } from "./resources/webhooks.js";
import { createFrozenFacade, forwardOptions } from "./resources/_helpers.js";
import type { AhaSendPromise, RequestOptions, UUID } from "./types/common.js";

const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");
const REDACTED = "[REDACTED]" as const;

interface SerializedAhaSendClient {
  readonly name: "AhaSendClient";
  readonly accountId: UUID;
  readonly apiKey: typeof REDACTED;
}

/** Options for an {@link AhaSendClient}, including the account that its resources target. */
export interface AhaSendClientOptions extends ClientOptions {
  /** Account ID used by every account-scoped resource request. */
  accountId: UUID;
}

/** Response returned by {@link AhaSendClient.ping}. */
export interface PingResponse {
  /** API health-check message. */
  message: string;
}

/**
 * AhaSend API client, bound to a single account.
 *
 * ```ts
 * const client = new AhaSendClient({
 *   apiKey: process.env.AHASEND_API_KEY!,
 *   accountId: process.env.AHASEND_ACCOUNT_ID!,
 * });
 * await client.messages.send({ ... });
 * ```
 *
 * Server-side only — construction throws in browser-like environments
 * to keep the bearer key out of front-end bundles. One client maps to
 * one account; instantiate multiple clients for multi-account tooling.
 *
 * The client exposes readonly structural facades for messages, domains,
 * API keys, outbound webhooks, statistics, suppressions, routes, accounts,
 * SMTP credentials, and sub-accounts. Child-account API keys are available
 * through `client.subAccounts.apiKeys`.
 *
 * Retries (with backoff + `Retry-After`), opt-in two-bucket rate limiting,
 * and automatic idempotency keys on create operations are built in and
 * configurable via {@link AhaSendClientOptions}.
 */
export class AhaSendClient {
  readonly #accountId: UUID;
  readonly #http: HttpClient;
  readonly #operations: OperationExecutor;
  readonly #messages: Readonly<MessagesClient>;
  readonly #domains: Readonly<DomainsClient>;
  readonly #apiKeys: Readonly<APIKeysClient>;
  readonly #webhooks: Readonly<WebhooksClient>;
  readonly #statistics: Readonly<StatisticsClient>;
  readonly #suppressions: Readonly<SuppressionsClient>;
  readonly #routes: Readonly<RoutesClient>;
  readonly #accounts: Readonly<AccountsClient>;
  readonly #smtpCredentials: Readonly<SMTPCredentialsClient>;
  readonly #subAccounts: Readonly<SubAccountsClient>;

  /** Create a server-side client bound to `options.accountId`. */
  constructor(options: AhaSendClientOptions) {
    assertPlainRecord(options, "client options");
    if (typeof options.accountId !== "string" || options.accountId.trim().length === 0) {
      throw new AhaSendConfigurationError("AhaSend: `accountId` is required.");
    }

    const { accountId, ...clientOptions } = options;
    const config = resolveConfig(clientOptions);
    this.#http = new HttpClient(config);
    this.#operations = new OperationExecutor(this.#http);
    this.#accountId = accountId;

    this.#messages = createFrozenFacade(createMessagesClient(this.#operations, accountId));
    this.#domains = createFrozenFacade(createDomainsClient(this.#operations, accountId));
    this.#apiKeys = createFrozenFacade(createAPIKeysClient(this.#operations, accountId));
    this.#webhooks = createFrozenFacade(createWebhooksClient(this.#operations, accountId));
    this.#statistics = createFrozenFacade(createStatisticsClient(this.#operations, accountId));
    this.#suppressions = createFrozenFacade(createSuppressionsClient(this.#operations, accountId));
    this.#routes = createFrozenFacade(createRoutesClient(this.#operations, accountId));
    this.#accounts = createFrozenFacade(createAccountsClient(this.#operations, accountId));
    this.#smtpCredentials = createFrozenFacade(
      createSMTPCredentialsClient(this.#operations, accountId),
    );
    this.#subAccounts = createFrozenFacade(createSubAccountsClient(this.#operations, accountId));
  }

  /** Account ID used by every account-scoped resource facade. */
  get accountId(): UUID {
    return this.#accountId;
  }

  /** Send, inspect, list, and cancel transactional messages. */
  get messages(): Readonly<MessagesClient> {
    return this.#messages;
  }

  /** Create, verify, inspect, update, and delete sending domains. */
  get domains(): Readonly<DomainsClient> {
    return this.#domains;
  }

  /** Create, inspect, update, and delete API keys for the current account. */
  get apiKeys(): Readonly<APIKeysClient> {
    return this.#apiKeys;
  }

  /** Create, inspect, update, and delete outbound webhook endpoints. */
  get webhooks(): Readonly<WebhooksClient> {
    return this.#webhooks;
  }

  /** Query deliverability, bounce, and delivery-time statistics. */
  get statistics(): Readonly<StatisticsClient> {
    return this.#statistics;
  }

  /** Create, list, delete, and wipe address suppressions. */
  get suppressions(): Readonly<SuppressionsClient> {
    return this.#suppressions;
  }

  /** Create, inspect, update, and delete inbound email routes. */
  get routes(): Readonly<RoutesClient> {
    return this.#routes;
  }

  /** Inspect and update accounts and manage account members. */
  get accounts(): Readonly<AccountsClient> {
    return this.#accounts;
  }

  /** Create, inspect, list, and delete SMTP credentials. */
  get smtpCredentials(): Readonly<SMTPCredentialsClient> {
    return this.#smtpCredentials;
  }

  /** Manage child accounts, their usage, and their nested API keys. */
  get subAccounts(): Readonly<SubAccountsClient> {
    return this.#subAccounts;
  }

  /**
   * Construct a client from `AHASEND_*` environment variables.
   * Requires `AHASEND_API_KEY` (or `AHASEND_TOKEN`) and
   * `AHASEND_ACCOUNT_ID`; honours every other documented variable
   * (base URL, timeout, retries, rate limit, idempotency, debug).
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AhaSendClient {
    const base = optionsFromEnv(env);
    const accountId = env.AHASEND_ACCOUNT_ID;
    if (!accountId) {
      throw new AhaSendConfigurationError(
        "AhaSend: AHASEND_ACCOUNT_ID environment variable is required.",
      );
    }
    return new AhaSendClient({ ...base, accountId });
  }

  /** Return a safe diagnostic representation without transport or resource state. */
  toJSON(): SerializedAhaSendClient {
    return Object.freeze({
      name: "AhaSendClient",
      accountId: this.#accountId,
      apiKey: REDACTED,
    });
  }

  [INSPECT_CUSTOM](): SerializedAhaSendClient {
    return this.toJSON();
  }

  /** Health check (`GET /v2/ping`) — verifies connectivity and the API key. */
  ping(options: RequestOptions = {}): AhaSendPromise<PingResponse> {
    return this.#operations.execute("ping", {}, forwardOptions(options));
  }
}
