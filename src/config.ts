import type { IdempotencyConfig, ResolvedIdempotencyConfig } from "./idempotency.js";
import { assertValidIdempotencyKey, resolveIdempotencyConfig } from "./idempotency.js";
import { AhaSendConfigurationError } from "./errors.js";
import type { RateLimitConfig, ResolvedRateLimitConfig } from "./rate-limit.js";
import {
  assertBurst,
  assertMaxQueue,
  assertRequestsPerSecond,
  resolveRateLimitConfig,
} from "./rate-limit.js";
import type { ResolvedRetryConfig, RetryConfig } from "./retry.js";
import { MAX_RETRIES, resolveRetryConfig } from "./retry.js";
import type { ResolvedTelemetryHooks, TelemetryHooks } from "./telemetry.js";
import { composeHooks, debugConsoleHooks, resolveTelemetryHooks } from "./telemetry.js";
import type { IdempotencyRequestOptions, RequestOptions } from "./types/common.js";
import { DEFAULT_USER_AGENT } from "./version.js";

/**
 * A `process.env`-shaped read-only lookup.
 *
 * Declared structurally rather than as `NodeJS.ProcessEnv` so the published
 * declarations never name a type that only `@types/node` supplies. `process.env`
 * satisfies this, as does any plain object of string values — which is also what
 * makes {@link optionsFromEnv} testable without mutating the real environment.
 */
export type ProcessEnvLike = Readonly<Record<string, string | undefined>>;

const EMPTY_PROCESS_ENV: ProcessEnvLike = Object.freeze({});

/** @internal Resolve the Node.js environment without assuming `process` exists. */
export function defaultProcessEnv(): ProcessEnvLike {
  return typeof process !== "undefined" && process !== null && process.env
    ? process.env
    : EMPTY_PROCESS_ENV;
}

export const DEFAULT_BASE_URL = "https://api.ahasend.com";
export const DEFAULT_TIMEOUT_MS = 30_000;
/** @internal Largest delay supported by Node.js timer APIs without coercion. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  /** Timeout for each fetch attempt, including response-body reading. */
  timeoutMs?: number | undefined;
  userAgent?: string | undefined;
  debug?: boolean | undefined;
  fetch?: typeof fetch | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  idempotency?: IdempotencyConfig | undefined;
  retry?: RetryConfig | undefined;
  rateLimit?: RateLimitConfig | undefined;
  hooks?: TelemetryHooks | undefined;
  /**
   * Allow an HTTP `baseUrl` (other than localhost / loopback).
   * Defaults to `false`. Setting this to `true` lets the SDK send the
   * bearer token in plaintext, which is dangerous; only enable it for
   * development environments where you control the network.
   */
  dangerouslyAllowInsecureBaseUrl?: boolean | undefined;
  /**
   * This SDK is server-side only — embedding the bearer API key in a
   * browser bundle exposes it to anyone visiting your site. The
   * constructor throws if it detects browser globals (`window` or `document`),
   * or a service-worker scope without a recognized server-runtime signal.
   * Set this to `true` only when you have a non-browser reason for the
   * browser-shaped globals to exist (e.g. JSDOM in unit tests).
   */
  dangerouslyAllowBrowser?: boolean | undefined;
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

