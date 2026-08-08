#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalizeJson, digestJsonArtifact } from "./digest-artifact.mjs";

const CAPTURED_PATH = "contracts/webhooks/captured";
const IMPLEMENTATION = "@ahasend/sdk";
const TOLERANCE_SECONDS = 10 * 365 * 24 * 60 * 60;

function keyFromFile(source, path) {
  if (source.length < 2 || source.at(-1) !== 0x0a || source.subarray(0, -1).includes(0x0a)) {
    throw new TypeError(`${path} must contain one UTF-8 signing key followed by one LF`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(0, -1));
}

function isRouteBound(event, signingResource) {
  return (
    signingResource.type !== "route" ||
    (event.type === "message.routing" && event.route_id === signingResource.id)
  );
}

async function observedResult(root, capture, WebhookVerifier, VerificationError) {
  const [rawBody, keyFile] = await Promise.all([
    readFile(resolve(root, capture.bodyPath)),
    readFile(resolve(root, capture.signingResource.keyPath)),
  ]);
  const verifier = new WebhookVerifier(keyFromFile(keyFile, capture.signingResource.keyPath), {
    toleranceSeconds: TOLERANCE_SECONDS,
  });
  const headers = {
    "webhook-id": capture.webhookId,
    "webhook-timestamp": capture.webhookTimestamp,
    "webhook-signature": capture.signature,
  };

  let result = "invalid";
  try {
    const event = await verifier.parse(headers, rawBody);
    if (isRouteBound(event, capture.signingResource)) result = "valid";
  } catch (error) {
    if (!(error instanceof VerificationError)) throw error;
  }

  return {
    fixture: capture.fixtureId,
    signingResource: {
      type: capture.signingResource.type,
      id: capture.signingResource.id,
    },
    keySha256: capture.signingResource.keySha256,
    captureSha256: digestJsonArtifact(capture),
    webhookId: capture.webhookId,
    webhookTimestamp: capture.webhookTimestamp,
    signature: capture.signature,
    bodySha256: capture.rawBodySha256,
    headersSha256: capture.headersSha256,
    result,
  };
}

export async function runWebhookFixtureResults(root = process.cwd()) {
  const manifestPath = resolve(root, CAPTURED_PATH, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const publicVerifier = await import(pathToFileURL(resolve(root, "dist/webhooks/index.js")).href);
  const results = [];

  for (const capture of manifest.captures) {
    results.push(
      await observedResult(
        root,
        capture,
        publicVerifier.WebhookVerifier,
        publicVerifier.AhaSendWebhookVerificationError,
      ),
    );
  }

  return canonicalizeJson({
    version: 1,
    implementation: IMPLEMENTATION,
    manifestSha256: digestJsonArtifact(manifest),
    results,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 0) {
    throw new TypeError("Usage: node scripts/run-webhook-fixture-results.mjs");
  }
  process.stdout.write(await runWebhookFixtureResults());
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run-webhook-fixture-results: ${message}\n`);
    process.exitCode = 1;
  });
}
