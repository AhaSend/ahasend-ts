import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NODE_CODE_SAMPLES } from "../scripts/node-code-samples.mjs";
import {
  buildDocumentationIndex,
  loadDocumentation,
  verifyDocumentation,
  verifyDocumentationIndex,
  verifyPackagedJavaScript,
  verifySafeOutput,
} from "../scripts/verify-docs.mjs";

const repositoryRoot = process.cwd();
const packedSdkDirectory = mkdtempSync(join(tmpdir(), "ahasend-docs-verification-test-"));
let packedSdkTarball = "";
let packedSdkChecksum = "";

beforeAll(() => {
  const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);

  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable === undefined ? "npm" : process.execPath;
  const args = [
    ...(npmExecutable === undefined ? [] : [npmExecutable]),
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    packedSdkDirectory,
  ];
  const pack = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  expect(pack.status, `${pack.stdout}${pack.stderr}`).toBe(0);

  const tarballs = readdirSync(packedSdkDirectory).filter((name) => name.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  packedSdkTarball = resolve(packedSdkDirectory, tarballs[0]!);
  packedSdkChecksum = createHash("sha256").update(readFileSync(packedSdkTarball)).digest("hex");
});

afterAll(() => {
  rmSync(packedSdkDirectory, { recursive: true, force: true });
});

