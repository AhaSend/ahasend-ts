import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { format } from "node:util";
import yaml from "js-yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  allocateLoopbackPort,
  spawnCapturedProcess,
  stopProcess,
  waitForProcessReadiness,
  type CapturedLocalProcess,
} from "../helpers/local-process.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const RESOURCE_ID = "00000000-0000-4000-8000-000000000002";
const DOMAIN = "example.test";
const API_KEY = "aha-sk-integration-test";
const repositoryRoot = process.cwd();
const requireFromRepository = createRequire(import.meta.url);

type UnknownRecord = Record<string, unknown>;
type InstalledConstructor = new (options: UnknownRecord) => object;

interface InstalledSdk {
  readonly AhaSendClient: InstalledConstructor;
}

interface InstalledWebhooks {
  readonly WebhookVerifier: new (secret: string) => object;
}

interface OperationCase {
  readonly operationId: string;
  readonly target: readonly string[];
  readonly method: string;
  readonly args?: readonly unknown[];
}

interface OpenAPIDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

interface SpecOperation {
  readonly operationId: string;
  readonly httpMethod: string;
  readonly pathTemplate: string;
}

interface ObservedRequest {
  readonly httpMethod: string;
  readonly pathname: string;
}

interface ObservedExampleRequest extends ObservedRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

interface PackedExampleCaseBase {
  readonly file: string;
  readonly runtimeCase: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly allowedEnvironmentOverrides: readonly string[];
  readonly expectedMarkers: readonly string[];
  readonly timeoutMs: number;
}

interface ReadonlyPackedExampleCase extends PackedExampleCaseBase {
  readonly kind: "readonly";
  readonly enabledExitCode: 0;
}

interface GuardedPackedExampleCase extends PackedExampleCaseBase {
  readonly kind: "guarded-mutation";
  readonly enabledExitCode: 0;
  readonly refusalExitCode: 1;
  readonly usesSecretFile: boolean;
}

interface SpawnedSpecializedPackedExampleCase extends PackedExampleCaseBase {
  readonly kind: "typed-error" | "offline-webhook";
  readonly enabledExitCode: 0;
}

interface FrameworkPackedExampleCase extends PackedExampleCaseBase {
  readonly kind: "express-webhook" | "next-webhook";
}

type PackedExampleCase =
  | ReadonlyPackedExampleCase
  | GuardedPackedExampleCase
  | SpawnedSpecializedPackedExampleCase
  | FrameworkPackedExampleCase;

