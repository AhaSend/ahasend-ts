import type { IdempotencyConfig, ResolvedIdempotencyConfig } from "./idempotency.js";
import { resolveIdempotencyConfig } from "./idempotency.js";
import type { RateLimitConfig, ResolvedRateLimitConfig } from "./rate-limit.js";
import { resolveRateLimitConfig } from "./rate-limit.js";
import type { ResolvedRetryConfig, RetryConfig } from "./retry.js";
import { resolveRetryConfig } from "./retry.js";
import type { ResolvedTelemetryHooks, TelemetryHooks } from "./telemetry.js";
import { composeHooks, debugConsoleHooks, resolveTelemetryHooks } from "./telemetry.js";
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
  idempotency?: IdempotencyConfig;
  retry?: RetryConfig;
  rateLimit?: RateLimitConfig;
  hooks?: TelemetryHooks;
  /**
   * Allow non-HTTPS `baseUrl` values (other than localhost / 127.0.0.1).
   * Defaults to `false`. Setting to `true` lets the SDK send the bearer
   * token in plaintext, which is dangerous; only enable for testing
   * environments where you control the network.
   */
  dangerouslyAllowInsecureBaseUrl?: boolean;
  /**
   * This SDK is server-side only — embedding the bearer API key in a
   * browser bundle exposes it to anyone visiting your site. The
   * constructor throws if it detects a browser-like global (`window`).
   * Set this to `true` only when you have a non-browser reason for the
   * `window` global to exist (e.g. JSDOM in unit tests).
   */
  dangerouslyAllowBrowser?: boolean;
}

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  userAgent: string;
  debug: boolean;
  fetch: typeof fetch;
  defaultHeaders: Record<string, string>;
  idempotency: ResolvedIdempotencyConfig;
  retry: ResolvedRetryConfig;
  rateLimit: ResolvedRateLimitConfig;
  hooks: ResolvedTelemetryHooks;
}

export function resolveConfig(options: ClientOptions): ResolvedConfig {
  if (!options.apiKey || typeof options.apiKey !== "string") {
    throw new Error("AhaSend: `apiKey` is required.");
  }

  assertNotBrowser(options.dangerouslyAllowBrowser ?? false);

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  assertSecureBaseUrl(baseUrl, options.dangerouslyAllowInsecureBaseUrl ?? false);

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
    idempotency: resolveIdempotencyConfig(options.idempotency),
    retry: resolveRetryConfig(options.retry),
    rateLimit: resolveRateLimitConfig(options.rateLimit),
    hooks: resolveTelemetryHooks(
      options.debug
        ? composeHooks(debugConsoleHooks(), options.hooks)
        : options.hooks,
    ),
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

  const idempotency: IdempotencyConfig = {};
  if (env.AHASEND_IDEMPOTENCY_AUTO_GENERATE !== undefined) {
    idempotency.autoGenerate = parseBool(env.AHASEND_IDEMPOTENCY_AUTO_GENERATE);
  }
  if (env.AHASEND_IDEMPOTENCY_PREFIX) {
    idempotency.prefix = env.AHASEND_IDEMPOTENCY_PREFIX;
  }
  if (Object.keys(idempotency).length > 0) options.idempotency = idempotency;

  const retry: RetryConfig = {};
  if (env.AHASEND_MAX_RETRIES !== undefined) {
    const n = Number(env.AHASEND_MAX_RETRIES);
    if (Number.isFinite(n) && n >= 0) retry.maxRetries = n;
  }
  if (Object.keys(retry).length > 0) options.retry = retry;

  if (env.AHASEND_ENABLE_RATE_LIMIT !== undefined) {
    options.rateLimit = { enabled: parseBool(env.AHASEND_ENABLE_RATE_LIMIT) };
  }

  return options;
}

function buildBaseUrl(scheme: string | undefined, host: string | undefined): string | undefined {
  if (!host) return undefined;
  return `${scheme ?? "https"}://${host}`;
}

function assertNotBrowser(allow: boolean): void {
  if (allow) return;
  // Regular browsers expose `window`/`document`; Service Workers expose
  // `ServiceWorkerGlobalScope` (and `clients`) but not `window`. All of
  // these are credential-exposure risks. Cloudflare Workers and Vercel
  // Edge expose `self` but not the others — and they are explicitly
  // out-of-scope for this SDK, so they would also fall through here.
  const g = globalThis as {
    window?: unknown;
    document?: unknown;
    ServiceWorkerGlobalScope?: unknown;
    clients?: unknown;
  };
  const isBrowser =
    typeof g.window !== "undefined" || typeof g.document !== "undefined";
  const isServiceWorker = typeof g.ServiceWorkerGlobalScope !== "undefined";
  if (isBrowser || isServiceWorker) {
    throw new Error(
      "AhaSend: refusing to construct an AhaSendClient in a browser-like " +
        "environment (window/document/ServiceWorker) — embedding the bearer " +
        "API key in a browser bundle exposes it. Use this SDK from a Node.js " +
        "(or other server) runtime, or pass { dangerouslyAllowBrowser: true } " +
        "if you really know what you are doing.",
    );
  }
}

function assertSecureBaseUrl(baseUrl: string, allowInsecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`AhaSend: invalid baseUrl "${baseUrl}" — expected a full URL.`);
  }
  if (parsed.protocol === "https:") return;
  // `URL` strips the square brackets from the bracketed IPv6 form, so
  // `http://[::1]:port` parses with `hostname === "::1"`. Localhost
  // (`127.0.0.1` IPv4 + `::1` IPv6) is carved out for Prism/local-dev.
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
  if (allowInsecure) return;
  throw new Error(
    `AhaSend: refusing to send the bearer API key over an insecure baseUrl ("${baseUrl}"). ` +
      `Use https:// or set { dangerouslyAllowInsecureBaseUrl: true } to override.`,
  );
}

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on" || v === "enable";
}
