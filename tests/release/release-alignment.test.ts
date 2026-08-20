import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  changelog.indexOf("## [0.2.1]"),
  changelog.indexOf("## [0.2.0]"),
);

describe("v0.2.1 release source alignment", () => {
  it("pins the package, lockfile, runtime, changelog, and root declaration report", () => {
    expect(packageManifest.name).toBe("@ahasend/sdk");
    expect(packageManifest.version).toBe("0.2.1");
    expect(packageLock.version).toBe("0.2.1");
    expect(packageLock.packages[""]?.version).toBe("0.2.1");
    expect(versionSource).toContain('export const SDK_VERSION = "0.2.1";');
    expect(changelog).toContain("## [0.2.1] — 2026-08-20");
    expect(changelog).not.toContain("## [0.2.1] — Unreleased");
    expect(rootApiReport).toContain('export const SDK_VERSION = "0.2.1";');
  });

  it("documents the additive delivery_attempt surface and claims no breaking change", () => {
    // A patch release must not carry a BREAKING section, and must say plainly
    // that an older client is unaffected — that is the whole basis for shipping
    // this as a patch.
    expect(releaseSection).toContain("### Added");
    expect(releaseSection).not.toContain("### BREAKING");
    expect(releaseSection).toMatch(/a 0\.1\.0 or 0\.2\.0 client ignores the new field/u);

    // The three public names the release announces. Anchored, because
    // `KnownDeliveryAttemptClassification` is a substring of the guard's name
    // and an unanchored check for it can never fail. The published surface is
    // pinned in tests/package.test.ts; this only pins what the release claims.
    for (const name of [
      "WebhookDeliveryAttempt",
      "KnownDeliveryAttemptClassification",
      "isKnownDeliveryAttemptClassification",
    ]) {
      expect(releaseSection, name).toContain("`" + name + "`");
    }
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

  it("uses the v0.2.1 tag in release and recovery commands", () => {
    expect(runbook).toContain("git tag v0.2.1\ngit push origin v0.2.1");
    expect(runbook).toContain("git tag -d v0.2.1 && git push origin :refs/tags/v0.2.1");
    // Any tag that is not this release's is stale, whichever release preceded
    // it — and the push and delete forms count too, not just `git tag`.
    expect(runbook).not.toMatch(/git tag (?:-d )?v(?!0\.2\.1\b)/u);
    expect(runbook).not.toMatch(/git push origin (?::refs\/tags\/)?v(?!0\.2\.1\b)/u);
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

  it("keeps every release.yml line citation in RELEASING.md anchored to what it cites", () => {
    // The runbook cites exact release.yml lines; edits to the workflow shift
    // them silently. Each citation is held to the fragment that makes it
    // meaningful, and the coverage check at the end forces a new citation to
    // be added here rather than drifting unverified.
    const workflowLines = readFileSync(
      resolve(root, ".github/workflows/release.yml"),
      "utf8",
    ).split("\n");
    const lineAt = (lineNumber: number): string => workflowLines[lineNumber - 1] ?? "";
    const verified = new Set<number>();

    // Secrets table: the cited line must consume that secret.
    const secretRows = [...runbook.matchAll(/^\| `(\w+)`\s+\|[^|]*\(release\.yml:([\d, ]+)\)/gmu)];
    expect(secretRows.length).toBeGreaterThanOrEqual(4);
    for (const [, secret, numbers] of secretRows) {
      for (const cited of numbers!.split(",").map((value) => Number(value.trim()))) {
        expect(lineAt(cited), `release.yml:${cited} cited for ${secret}`).toContain(
          `secrets.${secret}`,
        );
        verified.add(cited);
      }
    }

    // Inline citations pin one fact each.
    const provenance = /`npm publish --provenance` \(release\.yml:(\d+)\)/u.exec(runbook);
    expect(provenance).not.toBeNull();
    expect(lineAt(Number(provenance![1]))).toContain("--provenance");
    verified.add(Number(provenance![1]));

    const promotionGate = /`registry-smoke` succeeded \(release\.yml:(\d+)\)/u.exec(runbook);
    expect(promotionGate).not.toBeNull();
    expect(lineAt(Number(promotionGate![1]))).toContain("registry-smoke.result == 'success'");
    verified.add(Number(promotionGate![1]));

    // Every release.yml citation in the runbook must be one of the verified.
    const cited = [...runbook.matchAll(/release\.yml:([\d, ]+)/gu)].flatMap(([, numbers]) =>
      numbers!.split(",").map((value) => Number(value.trim())),
    );
    for (const citation of cited) {
      expect(verified.has(citation), `release.yml:${citation} is cited but unverified`).toBe(true);
    }
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
