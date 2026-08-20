import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, SDK_VERSION } from "../src/version.js";

describe("SDK_VERSION", () => {
  it("pins 0.2.1 and matches package.json#version (bump both together)", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8")) as {
      version: string;
    };
    expect(SDK_VERSION).toBe("0.2.1");
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("User-Agent embeds the version", () => {
    expect(DEFAULT_USER_AGENT).toBe(`ahasend-node/${SDK_VERSION}`);
  });
});