interface PackedExampleResult {
  readonly exitCode: number | null;
  readonly requests: readonly ObservedExampleRequest[];
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface CapturedProcessOutput {
  readonly stdout: string[];
  readonly stderr: string[];
  restore(): void;
}

type EnqueueOnce = (webhookId: string, event: unknown) => Promise<boolean>;

interface PackedExpressApplication {
  listen(port: number, hostname: string, listener: () => void): Server;
}

interface PackedExpressExample {
  createWebhookApp(options: {
    readonly secret: string;
    readonly enqueueOnce: EnqueueOnce;
  }): PackedExpressApplication;
}

interface PackedNextRouteModule {
  readonly POST: (request: Request) => Promise<Response>;
  readonly runtime: "edge";
}

interface PackedNextRouteFactory {
  createWebhookRoute(options: {
    readonly secret: string;
    readonly enqueueOnce: EnqueueOnce;
  }): (request: Request) => Promise<Response>;
}

interface SignedWebhookDelivery {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

const PAGINATION = { limit: 5 };
const STATISTICS = {
  from_time: "2026-04-01T00:00:00Z",
  to_time: "2026-04-30T00:00:00Z",
  sender_domain: DOMAIN,
  group_by: "day",
};
const PACKED_EXAMPLE_TIMEOUT_MS = 15_000;
const PRISM_ENFORCEMENT_CANARY_PATH = "/__prism_enforcement_canary";
const PACKED_EXAMPLE_MATRIX: readonly PackedExampleCase[] = [
  {
    file: "bootstrap-subaccount.mjs",
    runtimeCase: "guarded child-account bootstrap",
    kind: "guarded-mutation",
    environment: {
      AHASEND_SUBACCOUNT_NAME: "Integration child",
      AHASEND_SUBACCOUNT_WEBSITE: `child.${DOMAIN}`,
    },
    allowedEnvironmentOverrides: ["AHASEND_ALLOW_MUTATIONS", "AHASEND_CHILD_SECRET_FILE"],
    expectedMarkers: ["✓ created child account id=", "stored its one-time key"],
    enabledExitCode: 0,
    refusalExitCode: 1,
    usesSecretFile: true,
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
  {
    file: "error-handling.mjs",
    runtimeCase: "typed local 404 error",
    kind: "typed-error",
    environment: {},
    allowedEnvironmentOverrides: ["AHASEND_API_KEY", "AHASEND_BASE_URL"],
    expectedMarkers: ["✓ caught AhaSendNotFoundError status=404"],
    enabledExitCode: 0,
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
  readonlyExample("get-account.mjs", "read account", ["✓ account id=", "status=200"]),
  {
    file: "idempotency.mjs",
    runtimeCase: "guarded idempotent send and replay",
    kind: "guarded-mutation",
    environment: { AHASEND_FROM_EMAIL: `sender@${DOMAIN}` },
    allowedEnvironmentOverrides: ["AHASEND_ALLOW_MUTATIONS"],
    expectedMarkers: ["✓ first send:", "✓ replay send:", "(no duplicate email)"],
    enabledExitCode: 0,
    refusalExitCode: 1,
    usesSecretFile: false,
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
  readonlyExample("iterate.mjs", "bounded message iteration", ["✓ iterated 1 message(s)"]),
  readonlyExample("list-api-keys.mjs", "list API keys", ["API key(s) status=200"]),
  readonlyExample("list-domains.mjs", "list domains", ["domain(s) status=200"]),
  readonlyExample("list-routes.mjs", "list routes", ["route(s) status=200"]),
  readonlyExample("list-suppressions.mjs", "list suppressions", ["suppression(s) status=200"]),
  {
    file: "next-webhook-route.mjs",
    runtimeCase: "offline Next webhook route",
    kind: "next-webhook",
    environment: {},
    allowedEnvironmentOverrides: [],
    expectedMarkers: [],
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
  readonlyExample("ping.mjs", "API ping", ["✓ ping status=200"]),
  {
    file: "send-sandbox.mjs",
    runtimeCase: "guarded sandbox send",
    kind: "guarded-mutation",
    environment: { AHASEND_FROM_EMAIL: `sender@${DOMAIN}` },
    allowedEnvironmentOverrides: ["AHASEND_ALLOW_MUTATIONS"],
    expectedMarkers: ["✓ sandbox send: ", " queued, ", " rejected"],
    enabledExitCode: 0,
    refusalExitCode: 1,
    usesSecretFile: false,
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
  readonlyExample("statistics.mjs", "deliverability statistics", ["bucket(s) returned status=200"]),
  {
    file: "telemetry.mjs",
    runtimeCase: "safe telemetry hooks",
    kind: "readonly",
    environment: {},
    allowedEnvironmentOverrides: [],
    expectedMarkers: ["→ request started", "← response received", "✓ done"],
    enabledExitCode: 0,
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
  {
    file: "update-api-key-ip-list.mjs",
    runtimeCase: "guarded API-key IP allow-list update",
    kind: "guarded-mutation",
    environment: {
      AHASEND_API_KEY_ID: RESOURCE_ID,
      AHASEND_IP_ALLOW_LIST: "203.0.113.0/24,198.51.100.7",
    },
    allowedEnvironmentOverrides: ["AHASEND_ALLOW_MUTATIONS"],
    expectedMarkers: ["✓ updated IP allow-list with ", "canonical entries"],
    enabledExitCode: 0,
    refusalExitCode: 1,
    usesSecretFile: false,
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
  {
    file: "verify-webhook.mjs",
    runtimeCase: "offline webhook verification and tamper rejection",
    kind: "offline-webhook",
    environment: {},
    allowedEnvironmentOverrides: [],
    expectedMarkers: ["✓ verified webhook signature", "✓ tampered body correctly rejected"],
    enabledExitCode: 0,
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
  {
    file: "webhook-express.mjs",
    runtimeCase: "ephemeral Express webhook server",
    kind: "express-webhook",
    environment: {},
    allowedEnvironmentOverrides: [],
    expectedMarkers: [],
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  },
];

const READONLY_PACKED_EXAMPLE_CASES = PACKED_EXAMPLE_MATRIX.filter(
  (example): example is ReadonlyPackedExampleCase => example.kind === "readonly",
);
const GUARDED_PACKED_EXAMPLE_CASES = PACKED_EXAMPLE_MATRIX.filter(
  (example): example is GuardedPackedExampleCase => example.kind === "guarded-mutation",
);

const OPERATION_CASES = [
  operation("ping", [], "ping"),
  operation("getAPIKeys", ["apiKeys"], "list", [PAGINATION]),
  operation("createAPIKey", ["apiKeys"], "create", [
    { label: "Integration key", scopes: ["messages:send:all"] },
  ]),
  operation("getAPIKey", ["apiKeys"], "get", [RESOURCE_ID]),
  operation("updateAPIKey", ["apiKeys"], "update", [RESOURCE_ID, { label: "Updated key" }]),
  operation("deleteAPIKey", ["apiKeys"], "delete", [RESOURCE_ID]),
  operation("getDomains", ["domains"], "list", [{ dns_valid: true, ...PAGINATION }]),
  operation("createDomain", ["domains"], "create", [{ domain: DOMAIN }]),
  operation("getDomain", ["domains"], "get", [DOMAIN]),
  operation("updateDomain", ["domains"], "update", [DOMAIN, { tracking_subdomain: "track" }]),
  operation("deleteDomain", ["domains"], "delete", [DOMAIN]),
  operation("checkDomainDNS", ["domains"], "checkDns", [DOMAIN]),
  operation("getMessages", ["messages"], "list", [
    { status: "Delivered", sender: `sender@${DOMAIN}`, ...PAGINATION },
  ]),
  operation("createMessage", ["messages"], "send", [
    {
      from: { email: `sender@${DOMAIN}` },
      recipients: [{ email: `recipient@${DOMAIN}` }],
      subject: "Integration message",
      text_content: "Hello from the packed SDK",
    },
  ]),
  operation("createConversationMessage", ["messages"], "sendConversation", [
    {
      from: { email: `sender@${DOMAIN}` },
      to: [{ email: `recipient@${DOMAIN}` }],
      subject: "Integration conversation",
      text_content: "Hello from the packed SDK",
    },
  ]),
  operation("getMessage", ["messages"], "get", [RESOURCE_ID]),
  operation("cancelMessage", ["messages"], "cancel", [RESOURCE_ID]),
  operation("getAccount", ["accounts"], "get"),
  operation("updateAccount", ["accounts"], "update", [{ name: "Integration account" }]),
  operation("getAccountMembers", ["accounts"], "listMembers"),
  operation("addAccountMember", ["accounts"], "addMember", [
    { email: `member@${DOMAIN}`, role: "Developer" },
  ]),
  operation("removeAccountMember", ["accounts"], "removeMember", [RESOURCE_ID]),
  operation("listSubAccounts", ["subAccounts"], "list", [PAGINATION]),
  operation("createSubAccount", ["subAccounts"], "create", [
    { name: "Integration child", website: `child.${DOMAIN}` },
  ]),
  operation("getSubAccountsUsage", ["subAccounts"], "usage"),
  operation("getSubAccount", ["subAccounts"], "get", [RESOURCE_ID]),
  operation("updateSubAccount", ["subAccounts"], "update", [
    RESOURCE_ID,
    { name: "Updated child" },
  ]),
  operation("deleteSubAccount", ["subAccounts"], "delete", [RESOURCE_ID]),
  operation("suspendSubAccount", ["subAccounts"], "suspend", [
    RESOURCE_ID,
    { reason: "Integration suspension" },
  ]),
  operation("unsuspendSubAccount", ["subAccounts"], "unsuspend", [RESOURCE_ID]),
  operation("listSubAccountAPIKeys", ["subAccounts", "apiKeys"], "list", [RESOURCE_ID, PAGINATION]),
  operation("createSubAccountAPIKey", ["subAccounts", "apiKeys"], "create", [
    RESOURCE_ID,
    { label: "Integration child key", scopes: ["messages:send:all"] },
  ]),
  operation("getSubAccountAPIKey", ["subAccounts", "apiKeys"], "get", [RESOURCE_ID, RESOURCE_ID]),
  operation("updateSubAccountAPIKey", ["subAccounts", "apiKeys"], "update", [
    RESOURCE_ID,
    RESOURCE_ID,
    { label: "Updated child key" },
  ]),
  operation("deleteSubAccountAPIKey", ["subAccounts", "apiKeys"], "delete", [
    RESOURCE_ID,
    RESOURCE_ID,
  ]),
  operation("getSuppressions", ["suppressions"], "list", [
    { domain: DOMAIN, email: `blocked@${DOMAIN}`, ...PAGINATION },
  ]),
  operation("createSuppression", ["suppressions"], "create", [
    { email: `blocked@${DOMAIN}`, expires_at: "2027-01-01T00:00:00Z" },
  ]),
  operation("deleteSuppression", ["suppressions"], "delete", [
    { email: `blocked@${DOMAIN}`, domain: DOMAIN },
  ]),
  operation("deleteAllSuppressions", ["suppressions"], "wipe", [{ domain: DOMAIN }]),
  operation("getRoutes", ["routes"], "list", [{ domain: DOMAIN, ...PAGINATION }]),
  operation("createRoute", ["routes"], "create", [
    {
      name: "Integration route",
      url: "https://hooks.example.test/inbound",
      recipient: `support@${DOMAIN}`,
    },
  ]),
  operation("getRoute", ["routes"], "get", [RESOURCE_ID]),
  operation("updateRoute", ["routes"], "update", [RESOURCE_ID, { name: "Updated route" }]),
  operation("deleteRoute", ["routes"], "delete", [RESOURCE_ID]),
  operation("getWebhooks", ["webhooks"], "list", [
    { enabled: true, on_delivered: true, ...PAGINATION },
  ]),
  operation("createWebhook", ["webhooks"], "create", [
    {
      name: "Integration webhook",
      url: "https://hooks.example.test/ahasend",
      scope: "global",
      on_delivered: true,
    },
  ]),
  operation("getWebhook", ["webhooks"], "get", [RESOURCE_ID]),
  operation("updateWebhook", ["webhooks"], "update", [RESOURCE_ID, { name: "Updated webhook" }]),
  operation("deleteWebhook", ["webhooks"], "delete", [RESOURCE_ID]),
  operation("getSMTPCredentials", ["smtpCredentials"], "list", [PAGINATION]),
  operation("createSMTPCredential", ["smtpCredentials"], "create", [
    { name: "Integration SMTP", scope: "global" },
  ]),
  operation("getSMTPCredential", ["smtpCredentials"], "get", [RESOURCE_ID]),
  operation("deleteSMTPCredential", ["smtpCredentials"], "delete", [RESOURCE_ID]),
  operation("getDeliverabilityStatistics", ["statistics"], "deliverability", [STATISTICS]),
  operation("getBounceStatistics", ["statistics"], "bounces", [STATISTICS]),
  operation("getDeliveryTimeStatistics", ["statistics"], "deliveryTimes", [STATISTICS]),
] as const satisfies readonly OperationCase[];

const STAGED_CONTACT_OPERATION_IDS = [
  "getContacts",
  "createContact",
  "batchUpsertContacts",
  "getContact",
  "updateContact",
  "deleteContact",
] as const;

const SPEC_OPERATIONS = loadSpecOperations();

let consumerDirectory: string | undefined;
let exampleRequestProxy: Server | undefined;
const observedExampleRequests: ObservedExampleRequest[] = [];
let prismProcess: CapturedLocalProcess | undefined;
let baseUrl = "";
let prismBaseUrl = "";
let prismDocumentDirectory: string | undefined;
let installedSdk: InstalledSdk;
let installedWebhooks: InstalledWebhooks;
let resolvedPackageEntry = "";
let resolvedWebhooksEntry = "";

beforeAll(async () => {
  const tarball = verifiedTarball();
  consumerDirectory = installTarball(tarball);
  ({
    sdk: installedSdk,
    webhooks: installedWebhooks,
    packageEntry: resolvedPackageEntry,
    webhooksEntry: resolvedWebhooksEntry,
  } = loadInstalledPackage(consumerDirectory));

  const port = await allocateLoopbackPort();
  prismDocumentDirectory = mkdtempSync(join(tmpdir(), "ahasend-prism-contract-"));
  prismProcess = startPrism(port, writePrismCanaryDocument(prismDocumentDirectory));
  prismBaseUrl = `http://127.0.0.1:${port}`;
  await waitForProcessReadiness(
    prismProcess,
    async (signal) => {
      const response = await fetch(`${prismBaseUrl}/v2/ping`, {
        headers: { authorization: `Bearer ${API_KEY}` },
        signal,
      });
      return response.ok;
    },
    { label: "Prism", timeoutMs: 60_000 },
  );
  ({ server: exampleRequestProxy, baseUrl } = await startExampleRequestProxy(prismBaseUrl));
}, 120_000);

afterAll(async () => {
  await stopHttpServer(exampleRequestProxy);
  await stopProcess(prismProcess);
  if (consumerDirectory !== undefined) {
    rmSync(consumerDirectory, { recursive: true, force: true });
  }
  if (prismDocumentDirectory !== undefined) {
    rmSync(prismDocumentDirectory, { recursive: true, force: true });
  }
});

describe("installed package boundary", () => {
  it("resolves both public entry points from the clean consumer", () => {
    expect(resolvedPackageEntry).toContain(
      join("node_modules", "@ahasend", "sdk", "dist", "index.cjs"),
    );
    expect(resolvedWebhooksEntry).toContain(
      join("node_modules", "@ahasend", "sdk", "dist", "webhooks", "index.cjs"),
    );
    expect(resolvedPackageEntry).not.toContain(join(repositoryRoot, "src"));
    expect(resolvedWebhooksEntry).not.toContain(join(repositoryRoot, "src"));
  });
});

describe("packed example matrix", () => {
  it("registers every top-level example source exactly once with one named runtime case", () => {
    const sourceFiles = readdirSync(resolve(repositoryRoot, "examples"))
      .filter((file) => file.endsWith(".mjs"))
      .sort();
    const registeredFiles = PACKED_EXAMPLE_MATRIX.map(({ file }) => file);
    const runtimeCases = PACKED_EXAMPLE_MATRIX.map(({ runtimeCase }) => runtimeCase);
    const duplicateFiles = duplicates(registeredFiles);
    const duplicateRuntimeCases = duplicates(runtimeCases);
    const missingFiles = sourceFiles.filter((file) => !registeredFiles.includes(file));
    const orphanFiles = registeredFiles.filter((file) => !sourceFiles.includes(file));

    expect(sourceFiles).toHaveLength(17);
    expect(PACKED_EXAMPLE_MATRIX).toHaveLength(17);
    expect(registeredFiles).toEqual([...registeredFiles].sort());
    expect(duplicateFiles).toEqual([]);
    expect(duplicateRuntimeCases).toEqual([]);
    expect(missingFiles).toEqual([]);
    expect(orphanFiles).toEqual([]);
    expect(registeredFiles).toEqual(sourceFiles);
  });
});

describe("enforcing Prism", () => {
  it("rejects an intentionally invalid SDK-shaped request", async () => {
    const response = await fetch(`${baseUrl}/v2/accounts/${ACCOUNT_ID}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": "integration-invalid-request",
      },
      body: "{}",
    });

    expect(response.status).toBe(422);
  });

  it("requires --errors to reject the deliberately invalid canary response", async () => {
    const response = await fetch(`${prismBaseUrl}${PRISM_ENFORCEMENT_CANARY_PATH}`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      title: "Request/Response not valid",
    });
  });
});

describe("local process orchestration", () => {
  it("reports an early Prism startup failure with its status and captured output", async () => {
    const port = await allocateLoopbackPort();
    const missingDocument = resolve(repositoryRoot, "missing-prism-document.yaml");
    const failedPrism = startPrism(port, missingDocument);
    const startedAt = Date.now();
    let failure: unknown;

    try {
      await waitForProcessReadiness(
        failedPrism,
        async (signal) => {
          const response = await fetch(`http://127.0.0.1:${port}/v2/ping`, {
            headers: { authorization: `Bearer ${API_KEY}` },
            signal,
          });
          return response.ok;
        },
        { label: "Prism startup test", timeoutMs: 20_000 },
      );
    } catch (error) {
      failure = error;
    } finally {
      await stopProcess(failedPrism);
    }

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected Prism startup to fail.");
    expect(failure.message).toContain("Prism startup test exited before becoming ready");
    expect(failure.message).toMatch(/\((?:exit code \d+|signal \w+)\)/u);
    expect(failure.message).toContain("stdout:\n");
    expect(failure.message).toContain("stderr:\n");
    expect(`${failedPrism.stdout}${failedPrism.stderr}`).not.toBe("");
  });

  it("tears down a ready Prism process after an assertion failure", async () => {
    const port = await allocateLoopbackPort();
    const disposablePrism = startPrism(port, resolve(repositoryRoot, "openapi.yaml"));
    const assertionRun = async (): Promise<void> => {
      try {
        await waitForProcessReadiness(
          disposablePrism,
          async (signal) => {
            const response = await fetch(`http://127.0.0.1:${port}/v2/ping`, {
              headers: { authorization: `Bearer ${API_KEY}` },
              signal,
            });
            return response.ok;
          },
          { label: "Disposable Prism", timeoutMs: 60_000 },
        );
        expect("actual assertion value").toBe("expected assertion value");
      } finally {
        await stopProcess(disposablePrism);
      }
    };

    await expect(assertionRun()).rejects.toThrow("expected assertion value");
    const exit = await disposablePrism.exited;
    expect(exit.exitCode !== null || exit.signal !== null).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/v2/ping`)).rejects.toThrow();
  });

  it("escalates teardown to KILL when a local child ignores TERM", async () => {
    const stubbornProcess = spawnCapturedProcess(process.execPath, [
      "-e",
      [
        'process.on("SIGTERM", () => process.stderr.write("ignored TERM\\n"));',
        'process.stdout.write("ready\\n");',
        "setInterval(() => {}, 1_000);",
      ].join(""),
    ]);

    await waitForProcessReadiness(
      stubbornProcess,
      async () => stubbornProcess.stdout.includes("ready\n"),
      { label: "Stubborn child", timeoutMs: 5_000, intervalMs: 10 },
    );
    await stopProcess(stubbornProcess, { gracePeriodMs: 100 });

    const exit = await stubbornProcess.exited;
    expect(exit.signal).toBe("SIGKILL");
    expect(stubbornProcess.stderr).toContain("ignored TERM");
  });
});

describe("packed readonly examples", () => {
  it.each(READONLY_PACKED_EXAMPLE_CASES)("$runtimeCase ($file)", async (example) => {
    const result = await runPackedExample(example);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(example.enabledExitCode);
    expect(result.stderr).toBe("");
    for (const marker of example.expectedMarkers) expect(output).toContain(marker);
    expect(output).not.toContain(API_KEY);
    assertPackedApiRequests(example, result.requests);
  });
});

describe("packed typed error example", () => {
  it(packedExample("error-handling.mjs", "typed-error").runtimeCase, async () => {
    const example = packedExample("error-handling.mjs", "typed-error");
    const rawResponseMessage = "private upstream diagnostic must not be logged";
    const suppliedApiKey = "aha-sk-error-example-secret";
    const requestId = "req_error_example_404";
    const observedRequests: ObservedExampleRequest[] = [];
    const responder = createHttpServer(async (request, response) => {
      observedRequests.push(await observeIncomingRequest(request));
      response.writeHead(404, {
        "content-type": "application/json",
        "x-request-id": requestId,
      });
      response.end(JSON.stringify({ message: rawResponseMessage }));
    });
    await new Promise<void>((resolveListening, reject) => {
      responder.once("error", reject);
      responder.listen(0, "127.0.0.1", resolveListening);
    });

    try {
      const address = responder.address();
      if (address === null || typeof address === "string") {
        throw new Error("The deterministic 404 responder did not bind to a TCP port.");
      }
      const result = await runPackedExample(example, {
        AHASEND_API_KEY: suppliedApiKey,
        AHASEND_BASE_URL: `http://127.0.0.1:${address.port}`,
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(example.enabledExitCode);
      expect(result.stderr).toBe("");
      for (const marker of example.expectedMarkers) expect(output).toContain(marker);
      expect(result.stdout).toBe(
        `✓ caught AhaSendNotFoundError status=404 code=not_found_error request-id=${requestId}\n`,
      );
      expect(output).not.toContain(rawResponseMessage);
      expect(output).not.toContain(suppliedApiKey);
      expect(output).not.toContain(API_KEY);
      expect(result.requests).toEqual([]);
      expect(observedRequests).toHaveLength(1);
      const observedRequest = requiredObservedRequest(observedRequests, 0);
      expect(observedRequest.httpMethod).toBe("GET");
      expect(observedRequest.pathname).toBe(
        `/v2/accounts/${ACCOUNT_ID}/messages/00000000-0000-0000-0000-000000000000`,
      );
      expect(observedRequest.query).toEqual({});
      expect(observedRequest.body).toBe("");
      expect(observedRequest.headers["authorization"]).toBe(`Bearer ${suppliedApiKey}`);
    } finally {
      await new Promise<void>((resolveClosed, reject) => {
        responder.close((error) => {
          if (error === undefined) resolveClosed();
          else reject(error);
        });
      });
    }
  });
});

describe("packed offline webhook example", () => {
  it(packedExample("verify-webhook.mjs", "offline-webhook").runtimeCase, async () => {
    const example = packedExample("verify-webhook.mjs", "offline-webhook");
    const fixtureSecret = "aha-whsec-local-demo-secret-please-rotate";
    const result = await runPackedExample(example);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(example.enabledExitCode);
    expect(result.stderr).toBe("");
    for (const marker of example.expectedMarkers) expect(output).toContain(marker);
    expect(result.stdout).toBe(
      "✓ verified webhook signature\n✓ tampered body correctly rejected\n",
    );
    expect(output).not.toContain("signature_mismatch");
    expect(output).not.toContain(fixtureSecret);
    expect(output).not.toContain(API_KEY);
  });
});

describe("packed Express webhook example", () => {
  it(
    packedExample("webhook-express.mjs", "express-webhook").runtimeCase,
    async () => {
      const exampleCase = packedExample("webhook-express.mjs", "express-webhook");
      const secret = "aha-whsec-express-integration-secret";
      const webhookId = "msg_express_it_1";
      const { body, headers } = createSignedWebhookDelivery(secret, webhookId);
      const capturedOutput = captureProcessOutput();
      let server: Server | undefined;

      try {
        linkExpressHostDependency();
        const installedCopy = copyPackedExample(exampleCase.file);
        const example = (await import(pathToFileURL(installedCopy).href)) as PackedExpressExample;
        const app = example.createWebhookApp({
          secret,
          enqueueOnce: createInMemoryEnqueueOnce(),
        });
        server = await listenOnEphemeralPort(app);
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("The packed Express example did not bind to a TCP port.");
        }
        const url = `http://127.0.0.1:${address.port}/webhooks/ahasend`;

        const first = await fetch(url, { method: "POST", headers, body });
        const firstOutput = await first.text();
        const duplicate = await fetch(url, { method: "POST", headers, body });
        const duplicateOutput = await duplicate.text();

        expect(first.status).toBe(202);
        expect(duplicate.status).toBe(200);
        expect(firstOutput).toBe("");
        expect(duplicateOutput).toBe("");
        expect(`${firstOutput}${duplicateOutput}`).not.toContain(secret);
        expect(`${firstOutput}${duplicateOutput}`).not.toContain(API_KEY);
      } finally {
        await stopHttpServer(server);
        capturedOutput.restore();
      }

      const processOutput = `${capturedOutput.stdout.join("")}${capturedOutput.stderr.join("")}`;
      expect(server?.listening).toBe(false);
      expect(processOutput).toBe("");
      expect(processOutput).not.toContain(secret);
      expect(processOutput).not.toContain(API_KEY);
    },
    packedExample("webhook-express.mjs", "express-webhook").timeoutMs,
  );
});

describe("packed Next webhook example", () => {
  it(
    packedExample("next-webhook-route.mjs", "next-webhook").runtimeCase,
    async () => {
      const exampleCase = packedExample("next-webhook-route.mjs", "next-webhook");
      const secret = "aha-whsec-next-integration-secret";
      const webhookId = "msg_next_it_1";
      const { body, headers } = createSignedWebhookDelivery(secret, webhookId);

      const capturedOutput = captureProcessOutput();
      const previousSecret = process.env.AHASEND_WEBHOOK_SECRET;
      process.env.AHASEND_WEBHOOK_SECRET = secret;
      let responses: readonly [Response, Response] | undefined;
      try {
        const installedFactoryCopy = copyPackedExample(
          "next-webhook-route/create-webhook-route.mjs",
        );
        const installedCopy = copyPackedExample(exampleCase.file);
        const routeModule = (await import(
          pathToFileURL(installedCopy).href
        )) as PackedNextRouteModule;
        const routeFactory = (await import(
          pathToFileURL(installedFactoryCopy).href
        )) as PackedNextRouteFactory;
        expect(Object.keys(routeModule).sort()).toEqual(["POST", "runtime"]);
        expect(routeModule.POST).toBeTypeOf("function");
        expect(routeModule.runtime).toBe("edge");
        const route = routeFactory.createWebhookRoute({
          secret,
          enqueueOnce: createInMemoryEnqueueOnce(),
        });
        responses = [
          await route(
            new Request("https://example.test/webhooks/ahasend", {
              method: "POST",
              headers,
              body,
            }),
          ),
          await route(
            new Request("https://example.test/webhooks/ahasend", {
              method: "POST",
              headers,
              body,
            }),
          ),
        ];
      } finally {
        if (previousSecret === undefined) delete process.env.AHASEND_WEBHOOK_SECRET;
        else process.env.AHASEND_WEBHOOK_SECRET = previousSecret;
        capturedOutput.restore();
      }

      if (!responses) throw new Error("The packed Next example did not return both responses.");
      const [first, duplicate] = responses;
      const firstOutput = await first.text();
      const duplicateOutput = await duplicate.text();
      const processOutput = `${capturedOutput.stdout.join("")}${capturedOutput.stderr.join("")}`;

      expect(first.status).toBe(202);
      expect(duplicate.status).toBe(200);
      expect(firstOutput).toBe("");
      expect(duplicateOutput).toBe("");
      expect(processOutput).toBe("");
      expect(processOutput).not.toContain(secret);
      expect(processOutput).not.toContain(API_KEY);
    },
    packedExample("next-webhook-route.mjs", "next-webhook").timeoutMs,
  );
});

describe("packed guarded mutation examples", () => {
  it.each(GUARDED_PACKED_EXAMPLE_CASES)(
    "refuses $runtimeCase ($file) without explicit mutation approval",
    async (example) => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "ahasend-guarded-example-"));
      const secretFile = join(temporaryDirectory, "child-api-key.secret");
      const environment = example.usesSecretFile ? { AHASEND_CHILD_SECRET_FILE: secretFile } : {};

      try {
        const result = await runPackedExample(example, environment);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.timedOut).toBe(false);
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(example.refusalExitCode);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Refusing mutation; set AHASEND_ALLOW_MUTATIONS=1");
        expect(output).not.toContain(API_KEY);
        expect(output).not.toContain(secretFile);
        for (const suppliedValue of Object.values(example.environment)) {
          expect(output).not.toContain(suppliedValue);
        }
        expect(existsSync(secretFile)).toBe(false);
        expect(result.requests).toEqual([]);
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      expect(existsSync(temporaryDirectory)).toBe(false);
    },
  );

  it.each(GUARDED_PACKED_EXAMPLE_CASES)(
    "executes approved $runtimeCase ($file) against Prism",
    async (example) => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "ahasend-guarded-example-"));
      const secretFile = join(temporaryDirectory, "child-api-key.secret");
      const environment = {
        AHASEND_ALLOW_MUTATIONS: "1",
        ...(example.usesSecretFile ? { AHASEND_CHILD_SECRET_FILE: secretFile } : {}),
      };

