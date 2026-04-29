import type { ClientOptions } from "./config.js";
import { optionsFromEnv, resolveConfig } from "./config.js";
import { HttpClient } from "./http.js";
import { APIKeysClient } from "./resources/api-keys.js";
import { DomainsClient } from "./resources/domains.js";
import { MessagesClient } from "./resources/messages.js";
import type { RequestOptions, UUID } from "./types/common.js";

export interface AhaSendClientOptions extends ClientOptions {
  accountId: UUID;
}

export interface PingResponse {
  message: string;
}

export class AhaSendClient {
  public readonly accountId: UUID;
  public readonly messages: MessagesClient;
  public readonly domains: DomainsClient;
  public readonly apiKeys: APIKeysClient;

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
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AhaSendClient {
    const base = optionsFromEnv(env);
    const accountId = env.AHASEND_ACCOUNT_ID;
    if (!accountId) {
      throw new Error("AhaSend: AHASEND_ACCOUNT_ID environment variable is required.");
    }
    return new AhaSendClient({ ...base, accountId });
  }

  ping(options: RequestOptions = {}): Promise<PingResponse> {
    const init: { signal?: AbortSignal; headers?: Record<string, string> } = {};
    if (options.signal) init.signal = options.signal;
    if (options.headers) init.headers = options.headers;
    return this.http.request<PingResponse>({
      method: "GET",
      path: "/v2/ping",
      ...init,
    });
  }
}
