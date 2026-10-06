import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseOpenApi } from "../scripts/generate-contracts.mjs";
import {
  DEFAULT_SPEC_REF,
  describeUnmappedContract,
  GENERATOR_SCRIPTS,
  parseSyncArguments,
  SPEC_FILES,
  SPEC_REPOSITORY,
  syncSpec,
  writeSpecFiles,
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

const openApiSource = readFileSync(resolve(repositoryRoot, "openapi.yaml"), "utf8");
const webhookSource = readFileSync(resolve(repositoryRoot, "webhooks.yaml"), "utf8");

function syncSteps(calls: string[], sources: { openapi?: string; webhooks?: string | Error } = {}) {
  return {
    download: vi.fn(async (file: string) => {
      calls.push(`download:${file}`);
      if (file === "openapi.yaml") return sources.openapi ?? openApiSource;
      const webhooks = sources.webhooks ?? webhookSource;
      if (webhooks instanceof Error) throw webhooks;
      return webhooks;
    }),
    readLock: vi.fn(async () => lock),
    writeFiles: vi.fn(async (_sources: ReadonlyMap<string, string>) => {
      calls.push("writeFiles");
    }),
    generate: vi.fn(async () => {
      calls.push("generate");
    }),
  };
}

function paths(value: JsonRecord): Record<string, JsonRecord> {
  return value["paths"] as Record<string, JsonRecord>;
}

describe("spec sync", () => {
  it("downloads the API repository's master spec unless another ref is named", () => {
    expect(SPEC_REPOSITORY).toBe("AhaSend/AhaSend");
    expect(parseSyncArguments([])).toEqual({ ref: DEFAULT_SPEC_REF });
    expect(DEFAULT_SPEC_REF).toBe("master");
    expect(parseSyncArguments(["--ref", "devel"])).toEqual({ ref: "devel" });
    for (const invalid of [["--ref"], ["--ref", " "], ["devel"], ["--ref", "a", "b"]]) {
      expect(() => parseSyncArguments(invalid), JSON.stringify(invalid)).toThrow(/Usage/);
    }
  });

  it("copies openapi.yaml and webhooks.yaml from the same ref, then generates", async () => {
    const calls: string[] = [];
    const steps = syncSteps(calls);
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await syncSpec({ ref: "devel" }, steps).finally(() => output.mockRestore());

    expect(SPEC_FILES).toEqual(["openapi.yaml", "webhooks.yaml"]);
    expect(steps.download.mock.calls).toEqual([
      ["openapi.yaml", "devel"],
      ["webhooks.yaml", "devel"],
    ]);
    expect(steps.writeFiles).toHaveBeenCalledOnce();
    expect([...steps.writeFiles.mock.calls[0]![0]]).toEqual([
      ["openapi.yaml", openApiSource],
      ["webhooks.yaml", webhookSource],
    ]);
    expect(calls.slice(-2)).toEqual(["writeFiles", "generate"]);
  });

  it.each([
    ["the second download fails", { webhooks: new Error("gh: Not Found (HTTP 404)") }],
    ["webhooks.yaml does not parse", { webhooks: "webhooks: [\n" }],
    [
      "webhooks.yaml breaks the webhook contract",
      { webhooks: webhookSource.replace("enum: [message.routing]", "enum: [route.message]") },
    ],
    [
      "openapi.yaml adds an operation the repository does not map",
      {
        openapi: openApiSource.replace(
          "operationId: unpauseSubAccountDomain",
          "operationId: unpauseSubAccountDomainLater",
        ),
      },
    ],
  ])("writes neither file and generates nothing when %s", async (_case, sources) => {
    const calls: string[] = [];
    const steps = syncSteps(calls, sources);

    await expect(syncSpec({ ref: "master" }, steps)).rejects.toThrow();

    expect(steps.download).toHaveBeenCalledTimes(2);
    expect(steps.writeFiles).not.toHaveBeenCalled();
    expect(steps.generate).not.toHaveBeenCalled();
  });

  it("stages both files before renaming either into place", async () => {
    const root = mkdtempSync(join(tmpdir(), "ahasend-sync-spec-"));
    try {
      writeFileSync(join(root, "openapi.yaml"), "old openapi\n");
      writeFileSync(join(root, "webhooks.yaml"), "old webhooks\n");

      await writeSpecFiles(
        new Map([
          ["openapi.yaml", "new openapi\n"],
          ["webhooks.yaml", "new webhooks\n"],
        ]),
        root,
      );
      expect(readFileSync(join(root, "openapi.yaml"), "utf8")).toBe("new openapi\n");
      expect(readFileSync(join(root, "webhooks.yaml"), "utf8")).toBe("new webhooks\n");
      expect(readdirSync(root).sort()).toEqual(["openapi.yaml", "webhooks.yaml"]);

      // A directory where the second staged file goes makes its write fail.
      mkdirSync(join(root, "webhooks.yaml.sync-tmp"));
      await expect(
        writeSpecFiles(
          new Map([
            ["openapi.yaml", "newer openapi\n"],
            ["webhooks.yaml", "newer webhooks\n"],
          ]),
          root,
        ),
      ).rejects.toThrow();
      expect(readFileSync(join(root, "openapi.yaml"), "utf8")).toBe("new openapi\n");
      expect(readFileSync(join(root, "webhooks.yaml"), "utf8")).toBe("new webhooks\n");
      expect(readdirSync(root)).not.toContain("openapi.yaml.sync-tmp");
    } finally {
      rmSync(root, { recursive: true, force: true });
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