      try {
        const result = await runPackedExample(example, environment);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.timedOut).toBe(false);
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(example.enabledExitCode);
        expect(result.stderr).toBe("");
        for (const marker of example.expectedMarkers) expect(output).toContain(marker);
        expect(output).not.toContain(API_KEY);
        expect(output).not.toContain(secretFile);
        for (const suppliedValue of Object.values(example.environment)) {
          expect(output).not.toContain(suppliedValue);
        }
        assertPackedApiRequests(example, result.requests);

        if (example.usesSecretFile) {
          const secretFileStats = statSync(secretFile);
          expect(secretFileStats.isFile()).toBe(true);
          expect(secretFileStats.mode & 0o777).toBe(0o600);
          expect(secretFileStats.size).toBeGreaterThan(0);
          const secretWasPrinted = output.includes(readFileSync(secretFile, "utf8"));
          expect(secretWasPrinted).toBe(false);
        } else {
          expect(existsSync(secretFile)).toBe(false);
        }
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      expect(existsSync(temporaryDirectory)).toBe(false);
    },
  );
});

describe("packed SDK operation contract", () => {
  it("covers every implemented operation and accounts for staged contact operations", () => {
    const operationIds = [...SPEC_OPERATIONS.keys()];
    const implementedOperationIds = OPERATION_CASES.map(({ operationId }) => operationId);

    expect(OPERATION_CASES).toHaveLength(56);
    expect(new Set(implementedOperationIds).size).toBe(56);
    expect(STAGED_CONTACT_OPERATION_IDS).toHaveLength(6);
    expect(new Set(STAGED_CONTACT_OPERATION_IDS).size).toBe(6);
    expect([...implementedOperationIds, ...STAGED_CONTACT_OPERATION_IDS].sort()).toEqual(
      operationIds.sort(),
    );
  });

  it.each(OPERATION_CASES)("$operationId", async ({ operationId, target, method, args = [] }) => {
    const observedRequests: ObservedRequest[] = [];
    const forwardingFetch: typeof fetch = async (input, init) => {
      observedRequests.push(observeRequest(input, init));
      return await globalThis.fetch(input, init);
    };
    const client = new installedSdk.AhaSendClient({
      apiKey: API_KEY,
      accountId: ACCOUNT_ID,
      baseUrl,
      fetch: forwardingFetch,
      retry: { enabled: false },
    });

    await expect(callMethod(client, target, method, args)).resolves.toBeDefined();
    expect(observedRequests).toHaveLength(1);

    const expectedOperation = SPEC_OPERATIONS.get(operationId);
    const observedRequest = observedRequests[0];
    if (expectedOperation === undefined || observedRequest === undefined) {
      throw new Error(`Missing OpenAPI contract or observed request for ${operationId}.`);
    }
    expect(observedRequest.httpMethod).toBe(expectedOperation.httpMethod);
    expect(pathMatchesTemplate(observedRequest.pathname, expectedOperation.pathTemplate)).toBe(
      true,
    );
  });
});

