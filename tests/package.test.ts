import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { assertNoNodeSpecifiers } from "../scripts/assert-no-node-specifiers.mjs";
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
const apiExtractorManifestPath = require.resolve("@microsoft/api-extractor/package.json");
const apiExtractorManifest = JSON.parse(readFileSync(apiExtractorManifestPath, "utf8")) as {
  readonly bin: Readonly<Record<string, string>>;
};
const apiExtractorBin = apiExtractorManifest.bin["api-extractor"];
if (apiExtractorBin === undefined) {
  throw new TypeError("@microsoft/api-extractor does not declare its api-extractor executable.");
}
const apiExtractorExecutable = resolve(dirname(apiExtractorManifestPath), apiExtractorBin);
const webhookRuntimeExports = [
  "AhaSendWebhookVerificationError",
  "DEFAULT_TOLERANCE_SECONDS",
  "MAX_WEBHOOK_BODY_BYTES",
  "WEBHOOK_ID_HEADER",
  "WEBHOOK_SIGNATURE_HEADER",
  "WEBHOOK_TIMESTAMP_HEADER",
  "WebhookVerifier",
  "expressWebhookHandler",
  "fastifyWebhookHandler",
  "isKnownWebhookEvent",
  "isKnownWebhookEventType",
  "nextRouteHandler",
];
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

function generatedArtifacts(
  directory: string,
  prefix = "dist",
  artifacts = new Map<string, Buffer>(),
): ReadonlyMap<string, Buffer> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      generatedArtifacts(absolutePath, relativePath, artifacts);
    } else if (entry.isFile()) {
      artifacts.set(relativePath, readFileSync(absolutePath));
    }
  }
  return artifacts;
}

function parsePackOutput(output: string): readonly PackResult[] {
  const parsed = JSON.parse(output) as PackOutput;
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

describe("published artifact Node.js specifiers", () => {
  const cleanArtifacts = new Map<string, Buffer>([
    ["dist/index.js", Buffer.from("export const sdk = true;\n")],
    ["dist/index.cjs", Buffer.from('"use strict";\nexports.sdk = true;\n')],
    ["dist/index.d.ts", Buffer.from("export declare const sdk: true;\n")],
    ["dist/errors-clean.d.cts", Buffer.from("export declare class SDKError extends Error {}\n")],
    ["dist/index.js.map", Buffer.from('{"version":3,"sources":[]}\n')],
    ["README.md", Buffer.from("Use node:crypto only in application code.\n")],
    ["CHANGELOG.md", Buffer.from("Removed the node:buffer dependency.\n")],
  ]);

  it.each([
    ["ESM runtime", "dist/index.js", 'import "node:crypto";\n'],
    ["CommonJS runtime", "dist/index.cjs", 'require("node:buffer");\n'],
    ["declaration entry", "dist/index.d.ts", 'import type { Buffer } from "node:buffer";\n'],
    [
      "declaration chunk",
      "dist/errors-clean.d.cts",
      'import type { InspectOptions } from "node:util";\n',
    ],
    [
      "source map",
      "dist/index.js.map",
      '{"version":3,"sourcesContent":["import \\"node:stream\\";"]}\n',
    ],
  ])("rejects synthetic %s contamination", (_label, path, contamination) => {
    const contaminatedArtifacts = new Map(cleanArtifacts);
    contaminatedArtifacts.set(path, Buffer.from(contamination));

    expect(() => assertNoNodeSpecifiers(contaminatedArtifacts)).toThrow(path);
  });

  it("reports every contaminated generated artifact and ignores package prose", () => {
    const contaminatedArtifacts = new Map(cleanArtifacts);
    contaminatedArtifacts.set("dist/index.js", Buffer.from('import "node:crypto";\n'));
    contaminatedArtifacts.set(
      "dist/webhooks/index.d.cts",
      Buffer.from('export { EventEmitter } from "node:events";\n'),
    );

    expect(() => assertNoNodeSpecifiers(contaminatedArtifacts)).toThrowError(
      new TypeError(
        "Generated artifacts contain forbidden Node.js specifiers:\n" +
          "- dist/index.js\n" +
          "- dist/webhooks/index.d.cts",
      ),
    );
  });
});

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
  it("targets Node 22 with no runtime dependencies or extra package conditions", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as {
      engines: { node: string };
      exports: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };

    expect(packageJson.engines.node).toBe(">=22");
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.exports).toEqual({
      ".": {
        import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
        require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
      },
      "./webhooks": {
        import: { types: "./dist/webhooks/index.d.ts", default: "./dist/webhooks/index.js" },
        require: {
          types: "./dist/webhooks/index.d.cts",
          default: "./dist/webhooks/index.cjs",
        },
      },
      "./package.json": "./package.json",
    });
  });

  it("passes the artifact scanner with the complete clean build", () => {
    expect(() => assertNoNodeSpecifiers(generatedArtifacts(distDirectory))).not.toThrow();
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

  it("extracts a warning-free curated root declaration report", () => {
    const config = JSON.parse(
      readFileSync(resolve(repositoryRoot, "config/api-extractor.json"), "utf8"),
    ) as {
      readonly apiReport: { readonly includeForgottenExports: boolean };
      readonly messages: {
        readonly extractorMessageReporting: Readonly<
          Record<string, { readonly logLevel: string; readonly addToApiReportFile?: boolean }>
        >;
      };
    };
    expect(config.apiReport.includeForgottenExports).toBe(false);
    expect(config.messages.extractorMessageReporting["ae-forgotten-export"]).toEqual({
      logLevel: "error",
      addToApiReportFile: false,
    });

    const extraction = spawnSync(
      process.execPath,
      [apiExtractorExecutable, "run", "--config", "config/api-extractor.json"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const output = `${extraction.stdout}${extraction.stderr}`;
    expect(extraction.status, output).toBe(0);
    expect(output).not.toContain("ae-forgotten-export");

    const report = readFileSync(resolve(repositoryRoot, "etc/ahasend-sdk.api.md"), "utf8");
    expect(report).toContain("export class AhaSendClient");
    expect(report).toContain("export interface MessagesClient");
    expect(report).not.toContain("Warning:");
    for (const internal of [
      "APIErrorParams",
      "ClientImplementation",
      "HttpClient",
      "IdempotencyOperationPolicy",
      "OperationExecutor",
      "OperationId",
      "OPERATION_DESCRIPTORS",
      "ResolvedClientConfig",
      "RetryMode",
      "SerializedAhaSendClient",
      "typeof REDACTED",
    ]) {
      expect(report).not.toContain(internal);
    }
    expect(report).not.toMatch(/\b(?:declare )?const REDACTED\b/u);
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
      expect(Object.keys(webhooks).sort()).toEqual(webhookRuntimeExports);
      expect(webhooks).not.toHaveProperty("createWebhookVerifierWithClock");
      expect(webhooks).not.toHaveProperty("fetchWebhookHandler");
      expect(webhooks).not.toHaveProperty("sign");
    }

    const webhookReport = readFileSync(
      resolve(repositoryRoot, "etc/ahasend-sdk-webhooks.api.md"),
      "utf8",
    );
    for (const adapter of [
      "expressWebhookHandler",
      "fastifyWebhookHandler",
      "nextRouteHandler",
    ]) {
      expect(webhookReport).toContain(`// @public\nexport function ${adapter}`);
    }
    expect(webhookReport).not.toContain("fetchWebhookHandler");
    expect(webhookReport).not.toContain("FetchHandler");
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
