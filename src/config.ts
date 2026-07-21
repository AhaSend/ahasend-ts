import type { IdempotencyConfig, ResolvedIdempotencyConfig } from "./idempotency.js";
import { assertValidIdempotencyKey, resolveIdempotencyConfig } from "./idempotency.js";
import type { RateLimitConfig, ResolvedRateLimitConfig } from "./rate-limit.js";
import { resolveRateLimitConfig } from "./rate-limit.js";
import type { ResolvedRetryConfig, RetryConfig } from "./retry.js";
import { resolveRetryConfig } from "./retry.js";
import type { ResolvedTelemetryHooks, TelemetryHooks } from "./telemetry.js";
import { composeHooks, debugConsoleHooks, resolveTelemetryHooks } from "./telemetry.js";
import type { IdempotencyRequestOptions, RequestOptions } from "./types/common.js";
import { DEFAULT_USER_AGENT } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.ahasend.com";
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
  debug?: boolean;
  fetch?: typeof fetch;
  defaultHeaders?: Record<string, string>;
  idempotency?: IdempotencyConfig;
  retry?: RetryConfig;
  rateLimit?: RateLimitConfig;
  hooks?: TelemetryHooks;
  /**
   * Allow an HTTP `baseUrl` (other than localhost / loopback).
   * Defaults to `false`. Setting this to `true` lets the SDK send the
   * bearer token in plaintext, which is dangerous; only enable it for
   * development environments where you control the network.
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
  timeoutMs: number;
  userAgent: string;
  debug: boolean;
  fetch: typeof fetch;
  defaultHeaders: Record<string, string>;
  idempotency: ResolvedIdempotencyConfig;
  retry: ResolvedRetryConfig;
  rateLimit: ResolvedRateLimitConfig;
  hooks: ResolvedTelemetryHooks;
}

const CLIENT_OPTION_NAMES = new Set([
  "apiKey",
  "baseUrl",
  "timeoutMs",
  "userAgent",
  "debug",
  "fetch",
  "defaultHeaders",
  "idempotency",
  "retry",
  "rateLimit",
  "hooks",
  "dangerouslyAllowInsecureBaseUrl",
  "dangerouslyAllowBrowser",
]);

const REQUEST_OPTION_NAMES = new Set(["signal", "headers"]);
const IDEMPOTENCY_REQUEST_OPTION_NAMES = new Set([...REQUEST_OPTION_NAMES, "idempotencyKey"]);
const RETRY_STRATEGIES = new Set(["exponential", "linear", "constant"]);
const HOOK_NAMES = new Set(["onRequest", "onResponse", "onRetry", "onError"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INVALID_HEADER_VALUE_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f]|[^\u0000-\u00ff]/;

export function resolveConfig(options: ClientOptions): ResolvedConfig {
  assertPlainRecord(options, "options");
  assertKnownKeys(options, CLIENT_OPTION_NAMES, "options");

  assertNonEmptyString(options.apiKey, "apiKey");
  assertHeaderValue(options.apiKey, "apiKey");
  assertOptionalBoolean(options.debug, "debug");
  assertOptionalBoolean(options.dangerouslyAllowBrowser, "dangerouslyAllowBrowser");
  assertOptionalBoolean(options.dangerouslyAllowInsecureBaseUrl, "dangerouslyAllowInsecureBaseUrl");
  assertNotBrowser(options.dangerouslyAllowBrowser ?? false);

  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? DEFAULT_BASE_URL,
    options.dangerouslyAllowInsecureBaseUrl ?? false,
  );

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertPositiveFiniteNumber(timeoutMs, "timeoutMs");

  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  assertNonEmptyString(userAgent, "userAgent");
  assertHeaderValue(userAgent, "userAgent");

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "AhaSend: `fetch` is not available. Use Node.js 18+ or inject a `fetch` implementation via `options.fetch`.",
    );
  }

  assertHeaders(options.defaultHeaders, "defaultHeaders");
  assertRetryConfig(options.retry);
  assertRateLimitConfig(options.rateLimit);
  assertTelemetryHooks(options.hooks);

  return {
    apiKey: options.apiKey,
    baseUrl,
    timeoutMs,
    userAgent,
    debug: options.debug ?? false,
    fetch: fetchImpl,
    defaultHeaders: { ...(options.defaultHeaders ?? {}) },
    idempotency: resolveIdempotencyConfig(options.idempotency),
    retry: resolveRetryConfig(options.retry),
    rateLimit: resolveRateLimitConfig(options.rateLimit),
    hooks: resolveTelemetryHooks(
      options.debug ? composeHooks(debugConsoleHooks(), options.hooks) : options.hooks,
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
  assertNonEmptyString(apiKey, "AHASEND_API_KEY/AHASEND_TOKEN");
  assertHeaderValue(apiKey, "AHASEND_API_KEY/AHASEND_TOKEN");

  const options: ClientOptions = { apiKey };

  const baseUrl = env.AHASEND_BASE_URL ?? buildBaseUrl(env.AHASEND_SCHEME, env.AHASEND_HOST);
  if (baseUrl !== undefined) options.baseUrl = normalizeBaseUrl(baseUrl, false);

  if (env.AHASEND_USER_AGENT !== undefined) {
    assertNonEmptyString(env.AHASEND_USER_AGENT, "AHASEND_USER_AGENT");
    assertHeaderValue(env.AHASEND_USER_AGENT, "AHASEND_USER_AGENT");
    options.userAgent = env.AHASEND_USER_AGENT;
  }

  if (env.AHASEND_TIMEOUT !== undefined) {
    const seconds = parseFiniteNumber(env.AHASEND_TIMEOUT, "AHASEND_TIMEOUT");
    if (seconds <= 0) {
      throw new Error("AhaSend: `AHASEND_TIMEOUT` must be a positive number of seconds.");
    }
    const timeoutMs = seconds * 1000;
    assertPositiveFiniteNumber(timeoutMs, "AHASEND_TIMEOUT");
    options.timeoutMs = timeoutMs;
  }

  if (env.AHASEND_DEBUG !== undefined) {
    options.debug = parseBool(env.AHASEND_DEBUG, "AHASEND_DEBUG");
  }

  const idempotency: IdempotencyConfig = {};
  if (env.AHASEND_IDEMPOTENCY_AUTO_GENERATE !== undefined) {
    idempotency.autoGenerate = parseBool(
      env.AHASEND_IDEMPOTENCY_AUTO_GENERATE,
      "AHASEND_IDEMPOTENCY_AUTO_GENERATE",
    );
  }
  if (env.AHASEND_IDEMPOTENCY_PREFIX !== undefined) {
    idempotency.prefix = env.AHASEND_IDEMPOTENCY_PREFIX;
  }
  if (Object.keys(idempotency).length > 0) {
    resolveIdempotencyConfig(idempotency);
    options.idempotency = idempotency;
  }

  const retry: RetryConfig = {};
  if (env.AHASEND_MAX_RETRIES !== undefined) {
    const maxRetries = parseFiniteNumber(env.AHASEND_MAX_RETRIES, "AHASEND_MAX_RETRIES");
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new Error("AhaSend: `AHASEND_MAX_RETRIES` must be a non-negative integer.");
    }
    retry.maxRetries = maxRetries;
  }
  if (Object.keys(retry).length > 0) {
    assertRetryConfig(retry);
    options.retry = retry;
  }

  if (env.AHASEND_ENABLE_RATE_LIMIT !== undefined) {
    options.rateLimit = {
      enabled: parseBool(env.AHASEND_ENABLE_RATE_LIMIT, "AHASEND_ENABLE_RATE_LIMIT"),
    };
  }

  return options;
}

/** @internal Validate the common public request-options shape before transport work starts. */
export function assertRequestOptions(
  options: unknown,
  allowIdempotencyKey = false,
): asserts options is RequestOptions | IdempotencyRequestOptions {
  assertPlainRecord(options, "request options");
  assertKnownKeys(
    options,
    allowIdempotencyKey ? IDEMPOTENCY_REQUEST_OPTION_NAMES : REQUEST_OPTION_NAMES,
    "request options",
  );

  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new Error("AhaSend: `request options.signal` must be an AbortSignal.");
  }
  assertHeaders(options.headers, "request options.headers");

  if (allowIdempotencyKey && options.idempotencyKey !== undefined) {
    assertValidIdempotencyKey(options.idempotencyKey, "request options.idempotencyKey");
  }
}

