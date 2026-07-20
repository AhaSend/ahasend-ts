import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  digestArtifactFile,
  digestJsonArtifact,
  digestYamlArtifact,
  sha256Hex,
} from "../scripts/digest-artifact.mjs";
import cases from "./fixtures/digests/artifact-cases.json";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("canonical artifact digests", () => {
  for (const testCase of cases.valid) {
    it(`matches the fixed vector: ${testCase.name}`, () => {
      const canonical = canonicalizeJson(testCase.value);

      expect(canonical).toEqual(Buffer.from(testCase.canonical, "utf8"));
      expect(digestJsonArtifact(testCase.value)).toBe(testCase.sha256);
    });
  }

  for (const testCase of cases.rejections) {
    it(`rejects the fixed vector: ${testCase.name}`, () => {
      const value: unknown = JSON.parse(testCase.source);

      expect(() => canonicalizeJson(value)).toThrow(testCase.error);
    });
  }

  it("rejects self-digest fields at any object depth", () => {
    expect(() => canonicalizeJson({ metadata: { digest: "pending" } })).toThrow(/self-digest/);
  });

  it("emits UTF-8 JCS bytes without a BOM or trailing newline", () => {
    const canonical = canonicalizeJson({ unicode: "€", negativeZero: -0 });

    expect(canonical.toString("utf8")).toBe('{"negativeZero":0,"unicode":"€"}');
    expect(canonical.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(canonical.at(-1)).not.toBe(0x0a);
  });

  it("rejects values outside the I-JSON data model", () => {
    expect(() => canonicalizeJson({ value: undefined })).toThrow(/undefined/);
    expect(() => canonicalizeJson({ value: "\ud800" })).toThrow(/lone surrogate/);
    expect(() => canonicalizeJson([, 1])).toThrow(/sparse array/);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(/cyclic/);
  });

  it("returns detached lowercase SHA-256 values", () => {
    expect(sha256Hex(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(digestJsonArtifact({ digestible: true })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes exact UTF-8 YAML bytes, including their final newline", () => {
    const withoutNewline = Buffer.from("name: artifact", "utf8");
    const withNewline = Buffer.from("name: artifact\n", "utf8");

    expect(digestYamlArtifact(withNewline)).toBe(
      createHash("sha256").update(withNewline).digest("hex"),
    );
    expect(digestYamlArtifact(withNewline)).not.toBe(digestYamlArtifact(withoutNewline));
    expect(() => digestYamlArtifact(Buffer.from([0xff]))).toThrow();
  });

  it("selects canonical JSON or exact YAML hashing by file extension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ahasend-digest-"));
    temporaryDirectories.push(directory);
    const jsonPath = join(directory, "artifact.json");
    const yamlPath = join(directory, "artifact.yaml");
    await writeFile(jsonPath, '{ "z": 2, "a": 1 }\n', "utf8");
    await writeFile(yamlPath, "z: 2\na: 1\n", "utf8");

    await expect(digestArtifactFile(jsonPath)).resolves.toBe(digestJsonArtifact({ z: 2, a: 1 }));
    await expect(digestArtifactFile(yamlPath)).resolves.toBe(
      sha256Hex(Buffer.from("z: 2\na: 1\n", "utf8")),
    );
  });
});
