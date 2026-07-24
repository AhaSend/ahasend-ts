import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadDocumentation, verifyDocumentation } from "../scripts/verify-docs.mjs";

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
