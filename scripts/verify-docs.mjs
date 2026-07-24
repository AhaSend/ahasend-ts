#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_DOCUMENT_PATHS = Object.freeze([
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "docs/api-reference.md",
  "docs/cancellation.md",
  "docs/rate-pacing.md",
  "docs/retries-and-idempotency.md",
  "docs/safe-logging.md",
  "docs/security-and-webhooks.md",
  "docs/subaccounts.md",
]);

const REQUIREMENTS = Object.freeze([
  {
    label: "npm installation",
    path: "README.md",
    text: "npm install @ahasend/sdk",
  },
  {
    label: "Node 22 runtime floor",
    path: "README.md",
    text: "Node.js 22 or later",
  },
  {
    label: "JavaScript and TypeScript parity",
    path: "README.md",
    text: "same runtime API to JavaScript and TypeScript",
  },
  {
    label: "CommonJS entry point",
    path: "README.md",
    text: 'require("@ahasend/sdk")',
  },
  {
    label: "supported TypeScript resolution modes",
    path: "README.md",
    text: "`Bundler`, `Node16`, and `NodeNext`",
  },
  {
    label: "unsupported runtime boundary",
    path: "README.md",
    text: "Browsers and edge runtimes",
  },
  {
    label: "Express 5 support",
    path: "README.md",
    text: "Express 5.x",
  },
  {
    label: "pagination guidance",
    path: "README.md",
    text: "pages are fetched lazily",
  },
  {
    label: "constructor timeout unit",
    path: "docs/cancellation.md",
    text: "`timeoutMs` is a per-network-attempt budget in **milliseconds**",
  },
  {
    label: "environment timeout unit",
    path: "docs/cancellation.md",
    text: "`AHASEND_TIMEOUT` in **seconds**",
  },
  {
    label: "end-to-end caller cancellation",
    path: "docs/cancellation.md",
    text: "waiting for a local rate-limit\ntoken, `fetch`, response-body reading, retry backoff, and later attempts",
  },
  {
    label: "pacing timeout boundary",
    path: "docs/rate-pacing.md",
    text: "Local pacing happens before the per-attempt `timeoutMs` budget starts",
  },
  {
    label: "pacing categories",
    path: "docs/rate-pacing.md",
    text: "independent in-memory token buckets for standard and statistics operations",
  },
  {
    label: "pacing header independence",
    path: "docs/rate-pacing.md",
    text: "does not learn from undocumented\nremaining-quota response headers",
  },
  {
    label: "retry status policy",
    path: "docs/retries-and-idempotency.md",
    text: "HTTP 408, 429, and 5xx responses",
  },
  {
    label: "idempotency key reuse",
    path: "docs/retries-and-idempotency.md",
    text: "reuses the\nsame value across all internal retry attempts",
  },
  {
    label: "secret replay retention",
    path: "docs/retries-and-idempotency.md",
    text: "5-minute replay window",
  },
  {
    label: "safe telemetry shape",
    path: "docs/safe-logging.md",
    text: "They do not expose the expanded\nURL, query string, request headers, or request body",
  },
  {
    label: "sensitive logging inventory",
    path: "docs/safe-logging.md",
    text: "one-time `secret_key` values",
  },
  {
    label: "error logging warning",
    path: "docs/safe-logging.md",
    text: "do not serialize the whole error blindly",
  },
  {
    label: "IP allow-list behavior",
    path: "docs/subaccounts.md",
    text: "A non-empty list restricts the\nkey on every v2 endpoint regardless of scopes",
  },
  {
    label: "self-lockout behavior",
    path: "docs/subaccounts.md",
    text: "terminal\nHTTP 409 and persists nothing",
  },
  {
    label: "child-key boundary",
    path: "docs/subaccounts.md",
    text: "Child credentials cannot manage nested child API keys",
  },
  {
    label: "pooled usage semantics",
    path: "docs/subaccounts.md",
    text: "`allocated_cost` is an allocation of the pooled\ninvoice, not standalone pricing",
  },
  {
    label: "timestamp versus replay distinction",
    path: "docs/security-and-webhooks.md",
    text: "Timestamp-window verification is not replay deduplication.",
  },
  {
    label: "application webhook-id responsibility",
    path: "docs/security-and-webhooks.md",
    text: "Applications must deduplicate the `webhook-id` value.",
  },
  {
    label: "atomic webhook replay claim",
    path: "docs/security-and-webhooks.md",
    text: "Record the ID atomically after signature verification and before performing side effects.",
  },
  {
    label: "duplicate webhook rejection pattern",
    path: "docs/security-and-webhooks.md",
    text: "Duplicate delivery: acknowledge it but do not run the application handler again.",
  },
  {
    label: "verified webhook integration",
    path: "docs/security-and-webhooks.md",
    text: "expressWebhookHandler(verifier",
  },
  {
    label: "webhook adapter error semantics",
    path: "docs/security-and-webhooks.md",
    text: "`onError` is observation-only",
  },
  {
    label: "webhook adapter body outcomes",
    path: "docs/security-and-webhooks.md",
    text: "Invalid signatures and schemas receive an opaque 400 response",
  },
  {
    label: "Express native error propagation",
    path: "docs/security-and-webhooks.md",
    text: "the adapter calls `next(originalError)` exactly once",
  },
  {
    label: "private vulnerability reporting",
    path: "SECURITY.md",
    text: "Report suspected vulnerabilities privately",
  },
  {
    label: "supported release line",
    path: "SECURITY.md",
    text: "latest published minor line",
  },
  {
    label: "security response targets",
    path: "SECURITY.md",
    text: "acknowledge a report within three business days",
  },
  {
    label: "security disclosure policy",
    path: "SECURITY.md",
    text: "coordinate a disclosure date",
  },
  {
    label: "v0.1.0 surface",
    path: "CHANGELOG.md",
    text: "## [0.1.0] — Unreleased",
  },
]);

export async function loadDocumentation(root = repositoryRoot) {
  return Object.fromEntries(
    await Promise.all(
      REQUIRED_DOCUMENT_PATHS.map(async (path) => [
        path,
        await readFile(resolve(root, path), "utf8"),
      ]),
    ),
  );
}

export function verifyDocumentation(documents) {
  if (documents === null || typeof documents !== "object" || Array.isArray(documents)) {
    throw new TypeError("Documentation input must be a path-to-source record.");
  }

  for (const path of REQUIRED_DOCUMENT_PATHS) {
    if (typeof documents[path] !== "string") {
      throw new TypeError(`Missing required documentation file: ${path}`);
    }
  }

  for (const requirement of REQUIREMENTS) {
    if (!documents[requirement.path].includes(requirement.text)) {
      throw new TypeError(`${requirement.path} is missing required guidance: ${requirement.label}`);
    }
  }
}

async function main() {
  if (process.argv.length !== 2) {
    throw new TypeError("Usage: node scripts/verify-docs.mjs");
  }
  const documents = await loadDocumentation();
  verifyDocumentation(documents);
  process.stdout.write(`verify-docs: ${REQUIRED_DOCUMENT_PATHS.length} documents passed\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-docs: ${message}\n`);
    process.exitCode = 1;
  });
}