describe("packed webhooks subpath", () => {
  it("verifies a signed payload through the installed subpath", async () => {
    const secret = "aha-whsec-integration-secret";
    const verifier = new installedWebhooks.WebhookVerifier(secret);
    const id = "msg_it_1";
    const { body, headers } = createSignedWebhookDelivery(secret, id);

    const event = await callMethod(verifier, [], "parse", [headers, body]);
    expect(event).toMatchObject({ type: "message.delivered" });
  });
});

function operation(
  operationId: string,
  target: readonly string[],
  method: string,
  args?: readonly unknown[],
): OperationCase {
  return args === undefined
    ? { operationId, target, method }
    : { operationId, target, method, args };
}

function readonlyExample(
  file: string,
  runtimeCase: string,
  expectedMarkers: readonly string[],
): ReadonlyPackedExampleCase {
  return {
    file,
    runtimeCase,
    kind: "readonly",
    environment: {},
    allowedEnvironmentOverrides: [],
    expectedMarkers,
    enabledExitCode: 0,
    timeoutMs: PACKED_EXAMPLE_TIMEOUT_MS,
  };
}

function packedExample<Kind extends PackedExampleCase["kind"]>(
  file: string,
  kind: Kind,
): PackedExampleCase & { readonly kind: Kind } {
  const example = PACKED_EXAMPLE_MATRIX.find((candidate) => candidate.file === file);
  if (example === undefined || example.kind !== kind) {
    throw new Error(`The packed example matrix is missing ${kind} case ${file}.`);
  }
  return example as PackedExampleCase & { readonly kind: Kind };
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}

