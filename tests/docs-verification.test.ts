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
      "Record the ID atomically after signature verification and before performing side effects.",
    ],
  ])("fails if the %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "docs/security-and-webhooks.md";
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
