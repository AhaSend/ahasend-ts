#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

// These semantic rules are consumed by the scenario builders, which reject any
// shape that does not match the authorization contract exercised by the suite.
const resourceAuthorization = Object.freeze({
  getRoutes: {
    kind: "query_domain_required_for_scoped",
    queryParameter: "domain",
    condition: "scoped_role_requires_filter",
    roles: { global: "routes:read:all", domain: "routes:read:{domain}" },
  },
  createRoute: {
    kind: "body_domain",
    bodyPath: "recipient",
    quantifier: "one",
    roles: { global: "routes:write:all", domain: "routes:write:{domain}" },
  },
  updateRoute: {
    kind: "existing_and_replacement_domain",
    resource: "route",
    resourceIdParameter: "route_id",
    existingPath: "recipient",
    replacementBodyPath: "recipient",
    quantifier: "every",
    roles: { global: "routes:write:all", domain: "routes:write:{domain}" },
  },
  createWebhook: {
    kind: "all_body_domains",
    bodyPath: "domains",
    scopeBodyPath: "scope",
    globalValue: "global",
    quantifier: "every",
    condition: "global_scope_requires_global_role",
    roles: { global: "webhooks:write:all", domain: "webhooks:write:{domain}" },
  },
  updateWebhook: {
    kind: "existing_and_new_domains",
    resource: "webhook",
    resourceIdParameter: "webhook_id",
    existingPath: "domains",
    newBodyPath: "domains",
    scopeBodyPath: "scope",
    globalValue: "global",
    quantifier: "every",
    transition: "global_scope_requires_global_role",
    roles: { global: "webhooks:write:all", domain: "webhooks:write:{domain}" },
  },
  createSMTPCredential: {
    kind: "all_body_domains",
    bodyPath: "domains",
    scopeBodyPath: "scope",
    globalValue: "global",
    quantifier: "every",
    condition: "global_scope_requires_global_role",
    roles: {
      global: "smtp-credentials:write:all",
      domain: "smtp-credentials:write:{domain}",
    },
  },
  ...Object.fromEntries(
    ["getDeliverabilityStatistics", "getBounceStatistics", "getDeliveryTimeStatistics"].map(
      (operationId) => [
        operationId,
        {
          kind: "comma_separated_query_domains",
          queryParameter: "sender_domain",
          quantifier: "every",
          roles: {
            global: "statistics-transactional:read:all",
            domain: "statistics-transactional:read:{domain}",
          },
        },
      ],
    ),
  ),
});

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

function collectRun(target, run) {
  if (run.failure !== null) {
    const operation = run.failure.operationId === undefined ? "" : ` ${run.failure.operationId}`;
    throw new TypeError(`Live ${target}${operation} failed during ${run.failure.phase}.`);
  }
  return run;
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
          authorization: resourceAuthorization,
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
          authorization: resourceAuthorization,
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
          authorization: resourceAuthorization,
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
          authorization: resourceAuthorization,
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
  if (combined.failure !== null || combined.subAccountAPIKeys === null) {
    const operation =
      combined.failure?.operationId === undefined ? "" : ` ${combined.failure.operationId}`;
    const phase = combined.failure?.phase ?? "setup";
    throw new TypeError(`Live sub-account${operation} failed during ${phase}.`);
  }

  return Object.freeze({
    operationResults: Object.freeze([
      ...runs.flatMap((run) => run.operationResults),
      ...combined.subAccounts.operationResults,
      ...combined.subAccountAPIKeys.operationResults,
    ]),
    iteratorResults: Object.freeze([
      ...runs.flatMap((run) => run.iteratorResults),
      ...combined.subAccounts.iteratorResults,
      ...combined.subAccountAPIKeys.iteratorResults,
    ]),
    cleanupResults: Object.freeze([
      ...runs.flatMap((run) => run.cleanupResults),
      ...combined.cleanupResults,
    ]),
  });
}

async function main() {
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
  const candidate = await installLiveCandidate({
    manifestPath,
    tarballPath,
    installDirectory,
    ...(manifestSidecarPath === undefined ? {} : { manifestSidecarPath }),
  });
  const installedModule = await import(
    pathToFileURL(resolve(candidate.installedRoot, "dist/index.js")).href
  );
  if (typeof installedModule.AhaSendClient !== "function") {
    throw new TypeError("Installed candidate does not export AhaSendClient.");
  }
  const results = await executeLiveAcceptance({
    candidate,
    AhaSendClient: installedModule.AhaSendClient,
    apiKey,
    accountId,
    config,
  });
  const secrets = [apiKey, accountId, ...Object.values(config)];
  const report = createLiveReport({ candidate, ...results, secrets });
  await writeLiveReport({
    report,
    candidate,
    reportPath,
    reportSidecarPath,
    secrets,
  });
  const [reportSource, reportSidecar] = await Promise.all([
    readFile(reportPath),
    readFile(reportSidecarPath),
  ]);
  const summary = validateLiveReportArtifacts({ reportSource, reportSidecar, candidate });
  process.stdout.write(
    `Live acceptance passed for ${summary.package.name}@${summary.package.version}: ${summary.operations} primary operations, ${summary.iterators} iterators, zero unexpected, cleanup, or secret-leak failures.\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`run-live-acceptance: ${message}\n`);
  process.exitCode = 1;
});
