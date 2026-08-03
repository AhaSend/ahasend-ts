import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly scripts: Readonly<Record<string, string>>;
}

interface PackageLock {
  readonly version: string;
  readonly packages: Readonly<Record<string, { readonly version?: string }>>;
}

const root = process.cwd();
const packageManifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as PackageManifest;
const packageLock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
) as PackageLock;
const versionSource = readFileSync(resolve(root, "src/version.ts"), "utf8");
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const rootApiReport = readFileSync(resolve(root, "etc/ahasend-sdk.api.md"), "utf8");
const webhookApiReport = readFileSync(resolve(root, "etc/ahasend-sdk-webhooks.api.md"), "utf8");

describe("v0.1.0 release source alignment", () => {
  it("pins the package, lockfile, runtime, changelog, and root declaration report", () => {
    expect(packageManifest.name).toBe("@ahasend/sdk");
    expect(packageManifest.version).toBe("0.1.0");
    expect(packageLock.version).toBe("0.1.0");
    expect(packageLock.packages[""]?.version).toBe("0.1.0");
    expect(versionSource).toContain('export const SDK_VERSION = "0.1.0";');
    expect(changelog).toContain("## [0.1.0] — 2026-07-25");
    expect(changelog).not.toContain("## [0.1.0] — Unreleased");
    expect(rootApiReport).toContain('export const SDK_VERSION = "0.1.0";');
  });

  it("retains the reviewed cursor-exclusive pagination declarations", () => {
    expect(rootApiReport).toContain("export interface PaginatedResponse<T>");
    // Optional members admit `undefined` so a `string | undefined` cursor can be
    // threaded through the documented pagination loop under
    // `exactOptionalPropertyTypes`; the cursors stay mutually exclusive.
    expect(rootApiReport).toMatch(
      /export type PaginationParams = Readonly<\{\s+limit\?: number \| undefined;\s+\} & \(\{\s+after\?: string \| undefined;\s+before\?: never;\s+\} \| \{\s+after\?: never;\s+before\?: string \| undefined;\s+\}\)>;/u,
    );
    expect(rootApiReport).toContain(
      "iterate(params?: ListMessagesParams, options?: RequestOptions): AsyncGenerator<MessageSummary, void, undefined>;",
    );
  });

  it("keeps the root and webhook reports on their approved entry-point boundaries", () => {
    expect(rootApiReport).toContain('## API Report File for "@ahasend/sdk"');
    expect(rootApiReport).not.toContain("export class WebhookVerifier");
    expect(webhookApiReport).toContain('## API Report File for "@ahasend/sdk"');
    expect(webhookApiReport).toContain("export class WebhookVerifier");
    expect(webhookApiReport).toContain("export function expressWebhookHandler");
    expect(webhookApiReport).not.toContain("export class AhaSendClient");
  });

  it("exposes the tested source, candidate, live, and aggregate release validators", () => {
    expect(packageManifest.scripts["release:source-gate"]).toBe(
      "node scripts/run-source-gates.mjs",
    );
    expect(packageManifest.scripts["release:candidate"]).toBe("node scripts/create-candidate.mjs");
    expect(packageManifest.scripts["release:live"]).toBe("node scripts/run-live-acceptance.mjs");
    expect(packageManifest.scripts["release:verify"]).toBe(
      "vitest run tests/release tests/version.test.ts tests/contracts.test.ts tests/generation.test.ts",
    );
  });
});