function loadSpecOperations(): ReadonlyMap<string, SpecOperation> {
  const source = readFileSync(resolve(repositoryRoot, "openapi.yaml"), "utf8");
  const document = yaml.load(source) as OpenAPIDocument;
  const operations = new Map<string, SpecOperation>();

  for (const [pathTemplate, pathItem] of Object.entries(document.paths)) {
    for (const [method, candidate] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "delete"].includes(method) || !isRecord(candidate)) continue;
      const operationId = candidate["operationId"];
      if (typeof operationId !== "string") continue;
      operations.set(operationId, {
        operationId,
        httpMethod: method.toUpperCase(),
        pathTemplate,
      });
    }
  }

  return operations;
}

function observeRequest(input: string | URL | Request, init?: RequestInit): ObservedRequest {
  const request = input instanceof Request ? input : undefined;
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  return {
    httpMethod: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    pathname: url.pathname,
  };
}

async function observeIncomingRequest(request: IncomingMessage): Promise<ObservedExampleRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[name] = value;
    else if (value !== undefined) headers[name] = value.join(", ");
  }

  return {
    httpMethod: (request.method ?? "GET").toUpperCase(),
    pathname: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

function assertPackedApiRequests(
  example: ReadonlyPackedExampleCase | GuardedPackedExampleCase,
  requests: readonly ObservedExampleRequest[],
): void {
  switch (example.file) {
    case "bootstrap-subaccount.mjs": {
      expect(requests).toHaveLength(2);
      const createAccount = assertExampleRequest(
        requests,
        0,
        "POST",
        `/v2/accounts/${ACCOUNT_ID}/sub-accounts`,
      );
      expectJsonBody(createAccount, {
        name: "Integration child",
        website: `child.${DOMAIN}`,
      });
      const createKey = assertExampleRequest(requests, 1, "POST");
      expect(
        pathMatchesTemplate(
          createKey.pathname,
          "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys",
        ),
      ).toBe(true);
      expect(createKey.pathname).toMatch(
        new RegExp(`^/v2/accounts/${ACCOUNT_ID}/sub-accounts/[^/]+/api-keys$`),
      );
      expectJsonBody(createKey, {
        label: "Bootstrap message sender",
        scopes: ["messages:send:all"],
      });
      expectAutoIdempotencyKey(createAccount);
      expectAutoIdempotencyKey(createKey);
      expect(createKey.headers["idempotency-key"]).not.toBe(
        createAccount.headers["idempotency-key"],
      );
      return;
    }
    case "get-account.mjs":
      expectSingleReadonlyRequest(requests, `/v2/accounts/${ACCOUNT_ID}`);
      return;
    case "idempotency.mjs": {
      expect(requests).toHaveLength(2);
      const first = assertExampleRequest(
        requests,
        0,
        "POST",
        `/v2/accounts/${ACCOUNT_ID}/messages`,
      );
      const replay = assertExampleRequest(
        requests,
        1,
        "POST",
        `/v2/accounts/${ACCOUNT_ID}/messages`,
      );
      const expectedBody = {
        from: { email: `sender@${DOMAIN}` },
        recipients: [{ email: "to@example.com" }],
        subject: "Receipt for order-12345",
        text_content: "Thanks for your order.",
        sandbox: true,
      };
      expectJsonBody(first, expectedBody);
      expectJsonBody(replay, expectedBody);
      expect(first.headers["idempotency-key"]).toBe("receipt-order-12345");
      expect(replay.headers["idempotency-key"]).toBe("receipt-order-12345");
      return;
    }
    case "iterate.mjs":
      expectSingleReadonlyRequest(requests, `/v2/accounts/${ACCOUNT_ID}/messages`, {
        status: "Delivered",
        limit: "50",
      });
      return;
    case "list-api-keys.mjs":
      expectSingleReadonlyRequest(requests, `/v2/accounts/${ACCOUNT_ID}/api-keys`, {
        limit: "10",
      });
      return;
    case "list-domains.mjs":
      expectSingleReadonlyRequest(requests, `/v2/accounts/${ACCOUNT_ID}/domains`, {
        limit: "10",
      });
      return;
    case "list-routes.mjs":
      expectSingleReadonlyRequest(requests, `/v2/accounts/${ACCOUNT_ID}/routes`, {
        limit: "10",
      });
      return;
    case "list-suppressions.mjs":
      expectSingleReadonlyRequest(requests, `/v2/accounts/${ACCOUNT_ID}/suppressions`, {
        limit: "10",
      });
      return;
    case "ping.mjs":
    case "telemetry.mjs":
      expectSingleReadonlyRequest(requests, "/v2/ping");
      return;
    case "send-sandbox.mjs": {
      expect(requests).toHaveLength(1);
      const request = assertExampleRequest(
        requests,
        0,
        "POST",
        `/v2/accounts/${ACCOUNT_ID}/messages`,
      );
      expectJsonBody(request, {
        from: { email: `sender@${DOMAIN}`, name: "AhaSend SDK Test" },
        recipients: [{ email: "to@example.com", name: "Test Recipient" }],
        subject: "SDK sandbox test",
        text_content: "This is a sandbox-mode send from the AhaSend Node SDK.",
        html_content: "<p>This is a <b>sandbox-mode</b> send from the AhaSend Node SDK.</p>",
        sandbox: true,
        sandbox_result: "deliver",
        tags: ["sdk-smoketest"],
      });
      expectAutoIdempotencyKey(request);
      return;
    }
    case "statistics.mjs": {
      expect(requests).toHaveLength(1);
      const request = assertExampleRequest(
        requests,
        0,
        "GET",
        `/v2/accounts/${ACCOUNT_ID}/statistics/transactional/deliverability`,
      );
      expect(Object.keys(request.query).sort()).toEqual(["from_time", "group_by", "to_time"]);
      expect(request.query["group_by"]).toBe("day");
      const fromTime = Date.parse(request.query["from_time"] ?? "");
      const toTime = Date.parse(request.query["to_time"] ?? "");
      expect(Number.isNaN(fromTime)).toBe(false);
      expect(Number.isNaN(toTime)).toBe(false);
      expect(toTime - fromTime).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1_000);
      expect(toTime - fromTime).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1_000);
      return;
    }
    case "update-api-key-ip-list.mjs": {
      expect(requests).toHaveLength(1);
      const request = assertExampleRequest(
        requests,
        0,
        "PUT",
        `/v2/accounts/${ACCOUNT_ID}/api-keys/${RESOURCE_ID}`,
      );
      expectJsonBody(request, { ip_allow_list: ["203.0.113.0/24", "198.51.100.7"] });
      expect(request.headers["idempotency-key"]).toBeUndefined();
      return;
    }
    default:
      throw new Error(`No API request contract is registered for ${example.file}.`);
  }
}