describe("operational documentation verification", () => {
  it("supports source-only verification of the committed guidance", async () => {
    const documents = await loadDocumentation();

    expect(() => verifyDocumentation(documents)).not.toThrow();

    const environment = { ...process.env };
    delete environment.SDK_TARBALL;
    delete environment.SDK_TARBALL_SHA256;
    const check = spawnSync(process.execPath, ["scripts/verify-docs.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });
    expect(check.stderr).toBe("");
    expect(check.stdout).toContain("10 documents passed");
    expect(check.status).toBe(0);
  });

  it("strict-checks all 56 SDK samples against the packed declarations", async () => {
    expect(Object.keys(NODE_CODE_SAMPLES)).toHaveLength(56);

    await expect(
      verifyPackagedJavaScript(packedSdkTarball, packedSdkChecksum),
    ).resolves.toBeUndefined();
  });

  it("rejects a packed sample that is outside the public facade declarations", async () => {
    const pingSample = NODE_CODE_SAMPLES.ping;
    expect(pingSample).toBeDefined();
    const invalidSamples = {
      ...NODE_CODE_SAMPLES,
      ping: {
        ...pingSample!,
        source: pingSample!.source.replace("client.ping()", "client.notAnSdkMethod()"),
      },
    };

    await expect(
      verifyPackagedJavaScript(packedSdkTarball, packedSdkChecksum, repositoryRoot, invalidSamples),
    ).rejects.toThrow(/Property 'notAnSdkMethod' does not exist on type 'AhaSendClient'/u);
  });

  it("indexes and verifies commands, links, snippets, examples, samples, and profile counts", async () => {
    const index = await buildDocumentationIndex();

    expect(index.commands.length).toBeGreaterThan(0);
    expect(index.links.length).toBeGreaterThan(0);
    expect(index.snippets.length).toBeGreaterThan(0);
    expect(index.examples.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "examples/bootstrap-subaccount.mjs",
        "examples/next-webhook-route.mjs",
        "examples/update-api-key-ip-list.mjs",
        "examples/webhook-express.mjs",
      ]),
    );
    expect(Object.keys(index.nodeSamples)).toHaveLength(56);
    expect(index.profileSummary).toEqual({ operations: 56, iterators: 9 });
    await expect(verifyDocumentationIndex(index)).resolves.toBeUndefined();
  });

  it("rejects unguarded mutations and webhook handlers without durable ID deduplication", async () => {
    const index = await buildDocumentationIndex();
    const unsafeMutation = {
      ...structuredClone(index),
      examples: index.examples.map((example) =>
        example.path === "examples/update-api-key-ip-list.mjs"
          ? {
              ...example,
              source: example.source.replace(
                `if (process.env.AHASEND_ALLOW_MUTATIONS !== "1") {
  throw new Error("Refusing mutation; set AHASEND_ALLOW_MUTATIONS=1 after reviewing the script.");
}
`,
                '// process.env.AHASEND_ALLOW_MUTATIONS !== "1"\n',
              ),
            }
          : example,
      ),
    };
    await expect(verifyDocumentationIndex(unsafeMutation)).rejects.toThrow(/unguarded mutation/);

    const missingDeduplication = {
      ...structuredClone(index),
      examples: index.examples.map((example) =>
        example.path === "examples/webhook-express.mjs"
          ? {
              ...example,
              source: example.source.replace(
                `if (!accepted) {
      res.statusCode = 200;
      res.end();
      return;
    }`,
                `// enqueueOnce(webhookId, event)
    // if (!accepted) return;`,
              ),
            }
          : example,
      ),
    };
    await expect(verifyDocumentationIndex(missingDeduplication)).rejects.toThrow(
      /application-owned webhook-id deduplication/,
    );
  });

  it("rejects sensitive values in multiline console output", async () => {
    const index = await buildDocumentationIndex();
    const unsafeOutput = {
      ...structuredClone(index),
      examples: index.examples.map((example) =>
        example.path === "examples/bootstrap-subaccount.mjs"
          ? {
              ...example,
              source: example.source.replace(
                "console.log(`✓ created child account and stored its one-time key in ${secretFile}`);",
                `console.log({
  secret: key.secret_key,
});`,
              ),
            }
          : example,
      ),
    };

    await expect(verifyDocumentationIndex(unsafeOutput)).rejects.toThrow(
      /unsafe secret or payload output/,
    );
  });

  it.each([
    ["whole objects", "console.log(response);"],
    ["nested values", "console.log(response.data);"],
    ["nested objects", "console.log({ request: { status: err.status } });"],
    ["arrays", "console.log([response.id]);"],
    [
      "aliases",
      `const recipient = event.data.recipient;
const output = recipient;
console.log(output);`,
    ],
    ["template literals", "console.log(`recipient: ${event.data.recipient}`);"],
    ["error messages", "logger.error(err.message);"],
  ])("rejects unsafe output through %s", (_label, source) => {
    expect(() => verifySafeOutput("unsafe-output-fixture.mjs", source)).toThrow(
      /unsafe secret or payload output/,
    );
  });

  it("accepts only selected allowlisted SDK output", () => {
    expect(() =>
      verifySafeOutput(
        "safe-output-fixture.mjs",
        `console.log({
  count: response.data.length,
  messageId: response.data[0]?.id,
  status: err.status,
  errorCode: err.code,
  requestId: err.requestId,
});`,
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "missing",
      (source: string) =>
        source.replace(
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n",
          "",
        ),
    ],
    [
      "duplicate",
      (source: string) =>
        source.replace(
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n",
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n| `statistics.mjs`             | Duplicate fixture                                                                                                 |\n",
        ),
    ],
    [
      "orphan",
      (source: string) =>
        source.replace(
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n",
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n| `not-an-example.mjs`         | Orphan fixture                                                                                                    |\n",
        ),
    ],
  ])("rejects a %s advertised example inventory entry", async (kind, mutate) => {
    const index = await buildDocumentationIndex();
    const invalidInventory = {
      ...structuredClone(index),
      documents: {
        ...index.documents,
        "examples/README.md": mutate(index.documents["examples/README.md"]!),
      },
    };

    await expect(verifyDocumentationIndex(invalidInventory)).rejects.toThrow(
      new RegExp(`advertised example inventory.*${kind}`, "u"),
    );
  });

  it("rejects TypeScript snippets that import a missing SDK export", async () => {
    const index = await buildDocumentationIndex();
    const invalidImport = {
      ...structuredClone(index),
      snippets: index.snippets.map((snippet) =>
        snippet.path === "README.md" && snippet.source.includes("import { AhaSendClient }")
          ? {
              ...snippet,
              source: snippet.source.replace(
                "import { AhaSendClient }",
                "import { DefinitelyNotAnSdkExport }",
              ),
            }
          : snippet,
      ),
    };

    await expect(verifyDocumentationIndex(invalidImport)).rejects.toThrow(
      /imports missing @ahasend\/sdk export DefinitelyNotAnSdkExport/,
    );
  });

  it.each([
    [
      "webhook-id deduplication responsibility",
      "Applications must deduplicate the `webhook-id` value.",
    ],
    ["timestamp-window distinction", "Timestamp-window verification is not replay deduplication."],
    [
      "atomic duplicate integration pattern",
      "Record the ID atomically after signature verification and before performing side effects, in the\nsame transaction as durable processing work.",
    ],
    [
      "Express adapter-owned raw stream",
      "mounts `expressWebhookHandler` directly so the adapter reads the bounded raw\nstream and owns the empty 413 response",
    ],
    [
      "transactional durable enqueue contract",
      "must commit both the unique `webhook-id` record and a\ndurable work/outbox record",
    ],
    [
      "webhook-id durable enqueue integration code",
      "const accepted = await webhookDeliveries.enqueueOnce(webhookId, event);",
    ],
    [
      "duplicate webhook early-return integration code",
      `if (!accepted) {
      res.statusCode = 200;
      res.end();
      return;
    }`,
    ],
    [
      "durable worker retry behavior",
      "A worker\nfailure then leaves retryable work instead of turning the sender's next delivery into a false\nsuccess.",
    ],
  ])("fails if the %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "docs/security-and-webhooks.md";
    documents[path] = documents[path]!.replace(requiredText, "");

    expect(() => verifyDocumentation(documents)).toThrow(/required guidance/);
  });

  it.each([
    ["README Express parser", "README.md", '  express.raw({ type: "*/*" }),\n'],
    [
      "security-guide Express parser",
      "docs/security-and-webhooks.md",
      '  express.raw({ type: "*/*", limit: "1mb" }),\n',
    ],
    [
      "claim-only webhook deduplication",
      "docs/security-and-webhooks.md",
      "    await webhookDeliveries.claim(webhookId);\n",
    ],
    [
      "full SDK error exception telemetry",
      "README.md",
      "    onError: (e) => sentry.captureException(e.error),\n",
    ],
    [
      "webhook recipient console output",
      "README.md",
      "        console.log(`delivered → ${event.data.recipient}`);\n",
    ],
  ])("fails if the %s pattern is introduced", async (_label, path, unsafeText) => {
    const documents = await loadDocumentation();
    documents[path] = `${documents[path]}\n${unsafeText}`;

    expect(() => verifyDocumentation(documents)).toThrow(/unsafe guidance/);
  });

  it.each([
    [
      "idempotent-operation inventory",
      "all 11 endpoints whose generated operation profile marks them idempotent",
    ],
    ["parsed webhook body behavior", "The adapters treat an already-parsed body as a setup error"],
    [
      "allow-listed error telemetry",
      'errorCode: isAhaSendError(e.error) ? e.error.code : "unknown"',
    ],
    ["webhook metric without recipient data", 'metrics.increment("ahasend.webhook.delivered");'],
  ])("fails if the README %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "README.md";
    documents[path] = documents[path]!.replace(requiredText, "");

    expect(() => verifyDocumentation(documents)).toThrow(/required guidance/);
  });

  it.each([
    ["operation-level retry gate", "`maxRetries` never overrides the operation-level gate"],
    ["default first-retry jitter range", "the first retry waits from 500 to 1,000 milliseconds"],
  ])("fails if the %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "docs/retries-and-idempotency.md";
    documents[path] = documents[path]!.replace(requiredText, "");

    expect(() => verifyDocumentation(documents)).toThrow(/required guidance/);
  });
});
