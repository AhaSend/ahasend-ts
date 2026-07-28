#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "./digest-artifact.mjs";
import {
  parseCanonicalJson,
  parseSha256Sidecar,
  requireExactKeys,
  requireHash,
  requireObject,
  requireString,
} from "./report-validation.mjs";

const EXPECTED_OPERATION_COUNT = 56;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseSample(value, label) {
  const sample = requireObject(value, label);
  requireExactKeys(sample, ["label", "language", "sourceHash"], label);
  return {
    label: requireString(sample.label, `${label}.label`),
    language: requireString(sample.language, `${label}.language`),
    sourceHash: requireHash(sample.sourceHash, `${label}.sourceHash`),
  };
}

function parseHandoff(value) {
  requireExactKeys(value, ["operations", "restDigest", "version"], "Renderer handoff");
  if (value.version !== 1) throw new TypeError("Renderer handoff version must be 1.");
  const restDigest = requireHash(value.restDigest, "Renderer handoff restDigest");
  if (!Array.isArray(value.operations)) {
    throw new TypeError("Renderer handoff operations must be an array.");
  }
  if (value.operations.length !== EXPECTED_OPERATION_COUNT) {
    throw new TypeError(
      `Renderer handoff must contain ${EXPECTED_OPERATION_COUNT} operations, received ${value.operations.length}.`,
    );
  }

  const operationIds = new Set();
  const operations = value.operations.map((value, operationIndex) => {
    const label = `Renderer handoff operation ${operationIndex}`;
    const operation = requireObject(value, label);
    requireExactKeys(operation, ["operationId", "samples"], label);
    const operationId = requireString(operation.operationId, `${label}.operationId`);
    if (operationIds.has(operationId)) {
      throw new TypeError(`Renderer handoff contains duplicate operation ${operationId}.`);
    }
    operationIds.add(operationId);
    if (!Array.isArray(operation.samples) || operation.samples.length === 0) {
      throw new TypeError(`Renderer handoff operation ${operationId} must contain samples.`);
    }
    const samples = operation.samples.map((sample, sampleIndex) =>
      parseSample(sample, `${label} sample ${sampleIndex}`),
    );
    const sampleKeys = new Set();
    for (const sample of samples) {
      const key = JSON.stringify([sample.label, sample.language]);
      if (sampleKeys.has(key)) {
        throw new TypeError(
          `Renderer handoff operation ${operationId} contains a duplicate sample tab.`,
        );
      }
      sampleKeys.add(key);
    }
    return { operationId, samples };
  });

  return { restDigest, operations };
}

function parseReport(value) {
  requireExactKeys(
    value,
    ["handoffDigest", "operations", "restDigest", "version"],
    "Renderer report",
  );
  if (value.version !== 1) throw new TypeError("Renderer report version must be 1.");
  const handoffDigest = requireHash(value.handoffDigest, "Renderer report handoffDigest");
  const restDigest = requireHash(value.restDigest, "Renderer report restDigest");
  if (!Array.isArray(value.operations)) {
    throw new TypeError("Renderer report operations must be an array.");
  }

  const operationIds = new Set();
  const operations = value.operations.map((value, operationIndex) => {
    const label = `Renderer report operation ${operationIndex}`;
    const operation = requireObject(value, label);
    requireExactKeys(operation, ["operationId", "tabs"], label);
    const operationId = requireString(operation.operationId, `${label}.operationId`);
    if (operationIds.has(operationId)) {
      throw new TypeError(`Renderer report contains duplicate operation ${operationId}.`);
    }
    operationIds.add(operationId);
    if (!Array.isArray(operation.tabs)) {
      throw new TypeError(`Renderer report operation ${operationId} tabs must be an array.`);
    }
    const tabs = operation.tabs.map((tab, tabIndex) =>
      parseSample(tab, `${label} tab ${tabIndex}`),
    );
    const tabKeys = new Set();
    for (const tab of tabs) {
      const key = JSON.stringify([tab.label, tab.language]);
      if (tabKeys.has(key)) {
        throw new TypeError(`Renderer report operation ${operationId} contains a duplicate tab.`);
      }
      tabKeys.add(key);
    }
    return { operationId, tabs };
  });

  return { handoffDigest, restDigest, operations };
}

