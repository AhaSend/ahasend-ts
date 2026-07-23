import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
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

const PAGINATION = { limit: 5 };
const STATISTICS = {
  from_time: "2026-04-01T00:00:00Z",
  to_time: "2026-04-30T00:00:00Z",
  sender_domain: DOMAIN,
  group_by: "day",
};

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

describe("packed SDK operation contract", () => {
  it("covers every operation declared by openapi.yaml exactly once", () => {
    const source = readFileSync(resolve(repositoryRoot, "openapi.yaml"), "utf8");
    const operationIds = [...source.matchAll(/^\s+operationId:\s+(\S+)\s*$/gm)].map(
      (match) => match[1],
    );

    expect(OPERATION_CASES).toHaveLength(56);
    expect(new Set(OPERATION_CASES.map(({ operationId }) => operationId)).size).toBe(56);
    expect(OPERATION_CASES.map(({ operationId }) => operationId).sort()).toEqual(
      operationIds.sort(),
    );
  });

  it.each(OPERATION_CASES)("$operationId", async ({ target, method, args = [] }) => {
    const client = new installedSdk.AhaSendClient({
      apiKey: API_KEY,
      accountId: ACCOUNT_ID,
      baseUrl,
      retry: { enabled: false },
    });

    await expect(callMethod(client, target, method, args)).resolves.toBeDefined();
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
