import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
import type { ClientOptions } from "../src/config.js";
import { DEFAULT_BASE_URL, optionsFromEnv, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("requires an apiKey", () => {
    expect(() => resolveConfig({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("exposes timeoutMs (and not the legacy timeout option) in the public contract", () => {
    type HasTimeout = "timeout" extends keyof ClientOptions ? true : false;
    type HasTimeoutMs = "timeoutMs" extends keyof ClientOptions ? true : false;

    expectTypeOf<HasTimeout>().toEqualTypeOf<false>();
    expectTypeOf<HasTimeoutMs>().toEqualTypeOf<true>();
    expect(() => resolveConfig({ apiKey: "aha-sk-test", timeout: 1 } as never)).toThrow(
      /timeoutMs/,
    );
  });

  it("applies defaults for baseUrl, timeoutMs, userAgent, and idempotency", () => {
    const resolved = resolveConfig({ apiKey: "aha-sk-test" });
    expect(resolved.apiKey).toBe("aha-sk-test");
    expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(resolved.timeoutMs).toBe(30_000);
    expect(resolved.userAgent).toMatch(/^ahasend-node\//);
    expect(resolved.debug).toBe(false);
    expect(typeof resolved.fetch).toBe("function");
    expect(resolved.idempotency).toEqual({ autoGenerate: true, prefix: "" });
  });

  it("respects custom idempotency config", () => {
    const resolved = resolveConfig({
      apiKey: "aha-sk-test",
      idempotency: { autoGenerate: false, prefix: "myapp" },
    });
    expect(resolved.idempotency).toEqual({ autoGenerate: false, prefix: "myapp" });
  });

  it("rejects non-HTTPS baseUrls without the override flag", () => {
    expect(() =>
      resolveConfig({ apiKey: "aha-sk-test", baseUrl: "http://api.example.com" }),
    ).toThrow(/insecure|https/i);
  });

  it.each(["http://localhost:4010", "http://127.0.0.1:4010", "http://[::1]:4010"])(
    "allows the explicit local HTTP origin %s",
    (baseUrl) => {
      expect(resolveConfig({ apiKey: "aha-sk-test", baseUrl }).baseUrl).toBe(baseUrl);
    },
  );

  it.each([
    "http://dev.localhost:4010",
    "http://127.0.0.2:4010",
    "http://127.1:4010",
    "http://[::]:4010",
    "http://[0:0:0:0:0:0:0:1]:4010",
  ])("rejects the non-explicit local HTTP form %s", (baseUrl) => {
    expect(() => resolveConfig({ apiKey: "aha-sk-test", baseUrl })).toThrow(/insecure|https/i);
  });

  it("dangerouslyAllowInsecureBaseUrl opt-in lets http:// through", () => {
    expect(() =>
      resolveConfig({
        apiKey: "aha-sk-test",
        baseUrl: "http://api.example.com",
        dangerouslyAllowInsecureBaseUrl: true,
      }),
    ).not.toThrow();
  });

  it("refuses to construct in a browser-like environment (window present)", () => {
    const g = globalThis as { window?: unknown };
    const original = g.window;
    g.window = {}; // simulate a browser
    try {
      expect(() => resolveConfig({ apiKey: "aha-sk-test" })).toThrow(/browser/i);
    } finally {
      if (original === undefined) delete g.window;
      else g.window = original;
    }
  });

  it("dangerouslyAllowBrowser opt-in bypasses the browser guard", () => {
    const g = globalThis as { window?: unknown };
    const original = g.window;
    g.window = {};
    try {
      expect(() =>
        resolveConfig({ apiKey: "aha-sk-test", dangerouslyAllowBrowser: true }),
      ).not.toThrow();
    } finally {
      if (original === undefined) delete g.window;
      else g.window = original;
    }
  });

  it("normalizes an origin with one trailing slash", () => {
    const resolved = resolveConfig({
      apiKey: "aha-sk-test",
      baseUrl: "https://api.example.com/",
    });
    expect(resolved.baseUrl).toBe("https://api.example.com");
  });

  it.each([
    "https://user:password@api.example.com",
    "https://@api.example.com",
    "https://:@api.example.com",
    "https://api.example.com/v2",
    "https://api.example.com/.",
    "https://api.example.com/v2/..",
    "https://api.example.com/%2e",
    "https://api.example.com?region=us",
    "https://api.example.com?",
    "https://api.example.com#fragment",
    "https://api.example.com#",
    "https://api.example.com///",
    " https://api.example.com",
    "https:api.example.com",
    "https:\\api.example.com",
    "ftp://api.example.com",
  ])("rejects a baseUrl that is not an HTTP(S) origin: %s", (baseUrl) => {
    expect(() => resolveConfig({ apiKey: "aha-sk-test", baseUrl })).toThrow(
      /baseUrl|origin|protocol/,
    );
  });

  it("does not allow the insecure-development flag to enable non-HTTP protocols", () => {
    expect(() =>
      resolveConfig({
        apiKey: "aha-sk-test",
        baseUrl: "ftp://api.example.com",
        dangerouslyAllowInsecureBaseUrl: true,
      }),
    ).toThrow(/protocol/);
  });

  it("uses an injected fetch when provided", () => {
    const mockFetch = (async () => new Response("ok")) as typeof fetch;
    const resolved = resolveConfig({ apiKey: "aha-sk-test", fetch: mockFetch });
    expect(resolved.fetch).toBe(mockFetch);
  });

  it.each([
    ["timeoutMs", { timeoutMs: 0 }],
    ["timeoutMs", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["debug", { debug: "true" }],
    ["fetch", { fetch: {} }],
    ["userAgent", { userAgent: "" }],
    ["dangerouslyAllowBrowser", { dangerouslyAllowBrowser: 1 }],
    ["unknown", { typo: true }],
  ])("rejects invalid constructor option %s", (_name, invalid) => {
    expect(() => resolveConfig({ apiKey: "aha-sk-test", ...invalid } as never)).toThrow();
  });

  it("rejects a non-plain top-level configuration object", () => {
    const options = Object.assign(new Date(0), { apiKey: "aha-sk-test" });
    expect(() => resolveConfig(options as never)).toThrow(/plain object/i);
  });

  it.each([
    ["Date", Object.assign(new Date(0), { apiKey: "aha-sk-test", accountId: "account-id" })],
    ["Map", Object.assign(new Map(), { apiKey: "aha-sk-test", accountId: "account-id" })],
    ["array", Object.assign([], { apiKey: "aha-sk-test", accountId: "account-id" })],
    [
      "custom prototype",
      Object.assign(Object.create({ inherited: true }) as object, {
        apiKey: "aha-sk-test",
        accountId: "account-id",
      }),
    ],
  ])("rejects a non-plain %s container through the public constructor", (_name, options) => {
    expect(() => new AhaSendClient(options as never)).toThrow(/object/i);
  });

  it.each([
    ["bad header name", { "bad header": "value" }],
    ["line break", { "x-test": "safe\r\ninjected: true" }],
    ["non-string value", { "x-test": 42 }],
    ["whitespace-only idempotency key", { "Idempotency-Key": " \t " }],
    ["Headers instance", new Headers({ "x-test": "value" })],
    ["Map instance", new Map([["x-test", "value"]])],
    ["Date instance", new Date(0)],
  ])("rejects invalid default headers: %s", (_name, defaultHeaders) => {
    expect(() => resolveConfig({ apiKey: "aha-sk-test", defaultHeaders } as never)).toThrow(
      /header|string/i,
    );
  });

  it.each([
    "Accept",
    "AUTHORIZATION",
    "Content-Length",
    "content-TYPE",
    "HOST",
    "Idempotency-Key",
    "User-Agent",
  ])("rejects the transport-owned default header %s case-insensitively", (header) => {
    expect(() =>
      resolveConfig({ apiKey: "aha-sk-test", defaultHeaders: { [header]: "override" } }),
    ).toThrow(/owned|cannot be overridden/i);
  });

  it.each([
    ["negative retries", { maxRetries: -1 }],
    ["fractional retries", { maxRetries: 1.5 }],
    ["negative base delay", { baseDelayMs: -1 }],
    ["infinite maximum delay", { maxDelayMs: Number.POSITIVE_INFINITY }],
    ["maximum below base", { baseDelayMs: 10, maxDelayMs: 5 }],
    ["unknown strategy", { strategy: "random" }],
    ["non-boolean jitter", { jitter: 1 }],
  ])("rejects invalid retry config: %s", (_name, retry) => {
    expect(() => resolveConfig({ apiKey: "aha-sk-test", retry } as never)).toThrow(/retry/);
  });

  it.each([
    ["retry", { retry: new Date(0) }],
    ["rateLimit", { rateLimit: new Map() }],
    ["rateLimit.general", { rateLimit: { general: new Date(0) } }],
    ["hooks", { hooks: new Map() }],
    ["idempotency", { idempotency: new Date(0) }],
  ])("rejects a non-plain %s configuration object", (_name, invalid) => {
    expect(() => resolveConfig({ apiKey: "aha-sk-test", ...invalid } as never)).toThrow(
      /plain object/i,
    );
  });

  it("rejects invalid per-request options synchronously before fetch", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "account-id",
      fetch: fetchImpl,
    });

    expect(() => client.ping({ headers: { "bad header": "value" } })).toThrow(/header/i);
    expect(() => client.ping({ signal: {} as AbortSignal })).toThrow(/AbortSignal/);
    expect(() => client.messages.send({} as never, { idempotencyKey: "" })).toThrow(
      /idempotencyKey/i,
    );
    expect(() => client.messages.send({} as never, { idempotencyKey: " \t " })).toThrow(
      /idempotencyKey/i,
    );
    expect(() =>
      client.messages.send({} as never, { headers: { "Idempotency-Key": " \t " } }),
    ).toThrow(/Idempotency-Key/i);
    expect(() =>
      client.ping({
        headers: new Headers({ "x-test": "value" }) as unknown as Record<string, string>,
      }),
    ).toThrow(/plain object/i);
    expect(() => client.ping(new Date(0) as never)).toThrow(/plain object/i);
    expect(() => client.messages.send({} as never, new Map() as never)).toThrow(/plain object/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "aCcEpT",
    "Authorization",
    "CONTENT-LENGTH",
    "Content-Type",
    "Host",
    "IDEMPOTENCY-KEY",
    "USER-AGENT",
  ])("rejects the transport-owned request header %s before fetch", (header) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "account-id",
      fetch: fetchImpl,
    });

    expect(() => client.ping({ headers: { [header]: "override" } })).toThrow(
      /owned|cannot be overridden/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("optionsFromEnv", () => {
  it("throws when neither AHASEND_API_KEY nor AHASEND_TOKEN is set", () => {
    expect(() => optionsFromEnv({})).toThrow(/AHASEND_API_KEY/);
  });

  it("reads AHASEND_API_KEY", () => {
    const options = optionsFromEnv({ AHASEND_API_KEY: "aha-sk-env" });
    expect(options.apiKey).toBe("aha-sk-env");
  });

  it("falls back to AHASEND_TOKEN", () => {
    const options = optionsFromEnv({ AHASEND_TOKEN: "aha-sk-token" });
    expect(options.apiKey).toBe("aha-sk-token");
  });

  it("reads AHASEND_BASE_URL", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_BASE_URL: "https://example.ahasend.com",
    });
    expect(options.baseUrl).toBe("https://example.ahasend.com");
  });

  it("builds baseUrl from scheme and host when AHASEND_BASE_URL is not set", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_HOST: "localhost:4010",
      AHASEND_SCHEME: "http",
    });
    expect(options.baseUrl).toBe("http://localhost:4010");
  });

  it("converts AHASEND_TIMEOUT seconds to milliseconds", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_TIMEOUT: "5",
    });
    expect(options.timeoutMs).toBe(5000);
  });

  it("parses AHASEND_DEBUG truthy values", () => {
    for (const value of ["true", "1", "yes", "on", "enable"]) {
      const options = optionsFromEnv({ AHASEND_API_KEY: "aha-sk-test", AHASEND_DEBUG: value });
      expect(options.debug).toBe(true);
    }
  });

  it("parses AHASEND_DEBUG falsy values", () => {
    for (const value of ["false", "0", "no", "off"]) {
      const options = optionsFromEnv({ AHASEND_API_KEY: "aha-sk-test", AHASEND_DEBUG: value });
      expect(options.debug).toBe(false);
    }
  });

  it("reads AHASEND_IDEMPOTENCY_AUTO_GENERATE", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_IDEMPOTENCY_AUTO_GENERATE: "false",
    });
    expect(options.idempotency).toEqual({ autoGenerate: false });
  });

  it("reads AHASEND_IDEMPOTENCY_PREFIX", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_IDEMPOTENCY_PREFIX: "prod",
    });
    expect(options.idempotency).toEqual({ prefix: "prod" });
  });

  it("combines both idempotency env vars", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_IDEMPOTENCY_AUTO_GENERATE: "true",
      AHASEND_IDEMPOTENCY_PREFIX: "staging",
    });
    expect(options.idempotency).toEqual({ autoGenerate: true, prefix: "staging" });
  });

  it.each([
    ["AHASEND_TIMEOUT", { AHASEND_TIMEOUT: "0" }],
    ["AHASEND_TIMEOUT", { AHASEND_TIMEOUT: "not-a-number" }],
    ["AHASEND_MAX_RETRIES", { AHASEND_MAX_RETRIES: "-1" }],
    ["AHASEND_MAX_RETRIES", { AHASEND_MAX_RETRIES: "1.5" }],
    ["AHASEND_DEBUG", { AHASEND_DEBUG: "sometimes" }],
    ["AHASEND_ENABLE_RATE_LIMIT", { AHASEND_ENABLE_RATE_LIMIT: "" }],
    ["AHASEND_IDEMPOTENCY_AUTO_GENERATE", { AHASEND_IDEMPOTENCY_AUTO_GENERATE: "automatic" }],
    ["AHASEND_SCHEME", { AHASEND_SCHEME: "https" }],
    ["AHASEND_API_KEY", { AHASEND_API_KEY: "   " }],
  ])("rejects invalid %s values instead of silently ignoring them", (_name, values) => {
    expect(() => optionsFromEnv({ AHASEND_API_KEY: "aha-sk-test", ...values })).toThrow();
  });

  it("rejects an insecure non-local environment base URL", () => {
    expect(() =>
      optionsFromEnv({
        AHASEND_API_KEY: "aha-sk-test",
        AHASEND_BASE_URL: "http://api.example.com",
      }),
    ).toThrow(/insecure|https/i);
  });
});
