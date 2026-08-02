#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "./digest-artifact.mjs";
import {
  decodeUtf8,
  parseCanonicalJson,
  parseSha256Sidecar,
  requireExactKeys,
  requireHash,
  requireObject,
  requireString,
  sourceBytes,
} from "./report-validation.mjs";

const packageName = "@ahasend/sdk";
const gitCommitPattern = /^[0-9a-f]{40}$/u;
const slsaPredicateTypes = new Set([
  "https://slsa.dev/provenance/v0.2",
  "https://slsa.dev/provenance/v1",
]);

function parseJson(source, label) {
  try {
    return requireObject(JSON.parse(decodeUtf8(source, label)), label);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(`${label} must`)) throw error;
    throw new TypeError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !gitCommitPattern.test(value)) {
    throw new TypeError(`${label} must be a full lowercase Git commit.`);
  }
  return value;
}

function parseCandidateEnvelope(manifestSource, manifestSidecar, tarballSource) {
  const payload = parseCanonicalJson(manifestSource, "Candidate manifest");
  const detachedDigest = parseSha256Sidecar(manifestSidecar, "Candidate manifest sidecar");
  const manifestDigest = sha256Hex(payload.bytes);
  if (detachedDigest !== manifestDigest) {
    throw new TypeError("Candidate manifest does not match its detached sidecar.");
  }

  const manifest = payload.value;
  requireExactKeys(
    manifest,
    [
      "captureSha256",
      "commit",
      "contractSha256",
      "keysSha256",
      "profileSha256",
      "sourceReportSha256",
      "tarballSha256",
      "version",
    ],
    "Candidate manifest",
  );
  if (manifest.version !== 1) throw new TypeError("Candidate manifest version must be 1.");
  const commit = requireCommit(manifest.commit, "Candidate manifest commit");
  const expectedTarballSha256 = requireHash(
    manifest.tarballSha256,
    "Candidate manifest tarballSha256",
  );
  const candidate = sourceBytes(tarballSource, "Candidate tarball");
  const candidateSha256 = sha256Hex(candidate);
  if (candidateSha256 !== expectedTarballSha256) {
    throw new TypeError("Candidate tarball does not match the candidate manifest.");
  }
  return { candidate, candidateSha256, commit, manifestDigest };
}

function parsePackageIdentity(source) {
  const manifest = parseJson(source, "Candidate package manifest");
  if (manifest.name !== packageName) {
    throw new TypeError(`Candidate package name must be ${packageName}.`);
  }
  return {
    name: packageName,
    version: requireString(manifest.version, "Candidate package version"),
  };
}

function sha512Integrity(source) {
  return `sha512-${createHash("sha512").update(source).digest("base64")}`;
}

function sha512Hex(source) {
  return createHash("sha512").update(source).digest("hex");
}

function sha1Hex(source) {
  return createHash("sha1").update(source).digest("hex");
}

function parseRegistryMetadata(source, identity, registryTarball) {
  const metadata = parseJson(source, "Registry metadata");
  if (metadata.name !== identity.name || metadata.version !== identity.version) {
    throw new TypeError("Registry metadata does not identify the candidate package version.");
  }
  const dist = requireObject(metadata.dist, "Registry metadata dist");
  const integrity = requireString(dist.integrity, "Registry metadata dist.integrity");
  const expectedIntegrity = sha512Integrity(registryTarball);
  if (integrity !== expectedIntegrity) {
    throw new TypeError(
      `Registry integrity mismatch: expected ${expectedIntegrity}, received ${integrity}.`,
    );
  }
  if (requireString(dist.shasum, "Registry metadata dist.shasum") !== sha1Hex(registryTarball)) {
    throw new TypeError("Registry SHA-1 checksum does not match the downloaded tarball.");
  }

  const attestations = requireObject(dist.attestations, "Registry metadata dist.attestations");
  const provenance = requireObject(
    attestations.provenance,
    "Registry metadata provenance attestation",
  );
  const predicateType = requireString(
    provenance.predicateType,
    "Registry metadata provenance predicateType",
  );
  if (!slsaPredicateTypes.has(predicateType)) {
    throw new TypeError(`Registry provenance uses unsupported predicate type ${predicateType}.`);
  }
  requireString(attestations.url, "Registry metadata attestations URL");
  return { integrity, predicateType };
}

