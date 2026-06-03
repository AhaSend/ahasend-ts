import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDEMPOTENCY_CONFIG,
  IdempotencyKeyBuilder,
  generateIdempotencyKey,
  resolveIdempotencyConfig,
} from "../src/idempotency.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("generateIdempotencyKey", () => {
  it("returns a UUID v4 with no prefix by default", () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(UUID_REGEX);
  });

  it("returns a prefixed key with literal concatenation (no separator inserted)", () => {
    const key = generateIdempotencyKey("welcome-");
    // The prefix is prepended literally — caller controls the separator.
    // This avoids the previous "msg-" + "-" + uuid = "msg--<uuid>" bug.
    expect(key.startsWith("welcome-")).toBe(true);
    expect(key.startsWith("welcome--")).toBe(false);
    expect(key.slice("welcome-".length)).toMatch(UUID_REGEX);
  });

  it("ignores empty-string prefix", () => {
    const key = generateIdempotencyKey("");
    expect(key).toMatch(UUID_REGEX);
  });

  it("returns unique keys across calls", () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
  });
});

describe("IdempotencyKeyBuilder", () => {
  it("first next() returns the base key, subsequent calls add a unique suffix", () => {
    const builder = new IdempotencyKeyBuilder("order-123");
    expect(builder.next()).toBe("order-123");
    const second = builder.next();
    expect(second.startsWith("order-123-")).toBe(true);
    expect(second).not.toBe("order-123");
    const third = builder.next();
    expect(third).not.toBe(second);
  });

  it("withSuffix returns a deterministic suffix-appended key", () => {
    const builder = new IdempotencyKeyBuilder("order-123");
    expect(builder.withSuffix("confirmation")).toBe("order-123-confirmation");
    expect(builder.withSuffix("receipt")).toBe("order-123-receipt");
  });

  it("rejects an empty base key", () => {
    expect(() => new IdempotencyKeyBuilder("")).toThrow(/baseKey/);
  });

  it("withSuffix rejects an empty suffix", () => {
    const builder = new IdempotencyKeyBuilder("order-123");
    expect(() => builder.withSuffix("")).toThrow(/suffix/);
  });
});

describe("resolveIdempotencyConfig", () => {
  it("returns defaults when no override is provided", () => {
    expect(resolveIdempotencyConfig()).toEqual(DEFAULT_IDEMPOTENCY_CONFIG);
  });

  it("respects autoGenerate=false", () => {
    expect(resolveIdempotencyConfig({ autoGenerate: false })).toEqual({
      autoGenerate: false,
      prefix: "",
    });
  });

  it("applies a custom prefix", () => {
    expect(resolveIdempotencyConfig({ prefix: "myapp" })).toEqual({
      autoGenerate: true,
      prefix: "myapp",
    });
  });
});
