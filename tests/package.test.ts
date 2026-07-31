import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { digestJsonArtifact } from "../scripts/digest-artifact.mjs";

type RootModule = typeof import("../src/index.js");
type WebhooksModule = typeof import("../src/webhooks/index.js");

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly files: PackFile[];
}

type PackOutput = PackResult[] | Readonly<Record<string, PackResult>>;

const repositoryRoot = process.cwd();
const distDirectory = resolve(repositoryRoot, "dist");
const require = createRequire(import.meta.url);
let esmRoot: RootModule;
let esmWebhooks: WebhooksModule;
let cjsRoot: RootModule;
let cjsWebhooks: WebhooksModule;

function runtimeFiles(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeFiles(join(directory, entry.name), relativePath));
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".cjs")) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function parsePackOutput(output: string): readonly PackResult[] {
  const parsed = JSON.parse(output) as PackOutput;
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

beforeAll(async () => {
  const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);

  esmRoot = (await import(pathToFileURL(resolve(distDirectory, "index.js")).href)) as RootModule;
  esmWebhooks = (await import(
    pathToFileURL(resolve(distDirectory, "webhooks/index.js")).href
  )) as WebhooksModule;
  cjsRoot = require(resolve(distDirectory, "index.cjs")) as RootModule;
  cjsWebhooks = require(resolve(distDirectory, "webhooks/index.cjs")) as WebhooksModule;
});

describe("npm pack output compatibility", () => {
  it.each([
    ["npm 10/11 array output", [{ files: [{ path: "array-package.tgz" }] }], "array-package.tgz"],
    [
      "npm 12 keyed-object output",
      { "@ahasend/sdk": { files: [{ path: "keyed-package.tgz" }] } },
      "keyed-package.tgz",
    ],
  ])("accepts %s", (_label, output, expectedPath) => {
    const [manifest] = parsePackOutput(JSON.stringify(output));
    expect(manifest?.files[0]?.path).toBe(expectedPath);
  });
});

describe("built package topology", () => {
  it("targets Node 22 and exposes only the supported package entries", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as {
      engines: { node: string };
      exports: Record<string, unknown>;
    };

    expect(packageJson.engines.node).toBe(">=22");
    expect(Object.keys(packageJson.exports)).toEqual([".", "./webhooks", "./package.json"]);
  });

  it("keeps exactly one shared error runtime per module format", () => {
    expect(runtimeFiles(distDirectory)).toEqual([
      "_internal/errors.cjs",
      "_internal/errors.js",
      "index.cjs",
      "index.js",
      join("webhooks", "index.cjs"),
      join("webhooks", "index.js"),
    ]);

    const esmErrorRuntime = readFileSync(resolve(distDirectory, "_internal/errors.js"), "utf8");
    const cjsErrorRuntime = readFileSync(resolve(distDirectory, "_internal/errors.cjs"), "utf8");
    expect(esmErrorRuntime).toContain('Symbol.for("@ahasend/sdk.error")');
    expect(cjsErrorRuntime).toContain('Symbol.for("@ahasend/sdk.error")');

    for (const entry of ["index.js", "webhooks/index.js", "index.cjs", "webhooks/index.cjs"]) {
      expect(readFileSync(resolve(distDirectory, entry), "utf8"), entry).not.toContain(
        'Symbol.for("@ahasend/sdk.error")',
      );
    }
  });

  it("shares constructors within each format and brands errors across mixed graphs", () => {
    const esmWebhookError = new esmWebhooks.AhaSendWebhookVerificationError("signature_mismatch");
    const cjsWebhookError = new cjsWebhooks.AhaSendWebhookVerificationError("signature_mismatch");

    expect(esmWebhookError).toBeInstanceOf(esmRoot.AhaSendError);
    expect(cjsWebhookError).toBeInstanceOf(cjsRoot.AhaSendError);
    expect(() => new esmWebhooks.WebhookVerifier("")).toThrow(esmRoot.AhaSendConfigurationError);
    expect(() => new cjsWebhooks.WebhookVerifier("")).toThrow(cjsRoot.AhaSendConfigurationError);

    expect(esmRoot.AhaSendError).not.toBe(cjsRoot.AhaSendError);
    expect(cjsRoot.isAhaSendError(esmWebhookError)).toBe(true);
    expect(esmRoot.isAhaSendError(cjsWebhookError)).toBe(true);
  });

  it("keeps webhook signing and test-clock facilities out of both public module formats", () => {
    for (const webhooks of [esmWebhooks, cjsWebhooks]) {
      expect(webhooks).not.toHaveProperty("createWebhookVerifierWithClock");
      expect(webhooks).not.toHaveProperty("sign");
    }
  });

  it("copies the operation profile and detached digest byte-for-byte", () => {
    const sourceProfile = readFileSync(
      resolve(repositoryRoot, "src/generated/operation-profile.json"),
    );
    const sourceDigest = readFileSync(
      resolve(repositoryRoot, "src/generated/operation-profile.sha256"),
    );
    const packagedProfile = readFileSync(
      resolve(distDirectory, "_metadata/operation-profile.json"),
    );
    const packagedDigest = readFileSync(
      resolve(distDirectory, "_metadata/operation-profile.sha256"),
    );

    expect(packagedProfile).toEqual(sourceProfile);
    expect(packagedDigest).toEqual(sourceDigest);
    expect(packagedDigest.toString("utf8")).toBe(
      `${digestJsonArtifact(JSON.parse(packagedProfile.toString("utf8")))}\n`,
    );
  });

  it("packs private runtimes and metadata without exporting their subpaths", () => {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = spawnSync(npmCommand, ["pack", "--ignore-scripts", "--dry-run", "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(packed.status, `${packed.stdout}${packed.stderr}`).toBe(0);

    const manifests = parsePackOutput(packed.stdout);
    expect(manifests).toHaveLength(1);
    const [manifest] = manifests;
    expect(manifest).toBeDefined();
    const paths = manifest!.files.map(({ path }) => path);
    expect(paths).toContain("dist/_internal/errors.js");
    expect(paths).toContain("dist/_internal/errors.cjs");
    expect(paths).toContain("dist/_metadata/operation-profile.json");
    expect(paths).toContain("dist/_metadata/operation-profile.sha256");
    expect(paths).not.toContain("src/generated/operation-profile.json");

    for (const specifier of [
      "@ahasend/sdk/_internal/errors",
      "@ahasend/sdk/_metadata/operation-profile.json",
    ]) {
      const privateImport = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
        },
      );
      expect(privateImport.status).not.toBe(0);
      expect(privateImport.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    }
  });
});
