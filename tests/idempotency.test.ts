import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDEMPOTENCY_CONFIG,
  IdempotencyKeyBuilder,
  assertValidIdempotencyKey,
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

  it.each([" \t ", " leading-"])(
    "rejects a prefix whose leading whitespace would be normalized: %j",
    (prefix) => {
      expect(() => generateIdempotencyKey(prefix)).toThrow(/prefix/);
    },
  );

  it("returns unique keys across calls", () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
  });
});

describe("IdempotencyKeyBuilder", () => {
  it("first next() returns the base key, subsequent calls add full UUID entropy", () => {
    const builder = new IdempotencyKeyBuilder("order-123");
    expect(builder.next()).toBe("order-123");
    const second = builder.next();
    expect(second.startsWith("order-123-")).toBe(true);
    expect(second).not.toBe("order-123");
    expect(second.slice("order-123-".length)).toMatch(UUID_REGEX);
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

  it("rejects whitespace-only builder components", () => {
    expect(() => new IdempotencyKeyBuilder(" \t ")).toThrow(/baseKey/);
    const builder = new IdempotencyKeyBuilder("order-123");
    expect(() => builder.withSuffix(" \t ")).toThrow(/suffix/);
    expect(() => builder.withSuffix("confirmation ")).toThrow(/suffix/);
  });

  it("withSuffix rejects an empty suffix", () => {
    const builder = new IdempotencyKeyBuilder("order-123");
    expect(() => builder.withSuffix("")).toThrow(/suffix/);
  });

  it("enforces the 255-character limit on composed keys", () => {
    const builder = new IdempotencyKeyBuilder("a".repeat(218));
    expect(builder.next()).toHaveLength(218);
    expect(builder.next()).toHaveLength(255);

    expect(() => new IdempotencyKeyBuilder("a".repeat(256))).toThrow(/255/);
    expect(() => new IdempotencyKeyBuilder("a".repeat(219)).next()).not.toThrow();
    const oversized = new IdempotencyKeyBuilder("a".repeat(219));
    oversized.next();
    expect(() => oversized.next()).toThrow(/255/);
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

  it("publishes an immutable default object", () => {
    expect(Object.isFrozen(DEFAULT_IDEMPOTENCY_CONFIG)).toBe(true);
    expect(() => {
      (DEFAULT_IDEMPOTENCY_CONFIG as { autoGenerate: boolean }).autoGenerate = false;
    }).toThrow(TypeError);
    expect(DEFAULT_IDEMPOTENCY_CONFIG.autoGenerate).toBe(true);
  });

  it.each([
    ["non-boolean autoGenerate", { autoGenerate: "yes" }],
    ["non-string prefix", { prefix: 123 }],
    ["oversized prefix", { prefix: "p".repeat(220) }],
    ["header-unsafe prefix", { prefix: "app\n" }],
    ["unknown option", { unknown: true }],
    ["Date instance", new Date(0)],
    ["Map instance", new Map()],
  ])("rejects invalid config: %s", (_name, override) => {
    expect(() => resolveIdempotencyConfig(override as never)).toThrow();
  });
});

describe("idempotency key boundaries", () => {
  it("accepts non-empty keys through the API maximum", () => {
    expect(() => assertValidIdempotencyKey("a")).not.toThrow();
    expect(() => assertValidIdempotencyKey("a".repeat(255))).not.toThrow();
  });

  it.each(["", " \t ", " leading", "trailing\t", "a".repeat(256), "safe\r\ninjected: true"])(
    "rejects an invalid key boundary",
    (key) => {
      expect(() => assertValidIdempotencyKey(key)).toThrow();
    },
  );

  it("preserves UUID entropy at the maximum generated-key boundary", () => {
    const prefix = "p".repeat(219);
    const key = generateIdempotencyKey(prefix);
    expect(key).toHaveLength(255);
    expect(key.slice(prefix.length)).toMatch(UUID_REGEX);
    expect(() => generateIdempotencyKey(`${prefix}p`)).toThrow(/219/);
  });
});
