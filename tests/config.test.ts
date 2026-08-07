import { inspect } from "node:util";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
import type { ClientOptions } from "../src/config.js";
import {
  DEFAULT_BASE_URL,
  MAX_TIMER_DELAY_MS,
  optionsFromEnv,
  resolveConfig,
} from "../src/config.js";
import { AhaSendConfigurationError } from "../src/errors.js";
import { DEFAULT_MAX_QUEUE, MIN_REQUESTS_PER_SECOND } from "../src/rate-limit.js";
import { MAX_RETRIES } from "../src/retry.js";

function renderErrorDiagnostics(error: unknown): string[] {
  return [
    String(error),
    error instanceof Error ? error.message : undefined,
    error instanceof Error ? error.stack : undefined,
    JSON.stringify(error),
    inspect(error),
    inspect(error, { showHidden: true }),
  ].filter((diagnostic): diagnostic is string => diagnostic !== undefined);
}

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

  it("resolves opt-in pacing for the standard and statistics categories", () => {
    const resolved = resolveConfig({
      apiKey: "aha-sk-test",
      rateLimit: {
        enabled: true,
        standard: { requestsPerSecond: 50 },
        statistics: { enabled: false },
      },
    });

    expect(resolved.rateLimit).toEqual({
      enabled: true,
      standard: { requestsPerSecond: 50, burst: 200, enabled: true, maxQueue: DEFAULT_MAX_QUEUE },
      statistics: {
        requestsPerSecond: 1,
        burst: 1,
        enabled: false,
        maxQueue: DEFAULT_MAX_QUEUE,
      },
    });
  });

  it.each(["general", "sendMessage"])("rejects the obsolete rate-limit category %s", (key) => {
    expect(() =>
      resolveConfig({ apiKey: "aha-sk-test", rateLimit: { [key]: {} } } as never),
    ).toThrow(/unknown .* option/i);
  });

  // Every rule below was deletable with a green suite: the option had only
  // positive-path coverage, so nothing pinned what it refuses.
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 0.5],
    ["not a number", "5"],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    // Number.isInteger(Number.MAX_VALUE) is true, so an integer check alone
    // lets a value through that stops behaving like a count and silently
    // removes the bound this option exists to provide.
    ["beyond safe-integer range", Number.MAX_VALUE],
    ["exactly 2^53", 2 ** 53],
  ])("rejects a %s maxQueue", (_label, maxQueue) => {
    expect(() =>
      resolveConfig({
        apiKey: "aha-sk-test",
        rateLimit: { standard: { maxQueue } as never },
      }),
    ).toThrow(/maxQueue.*safe integer greater than or equal to 1/i);
  });

  it.each(["standard", "statistics"] as const)("accepts a usable %s maxQueue", (category) => {
    const resolved = resolveConfig({
      apiKey: "aha-sk-test",
      rateLimit: { [category]: { maxQueue: 25 } },
    });
    expect(resolved.rateLimit[category].maxQueue).toBe(25);
  });

  it("validates the value it installs, not one a getter showed it", () => {
    // assertPlainRecord permits accessors, so reading the field more than once
    // would let a changing getter install a value that never passed.
    let reads = 0;
    const category = {
      get maxQueue() {
        reads += 1;
        return reads > 1 ? Number.NaN : 25;
      },
    };

    const resolved = resolveConfig({
      apiKey: "aha-sk-test",
      rateLimit: { standard: category as never },
    });
    expect(resolved.rateLimit.standard.maxQueue).toBe(25);
  });

  it.each(["standard", "statistics"] as const)(
    "rejects a %s burst that cannot hold one request token",
    (category) => {
      expect(() =>
        resolveConfig({
          apiKey: "aha-sk-test",
          rateLimit: { [category]: { burst: 0.5 } },
        }),
      ).toThrow(/burst.*greater than or equal to 1/i);
    },
  );

  it.each(["standard", "statistics"] as const)(
    "accepts the exact minimum pacing rate for %s requests",
    (category) => {
      const resolved = resolveConfig({
        apiKey: "aha-sk-test",
        rateLimit: { [category]: { requestsPerSecond: MIN_REQUESTS_PER_SECOND } },
      });

      expect(resolved.rateLimit[category].requestsPerSecond).toBe(MIN_REQUESTS_PER_SECOND);
    },
  );

  it.each(["standard", "statistics"] as const)(
    "rejects a pacing rate immediately below the timer-safe minimum for %s requests",
    (category) => {
      const immediatelyBelowMinimum = MIN_REQUESTS_PER_SECOND * (1 - Number.EPSILON);

      expect(() =>
        resolveConfig({
          apiKey: "aha-sk-test",
          rateLimit: { [category]: { requestsPerSecond: immediatelyBelowMinimum } },
        }),
      ).toThrow(/requestsPerSecond.*greater than or equal/i);
    },
  );

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
    ["below", MAX_TIMER_DELAY_MS - 1],
    ["at", MAX_TIMER_DELAY_MS],
  ])("accepts a constructor timeout %s the timer maximum", (_position, timeoutMs) => {
    expect(resolveConfig({ apiKey: "aha-sk-test", timeoutMs }).timeoutMs).toBe(timeoutMs);
  });

  it.each([
    ["timeoutMs", { timeoutMs: MAX_TIMER_DELAY_MS + 1 }],
    [
      "retry.baseDelayMs",
      {
        retry: {
          baseDelayMs: MAX_TIMER_DELAY_MS + 1,
          maxDelayMs: MAX_TIMER_DELAY_MS + 1,
        },
      },
    ],
    ["retry.maxDelayMs", { retry: { maxDelayMs: MAX_TIMER_DELAY_MS + 1 } }],
  ])("rejects constructor %s above the timer maximum before fetch", (_name, invalid) => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(
      () =>
        new AhaSendClient({
          apiKey: "aha-sk-test",
          accountId: "22222222-2222-4222-8222-222222222222",
          fetch: fetchImpl,
          ...invalid,
        }),
    ).toThrow(/2147483647 milliseconds/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["below", MAX_TIMER_DELAY_MS - 1],
    ["at", MAX_TIMER_DELAY_MS],
  ])("accepts retry delays %s the timer maximum", (_position, delayMs) => {
    const resolved = resolveConfig({
      apiKey: "aha-sk-test",
      retry: { baseDelayMs: delayMs, maxDelayMs: delayMs },
    });

    expect(resolved.retry.baseDelayMs).toBe(delayMs);
    expect(resolved.retry.maxDelayMs).toBe(delayMs);
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
    [
      "Date",
      Object.assign(new Date(0), {
        apiKey: "aha-sk-test",
        accountId: "22222222-2222-4222-8222-222222222222",
      }),
    ],
    [
      "Map",
      Object.assign(new Map(), {
        apiKey: "aha-sk-test",
        accountId: "22222222-2222-4222-8222-222222222222",
      }),
    ],
    [
      "array",
      Object.assign([], {
        apiKey: "aha-sk-test",
        accountId: "22222222-2222-4222-8222-222222222222",
      }),
    ],
    [
      "custom prototype",
      Object.assign(Object.create({ inherited: true }) as object, {
        apiKey: "aha-sk-test",
        accountId: "22222222-2222-4222-8222-222222222222",
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
    "Accept-Charset",
    "Accept-Encoding",
    "Access-Control-Request-Headers",
    "Access-Control-Request-Method",
    "AUTHORIZATION",
    "Connection",
    "Content-Length",
    "content-TYPE",
    "Cookie",
    "Cookie2",
    "Date",
    "DNT",
    "Expect",
    "HOST",
    "Idempotency-Key",
    "Keep-Alive",
    "Origin",
    "Proxy-Authenticate",
    "Proxy-Authorization",
    "Referer",
    "Set-Cookie",
    "TE",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
    "User-Agent",
    "Via",
    "Proxy-Custom",
    "Sec-Custom",
  ])("rejects the controlled default header %s case-insensitively", (header) => {
    expect(() =>
      resolveConfig({ apiKey: "aha-sk-test", defaultHeaders: { [header]: "override" } }),
    ).toThrow(/owned|cannot be overridden/i);
  });

  it.each([0, MAX_RETRIES])("accepts constructor maxRetries at the boundary: %d", (maxRetries) => {
    expect(resolveConfig({ apiKey: "aha-sk-test", retry: { maxRetries } }).retry.maxRetries).toBe(
      maxRetries,
    );
  });

  it.each([
    ["below range", -1],
    ["above range", MAX_RETRIES + 1],
    ["non-integer", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects constructor maxRetries that is %s before fetch", (_case, maxRetries) => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(
      () =>
        new AhaSendClient({
          apiKey: "aha-sk-test",
          accountId: "22222222-2222-4222-8222-222222222222",
          fetch: fetchImpl,
          retry: { maxRetries },
        }),
    ).toThrow(/retry\.maxRetries.*safe integer.*0.*20/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
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
    ["rateLimit.standard", { rateLimit: { standard: new Date(0) } }],
    ["hooks", { hooks: new Map() }],
    ["idempotency", { idempotency: new Date(0) }],
  ])("rejects a non-plain %s configuration object", (_name, invalid) => {
    expect(() => resolveConfig({ apiKey: "aha-sk-test", ...invalid } as never)).toThrow(
      /plain object/i,
    );
  });

  it.each(["onRequest", "onResponse", "onRetry", "onError"] as const)(
    "accepts an explicitly undefined hooks.%s member",
    (hookName) => {
      const resolved = resolveConfig({
        apiKey: "aha-sk-test",
        hooks: { [hookName]: undefined },
      } as unknown as ClientOptions);

      expect(resolved.hooks[hookName]).toBeTypeOf("function");
    },
  );

  it("rejects invalid per-request options synchronously before fetch", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "22222222-2222-4222-8222-222222222222",
      fetch: fetchImpl,
    });

    expect(() => client.ping({ headers: { "bad header": "value" } })).toThrow(/header/i);
    expect(() => client.ping({ signal: {} as AbortSignal })).toThrow(/AbortSignal/);
    expect(() => client.ping({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => client.ping({ timeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/timeoutMs/);
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
    "Accept-Charset",
    "ACCEPT-ENCODING",
    "Access-Control-Request-Headers",
    "Access-Control-Request-Method",
    "Authorization",
    "Connection",
    "CONTENT-LENGTH",
    "Content-Type",
    "Cookie",
    "Cookie2",
    "Date",
    "DNT",
    "Expect",
    "Host",
    "IDEMPOTENCY-KEY",
    "Keep-Alive",
    "Origin",
    "Proxy-Authenticate",
    "Proxy-Authorization",
    "Referer",
    "Set-Cookie",
    "TE",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
    "USER-AGENT",
    "Via",
    "Proxy-Custom",
    "Sec-Custom",
  ])("rejects the controlled request header %s before fetch", (header) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "22222222-2222-4222-8222-222222222222",
      fetch: fetchImpl,
    });

    expect(() => client.ping({ headers: { [header]: "override" } })).toThrow(
      /owned|cannot be overridden/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["X-HTTP-Method", "x-http-method-override", "X-Method-Override"])(
    "rejects a forbidden method in the fetch-controlled request header %s before fetch",
    (header) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const client = new AhaSendClient({
        apiKey: "aha-sk-test",
        accountId: "22222222-2222-4222-8222-222222222222",
        fetch: fetchImpl,
      });

      expect(() => client.ping({ headers: { [header]: "POST, TRACE" } })).toThrow(
        /controlled|cannot be overridden/i,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("allows a method-override header whose value is not a forbidden Fetch method", () => {
    const resolved = resolveConfig({
      apiKey: "aha-sk-test",
      defaultHeaders: { "X-HTTP-Method-Override": "POST" },
    });

    expect(resolved.defaultHeaders).toEqual({ "X-HTTP-Method-Override": "POST" });
  });

  it("does not mutate the caller's readonly headers when controlled-header validation fails", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: "22222222-2222-4222-8222-222222222222",
      fetch: fetchImpl,
    });
    const headers: Readonly<Record<string, string>> = {
      Connection: "keep-alive",
      "X-Trace-Id": "trace-1",
    };
    const originalHeaders = { ...headers };

    expect(() => client.ping({ headers })).toThrow(/controlled|cannot be overridden/i);

    expect(headers).toEqual(originalHeaders);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("optionsFromEnv", () => {
  it.each([
    ["optionsFromEnv", () => optionsFromEnv()],
    ["AhaSendClient.fromEnv", () => AhaSendClient.fromEnv()],
  ])("%s reports the missing API key when process is absent", (_name, readEnvironment) => {
    const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
    expect(processDescriptor).toBeDefined();
    Reflect.deleteProperty(globalThis, "process");

    try {
      expect(readEnvironment).toThrow(AhaSendConfigurationError);
      expect(readEnvironment).toThrow(/missing API key.*AHASEND_API_KEY/i);
    } finally {
      Object.defineProperty(globalThis, "process", processDescriptor!);
    }
  });

  it.each([
    [
      "API key",
      {
        AHASEND_API_KEY: "aha-sk-workers",
        AHASEND_ACCOUNT_ID: "22222222-2222-4222-8222-222222222222",
      },
    ],
    [
      "fallback token and optional settings",
      {
        AHASEND_TOKEN: "aha-token-workers",
        AHASEND_ACCOUNT_ID: "33333333-3333-4333-8333-333333333333",
        AHASEND_TIMEOUT: "10",
        AHASEND_DEBUG: "false",
      },
    ],
  ] as const)("AhaSendClient.fromEnv accepts a Workers-style %s record", (_name, env) => {
    const workersEnv: Readonly<Record<string, string>> = env;

    expect(AhaSendClient.fromEnv(workersEnv).accountId).toBe(env.AHASEND_ACCOUNT_ID);
  });

  it.each([
    ["reads AHASEND_API_KEY", { AHASEND_API_KEY: "aha-sk-env" }, "aha-sk-env"],
    ["falls back to AHASEND_TOKEN", { AHASEND_TOKEN: "aha-sk-token" }, "aha-sk-token"],
    [
      "falls back to AHASEND_TOKEN when AHASEND_API_KEY is empty",
      { AHASEND_API_KEY: "", AHASEND_TOKEN: "aha-sk-token" },
      "aha-sk-token",
    ],
    [
      "prefers a non-empty AHASEND_API_KEY",
      { AHASEND_API_KEY: "aha-sk-env", AHASEND_TOKEN: "aha-sk-token" },
      "aha-sk-env",
    ],
  ])("%s", (_case, env, expected) => {
    expect(optionsFromEnv(env).apiKey).toBe(expected);
  });

  it.each([
    ["optionsFromEnv", () => optionsFromEnv({ AHASEND_API_KEY: "", AHASEND_TOKEN: "" })],
    [
      "AhaSendClient.fromEnv",
      () => AhaSendClient.fromEnv({ AHASEND_API_KEY: "", AHASEND_TOKEN: "" }),
    ],
  ])("%s reports the normal missing-credential error", (_name, readEnvironment) => {
    expect(readEnvironment).toThrow(AhaSendConfigurationError);
    expect(readEnvironment).toThrow(/AHASEND_API_KEY/);
  });

  it.each([
    [
      "API key",
      {
        AHASEND_API_KEY: "aha-sk-secret\nmaterial",
        AHASEND_TOKEN: "aha-token-backup-secret",
      },
      ["aha-sk-secret\nmaterial", "aha-token-backup-secret"],
    ],
    [
      "fallback token",
      { AHASEND_API_KEY: "", AHASEND_TOKEN: "aha-token-secret\nmaterial" },
      ["aha-token-secret\nmaterial"],
    ],
  ])("keeps a rejected %s out of credential diagnostics", (_case, env, secrets) => {
    let error: unknown;
    try {
      optionsFromEnv(env);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/HTTP header/);
    for (const diagnostic of renderErrorDiagnostics(error)) {
      for (const secret of secrets) expect(diagnostic).not.toContain(secret);
    }
  });

  it("reads AHASEND_BASE_URL", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_BASE_URL: "https://example.ahasend.com",
    });
    expect(options.baseUrl).toBe("https://example.ahasend.com");
  });

  it("gives AHASEND_BASE_URL precedence over AHASEND_SCHEME and AHASEND_HOST", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_BASE_URL: "https://primary.example.com",
      AHASEND_SCHEME: "http",
      AHASEND_HOST: "ignored.example.com",
    });

    expect(options.baseUrl).toBe("https://primary.example.com");
  });

  it("builds baseUrl from scheme and host when AHASEND_BASE_URL is not set", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_HOST: "localhost:4010",
      AHASEND_SCHEME: "http",
      AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL: "true",
    });
    expect(options.baseUrl).toBe("http://localhost:4010");
  });

  it.each([
    ["explicit true", "true", false],
    ["explicit false", "false", true],
    ["absent", undefined, true],
    ["malformed", "sometimes", true],
  ])("%s controls environment-derived insecure HTTP base URLs", (_case, optIn, shouldReject) => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    const optInEnv =
      optIn === undefined ? {} : { AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL: optIn };
    const construct = () =>
      AhaSendClient.fromEnv({
        AHASEND_API_KEY: "aha-sk-test",
        AHASEND_ACCOUNT_ID: "22222222-2222-4222-8222-222222222222",
        AHASEND_BASE_URL: "http://api.example.com",
        ...optInEnv,
      });

    try {
      if (shouldReject) {
        expect(construct).toThrow(/insecure|boolean|https/i);
      } else {
        expect(construct).not.toThrow();
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["below", "2147482.647", MAX_TIMER_DELAY_MS - 1000],
    ["at", "2147483.647", MAX_TIMER_DELAY_MS],
    ["above", "2147483.648", undefined],
  ])(
    "validates AHASEND_TIMEOUT %s the timer maximum",
    (_position, timeoutSeconds, expectedTimeoutMs) => {
      const readOptions = () =>
        optionsFromEnv({
          AHASEND_API_KEY: "aha-sk-test",
          AHASEND_TIMEOUT: timeoutSeconds,
        });

      if (expectedTimeoutMs === undefined) {
        expect(readOptions).toThrow(/2147483647 milliseconds/);
      } else {
        expect(readOptions().timeoutMs).toBe(expectedTimeoutMs);
      }
    },
  );

  it("rejects AHASEND_TIMEOUT above the timer maximum before fetch", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    try {
      expect(() =>
        AhaSendClient.fromEnv({
          AHASEND_API_KEY: "aha-sk-test",
          AHASEND_ACCOUNT_ID: "22222222-2222-4222-8222-222222222222",
          AHASEND_TIMEOUT: "2147483.648",
        }),
      ).toThrow(/2147483647 milliseconds/);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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

  it.each(["0", String(MAX_RETRIES)])(
    "accepts AHASEND_MAX_RETRIES at the boundary: %s",
    (maxRetries) => {
      expect(
        optionsFromEnv({
          AHASEND_API_KEY: "aha-sk-test",
          AHASEND_MAX_RETRIES: maxRetries,
        }).retry,
      ).toEqual({ maxRetries: Number(maxRetries) });
    },
  );

  it.each([
    ["below range", "-1"],
    ["above range", String(MAX_RETRIES + 1)],
    ["non-integer", "1.5"],
    ["unsafe integer", "9007199254740992"],
  ])("rejects AHASEND_MAX_RETRIES that is %s before fetch", (_case, maxRetries) => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    try {
      expect(() =>
        AhaSendClient.fromEnv({
          AHASEND_API_KEY: "aha-sk-test",
          AHASEND_ACCOUNT_ID: "22222222-2222-4222-8222-222222222222",
          AHASEND_MAX_RETRIES: maxRetries,
        }),
      ).toThrow(/AHASEND_MAX_RETRIES.*safe integer.*0.*20/);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["AHASEND_TIMEOUT", { AHASEND_TIMEOUT: "0" }],
    ["AHASEND_TIMEOUT", { AHASEND_TIMEOUT: "not-a-number" }],
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

  it("uses the Node.js 22 support wording without exposing environment credentials", () => {
    const apiKey = "aha-sk-environment-secret";
    const token = "aha-token-environment-secret";
    vi.stubGlobal("fetch", undefined);

    try {
      let error: unknown;
      try {
        AhaSendClient.fromEnv({
          AHASEND_API_KEY: apiKey,
          AHASEND_TOKEN: token,
          AHASEND_ACCOUNT_ID: "22222222-2222-4222-8222-222222222222",
        });
      } catch (caught) {
        error = caught;
      }

      expect(String(error)).toMatch(/Node\.js 22 or later/);
      for (const diagnostic of renderErrorDiagnostics(error)) {
        expect(diagnostic).not.toContain(apiKey);
        expect(diagnostic).not.toContain(token);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("header snapshot integrity", () => {
  it("stores the value it validated, not one a getter showed it", () => {
    // assertPlainRecord permits accessors, so validating the caller's object
    // and then re-reading it to copy let a getter return one value to the
    // check and another to the store — putting an unvalidated CRLF into a
    // request header. Only the pre-flight Request caught it, and that is now
    // skipped where the runtime has no Request constructor.
    let reads = 0;
    const resolved = resolveConfig({
      apiKey: "aha-sk-test",
      defaultHeaders: {
        get "x-trace"() {
          reads += 1;
          return reads > 1 ? "injected\r\nx-evil: 1" : "safe";
        },
      },
    });

    expect(resolved.defaultHeaders["x-trace"]).toBe("safe");
    expect(reads).toBe(1);
  });

  it("still rejects a header value that cannot appear in a request", () => {
    expect(() =>
      resolveConfig({
        apiKey: "aha-sk-test",
        defaultHeaders: { "x-trace": "bad\r\nx-evil: 1" },
      }),
    ).toThrow(/invalid in an HTTP header/i);
  });
});