function expectSingleReadonlyRequest(
  requests: readonly ObservedExampleRequest[],
  pathname: string,
  query: Readonly<Record<string, string>> = {},
): void {
  expect(requests).toHaveLength(1);
  const request = assertExampleRequest(requests, 0, "GET", pathname);
  expect(request.query).toEqual(query);
  expect(request.body).toBe("");
  expect(request.headers["idempotency-key"]).toBeUndefined();
}

function assertExampleRequest(
  requests: readonly ObservedExampleRequest[],
  index: number,
  method: string,
  pathname?: string,
): ObservedExampleRequest {
  const request = requiredObservedRequest(requests, index);
  expect(request.httpMethod).toBe(method);
  if (pathname !== undefined) expect(request.pathname).toBe(pathname);
  expect(request.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
  if (method !== "GET") {
    expect(request.query).toEqual({});
    expect(request.headers["content-type"]).toContain("application/json");
  }
  return request;
}

function requiredObservedRequest(
  requests: readonly ObservedExampleRequest[],
  index: number,
): ObservedExampleRequest {
  const request = requests[index];
  if (request === undefined) throw new Error(`Missing observed example request at index ${index}.`);
  return request;
}

function expectJsonBody(request: ObservedExampleRequest, expected: unknown): void {
  expect(JSON.parse(request.body) as unknown).toEqual(expected);
}

function expectAutoIdempotencyKey(request: ObservedExampleRequest): void {
  expect(request.headers["idempotency-key"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
}

function pathMatchesTemplate(pathname: string, pathTemplate: string): boolean {
  const actualSegments = pathname.split("/");
  const templateSegments = pathTemplate.split("/");
  return (
    actualSegments.length === templateSegments.length &&
    templateSegments.every(
      (segment, index) =>
        (/^\{[^{}]+\}$/.test(segment) && actualSegments[index] !== "") ||
        segment === actualSegments[index],
    )
  );
}

function requiredEnvironment(name: "SDK_TARBALL" | "SDK_TARBALL_SHA256"): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for installed-package integration tests.`);
  }
  return value;
}

function verifiedTarball(): string {
  const suppliedPath = requiredEnvironment("SDK_TARBALL");
  const expectedChecksum = requiredEnvironment("SDK_TARBALL_SHA256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum)) {
    throw new Error("SDK_TARBALL_SHA256 must be a 64-character hexadecimal SHA-256 digest.");
  }

  const tarball = resolve(repositoryRoot, suppliedPath);
  if (!statSync(tarball).isFile()) {
    throw new Error(`SDK_TARBALL is not a file: ${tarball}`);
  }

  const actualChecksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `SDK tarball checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}.`,
    );
  }
  return tarball;
}

function installTarball(tarball: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ahasend-sdk-consumer-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "ahasend-sdk-integration-consumer", private: true, type: "module" }),
  );

  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable === undefined ? "npm" : process.execPath;
  const args =
    npmExecutable === undefined
      ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball]
      : [
          npmExecutable,
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          tarball,
        ];
  const result = spawnSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, SCARF_ANALYTICS: "false" },
  });

  if (result.error !== undefined) {
    rmSync(directory, { recursive: true, force: true });
    throw result.error;
  }
  if (result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Failed to install SDK tarball:\n${result.stdout}${result.stderr}`);
  }
  return directory;
}

