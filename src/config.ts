import { DEFAULT_USER_AGENT } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.ahasend.com";
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  debug?: boolean;
  fetch?: typeof fetch;
  defaultHeaders?: Record<string, string>;
}

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  userAgent: string;
  debug: boolean;
  fetch: typeof fetch;
  defaultHeaders: Record<string, string>;
}

export function resolveConfig(options: ClientOptions): ResolvedConfig {
  if (!options.apiKey || typeof options.apiKey !== "string") {
    throw new Error("AhaSend: `apiKey` is required.");
  }

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "AhaSend: `fetch` is not available. Use Node.js 18+ or inject a `fetch` implementation via `options.fetch`.",
    );
  }

  return {
    apiKey: options.apiKey,
    baseUrl,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    debug: options.debug ?? false,
    fetch: fetchImpl,
    defaultHeaders: options.defaultHeaders ?? {},
  };
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): ClientOptions {
  const apiKey = env.AHASEND_API_KEY ?? env.AHASEND_TOKEN;
  if (!apiKey) {
    throw new Error(
      "AhaSend: missing API key. Set AHASEND_API_KEY (or AHASEND_TOKEN) environment variable.",
    );
  }

  const options: ClientOptions = { apiKey };

  const baseUrl = env.AHASEND_BASE_URL ?? buildBaseUrl(env.AHASEND_SCHEME, env.AHASEND_HOST);
  if (baseUrl) options.baseUrl = baseUrl;

  if (env.AHASEND_USER_AGENT) options.userAgent = env.AHASEND_USER_AGENT;

  if (env.AHASEND_TIMEOUT) {
    const seconds = Number(env.AHASEND_TIMEOUT);
    if (Number.isFinite(seconds) && seconds > 0) options.timeout = seconds * 1000;
  }

  if (env.AHASEND_DEBUG !== undefined) options.debug = parseBool(env.AHASEND_DEBUG);

  return options;
}

function buildBaseUrl(scheme: string | undefined, host: string | undefined): string | undefined {
  if (!host) return undefined;
  return `${scheme ?? "https"}://${host}`;
}

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on" || v === "enable";
}