const REQUEST_OPTION_NAMES = new Set(["signal", "headers", "timeoutMs", "retry"]);
const IDEMPOTENCY_REQUEST_OPTION_NAMES = new Set([...REQUEST_OPTION_NAMES, "idempotencyKey"]);
const RETRY_STRATEGIES = new Set(["exponential", "linear", "constant"]);
const HOOK_NAMES = new Set(["onRequest", "onResponse", "onRetry", "onError"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INVALID_HEADER_VALUE_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f]|[^\u0000-\u00ff]/;
const HTTP_ORIGIN_PATTERN = /^https?:\/\/[^\s/?#\\]+\/?$/i;
const CONTROLLED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "idempotency-key",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);
const METHOD_OVERRIDE_HEADERS = new Set([
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);
const FORBIDDEN_METHODS = new Set(["connect", "trace", "track"]);

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
  assertTimeoutMs(timeoutMs, "timeoutMs");

  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  assertNonEmptyString(userAgent, "userAgent");
  assertHeaderValue(userAgent, "userAgent");

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AhaSendConfigurationError(
      "AhaSend: `fetch` is not available. Use Node.js 22 or later, or inject a `fetch` implementation via `options.fetch`.",
    );
  }

  const defaultHeaders = assertHeaders(options.defaultHeaders, "defaultHeaders") ?? {};
  assertRetryConfig(options.retry);
  const rateLimit = assertRateLimitConfig(options.rateLimit);
  assertTelemetryHooks(options.hooks);

  return {
    apiKey: options.apiKey,
    baseUrl,
    timeoutMs,
    userAgent,
    debug: options.debug ?? false,
    fetch: fetchImpl,
    defaultHeaders,
    idempotency: resolveIdempotencyConfig(options.idempotency),
    retry: resolveRetryConfig(options.retry),
    rateLimit: resolveRateLimitConfig(rateLimit),
    hooks: resolveTelemetryHooks(
      options.debug ? composeHooks(debugConsoleHooks(), options.hooks) : options.hooks,
    ),
  };
}

export function optionsFromEnv(env: ProcessEnvLike = defaultProcessEnv()): ClientOptions {
  const apiKey = env.AHASEND_API_KEY || env.AHASEND_TOKEN;
  if (!apiKey) {
    throw new AhaSendConfigurationError(
      "AhaSend: missing API key. Set AHASEND_API_KEY (or AHASEND_TOKEN) environment variable.",
    );
  }
  assertNonEmptyString(apiKey, "AHASEND_API_KEY/AHASEND_TOKEN");
  assertHeaderValue(apiKey, "AHASEND_API_KEY/AHASEND_TOKEN");

  const options: ClientOptions = { apiKey };

  const allowInsecureBaseUrl =
    env.AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL === undefined
      ? false
      : parseBool(
          env.AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL,
          "AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL",
        );
  if (env.AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL !== undefined) {
    options.dangerouslyAllowInsecureBaseUrl = allowInsecureBaseUrl;
  }

  const baseUrl = env.AHASEND_BASE_URL ?? buildBaseUrl(env.AHASEND_SCHEME, env.AHASEND_HOST);
  if (baseUrl !== undefined) {
    options.baseUrl = normalizeBaseUrl(baseUrl, allowInsecureBaseUrl, false);
  }

  if (env.AHASEND_USER_AGENT !== undefined) {
    assertNonEmptyString(env.AHASEND_USER_AGENT, "AHASEND_USER_AGENT");
    assertHeaderValue(env.AHASEND_USER_AGENT, "AHASEND_USER_AGENT");
    options.userAgent = env.AHASEND_USER_AGENT;
  }

  if (env.AHASEND_TIMEOUT !== undefined) {
    const seconds = parseFiniteNumber(env.AHASEND_TIMEOUT, "AHASEND_TIMEOUT");
    if (seconds <= 0) {
      throw new AhaSendConfigurationError(
        "AhaSend: `AHASEND_TIMEOUT` must be a positive number of seconds.",
      );
    }
    const timeoutMs = seconds * 1000;
    assertTimeoutMs(timeoutMs, "AHASEND_TIMEOUT");
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
    assertRetryCount(maxRetries, "AHASEND_MAX_RETRIES");
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
    throw new AhaSendConfigurationError(
      "AhaSend: `request options.signal` must be an AbortSignal.",
    );
  }
  assertHeaders(options.headers, "request options.headers");
  if (options.timeoutMs !== undefined) {
    assertTimeoutMs(options.timeoutMs, "request options.timeoutMs");
  }
  if (options.retry !== undefined && options.retry !== false) {
    assertRequestRetryOverride(options.retry);
  }

  if (allowIdempotencyKey && options.idempotencyKey !== undefined) {
    assertValidIdempotencyKey(options.idempotencyKey, "request options.idempotencyKey");
  }
}

