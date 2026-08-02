import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

interface PackedExampleCase {
  readonly file: string;
  readonly expectedMarkers: readonly string[];
}

interface PackedExampleResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface GuardedPackedExampleCase extends PackedExampleCase {
  readonly environment: Readonly<Record<string, string>>;
  readonly usesSecretFile: boolean;
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

const PAGINATION = { limit: 5 };
const STATISTICS = {
  from_time: "2026-04-01T00:00:00Z",
  to_time: "2026-04-30T00:00:00Z",
  sender_domain: DOMAIN,
  group_by: "day",
};
const PACKED_EXAMPLE_TIMEOUT_MS = 15_000;
const PACKED_EXAMPLE_CASES = [
  { file: "get-account.mjs", expectedMarkers: ["✓ account id=", "status=200"] },
  { file: "iterate.mjs", expectedMarkers: ["✓ iterated 1 message(s)"] },
  { file: "list-api-keys.mjs", expectedMarkers: ["API key(s) status=200"] },
  { file: "list-domains.mjs", expectedMarkers: ["domain(s) status=200"] },
  { file: "list-routes.mjs", expectedMarkers: ["route(s) status=200"] },
  { file: "list-suppressions.mjs", expectedMarkers: ["suppression(s) status=200"] },
  { file: "ping.mjs", expectedMarkers: ["✓ ping status=200"] },
  { file: "statistics.mjs", expectedMarkers: ["bucket(s) returned status=200"] },
  {
    file: "telemetry.mjs",
    expectedMarkers: ["→ request started", "← response received", "✓ done"],
  },
] as const satisfies readonly PackedExampleCase[];
const GUARDED_PACKED_EXAMPLE_CASES = [
  {
    file: "bootstrap-subaccount.mjs",
    expectedMarkers: ["✓ created child account id=", "stored its one-time key"],
    environment: {
      AHASEND_SUBACCOUNT_NAME: "Integration child",
      AHASEND_SUBACCOUNT_WEBSITE: `child.${DOMAIN}`,
    },
    usesSecretFile: true,
  },
  {
    file: "idempotency.mjs",
    expectedMarkers: ["✓ first send:", "✓ replay send:", "(no duplicate email)"],
    environment: { AHASEND_FROM_EMAIL: `sender@${DOMAIN}` },
    usesSecretFile: false,
  },
  {
    file: "send-sandbox.mjs",
    expectedMarkers: ["✓ sandbox send accepted for ", "recipient(s)"],
    environment: { AHASEND_FROM_EMAIL: `sender@${DOMAIN}` },
    usesSecretFile: false,
  },
  {
    file: "update-api-key-ip-list.mjs",
    expectedMarkers: ["✓ updated IP allow-list with ", "canonical entries"],
    environment: {
      AHASEND_API_KEY_ID: RESOURCE_ID,
      AHASEND_IP_ALLOW_LIST: "203.0.113.0/24,198.51.100.7",
    },
    usesSecretFile: false,
  },
] as const satisfies readonly GuardedPackedExampleCase[];

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

const SPEC_OPERATIONS = loadSpecOperations();

let consumerDirectory: string | undefined;
let prismProcess: ChildProcess | undefined;
let prismOutput = "";
let baseUrl = "";
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

  const port = await availablePort();
  prismProcess = startPrism(port);
  baseUrl = `http://127.0.0.1:${port}`;
  await waitForPrism(prismProcess, `${baseUrl}/v2/ping`, 60_000);
}, 120_000);

afterAll(async () => {
  await stopProcess(prismProcess);
  if (consumerDirectory !== undefined) {
    rmSync(consumerDirectory, { recursive: true, force: true });
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
});

describe("packed readonly examples", () => {
  it.each(PACKED_EXAMPLE_CASES)("executes $file from the clean consumer", async (example) => {
    const result = await runPackedExample(example.file);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const marker of example.expectedMarkers) expect(output).toContain(marker);
    expect(output).not.toContain(API_KEY);
  });
});

