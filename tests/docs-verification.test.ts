import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildDocumentationIndex,
  loadDocumentation,
  verifyDocumentation,
  verifyDocumentationIndex,
} from "../scripts/verify-docs.mjs";

describe("operational documentation verification", () => {
  it("accepts the committed operational and security guidance", async () => {
    const documents = await loadDocumentation();

    expect(() => verifyDocumentation(documents)).not.toThrow();

    const check = spawnSync(process.execPath, ["scripts/verify-docs.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.stdout).toContain("10 documents passed");
    expect(check.status).toBe(0);
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