/** @internal Validate the public per-call retry override shape. */
export function assertRequestRetryOverride(
  retry: unknown,
): asserts retry is false | Partial<RetryConfig> {
  if (retry === false) return;
  assertRetryConfig(retry, "request options.retry", false);
}

/** @internal Validate caller headers and reject names owned by the SDK transport. */
/**
 * Validate a header record and return a plain snapshot of it.
 *
 * The snapshot is what callers must store. `assertPlainRecord` permits
 * accessors, so validating the caller's object and then reading it again to
 * copy it lets a getter return one value to the check and another to the
 * store — which is how an unvalidated CRLF could reach the transport.
 */
export function assertHeaders(
  headers: unknown,
  name: string,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined;
  assertPlainRecord(headers, name);
  const snapshot: Record<string, string> = {};
  for (const [headerName, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(headerName)) {
      throw new AhaSendConfigurationError(
        `AhaSend: \`${name}\` contains an invalid header name "${headerName}".`,
      );
    }
    if (typeof value !== "string") {
      throw new AhaSendConfigurationError(`AhaSend: \`${name}.${headerName}\` must be a string.`);
    }
    assertHeaderValue(value, `${name}.${headerName}`);
    if (isControlledRequestHeader(headerName, value)) {
      throw new AhaSendConfigurationError(
        `AhaSend: \`${name}.${headerName}\` is controlled by the SDK transport or Fetch and cannot be overridden.`,
      );
    }
    snapshot[headerName] = value;
  }
  return snapshot;
}

function isControlledRequestHeader(name: string, value: string): boolean {
  const normalizedName = name.toLowerCase();
  if (
    CONTROLLED_REQUEST_HEADERS.has(normalizedName) ||
    normalizedName.startsWith("proxy-") ||
    normalizedName.startsWith("sec-")
  ) {
    return true;
  }
  if (!METHOD_OVERRIDE_HEADERS.has(normalizedName)) return false;
  return value.split(",").some((method) => FORBIDDEN_METHODS.has(method.trim().toLowerCase()));
}

function buildBaseUrl(scheme: string | undefined, host: string | undefined): string | undefined {
  if (scheme !== undefined && host === undefined) {
    throw new AhaSendConfigurationError("AhaSend: `AHASEND_SCHEME` requires `AHASEND_HOST`.");
  }
  if (host === undefined) return undefined;
  assertNonEmptyString(host, "AHASEND_HOST");
  const selectedScheme = scheme ?? "https";
  assertNonEmptyString(selectedScheme, "AHASEND_SCHEME");
  return `${selectedScheme}://${host}`;
}

function assertNotBrowser(allow: boolean): void {
  if (allow) return;

  const g = globalThis as {
    window?: unknown;
    document?: unknown;
    ServiceWorkerGlobalScope?: unknown;
    navigator?: { userAgent?: unknown } | null;
    EdgeRuntime?: unknown;
    Deno?: unknown;
    Bun?: unknown;
    process?: { versions?: { node?: unknown } | null } | null;
  };
  const isBrowser = typeof g.window !== "undefined" || typeof g.document !== "undefined";
  const isServiceWorker = typeof g.ServiceWorkerGlobalScope !== "undefined";
  const hasServerRuntimeSignal =
    g.navigator?.userAgent === "Cloudflare-Workers" ||
    typeof g.EdgeRuntime !== "undefined" ||
    typeof g.Deno !== "undefined" ||
    typeof g.Bun !== "undefined" ||
    typeof g.process?.versions?.node !== "undefined";

  if (isBrowser || (isServiceWorker && !hasServerRuntimeSignal)) {
    throw new AhaSendConfigurationError(
      "AhaSend: refusing to construct an AhaSendClient in a browser-like " +
        "environment (window/document/ServiceWorker) — embedding the bearer " +
        "API key in a browser bundle exposes it. Use this SDK from a Node.js " +
        "(or other server) runtime, or pass { dangerouslyAllowBrowser: true } " +
        "if you really know what you are doing.",
    );
  }
}