function parseAuditReport(source, identity, predicateType) {
  const report = parseJson(source, "npm audit signatures report");
  if (!Array.isArray(report.invalid) || report.invalid.length !== 0) {
    throw new TypeError("npm audit signatures report contains invalid signatures or attestations.");
  }
  if (!Array.isArray(report.missing) || report.missing.length !== 0) {
    throw new TypeError("npm audit signatures report contains missing registry signatures.");
  }
  if (!Array.isArray(report.verified)) {
    throw new TypeError("npm audit signatures report must include verified attestations.");
  }
  const matches = report.verified.filter(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value.name === identity.name &&
      value.version === identity.version,
  );
  if (matches.length !== 1) {
    throw new TypeError(
      `npm audit signatures report must contain one verified ${identity.name}@${identity.version} entry.`,
    );
  }
  const verified = requireObject(matches[0], "Verified npm audit entry");
  const attestations = requireObject(verified.attestations, "Verified npm attestations");
  const provenance = requireObject(attestations.provenance, "Verified npm provenance");
  if (provenance.predicateType !== predicateType) {
    throw new TypeError("Verified npm provenance predicate does not match registry metadata.");
  }
  const bundleValue = verified.attestationBundles;
  const bundles = Array.isArray(bundleValue)
    ? bundleValue
    : Object.values(requireObject(bundleValue, "Verified npm attestation bundles"));
  if (bundles.length === 0) {
    throw new TypeError("Verified npm provenance must include its attestation bundles.");
  }
  return bundles;
}

function decodeStatement(bundle, index) {
  const descriptor = requireObject(bundle, `Verified attestation bundle ${index}`);
  const descriptorPredicateType = requireString(
    descriptor.predicateType,
    `Verified attestation bundle ${index} predicateType`,
  );
  const sigstoreBundle = requireObject(
    descriptor.bundle,
    `Verified attestation bundle ${index} Sigstore bundle`,
  );
  const envelope = requireObject(
    sigstoreBundle.dsseEnvelope,
    `Verified attestation bundle ${index} DSSE envelope`,
  );
  const payload = requireString(
    envelope.payload,
    `Verified attestation bundle ${index} DSSE payload`,
  );
  let source;
  try {
    source = Buffer.from(payload, "base64");
    if (source.length === 0 || source.toString("base64") !== payload) {
      throw new TypeError("non-canonical base64");
    }
  } catch (error) {
    throw new TypeError(
      `Verified attestation bundle ${index} DSSE payload must be canonical base64.`,
      { cause: error },
    );
  }
  const statement = parseJson(source, `Verified attestation statement ${index}`);
  if (statement.predicateType !== descriptorPredicateType) {
    throw new TypeError(
      `Verified attestation bundle ${index} predicateType does not match its statement.`,
    );
  }
  return statement;
}

function statementCommits(statement) {
  const predicate = requireObject(statement.predicate, "SLSA provenance predicate");
  if (statement.predicateType === "https://slsa.dev/provenance/v1") {
    const buildDefinition = requireObject(predicate.buildDefinition, "SLSA v1 build definition");
    if (!Array.isArray(buildDefinition.resolvedDependencies)) {
      throw new TypeError("SLSA v1 provenance must include resolved dependencies.");
    }
    return buildDefinition.resolvedDependencies.flatMap((value, index) => {
      const dependency = requireObject(value, `SLSA resolved dependency ${index}`);
      const digest = requireObject(dependency.digest, `SLSA resolved dependency ${index} digest`);
      return typeof digest.gitCommit === "string" ? [digest.gitCommit] : [];
    });
  }

  const invocation = requireObject(predicate.invocation, "SLSA v0.2 invocation");
  const configSource = requireObject(invocation.configSource, "SLSA v0.2 config source");
  const digest = requireObject(configSource.digest, "SLSA v0.2 config source digest");
  return typeof digest.sha1 === "string" ? [digest.sha1] : [];
}

