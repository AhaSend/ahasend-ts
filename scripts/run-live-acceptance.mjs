#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalizeJson, sha256Hex } from "./digest-artifact.mjs";
import {
  createAccountScenarioRegistry,
  createAPIKeyScenarioRegistry,
  createDomainScenarioRegistry,
  createLiveReport,
  createMessageScenarioRegistry,
  createRouteScenarioRegistry,
  createSMTPCredentialScenarioRegistry,
  createStatisticsScenarioRegistry,
  createSubAccountAPIKeyScenarioRegistry,
  createSubAccountScenarioRegistry,
  createSuppressionScenarioRegistry,
  createWebhookScenarioRegistry,
  installLiveCandidate,
  redactLiveValue,
  runAccountLiveScenarios,
  runAPIKeyLiveScenarios,
  runDomainLiveScenarios,
  runMessageLiveScenarios,
  runRouteLiveScenarios,
  runSMTPCredentialLiveScenarios,
  runStatisticsLiveScenarios,
  runSubAccountAndAPIKeyLiveScenarios,
  runSuppressionLiveScenarios,
  runWebhookLiveScenarios,
  validateLiveReportArtifacts,
  writeLiveReport,
} from "./live-acceptance.mjs";
import { AUTHORIZATION_REGISTRY } from "./generate-sdk.mjs";
import { requireExactKeys, requireObject, requireString } from "./report-validation.mjs";

const configKeys = Object.freeze([
  "disposableMailbox",
  "dnslessDomain",
  "lifecycleDomain",
  "neverRegisteredDomain",
  "replacementVerifiedDomain",
  "suppressionDomain",
  "verifiedDomain",
  "webhookUrl",
]);
let failureRedactionSecrets = [];

function parseLiveConfig(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new TypeError("AHASEND_LIVE_CONFIG_JSON must be valid JSON.", { cause: error });
  }
  const config = requireObject(parsed, "Live acceptance configuration");
  requireExactKeys(config, configKeys, "Live acceptance configuration");
  const normalized = Object.fromEntries(
    configKeys.map((key) => [key, requireString(config[key], `Live acceptance ${key}`)]),
  );
  const domains = [
    normalized.verifiedDomain,
    normalized.replacementVerifiedDomain,
    normalized.neverRegisteredDomain,
    normalized.dnslessDomain,
    normalized.lifecycleDomain,
    normalized.suppressionDomain,
  ].map((domain) => domain.trim().toLowerCase());
  if (
    domains.some((domain) => domain === "" || domain.includes("@") || domain.includes(",")) ||
    new Set(domains).size !== domains.length
  ) {
    throw new TypeError("Live acceptance domains must be six distinct domain names.");
  }
  if (!normalized.disposableMailbox.includes("@")) {
    throw new TypeError("Live acceptance disposableMailbox must be an email address.");
  }
  const webhookUrl = new URL(normalized.webhookUrl);
  if (webhookUrl.protocol !== "https:") {
    throw new TypeError("Live acceptance webhookUrl must use HTTPS.");
  }
  return Object.freeze({
    ...normalized,
    verifiedDomain: domains[0],
    replacementVerifiedDomain: domains[1],
    neverRegisteredDomain: domains[2],
    dnslessDomain: domains[3],
    lifecycleDomain: domains[4],
    suppressionDomain: domains[5],
    webhookUrl: webhookUrl.href,
  });
}

function requireEnvironment(name) {
  return requireString(process.env[name], name);
}

function collectRun(_target, run) {
  return run;
}

function safeFailureEvidence(error) {
  let source = error;
  try {
    if (
      typeof error === "object" &&
      error !== null &&
      typeof error.serialized === "object" &&
      error.serialized !== null
    ) {
      source = error.serialized;
    }
  } catch {
    // Continue with a bounded representation for hostile thrown values.
  }
  let name = "ThrownValue";
  let message = "Live acceptance threw an unreadable value.";
  try {
    message = typeof source === "string" ? source : String(source);
    if (source instanceof Error) {
      name = typeof source.name === "string" ? source.name : "Error";
      message = typeof source.message === "string" ? source.message : "Live acceptance failed.";
    } else if (typeof source === "object" && source !== null) {
      name = typeof source.name === "string" ? source.name : name;
      message = typeof source.message === "string" ? source.message : message;
    }
  } catch {
    // Failure finalization must not trust arbitrary thrown values.
  }
  return Object.freeze({ name, message });
}

