import type { ClientOptions } from "./config.js";
import { optionsFromEnv, resolveConfig } from "./config.js";
import { HttpClient } from "./http.js";
import { AccountsClient } from "./resources/accounts.js";
import { APIKeysClient } from "./resources/api-keys.js";
import { DomainsClient } from "./resources/domains.js";
import { MessagesClient } from "./resources/messages.js";
import { RoutesClient } from "./resources/routes.js";
import { SMTPCredentialsClient } from "./resources/smtp-credentials.js";
import { StatisticsClient } from "./resources/statistics.js";
import { SuppressionsClient } from "./resources/suppressions.js";
import { WebhooksClient } from "./resources/webhooks.js";
import { forwardOptions } from "./resources/_helpers.js";
import type { RequestOptions, UUID } from "./types/common.js";

export interface AhaSendClientOptions extends ClientOptions {
  accountId: UUID;
}

export interface PingResponse {
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
 * Retries (with backoff + `Retry-After`), three-bucket rate limiting,
 * and automatic idempotency keys on create operations are built in and
 * configurable via {@link AhaSendClientOptions}.
 */
export class AhaSendClient {
  public readonly accountId: UUID;
  public readonly messages: MessagesClient;
  public readonly domains: DomainsClient;
  public readonly apiKeys: APIKeysClient;
  public readonly webhooks: WebhooksClient;
  public readonly statistics: StatisticsClient;
  public readonly suppressions: SuppressionsClient;
  public readonly routes: RoutesClient;
  public readonly accounts: AccountsClient;
  public readonly smtpCredentials: SMTPCredentialsClient;

  private readonly http: HttpClient;

  constructor(options: AhaSendClientOptions) {
    if (!options.accountId) {
      throw new Error("AhaSend: `accountId` is required.");
    }

    const config = resolveConfig(options);
    this.http = new HttpClient(config);
    this.accountId = options.accountId;

    this.messages = new MessagesClient(this.http, options.accountId);
    this.domains = new DomainsClient(this.http, options.accountId);
    this.apiKeys = new APIKeysClient(this.http, options.accountId);
    this.webhooks = new WebhooksClient(this.http, options.accountId);
    this.statistics = new StatisticsClient(this.http, options.accountId);
    this.suppressions = new SuppressionsClient(this.http, options.accountId);
    this.routes = new RoutesClient(this.http, options.accountId);
    this.accounts = new AccountsClient(this.http, options.accountId);
    this.smtpCredentials = new SMTPCredentialsClient(this.http, options.accountId);
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
      throw new Error("AhaSend: AHASEND_ACCOUNT_ID environment variable is required.");
    }
    return new AhaSendClient({ ...base, accountId });
  }

  /** Health check (`GET /v2/ping`) — verifies connectivity and the API key. */
  ping(options: RequestOptions = {}): Promise<PingResponse> {
    return this.http.request<PingResponse>({
      method: "GET",
      path: "/v2/ping",
      ...forwardOptions(options),
    });
  }
}