async function runPackedExample(
  example: PackedExampleCase,
  environmentOverrides: Readonly<Record<string, string>> = {},
): Promise<PackedExampleResult> {
  if (consumerDirectory === undefined) {
    throw new Error("The clean installed-package consumer is not available.");
  }
  const unexpectedEnvironmentKeys = Object.keys(environmentOverrides).filter(
    (name) => !example.allowedEnvironmentOverrides.includes(name),
  );
  if (unexpectedEnvironmentKeys.length > 0) {
    throw new Error(
      `${example.file} received environment keys outside its allowlist: ${unexpectedEnvironmentKeys.join(", ")}`,
    );
  }

  const installedCopy = copyPackedExample(example.file);
  const firstRequestIndex = observedExampleRequests.length;

  return await new Promise<PackedExampleResult>((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(process.execPath, [installedCopy], {
      cwd: consumerDirectory,
      env: {
        AHASEND_ACCOUNT_ID: ACCOUNT_ID,
        AHASEND_API_KEY: API_KEY,
        AHASEND_BASE_URL: baseUrl,
        AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL: "true",
        AHASEND_DEBUG: "false",
        AHASEND_MAX_RETRIES: "0",
        AHASEND_TIMEOUT: "5",
        NO_COLOR: "1",
        ...example.environment,
        ...environmentOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, example.timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        exitCode,
        requests: observedExampleRequests.slice(firstRequestIndex),
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function copyPackedExample(file: string): string {
  if (consumerDirectory === undefined) {
    throw new Error("The clean installed-package consumer is not available.");
  }

  const examplesDirectory = join(consumerDirectory, "examples");
  const source = resolve(repositoryRoot, "examples", file);
  const installedCopy = resolve(examplesDirectory, file);
  mkdirSync(dirname(installedCopy), { recursive: true });
  copyFileSync(source, installedCopy);
  if (readFileSync(installedCopy, "utf8") !== readFileSync(source, "utf8")) {
    throw new Error(`Packed example copy does not match the repository source: ${file}`);
  }
  return installedCopy;
}

function createInMemoryEnqueueOnce(): EnqueueOnce {
  const acceptedWebhookIds = new Set<string>();
  return async (webhookId) => {
    if (acceptedWebhookIds.has(webhookId)) return false;
    acceptedWebhookIds.add(webhookId);
    return true;
  };
}

function createSignedWebhookDelivery(secret: string, webhookId: string): SignedWebhookDelivery {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type: "message.delivered",
    webhook_id: "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1",
    timestamp: new Date().toISOString(),
    data: {
      id: webhookId,
      account_id: ACCOUNT_ID,
      event: "on_delivered",
      from: "sender@example.test",
      recipient: "recipient@example.test",
      subject: "Integration",
      message_id_header: `<${webhookId}@example.test>`,
    },
  });
  const signature = `v1,${createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest("base64")}`;

  return {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
  };
}

function captureProcessOutput(): CapturedProcessOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }),
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout.push(format(...args));
    }),
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      stdout.push(format(...args));
    }),
    vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
      stdout.push(format(...args));
    }),
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(format(...args));
    }),
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      stderr.push(format(...args));
    }),
  ];

  return {
    stdout,
    stderr,
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

function linkExpressHostDependency(): void {
  if (consumerDirectory === undefined) {
    throw new Error("The clean installed-package consumer is not available.");
  }

  const installedExpress = join(consumerDirectory, "node_modules", "express");
  if (existsSync(installedExpress)) return;
  const repositoryExpress = dirname(requireFromRepository.resolve("express/package.json"));
  symlinkSync(repositoryExpress, installedExpress, "junction");
}

async function listenOnEphemeralPort(app: PackedExpressApplication): Promise<Server> {
  return await new Promise((resolveListening, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolveListening(server));
    server.once("error", reject);
  });
}

