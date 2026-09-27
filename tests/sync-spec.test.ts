import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../scripts/generate-contracts.mjs";
import {
  DEFAULT_SPEC_REF,
  describeUnmappedContract,
  GENERATOR_SCRIPTS,
  parseSyncArguments,
  SPEC_REPOSITORY,
} from "../scripts/sync-spec.mjs";

type JsonRecord = Record<string, unknown>;

const repositoryRoot = process.cwd();
const source = readFileSync(resolve(repositoryRoot, "scripts/sync-spec.mjs"), "utf8");
const document = parseOpenApi(
  readFileSync(resolve(repositoryRoot, "openapi.yaml"), "utf8"),
) as JsonRecord;
const lock = JSON.parse(readFileSync(resolve(repositoryRoot, "contracts.lock.json"), "utf8")) as {
  inventories: Record<string, string[]>;
};

function paths(value: JsonRecord): Record<string, JsonRecord> {
  return value["paths"] as Record<string, JsonRecord>;
}

describe("spec sync", () => {
  it("downloads the API repository's devel spec unless another ref is named", () => {
    expect(SPEC_REPOSITORY).toBe("AhaSend/AhaSend");
    expect(parseSyncArguments([])).toEqual({ ref: DEFAULT_SPEC_REF });
    expect(DEFAULT_SPEC_REF).toBe("devel");
    expect(parseSyncArguments(["--ref", "fix/branch"])).toEqual({ ref: "fix/branch" });
    for (const invalid of [["--ref"], ["--ref", " "], ["devel"], ["--ref", "a", "b"]]) {
      expect(() => parseSyncArguments(invalid), JSON.stringify(invalid)).toThrow(/Usage/);
    }
  });

  it("runs gh and the generators as argument arrays, never through a shell", () => {
    expect(source).toContain('"gh",');
    expect(source).toContain('"Accept: application/vnd.github.raw"');
    expect(source).toContain("encodeURIComponent(ref)");
    expect(source).not.toMatch(/\bexec\(|execSync|shell:\s*true/u);
  });

  it("regenerates in the order a spec change needs", () => {
    expect(GENERATOR_SCRIPTS).toEqual([
      "scripts/generate-sdk.mjs",
      "scripts/generate-contracts.mjs",
      "scripts/generate-sdk.mjs",
      "scripts/generate-docs.mjs",
    ]);
  });

  it("reports nothing for the committed spec", () => {
    expect(describeUnmappedContract(document, lock)).toEqual([]);
  });

  it("names a new operation's missing mapping, sample, and inventory entry", () => {
    const changed = structuredClone(document);
    const ping = paths(changed)["/v2/ping"]!;
    ping["head"] = { ...structuredClone(ping["get"] as JsonRecord), operationId: "headPing" };

    const problems = describeUnmappedContract(changed, lock);

    expect(problems).toEqual([
      "operations without a facade mapping in scripts/generate-sdk.mjs: headPing",
      "operations without a Node sample in scripts/node-code-samples.mjs: headPing",
      'contracts.lock.json operationIds drift: added ["headPing"], removed []',
    ]);
  });

  it("names mappings whose operation the spec dropped", () => {
    const changed = structuredClone(document);
    delete paths(changed)["/v2/accounts/{account_id}/contacts/{id_or_email}/lists"];

    const problems = describeUnmappedContract(changed, lock);

    expect(problems).toContain("mappings for operations the spec no longer has: getContactLists");
    expect(problems).toContain(
      'contracts.lock.json operationIds drift: added [], removed ["getContactLists"]',
    );
  });
});