function originalFailure(error) {
  try {
    if (typeof error === "object" && error !== null && Object.hasOwn(error, "error")) {
      return error.error;
    }
  } catch {
    // Preserve the thrown wrapper when it cannot be inspected safely.
  }
  return error;
}

function failureOperationResults(candidate, results, failure) {
  const supplied = Array.isArray(results.operationResults) ? results.operationResults : [];
  if (failure === null) return supplied;
  const operationId = safeProperty(failure, "operationId");
  const phase = safeProperty(failure, "phase");
  const evidence = {
    phase: typeof phase === "string" ? phase : operationId === undefined ? "run" : "operation",
    ...safeFailureEvidence(failure),
  };
  if (typeof operationId === "string") {
    return supplied.map((result) =>
      result.operationId === operationId ? { ...result, failure: evidence } : result,
    );
  }
  if (supplied.length > 0) {
    return supplied.map((result, index) =>
      index === 0 ? { ...result, failure: evidence } : result,
    );
  }
  const firstOperation = candidate.profile.operations[0];
  return firstOperation === undefined
    ? supplied
    : [{ operationId: firstOperation.operationId, status: "pending", failure: evidence }];
}

const liveResultStatuses = new Set(["failed", "passed", "pending", "skipped"]);
const cleanupResultStatuses = new Set(["failed", "passed"]);