export function validateRendererReport({ handoffSource, handoffSidecar, reportSource }) {
  const handoffPayload = parseCanonicalJson(handoffSource, "Renderer handoff");
  const reportPayload = parseCanonicalJson(reportSource, "Renderer report");
  const sidecarDigest = parseSha256Sidecar(handoffSidecar, "Renderer handoff sidecar");
  const actualHandoffDigest = sha256Hex(handoffPayload.bytes);
  if (sidecarDigest !== actualHandoffDigest) {
    throw new TypeError(
      `Renderer handoff sidecar mismatch: expected ${actualHandoffDigest}, received ${sidecarDigest}.`,
    );
  }

  const handoff = parseHandoff(handoffPayload.value);
  const report = parseReport(reportPayload.value);
  if (report.handoffDigest !== actualHandoffDigest) {
    throw new TypeError("Renderer report references a stale handoff digest.");
  }
  if (report.restDigest !== handoff.restDigest) {
    throw new TypeError("Renderer report references a stale REST digest.");
  }
  if (report.operations.length !== handoff.operations.length) {
    throw new TypeError(
      `Renderer report must contain ${handoff.operations.length} operations, received ${report.operations.length}.`,
    );
  }

  let tabCount = 0;
  for (let index = 0; index < handoff.operations.length; index += 1) {
    const expected = handoff.operations[index];
    const actual = report.operations[index];
    if (actual.operationId !== expected.operationId) {
      const actualIds = new Set(report.operations.map(({ operationId }) => operationId));
      const missing = handoff.operations
        .map(({ operationId }) => operationId)
        .filter((operationId) => !actualIds.has(operationId));
      if (missing.length > 0) {
        throw new TypeError(
          `Renderer report is missing operations: ${missing.map(JSON.stringify).join(", ")}.`,
        );
      }
      throw new TypeError(
        `Renderer report operations are not in canonical handoff order at index ${index}.`,
      );
    }
    if (actual.tabs.length !== expected.samples.length) {
      throw new TypeError(
        `Renderer report operation ${expected.operationId} is missing required sample tabs.`,
      );
    }

    for (let tabIndex = 0; tabIndex < expected.samples.length; tabIndex += 1) {
      const expectedTab = expected.samples[tabIndex];
      const actualTab = actual.tabs[tabIndex];
      if (actualTab.label !== expectedTab.label || actualTab.language !== expectedTab.language) {
        throw new TypeError(
          `Renderer report operation ${expected.operationId} is missing the canonical ${expectedTab.label} (${expectedTab.language}) tab.`,
        );
      }
      if (actualTab.sourceHash !== expectedTab.sourceHash) {
        throw new TypeError(
          `Renderer report operation ${expected.operationId} has a source-hash mismatch for ${expectedTab.label}.`,
        );
      }
      tabCount += 1;
    }
  }

  return {
    handoffDigest: actualHandoffDigest,
    operations: handoff.operations.length,
    tabs: tabCount,
  };
}

async function main() {
  const [reportPath, ...extraArguments] = process.argv.slice(2);
  if (reportPath === undefined || extraArguments.length > 0) {
    throw new TypeError("Usage: node scripts/verify-renderer-report.mjs <renderer-report.json>");
  }
  const [handoffSource, handoffSidecar, reportSource] = await Promise.all([
    readFile(resolve(repositoryRoot, "docs/renderer-handoff.json")),
    readFile(resolve(repositoryRoot, "docs/renderer-handoff.sha256")),
    readFile(resolve(reportPath)),
  ]);
  const summary = validateRendererReport({ handoffSource, handoffSidecar, reportSource });
  process.stdout.write(
    `Renderer report passed: ${summary.operations} operations and ${summary.tabs} tabs for handoff ${summary.handoffDigest}.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-renderer-report: ${message}\n`);
    process.exitCode = 1;
  });
}