describe("packed typed error example", () => {
  it("reports only allowlisted fields from a deterministic local 404", async () => {
    const rawResponseMessage = "private upstream diagnostic must not be logged";
    const suppliedApiKey = "aha-sk-error-example-secret";
    const requestId = "req_error_example_404";
    const responder = createHttpServer((_request, response) => {
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
      const result = await runPackedExample("error-handling.mjs", {
        AHASEND_API_KEY: suppliedApiKey,
        AHASEND_BASE_URL: `http://127.0.0.1:${address.port}`,
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `✓ caught AhaSendNotFoundError status=404 code=not_found_error request-id=${requestId}\n`,
      );
      expect(output).not.toContain(rawResponseMessage);
      expect(output).not.toContain(suppliedApiKey);
      expect(output).not.toContain(API_KEY);
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
  it("verifies and rejects the exact example without exposing raw errors or secrets", async () => {
    const fixtureSecret = "aha-whsec-local-demo-secret-please-rotate";
    const result = await runPackedExample("verify-webhook.mjs", {
      AHASEND_BASE_URL: "http://127.0.0.1:1",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
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
    "accepts the first signed delivery and acknowledges its duplicate",
    async () => {
      const secret = "aha-whsec-express-integration-secret";
      const webhookId = "msg_express_it_1";
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
          message_id_header: "<express-integration@example.test>",
        },
      });
      const signature = `v1,${createHmac("sha256", Buffer.from(secret, "utf8"))
        .update(`${webhookId}.${timestamp}.${body}`)
        .digest("base64")}`;
      const headers = {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature,
      };

      linkExpressHostDependency();
      const installedCopy = copyPackedExample("webhook-express.mjs");
      const example = (await import(pathToFileURL(installedCopy).href)) as PackedExpressExample;
      const app = example.createWebhookApp({
        secret,
        enqueueOnce: createInMemoryEnqueueOnce(),
      });
      let server: Server | undefined;

      try {
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
      }

      expect(server?.listening).toBe(false);
    },
    PACKED_EXAMPLE_TIMEOUT_MS,
  );
});

describe("packed guarded mutation examples", () => {
  it.each(GUARDED_PACKED_EXAMPLE_CASES)(
    "refuses $file without explicit mutation approval",
    async (example) => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "ahasend-guarded-example-"));
      const secretFile = join(temporaryDirectory, "child-api-key.secret");
      const environment = example.usesSecretFile
        ? { ...example.environment, AHASEND_CHILD_SECRET_FILE: secretFile }
        : example.environment;

      try {
        const result = await runPackedExample(example.file, environment);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.timedOut).toBe(false);
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Refusing mutation; set AHASEND_ALLOW_MUTATIONS=1");
        expect(output).not.toContain(API_KEY);
        expect(output).not.toContain(secretFile);
        for (const suppliedValue of Object.values(example.environment)) {
          expect(output).not.toContain(suppliedValue);
        }
        expect(existsSync(secretFile)).toBe(false);
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      expect(existsSync(temporaryDirectory)).toBe(false);
    },
  );

  it.each(GUARDED_PACKED_EXAMPLE_CASES)(
    "executes the approved $file mutation against Prism",
    async (example) => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "ahasend-guarded-example-"));
      const secretFile = join(temporaryDirectory, "child-api-key.secret");
      const environment = {
        ...example.environment,
        AHASEND_ALLOW_MUTATIONS: "1",
        ...(example.usesSecretFile ? { AHASEND_CHILD_SECRET_FILE: secretFile } : {}),
      };

      try {
        const result = await runPackedExample(example.file, environment);
        const output = `${result.stdout}${result.stderr}`;

        expect(result.timedOut).toBe(false);
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        for (const marker of example.expectedMarkers) expect(output).toContain(marker);
        expect(output).not.toContain(API_KEY);
        expect(output).not.toContain(secretFile);
        for (const suppliedValue of Object.values(example.environment)) {
          expect(output).not.toContain(suppliedValue);
        }

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
  it("covers every operation declared by openapi.yaml exactly once", () => {
    const operationIds = [...SPEC_OPERATIONS.keys()];

    expect(OPERATION_CASES).toHaveLength(56);
    expect(new Set(OPERATION_CASES.map(({ operationId }) => operationId)).size).toBe(56);
    expect(OPERATION_CASES.map(({ operationId }) => operationId).sort()).toEqual(
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
  it("verifies a signed payload through the installed subpath", () => {
    const secret = "aha-whsec-integration-secret";
    const verifier = new installedWebhooks.WebhookVerifier(secret);
    const id = "msg_it_1";
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: "message.delivered",
      webhook_id: "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1",
      timestamp: new Date().toISOString(),
      data: {
        id,
        account_id: ACCOUNT_ID,
        event: "on_delivered",
        from: "sender@example.test",
        recipient: "recipient@example.test",
        subject: "Integration",
        message_id_header: "<integration@example.test>",
      },
    });
    const signature = `v1,${createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")}`;

    const event = callMethod(verifier, [], "parse", [
      {
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature,
      },
      body,
    ]);
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
  file: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<PackedExampleResult> {
  if (consumerDirectory === undefined) {
    throw new Error("The clean installed-package consumer is not available.");
  }

  const installedCopy = copyPackedExample(file);

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
        ...environment,
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
    }, PACKED_EXAMPLE_TIMEOUT_MS);

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
      resolveResult({ exitCode, signal, stdout, stderr, timedOut });
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
  mkdirSync(examplesDirectory, { recursive: true });
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

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a Prism port."));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else reject(error);
      });
    });
  });
}

function startPrism(port: number): ChildProcess {
  const prismPackage = requireFromRepository.resolve("@stoplight/prism-cli/package.json");
  const manifest = JSON.parse(readFileSync(prismPackage, "utf8")) as {
    readonly bin?: string | Readonly<Record<string, string>>;
  };
  const relativeBin =
    typeof manifest.bin === "string" ? manifest.bin : (manifest.bin?.["prism"] ?? undefined);
  if (relativeBin === undefined) {
    throw new Error("@stoplight/prism-cli does not declare its prism executable.");
  }

  const child = spawn(
    process.execPath,
    [
      resolve(dirname(prismPackage), relativeBin),
      "mock",
      resolve(repositoryRoot, "openapi.yaml"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--errors",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer | string) => {
    prismOutput += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    prismOutput += chunk.toString();
  });
  return child;
}

async function waitForPrism(
  child: ChildProcess,
  readinessUrl: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Prism exited before becoming ready (${child.exitCode}):\n${prismOutput}`);
    }
    try {
      const response = await fetch(readinessUrl, {
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      if (response.ok) return;
    } catch {
      // The local process has not started listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Prism did not become ready within ${timeoutMs}ms:\n${prismOutput}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
