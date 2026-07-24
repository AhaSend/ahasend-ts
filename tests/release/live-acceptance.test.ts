import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Ajv from "ajv";
import { afterAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { canonicalizeJson, digestJsonArtifact, sha256Hex } from "../../scripts/digest-artifact.mjs";
import type { AhaSendClient } from "../../src/client.js";
import {
  createCleanupRegistry,
  createDomainScenarioRegistry,
  createLiveReport,
  createMessageScenarioRegistry,
  createScenarioRegistry,
  inspectLiveCandidate,
  installLiveCandidate,
  loadLiveCandidate,
  runDomainLiveScenarios,
  runMessageLiveScenarios,
  runWithCleanup,
  validateLiveReportArtifacts,
  validatePackagedLiveProfile,
  writeLiveReport,
  type DomainLiveClient,
  type LiveCandidate,
  type LiveCandidateManifest,
  type LiveProfile,
  type MessageLiveClient,
} from "../../scripts/live-acceptance.mjs";
import liveReportSchema from "../../scripts/live-report.schema.json";

interface OperationProfileSource {
  version: number;
  operations: Array<{ operationId: string; facade: string; method: string }>;
  iterators: Array<{ operationId: string; facade: string; method: string }>;
}

type IsAssignable<Source, Target> = Source extends Target ? true : false;

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

function domainClientFixture(options: { failGet?: boolean } = {}) {
  const calls: string[] = [];
  let exists = false;
  const domain = "live-domain.example";
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const client: DomainLiveClient = {
    domains: {
      list: vi.fn(async (params) => {
        calls.push(`list:${JSON.stringify(params)}`);
        return {
          object: "list",
          data: exists ? [{ domain }] : [],
          pagination: { has_more: false },
        };
      }),
      iterate: vi.fn(async function* (params) {
        calls.push(`iterate:${JSON.stringify(params)}`);
        if (exists) yield { domain };
      }),
      create: vi.fn(async () => {
        calls.push("create");
        exists = true;
        return { domain };
      }),
      get: vi.fn(async () => {
        calls.push("get");
        if (!exists) throw notFound();
        if (options.failGet === true) {
          throw Object.assign(new Error("later scenario failed"), { status: 500 });
        }
        return { domain };
      }),
      update: vi.fn(async () => {
        calls.push("update");
        if (!exists) throw notFound();
        return { domain };
      }),
      delete: vi.fn(async () => {
        calls.push("delete");
        if (!exists) throw notFound();
        exists = false;
        return { message: "deleted" };
      }),
      checkDns: vi.fn(async () => {
        calls.push("checkDns");
        if (!exists) throw notFound();
        return { domain };
      }),
    },
  };
  return { calls, client, domain };
}

function messageClientFixture() {
  const calls: string[] = [];
  const sendRequests: Array<{ from: { email: string }; [key: string]: unknown }> = [];
  const verifiedDomain = "verified.example";
  const neverRegisteredDomain = "absent.example";
  const dnslessDomain = "dnsless.example";
  const messageId = "<live-message-id@ahasend.test>";
  const registeredDomains = new Set<string>();
  const scheduledMessageIds = new Set<string>();
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const rejected = () => Object.assign(new Error("sandbox sender rejected"), { status: 400 });
  const success = (status: "queued" | "scheduled" = "queued") => ({
    object: "list",
    data: [{ id: messageId, status }],
  });
  const client: MessageLiveClient = {
    ping: vi.fn(async () => {
      calls.push("ping");
      return { message: "pong" };
    }),
    messages: {
      send: vi.fn(async (request: { from: { email: string }; [key: string]: unknown }) => {
        calls.push("send");
        sendRequests.push(request);
        const domain = request.from.email.split("@").at(-1);
        if (domain !== verifiedDomain) throw rejected();
        const firstAttempt = (request.schedule as { first_attempt?: unknown } | undefined)
          ?.first_attempt;
        if (typeof firstAttempt !== "string" || Date.parse(firstAttempt) <= Date.now()) {
          throw new Error("verified sandbox send must be scheduled in the future");
        }
        scheduledMessageIds.add(messageId);
        return success("scheduled");
      }),
      sendConversation: vi.fn(
        async (request: { from: { email: string }; [key: string]: unknown }) => {
          calls.push("sendConversation");
          sendRequests.push(request);
          return success();
        },
      ),
      list: vi.fn(async (params: unknown) => {
        calls.push(`list:${JSON.stringify(params)}`);
        return {
          object: "list",
          data: [{ id: messageId }],
          pagination: { has_more: false },
        };
      }),
      iterate: vi.fn(async function* (params: unknown) {
        calls.push(`iterate:${JSON.stringify(params)}`);
        yield { id: messageId };
      }),
      get: vi.fn(async (id: string) => {
        calls.push(`get:${id}`);
        return { id: messageId };
      }),
      cancel: vi.fn(async (id: string) => {
        calls.push(`cancel:${id}`);
        if (!scheduledMessageIds.delete(id)) {
          throw new Error("only scheduled messages can be cancelled");
        }
        return { message: "cancelled" };
      }),
    },
    domains: {
      create: vi.fn(async (request: { domain: string }) => {
        calls.push("createDomain");
        registeredDomains.add(request.domain);
        return { domain: request.domain };
      }),
      get: vi.fn(async (domain: string) => {
        calls.push("getDomain");
        if (!registeredDomains.has(domain)) throw notFound();
        return { domain };
      }),
      delete: vi.fn(async (domain: string) => {
        calls.push("deleteDomain");
        if (!registeredDomains.delete(domain)) throw notFound();
        return { message: "deleted" };
      }),
    },
  };
  const verifiedRequest = {
    from: { email: `sender@${verifiedDomain}` },
    recipients: [{ email: "recipient@example.net" }],
    subject: "live message subject",
    text_content: "live message content",
    sandbox: true as const,
    schedule: {
      first_attempt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    },
  };
  const conversationRequest = {
    from: { email: `sender@${verifiedDomain}` },
    to: [{ email: "recipient@example.net" }],
    subject: "live conversation subject",
    text_content: "live conversation content",
    sandbox: true as const,
  };
  return {
    calls,
    client,
    conversationRequest,
    dnslessDomain,
    messageId,
    neverRegisteredDomain,
    registeredDomains,
    sendRequests,
    verifiedDomain,
    verifiedRequest,
  };
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

  it("registers exactly one executable scenario for every packaged domain primary", () => {
    const profile = inspectFixture().profile;
    const fixture = domainClientFixture();
    const registry = createDomainScenarioRegistry({
      profile,
      client: fixture.client,
      createRequest: { domain: fixture.domain },
    });
    const domainEntries = [...registry.primary.values()].filter(
      ({ facade }) => facade === "domains",
    );

    expect(domainEntries.map(({ operationId }) => operationId).sort()).toEqual(
      [
        "checkDomainDNS",
        "createDomain",
        "deleteDomain",
        "getDomain",
        "getDomains",
        "updateDomain",
      ].sort(),
    );
    expect(domainEntries).toHaveLength(6);
    expect(domainEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, DomainLiveClient>>().toEqualTypeOf<true>();
  });

  it("dispatches domain lifecycle calls through the authenticated packaged mappings", async () => {
    const candidate = inspectFixture();
    const fixture = domainClientFixture();
    const domains = fixture.client.domains;
    const packagedMethods = {
      packagedCreate: vi.fn(() => domains.create()),
      packagedGet: vi.fn(() => domains.get()),
      packagedUpdate: vi.fn(() => domains.update()),
      packagedCheckDns: vi.fn(() => domains.checkDns()),
      packagedDelete: vi.fn(() => domains.delete()),
    };
    Object.assign(domains, packagedMethods);
    const mappedMethods = new Map([
      ["createDomain", "packagedCreate"],
      ["getDomain", "packagedGet"],
      ["updateDomain", "packagedUpdate"],
      ["checkDomainDNS", "packagedCheckDns"],
      ["deleteDomain", "packagedDelete"],
    ]);
    const profile = {
      ...candidate.profile,
      operations: candidate.profile.operations.map((mapping) => ({
        ...mapping,
        method: mappedMethods.get(mapping.operationId) ?? mapping.method,
      })),
    };
    const registry = createDomainScenarioRegistry({
      profile,
      client: fixture.client,
      createRequest: { domain: fixture.domain },
    });

    const result = await runDomainLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(packagedMethods.packagedCreate).toHaveBeenCalledOnce();
    expect(packagedMethods.packagedGet).toHaveBeenCalledTimes(2);
    expect(packagedMethods.packagedUpdate).toHaveBeenCalledOnce();
    expect(packagedMethods.packagedCheckDns).toHaveBeenCalledOnce();
    expect(packagedMethods.packagedDelete).toHaveBeenCalledTimes(2);
  });

  it("records the domain iterator as one linked subcase without a second primary", async () => {
    const candidate = inspectFixture();
    const fixture = domainClientFixture();
    const registry = createDomainScenarioRegistry({
      profile: candidate.profile,
      client: fixture.client,
      createRequest: { domain: fixture.domain },
    });

    const result = await runDomainLiveScenarios(registry);
    const listResults = result.operationResults.filter(
      ({ operationId }) => operationId === "getDomains",
    );

    expect(result.failure).toBeNull();
    expect(listResults).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "getDomains",
        status: "passed",
        evidence: { direction: "forward", items: 0, limit: 1 },
      },
    ]);
    expect(registry.primary.get("getDomains")?.iterator).toMatchObject({
      operationId: "getDomains",
      method: "iterate",
    });
  });

  it("uses a positive limit and only the selected domain cursor direction", async () => {
    const fixture = domainClientFixture();
    const registry = createDomainScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createRequest: { domain: fixture.domain },
      pagination: { limit: 2, after: "next-page" },
    });

    await runDomainLiveScenarios(registry);

    expect(fixture.client.domains.list).toHaveBeenCalledWith({
      limit: 2,
      after: "next-page",
    });
    expect(fixture.client.domains.iterate).toHaveBeenCalledWith({
      limit: 2,
      after: "next-page",
    });
    expect(fixture.client.domains.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ before: expect.anything() }),
    );
  });

  it("registers exactly one executable scenario for ping and every message primary", () => {
    const fixture = messageClientFixture();
    const registry = createMessageScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      verifiedRequest: fixture.verifiedRequest,
      conversationRequest: fixture.conversationRequest,
      neverRegisteredDomain: fixture.neverRegisteredDomain,
      dnslessCreateRequest: { domain: fixture.dnslessDomain },
    });
    const messageEntries = [...registry.primary.values()].filter(
      ({ facade, operationId }) => facade === "messages" || operationId === "ping",
    );

    expect(messageEntries.map(({ operationId }) => operationId).sort()).toEqual(
      [
        "cancelMessage",
        "createConversationMessage",
        "createMessage",
        "getMessage",
        "getMessages",
        "ping",
      ].sort(),
    );
    expect(messageEntries).toHaveLength(6);
    expect(messageEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, MessageLiveClient>>().toEqualTypeOf<true>();
  });

  it("dispatches ping and message calls through the packaged mappings", async () => {
    const candidate = inspectFixture();
    const fixture = messageClientFixture();
    const messages = fixture.client.messages;
    const original = {
      send: messages.send as unknown as (request: unknown) => unknown,
      sendConversation: messages.sendConversation as unknown as (request: unknown) => unknown,
      get: messages.get as unknown as (messageId: unknown) => unknown,
      cancel: messages.cancel as unknown as (messageId: unknown) => unknown,
    };
    const packagedMethods = {
      packagedPing: vi.fn(() => fixture.client.ping()),
      packagedSend: vi.fn((request: unknown) => original.send(request)),
      packagedConversation: vi.fn((request: unknown) => original.sendConversation(request)),
      packagedGet: vi.fn((messageId: unknown) => original.get(messageId)),
      packagedCancel: vi.fn((messageId: unknown) => original.cancel(messageId)),
    };
    Object.assign(fixture.client, { packagedPing: packagedMethods.packagedPing });
    Object.assign(messages, packagedMethods);
    const mappedMethods = new Map([
      ["ping", "packagedPing"],
      ["createMessage", "packagedSend"],
      ["createConversationMessage", "packagedConversation"],
      ["getMessage", "packagedGet"],
      ["cancelMessage", "packagedCancel"],
    ]);
    const profile = {
      ...candidate.profile,
      operations: candidate.profile.operations.map((mapping) => ({
        ...mapping,
        method: mappedMethods.get(mapping.operationId) ?? mapping.method,
      })),
    };
    const registry = createMessageScenarioRegistry({
      profile,
      client: fixture.client,
      verifiedRequest: fixture.verifiedRequest,
      conversationRequest: fixture.conversationRequest,
      neverRegisteredDomain: fixture.neverRegisteredDomain,
      dnslessCreateRequest: { domain: fixture.dnslessDomain },
    });

    const result = await runMessageLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(packagedMethods.packagedPing).toHaveBeenCalledOnce();
    expect(packagedMethods.packagedSend).toHaveBeenCalledTimes(3);
    expect(packagedMethods.packagedConversation).toHaveBeenCalledOnce();
    expect(packagedMethods.packagedGet).toHaveBeenCalledOnce();
    expect(packagedMethods.packagedCancel).toHaveBeenCalledOnce();
  });

  it("runs verified, never-registered, and newly registered DNS-less sandbox outcomes", async () => {
    const fixture = messageClientFixture();
    const registry = createMessageScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      verifiedRequest: fixture.verifiedRequest,
      conversationRequest: fixture.conversationRequest,
      neverRegisteredDomain: fixture.neverRegisteredDomain,
      dnslessCreateRequest: { domain: fixture.dnslessDomain },
    });

    const result = await runMessageLiveScenarios(registry);
    const sendResult = result.operationResults.find(
      ({ operationId }) => operationId === "createMessage",
    );

    expect(result.failure).toBeNull();
    expect(sendResult).toMatchObject({
      status: "passed",
      evidence: {
        senderAuthorization: { source: "body.from.email" },
        sandbox: {
          verified: { accepted: true, results: 1 },
          neverRegistered: {
            reason: "domain_not_registered",
            rejected: true,
            status: 400,
          },
          dnsless: { reason: "dns_not_verified", rejected: true, status: 400 },
        },
      },
    });
    expect(fixture.sendRequests.map(({ from }) => from.email)).toEqual([
      `sender@${fixture.verifiedDomain}`,
      `live-acceptance@${fixture.neverRegisteredDomain}`,
      `live-acceptance@${fixture.dnslessDomain}`,
      `sender@${fixture.verifiedDomain}`,
    ]);
    expect(fixture.sendRequests.every((request) => request.sandbox === true)).toBe(true);
    expect(result.cleanupResults).toEqual([
      {
        label: "delete and verify DNS-less message domain fixture",
        status: "passed",
      },
    ]);
    expect(fixture.registeredDomains.size).toBe(0);
  });

  it("requires a future scheduled verified sandbox message before cancellation", async () => {
    const fixture = messageClientFixture();
    const { schedule: _schedule, ...unscheduledRequest } = fixture.verifiedRequest;
    const createRegistry = (verifiedRequest: typeof fixture.verifiedRequest) =>
      createMessageScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        verifiedRequest,
        conversationRequest: fixture.conversationRequest,
        neverRegisteredDomain: fixture.neverRegisteredDomain,
        dnslessCreateRequest: { domain: fixture.dnslessDomain },
      });

    expect(() => createRegistry(unscheduledRequest as never)).toThrow(
      "Verified-domain sandbox request schedule must be an object",
    );
    expect(() =>
      createRegistry({
        ...fixture.verifiedRequest,
        schedule: { first_attempt: new Date(Date.now() - 60_000).toISOString() },
      }),
    ).toThrow(
      "Verified-domain sandbox request schedule.first_attempt must be a future RFC 3339 timestamp",
    );

    const result = await runMessageLiveScenarios(createRegistry(fixture.verifiedRequest));

    expect(result.failure).toBeNull();
    expect(fixture.client.messages.cancel).toHaveBeenCalledWith(fixture.messageId);
    expect(fixture.sendRequests[0]).toMatchObject({
      sandbox: true,
      schedule: { first_attempt: fixture.verifiedRequest.schedule.first_attempt },
    });
  });

  it("records one linked message iterator with positive single-direction pagination", async () => {
    const fixture = messageClientFixture();
    const registry = createMessageScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      verifiedRequest: fixture.verifiedRequest,
      conversationRequest: fixture.conversationRequest,
      neverRegisteredDomain: fixture.neverRegisteredDomain,
      dnslessCreateRequest: { domain: fixture.dnslessDomain },
      pagination: { limit: 2, before: "previous-page" },
    });

    const result = await runMessageLiveScenarios(registry);
    const listResults = result.operationResults.filter(
      ({ operationId }) => operationId === "getMessages",
    );

    expect(result.failure).toBeNull();
    expect(listResults).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "getMessages",
        status: "passed",
        evidence: { direction: "backward", items: 1, limit: 2 },
      },
    ]);
    expect(fixture.client.messages.list).toHaveBeenCalledWith({
      limit: 2,
      before: "previous-page",
    });
    expect(fixture.client.messages.iterate).toHaveBeenCalledWith({
      limit: 2,
      before: "previous-page",
    });
    expect(fixture.client.messages.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.anything() }),
    );
    expect(registry.primary.get("getMessages")?.iterator).toMatchObject({
      operationId: "getMessages",
      method: "iterate",
    });
  });

  it("keeps message content, addresses, IDs, and API errors out of report evidence", async () => {
    const candidate = inspectFixture();
    const fixture = messageClientFixture();
    const registry = createMessageScenarioRegistry({
      profile: candidate.profile,
      client: fixture.client,
      verifiedRequest: fixture.verifiedRequest,
      conversationRequest: fixture.conversationRequest,
      neverRegisteredDomain: fixture.neverRegisteredDomain,
      dnslessCreateRequest: { domain: fixture.dnslessDomain },
    });
    const result = await runMessageLiveScenarios(registry);
    const report = createLiveReport({
      candidate,
      operationResults: result.operationResults,
      iteratorResults: result.iteratorResults,
      cleanupResults: result.cleanupResults,
      secrets: [
        fixture.verifiedDomain,
        fixture.neverRegisteredDomain,
        fixture.dnslessDomain,
        fixture.messageId,
      ],
    });
    const source = canonicalizeJson(report).toString("utf8");

    expect(source).not.toContain(fixture.verifiedRequest.subject);
    expect(source).not.toContain(fixture.verifiedRequest.text_content);
    expect(source).not.toContain(fixture.conversationRequest.subject);
    expect(source).not.toContain(fixture.conversationRequest.text_content);
    expect(source).not.toContain("sender@");
    expect(source).not.toContain("recipient@");
    expect(source).not.toContain(fixture.messageId);
    expect(source).not.toContain("sandbox sender rejected");
    expect(source).toContain('"source":"body.from.email"');
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

  it("registers domain cleanup before later lifecycle work and verifies removal", async () => {
    const fixture = domainClientFixture({ failGet: true });
    const registry = createDomainScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createRequest: { domain: fixture.domain },
    });

    const result = await runDomainLiveScenarios(registry);

    expect(result.failure).toEqual({ phase: "operation", operationId: "getDomain" });
    expect(result.cleanupResults).toEqual([
      { label: "delete and verify domain fixture", status: "passed" },
    ]);
    expect(fixture.calls).toEqual([
      'list:{"limit":1}',
      'iterate:{"limit":1}',
      "create",
      "get",
      "delete",
      "get",
    ]);
  });

  it("keeps domain requests and cleanup reports free of live secret material", async () => {
    const candidate = inspectFixture();
    const fixture = domainClientFixture();
    const privateKey = "live-domain-private-key";
    const registry = createDomainScenarioRegistry({
      profile: candidate.profile,
      client: fixture.client,
      createRequest: {
        domain: fixture.domain,
        dkim_private_key: privateKey,
      },
    });
    const result = await runDomainLiveScenarios(registry);
    const report = createLiveReport({
      candidate,
      operationResults: result.operationResults,
      iteratorResults: result.iteratorResults,
      cleanupResults: result.cleanupResults,
      secrets: [fixture.domain, privateKey],
    });
    const source = canonicalizeJson(report).toString("utf8");

    expect(source).not.toContain(fixture.domain);
    expect(source).not.toContain(privateKey);
    expect(report.cleanup).toEqual([
      { label: "delete and verify domain fixture", status: "passed" },
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
