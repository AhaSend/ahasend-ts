import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Ajv from "ajv";
import { afterAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { canonicalizeJson, digestJsonArtifact, sha256Hex } from "../../scripts/digest-artifact.mjs";
import type { AhaSendClient } from "../../src/client.js";
import { RESOURCE_AUTHORIZATION } from "../../src/generated/operations.js";
import {
  createAccountScenarioRegistry,
  createAPIKeyScenarioRegistry,
  createCleanupRegistry,
  createDomainScenarioRegistry,
  createLiveReport,
  createMessageScenarioRegistry,
  createRouteScenarioRegistry,
  createScenarioRegistry,
  createSMTPCredentialScenarioRegistry,
  createStatisticsScenarioRegistry,
  createSubAccountAPIKeyScenarioRegistry,
  createSubAccountScenarioRegistry,
  createSuppressionScenarioRegistry,
  createWebhookScenarioRegistry,
  inspectLiveCandidate,
  installLiveCandidate,
  loadLiveCandidate,
  runAccountLiveScenarios,
  runDomainLiveScenarios,
  runAPIKeyLiveScenarios,
  runMessageLiveScenarios,
  runRouteLiveScenarios,
  runSMTPCredentialLiveScenarios,
  runStatisticsLiveScenarios,
  runSubAccountAPIKeyLiveScenarios,
  runSubAccountLiveScenarios,
  runSuppressionLiveScenarios,
  runWebhookLiveScenarios,
  runWithCleanup,
  validateLiveReportArtifacts,
  validatePackagedLiveProfile,
  writeLiveReport,
  type APIKeyLiveClient,
  type AccountLiveClient,
  type DomainLiveClient,
  type LiveCandidate,
  type LiveCandidateManifest,
  type LiveProfile,
  type MessageLiveClient,
  type RouteLiveClient,
  type SMTPCredentialLiveClient,
  type StatisticsLiveClient,
  type SubAccountAPIKeyLiveClient,
  type SubAccountLiveClient,
  type SuppressionLiveClient,
  type WebhookLiveClient,
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

function messageClientFixture(
  options: { absentDomainRegistered?: boolean; dnslessDnsValid?: boolean } = {},
) {
  const calls: string[] = [];
  const sendRequests: Array<{ from: { email: string }; [key: string]: unknown }> = [];
  const verifiedDomain = "verified.example";
  const neverRegisteredDomain = "absent.example";
  const dnslessDomain = "dnsless.example";
  const messageId = "<live-message-id@ahasend.test>";
  const registeredDomains = new Map<string, boolean>();
  if (options.absentDomainRegistered === true) {
    registeredDomains.set(neverRegisteredDomain, false);
  }
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
        const dnsValid =
          domain === verifiedDomain
            ? true
            : domain === undefined
              ? undefined
              : registeredDomains.get(domain);
        if (dnsValid !== true) throw rejected();
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
        const dnsValid = options.dnslessDnsValid ?? false;
        registeredDomains.set(request.domain, dnsValid);
        return { domain: request.domain, dns_valid: dnsValid };
      }),
      get: vi.fn(async (domain: string) => {
        calls.push("getDomain");
        if (!registeredDomains.has(domain)) throw notFound();
        return { domain, dns_valid: registeredDomains.get(domain) };
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

function statisticsClientFixture(options: { checkEveryDomain?: boolean } = {}) {
  const firstDomain = "statistics-one.example";
  const secondDomain = "statistics-two.example";
  const authorizedDomains = new Set([firstDomain]);
  const request = async (params: { sender_domain?: string }) => {
    const domains = (params.sender_domain ?? "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain !== "");
    const checkedDomains = options.checkEveryDomain === false ? domains.slice(0, 1) : domains;
    if (
      checkedDomains.length === 0 ||
      !checkedDomains.every((domain) => authorizedDomains.has(domain))
    ) {
      throw Object.assign(new Error("statistics sender is not authorized"), {
        status: 403,
        url: `https://api.example.test/statistics?sender_domain=${params.sender_domain}`,
      });
    }
    return { object: "list" as const, data: [{ bucket: "redacted fixture" }] };
  };
  const client: StatisticsLiveClient = {
    statistics: {
      deliverability: vi.fn(request),
      bounces: vi.fn(request),
      deliveryTimes: vi.fn(request),
    },
  };
  return {
    client,
    firstDomain,
    secondDomain,
    senderDomains: {
      authorized: firstDomain,
      unauthorized: secondDomain,
    },
  };
}

function apiKeyClientFixture(options: { malformedSecondarySecret?: boolean } = {}) {
  const primaryId = "11111111-1111-4111-8111-111111111111";
  const secondaryId = "22222222-2222-4222-8222-222222222222";
  const primarySecret = `aha-sk-${"P".repeat(64)}`;
  const secondarySecret = `aha-sk-${"S".repeat(64)}`;
  const records = new Map<
    string,
    { id: string; label: string; scopes: string[]; ip_allow_list: string[] }
  >();
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  let createCount = 0;
  const list = vi.fn(async (params: { limit: number; after?: string; before?: string }) => ({
    object: "list" as const,
    data: [...records.values()],
    pagination: { has_more: false, next_cursor: null, prev_cursor: null },
    params,
  }));
  const iterate = vi.fn(async function* (params: {
    limit: number;
    after?: string;
    before?: string;
  }) {
    for (const record of records.values()) yield { ...record, params };
  });
  const create = vi.fn(
    async (request: { label: string; scopes: readonly string[]; ip_allow_list: readonly [] }) => {
      createCount += 1;
      const id = createCount === 1 ? primaryId : secondaryId;
      const record = {
        id,
        label: request.label,
        scopes: [...request.scopes],
        ip_allow_list: [],
      };
      records.set(id, record);
      if (createCount === 2 && options.malformedSecondarySecret === true) return { ...record };
      return {
        ...record,
        secret_key: createCount === 1 ? primarySecret : secondarySecret,
      };
    },
  );
  const get = vi.fn(async (id: string) => {
    const record = records.get(id);
    if (record === undefined) throw notFound();
    return { ...record, ip_allow_list: [...record.ip_allow_list] };
  });
  const update = vi.fn(
    async (id: string, request: { label?: string; ip_allow_list?: readonly string[] | null }) => {
      const record = records.get(id);
      if (record === undefined) throw notFound();
      if (request.label !== undefined) record.label = request.label;
      if (Array.isArray(request.ip_allow_list)) {
        record.ip_allow_list = [
          ...new Set(
            request.ip_allow_list.map((entry) => (entry.includes("/") ? entry : `${entry}/32`)),
          ),
        ];
      }
      return { ...record, ip_allow_list: [...record.ip_allow_list] };
    },
  );
  const deleteKey = vi.fn(async (id: string) => {
    if (!records.delete(id)) throw notFound();
    return { message: "deleted" };
  });
  const client: APIKeyLiveClient = {
    apiKeys: { list, iterate, create, get, update, delete: deleteKey },
  };
  const selfUpdate = vi.fn(async (_id: string, _request: { ip_allow_list: readonly string[] }) => {
    throw Object.assign(new Error("self-lockout prevented"), { status: 409 });
  });
  const createSecondaryClient = vi.fn(
    (_secret: string): APIKeyLiveClient => ({
      apiKeys: {
        ...client.apiKeys,
        update: selfUpdate,
      },
    }),
  );
  return {
    client,
    createSecondaryClient,
    primaryId,
    primarySecret,
    records,
    secondaryId,
    secondarySecret,
    selfUpdate,
  };
}

function routeClientFixture(options: { malformedSecret?: boolean } = {}) {
  const existingDomain = "route-existing.example";
  const replacementDomain = "route-replacement.example";
  const existingRecipient = `inbound@${existingDomain}`;
  const replacementRecipient = `replacement@${replacementDomain}`;
  const routeId = "33333333-3333-4333-8333-333333333333";
  const routeSecret = `aha-route-${"R".repeat(64)}`;
  const authorizationChecks: string[] = [];
  let record:
    | {
        id: string;
        name: string;
        url: string;
        recipient: string;
      }
    | undefined;
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const list = vi.fn(
    async (params: { domain: string; limit: number; after?: string; before?: string }) => {
      if (params.domain !== existingDomain) {
        throw Object.assign(new Error("scoped route list requires domain"), { status: 403 });
      }
      authorizationChecks.push("list:query.domain");
      return {
        object: "list" as const,
        data: record === undefined ? [] : [record],
        pagination: { has_more: false, next_cursor: null, prev_cursor: null },
      };
    },
  );
  const iterate = vi.fn(async function* (params: {
    domain: string;
    limit: number;
    after?: string;
    before?: string;
  }) {
    if (params.domain !== existingDomain) {
      throw Object.assign(new Error("scoped route iterator requires domain"), { status: 403 });
    }
    if (record !== undefined) yield { ...record };
  });
  const create = vi.fn(async (request: { name: string; url: string; recipient: string }) => {
    if (!request.recipient.endsWith(`@${existingDomain}`)) {
      throw Object.assign(new Error("route recipient is not authorized"), { status: 403 });
    }
    authorizationChecks.push("create:body.recipient");
    record = { id: routeId, ...request };
    return {
      ...record,
      ...(options.malformedSecret === true ? {} : { secret: routeSecret }),
    };
  });
  const get = vi.fn(async (id: string) => {
    if (record === undefined || id !== record.id) throw notFound();
    return { ...record };
  });
  const update = vi.fn(
    async (id: string, request: { name: string; url: string; recipient: string }) => {
      if (record === undefined || id !== record.id) throw notFound();
      if (
        !record.recipient.endsWith(`@${existingDomain}`) ||
        !request.recipient.endsWith(`@${replacementDomain}`)
      ) {
        throw Object.assign(new Error("route recipient transition is not authorized"), {
          status: 403,
        });
      }
      authorizationChecks.push("update:existing.recipient");
      authorizationChecks.push("update:body.recipient");
      record = { ...record, ...request };
      return { ...record };
    },
  );
  const deleteRoute = vi.fn(async (id: string) => {
    if (record === undefined || id !== record.id) throw notFound();
    record = undefined;
    return { message: "deleted" };
  });
  const client: RouteLiveClient = {
    routes: { list, iterate, create, get, update, delete: deleteRoute },
  };
  return {
    authorizationChecks,
    client,
    createRequest: {
      name: "Live route",
      url: "https://example.test/route",
      recipient: existingRecipient,
    },
    existingDomain,
    existingRecipient,
    getRoute: get,
    replacementDomain,
    replacementRecipient,
    routeId,
    routeSecret,
    updateRequest: {
      name: "Updated live route",
      url: "https://example.test/route-updated",
      recipient: replacementRecipient,
    },
  };
}

function webhookClientFixture(options: { malformedSecret?: boolean } = {}) {
  const existingDomains = ["webhook-existing.example", "webhook-second.example"] as const;
  const newlySuppliedDomains = ["webhook-new.example", "webhook-newer.example"] as const;
  const webhookId = "44444444-4444-4444-8444-444444444444";
  const webhookSecret = `aha-webhook-${"W".repeat(64)}`;
  const authorizationChecks: string[] = [];
  let record:
    | {
        id: string;
        name: string;
        url: string;
        scope: "global" | "scoped";
        domains: string[];
      }
    | undefined;
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const list = vi.fn(async (_params: { limit: number; after?: string; before?: string }) => ({
    object: "list" as const,
    data: record === undefined ? [] : [{ ...record, domains: [...record.domains] }],
    pagination: { has_more: false, next_cursor: null, prev_cursor: null },
  }));
  const iterate = vi.fn(async function* (_params: {
    limit: number;
    after?: string;
    before?: string;
  }) {
    if (record !== undefined) yield { ...record, domains: [...record.domains] };
  });
  const create = vi.fn(
    async (request: { name: string; url: string; scope: "scoped"; domains: readonly string[] }) => {
      for (const domain of request.domains) {
        if (!existingDomains.includes(domain as (typeof existingDomains)[number])) {
          throw Object.assign(new Error("webhook domain is not authorized"), { status: 403 });
        }
        authorizationChecks.push(`create:body.domains:${domain}`);
      }
      record = {
        id: webhookId,
        ...request,
        domains: [...request.domains],
      };
      return {
        ...record,
        ...(options.malformedSecret === true ? {} : { secret: webhookSecret }),
      };
    },
  );
  const get = vi.fn(async (id: string) => {
    if (record === undefined || id !== record.id) throw notFound();
    return { ...record, domains: [...record.domains] };
  });
  const update = vi.fn(
    async (
      id: string,
      request: {
        name?: string;
        url?: string;
        scope?: "global" | "scoped";
        domains?: readonly string[];
      },
    ) => {
      if (record === undefined || id !== record.id) throw notFound();
      for (const domain of record.domains) {
        authorizationChecks.push(`update:existing.domains:${domain}`);
      }
      if (request.scope === "global") {
        authorizationChecks.push("update:global-role");
        record = { ...record, ...request, scope: "global", domains: [] };
      } else {
        for (const domain of request.domains ?? []) {
          if (!newlySuppliedDomains.includes(domain as (typeof newlySuppliedDomains)[number])) {
            throw Object.assign(new Error("new webhook domain is not authorized"), { status: 403 });
          }
          authorizationChecks.push(`update:body.domains:${domain}`);
        }
        record = {
          ...record,
          ...request,
          domains: request.domains === undefined ? record.domains : [...request.domains],
        };
      }
      if (record === undefined) throw notFound();
      return { ...record, domains: [...record.domains] };
    },
  );
  const deleteWebhook = vi.fn(async (id: string) => {
    if (record === undefined || id !== record.id) throw notFound();
    record = undefined;
    return { message: "deleted" };
  });
  const client: WebhookLiveClient = {
    webhooks: { list, iterate, create, get, update, delete: deleteWebhook },
  };
  return {
    authorizationChecks,
    client,
    createRequest: {
      name: "Live configured webhook",
      url: "https://example.test/configured-webhook",
      scope: "scoped" as const,
      domains: existingDomains,
      on_delivered: true,
    },
    existingDomains,
    getWebhook: get,
    newlySuppliedDomains,
    updateRequest: {
      name: "Updated live configured webhook",
      scope: "scoped" as const,
      domains: newlySuppliedDomains,
    },
    webhookId,
    webhookSecret,
  };
}

function smtpCredentialClientFixture(
  options: {
    malformedPasswordScope?: "global" | "scoped";
    preserveGlobalDomains?: boolean;
  } = {},
) {
  const controlledDomains = ["smtp-one.example", "smtp-two.example"] as const;
  const scopedCredentialId = "55555555-5555-4555-8555-555555555555";
  const globalCredentialId = "66666666-6666-4666-8666-666666666666";
  const scopedPassword = `aha-smtp-${"S".repeat(64)}`;
  const globalPassword = `aha-smtp-${"G".repeat(64)}`;
  const authorizationChecks: string[] = [];
  const records = new Map<
    string,
    {
      id: string;
      name: string;
      sandbox: boolean;
      scope: "global" | "scoped";
      domains: string[];
    }
  >();
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const list = vi.fn(async (_params: { limit: number; after?: string; before?: string }) => ({
    object: "list" as const,
    data: [...records.values()].map((record) => ({ ...record, domains: [...record.domains] })),
    pagination: { has_more: false, next_cursor: null, prev_cursor: null },
  }));
  const iterate = vi.fn(async function* (_params: {
    limit: number;
    after?: string;
    before?: string;
  }) {
    for (const record of records.values()) {
      yield { ...record, domains: [...record.domains] };
    }
  });
  const create = vi.fn(
    async (request: {
      name: string;
      sandbox?: boolean;
      scope: "global" | "scoped";
      domains: readonly string[];
    }) => {
      if (request.scope === "scoped") {
        for (const domain of request.domains) {
          if (!controlledDomains.includes(domain as (typeof controlledDomains)[number])) {
            throw Object.assign(new Error("SMTP domain is not authorized"), { status: 403 });
          }
          authorizationChecks.push(`create:body.domains:${domain}`);
        }
      } else {
        authorizationChecks.push("create:global-role");
      }
      const id = request.scope === "scoped" ? scopedCredentialId : globalCredentialId;
      const domains =
        request.scope === "scoped" || options.preserveGlobalDomains === true
          ? [...request.domains]
          : [];
      const record = {
        id,
        name: request.name,
        sandbox: request.sandbox ?? false,
        scope: request.scope,
        domains,
      };
      records.set(id, record);
      const password = request.scope === "scoped" ? scopedPassword : globalPassword;
      return {
        ...record,
        ...(options.malformedPasswordScope === request.scope ? {} : { password }),
      };
    },
  );
  const get = vi.fn(async (id: string) => {
    const record = records.get(id);
    if (record === undefined) throw notFound();
    return { ...record, domains: [...record.domains] };
  });
  const deleteCredential = vi.fn(async (id: string) => {
    if (!records.delete(id)) throw notFound();
    return { message: "deleted" };
  });
  const client: SMTPCredentialLiveClient = {
    smtpCredentials: { list, iterate, create, get, delete: deleteCredential },
  };
  return {
    authorizationChecks,
    client,
    controlledDomains,
    getCredential: get,
    globalCredentialId,
    globalCreateRequest: {
      name: "Live global SMTP credential",
      sandbox: true,
      scope: "global" as const,
      domains: controlledDomains,
    },
    globalPassword,
    records,
    scopedCredentialId,
    scopedCreateRequest: {
      name: "Live scoped SMTP credential",
      sandbox: true,
      scope: "scoped" as const,
      domains: controlledDomains,
    },
    scopedPassword,
  };
}

function accountClientFixture(
  options: {
    failMutation?: boolean;
    failRestoration?: boolean;
    failMemberCleanup?: boolean;
    malformedMemberResult?: boolean;
  } = {},
) {
  const accountId = "77777777-7777-4777-8777-777777777777";
  const memberId = "88888888-8888-4888-8888-888888888888";
  const disposableMailbox = "sdk-live-disposable@example.test";
  const priorState = {
    name: "Disposable live account",
    website: "https://prior.example.test",
    about: "Prior disposable account state",
    track_opens: true,
    track_clicks: false,
    reject_bad_recipients: true,
    reject_mistyped_recipients: false,
    message_metadata_retention: 14,
    message_data_retention: 7,
  };
  const account = {
    object: "account" as const,
    id: accountId,
    parent_account_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    owner_id: "99999999-9999-4999-8999-999999999999",
    ...priorState,
  };
  const calls: string[] = [];
  const updateRequests: Array<Record<string, unknown>> = [];
  const members = new Map<
    string,
    {
      created_at: string;
      updated_at: string;
      user_id: string;
      account_id: string;
      role: "Developer" | "Analyst";
    }
  >();
  let updateCalls = 0;
  let removeCalls = 0;
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const get = vi.fn(async () => {
    calls.push("get");
    return { ...account };
  });
  const update = vi.fn(async (request: Record<string, unknown>) => {
    calls.push("update");
    updateCalls += 1;
    updateRequests.push({ ...request });
    if (options.failMutation === true && updateCalls === 1) {
      throw Object.assign(new Error("mutation failed"), { status: 500 });
    }
    if (options.failRestoration === true && updateCalls === 2) {
      throw Object.assign(new Error("restoration failed"), { status: 500 });
    }
    Object.assign(account, request);
    return { ...account };
  });
  const listMembers = vi.fn(async () => {
    calls.push("listMembers");
    return {
      object: "list" as const,
      data: [...members.values()].map((member) => ({ ...member })),
    };
  });
  const addMember = vi.fn(
    async (request: { email: string; name?: string; role: "Developer" | "Analyst" }) => {
      calls.push("addMember");
      if (request.email !== disposableMailbox) throw new Error("unexpected mailbox");
      const relationship = {
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        user_id: memberId,
        account_id: accountId,
        role: request.role,
      };
      members.set(memberId, relationship);
      return {
        ...relationship,
        ...(options.malformedMemberResult === true ? { role: "Analyst" as const } : {}),
      };
    },
  );
  const removeMember = vi.fn(async (userId: string) => {
    calls.push("removeMember");
    removeCalls += 1;
    if (options.failMemberCleanup === true && removeCalls === 2) {
      throw Object.assign(new Error("member cleanup failed"), { status: 500 });
    }
    if (!members.delete(userId)) throw notFound();
    return { message: "removed" };
  });
  const client: AccountLiveClient = {
    accountId,
    accounts: { get, update, listMembers, addMember, removeMember },
  };
  return {
    account,
    accountId,
    calls,
    client,
    disposableMailbox,
    memberId,
    memberRequest: {
      email: disposableMailbox,
      name: "Disposable SDK invite",
      role: "Developer" as const,
    },
    members,
    priorState,
    updateRequest: { track_opens: false, track_clicks: true },
    updateRequests,
  };
}

function suppressionClientFixture(
  options: { failCleanup?: boolean; malformedCreate?: "create" | "wipe" } = {},
) {
  const disposableDomain = "sdk-live-suppressions.example.test";
  const createRequest = {
    email: "delete-fixture@example.test",
    domain: disposableDomain,
    reason: "SDK live delete fixture",
    expires_at: "2030-01-01T00:00:00.000Z",
  };
  const wipeCreateRequest = {
    email: "wipe-fixture@example.test",
    domain: disposableDomain,
    reason: "SDK live wipe fixture",
    expires_at: "2030-01-02T00:00:00.000Z",
  };
  const outside = {
    object: "suppression" as const,
    id: "99999999-9999-4999-8999-999999999999",
    created_at: "2026-01-01T00:00:00.000Z",
    email: "outside@example.test",
    domain: "outside.example.test",
    reason: "Existing unrelated suppression",
    expires_at: "2030-01-03T00:00:00.000Z",
  };
  const records = new Map([[`${outside.email}|${outside.domain}`, outside]]);
  const calls: string[] = [];
  let createCalls = 0;
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const select = (params: { email?: string; domain?: string }) =>
    [...records.values()].filter(
      (entry) =>
        (params.email === undefined || entry.email === params.email) &&
        (params.domain === undefined || entry.domain === params.domain),
    );
  const list = vi.fn(
    async (params: {
      limit: number;
      after?: string;
      before?: string;
      email?: string;
      domain?: string;
    }) => {
      calls.push(`list:${JSON.stringify(params)}`);
      return {
        object: "list" as const,
        data: select(params).slice(0, params.limit),
        pagination: { has_more: false },
      };
    },
  );
  const iterate = vi.fn(async function* (params: {
    limit: number;
    after?: string;
    before?: string;
  }) {
    calls.push(`iterate:${JSON.stringify(params)}`);
    for (const entry of select({}).slice(0, params.limit)) yield entry;
  });
  const create = vi.fn(
    async (request: { email: string; domain?: string; reason?: string; expires_at: string }) => {
      calls.push(`create:${request.email}`);
      createCalls += 1;
      const record = {
        object: "suppression" as const,
        id: `${createCalls}1111111-1111-4111-8111-111111111111`.slice(0, 36),
        created_at: "2026-01-01T00:00:00.000Z",
        email: request.email,
        domain: request.domain ?? "",
        reason: request.reason ?? "",
        expires_at: request.expires_at,
      };
      records.set(`${record.email}|${record.domain}`, record);
      const malformed =
        (createCalls === 1 && options.malformedCreate === "create") ||
        (createCalls === 2 && options.malformedCreate === "wipe");
      return {
        object: "list" as const,
        data: malformed ? [] : [record],
      };
    },
  );
  const deleteSuppression = vi.fn(async (params: { email: string; domain?: string }) => {
    calls.push(`delete:${params.email}`);
    const key = `${params.email}|${params.domain ?? ""}`;
    if (
      !records.has(key) &&
      options.failCleanup === true &&
      params.email === wipeCreateRequest.email
    ) {
      throw Object.assign(new Error("cleanup verification failed"), { status: 500 });
    }
    if (!records.delete(key)) throw notFound();
    return { message: "deleted" };
  });
  const wipe = vi.fn(async (params: { domain?: string }) => {
    calls.push(`wipe:${params.domain ?? ""}`);
    for (const [key, entry] of records) {
      if (params.domain === undefined || entry.domain === params.domain) records.delete(key);
    }
    return { message: "wiped" };
  });
  const client: SuppressionLiveClient = {
    suppressions: { list, iterate, create, delete: deleteSuppression, wipe },
  };
  return {
    calls,
    client,
    createRequest,
    disposableDomain,
    outside,
    records,
    wipeCreateRequest,
  };
}

function subAccountClientFixture(
  options: {
    failCleanup?: boolean;
    malformedCreate?: boolean;
    unsafeUsage?: boolean;
  } = {},
) {
  const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const existingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const createRequest = {
    name: "Disposable SDK child",
    website: "sdk-live-child.example.test",
    monthly_credit: 50_000,
  };
  const updateRequest = {
    name: "Updated disposable SDK child",
    monthly_credit: 75_000,
  };
  const suspendRequest = { reason: "SDK live lifecycle verification" };
  const record = (id: string, name: string, website: string) => ({
    object: "sub_account" as const,
    id,
    parent_account_id: accountId,
    created_at: "2026-01-01T00:00:00.000Z",
    name,
    website,
    status: "active" as "active" | "suspended",
    monthly_credit: 0,
    domain_count: 0,
    member_count: 0,
    last_activity_at: null,
  });
  const records = new Map([
    [existingId, record(existingId, "Existing child", "existing-child.example.test")],
  ]);
  const calls: string[] = [];
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const list = vi.fn(async (params: { limit: number; after?: string; before?: string }) => {
    calls.push(`list:${JSON.stringify(params)}`);
    return {
      object: "list" as const,
      data: [...records.values()].slice(0, params.limit).map((entry) => ({ ...entry })),
      pagination: { has_more: false },
    };
  });
  const iterate = vi.fn(async function* (params: {
    limit: number;
    after?: string;
    before?: string;
  }) {
    calls.push(`iterate:${JSON.stringify(params)}`);
    for (const entry of [...records.values()].slice(0, params.limit)) yield { ...entry };
  });
  const create = vi.fn(async (request: typeof createRequest) => {
    calls.push("create");
    const created = {
      ...record(childId, request.name, request.website),
      monthly_credit: request.monthly_credit,
      ...(options.malformedCreate === true ? { status: "suspended" as const } : {}),
    };
    records.set(childId, { ...created });
    return { ...created };
  });
  const usage = vi.fn(async () => {
    calls.push("usage");
    return {
      billing_period: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-02-01T00:00:00.000Z",
      },
      currency: "usd",
      allocation_method: "proportional" as const,
      allocation_note: "Proportional pooled usage.",
      parent: {
        account_id: accountId,
        reception_count: options.unsafeUsage === true ? Number.MAX_SAFE_INTEGER + 1 : 10,
        allocated_cost: 1,
      },
      sub_accounts: [...records.values()].map((entry) => ({
        account_id: entry.id,
        name: entry.name,
        reception_count: 5,
        allocated_cost: 0.5,
      })),
      removed_sub_accounts: { reception_count: 0, allocated_cost: 0 },
      total: { reception_count: 15, allocated_cost: 1.5 },
    };
  });
  const get = vi.fn(async (id: string) => {
    calls.push("get");
    const child = records.get(id);
    if (child === undefined) throw notFound();
    return { ...child };
  });
  const update = vi.fn(async (id: string, request: typeof updateRequest) => {
    calls.push("update");
    const child = records.get(id);
    if (child === undefined) throw notFound();
    Object.assign(child, request);
    return { ...child };
  });
  const deleteSubAccount = vi.fn(async (id: string) => {
    calls.push("delete");
    if (!records.delete(id)) {
      if (options.failCleanup === true && id === childId) {
        throw Object.assign(new Error("cleanup failed"), { status: 500 });
      }
      throw notFound();
    }
    return { message: "deleted" };
  });
  const suspend = vi.fn(async (id: string, request: typeof suspendRequest) => {
    calls.push(`suspend:${request.reason}`);
    const child = records.get(id);
    if (child === undefined) throw notFound();
    child.status = "suspended";
    return { ...child };
  });
  const unsuspend = vi.fn(async (id: string) => {
    calls.push("unsuspend");
    const child = records.get(id);
    if (child === undefined) throw notFound();
    child.status = "active";
    return { ...child };
  });
  const client: SubAccountLiveClient = {
    accountId,
    subAccounts: {
      list,
      iterate,
      create,
      usage,
      get,
      update,
      delete: deleteSubAccount,
      suspend,
      unsuspend,
    },
  };
  return {
    accountId,
    calls,
    childId,
    client,
    createRequest,
    records,
    suspendRequest,
    updateRequest,
  };
}

function subAccountAPIKeyClientFixture(options: { malformedSecret?: boolean } = {}) {
  const subAccountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const keyId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const existingKeyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const secret = "child-bootstrap-secret-material";
  const createRequest = {
    label: "Disposable child sender",
    scopes: ["messages:send:all"] as [string, ...string[]],
  };
  const updateRequest = { label: "Updated disposable child sender" };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const scopeRecords = (id: string, scopes: readonly string[]) =>
    scopes.map((scope, index) => ({
      id: `scope-${index}`,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      api_key_id: id,
      scope,
      domain_id: null,
    }));
  const record = (id: string, label: string, scopes: readonly string[]) => ({
    object: "api_key" as const,
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
    account_id: subAccountId,
    label,
    public_key: `public-${id}`,
    scopes: scopeRecords(id, scopes),
    ip_allow_list: [] as string[],
  });
  const records = new Map([
    [existingKeyId, record(existingKeyId, "Existing child key", ["messages:send:all"])],
  ]);
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const list = vi.fn(
    async (
      receivedSubAccountId: string,
      params: { limit: number; after?: string; before?: string },
    ) => {
      calls.push({ method: "list", args: [receivedSubAccountId, params] });
      return {
        object: "list" as const,
        data: [...records.values()].slice(0, params.limit).map((entry) => ({ ...entry })),
        pagination: { has_more: false },
      };
    },
  );
  const iterate = vi.fn(async function* (
    receivedSubAccountId: string,
    params: { limit: number; after?: string; before?: string },
  ) {
    calls.push({ method: "iterate", args: [receivedSubAccountId, params] });
    for (const entry of [...records.values()].slice(0, params.limit)) yield { ...entry };
  });
  const create = vi.fn(
    async (
      receivedSubAccountId: string,
      request: { label: string; scopes: readonly string[]; ip_allow_list?: readonly string[] },
    ) => {
      calls.push({ method: "create", args: [receivedSubAccountId, request] });
      const created = record(keyId, request.label, request.scopes);
      records.set(keyId, created);
      return {
        ...created,
        ...(options.malformedSecret === true ? {} : { secret_key: secret }),
      };
    },
  );
  const get = vi.fn(async (receivedSubAccountId: string, receivedKeyId: string) => {
    calls.push({ method: "get", args: [receivedSubAccountId, receivedKeyId] });
    const entry = records.get(receivedKeyId);
    if (entry === undefined) throw notFound();
    return { ...entry };
  });
  const update = vi.fn(
    async (
      receivedSubAccountId: string,
      receivedKeyId: string,
      request: { label?: string | null; scopes?: readonly string[] | null },
    ) => {
      calls.push({ method: "update", args: [receivedSubAccountId, receivedKeyId, request] });
      const entry = records.get(receivedKeyId);
      if (entry === undefined) throw notFound();
      if (request.label !== undefined && request.label !== null) entry.label = request.label;
      if (request.scopes !== undefined && request.scopes !== null) {
        entry.scopes = scopeRecords(receivedKeyId, request.scopes);
      }
      return { ...entry };
    },
  );
  const deleteKey = vi.fn(async (receivedSubAccountId: string, receivedKeyId: string) => {
    calls.push({ method: "delete", args: [receivedSubAccountId, receivedKeyId] });
    if (!records.delete(receivedKeyId)) throw notFound();
    return { message: "deleted" };
  });
  const client: SubAccountAPIKeyLiveClient = {
    subAccounts: { apiKeys: { list, iterate, create, get, update, delete: deleteKey } },
  };
  const ping = vi.fn(async () => ({ message: "pong" }));
  const createChildClient = vi.fn((receivedSecret: string, receivedAccountId: string) => ({
    accountId: receivedAccountId,
    ping,
  }));
  return {
    calls,
    client,
    createChildClient,
    createRequest,
    existingKeyId,
    keyId,
    ping,
    records,
    secret,
    subAccountId,
    updateRequest,
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

  it("refuses to attribute a rejection to an absent domain that is registered", async () => {
    const fixture = messageClientFixture({ absentDomainRegistered: true });
    const registry = createMessageScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      verifiedRequest: fixture.verifiedRequest,
      conversationRequest: fixture.conversationRequest,
      neverRegisteredDomain: fixture.neverRegisteredDomain,
      dnslessCreateRequest: { domain: fixture.dnslessDomain },
    });

    const result = await runMessageLiveScenarios(registry);

    expect(result.failure).toEqual({ phase: "operation", operationId: "createMessage" });
    expect(fixture.client.domains.get).toHaveBeenCalledWith(fixture.neverRegisteredDomain);
    expect(fixture.sendRequests).toHaveLength(1);
    expect(fixture.client.domains.create).not.toHaveBeenCalled();
  });

  it("refuses to attribute a rejection to DNS when the new domain is DNS-valid", async () => {
    const fixture = messageClientFixture({ dnslessDnsValid: true });
    const registry = createMessageScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      verifiedRequest: fixture.verifiedRequest,
      conversationRequest: fixture.conversationRequest,
      neverRegisteredDomain: fixture.neverRegisteredDomain,
      dnslessCreateRequest: { domain: fixture.dnslessDomain },
    });

    const result = await runMessageLiveScenarios(registry);

    expect(result.failure).toEqual({ phase: "operation", operationId: "createMessage" });
    expect(fixture.client.domains.get).toHaveBeenCalledWith(fixture.neverRegisteredDomain);
    expect(fixture.client.domains.get).toHaveBeenCalledWith(fixture.dnslessDomain);
    expect(fixture.sendRequests).toHaveLength(2);
    expect(result.cleanupResults).toEqual([
      {
        label: "delete and verify DNS-less message domain fixture",
        status: "passed",
      },
    ]);
  });

  it("fails the verified sandbox outcome when a later recipient result has an error", async () => {
    const fixture = messageClientFixture();
    vi.spyOn(fixture.client.messages, "send").mockImplementationOnce(async () => ({
      object: "list",
      data: [
        { id: fixture.messageId, status: "scheduled" },
        { id: null, status: "error", error: "recipient rejected" },
      ],
    }));
    const registry = createMessageScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      verifiedRequest: fixture.verifiedRequest,
      conversationRequest: fixture.conversationRequest,
      neverRegisteredDomain: fixture.neverRegisteredDomain,
      dnslessCreateRequest: { domain: fixture.dnslessDomain },
    });

    const result = await runMessageLiveScenarios(registry);

    expect(result.failure).toEqual({ phase: "operation", operationId: "createMessage" });
    expect(result.operationResults).toEqual([
      { operationId: "ping", status: "passed", evidence: { authenticated: true } },
      { operationId: "createMessage", status: "failed" },
    ]);
    expect(fixture.client.messages.send).toHaveBeenCalledOnce();
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

  it("registers exactly one executable scenario for every packaged parent API-key primary", () => {
    const fixture = apiKeyClientFixture();
    const registry = createAPIKeyScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createSecondaryClient: fixture.createSecondaryClient,
      createRequest: { label: "live-primary", scopes: ["api-keys:read"] },
      secondaryCreateRequest: {
        label: "live-self-lockout",
        scopes: ["api-keys:read", "api-keys:write"],
      },
    });
    const apiKeyEntries = [...registry.primary.values()].filter(
      ({ facade }) => facade === "apiKeys",
    );

    expect(apiKeyEntries.map(({ operationId }) => operationId).sort()).toEqual(
      ["createAPIKey", "deleteAPIKey", "getAPIKey", "getAPIKeys", "updateAPIKey"].sort(),
    );
    expect(apiKeyEntries).toHaveLength(5);
    expect(apiKeyEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, APIKeyLiveClient>>().toEqualTypeOf<true>();
  });

  it("records the parent API-key iterator once with positive single-direction pagination", async () => {
    const fixture = apiKeyClientFixture();
    const registry = createAPIKeyScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createSecondaryClient: fixture.createSecondaryClient,
      createRequest: { label: "live-primary", scopes: ["api-keys:read"] },
      secondaryCreateRequest: {
        label: "live-self-lockout",
        scopes: ["api-keys:read", "api-keys:write"],
      },
      pagination: { limit: 2, after: "next-page" },
    });

    const result = await runAPIKeyLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(
      result.operationResults.filter(({ operationId }) => operationId === "getAPIKeys"),
    ).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "getAPIKeys",
        status: "passed",
        evidence: { direction: "forward", items: 0, limit: 2 },
      },
    ]);
    expect(fixture.client.apiKeys.list).toHaveBeenCalledWith({
      limit: 2,
      after: "next-page",
    });
    expect(fixture.client.apiKeys.iterate).toHaveBeenCalledWith({
      limit: 2,
      after: "next-page",
    });
    expect(fixture.client.apiKeys.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ before: expect.anything() }),
    );
    expect(registry.primary.get("getAPIKeys")?.iterator).toMatchObject({
      operationId: "getAPIKeys",
      method: "iterate",
    });
  });

  it("covers omitted, restricted, null, and cleared parent API-key IP-list transitions", async () => {
    const fixture = apiKeyClientFixture();
    const registry = createAPIKeyScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createSecondaryClient: fixture.createSecondaryClient,
      createRequest: { label: "live-primary", scopes: ["api-keys:read"] },
      secondaryCreateRequest: {
        label: "live-self-lockout",
        scopes: ["api-keys:read", "api-keys:write"],
      },
    });

    const result = await runAPIKeyLiveScenarios(registry);
    const updateResult = result.operationResults.find(
      ({ operationId }) => operationId === "updateAPIKey",
    );

    expect(result.failure).toBeNull();
    expect(fixture.client.apiKeys.update).toHaveBeenNthCalledWith(1, fixture.primaryId, {
      label: "live-primary updated",
    });
    expect(fixture.client.apiKeys.update).toHaveBeenNthCalledWith(2, fixture.primaryId, {
      ip_allow_list: ["192.0.2.7", "192.0.2.7/32"],
    });
    expect(fixture.client.apiKeys.update).toHaveBeenNthCalledWith(3, fixture.primaryId, {
      label: "live-primary null-preserved",
      ip_allow_list: null,
    });
    expect(fixture.client.apiKeys.update).toHaveBeenNthCalledWith(4, fixture.primaryId, {
      ip_allow_list: [],
    });
    expect(updateResult).toMatchObject({
      status: "passed",
      evidence: {
        ipAllowList: {
          cleared: true,
          nullPreserved: true,
          omittedPreserved: true,
          restrictedCanonicalized: true,
        },
      },
    });
  });

  it("uses only the disposable secondary key for self-lockout and parent auth for cleanup", async () => {
    const fixture = apiKeyClientFixture();
    const registry = createAPIKeyScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createSecondaryClient: fixture.createSecondaryClient,
      createRequest: { label: "live-primary", scopes: ["api-keys:read"] },
      secondaryCreateRequest: {
        label: "live-self-lockout",
        scopes: ["api-keys:read", "api-keys:write"],
      },
    });

    const result = await runAPIKeyLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(fixture.createSecondaryClient).toHaveBeenCalledOnce();
    expect(fixture.createSecondaryClient).toHaveBeenCalledWith(fixture.secondarySecret);
    expect(fixture.selfUpdate).toHaveBeenCalledWith(fixture.secondaryId, {
      ip_allow_list: ["192.0.2.1/32"],
    });
    expect(fixture.client.apiKeys.update).not.toHaveBeenCalledWith(
      fixture.secondaryId,
      expect.anything(),
    );
    expect(fixture.client.apiKeys.delete).toHaveBeenCalledWith(fixture.secondaryId);
    expect(result.cleanupResults).toEqual([
      { label: "delete and verify secondary API-key fixture", status: "passed" },
      { label: "delete and verify primary API-key fixture", status: "passed" },
    ]);
    expect(fixture.records.size).toBe(0);
    expect(
      result.operationResults.find(({ operationId }) => operationId === "updateAPIKey"),
    ).toMatchObject({
      evidence: { selfLockout: { persisted: false, status: 409 } },
    });
  });

  it("retains immediate cleanup when a one-time secondary secret is malformed", async () => {
    const fixture = apiKeyClientFixture({ malformedSecondarySecret: true });
    const registry = createAPIKeyScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createSecondaryClient: fixture.createSecondaryClient,
      createRequest: { label: "live-primary", scopes: ["api-keys:read"] },
      secondaryCreateRequest: {
        label: "live-self-lockout",
        scopes: ["api-keys:read", "api-keys:write"],
      },
    });

    const result = await runAPIKeyLiveScenarios(registry);

    expect(result.failure).toEqual({ phase: "operation", operationId: "createAPIKey" });
    expect(result.operationResults).toEqual([
      {
        operationId: "getAPIKeys",
        status: "passed",
        evidence: { direction: "forward", limit: 1, pageItems: 0 },
      },
      { operationId: "createAPIKey", status: "failed" },
    ]);
    expect(result.cleanupResults).toEqual([
      { label: "delete and verify secondary API-key fixture", status: "passed" },
      { label: "delete and verify primary API-key fixture", status: "passed" },
    ]);
    expect(fixture.createSecondaryClient).not.toHaveBeenCalled();
    expect(fixture.records.size).toBe(0);
  });

  it("keeps parent API-key one-time secrets out of canonical live reports", async () => {
    const candidate = inspectFixture();
    const fixture = apiKeyClientFixture();
    const registry = createAPIKeyScenarioRegistry({
      profile: candidate.profile,
      client: fixture.client,
      createSecondaryClient: fixture.createSecondaryClient,
      createRequest: { label: "live-primary", scopes: ["api-keys:read"] },
      secondaryCreateRequest: {
        label: "live-self-lockout",
        scopes: ["api-keys:read", "api-keys:write"],
      },
    });
    const result = await runAPIKeyLiveScenarios(registry);
    const report = createLiveReport({
      candidate,
      operationResults: result.operationResults,
      iteratorResults: result.iteratorResults,
      cleanupResults: result.cleanupResults,
    });
    const source = canonicalizeJson(report).toString("utf8");

    expect(source).not.toContain(fixture.primarySecret);
    expect(source).not.toContain(fixture.secondarySecret);
    expect(source).not.toContain("secret_key");
    expect(source).not.toContain("self-lockout prevented");
    expect(source).toContain('"secretsReported":false');
    expect(source).toContain('"selfLockout":{"persisted":false,"status":409}');
  });

  it("registers exactly one executable scenario for every packaged route primary", () => {
    const fixture = routeClientFixture();
    const registry = createRouteScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomain,
        replacement: fixture.replacementDomain,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    });
    const routeEntries = [...registry.primary.values()].filter(({ facade }) => facade === "routes");

    expect(routeEntries.map(({ operationId }) => operationId).sort()).toEqual(
      ["createRoute", "deleteRoute", "getRoute", "getRoutes", "updateRoute"].sort(),
    );
    expect(routeEntries).toHaveLength(5);
    expect(routeEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, RouteLiveClient>>().toEqualTypeOf<true>();
  });

  it("records the route iterator once with scoped positive single-direction pagination", async () => {
    const fixture = routeClientFixture();
    const registry = createRouteScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomain,
        replacement: fixture.replacementDomain,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
      pagination: { limit: 2, before: "previous-page" },
    });

    const result = await runRouteLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(
      result.operationResults.filter(({ operationId }) => operationId === "getRoutes"),
    ).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "getRoutes",
        status: "passed",
        evidence: { direction: "backward", items: 0, limit: 2 },
      },
    ]);
    const expectedParams = {
      limit: 2,
      before: "previous-page",
      domain: fixture.existingDomain,
    };
    expect(fixture.client.routes.list).toHaveBeenCalledWith(expectedParams);
    expect(fixture.client.routes.iterate).toHaveBeenCalledWith(expectedParams);
    expect(fixture.client.routes.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.anything() }),
    );
    expect(registry.primary.get("getRoutes")?.iterator).toMatchObject({
      operationId: "getRoutes",
      method: "iterate",
    });
  });

  it("requires the packaged scoped-list rule and supplies its controlled domain filter", async () => {
    const fixture = routeClientFixture();
    const options = {
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomain,
        replacement: fixture.replacementDomain,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    };
    const registry = createRouteScenarioRegistry(options);

    const result = await runRouteLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(fixture.authorizationChecks).toContain("list:query.domain");
    expect(result.operationResults.find(({ operationId }) => operationId === "getRoutes")).toEqual({
      operationId: "getRoutes",
      status: "passed",
      evidence: {
        direction: "forward",
        limit: 1,
        pageItems: 0,
        scopedAuthorization: {
          domainFilterSupplied: true,
          source: "query.domain",
        },
      },
    });
    expect(() =>
      createRouteScenarioRegistry({
        ...options,
        authorization: {
          ...RESOURCE_AUTHORIZATION,
          getRoutes: {
            ...RESOURCE_AUTHORIZATION.getRoutes,
            queryParameter: "sender_domain",
          },
        } as never,
      }),
    ).toThrow("must require the domain query for scoped access");
  });

  it("checks controlled create, existing, and replacement recipient domains", async () => {
    const fixture = routeClientFixture();
    const createRegistry = (
      overrides: Partial<Parameters<typeof createRouteScenarioRegistry>[0]> = {},
    ) =>
      createRouteScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        authorization: RESOURCE_AUTHORIZATION,
        controlledDomains: {
          existing: fixture.existingDomain,
          replacement: fixture.replacementDomain,
        },
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
        ...overrides,
      });

    expect(() =>
      createRegistry({
        createRequest: {
          ...fixture.createRequest,
          recipient: "inbound@uncontrolled.example",
        },
      }),
    ).toThrow("create request recipient must use its controlled route domain");
    expect(() =>
      createRegistry({
        updateRequest: {
          ...fixture.updateRequest,
          recipient: "replacement@uncontrolled.example",
        },
      }),
    ).toThrow("update request recipient must use its controlled route domain");

    const result = await runRouteLiveScenarios(createRegistry());

    expect(result.failure).toBeNull();
    expect(fixture.client.routes.create).toHaveBeenCalledWith(fixture.createRequest);
    expect(fixture.client.routes.update).toHaveBeenCalledWith(
      fixture.routeId,
      fixture.updateRequest,
    );
    expect(fixture.authorizationChecks).toEqual([
      "list:query.domain",
      "create:body.recipient",
      "update:existing.recipient",
      "update:body.recipient",
    ]);
    expect(
      result.operationResults.find(({ operationId }) => operationId === "createRoute"),
    ).toMatchObject({
      evidence: {
        recipientAuthorization: {
          controlled: true,
          quantifier: "one",
          source: "body.recipient",
        },
      },
    });
    expect(
      result.operationResults.find(({ operationId }) => operationId === "updateRoute"),
    ).toMatchObject({
      evidence: {
        recipientAuthorization: {
          existingControlled: true,
          quantifier: "every",
          replacementControlled: true,
          sources: ["existing.recipient", "body.recipient"],
        },
      },
    });
  });

  it("retains immediate route cleanup when the one-time secret is malformed", async () => {
    const fixture = routeClientFixture({ malformedSecret: true });
    const registry = createRouteScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomain,
        replacement: fixture.replacementDomain,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    });

    const result = await runRouteLiveScenarios(registry);

    expect(result.failure).toEqual({ phase: "operation", operationId: "createRoute" });
    expect(result.cleanupResults).toEqual([
      { label: "delete and verify route fixture", status: "passed" },
    ]);
    expect(fixture.client.routes.delete).toHaveBeenCalledWith(fixture.routeId);
    await expect(fixture.getRoute(fixture.routeId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("keeps route secrets and controlled recipients out of canonical live reports", async () => {
    const candidate = inspectFixture();
    const fixture = routeClientFixture();
    const registry = createRouteScenarioRegistry({
      profile: candidate.profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomain,
        replacement: fixture.replacementDomain,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    });
    const result = await runRouteLiveScenarios(registry);
    const report = createLiveReport({
      candidate,
      operationResults: result.operationResults,
      iteratorResults: result.iteratorResults,
      cleanupResults: result.cleanupResults,
    });
    const source = canonicalizeJson(report).toString("utf8");

    expect(source).not.toContain(fixture.routeSecret);
    expect(source).not.toContain(fixture.existingRecipient);
    expect(source).not.toContain(fixture.replacementRecipient);
    expect(source).not.toContain(fixture.existingDomain);
    expect(source).not.toContain(fixture.replacementDomain);
    expect(source).not.toContain('"secret"');
    expect(source).toContain('"secretsReported":false');
    expect(source).toContain('"sources":["existing.recipient","body.recipient"]');
  });

  it("registers exactly one executable scenario for every packaged configured-webhook primary", () => {
    const fixture = webhookClientFixture();
    const registry = createWebhookScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomains,
        newlySupplied: fixture.newlySuppliedDomains,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    });
    const webhookEntries = [...registry.primary.values()].filter(
      ({ facade }) => facade === "webhooks",
    );

    expect(webhookEntries.map(({ operationId }) => operationId).sort()).toEqual(
      ["createWebhook", "deleteWebhook", "getWebhook", "getWebhooks", "updateWebhook"].sort(),
    );
    expect(webhookEntries).toHaveLength(5);
    expect(webhookEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, WebhookLiveClient>>().toEqualTypeOf<true>();
  });

  it("records the configured-webhook iterator once with positive single-direction pagination", async () => {
    const fixture = webhookClientFixture();
    const registry = createWebhookScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomains,
        newlySupplied: fixture.newlySuppliedDomains,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
      pagination: { limit: 2, after: "next-page" },
    });

    const result = await runWebhookLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(
      result.operationResults.filter(({ operationId }) => operationId === "getWebhooks"),
    ).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "getWebhooks",
        status: "passed",
        evidence: { direction: "forward", items: 0, limit: 2 },
      },
    ]);
    const expectedParams = { limit: 2, after: "next-page" };
    expect(fixture.client.webhooks.list).toHaveBeenCalledWith(expectedParams);
    expect(fixture.client.webhooks.iterate).toHaveBeenCalledWith(expectedParams);
    expect(fixture.client.webhooks.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ before: expect.anything() }),
    );
    expect(registry.primary.get("getWebhooks")?.iterator).toMatchObject({
      operationId: "getWebhooks",
      method: "iterate",
    });
  });

  it("verifies every scoped creation domain and the existing webhook associations", async () => {
    const fixture = webhookClientFixture();
    const options = {
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomains,
        newlySupplied: fixture.newlySuppliedDomains,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    };

    expect(() =>
      createWebhookScenarioRegistry({
        ...options,
        createRequest: {
          ...fixture.createRequest,
          domains: [fixture.existingDomains[0], "uncontrolled.example"],
        },
      }),
    ).toThrow("domains must contain every controlled domain");

    const result = await runWebhookLiveScenarios(createWebhookScenarioRegistry(options));

    expect(result.failure).toBeNull();
    expect(fixture.client.webhooks.create).toHaveBeenCalledWith(fixture.createRequest);
    expect(fixture.authorizationChecks.slice(0, 2)).toEqual(
      fixture.existingDomains.map((domain) => `create:body.domains:${domain}`),
    );
    expect(
      result.operationResults.find(({ operationId }) => operationId === "createWebhook"),
    ).toMatchObject({
      evidence: {
        scopedAuthorization: {
          controlled: true,
          domainsVerified: 2,
          quantifier: "every",
          source: "body.domains",
        },
      },
    });
    expect(
      result.operationResults.find(({ operationId }) => operationId === "getWebhook"),
    ).toMatchObject({
      evidence: { existingAssociationsVerified: 2 },
    });
  });

  it("checks existing and new domains, clears scoped domains, and requires global transition auth", async () => {
    const fixture = webhookClientFixture();
    const options = {
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomains,
        newlySupplied: fixture.newlySuppliedDomains,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    };

    expect(() =>
      createWebhookScenarioRegistry({
        ...options,
        authorization: {
          ...RESOURCE_AUTHORIZATION,
          updateWebhook: {
            ...RESOURCE_AUTHORIZATION.updateWebhook,
            transition: "scoped_only",
          },
        } as never,
      }),
    ).toThrow("require the global role for global transitions");

    const result = await runWebhookLiveScenarios(createWebhookScenarioRegistry(options));

    expect(result.failure).toBeNull();
    expect(fixture.client.webhooks.update).toHaveBeenNthCalledWith(
      1,
      fixture.webhookId,
      fixture.updateRequest,
    );
    expect(fixture.client.webhooks.update).toHaveBeenNthCalledWith(2, fixture.webhookId, {
      scope: "scoped",
      domains: [],
    });
    expect(fixture.client.webhooks.update).toHaveBeenNthCalledWith(3, fixture.webhookId, {
      scope: "global",
    });
    expect(fixture.authorizationChecks).toEqual([
      ...fixture.existingDomains.map((domain) => `create:body.domains:${domain}`),
      ...fixture.existingDomains.map((domain) => `update:existing.domains:${domain}`),
      ...fixture.newlySuppliedDomains.map((domain) => `update:body.domains:${domain}`),
      ...fixture.newlySuppliedDomains.map((domain) => `update:existing.domains:${domain}`),
      "update:global-role",
    ]);
    expect(
      result.operationResults.find(({ operationId }) => operationId === "updateWebhook"),
    ).toMatchObject({
      evidence: {
        domainAuthorization: {
          existingAssociationsVerified: 2,
          existingSource: "existing.domains",
          globalRoleRequired: true,
          newDomainsVerified: 2,
          newSource: "body.domains",
          quantifier: "every",
          scopeSource: "body.scope",
        },
        globalTransitionVerified: true,
        scopedClearingVerified: true,
      },
    });
  });

  it("retains immediate configured-webhook cleanup when its one-time secret is malformed", async () => {
    const fixture = webhookClientFixture({ malformedSecret: true });
    const registry = createWebhookScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomains,
        newlySupplied: fixture.newlySuppliedDomains,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    });

    const result = await runWebhookLiveScenarios(registry);

    expect(result.failure).toEqual({ phase: "operation", operationId: "createWebhook" });
    expect(result.cleanupResults).toEqual([
      { label: "delete and verify configured-webhook fixture", status: "passed" },
    ]);
    expect(fixture.client.webhooks.delete).toHaveBeenCalledWith(fixture.webhookId);
    await expect(fixture.getWebhook(fixture.webhookId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("keeps configured-webhook secrets and controlled domains out of canonical live reports", async () => {
    const candidate = inspectFixture();
    const fixture = webhookClientFixture();
    const registry = createWebhookScenarioRegistry({
      profile: candidate.profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: {
        existing: fixture.existingDomains,
        newlySupplied: fixture.newlySuppliedDomains,
      },
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    });
    const result = await runWebhookLiveScenarios(registry);
    const report = createLiveReport({
      candidate,
      operationResults: result.operationResults,
      iteratorResults: result.iteratorResults,
      cleanupResults: result.cleanupResults,
    });
    const source = canonicalizeJson(report).toString("utf8");

    expect(source).not.toContain(fixture.webhookSecret);
    for (const domain of [...fixture.existingDomains, ...fixture.newlySuppliedDomains]) {
      expect(source).not.toContain(domain);
    }
    expect(source).not.toContain('"secret"');
    expect(source).toContain('"secretsReported":false');
    expect(source).toContain('"globalRoleRequired":true');
  });

  it("registers each packaged SMTP-credential primary once and has no update scenario", () => {
    const fixture = smtpCredentialClientFixture();
    const registry = createSMTPCredentialScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: fixture.controlledDomains,
      scopedCreateRequest: fixture.scopedCreateRequest,
      globalCreateRequest: fixture.globalCreateRequest,
    });
    const smtpEntries = [...registry.primary.values()].filter(
      ({ facade }) => facade === "smtpCredentials",
    );

    expect(smtpEntries.map(({ operationId }) => operationId).sort()).toEqual(
      [
        "createSMTPCredential",
        "deleteSMTPCredential",
        "getSMTPCredential",
        "getSMTPCredentials",
      ].sort(),
    );
    expect(smtpEntries).toHaveLength(4);
    expect(smtpEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(
      smtpEntries.some(
        ({ operationId, method }) => operationId.includes("update") || method === "update",
      ),
    ).toBe(false);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, SMTPCredentialLiveClient>>().toEqualTypeOf<true>();
  });

  it("records the SMTP iterator once with positive single-direction pagination", async () => {
    const fixture = smtpCredentialClientFixture();
    const registry = createSMTPCredentialScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: fixture.controlledDomains,
      scopedCreateRequest: fixture.scopedCreateRequest,
      globalCreateRequest: fixture.globalCreateRequest,
      pagination: { limit: 2, before: "previous-page" },
    });

    const result = await runSMTPCredentialLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(
      result.operationResults.filter(({ operationId }) => operationId === "getSMTPCredentials"),
    ).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "getSMTPCredentials",
        status: "passed",
        evidence: { direction: "backward", items: 0, limit: 2 },
      },
    ]);
    const expectedParams = { limit: 2, before: "previous-page" };
    expect(fixture.client.smtpCredentials.list).toHaveBeenCalledWith(expectedParams);
    expect(fixture.client.smtpCredentials.iterate).toHaveBeenCalledWith(expectedParams);
    expect(fixture.client.smtpCredentials.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.anything() }),
    );
    expect(registry.primary.get("getSMTPCredentials")?.iterator).toMatchObject({
      operationId: "getSMTPCredentials",
      method: "iterate",
    });
  });

  it("verifies every scoped SMTP domain and accepted global-domain behavior", async () => {
    const fixture = smtpCredentialClientFixture();
    const options = {
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: fixture.controlledDomains,
      scopedCreateRequest: fixture.scopedCreateRequest,
      globalCreateRequest: fixture.globalCreateRequest,
    };

    expect(() =>
      createSMTPCredentialScenarioRegistry({
        ...options,
        scopedCreateRequest: {
          ...fixture.scopedCreateRequest,
          domains: [fixture.controlledDomains[0], "uncontrolled.example"],
        },
      }),
    ).toThrow("domains must contain every controlled domain");

    const result = await runSMTPCredentialLiveScenarios(
      createSMTPCredentialScenarioRegistry(options),
    );

    expect(result.failure).toBeNull();
    expect(fixture.client.smtpCredentials.create).toHaveBeenNthCalledWith(
      1,
      fixture.scopedCreateRequest,
    );
    expect(fixture.client.smtpCredentials.create).toHaveBeenNthCalledWith(
      2,
      fixture.globalCreateRequest,
    );
    expect(fixture.authorizationChecks).toEqual([
      ...fixture.controlledDomains.map((domain) => `create:body.domains:${domain}`),
      "create:global-role",
    ]);
    expect(
      result.operationResults.find(({ operationId }) => operationId === "createSMTPCredential"),
    ).toMatchObject({
      evidence: {
        cleanupRegistered: 2,
        globalAuthorization: {
          domainsSupplied: 2,
          globalRoleRequired: true,
          scopeSource: "body.scope",
          suppliedDomainsIgnored: true,
        },
        scopedAuthorization: {
          controlled: true,
          domainsVerified: 2,
          quantifier: "every",
          source: "body.domains",
        },
      },
    });
    expect(
      result.operationResults.find(({ operationId }) => operationId === "getSMTPCredential"),
    ).toMatchObject({
      evidence: { scopedDomainsVerified: 2 },
    });

    const invalidGlobalFixture = smtpCredentialClientFixture({
      preserveGlobalDomains: true,
    });
    const invalidGlobalResult = await runSMTPCredentialLiveScenarios(
      createSMTPCredentialScenarioRegistry({
        profile: inspectFixture().profile,
        client: invalidGlobalFixture.client,
        authorization: RESOURCE_AUTHORIZATION,
        controlledDomains: invalidGlobalFixture.controlledDomains,
        scopedCreateRequest: invalidGlobalFixture.scopedCreateRequest,
        globalCreateRequest: invalidGlobalFixture.globalCreateRequest,
      }),
    );
    expect(invalidGlobalResult.failure).toEqual({
      phase: "operation",
      operationId: "createSMTPCredential",
    });
  });

  it("registers SMTP cleanup before validating each one-time password", async () => {
    const fixture = smtpCredentialClientFixture({ malformedPasswordScope: "global" });
    const registry = createSMTPCredentialScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: fixture.controlledDomains,
      scopedCreateRequest: fixture.scopedCreateRequest,
      globalCreateRequest: fixture.globalCreateRequest,
    });

    const result = await runSMTPCredentialLiveScenarios(registry);

    expect(result.failure).toEqual({
      phase: "operation",
      operationId: "createSMTPCredential",
    });
    expect(result.cleanupResults).toEqual([
      { label: "delete and verify global SMTP-credential fixture", status: "passed" },
      { label: "delete and verify scoped SMTP-credential fixture", status: "passed" },
    ]);
    expect(fixture.client.smtpCredentials.delete).toHaveBeenCalledWith(fixture.globalCredentialId);
    expect(fixture.client.smtpCredentials.delete).toHaveBeenCalledWith(fixture.scopedCredentialId);
    expect(fixture.records.size).toBe(0);
  });

  it("keeps SMTP passwords and controlled domains out of canonical live reports", async () => {
    const candidate = inspectFixture();
    const fixture = smtpCredentialClientFixture();
    const registry = createSMTPCredentialScenarioRegistry({
      profile: candidate.profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      controlledDomains: fixture.controlledDomains,
      scopedCreateRequest: fixture.scopedCreateRequest,
      globalCreateRequest: fixture.globalCreateRequest,
    });
    const result = await runSMTPCredentialLiveScenarios(registry);
    const report = createLiveReport({
      candidate,
      operationResults: result.operationResults,
      iteratorResults: result.iteratorResults,
      cleanupResults: result.cleanupResults,
    });
    const source = canonicalizeJson(report).toString("utf8");

    expect(source).not.toContain(fixture.scopedPassword);
    expect(source).not.toContain(fixture.globalPassword);
    for (const domain of fixture.controlledDomains) {
      expect(source).not.toContain(domain);
    }
    expect(source).not.toContain('"password"');
    expect(source).toContain('"secretsReported":false');
    expect(source).toContain('"suppliedDomainsIgnored":true');
  });

  it("registers exactly one executable scenario for every packaged account primary", () => {
    const fixture = accountClientFixture();
    const registry = createAccountScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      disposableAccountId: fixture.accountId,
      disposableMailbox: fixture.disposableMailbox,
      updateRequest: fixture.updateRequest,
      memberRequest: fixture.memberRequest,
    });
    const accountEntries = [...registry.primary.values()].filter(
      ({ facade }) => facade === "accounts",
    );

    expect(accountEntries.map(({ operationId }) => operationId).sort()).toEqual(
      [
        "getAccount",
        "updateAccount",
        "getAccountMembers",
        "addAccountMember",
        "removeAccountMember",
      ].sort(),
    );
    expect(accountEntries).toHaveLength(5);
    expect(accountEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.iterators.filter(({ facade }) => facade === "accounts")).toHaveLength(0);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, AccountLiveClient>>().toEqualTypeOf<true>();
  });

  it("captures all mutable account state and restores and verifies it after the lifecycle", async () => {
    const fixture = accountClientFixture();
    const result = await runAccountLiveScenarios(
      createAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        disposableAccountId: fixture.accountId,
        disposableMailbox: fixture.disposableMailbox,
        updateRequest: fixture.updateRequest,
        memberRequest: fixture.memberRequest,
      }),
    );

    expect(result.failure).toBeNull();
    expect(result.operationResults).toHaveLength(5);
    expect(result.iteratorResults).toEqual([]);
    expect(fixture.updateRequests).toEqual([
      fixture.updateRequest,
      {
        track_opens: fixture.priorState.track_opens,
        track_clicks: fixture.priorState.track_clicks,
      },
    ]);
    expect(fixture.account).toMatchObject(fixture.priorState);
    expect(result.cleanupResults).toEqual([
      { label: "remove and verify disposable account member", status: "passed" },
      { label: "restore and verify disposable parent account", status: "passed" },
    ]);
    expect(
      result.operationResults.find(({ operationId }) => operationId === "updateAccount"),
    ).toMatchObject({
      evidence: {
        priorStateCaptured: 9,
        restorationRegistered: true,
        updatedFields: 2,
      },
    });
    expect(fixture.calls.slice(-2)).toEqual(["update", "get"]);
  });

  it("registers account restoration before applying a mutation that can fail", async () => {
    const fixture = accountClientFixture({ failMutation: true });
    const result = await runAccountLiveScenarios(
      createAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        disposableAccountId: fixture.accountId,
        disposableMailbox: fixture.disposableMailbox,
        updateRequest: fixture.updateRequest,
        memberRequest: fixture.memberRequest,
      }),
    );

    expect(result.failure).toEqual({ phase: "operation", operationId: "updateAccount" });
    expect(fixture.updateRequests).toEqual([
      fixture.updateRequest,
      {
        track_opens: fixture.priorState.track_opens,
        track_clicks: fixture.priorState.track_clicks,
      },
    ]);
    expect(result.cleanupResults).toEqual([
      { label: "restore and verify disposable parent account", status: "passed" },
    ]);
    expect(fixture.account).toMatchObject(fixture.priorState);
  });

  it("uses only the dedicated disposable account and mailbox for member mutation", async () => {
    const fixture = accountClientFixture({ malformedMemberResult: true });
    const options = {
      profile: inspectFixture().profile,
      client: fixture.client,
      disposableAccountId: fixture.accountId,
      disposableMailbox: fixture.disposableMailbox,
      updateRequest: fixture.updateRequest,
      memberRequest: fixture.memberRequest,
    };

    expect(() =>
      createAccountScenarioRegistry({
        ...options,
        disposableAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toThrow("disposable parent account");
    expect(() =>
      createAccountScenarioRegistry({
        ...options,
        memberRequest: { ...fixture.memberRequest, email: "someone-else@example.test" },
      }),
    ).toThrow("disposable member mailbox");

    const result = await runAccountLiveScenarios(createAccountScenarioRegistry(options));

    expect(result.failure).toEqual({ phase: "operation", operationId: "addAccountMember" });
    expect(fixture.client.accounts.addMember).toHaveBeenCalledWith(fixture.memberRequest);
    expect(fixture.client.accounts.removeMember).toHaveBeenCalledWith(fixture.memberId);
    expect(fixture.members.size).toBe(0);
    expect(result.cleanupResults).toEqual([
      { label: "remove and verify disposable account member", status: "passed" },
      { label: "restore and verify disposable parent account", status: "passed" },
    ]);
  });

  it("records restoration and member-removal failures as release-blocking cleanup failures", async () => {
    const restorationFixture = accountClientFixture({ failRestoration: true });
    const restorationResult = await runAccountLiveScenarios(
      createAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: restorationFixture.client,
        disposableAccountId: restorationFixture.accountId,
        disposableMailbox: restorationFixture.disposableMailbox,
        updateRequest: restorationFixture.updateRequest,
        memberRequest: restorationFixture.memberRequest,
      }),
    );
    expect(restorationResult.failure).toEqual({ phase: "cleanup" });
    expect(restorationResult.cleanupResults).toContainEqual({
      label: "restore and verify disposable parent account",
      status: "failed",
    });

    const memberFixture = accountClientFixture({ failMemberCleanup: true });
    const memberResult = await runAccountLiveScenarios(
      createAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: memberFixture.client,
        disposableAccountId: memberFixture.accountId,
        disposableMailbox: memberFixture.disposableMailbox,
        updateRequest: memberFixture.updateRequest,
        memberRequest: memberFixture.memberRequest,
      }),
    );
    expect(memberResult.failure).toEqual({ phase: "cleanup" });
    expect(memberResult.cleanupResults).toContainEqual({
      label: "remove and verify disposable account member",
      status: "failed",
    });
  });

  it("keeps account mutation and invitation data out of canonical live reports", async () => {
    const candidate = inspectFixture();
    const fixture = accountClientFixture();
    const result = await runAccountLiveScenarios(
      createAccountScenarioRegistry({
        profile: candidate.profile,
        client: fixture.client,
        disposableAccountId: fixture.accountId,
        disposableMailbox: fixture.disposableMailbox,
        updateRequest: fixture.updateRequest,
        memberRequest: fixture.memberRequest,
      }),
    );
    const source = canonicalizeJson(
      createLiveReport({
        candidate,
        operationResults: result.operationResults,
        cleanupResults: result.cleanupResults,
      }),
    ).toString("utf8");

    expect(source).not.toContain(fixture.disposableMailbox);
    expect(source).not.toContain(fixture.memberRequest.name);
    expect(source).not.toContain(fixture.memberId);
    expect(source).not.toContain(fixture.priorState.about);
    expect(source).not.toContain(fixture.priorState.website);
    expect(source).toContain('"disposableMailboxUsed":true');
    expect(source).toContain('"invitationDataReported":false');
  });

  it("registers exactly one executable scenario for every packaged suppression primary", () => {
    const fixture = suppressionClientFixture();
    const registry = createSuppressionScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      disposableDomain: fixture.disposableDomain,
      createRequest: fixture.createRequest,
      wipeCreateRequest: fixture.wipeCreateRequest,
    });
    const suppressionEntries = [...registry.primary.values()].filter(
      ({ facade }) => facade === "suppressions",
    );

    expect(suppressionEntries.map(({ operationId }) => operationId).sort()).toEqual(
      ["getSuppressions", "createSuppression", "deleteSuppression", "deleteAllSuppressions"].sort(),
    );
    expect(suppressionEntries).toHaveLength(4);
    expect(suppressionEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, SuppressionLiveClient>>().toEqualTypeOf<true>();
  });

  it("links suppression iteration to the list primary without a duplicate primary scenario", async () => {
    const fixture = suppressionClientFixture();
    const registry = createSuppressionScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      disposableDomain: fixture.disposableDomain,
      createRequest: fixture.createRequest,
      wipeCreateRequest: fixture.wipeCreateRequest,
    });
    const result = await runSuppressionLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(
      result.operationResults.filter(({ operationId }) => operationId === "getSuppressions"),
    ).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "getSuppressions",
        status: "passed",
        evidence: { direction: "forward", items: 1, limit: 1 },
      },
    ]);
    expect(registry.iterators.filter(({ facade }) => facade === "suppressions")).toHaveLength(1);
    expect(registry.primary.get("getSuppressions")?.iterator).toMatchObject({
      operationId: "getSuppressions",
      method: "iterate",
    });
  });

  it("uses positive single-direction suppression pagination for list and iteration", async () => {
    const fixture = suppressionClientFixture();
    const pagination = { limit: 2, before: "previous-page" };
    const registry = createSuppressionScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      disposableDomain: fixture.disposableDomain,
      createRequest: fixture.createRequest,
      wipeCreateRequest: fixture.wipeCreateRequest,
      pagination,
    });
    const result = await runSuppressionLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(fixture.client.suppressions.list).toHaveBeenNthCalledWith(1, pagination);
    expect(fixture.client.suppressions.iterate).toHaveBeenCalledOnce();
    expect(fixture.client.suppressions.iterate).toHaveBeenCalledWith(pagination);
    expect(fixture.client.suppressions.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.anything() }),
    );
    expect(result.iteratorResults[0]).toMatchObject({
      evidence: { direction: "backward", limit: 2 },
    });

    expect(() =>
      createSuppressionScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        disposableDomain: fixture.disposableDomain,
        createRequest: fixture.createRequest,
        wipeCreateRequest: fixture.wipeCreateRequest,
        pagination: { limit: 0 },
      }),
    ).toThrow("limit must be an integer from 1 to 100");
  });

  it("wipes only the disposable suppression domain and verifies removal immediately", async () => {
    const fixture = suppressionClientFixture();
    const result = await runSuppressionLiveScenarios(
      createSuppressionScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        disposableDomain: fixture.disposableDomain,
        createRequest: fixture.createRequest,
        wipeCreateRequest: fixture.wipeCreateRequest,
      }),
    );

    expect(result.failure).toBeNull();
    expect(fixture.client.suppressions.wipe).toHaveBeenCalledOnce();
    expect(fixture.client.suppressions.wipe).toHaveBeenCalledWith({
      domain: fixture.disposableDomain,
    });
    expect(fixture.records.has(`${fixture.outside.email}|${fixture.outside.domain}`)).toBe(true);
    expect(
      result.operationResults.find(({ operationId }) => operationId === "deleteAllSuppressions"),
    ).toMatchObject({
      evidence: {
        cleanupRegistered: true,
        cleanupVerified: true,
        domainScoped: true,
      },
    });
  });

  it("registers suppression cleanup before validation and drains it in reverse creation order", async () => {
    const malformedFixture = suppressionClientFixture({ malformedCreate: "create" });
    const malformedResult = await runSuppressionLiveScenarios(
      createSuppressionScenarioRegistry({
        profile: inspectFixture().profile,
        client: malformedFixture.client,
        disposableDomain: malformedFixture.disposableDomain,
        createRequest: malformedFixture.createRequest,
        wipeCreateRequest: malformedFixture.wipeCreateRequest,
      }),
    );

    expect(malformedResult.failure).toEqual({
      phase: "operation",
      operationId: "createSuppression",
    });
    expect(malformedResult.cleanupResults).toEqual([
      { label: "delete and verify disposable suppression fixture", status: "passed" },
    ]);

    const fixture = suppressionClientFixture();
    const result = await runSuppressionLiveScenarios(
      createSuppressionScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        disposableDomain: fixture.disposableDomain,
        createRequest: fixture.createRequest,
        wipeCreateRequest: fixture.wipeCreateRequest,
      }),
    );
    expect(result.cleanupResults).toEqual([
      { label: "delete and verify disposable wipe suppression fixture", status: "passed" },
      { label: "delete and verify disposable suppression fixture", status: "passed" },
    ]);

    const cleanupFailureFixture = suppressionClientFixture({ failCleanup: true });
    const cleanupFailureResult = await runSuppressionLiveScenarios(
      createSuppressionScenarioRegistry({
        profile: inspectFixture().profile,
        client: cleanupFailureFixture.client,
        disposableDomain: cleanupFailureFixture.disposableDomain,
        createRequest: cleanupFailureFixture.createRequest,
        wipeCreateRequest: cleanupFailureFixture.wipeCreateRequest,
      }),
    );
    expect(cleanupFailureResult.failure).toEqual({ phase: "cleanup" });
    expect(cleanupFailureResult.cleanupResults).toEqual([
      { label: "delete and verify disposable wipe suppression fixture", status: "failed" },
      { label: "delete and verify disposable suppression fixture", status: "passed" },
    ]);
  });

  it("reports suppression lifecycle and cleanup evidence without disposable data", async () => {
    const candidate = inspectFixture();
    const fixture = suppressionClientFixture();
    const result = await runSuppressionLiveScenarios(
      createSuppressionScenarioRegistry({
        profile: candidate.profile,
        client: fixture.client,
        disposableDomain: fixture.disposableDomain,
        createRequest: fixture.createRequest,
        wipeCreateRequest: fixture.wipeCreateRequest,
      }),
    );
    const source = canonicalizeJson(
      createLiveReport({
        candidate,
        operationResults: result.operationResults,
        iteratorResults: result.iteratorResults,
        cleanupResults: result.cleanupResults,
      }),
    ).toString("utf8");

    expect(source).not.toContain(fixture.createRequest.email);
    expect(source).not.toContain(fixture.wipeCreateRequest.email);
    expect(source).not.toContain(fixture.disposableDomain);
    expect(source).not.toContain(fixture.createRequest.reason);
    expect(source).toContain('"disposableDataUsed":true');
    expect(source).toContain('"domainScoped":true');
    expect(source).toContain('"cleanupVerified":true');
  });

  it("registers exactly one executable scenario for every packaged parent sub-account primary", () => {
    const fixture = subAccountClientFixture();
    const registry = createSubAccountScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
      suspendRequest: fixture.suspendRequest,
    });
    const entries = [...registry.primary.values()].filter(({ facade }) => facade === "subAccounts");

    expect(entries.map(({ operationId }) => operationId).sort()).toEqual(
      [
        "listSubAccounts",
        "createSubAccount",
        "getSubAccountsUsage",
        "getSubAccount",
        "updateSubAccount",
        "deleteSubAccount",
        "suspendSubAccount",
        "unsuspendSubAccount",
      ].sort(),
    );
    expect(entries).toHaveLength(8);
    expect(entries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, SubAccountLiveClient>>().toEqualTypeOf<true>();
  });

  it("links parent sub-account iteration to one positive single-direction list scenario", async () => {
    const fixture = subAccountClientFixture();
    const pagination = { limit: 2, after: "next-page" };
    const registry = createSubAccountScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
      suspendRequest: fixture.suspendRequest,
      pagination,
    });
    const result = await runSubAccountLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(
      result.operationResults.filter(({ operationId }) => operationId === "listSubAccounts"),
    ).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "listSubAccounts",
        status: "passed",
        evidence: { direction: "forward", items: 1, limit: 2 },
      },
    ]);
    expect(fixture.client.subAccounts.list).toHaveBeenNthCalledWith(1, pagination);
    expect(fixture.client.subAccounts.iterate).toHaveBeenCalledOnce();
    expect(fixture.client.subAccounts.iterate).toHaveBeenCalledWith(pagination);
    expect(registry.iterators.filter(({ facade }) => facade === "subAccounts")).toHaveLength(1);
    expect(registry.primary.get("listSubAccounts")?.iterator).toMatchObject({
      operationId: "listSubAccounts",
      method: "iterate",
    });

    expect(() =>
      createSubAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
        suspendRequest: fixture.suspendRequest,
        pagination: { limit: 0 },
      }),
    ).toThrow("limit must be an integer from 1 to 100");
  });

  it("validates sub-account usage as finite numbers with safe int64 counts", async () => {
    const fixture = subAccountClientFixture();
    const result = await runSubAccountLiveScenarios(
      createSubAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
        suspendRequest: fixture.suspendRequest,
      }),
    );

    expect(result.failure).toBeNull();
    expect(fixture.client.subAccounts.usage).toHaveBeenCalledOnce();
    expect(
      result.operationResults.find(({ operationId }) => operationId === "getSubAccountsUsage"),
    ).toMatchObject({
      status: "passed",
      evidence: {
        allocationMethod: "proportional",
        safeIntegersVerified: true,
        subAccountBuckets: 2,
      },
    });

    const unsafeFixture = subAccountClientFixture({ unsafeUsage: true });
    const unsafeResult = await runSubAccountLiveScenarios(
      createSubAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: unsafeFixture.client,
        createRequest: unsafeFixture.createRequest,
        updateRequest: unsafeFixture.updateRequest,
        suspendRequest: unsafeFixture.suspendRequest,
      }),
    );
    expect(unsafeResult.failure).toEqual({
      phase: "operation",
      operationId: "getSubAccountsUsage",
    });
    expect(unsafeResult.cleanupResults).toEqual([
      { label: "delete and verify disposable sub-account fixture", status: "passed" },
    ]);
  });

  it("verifies active, suspended, restored, and deleted sub-account lifecycle states", async () => {
    const fixture = subAccountClientFixture();
    const result = await runSubAccountLiveScenarios(
      createSubAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
        suspendRequest: fixture.suspendRequest,
      }),
    );

    expect(result.failure).toBeNull();
    expect(fixture.client.subAccounts.suspend).toHaveBeenCalledWith(
      fixture.childId,
      fixture.suspendRequest,
    );
    expect(fixture.client.subAccounts.unsuspend).toHaveBeenCalledWith(fixture.childId);
    expect(
      result.operationResults.find(({ operationId }) => operationId === "suspendSubAccount"),
    ).toMatchObject({
      evidence: { status: "suspended", transitionVerified: true },
    });
    expect(
      result.operationResults.find(({ operationId }) => operationId === "unsuspendSubAccount"),
    ).toMatchObject({
      evidence: { status: "active", transitionVerified: true },
    });
    expect(
      result.operationResults.find(({ operationId }) => operationId === "deleteSubAccount"),
    ).toMatchObject({
      evidence: { cleanupVerified: true, deleted: true },
    });
    expect(fixture.records.has(fixture.childId)).toBe(false);
    expect(fixture.calls).toEqual(
      expect.arrayContaining([
        "create",
        "usage",
        "update",
        `suspend:${fixture.suspendRequest.reason}`,
        "unsuspend",
        "delete",
      ]),
    );
  });

  it("registers sub-account cleanup before validation and reports cleanup failures", async () => {
    const malformedFixture = subAccountClientFixture({ malformedCreate: true });
    const malformedResult = await runSubAccountLiveScenarios(
      createSubAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: malformedFixture.client,
        createRequest: malformedFixture.createRequest,
        updateRequest: malformedFixture.updateRequest,
        suspendRequest: malformedFixture.suspendRequest,
      }),
    );

    expect(malformedResult.failure).toEqual({
      phase: "operation",
      operationId: "createSubAccount",
    });
    expect(malformedResult.cleanupResults).toEqual([
      { label: "delete and verify disposable sub-account fixture", status: "passed" },
    ]);
    expect(malformedFixture.records.has(malformedFixture.childId)).toBe(false);

    const cleanupFailureFixture = subAccountClientFixture({ failCleanup: true });
    const cleanupFailureResult = await runSubAccountLiveScenarios(
      createSubAccountScenarioRegistry({
        profile: inspectFixture().profile,
        client: cleanupFailureFixture.client,
        createRequest: cleanupFailureFixture.createRequest,
        updateRequest: cleanupFailureFixture.updateRequest,
        suspendRequest: cleanupFailureFixture.suspendRequest,
      }),
    );
    expect(cleanupFailureResult.failure).toEqual({ phase: "cleanup" });
    expect(cleanupFailureResult.cleanupResults).toEqual([
      { label: "delete and verify disposable sub-account fixture", status: "failed" },
    ]);
  });

  it("reports sub-account lifecycle evidence without disposable or secret material", async () => {
    const candidate = inspectFixture();
    const fixture = subAccountClientFixture();
    const result = await runSubAccountLiveScenarios(
      createSubAccountScenarioRegistry({
        profile: candidate.profile,
        client: fixture.client,
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
        suspendRequest: fixture.suspendRequest,
      }),
    );
    const source = canonicalizeJson(
      createLiveReport({
        candidate,
        operationResults: result.operationResults,
        iteratorResults: result.iteratorResults,
        cleanupResults: result.cleanupResults,
      }),
    ).toString("utf8");

    expect(source).not.toContain(fixture.childId);
    expect(source).not.toContain(fixture.accountId);
    expect(source).not.toContain(fixture.createRequest.name);
    expect(source).not.toContain(fixture.createRequest.website);
    expect(source).not.toContain(fixture.updateRequest.name);
    expect(source).not.toContain(fixture.suspendRequest.reason);
    expect(source).toContain('"cleanupRegistered":true');
    expect(source).toContain('"disposableDataReported":false');
    expect(source).toContain('"safeIntegersVerified":true');
    expect(source).toContain('"transitionVerified":true');
  });

  it("registers exactly one executable scenario for every packaged child API-key primary", () => {
    const fixture = subAccountAPIKeyClientFixture();
    const registry = createSubAccountAPIKeyScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      subAccountId: fixture.subAccountId,
      createChildClient: fixture.createChildClient,
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
    });
    const entries = [...registry.primary.values()].filter(
      ({ facade }) => facade === "subAccounts.apiKeys",
    );

    expect(entries.map(({ operationId }) => operationId).sort()).toEqual(
      [
        "listSubAccountAPIKeys",
        "createSubAccountAPIKey",
        "getSubAccountAPIKey",
        "updateSubAccountAPIKey",
        "deleteSubAccountAPIKey",
      ].sort(),
    );
    expect(entries).toHaveLength(5);
    expect(entries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, SubAccountAPIKeyLiveClient>>().toEqualTypeOf<true>();
  });

  it("links child-key iteration and preserves subaccount-before-key identifier order", async () => {
    const fixture = subAccountAPIKeyClientFixture();
    const pagination = { limit: 2, before: "previous-page" };
    const registry = createSubAccountAPIKeyScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      subAccountId: fixture.subAccountId,
      createChildClient: fixture.createChildClient,
      createRequest: fixture.createRequest,
      updateRequest: fixture.updateRequest,
      pagination,
    });

    const result = await runSubAccountAPIKeyLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(
      result.operationResults.filter(({ operationId }) => operationId === "listSubAccountAPIKeys"),
    ).toHaveLength(1);
    expect(result.iteratorResults).toEqual([
      {
        operationId: "listSubAccountAPIKeys",
        status: "passed",
        evidence: { direction: "backward", items: 1, limit: 2 },
      },
    ]);
    expect(fixture.client.subAccounts.apiKeys.list).toHaveBeenCalledWith(
      fixture.subAccountId,
      pagination,
    );
    expect(fixture.client.subAccounts.apiKeys.iterate).toHaveBeenCalledWith(
      fixture.subAccountId,
      pagination,
    );
    expect(fixture.client.subAccounts.apiKeys.create).toHaveBeenCalledWith(fixture.subAccountId, {
      ...fixture.createRequest,
      ip_allow_list: [],
    });
    expect(fixture.client.subAccounts.apiKeys.get).toHaveBeenCalledWith(
      fixture.subAccountId,
      fixture.keyId,
    );
    expect(fixture.client.subAccounts.apiKeys.update).toHaveBeenCalledWith(
      fixture.subAccountId,
      fixture.keyId,
      fixture.updateRequest,
    );
    expect(fixture.client.subAccounts.apiKeys.delete).toHaveBeenCalledWith(
      fixture.subAccountId,
      fixture.keyId,
    );
    expect(
      registry.iterators.filter(({ facade }) => facade === "subAccounts.apiKeys"),
    ).toHaveLength(1);
    expect(registry.primary.get("listSubAccountAPIKeys")?.iterator).toMatchObject({
      operationId: "listSubAccountAPIKeys",
      method: "iterate",
    });

    expect(() =>
      createSubAccountAPIKeyScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        subAccountId: fixture.subAccountId,
        createChildClient: fixture.createChildClient,
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
        pagination: { limit: 0 },
      }),
    ).toThrow("limit must be an integer from 1 to 100");
  });

  it("bootstraps only the child client and keeps nested-key authority on the parent", async () => {
    const fixture = subAccountAPIKeyClientFixture();
    const result = await runSubAccountAPIKeyLiveScenarios(
      createSubAccountAPIKeyScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        subAccountId: fixture.subAccountId,
        createChildClient: fixture.createChildClient,
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
      }),
    );

    expect(result.failure).toBeNull();
    expect(fixture.createChildClient).toHaveBeenCalledOnce();
    expect(fixture.createChildClient).toHaveBeenCalledWith(fixture.secret, fixture.subAccountId);
    expect(fixture.ping).toHaveBeenCalledOnce();
    expect(
      result.operationResults.find(({ operationId }) => operationId === "createSubAccountAPIKey"),
    ).toMatchObject({
      evidence: {
        bootstrapAuthenticated: true,
        parentManaged: true,
        secretsReported: false,
        unsupportedAuthorityGranted: false,
      },
    });

    for (const scope of ["sub-accounts:create", "sub-account-api-keys:write"]) {
      expect(() =>
        createSubAccountAPIKeyScenarioRegistry({
          profile: inspectFixture().profile,
          client: fixture.client,
          subAccountId: fixture.subAccountId,
          createChildClient: fixture.createChildClient,
          createRequest: { label: "unsafe child key", scopes: [scope] },
          updateRequest: fixture.updateRequest,
        }),
      ).toThrow("cannot grant child credentials sub-account management authority");
    }
  });

  it("registers child-key cleanup before validating the creation-only secret", async () => {
    const fixture = subAccountAPIKeyClientFixture({ malformedSecret: true });
    const result = await runSubAccountAPIKeyLiveScenarios(
      createSubAccountAPIKeyScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        subAccountId: fixture.subAccountId,
        createChildClient: fixture.createChildClient,
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
      }),
    );

    expect(result.failure).toEqual({
      phase: "operation",
      operationId: "createSubAccountAPIKey",
    });
    expect(result.cleanupResults).toEqual([
      { label: "delete and verify disposable child API-key fixture", status: "passed" },
    ]);
    expect(fixture.records.has(fixture.keyId)).toBe(false);
    expect(fixture.records.has(fixture.existingKeyId)).toBe(true);
    expect(fixture.createChildClient).not.toHaveBeenCalled();
  });

  it("keeps child-key secrets and disposable identifiers out of live reports", async () => {
    const candidate = inspectFixture();
    const fixture = subAccountAPIKeyClientFixture();
    const result = await runSubAccountAPIKeyLiveScenarios(
      createSubAccountAPIKeyScenarioRegistry({
        profile: candidate.profile,
        client: fixture.client,
        subAccountId: fixture.subAccountId,
        createChildClient: fixture.createChildClient,
        createRequest: fixture.createRequest,
        updateRequest: fixture.updateRequest,
      }),
    );
    const source = canonicalizeJson(
      createLiveReport({
        candidate,
        operationResults: result.operationResults,
        iteratorResults: result.iteratorResults,
        cleanupResults: result.cleanupResults,
        secrets: [fixture.secret, fixture.subAccountId, fixture.keyId],
      }),
    ).toString("utf8");

    expect(source).not.toContain(fixture.secret);
    expect(source).not.toContain(fixture.subAccountId);
    expect(source).not.toContain(fixture.keyId);
    expect(source).not.toContain(fixture.createRequest.label);
    expect(source).not.toContain(fixture.updateRequest.label);
    expect(source).not.toContain("secret_key");
    expect(source).toContain('"bootstrapAuthenticated":true');
    expect(source).toContain('"secretsReported":false');
    expect(source).toContain('"unsupportedAuthorityGranted":false');
  });

  it("registers exactly one executable scenario for every packaged statistics primary", () => {
    const fixture = statisticsClientFixture();
    const registry = createStatisticsScenarioRegistry({
      profile: inspectFixture().profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      senderDomains: fixture.senderDomains,
    });
    const statisticsEntries = [...registry.primary.values()].filter(
      ({ facade }) => facade === "statistics",
    );

    expect(statisticsEntries.map(({ operationId }) => operationId).sort()).toEqual(
      ["getBounceStatistics", "getDeliverabilityStatistics", "getDeliveryTimeStatistics"].sort(),
    );
    expect(statisticsEntries).toHaveLength(3);
    expect(statisticsEntries.every(({ run }) => typeof run === "function")).toBe(true);
    expect(registry.primary.size).toBe(56);
    expectTypeOf<IsAssignable<AhaSendClient, StatisticsLiveClient>>().toEqualTypeOf<true>();
  });

  it("dispatches single- and multi-domain statistics cases through packaged mappings", async () => {
    const candidate = inspectFixture();
    const fixture = statisticsClientFixture();
    const statistics = fixture.client.statistics;
    const original = {
      deliverability: statistics.deliverability as unknown as (params: unknown) => unknown,
      bounces: statistics.bounces as unknown as (params: unknown) => unknown,
      deliveryTimes: statistics.deliveryTimes as unknown as (params: unknown) => unknown,
    };
    const packagedMethods = {
      packagedDeliverability: vi.fn((params: unknown) => original.deliverability(params)),
      packagedBounces: vi.fn((params: unknown) => original.bounces(params)),
      packagedDeliveryTimes: vi.fn((params: unknown) => original.deliveryTimes(params)),
    };
    Object.assign(statistics, packagedMethods);
    const mappedMethods = new Map([
      ["getDeliverabilityStatistics", "packagedDeliverability"],
      ["getBounceStatistics", "packagedBounces"],
      ["getDeliveryTimeStatistics", "packagedDeliveryTimes"],
    ]);
    const profile = {
      ...candidate.profile,
      operations: candidate.profile.operations.map((mapping) => ({
        ...mapping,
        method: mappedMethods.get(mapping.operationId) ?? mapping.method,
      })),
    };
    const registry = createStatisticsScenarioRegistry({
      profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      senderDomains: fixture.senderDomains,
    });

    const result = await runStatisticsLiveScenarios(registry);

    expect(result.failure).toBeNull();
    expect(result.operationResults).toHaveLength(3);
    expect(result.operationResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "getDeliverabilityStatistics",
          status: "passed",
          evidence: {
            senderAuthorization: {
              source: "query.sender_domain",
              quantifier: "every",
              singleDomain: { authorized: true, domainCount: 1, resultBuckets: 1 },
              unauthorizedDomain: { authorized: false, domainCount: 1, status: 403 },
              multiDomain: { authorized: false, domainCount: 2, status: 403 },
            },
          },
        }),
        expect.objectContaining({ operationId: "getBounceStatistics", status: "passed" }),
        expect.objectContaining({ operationId: "getDeliveryTimeStatistics", status: "passed" }),
      ]),
    );
    for (const method of Object.values(packagedMethods)) {
      expect(method).toHaveBeenNthCalledWith(1, {
        sender_domain: fixture.firstDomain,
      });
      expect(method).toHaveBeenNthCalledWith(2, {
        sender_domain: fixture.secondDomain,
      });
      expect(method).toHaveBeenNthCalledWith(3, {
        sender_domain: `${fixture.firstDomain},${fixture.secondDomain}`,
      });
    }
  });

  it("requires every comma-separated statistics domain to be authorized", async () => {
    const fixture = statisticsClientFixture({ checkEveryDomain: false });
    const createRegistry = (
      authorization: Parameters<typeof createStatisticsScenarioRegistry>[0]["authorization"],
    ) =>
      createStatisticsScenarioRegistry({
        profile: inspectFixture().profile,
        client: fixture.client,
        authorization,
        senderDomains: fixture.senderDomains,
      });

    const result = await runStatisticsLiveScenarios(createRegistry(RESOURCE_AUTHORIZATION));

    expect(result.failure).toEqual({
      phase: "operation",
      operationId: "getDeliverabilityStatistics",
    });
    expect(result.operationResults).toEqual([
      { operationId: "getDeliverabilityStatistics", status: "failed" },
    ]);
    expect(fixture.client.statistics.deliverability).toHaveBeenCalledTimes(3);

    const firstOnlyAuthorization = structuredClone(RESOURCE_AUTHORIZATION) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    firstOnlyAuthorization.getDeliverabilityStatistics!.quantifier = "one";
    expect(() =>
      createRegistry(
        firstOnlyAuthorization as unknown as Parameters<
          typeof createStatisticsScenarioRegistry
        >[0]["authorization"],
      ),
    ).toThrow("must authorize every comma-separated sender_domain value");
  });

  it("keeps statistics report authorization evidence free of domains and query-bearing URLs", async () => {
    const candidate = inspectFixture();
    const fixture = statisticsClientFixture();
    const registry = createStatisticsScenarioRegistry({
      profile: candidate.profile,
      client: fixture.client,
      authorization: RESOURCE_AUTHORIZATION,
      senderDomains: fixture.senderDomains,
    });
    const result = await runStatisticsLiveScenarios(registry);
    const report = createLiveReport({
      candidate,
      operationResults: result.operationResults,
      secrets: Object.values(fixture.senderDomains),
    });
    const source = canonicalizeJson(report).toString("utf8");
    const statisticsRows = (
      report.operations as Array<{
        operationId: string;
        status: string;
        evidence?: unknown;
      }>
    ).filter(({ operationId }) =>
      ["getDeliverabilityStatistics", "getBounceStatistics", "getDeliveryTimeStatistics"].includes(
        operationId,
      ),
    );

    expect(statisticsRows).toHaveLength(3);
    expect(statisticsRows.every(({ status, evidence }) => status === "passed" && evidence)).toBe(
      true,
    );
    expect(source).toContain('"source":"query.sender_domain"');
    expect(source).toContain('"quantifier":"every"');
    expect(source).not.toContain(fixture.firstDomain);
    expect(source).not.toContain(fixture.secondDomain);
    expect(source).not.toContain("statistics sender is not authorized");
    expect(source).not.toMatch(/https?:\/\//u);
    expect(source).not.toContain("?sender_domain=");
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