function safeProperty(value, key) {
  try {
    return typeof value === "object" && value !== null ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function safeFailureOutcome(value, fallbackPhase) {
  const phase = safeProperty(value, "phase");
  return {
    phase: typeof phase === "string" ? phase : fallbackPhase,
    ...safeFailureEvidence(value),
  };
}

function serializationSafeLiveResults(results, mappings) {
  const supplied = Array.isArray(results) ? results : [];
  const mappingsById = new Map(mappings.map((mapping) => [mapping.operationId, mapping]));
  const retained = new Map();
  for (const result of supplied) {
    const operationId = safeProperty(result, "operationId");
    const status = safeProperty(result, "status");
    if (
      typeof operationId !== "string" ||
      !mappingsById.has(operationId) ||
      typeof status !== "string" ||
      !liveResultStatuses.has(status) ||
      retained.has(operationId)
    ) {
      continue;
    }
    const failure = safeProperty(result, "failure");
    retained.set(operationId, {
      operationId,
      status,
      ...(failure === undefined ? {} : { failure: safeFailureOutcome(failure, "operation") }),
    });
  }
  return mappings.flatMap((mapping) => {
    const result = retained.get(mapping.operationId);
    return result === undefined ? [] : [result];
  });
}

function serializationSafeCleanupResults(results) {
  const supplied = Array.isArray(results) ? results : [];
  return supplied.flatMap((result) => {
    const label = safeProperty(result, "label");
    const status = safeProperty(result, "status");
    return typeof label === "string" &&
      typeof status === "string" &&
      cleanupResultStatuses.has(status)
      ? [{ label, status }]
      : [];
  });
}

function retainFinalizationFailure(candidate, results, failure) {
  let operationResults = serializationSafeLiveResults(
    results.operationResults,
    candidate.profile.operations,
  );
  let iteratorResults = serializationSafeLiveResults(
    results.iteratorResults,
    candidate.profile.iterators,
  );
  const reportFailure = safeFailureOutcome(failure, "report-finalization");
  const failedOperation = operationResults.findIndex(({ status }) => status === "failed");
  const failedIterator = iteratorResults.findIndex(({ status }) => status === "failed");
  const operationIndex =
    failedOperation >= 0 ? failedOperation : operationResults.length > 0 ? 0 : -1;
  const iteratorIndex = failedIterator >= 0 ? failedIterator : iteratorResults.length > 0 ? 0 : -1;

  if (operationIndex >= 0) {
    operationResults = operationResults.map((result, index) =>
      index === operationIndex ? { ...result, reportFailure } : result,
    );
  } else if (iteratorIndex >= 0) {
    iteratorResults = iteratorResults.map((result, index) =>
      index === iteratorIndex ? { ...result, reportFailure } : result,
    );
  } else {
    const firstOperation = candidate.profile.operations[0];
    if (firstOperation === undefined) throw failure;
    operationResults = [
      { operationId: firstOperation.operationId, status: "pending", reportFailure },
    ];
  }

  return {
    operationResults,
    iteratorResults,
    cleanupResults: serializationSafeCleanupResults(results.cleanupResults),
  };
}

export async function persistLiveAcceptanceEvidence({
  candidate,
  results = {},
  failure = results.failure ?? null,
  reportPath,
  reportSidecarPath,
  secrets = [],
}) {
  let fatalFailure = failure;
  let report;
  let operationResults;
  let summary;
  try {
    operationResults = failureOperationResults(candidate, results, fatalFailure);
    report = createLiveReport({
      candidate,
      ...results,
      operationResults,
      secrets,
    });
    if (fatalFailure === null) {
      const reportSource = canonicalizeJson(redactLiveValue(report, secrets));
      summary = validateLiveReportArtifacts({
        reportSource,
        reportSidecar: Buffer.from(`${sha256Hex(reportSource)}\n`, "utf8"),
        candidate,
      });
    }
    await writeLiveReport({
      report,
      candidate,
      reportPath,
      reportSidecarPath,
      secrets,
    });
  } catch (error) {
    fatalFailure ??= error;
    report = createLiveReport({
      candidate,
      ...retainFinalizationFailure(
        candidate,
        {
          operationResults: operationResults ?? safeProperty(results, "operationResults"),
          iteratorResults: safeProperty(results, "iteratorResults"),
          cleanupResults: safeProperty(results, "cleanupResults"),
        },
        error,
      ),
      secrets,
    });
    await writeLiveReport({
      report,
      candidate,
      reportPath,
      reportSidecarPath,
      secrets,
    });
  }

  if (fatalFailure !== null) throw originalFailure(fatalFailure);
  return summary;
}

async function executeLiveAcceptance({ candidate, AhaSendClient, apiKey, accountId, config }) {
  const profile = candidate.profile;
  const clientFromCredential = (credential, credentialAccountId = accountId) =>
    AhaSendClient.fromEnv({
      ...process.env,
      AHASEND_API_KEY: credential,
      AHASEND_ACCOUNT_ID: credentialAccountId,
    });
  const client = clientFromCredential(apiKey);
  const suffix = randomUUID();
  const pagination = Object.freeze({ limit: 1 });
  const controlledDomains = Object.freeze([
    config.verifiedDomain,
    config.replacementVerifiedDomain,
  ]);
  const verifiedSender = `sdk-live@${config.verifiedDomain}`;
  const scheduledAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const runs = [];
  runs.push(
    collectRun(
      "domain scenarios",
      await runDomainLiveScenarios(
        createDomainScenarioRegistry({
          profile,
          client,
          createRequest: { domain: config.lifecycleDomain },
          updateRequest: { tracking_subdomain: "sdk-live" },
          pagination,
        }),
      ),
    ),
  );
  runs.push(
    collectRun(
      "message scenarios",
      await runMessageLiveScenarios(
        createMessageScenarioRegistry({
          profile,
          client,
          verifiedRequest: {
            from: { email: verifiedSender },
            recipients: [{ email: config.disposableMailbox }],
            subject: `AhaSend SDK live acceptance ${suffix}`,
            text_content: "AhaSend SDK live acceptance sandbox message.",
            sandbox: true,
            schedule: { first_attempt: scheduledAt, expires: expiresAt },
          },
          conversationRequest: {
            from: { email: verifiedSender },
            to: [{ email: config.disposableMailbox }],
            subject: `AhaSend SDK live conversation ${suffix}`,
            text_content: "AhaSend SDK live acceptance sandbox conversation.",
            sandbox: true,
          },
          neverRegisteredDomain: config.neverRegisteredDomain,
          dnslessCreateRequest: { domain: config.dnslessDomain },
          pagination,
        }),
      ),
    ),
  );
  runs.push(
    collectRun(
      "statistics scenarios",
      await runStatisticsLiveScenarios(
        createStatisticsScenarioRegistry({
          profile,
          client,
          authorization: AUTHORIZATION_REGISTRY,
          senderDomains: {
            authorized: config.verifiedDomain,
            unauthorized: config.neverRegisteredDomain,
          },
        }),
      ),
    ),
  );
  runs.push(
    collectRun(
      "API-key scenarios",
      await runAPIKeyLiveScenarios(
        createAPIKeyScenarioRegistry({
          profile,
          client,
          createSecondaryClient: (secret) => clientFromCredential(secret),
          createRequest: {
            label: `SDK live primary ${suffix}`,
            scopes: ["api-keys:read"],
          },
          secondaryCreateRequest: {
            label: `SDK live secondary ${suffix}`,
            scopes: ["api-keys:read", "api-keys:write"],
          },
          pagination,
        }),
      ),
    ),
  );
  runs.push(
    collectRun(
      "route scenarios",
      await runRouteLiveScenarios(
        createRouteScenarioRegistry({
          profile,
          client,
          authorization: AUTHORIZATION_REGISTRY,
          controlledDomains: {
            existing: config.verifiedDomain,
            replacement: config.replacementVerifiedDomain,
          },
          createRequest: {
            name: `SDK live route ${suffix}`,
            url: config.webhookUrl,
            recipient: `sdk-live@${config.verifiedDomain}`,
            enabled: false,
          },
          updateRequest: {
            recipient: `sdk-live@${config.replacementVerifiedDomain}`,
            enabled: false,
          },
          pagination,
        }),
      ),
    ),
  );
  runs.push(
    collectRun(
      "webhook scenarios",
      await runWebhookLiveScenarios(
        createWebhookScenarioRegistry({
          profile,
          client,
          authorization: AUTHORIZATION_REGISTRY,
          controlledDomains: {
            existing: [config.verifiedDomain],
            newlySupplied: [config.replacementVerifiedDomain],
          },
          createRequest: {
            name: `SDK live webhook ${suffix}`,
            url: config.webhookUrl,
            scope: "scoped",
            domains: [config.verifiedDomain],
            enabled: false,
          },
          updateRequest: {
            scope: "scoped",
            domains: [config.replacementVerifiedDomain],
            enabled: false,
          },
          pagination,
        }),
      ),
    ),
  );
  runs.push(
    collectRun(
      "SMTP-credential scenarios",
      await runSMTPCredentialLiveScenarios(
        createSMTPCredentialScenarioRegistry({
          profile,
          client,
          authorization: AUTHORIZATION_REGISTRY,
          controlledDomains,
          scopedCreateRequest: {
            name: `SDK live scoped SMTP ${suffix}`,
            sandbox: true,
            scope: "scoped",
            domains: controlledDomains,
          },
          globalCreateRequest: {
            name: `SDK live global SMTP ${suffix}`,
            sandbox: true,
            scope: "global",
            domains: controlledDomains,
          },
          pagination,
        }),
      ),
    ),
  );
  runs.push(
    collectRun(
      "account scenarios",
      await runAccountLiveScenarios(
        createAccountScenarioRegistry({
          profile,
          client,
          disposableAccountId: accountId,
          disposableMailbox: config.disposableMailbox,
          updateRequest: { about: `AhaSend SDK live acceptance ${suffix}` },
          memberRequest: {
            email: config.disposableMailbox,
            name: "AhaSend SDK live acceptance",
            role: "Developer",
          },
        }),
      ),
    ),
  );
  runs.push(
    collectRun(
      "suppression scenarios",
      await runSuppressionLiveScenarios(
        createSuppressionScenarioRegistry({
          profile,
          client,
          disposableDomain: config.suppressionDomain,
          createRequest: {
            email: `sdk-live-delete-${suffix}@${config.suppressionDomain}`,
            domain: config.suppressionDomain,
            reason: "AhaSend SDK live delete fixture",
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
          wipeCreateRequest: {
            email: `sdk-live-wipe-${suffix}@${config.suppressionDomain}`,
            domain: config.suppressionDomain,
            reason: "AhaSend SDK live wipe fixture",
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
          pagination,
        }),
      ),
    ),
  );

  const combined = await runSubAccountAndAPIKeyLiveScenarios(
    createSubAccountScenarioRegistry({
      profile,
      client,
      createRequest: {
        name: `SDK live child ${suffix}`,
        website: `https://${config.lifecycleDomain}`,
        monthly_credit: 50_000,
      },
      updateRequest: {
        name: `Updated SDK live child ${suffix}`,
        monthly_credit: 75_000,
      },
      suspendRequest: { reason: "AhaSend SDK live lifecycle verification" },
      pagination,
    }),
    (subAccountId) =>
      createSubAccountAPIKeyScenarioRegistry({
        profile,
        client,
        subAccountId,
        createChildClient: (secret, childAccountId) => clientFromCredential(secret, childAccountId),
        createRequest: {
          label: `SDK live child sender ${suffix}`,
          scopes: ["messages:send:all"],
        },
        updateRequest: { label: `Updated SDK live child sender ${suffix}` },
        pagination,
      }),
  );
  const childOperationResults =
    combined.subAccountAPIKeys === null ? [] : combined.subAccountAPIKeys.operationResults;
  const childIteratorResults =
    combined.subAccountAPIKeys === null ? [] : combined.subAccountAPIKeys.iteratorResults;
  return Object.freeze({
    operationResults: Object.freeze([
      ...runs.flatMap((run) => run.operationResults),
      ...combined.subAccounts.operationResults,
      ...childOperationResults,
    ]),
    iteratorResults: Object.freeze([
      ...runs.flatMap((run) => run.iteratorResults),
      ...combined.subAccounts.iteratorResults,
      ...childIteratorResults,
    ]),
    cleanupResults: Object.freeze([
      ...runs.flatMap((run) => run.cleanupResults),
      ...combined.cleanupResults,
    ]),
    failure: runs.find((run) => run.failure !== null)?.failure ?? combined.failure,
  });
}

export async function main() {
  const [
    manifestPath,
    tarballPath,
    installDirectory,
    reportPath,
    reportSidecarPath,
    manifestSidecarPath,
    ...extra
  ] = process.argv.slice(2);
  if (
    manifestPath === undefined ||
    tarballPath === undefined ||
    installDirectory === undefined ||
    reportPath === undefined ||
    reportSidecarPath === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(
      "Usage: node scripts/run-live-acceptance.mjs <candidate-manifest.json> <candidate.tgz> <install-directory> <live-report.json> <live-report.sha256> [candidate-manifest.sha256]",
    );
  }
  const apiKey = requireEnvironment("AHASEND_API_KEY");
  const accountId = requireEnvironment("AHASEND_ACCOUNT_ID");
  const config = parseLiveConfig(requireEnvironment("AHASEND_LIVE_CONFIG_JSON"));
  const secrets = [apiKey, accountId, ...Object.values(config)];
  failureRedactionSecrets = secrets;
  const candidate = await installLiveCandidate({
    manifestPath,
    tarballPath,
    installDirectory,
    ...(manifestSidecarPath === undefined ? {} : { manifestSidecarPath }),
  });
  let results = {};
  let failure = null;
  try {
    const installedModule = await import(
      pathToFileURL(resolve(candidate.installedRoot, "dist/index.js")).href
    );
    if (typeof installedModule.AhaSendClient !== "function") {
      throw new TypeError("Installed candidate does not export AhaSendClient.");
    }
    results = await executeLiveAcceptance({
      candidate,
      AhaSendClient: installedModule.AhaSendClient,
      apiKey,
      accountId,
      config,
    });
  } catch (error) {
    failure = error;
  }

  const summary = await persistLiveAcceptanceEvidence({
    candidate,
    results,
    failure: failure ?? results.failure ?? null,
    reportPath,
    reportSidecarPath,
    secrets,
  });
  process.stdout.write(
    `Live acceptance passed for ${summary.package.name}@${summary.package.version}: ${summary.operations} primary operations, ${summary.iterators} iterators, zero unexpected, cleanup, or secret-leak failures.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = safeFailureEvidence(error).message;
    const redacted = redactLiveValue(message, failureRedactionSecrets);
    process.stderr.write(`run-live-acceptance: ${String(redacted)}\n`);
    process.exitCode = 1;
  });
}