function validateProvenanceStatement({ bundles, candidateCommit, predicateType, registryTarball }) {
  const statements = bundles
    .map((bundle, index) => decodeStatement(bundle, index))
    .filter((statement) => statement.predicateType === predicateType);
  if (statements.length !== 1) {
    throw new TypeError("Verified npm attestations must contain one SLSA provenance statement.");
  }
  const statement = statements[0];
  if (statement._type !== "https://in-toto.io/Statement/v1") {
    throw new TypeError("Verified npm provenance must be an in-toto v1 statement.");
  }
  if (!Array.isArray(statement.subject)) {
    throw new TypeError("Verified npm provenance subjects must be an array.");
  }
  const expectedSha512 = sha512Hex(registryTarball);
  const subjects = statement.subject.filter((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const digest = value.digest;
    return (
      typeof value.name === "string" &&
      typeof digest === "object" &&
      digest !== null &&
      !Array.isArray(digest) &&
      digest.sha512 === expectedSha512
    );
  });
  if (subjects.length !== 1) {
    throw new TypeError("Verified npm provenance subject does not match the registry tarball.");
  }
  const commits = statementCommits(statement);
  if (commits.length !== 1 || commits[0] !== candidateCommit) {
    throw new TypeError("Verified npm provenance commit does not match the candidate commit.");
  }
}

export function verifyRegistryProvenance({
  candidateTarballSource,
  candidateManifestSource,
  candidateManifestSidecar,
  candidatePackageManifestSource,
  registryTarballSource,
  registryMetadataSource,
  auditReportSource,
}) {
  const candidateEnvelope = parseCandidateEnvelope(
    candidateManifestSource,
    candidateManifestSidecar,
    candidateTarballSource,
  );
  const identity = parsePackageIdentity(candidatePackageManifestSource);
  const registryTarball = sourceBytes(registryTarballSource, "Registry tarball");
  if (
    registryTarball.length !== candidateEnvelope.candidate.length ||
    !timingSafeEqual(registryTarball, candidateEnvelope.candidate)
  ) {
    throw new TypeError("Registry tarball content does not match the retained candidate.");
  }
  const metadata = parseRegistryMetadata(registryMetadataSource, identity, registryTarball);
  const bundles = parseAuditReport(auditReportSource, identity, metadata.predicateType);
  validateProvenanceStatement({
    bundles,
    candidateCommit: candidateEnvelope.commit,
    predicateType: metadata.predicateType,
    registryTarball,
  });
  return Object.freeze({
    commit: candidateEnvelope.commit,
    integrity: metadata.integrity,
    manifestSha256: candidateEnvelope.manifestDigest,
    name: identity.name,
    tarballSha256: candidateEnvelope.candidateSha256,
    version: identity.version,
  });
}

function extractPackageManifest(tarballPath) {
  return execFileSync("tar", ["-xzOf", resolve(tarballPath), "package/package.json"]);
}

async function main() {
  const [
    candidateTarballPath,
    candidateManifestPath,
    candidateManifestSidecarPath,
    registryTarballPath,
    registryMetadataPath,
    auditReportPath,
    ...extra
  ] = process.argv.slice(2);
  if (
    candidateTarballPath === undefined ||
    candidateManifestPath === undefined ||
    candidateManifestSidecarPath === undefined ||
    registryTarballPath === undefined ||
    registryMetadataPath === undefined ||
    auditReportPath === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(
      "Usage: node scripts/verify-provenance.mjs <candidate.tgz> <candidate-manifest.json> <candidate-manifest.sha256> <registry.tgz> <registry-metadata.json> <npm-audit-signatures.json>",
    );
  }
  const [
    candidateTarballSource,
    candidateManifestSource,
    candidateManifestSidecar,
    registryTarballSource,
    registryMetadataSource,
    auditReportSource,
  ] = await Promise.all([
    readFile(resolve(candidateTarballPath)),
    readFile(resolve(candidateManifestPath)),
    readFile(resolve(candidateManifestSidecarPath)),
    readFile(resolve(registryTarballPath)),
    readFile(resolve(registryMetadataPath)),
    readFile(resolve(auditReportPath)),
  ]);
  const summary = verifyRegistryProvenance({
    candidateTarballSource,
    candidateManifestSource,
    candidateManifestSidecar,
    candidatePackageManifestSource: extractPackageManifest(candidateTarballPath),
    registryTarballSource,
    registryMetadataSource,
    auditReportSource,
  });
  process.stdout.write(
    `Verified ${summary.name}@${summary.version} from ${summary.commit}: ${summary.tarballSha256} (${summary.integrity}).\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-provenance: ${message}\n`);
    process.exitCode = 1;
  });
}