function normalizeBaseUrl(baseUrl: unknown, allowInsecure: boolean, allowLocalhost = true): string {
  assertNonEmptyString(baseUrl, "baseUrl");

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (cause) {
    throw new AhaSendConfigurationError(
      "AhaSend: invalid baseUrl — expected a full URL origin.",
      cause,
    );
  }

  if (
    parsed.username ||
    parsed.password ||
    baseUrl.includes("@") ||
    parsed.pathname !== "/" ||
    baseUrl.includes("?") ||
    baseUrl.includes("#") ||
    baseUrl !== baseUrl.trim() ||
    ((parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !HTTP_ORIGIN_PATTERN.test(baseUrl))
  ) {
    throw new AhaSendConfigurationError(
      "AhaSend: invalid baseUrl — expected an origin without credentials, path, query, or fragment.",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AhaSendConfigurationError(
      `AhaSend: invalid baseUrl protocol "${parsed.protocol}" — expected https or http.`,
    );
  }

  const isLocalhost = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(baseUrl);
  if (parsed.protocol === "http:" && (!isLocalhost || !allowLocalhost) && !allowInsecure) {
    throw new AhaSendConfigurationError(
      "AhaSend: refusing to send the bearer API key over an insecure baseUrl. " +
        `Use https:// or set { dangerouslyAllowInsecureBaseUrl: true } to override.`,
    );
  }

  return parsed.origin;
}

function assertRetryConfig(config: unknown, name = "retry", checkResolvedDelays = true): void {
  if (config === undefined) return;
  assertPlainRecord(config, name);
  assertKnownKeys(
    config,
    new Set(["enabled", "maxRetries", "baseDelayMs", "maxDelayMs", "strategy", "jitter"]),
    name,
  );
  assertOptionalBoolean(config.enabled, `${name}.enabled`);
  assertOptionalBoolean(config.jitter, `${name}.jitter`);
  if (config.maxRetries !== undefined) {
    assertRetryCount(config.maxRetries, `${name}.maxRetries`);
  }
  if (config.baseDelayMs !== undefined) {
    assertNonNegativeFiniteNumber(config.baseDelayMs, `${name}.baseDelayMs`);
    assertSupportedTimerDelay(config.baseDelayMs, `${name}.baseDelayMs`);
  }
  if (config.maxDelayMs !== undefined) {
    assertNonNegativeFiniteNumber(config.maxDelayMs, `${name}.maxDelayMs`);
    assertSupportedTimerDelay(config.maxDelayMs, `${name}.maxDelayMs`);
  }
  if (config.strategy !== undefined && !RETRY_STRATEGIES.has(config.strategy as string)) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}.strategy\` must be "exponential", "linear", or "constant".`,
    );
  }

  const resolved = resolveRetryConfig(config);
  if (checkResolvedDelays && resolved.maxDelayMs < resolved.baseDelayMs) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}.maxDelayMs\` must be greater than or equal to \`${name}.baseDelayMs\`.`,
    );
  }
}

/**
 * Validate the rate-limit options and return a plain snapshot of them.
 *
 * The snapshot is what gets resolved. `assertPlainRecord` permits accessors, so
 * reading a field again after validating it could install a value that never
 * passed — returning the values read during validation closes that gap instead
 * of trusting the caller's object to be stable.
 */
