#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestJsonArtifact } from "./digest-artifact.mjs";
import { validateCapturedManifest, validateSignedFixture } from "./generate-contracts.mjs";
import {
  decodeUtf8,
  parseCanonicalJson,
  parseSha256Sidecar,
  requireExactKeys,
  requireHash,
  requireObject,
  requireString,
} from "./report-validation.mjs";
import { validateRendererReport } from "./verify-renderer-report.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function parseJson(source, label) {
  try {
    return requireObject(JSON.parse(decodeUtf8(source, label)), label);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(`${label} must`)) throw error;
    throw new TypeError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }
}

function requireServerCommit(value, label) {
  if (typeof value !== "string" || !SERVER_COMMIT_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase 40-character Git commit.`);
  }
  return value;
}

function requireResult(value, label) {
  if (value !== "valid" && value !== "invalid") {
    throw new TypeError(`${label} must be valid or invalid.`);
  }
  return value;
}

function parseSigningResource(value, label) {
  const resource = requireObject(value, label);
  requireExactKeys(resource, ["id", "type"], label);
  const type = requireString(resource.type, `${label}.type`);
  if (type !== "configured-webhook" && type !== "route") {
    throw new TypeError(`${label}.type must be configured-webhook or route.`);
  }
  return {
    type,
    id: requireString(resource.id, `${label}.id`),
  };
}

function parseEvidenceRow(value, label, { go }) {
  const row = requireObject(value, label);
  const commonFields = [
    "bodySha256",
    "captureSha256",
    "fixture",
    "headersSha256",
    "keySha256",
    "signature",
    "signingResource",
    "webhookId",
    "webhookTimestamp",
  ];
  requireExactKeys(
    row,
    go
      ? [...commonFields, "actualResult", "expectedResult", "serverCommit"]
      : [...commonFields, "result"],
    label,
  );
  const parsed = {
    fixture: requireString(row.fixture, `${label}.fixture`),
    signingResource: parseSigningResource(row.signingResource, `${label}.signingResource`),
    keySha256: requireHash(row.keySha256, `${label}.keySha256`),
    captureSha256: requireHash(row.captureSha256, `${label}.captureSha256`),
    webhookId: requireString(row.webhookId, `${label}.webhookId`),
    webhookTimestamp: requireString(row.webhookTimestamp, `${label}.webhookTimestamp`),
    signature: requireString(row.signature, `${label}.signature`),
    bodySha256: requireHash(row.bodySha256, `${label}.bodySha256`),
    headersSha256: requireHash(row.headersSha256, `${label}.headersSha256`),
  };
  if (!/^\d+$/u.test(parsed.webhookTimestamp)) {
    throw new TypeError(`${label}.webhookTimestamp must contain decimal digits.`);
  }
  return go
    ? {
        ...parsed,
        serverCommit: requireServerCommit(row.serverCommit, `${label}.serverCommit`),
        expectedResult: requireResult(row.expectedResult, `${label}.expectedResult`),
        actualResult: requireResult(row.actualResult, `${label}.actualResult`),
      }
    : {
        ...parsed,
        result: requireResult(row.result, `${label}.result`),
      };
}

function parseResults(value, label, options) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const fixtures = new Set();
  return value.map((row, index) => {
    const parsed = parseEvidenceRow(row, `${label}[${index}]`, options);
    if (fixtures.has(parsed.fixture)) {
      throw new TypeError(`${label} contains duplicate fixture ${parsed.fixture}.`);
    }
    fixtures.add(parsed.fixture);
    return parsed;
  });
}

function expectedRow(capture) {
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
  };
}

function requireMatchingEvidence(actual, expected, label) {
  for (const field of [
    "fixture",
    "keySha256",
    "captureSha256",
    "webhookId",
    "webhookTimestamp",
    "signature",
    "bodySha256",
    "headersSha256",
  ]) {
    if (actual[field] !== expected[field]) {
      throw new TypeError(`${label} ${field} mismatch.`);
    }
  }
  if (
    actual.signingResource.type !== expected.signingResource.type ||
    actual.signingResource.id !== expected.signingResource.id
  ) {
    throw new TypeError(`${label} signing resource mismatch.`);
  }
}

export function validateWebhookAttestations({
  manifestSource,
  manifestSchemaSource,
  manifestSidecar,
  typescriptResultsSource,
  typescriptResultsSidecar,
  goResultsSource,
  fixtureSources,
}) {
  const manifest = parseJson(manifestSource, "Captured manifest");
  const schema = parseJson(manifestSchemaSource, "Captured manifest schema");
  const captures = validateCapturedManifest(manifest, schema);
  const manifestDigest = digestJsonArtifact(manifest);
  if (parseSha256Sidecar(manifestSidecar, "Captured manifest sidecar") !== manifestDigest) {
    throw new TypeError("Captured manifest sidecar mismatch.");
  }

  const typescriptResults = parseJson(typescriptResultsSource, "TypeScript webhook results");
  requireExactKeys(
    typescriptResults,
    ["implementation", "manifestSha256", "results", "version"],
    "TypeScript webhook results",
  );
  if (
    parseSha256Sidecar(typescriptResultsSidecar, "TypeScript webhook results sidecar") !==
    digestJsonArtifact(typescriptResults)
  ) {
    throw new TypeError("TypeScript webhook results sidecar mismatch.");
  }
  if (typescriptResults.version !== 1 || typescriptResults.implementation !== "@ahasend/sdk") {
    throw new TypeError("TypeScript webhook results must identify @ahasend/sdk version 1.");
  }
  if (typescriptResults.manifestSha256 !== manifestDigest) {
    throw new TypeError("TypeScript webhook results reference a stale capture digest.");
  }
  const typescriptRows = parseResults(
    typescriptResults.results,
    "TypeScript webhook results rows",
    { go: false },
  );

  const goPayload = parseCanonicalJson(goResultsSource, "Go webhook attestation");
  const goResults = goPayload.value;
  requireExactKeys(
    goResults,
    ["implementation", "manifestSha256", "results", "serverCommit", "version"],
    "Go webhook attestation",
  );
  if (goResults.version !== 1 || goResults.implementation !== "ahasend-go") {
    throw new TypeError("Go webhook attestation must identify ahasend-go version 1.");
  }
  const capturedServerCommit = requireServerCommit(
    manifest.serverCommit,
    "Captured manifest serverCommit",
  );
  const serverCommit = requireServerCommit(
    goResults.serverCommit,
    "Go webhook attestation serverCommit",
  );
  if (serverCommit !== capturedServerCommit) {
    throw new TypeError("Go webhook attestation has a stale serverCommit.");
  }
  if (goResults.manifestSha256 !== manifestDigest) {
    throw new TypeError("Go webhook attestation references a stale capture digest.");
  }
  const goRows = parseResults(goResults.results, "Go webhook attestation rows", {
    go: true,
  });

  if (typescriptRows.length !== captures.length || goRows.length !== captures.length) {
    throw new TypeError(`Webhook attestations must contain ${captures.length} fixture rows.`);
  }

  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index];
    const typescriptRow = typescriptRows[index];
    const goRow = goRows[index];
    const label = `Webhook fixture ${capture.fixtureId}`;
    requireMatchingEvidence(typescriptRow, expectedRow(capture), `${label} TypeScript evidence`);
    requireMatchingEvidence(goRow, expectedRow(capture), `${label} Go evidence`);
    requireMatchingEvidence(goRow, typescriptRow, `${label} cross-implementation evidence`);

    if (goRow.serverCommit !== capturedServerCommit) {
      throw new TypeError(`${label} has a stale serverCommit.`);
    }
    if (goRow.expectedResult !== capture.expectedResult) {
      throw new TypeError(`${label} expectedResult does not match the captured manifest.`);
    }
    if (goRow.actualResult !== goRow.expectedResult) {
      throw new TypeError(`${label} actualResult does not match expectedResult.`);
    }
    if (goRow.actualResult !== typescriptRow.result) {
      throw new TypeError(`${label} Go and TypeScript results do not match.`);
    }

    const body = fixtureSources[capture.bodyPath];
    const key = fixtureSources[capture.signingResource.keyPath];
    if (body === undefined) {
      throw new TypeError(`${label} body fixture is missing.`);
    }
    if (key === undefined) {
      throw new TypeError(`${label} signing key fixture is missing.`);
    }
    validateSignedFixture(capture, body, key, {
      captured: true,
      headerRecordFormat: manifest.headerRecordFormat,
    });
  }

  return {
    manifestDigest,
    serverCommit,
    fixtures: captures.length,
  };
}

export function validateExternalAttestations({
  rendererHandoffSource,
  rendererHandoffSidecar,
  rendererReportSource,
  webhook,
}) {
  return {
    renderer: validateRendererReport({
      handoffSource: rendererHandoffSource,
      handoffSidecar: rendererHandoffSidecar,
      reportSource: rendererReportSource,
    }),
    webhooks: validateWebhookAttestations(webhook),
  };
}

async function main() {
  const [rendererReportPath, webhookReportPath, ...extraArguments] = process.argv.slice(2);
  if (
    rendererReportPath === undefined ||
    webhookReportPath === undefined ||
    extraArguments.length > 0
  ) {
    throw new TypeError(
      "Usage: node scripts/verify-external-attestations.mjs <renderer-report.json> <go-webhook-attestation.json>",
    );
  }

  const paths = {
    manifest: "contracts/webhooks/captured/manifest.json",
    schema: "contracts/webhooks/captured/manifest.schema.json",
    manifestSidecar: "contracts/webhooks/captured/manifest.sha256",
    typescriptResults: "contracts/webhooks/captured/typescript-results.json",
    typescriptResultsSidecar: "contracts/webhooks/captured/typescript-results.sha256",
    configuredBody: "contracts/webhooks/captured/bodies/configured-webhook-message-delivered.json",
    routeBody: "contracts/webhooks/captured/bodies/route-message-routing.json",
    configuredKey: "contracts/webhooks/captured/keys/configured-webhook.key",
    routeKey: "contracts/webhooks/captured/keys/route.key",
  };
  const [
    rendererHandoffSource,
    rendererHandoffSidecar,
    rendererReportSource,
    manifestSource,
    manifestSchemaSource,
    manifestSidecar,
    typescriptResultsSource,
    typescriptResultsSidecar,
    goResultsSource,
    configuredBody,
    routeBody,
    configuredKey,
    routeKey,
  ] = await Promise.all([
    readFile(resolve(repositoryRoot, "docs/renderer-handoff.json")),
    readFile(resolve(repositoryRoot, "docs/renderer-handoff.sha256")),
    readFile(resolve(rendererReportPath)),
    readFile(resolve(repositoryRoot, paths.manifest)),
    readFile(resolve(repositoryRoot, paths.schema)),
    readFile(resolve(repositoryRoot, paths.manifestSidecar)),
    readFile(resolve(repositoryRoot, paths.typescriptResults)),
    readFile(resolve(repositoryRoot, paths.typescriptResultsSidecar)),
    readFile(resolve(webhookReportPath)),
    readFile(resolve(repositoryRoot, paths.configuredBody)),
    readFile(resolve(repositoryRoot, paths.routeBody)),
    readFile(resolve(repositoryRoot, paths.configuredKey)),
    readFile(resolve(repositoryRoot, paths.routeKey)),
  ]);
  const { renderer, webhooks } = validateExternalAttestations({
    rendererHandoffSource,
    rendererHandoffSidecar,
    rendererReportSource,
    webhook: {
      manifestSource,
      manifestSchemaSource,
      manifestSidecar,
      typescriptResultsSource,
      typescriptResultsSidecar,
      goResultsSource,
      fixtureSources: {
        [paths.configuredBody]: configuredBody,
        [paths.routeBody]: routeBody,
        [paths.configuredKey]: configuredKey,
        [paths.routeKey]: routeKey,
      },
    },
  });
  process.stdout.write(
    `External attestations passed: renderer report covers ${renderer.operations} operations and ${renderer.tabs} tabs for handoff ${renderer.handoffDigest}; webhook report covers ${webhooks.fixtures} fixtures at server commit ${webhooks.serverCommit}.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-external-attestations: ${message}\n`);
    process.exitCode = 1;
  });
}
