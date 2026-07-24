import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Ajv from "ajv";
import { afterAll, describe, expect, it, vi } from "vitest";
import { canonicalizeJson, digestJsonArtifact, sha256Hex } from "../../scripts/digest-artifact.mjs";
import {
  createCleanupRegistry,
  createLiveReport,
  createScenarioRegistry,
  inspectLiveCandidate,
  installLiveCandidate,
  loadLiveCandidate,
  runWithCleanup,
  validateLiveReportArtifacts,
  validatePackagedLiveProfile,
  writeLiveReport,
  type LiveCandidate,
  type LiveCandidateManifest,
  type LiveProfile,
} from "../../scripts/live-acceptance.mjs";
import liveReportSchema from "../../scripts/live-report.schema.json";

interface OperationProfileSource {
  version: number;
  operations: Array<{ operationId: string; facade: string; method: string }>;
  iterators: Array<{ operationId: string; facade: string; method: string }>;
}

const repositoryRoot = process.cwd();
const profileFixture = JSON.parse(
  readFileSync(resolve(repositoryRoot, "src/generated/operation-profile.json"), "utf8"),
) as OperationProfileSource;
const temporaryDirectories: string[] = [];
const zeroHash = "0".repeat(64);

function profileArtifacts(profile: OperationProfileSource = profileFixture) {
  const source = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`, "utf8");
  const digest = digestJsonArtifact(profile);
  return { source, digest, sidecar: Buffer.from(`${digest}\n`, "utf8") };
}

function manifestFor(tarball: Buffer, profileSha256: string): LiveCandidateManifest {
  return {
    version: 1,
    commit: "1".repeat(40),
    sourceReportSha256: "2".repeat(64),
    contractSha256: {
      "contracts.lock.json": "3".repeat(64),
      "openapi.yaml": "4".repeat(64),
      "webhooks.yaml": "5".repeat(64),
    },
    captureSha256: "6".repeat(64),
    keysSha256: {
      "contracts/webhooks/captured/keys/configured-webhook.key": "7".repeat(64),
      "contracts/webhooks/captured/keys/route.key": "8".repeat(64),
    },
    rendererReportSha256: "9".repeat(64),
    profileSha256,
    tarballSha256: sha256Hex(tarball),
  };
}

function candidateArtifacts() {
  const tarball = Buffer.from("verified candidate tarball fixture", "utf8");
  const profile = profileArtifacts();
  const manifest = manifestFor(tarball, profile.digest);
  const manifestSource = canonicalizeJson(manifest);
  const manifestSidecar = Buffer.from(`${sha256Hex(manifestSource)}\n`, "utf8");
  const packageManifestSource = canonicalizeJson({
    name: "@ahasend/sdk",
    version: "0.1.0-live-test",
  });
  return {
    tarball,
    profile,
    manifest,
    manifestSource,
    manifestSidecar,
    packageManifestSource,
  };
}

function inspectFixture(): LiveCandidate {
  const fixture = candidateArtifacts();
  return inspectLiveCandidate({
    manifestSource: fixture.manifestSource,
    manifestSidecar: fixture.manifestSidecar,
    tarballSource: fixture.tarball,
    profileSource: fixture.profile.source,
    profileSidecar: fixture.profile.sidecar,
    packageManifestSource: fixture.packageManifestSource,
  });
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("live candidate foundation", () => {
  it("validates candidate and packaged profile artifacts without repository source inputs", () => {
    const fixture = candidateArtifacts();
    const candidate = inspectFixture();

    expect(candidate.manifest).toEqual(fixture.manifest);
    expect(candidate.manifestSha256).toBe(sha256Hex(fixture.manifestSource));
    expect(candidate.tarballSha256).toBe(sha256Hex(fixture.tarball));
    expect(candidate.package).toEqual({
      name: "@ahasend/sdk",
      version: "0.1.0-live-test",
    });
    expect(candidate.profile.operations).toHaveLength(56);
    expect(candidate.profile.iterators).toHaveLength(9);
    expect(candidate.registry.primary.size).toBe(56);
    expect(candidate.registry.iterators).toHaveLength(9);
    expect(Object.isFrozen(candidate.manifest)).toBe(true);
    expect(Object.isFrozen(candidate.manifest.contractSha256)).toBe(true);
    expect(Object.isFrozen(candidate.manifest.keysSha256)).toBe(true);
    expect(() => {
      (candidate.manifest.contractSha256 as Record<string, string>)["openapi.yaml"] = "a".repeat(
        64,
      );
    }).toThrow(TypeError);
    expect(() => {
      (candidate.manifest.keysSha256 as Record<string, string>)[
        "contracts/webhooks/captured/keys/route.key"
      ] = "b".repeat(64);
    }).toThrow(TypeError);
  });

  it("rejects changed candidate, profile, or detached digest bytes", () => {
    const fixture = candidateArtifacts();
    const inspect = (overrides: Partial<Parameters<typeof inspectLiveCandidate>[0]> = {}) =>
      inspectLiveCandidate({
        manifestSource: fixture.manifestSource,
        manifestSidecar: fixture.manifestSidecar,
        tarballSource: fixture.tarball,
        profileSource: fixture.profile.source,
        profileSidecar: fixture.profile.sidecar,
        packageManifestSource: fixture.packageManifestSource,
        ...overrides,
      });

    expect(() => inspect({ tarballSource: Buffer.from("changed") })).toThrow(
      "tarball does not match",
    );
    expect(() => inspect({ manifestSidecar: `${zeroHash}\n` })).toThrow(
      "manifest does not match its detached sidecar",
    );
    expect(() => inspect({ profileSidecar: `${zeroHash}\n` })).toThrow(
      "profile does not match its detached sidecar",
    );

    const otherProfile = structuredClone(profileFixture);
    otherProfile.operations[0]!.method = "changed";
    const otherArtifacts = profileArtifacts(otherProfile);
    expect(() =>
      inspect({
        profileSource: otherArtifacts.source,
        profileSidecar: otherArtifacts.sidecar,
      }),
    ).toThrow("profile does not match the candidate manifest");
  });

  it("extracts the operation profile and package identity from verified tarball bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ahasend-live-archive-"));
    temporaryDirectories.push(directory);
    const packageRoot = resolve(directory, "staging/package");
    const metadataRoot = resolve(packageRoot, "dist/_metadata");
    mkdirSync(metadataRoot, { recursive: true });
    const profile = profileArtifacts();
    const packageManifestSource = canonicalizeJson({
      name: "@ahasend/sdk",
      version: "0.1.0-archive-test",
    });
    writeFileSync(resolve(metadataRoot, "operation-profile.json"), profile.source);
    writeFileSync(resolve(metadataRoot, "operation-profile.sha256"), profile.sidecar);
    writeFileSync(resolve(packageRoot, "package.json"), packageManifestSource);
    const tarballPath = resolve(directory, "candidate.tgz");
    execFileSync("tar", ["-czf", tarballPath, "-C", resolve(directory, "staging"), "package"]);

    const tarball = readFileSync(tarballPath);
    const manifestSource = canonicalizeJson(manifestFor(tarball, profile.digest));
    const manifestPath = resolve(directory, "candidate-manifest.json");
    const sidecarPath = resolve(directory, "candidate-manifest.sha256");
    writeFileSync(manifestPath, manifestSource);
    writeFileSync(sidecarPath, `${sha256Hex(manifestSource)}\n`);

    const candidate = await loadLiveCandidate({
      manifestPath,
      manifestSidecarPath: sidecarPath,
      tarballPath,
    });

    expect(candidate.package.version).toBe("0.1.0-archive-test");
    expect(candidate.profileSource).toEqual(profile.source);
    expect(candidate.profileSidecar).toEqual(profile.sidecar);
    expect(candidate.profile.operations).toHaveLength(56);
    expect(candidate.profile.iterators).toHaveLength(9);
  });

  it("installs an immutable copy only after all candidate artifacts verify", async () => {
    const fixture = candidateArtifacts();
    const directory = mkdtempSync(join(tmpdir(), "ahasend-live-install-"));
    temporaryDirectories.push(directory);
    const manifestPath = join(directory, "candidate-manifest.json");
    const sidecarPath = join(directory, "candidate-manifest.sha256");
    const tarballPath = join(directory, "candidate.tgz");
    const installDirectory = join(directory, "installed");
    writeFileSync(manifestPath, fixture.manifestSource);
    writeFileSync(sidecarPath, fixture.manifestSidecar);
    writeFileSync(tarballPath, fixture.tarball);

    const extractArchiveFile = vi.fn((_tarballPath: string, archivePath: string) => {
      if (archivePath === "dist/_metadata/operation-profile.json") return fixture.profile.source;
      if (archivePath === "dist/_metadata/operation-profile.sha256") return fixture.profile.sidecar;
      if (archivePath === "package.json") return fixture.packageManifestSource;
      throw new TypeError(`Unexpected archive path ${archivePath}`);
    });
    const runCommand = vi.fn(
      (_command: string, args: readonly string[], options: { cwd: string }) => {
        expect(options.cwd).toBe(resolve(installDirectory));
        expect(args.slice(-5)).toEqual([
          "install",
          "--ignore-scripts",
          "--no-package-lock",
          "--no-save",
          resolve(installDirectory, basename(tarballPath)),
        ]);
        const installedRoot = resolve(installDirectory, "node_modules/@ahasend/sdk");
        mkdirSync(resolve(installedRoot, "dist/_metadata"), { recursive: true });
        writeFileSync(resolve(installedRoot, "package.json"), fixture.packageManifestSource);
        writeFileSync(
          resolve(installedRoot, "dist/_metadata/operation-profile.json"),
          fixture.profile.source,
        );
        writeFileSync(
          resolve(installedRoot, "dist/_metadata/operation-profile.sha256"),
          fixture.profile.sidecar,
        );
      },
    );

    const installed = await installLiveCandidate({
      manifestPath,
      manifestSidecarPath: sidecarPath,
      tarballPath,
      installDirectory,
      extractArchiveFile,
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledOnce();
    expect(readFileSync(resolve(installDirectory, basename(tarballPath)))).toEqual(fixture.tarball);
    expect(installed.profile.operations).toHaveLength(56);

    const badDirectory = join(directory, "bad-install");
    writeFileSync(tarballPath, Buffer.from("substituted after candidate creation"));
    const rejectedRunCommand = vi.fn();
    const extractionCalls = extractArchiveFile.mock.calls.length;
    await expect(
      installLiveCandidate({
        manifestPath,
        manifestSidecarPath: sidecarPath,
        tarballPath,
        installDirectory: badDirectory,
        extractArchiveFile,
        runCommand: rejectedRunCommand,
      }),
    ).rejects.toThrow("tarball does not match");
    expect(rejectedRunCommand).not.toHaveBeenCalled();
    expect(extractArchiveFile).toHaveBeenCalledTimes(extractionCalls);
  });
});

describe("live scenario inventory", () => {
  it("creates 56 primary scenarios and nine attached iterator subcases from the profile", () => {
    const profile = inspectFixture().profile;
    const registry = createScenarioRegistry(
      profile,
      profile.operations.map(({ operationId }) => ({
        operationId,
        request: { fixture: operationId },
      })),
    );

    expect(registry.primary.size).toBe(56);
    expect(registry.iterators).toHaveLength(9);
    expect(new Set(registry.iterators.map(({ operationId }) => operationId))).toHaveLength(9);
    for (const iterator of registry.iterators) {
      expect(iterator.method).toBe("iterate");
      expect(iterator.primary).toBe(registry.primary.get(iterator.operationId));
      expect(iterator.primary.method).toBe("list");
      expect(iterator.primary.iterator).toMatchObject({
        operationId: iterator.operationId,
        method: "iterate",
      });
    }

    const mutablePrimary = registry.primary as unknown as Map<string, unknown>;
    expect(Object.isFrozen(registry.primary)).toBe(true);
    expect(() => mutablePrimary.delete(profile.operations[0]!.operationId)).toThrow();
    expect(() => mutablePrimary.set("orphan", {})).toThrow();
    expect(registry.primary.size).toBe(56);
  });

  it("rejects missing, orphaned, duplicate, and mapping-redefining scenarios", () => {
    const profile = inspectFixture().profile;
    const scenarios = profile.operations.map(({ operationId }) => ({ operationId }));

    expect(() => createScenarioRegistry(profile, scenarios.slice(1))).toThrow(
      "registry mismatch: missing",
    );
    expect(() =>
      createScenarioRegistry(profile, [...scenarios.slice(1), { operationId: "orphan" }]),
    ).toThrow(/missing .+ orphaned/u);
    expect(() => createScenarioRegistry(profile, [...scenarios, scenarios[0]!])).toThrow(
      "duplicate operationId",
    );
    expect(() =>
      createScenarioRegistry(profile, [
        { ...scenarios[0]!, facade: "substituted" },
        ...scenarios.slice(1),
      ]),
    ).toThrow("cannot redefine facade mappings");
  });

  it("rejects duplicate and incorrectly linked iterator mappings", () => {
    const duplicate = structuredClone(profileFixture);
    duplicate.iterators[1] = structuredClone(duplicate.iterators[0]!);
    const duplicateArtifacts = profileArtifacts(duplicate);
    expect(() =>
      validatePackagedLiveProfile({
        profileSource: duplicateArtifacts.source,
        profileSidecar: duplicateArtifacts.sidecar,
        expectedProfileSha256: duplicateArtifacts.digest,
      }),
    ).toThrow("duplicate operationId");

    const detached = structuredClone(profileFixture);
    detached.iterators[0]!.facade = "domains";
    const detachedArtifacts = profileArtifacts(detached);
    expect(() =>
      validatePackagedLiveProfile({
        profileSource: detachedArtifacts.source,
        profileSidecar: detachedArtifacts.sidecar,
        expectedProfileSha256: detachedArtifacts.digest,
      }),
    ).toThrow("must attach to its corresponding list-operation");
  });
});

describe("live cleanup and reporting", () => {
  it("retains immediately registered cleanup after a later failure and runs it in reverse order", async () => {
    const order: string[] = [];

    await expect(
      runWithCleanup(async (cleanup) => {
        cleanup.register("first create", () => {
          order.push("first");
        });
        cleanup.register("second create", async () => {
          await Promise.resolve();
          order.push("second");
        });
        throw new Error("later live scenario failed");
      }),
    ).rejects.toThrow("later live scenario failed");
    expect(order).toEqual(["second", "first"]);
  });

  it("runs every cleanup after one cleanup fails and retains reportable results", async () => {
    const order: string[] = [];
    const cleanup = createCleanupRegistry();
    cleanup.register("first", () => {
      order.push("first");
    });
    cleanup.register("failing", () => {
      order.push("failing");
      throw new Error("cleanup failed");
    });
    cleanup.register("last", () => {
      order.push("last");
    });

    await expect(cleanup.run()).rejects.toThrow("1 cleanup action(s) failed");
    expect(order).toEqual(["last", "failing", "first"]);
    expect(cleanup.size).toBe(0);
    expect(cleanup.results).toEqual([
      { label: "last", status: "passed" },
      { label: "failing", status: "failed" },
      { label: "first", status: "passed" },
    ]);
  });

  it("writes a redacted canonical report and linked detached digest", async () => {
    const candidate = inspectFixture();
    const secret = "live-api-key-value";
    const oneTimeSecretKey = "one-time-secret-key-value";
    const dkimPrivateKey = "private-key-material";
    const overlappingSecretPrefix = "aha-live";
    const overlappingSecret = "aha-live-secret-value";
    const bufferedCredential = "buffered-credential-value";
    const typedArrayCredential = "typed-array-credential-value";
    const environmentApiKey = "environment-api-key-value";
    const environmentToken = "environment-token-value";
    const environmentWebhookSecret = "environment-webhook-secret-value";
    const standaloneApiKey = `aha-sk-${"A".repeat(64)}`;
    const pemPrivateKey =
      "-----BEGIN PRIVATE KEY-----\nfixture-private-key\n-----END PRIVATE KEY-----";
    const report = createLiveReport({
      candidate,
      operationResults: [
        {
          operationId: candidate.profile.operations[0]!.operationId,
          status: "passed",
          evidence: {
            apiKey: secret,
            request: `Authorization: Bearer ${secret}`,
            response: `safe prefix ${secret}`,
            secret_key: oneTimeSecretKey,
            dkim_private_key: dkimPrivateKey,
            overlappingValue: overlappingSecret,
            [`credential-${secret}`]: true,
            bufferedValue: Buffer.from(bufferedCredential, "utf8"),
            typedArrayValue: Uint8Array.from(Buffer.from(typedArrayCredential, "utf8")),
            AHASEND_API_KEY: environmentApiKey,
            AHASEND_TOKEN: environmentToken,
            AHASEND_WEBHOOK_SECRET: environmentWebhookSecret,
            neutralApiOutput: standaloneApiKey,
            neutralPemOutput: pemPrivateKey,
          },
        },
      ],
      cleanupResults: [{ label: "delete fixture", status: "passed" }],
      secrets: [secret, overlappingSecretPrefix, overlappingSecret],
    });
    const directory = mkdtempSync(join(tmpdir(), "ahasend-live-report-"));
    temporaryDirectories.push(directory);
    const reportPath = join(directory, "live-report.json");
    const written = await writeLiveReport({ report, candidate, reportPath });
    const reportSource = readFileSync(reportPath);
    const sidecar = readFileSync(written.reportSidecarPath);
    const parsed = JSON.parse(reportSource.toString("utf8")) as {
      candidate: { manifestSha256: string };
      contractSha256: Record<string, string>;
      profileSha256: string;
      captureSha256: string;
      keysSha256: Record<string, string>;
      package: { name: string; version: string };
      tarballSha256: string;
      operations: Array<{ evidence?: Record<string, unknown> }>;
      iterators: unknown[];
    };
    const validateSchema = new Ajv({ allErrors: true }).compile(liveReportSchema);

    expect(reportSource).toEqual(canonicalizeJson(parsed));
    expect(reportSource.toString("utf8")).not.toContain(secret);
    expect(reportSource.toString("utf8")).not.toContain(oneTimeSecretKey);
    expect(reportSource.toString("utf8")).not.toContain(dkimPrivateKey);
    expect(reportSource.toString("utf8")).not.toContain(environmentApiKey);
    expect(reportSource.toString("utf8")).not.toContain(environmentToken);
    expect(reportSource.toString("utf8")).not.toContain(environmentWebhookSecret);
    expect(reportSource.toString("utf8")).not.toContain(standaloneApiKey);
    expect(reportSource.toString("utf8")).not.toContain(pemPrivateKey);
    expect(reportSource.toString("utf8")).not.toContain(overlappingSecret);
    expect(reportSource.toString("utf8")).not.toContain("-secret-value");
    expect(parsed.operations[0]?.evidence).toMatchObject({
      overlappingValue: "[REDACTED]",
      "credential-[REDACTED]": true,
      bufferedValue: "[REDACTED]",
      typedArrayValue: "[REDACTED]",
      AHASEND_API_KEY: "[REDACTED]",
      AHASEND_TOKEN: "[REDACTED]",
      AHASEND_WEBHOOK_SECRET: "[REDACTED]",
      neutralApiOutput: "[REDACTED]",
      neutralPemOutput: "[REDACTED]",
    });
    expect(reportSource.toString("utf8")).toContain("[REDACTED]");
    expect(sidecar.toString("utf8")).toBe(`${sha256Hex(reportSource)}\n`);
    expect(validateSchema(parsed), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(parsed).toMatchObject({
      candidate: { manifestSha256: candidate.manifestSha256 },
      contractSha256: candidate.manifest.contractSha256,
      profileSha256: candidate.profile.profileSha256,
      captureSha256: candidate.manifest.captureSha256,
      keysSha256: candidate.manifest.keysSha256,
      package: candidate.package,
      tarballSha256: candidate.tarballSha256,
    });
    expect(parsed.operations).toHaveLength(56);
    expect(parsed.iterators).toHaveLength(9);
    expect(
      validateLiveReportArtifacts({ reportSource, reportSidecar: sidecar, candidate }),
    ).toMatchObject({
      reportSha256: written.reportSha256,
      operations: 56,
      iterators: 9,
    });
  });

  it("rejects altered sidecars, duplicate IDs, detached iterators, and extra package fields", () => {
    const candidate = inspectFixture();
    const report = createLiveReport({ candidate });
    const source = canonicalizeJson(report);

    expect(() =>
      validateLiveReportArtifacts({
        reportSource: source,
        reportSidecar: `${zeroHash}\n`,
        candidate,
      }),
    ).toThrow("report does not match its detached sidecar");

    const duplicate = structuredClone(report) as {
      operations: Array<Record<string, unknown>>;
    };
    duplicate.operations[1]!.operationId = duplicate.operations[0]!.operationId;
    const duplicateSource = canonicalizeJson(duplicate);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: duplicateSource,
        reportSidecar: `${sha256Hex(duplicateSource)}\n`,
        candidate,
      }),
    ).toThrow("duplicate operationId");

    const detachedIterator = structuredClone(report) as {
      operations: Array<Record<string, unknown>>;
      iterators: Array<Record<string, unknown>>;
    };
    const nonListPrimary = detachedIterator.operations.find(({ method }) => method !== "list")!;
    detachedIterator.iterators[0]!.operationId = nonListPrimary.operationId;
    detachedIterator.iterators[0]!.facade = nonListPrimary.facade;
    const detachedIteratorSource = canonicalizeJson(detachedIterator);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: detachedIteratorSource,
        reportSidecar: `${sha256Hex(detachedIteratorSource)}\n`,
        candidate,
      }),
    ).toThrow("is not present in the packaged profile");

    const extraPackageField = structuredClone(report) as {
      package: Record<string, unknown>;
    };
    extraPackageField.package.extra = "schema-forbidden";
    const extraPackageFieldSource = canonicalizeJson(extraPackageField);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: extraPackageFieldSource,
        reportSidecar: `${sha256Hex(extraPackageFieldSource)}\n`,
        candidate,
      }),
    ).toThrow("Live acceptance report package fields must be canonical");
  });

  it("rejects substituted candidate identities and invented packaged operation inventories", () => {
    const candidate = inspectFixture();
    const report = createLiveReport({ candidate });
    const inconsistentCandidate = {
      ...candidate,
      manifest: {
        ...candidate.manifest,
        contractSha256: {
          ...candidate.manifest.contractSha256,
          "openapi.yaml": "c".repeat(64),
        },
        keysSha256: {
          ...candidate.manifest.keysSha256,
          "contracts/webhooks/captured/keys/route.key": "d".repeat(64),
        },
      },
    } satisfies LiveCandidate;
    const inconsistentReport = createLiveReport({ candidate: inconsistentCandidate });
    const inconsistentReportSource = canonicalizeJson(inconsistentReport);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: inconsistentReportSource,
        reportSidecar: `${sha256Hex(inconsistentReportSource)}\n`,
        candidate: inconsistentCandidate,
      }),
    ).toThrow("manifest does not match its authenticated manifestSha256");

    const substitutedProfileSha256 = "e".repeat(64);
    const inconsistentProfileCandidate = {
      ...candidate,
      profile: {
        ...candidate.profile,
        profileSha256: substitutedProfileSha256,
      },
    } satisfies LiveCandidate;
    const inconsistentProfileReport = createLiveReport({
      candidate: inconsistentProfileCandidate,
    });
    const inconsistentProfileSource = canonicalizeJson(inconsistentProfileReport);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: inconsistentProfileSource,
        reportSidecar: `${sha256Hex(inconsistentProfileSource)}\n`,
        candidate: inconsistentProfileCandidate,
      }),
    ).toThrow("profileSha256 does not match the authenticated candidate manifest");

    const inconsistentProfileMappings = {
      ...candidate,
      profile: {
        ...candidate.profile,
        operations: candidate.profile.operations.map((operation, index) =>
          index === 0 ? { ...operation, facade: "substituted" } : operation,
        ),
      },
    } satisfies LiveCandidate;
    const inconsistentMappingsReport = createLiveReport({
      candidate: inconsistentProfileMappings,
    });
    const inconsistentMappingsSource = canonicalizeJson(inconsistentMappingsReport);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: inconsistentMappingsSource,
        reportSidecar: `${sha256Hex(inconsistentMappingsSource)}\n`,
        candidate: inconsistentProfileMappings,
      }),
    ).toThrow("profile does not match the authenticated candidate manifest");

    const substitutedTarballSha256 = "f".repeat(64);
    const inconsistentTarballCandidate = {
      ...candidate,
      tarballSha256: substitutedTarballSha256,
    } satisfies LiveCandidate;
    const inconsistentTarballReport = createLiveReport({
      candidate: inconsistentTarballCandidate,
    });
    const inconsistentTarballSource = canonicalizeJson(inconsistentTarballReport);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: inconsistentTarballSource,
        reportSidecar: `${sha256Hex(inconsistentTarballSource)}\n`,
        candidate: inconsistentTarballCandidate,
      }),
    ).toThrow("tarballSha256 does not match the authenticated candidate manifest");

    const staleCandidate = structuredClone(report) as {
      candidate: { manifestSha256: string };
    };
    staleCandidate.candidate.manifestSha256 = "a".repeat(64);
    const staleCandidateSource = canonicalizeJson(staleCandidate);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: staleCandidateSource,
        reportSidecar: `${sha256Hex(staleCandidateSource)}\n`,
        candidate,
      }),
    ).toThrow("candidate manifestSha256 does not match the verified live candidate");

    const staleProfile = structuredClone(report) as {
      profileSha256: string;
    };
    staleProfile.profileSha256 = "b".repeat(64);
    const staleProfileSource = canonicalizeJson(staleProfile);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: staleProfileSource,
        reportSidecar: `${sha256Hex(staleProfileSource)}\n`,
        candidate,
      }),
    ).toThrow("profileSha256 does not match the verified live candidate");

    const stalePackage = structuredClone(report) as {
      package: { version: string };
    };
    stalePackage.package.version = "0.1.0-substituted";
    const stalePackageSource = canonicalizeJson(stalePackage);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: stalePackageSource,
        reportSidecar: `${sha256Hex(stalePackageSource)}\n`,
        candidate,
      }),
    ).toThrow("package does not match the verified live candidate");

    const substitutedMapping = structuredClone(report) as {
      operations: Array<Record<string, unknown>>;
    };
    substitutedMapping.operations[0]!.facade = "invented";
    const substitutedMappingSource = canonicalizeJson(substitutedMapping);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: substitutedMappingSource,
        reportSidecar: `${sha256Hex(substitutedMappingSource)}\n`,
        candidate,
      }),
    ).toThrow("does not match its packaged facade and method mapping");

    const inventedInventory = structuredClone(report) as {
      operations: Array<Record<string, unknown>>;
      iterators: Array<Record<string, unknown>>;
    };
    for (const [index, operation] of inventedInventory.operations.entries()) {
      operation.operationId = `invented-operation-${index}`;
      operation.facade = "invented";
      operation.method = index < 9 ? "list" : "create";
    }
    for (const [index, iterator] of inventedInventory.iterators.entries()) {
      iterator.operationId = `invented-operation-${index}`;
      iterator.facade = "invented";
      iterator.method = "iterate";
    }
    const inventedInventorySource = canonicalizeJson(inventedInventory);
    expect(() =>
      validateLiveReportArtifacts({
        reportSource: inventedInventorySource,
        reportSidecar: `${sha256Hex(inventedInventorySource)}\n`,
        candidate,
      }),
    ).toThrow("is not present in the packaged profile");
  });
});
