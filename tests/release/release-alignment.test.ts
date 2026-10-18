import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly engines: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
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

const releaseSection = changelog.slice(
  changelog.indexOf("## [0.3.0]"),
  changelog.indexOf("## [0.2.1]"),
);

describe("v0.3.0 release source alignment", () => {
  it("pins the package, lockfile, runtime, changelog, and root declaration report", () => {
    expect(packageManifest.name).toBe("@ahasend/sdk");
    expect(packageManifest.version).toBe("0.3.0");
    expect(packageLock.version).toBe("0.3.0");
    expect(packageLock.packages[""]?.version).toBe("0.3.0");
    expect(versionSource).toContain('export const SDK_VERSION = "0.3.0";');
    expect(changelog).toContain("## [0.3.0] — 2026-10-12");
    expect(changelog).not.toContain("## [0.3.0] — Unreleased");
    expect(rootApiReport).toContain('export const SDK_VERSION = "0.3.0";');
  });

  it("announces the new resources and the escaped substitution values", () => {
    expect(releaseSection).toContain("### Added");
    expect(releaseSection).toContain("### Changed");
    for (const name of [
      "client.contacts",
      "client.lists",
      "client.templates",
      "client.campaignTemplates",
      "client.campaigns",
    ]) {
      expect(releaseSection, name).toContain("`" + name + "`");
    }
    expect(releaseSection).toContain("`{{ name|safe }}`");
  });

  it("uses runtime-neutral package wording without changing the Node engine or dependency policy", () => {
    expect(packageManifest.description).toBe(
      "Official TypeScript SDK for the AhaSend transactional email API.",
    );
    expect(packageManifest.description).not.toMatch(/Node(?:\.js)?[- ]only/iu);
    expect(packageManifest.engines.node).toBe(">=22");
    expect(packageManifest.dependencies ?? {}).toEqual({});
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
    expect(webhookApiReport).toContain(
      "parse(headers: WebhookHeadersInput, rawBody: WebhookRawBody): Promise<AnyWebhookEvent>;",
    );
    expect(webhookApiReport).toContain(
      "verify(headers: WebhookHeadersInput, rawBody: WebhookRawBody): Promise<void>;",
    );
    expect(webhookApiReport).toContain("export function expressWebhookHandler");
    expect(webhookApiReport).not.toContain("export class AhaSendClient");
  });

  it("exposes the release validators and maintained runtime gates", () => {
    expect(packageManifest.scripts["test:watch"]).toBe("npm run build && vitest");
    expect(packageManifest.scripts["release:source-gate"]).toBe(
      "node scripts/run-source-gates.mjs",
    );
    expect(packageManifest.scripts["release:candidate"]).toBe("node scripts/create-candidate.mjs");
    expect(packageManifest.scripts["release:live"]).toBe("node scripts/run-live-acceptance.mjs");
    expect(packageManifest.scripts["release:verify"]).toBe(
      "vitest run tests/release tests/version.test.ts tests/contracts.test.ts tests/generation.test.ts",
    );
    expect(packageManifest.scripts["test:conformance:workerd"]).toBe(
      "npm run build && npm run test:conformance:workerd:artifact",
    );
    expect(packageManifest.scripts["test:conformance:workerd:artifact"]).toBe(
      "vitest run --config vitest.workerd.config.ts",
    );
    expect(packageManifest.scripts["test:runtime:deno"]).toBe(
      "node scripts/run-runtime-smoke.mjs deno",
    );
    expect(packageManifest.scripts["test:runtime:bun"]).toBe(
      "node scripts/run-runtime-smoke.mjs bun",
    );
  });

  // The assertions above compare script strings, which cannot tell whether a
  // documented command runs. RELEASING.md told the reader to run
  // `release:source-gate` and `release:candidate` bare; both exit non-zero on a
  // usage error, because they validate artifacts the release workflow produced.
  // These execute what the runbook now says, so the runbook cannot drift again.
  const runbook = readFileSync(resolve(root, "RELEASING.md"), "utf8");

  it("documents only local commands that exist as scripts", () => {
    const section = runbook.slice(
      runbook.indexOf("## Local verification without a release"),
      runbook.indexOf("### The `release:*` artifact validators are not local commands"),
    );
    expect(section).not.toBe("");

    const documented = [...section.matchAll(/^npm run ([\w:]+)/gmu)].map((match) => match[1]!);
    expect(documented).toEqual([
      "ci",
      "release:verify",
      "test:package:preflight",
      "test:conformance:workerd",
      "build",
      "test:runtime:deno",
      "test:runtime:bun",
    ]);
    for (const script of documented) {
      expect(packageManifest.scripts[script], `${script} is documented but not defined`).toBeTypeOf(
        "string",
      );
    }
  });

  it("keeps the runtime gates separate and binds Deno and Bun to one candidate tarball", () => {
    expect(runbook).not.toMatch(/\bsuperset\b/iu);
    expect(runbook).toContain("`npm run ci` is the core gate");
    expect(runbook).toContain("maintained workerd conformance gate separately");

    const runtimeCommands = [
      ...runbook.matchAll(/^npm run (test:runtime:(?:deno|bun)) -- "(\$[A-Z][A-Z_]*)"$/gmu),
    ].map(([, script, tarball]) => ({ script, tarball }));
    expect(runtimeCommands).toEqual([
      { script: "test:runtime:deno", tarball: "$CANDIDATE_TARBALL" },
      { script: "test:runtime:bun", tarball: "$CANDIDATE_TARBALL" },
    ]);
    expect(runbook).toContain('CANDIDATE_TARBALL="$(find "$RUNTIME_SMOKE_DIR"');
  });

  it("uses the v0.3.0 tag in release and recovery commands", () => {
    expect(runbook).toContain("git tag v0.3.0\ngit push origin v0.3.0");
    expect(runbook).toContain("git tag -d v0.3.0 && git push origin :refs/tags/v0.3.0");
    // Any tag that is not this release's is stale, whichever release preceded
    // it — and the push and delete forms count too, not just `git tag`.
    expect(runbook).not.toMatch(/git tag (?:-d )?v(?!0\.3\.0\b)/u);
    expect(runbook).not.toMatch(/git push origin (?::refs\/tags\/)?v(?!0\.3\.0\b)/u);
  });

  it("pins each artifact validator's usage line to the signature the runbook prints", () => {
    // Invoked with no arguments each one must refuse and say how it is called.
    // Running them for real needs a release artifact; refusing correctly is the
    // part a local test can hold, and it is what the runbook's signatures claim.
    const validators = [
      ["scripts/run-source-gates.mjs", "<source-report.json> [source-report.sha256]"],
      [
        "scripts/create-candidate.mjs",
        "<source-report.json> <output-directory> [source-report.sha256]",
      ],
      [
        "scripts/run-live-acceptance.mjs",
        "<candidate-manifest.json> <candidate.tgz> <install-directory> <live-report.json> <live-report.sha256> [candidate-manifest.sha256]",
      ],
    ] as const;

    for (const [script, signature] of validators) {
      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      expect(result.status, `${script} should refuse to run without arguments`).not.toBe(0);

      const usage = `${result.stdout}${result.stderr}`;
      expect(usage).toContain(`Usage: node ${script} ${signature}`);
      // The runbook must print the same argument list it will actually reject.
      expect(runbook, `${script} signature drifted from RELEASING.md`).toContain(signature);
    }
  });

  it("keeps the runbook's secrets and publication claims true to release.yml", () => {
    // The runbook names jobs, not release.yml lines, so an edit to the
    // workflow cannot shift a citation. Each claim is checked against the
    // parsed workflow instead.
    expect(runbook, "cite release.yml jobs, not lines").not.toMatch(/release\.yml:\d/u);
    const workflow = yaml.load(
      readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8"),
      { schema: yaml.JSON_SCHEMA },
    ) as { readonly jobs: Readonly<Record<string, unknown>> };
    const consumers = (secret: string): string[] =>
      Object.entries(workflow.jobs)
        .filter(([, job]) => JSON.stringify(job).includes(`secrets.${secret}`))
        .map(([name]) => name)
        .sort();

    // Secrets table: each secret is consumed by exactly the jobs it lists,
    // and every secret the workflow reads has a row.
    const secretsSection = runbook.slice(
      runbook.indexOf("### Secrets"),
      runbook.indexOf("### `AHASEND_LIVE_CONFIG_JSON`"),
    );
    const rows = [...secretsSection.matchAll(/^\| `([A-Z_]+)`\s+\|([^|]*)\|/gmu)];
    const documented = rows.map(([, secret]) => secret!).sort();
    const used = [
      ...new Set(
        [...JSON.stringify(workflow.jobs).matchAll(/secrets\.([A-Z_]+)/gu)].map(
          ([, secret]) => secret!,
        ),
      ),
    ].sort();
    expect(documented).toEqual(used);
    for (const [, secret, consumedBy] of rows) {
      const listed = [...consumedBy!.matchAll(/`([\w-]+)`/gu)].map(([, job]) => job!).sort();
      expect(listed, `jobs that consume ${secret}`).toEqual(consumers(secret!));
    }

    // next-publish has no NPM_TOKEN: it publishes with provenance.
    expect(runbook).toContain("`npm publish --provenance` with `id-token: write`");
    const publishJob = workflow.jobs["next-publish"] as {
      readonly steps: readonly { readonly run?: string }[];
    };
    const publishLines = publishJob.steps
      .flatMap((step) => (step.run ?? "").split("\n"))
      .filter((line) => line.trim().startsWith("npm publish"));
    expect(publishLines).toHaveLength(1);
    expect(publishLines[0]).toContain("--provenance");

    // latest-promotion runs only after both gates succeeded.
    expect(runbook).toMatch(
      /`latest-promotion`\s+\| Only if `live-gates` \*\*and\*\* `registry-smoke` succeeded\./u,
    );
    const promotion = workflow.jobs["latest-promotion"] as { readonly if?: string };
    expect(promotion.if).toContain("needs.live-gates.result == 'success'");
    expect(promotion.if).toContain("needs.registry-smoke.result == 'success'");
  });

  it("runs the full gate chain before publishing, not a subset of it", () => {
    // `prepublishOnly` is the last gate before the registry. It previously
    // omitted lint and the packed-package preflight, so a publish could skip
    // the fixtures that compile the shipped declarations without @types/node.
    //
    // Split on the chain operator rather than substring-matched: `toContain`
    // on the raw string let "npm run test" be satisfied by
    // "npm run test:package:preflight", so removing the unit-test step was
    // invisible to this test — the exact step it most exists to guard.
    const prepublish = packageManifest.scripts["prepublishOnly"] ?? "";
    const steps = prepublish.split(" && ");
    for (const step of [
      "clean",
      "contracts:check",
      "sdk:check",
      "docs:check",
      "verify:audit",
      "typecheck",
      "lint",
      "test",
      "test:package:preflight",
    ]) {
      expect(steps, `prepublishOnly omits ${step}`).toContain(`npm run ${step}`);
    }
  });
});