/** @internal Validate a header record without relying on transport-specific behavior. */
export function assertHeaders(
  headers: unknown,
  name: string,
): asserts headers is Record<string, string> {
  if (headers === undefined) return;
  assertPlainRecord(headers, name);
  for (const [headerName, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(headerName)) {
      throw new Error(`AhaSend: \`${name}\` contains an invalid header name "${headerName}".`);
    }
    if (typeof value !== "string") {
      throw new Error(`AhaSend: \`${name}.${headerName}\` must be a string.`);
    }
    assertHeaderValue(value, `${name}.${headerName}`);
    if (headerName.toLowerCase() === "idempotency-key") {
      assertValidIdempotencyKey(value, `${name}.${headerName}`);
    }
  }
}

function buildBaseUrl(scheme: string | undefined, host: string | undefined): string | undefined {
  if (scheme !== undefined && host === undefined) {
    throw new Error("AhaSend: `AHASEND_SCHEME` requires `AHASEND_HOST`.");
  }
  if (host === undefined) return undefined;
  assertNonEmptyString(host, "AHASEND_HOST");
  const selectedScheme = scheme ?? "https";
  assertNonEmptyString(selectedScheme, "AHASEND_SCHEME");
  return `${selectedScheme}://${host}`;
}

function assertNotBrowser(allow: boolean): void {
  if (allow) return;
  // Regular browsers expose `window`/`document`; Service Workers expose
  // `ServiceWorkerGlobalScope` but not `window`. Both are credential-exposure risks.
  const g = globalThis as {
    window?: unknown;
    document?: unknown;
    ServiceWorkerGlobalScope?: unknown;
  };
  const isBrowser = typeof g.window !== "undefined" || typeof g.document !== "undefined";
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

function normalizeBaseUrl(baseUrl: unknown, allowInsecure: boolean): string {
  assertNonEmptyString(baseUrl, "baseUrl");

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`AhaSend: invalid baseUrl "${baseUrl}" — expected a full URL origin.`);
  }

  if (
    parsed.username ||
    parsed.password ||
    !/^\/*$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `AhaSend: invalid baseUrl "${baseUrl}" — expected an origin without credentials, path, query, or fragment.`,
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `AhaSend: invalid baseUrl protocol "${parsed.protocol}" — expected https or http.`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (parsed.protocol === "http:" && !isLocalhost && !allowInsecure) {
    throw new Error(
      `AhaSend: refusing to send the bearer API key over an insecure baseUrl ("${baseUrl}"). ` +
        `Use https:// or set { dangerouslyAllowInsecureBaseUrl: true } to override.`,
    );
  }

  return parsed.origin;
}

function assertRetryConfig(config: unknown): void {
  if (config === undefined) return;
  assertPlainRecord(config, "retry");
  assertKnownKeys(
    config,
    new Set(["enabled", "maxRetries", "baseDelayMs", "maxDelayMs", "strategy", "jitter"]),
    "retry",
  );
  assertOptionalBoolean(config.enabled, "retry.enabled");
  assertOptionalBoolean(config.jitter, "retry.jitter");
  if (config.maxRetries !== undefined) {
    assertNonNegativeInteger(config.maxRetries, "retry.maxRetries");
  }
  if (config.baseDelayMs !== undefined) {
    assertNonNegativeFiniteNumber(config.baseDelayMs, "retry.baseDelayMs");
  }
  if (config.maxDelayMs !== undefined) {
    assertNonNegativeFiniteNumber(config.maxDelayMs, "retry.maxDelayMs");
  }
  if (config.strategy !== undefined && !RETRY_STRATEGIES.has(config.strategy as string)) {
    throw new Error('AhaSend: `retry.strategy` must be "exponential", "linear", or "constant".');
  }

  const resolved = resolveRetryConfig(config as RetryConfig);
  if (resolved.maxDelayMs < resolved.baseDelayMs) {
    throw new Error(
      "AhaSend: `retry.maxDelayMs` must be greater than or equal to `retry.baseDelayMs`.",
    );
  }
}

function assertRateLimitConfig(config: unknown): void {
  if (config === undefined) return;
  assertPlainRecord(config, "rateLimit");
  assertKnownKeys(
    config,
    new Set(["enabled", "general", "statistics", "sendMessage"]),
    "rateLimit",
  );
  assertOptionalBoolean(config.enabled, "rateLimit.enabled");

  for (const category of ["general", "statistics", "sendMessage"] as const) {
    const value = config[category];
    if (value === undefined) continue;
    assertPlainRecord(value, `rateLimit.${category}`);
    assertKnownKeys(
      value,
      new Set(["enabled", "requestsPerSecond", "burst"]),
      `rateLimit.${category}`,
    );
    assertOptionalBoolean(value.enabled, `rateLimit.${category}.enabled`);
    if (value.requestsPerSecond !== undefined) {
      assertPositiveFiniteNumber(
        value.requestsPerSecond,
        `rateLimit.${category}.requestsPerSecond`,
      );
    }
    if (value.burst !== undefined) {
      assertPositiveFiniteNumber(value.burst, `rateLimit.${category}.burst`);
    }
  }
}

function assertTelemetryHooks(hooks: unknown): void {
  if (hooks === undefined) return;
  assertPlainRecord(hooks, "hooks");
  assertKnownKeys(hooks, HOOK_NAMES, "hooks");
  for (const [name, hook] of Object.entries(hooks)) {
    if (typeof hook !== "function") {
      throw new Error(`AhaSend: \`hooks.${name}\` must be a function.`);
    }
  }
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`AhaSend: \`${name}\` must be an object.`);
  }
}

function assertPlainRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  assertRecord(value, name);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`AhaSend: \`${name}\` must be a plain object.`);
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  name: string,
): void {
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      const legacyHint = key === "timeout" ? " Use `timeoutMs` instead." : "";
      throw new Error(`AhaSend: unknown \`${name}.${key}\` option.${legacyHint}`);
    }
  }
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`AhaSend: \`${name}\` must be a non-empty string.`);
  }
}

function assertHeaderValue(value: string, name: string): void {
  if (INVALID_HEADER_VALUE_PATTERN.test(value)) {
    throw new Error(`AhaSend: \`${name}\` contains characters that are invalid in an HTTP header.`);
  }
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`AhaSend: \`${name}\` must be a boolean.`);
  }
}

function assertPositiveFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`AhaSend: \`${name}\` must be a positive finite number.`);
  }
}

function assertNonNegativeFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`AhaSend: \`${name}\` must be a non-negative finite number.`);
  }
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`AhaSend: \`${name}\` must be a non-negative integer.`);
  }
}

function parseFiniteNumber(value: string, name: string): number {
  if (value.trim().length === 0) {
    throw new Error(`AhaSend: \`${name}\` must be a finite number.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`AhaSend: \`${name}\` must be a finite number.`);
  }
  return parsed;
}

function parseBool(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disable", "disabled"].includes(normalized)) return false;
  throw new Error(`AhaSend: \`${name}\` must be a boolean value.`);
}