async function stopHttpServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClosed();
      else reject(error);
    });
  });
}

function loadInstalledPackage(directory: string): {
  readonly sdk: InstalledSdk;
  readonly webhooks: InstalledWebhooks;
  readonly packageEntry: string;
  readonly webhooksEntry: string;
} {
  const requireFromConsumer = createRequire(join(directory, "package.json"));
  const packageEntry = realpathSync(requireFromConsumer.resolve("@ahasend/sdk"));
  const webhooksEntry = realpathSync(requireFromConsumer.resolve("@ahasend/sdk/webhooks"));
  assertConsumerResolution(directory, packageEntry);
  assertConsumerResolution(directory, webhooksEntry);

  const sdkModule = record(requireFromConsumer("@ahasend/sdk"), "@ahasend/sdk");
  const webhookModule = record(
    requireFromConsumer("@ahasend/sdk/webhooks"),
    "@ahasend/sdk/webhooks",
  );
  const clientConstructor = sdkModule["AhaSendClient"];
  const verifierConstructor = webhookModule["WebhookVerifier"];
  if (typeof clientConstructor !== "function" || typeof verifierConstructor !== "function") {
    throw new TypeError("The installed package does not expose its documented constructors.");
  }

  return {
    sdk: { AhaSendClient: clientConstructor as InstalledConstructor },
    webhooks: {
      WebhookVerifier: verifierConstructor as InstalledWebhooks["WebhookVerifier"],
    },
    packageEntry,
    webhooksEntry,
  };
}

function assertConsumerResolution(directory: string, entry: string): void {
  const consumerRoot = realpathSync(directory);
  const pathFromConsumer = relative(consumerRoot, entry);
  if (
    pathFromConsumer === "" ||
    pathFromConsumer.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    pathFromConsumer === ".." ||
    isAbsolute(pathFromConsumer)
  ) {
    throw new Error(`Installed-package integration resolved outside its clean consumer: ${entry}`);
  }
}

function record(value: unknown, label: string): UnknownRecord {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError(`${label} is not an object.`);
  }
  return value as UnknownRecord;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function callMethod(
  root: object,
  target: readonly string[],
  method: string,
  args: readonly unknown[],
): unknown {
  let receiver: object = root;
  for (const segment of target) {
    receiver = record(receiver, segment);
    const next = receiver[segment as keyof typeof receiver];
    receiver = record(next, segment);
  }

  const callable = record(receiver, method)[method];
  if (typeof callable !== "function") {
    throw new TypeError(`${[...target, method].join(".")} is not callable.`);
  }
  return Reflect.apply(callable, receiver, args);
}

async function startExampleRequestProxy(
  upstreamBaseUrl: string,
): Promise<{ readonly server: Server; readonly baseUrl: string }> {
  const server = createHttpServer(async (request, response) => {
    try {
      const observedRequest = await observeIncomingRequest(request);
      observedExampleRequests.push(observedRequest);

      const headers = new Headers(observedRequest.headers);
      headers.delete("connection");
      headers.delete("content-length");
      headers.delete("host");
      const init: RequestInit = { method: observedRequest.httpMethod, headers };
      if (observedRequest.httpMethod !== "GET" && observedRequest.httpMethod !== "HEAD") {
        init.body = observedRequest.body;
      }
      // `request.url` is the raw request-target. An absolute-form target
      // (`GET http://other.example/ HTTP/1.1`) would override the base in
      // `new URL(target, base)` and point this fetch at an arbitrary host, so
      // only the path and query are taken — the upstream authority is always
      // the configured one. Parsed from the raw target rather than the
      // observed record, whose query object collapses duplicate keys.
      const requestTarget = new URL(request.url ?? "/", "http://proxy.invalid");
      const upstreamUrl = new URL(
        `${requestTarget.pathname}${requestTarget.search}`,
        upstreamBaseUrl,
      );
      const upstreamResponse = await fetch(upstreamUrl, init);
      response.statusCode = upstreamResponse.status;
      upstreamResponse.headers.forEach((value, name) => {
        if (!["connection", "content-length", "transfer-encoding"].includes(name)) {
          response.setHeader(name, value);
        }
      });
      response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
    } catch {
      // Constant body: echoing the error would reflect request-derived text
      // into the response. Failures surface through the asserting test — the
      // observed request is already recorded above.
      response.statusCode = 502;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Example request proxy failed.");
    }
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await stopHttpServer(server);
    throw new Error("The example request proxy did not bind to a TCP port.");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function writePrismCanaryDocument(directory: string): string {
  const source = readFileSync(resolve(repositoryRoot, "openapi.yaml"), "utf8");
  const document = yaml.load(source) as OpenAPIDocument;
  const paths = document.paths as Record<string, Readonly<Record<string, unknown>>>;
  paths[PRISM_ENFORCEMENT_CANARY_PATH] = {
    get: {
      operationId: "prismEnforcementCanary",
      security: [],
      responses: {
        "200": {
          description: "Deliberately invalid response used to assert Prism enforcement.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["valid"],
                properties: { valid: { type: "boolean" } },
              },
              example: { valid: "not-a-boolean" },
            },
          },
        },
      },
    },
  };
  const path = resolve(directory, "openapi-with-prism-canary.yaml");
  writeFileSync(path, yaml.dump(document, { noRefs: true }));
  return path;
}

function startPrism(port: number, documentPath: string): CapturedLocalProcess {
  const prismPackage = requireFromRepository.resolve("@stoplight/prism-cli/package.json");
  const manifest = JSON.parse(readFileSync(prismPackage, "utf8")) as {
    readonly bin?: string | Readonly<Record<string, string>>;
  };
  const relativeBin =
    typeof manifest.bin === "string" ? manifest.bin : (manifest.bin?.["prism"] ?? undefined);
  if (relativeBin === undefined) {
    throw new Error("@stoplight/prism-cli does not declare its prism executable.");
  }

  return spawnCapturedProcess(
    process.execPath,
    [
      resolve(dirname(prismPackage), relativeBin),
      "mock",
      documentPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--errors",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
}