function assertRateLimitConfig(config: unknown): RateLimitConfig | undefined {
  if (config === undefined) return undefined;
  assertPlainRecord(config, "rateLimit");
  assertKnownKeys(config, new Set(["enabled", "standard", "statistics"]), "rateLimit");
  const masterEnabled = config.enabled;
  assertOptionalBoolean(masterEnabled, "rateLimit.enabled");
  const snapshot: RateLimitConfig = {
    ...(masterEnabled !== undefined ? { enabled: masterEnabled } : {}),
  };

  for (const category of ["standard", "statistics"] as const) {
    const value = config[category];
    if (value === undefined) continue;
    assertPlainRecord(value, `rateLimit.${category}`);
    assertKnownKeys(
      value,
      new Set(["enabled", "requestsPerSecond", "burst", "maxQueue"]),
      `rateLimit.${category}`,
    );
    // Read each value once and validate the snapshot, not the source object.
    const { enabled, requestsPerSecond, burst, maxQueue } = value;
    assertOptionalBoolean(enabled, `rateLimit.${category}.enabled`);
    if (requestsPerSecond !== undefined) {
      assertRequestsPerSecond(requestsPerSecond, `rateLimit.${category}.requestsPerSecond`);
    }
    if (burst !== undefined) assertBurst(burst, `rateLimit.${category}.burst`);
    if (maxQueue !== undefined) assertMaxQueue(maxQueue, `rateLimit.${category}.maxQueue`);

    snapshot[category] = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(requestsPerSecond !== undefined ? { requestsPerSecond } : {}),
      ...(burst !== undefined ? { burst } : {}),
      ...(maxQueue !== undefined ? { maxQueue } : {}),
    };
  }

  return snapshot;
}

function assertTelemetryHooks(hooks: unknown): void {
  if (hooks === undefined) return;
  assertPlainRecord(hooks, "hooks");
  assertKnownKeys(hooks, HOOK_NAMES, "hooks");
  for (const [name, hook] of Object.entries(hooks)) {
    if (hook !== undefined && typeof hook !== "function") {
      throw new AhaSendConfigurationError(`AhaSend: \`hooks.${name}\` must be a function.`);
    }
  }
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be an object.`);
  }
}

/** @internal Validate that an option container preserves plain-record semantics. */
export function assertPlainRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  assertRecord(value, name);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a plain object.`);
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
      throw new AhaSendConfigurationError(
        `AhaSend: unknown \`${name}.${key}\` option.${legacyHint}`,
      );
    }
  }
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a non-empty string.`);
  }
}

function assertHeaderValue(value: string, name: string): void {
  if (INVALID_HEADER_VALUE_PATTERN.test(value)) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}\` contains characters that are invalid in an HTTP header.`,
    );
  }
}

function assertOptionalBoolean(value: unknown, name: string): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a boolean.`);
  }
}

function assertPositiveFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a positive finite number.`);
  }
}

/** @internal Validate a timeout against Node.js's supported timer range. */
export function assertTimeoutMs(value: unknown, name: string): asserts value is number {
  assertPositiveFiniteNumber(value, name);
  assertSupportedTimerDelay(value, name);
}

function assertNonNegativeFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}\` must be a non-negative finite number.`,
    );
  }
}

function assertSupportedTimerDelay(value: number, name: string): void {
  if (value > MAX_TIMER_DELAY_MS) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}\` must be less than or equal to ${MAX_TIMER_DELAY_MS} milliseconds.`,
    );
  }
}

function assertRetryCount(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_RETRIES
  ) {
    throw new AhaSendConfigurationError(
      `AhaSend: \`${name}\` must be a safe integer from 0 through ${MAX_RETRIES}.`,
    );
  }
}

function parseFiniteNumber(value: string, name: string): number {
  if (value.trim().length === 0) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a finite number.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a finite number.`);
  }
  return parsed;
}

function parseBool(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disable", "disabled"].includes(normalized)) return false;
  throw new AhaSendConfigurationError(`AhaSend: \`${name}\` must be a boolean value.`);
}
