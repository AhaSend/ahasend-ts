import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, optionsFromEnv, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("requires an apiKey", () => {
    expect(() => resolveConfig({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("applies defaults for baseUrl, timeout, and userAgent", () => {
    const resolved = resolveConfig({ apiKey: "aha-sk-test" });
    expect(resolved.apiKey).toBe("aha-sk-test");
    expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(resolved.timeout).toBe(30_000);
    expect(resolved.userAgent).toMatch(/^ahasend-node\//);
    expect(resolved.debug).toBe(false);
    expect(typeof resolved.fetch).toBe("function");
  });

  it("strips trailing slashes from baseUrl", () => {
    const resolved = resolveConfig({ apiKey: "aha-sk-test", baseUrl: "https://api.example.com///" });
    expect(resolved.baseUrl).toBe("https://api.example.com");
  });

  it("uses an injected fetch when provided", () => {
    const mockFetch = (async () => new Response("ok")) as typeof fetch;
    const resolved = resolveConfig({ apiKey: "aha-sk-test", fetch: mockFetch });
    expect(resolved.fetch).toBe(mockFetch);
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
      AHASEND_HOST: "api.example.com",
      AHASEND_SCHEME: "http",
    });
    expect(options.baseUrl).toBe("http://api.example.com");
  });

  it("converts AHASEND_TIMEOUT seconds to milliseconds", () => {
    const options = optionsFromEnv({
      AHASEND_API_KEY: "aha-sk-test",
      AHASEND_TIMEOUT: "5",
    });
    expect(options.timeout).toBe(5000);
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
});
