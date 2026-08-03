import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson, sha256Hex } from "../../scripts/digest-artifact.mjs";
import { verifyRegistryProvenance } from "../../scripts/verify-provenance.mjs";

const commit = "1".repeat(40);
const name = "@ahasend/sdk";
const version = "1.2.3";
const predicateType = "https://slsa.dev/provenance/v1";

function digest(algorithm: "sha1" | "sha512", source: Buffer, encoding: "base64" | "hex") {
  return createHash(algorithm).update(source).digest(encoding);
}

function fixture() {
  const tarball = Buffer.from("retained candidate tarball", "utf8");
  const manifest = canonicalizeJson({
    version: 1,
    commit,
    sourceReportSha256: "2".repeat(64),
    contractSha256: {
      "contracts.lock.json": "3".repeat(64),
      "openapi.yaml": "4".repeat(64),
      "webhooks.yaml": "5".repeat(64),
    },
    captureSha256: "6".repeat(64),
    keysSha256: {
      "contracts/webhooks/captured/keys/configured-webhook.key": "7".repeat(64),
      "contracts/webhooks/captured/keys/route.key": "8".repeat(64),
    },
    profileSha256: "a".repeat(64),
    tarballSha256: sha256Hex(tarball),
  });
  const packageManifest = Buffer.from(JSON.stringify({ name, version }), "utf8");
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `pkg:npm/%40ahasend/sdk@${version}`,
        digest: { sha512: digest("sha512", tarball, "hex") },
      },
    ],
    predicateType,
    predicate: {
      buildDefinition: {
        resolvedDependencies: [
          {
            uri: `git+https://github.com/AhaSend/ahasend-ts@${commit}`,
            digest: { gitCommit: commit },
          },
        ],
      },
    },
  };
  const metadata = {
    name,
    version,
    dist: {
      integrity: `sha512-${digest("sha512", tarball, "base64")}`,
      shasum: digest("sha1", tarball, "hex"),
      tarball: `https://registry.npmjs.org/@ahasend/sdk/-/sdk-${version}.tgz`,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/${name}@${version}`,
        provenance: { predicateType },
      },
    },
  };
  const audit = {
    invalid: [],
    missing: [],
    verified: [
      {
        name,
        version,
        location: "node_modules/@ahasend/sdk",
        registry: "https://registry.npmjs.org/",
        attestations: metadata.dist.attestations,
        attestationBundles: [
          {
            predicateType,
            bundle: {
              mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
              verificationMaterial: {
                certificate: { rawBytes: "verified-by-npm" },
                tlogEntries: [],
              },
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
                payloadType: "application/vnd.in-toto+json",
                signatures: [{ keyid: "", sig: "verified-by-npm" }],
              },
            },
          },
        ],
      },
    ],
  };
  return {
    audit,
    manifest,
    manifestSidecar: `${sha256Hex(manifest)}\n`,
    metadata,
    packageManifest,
    statement,
    tarball,
  };
}

function verify(value: ReturnType<typeof fixture>, registryTarballSource: Buffer = value.tarball) {
  return verifyRegistryProvenance({
    candidateTarballSource: value.tarball,
    candidateManifestSource: value.manifest,
    candidateManifestSidecar: value.manifestSidecar,
    candidatePackageManifestSource: value.packageManifest,
    registryTarballSource,
    registryMetadataSource: JSON.stringify(value.metadata),
    auditReportSource: JSON.stringify(value.audit),
  });
}

function refreshStatementBundle(value: ReturnType<typeof fixture>) {
  value.audit.verified[0]!.attestationBundles[0]!.bundle.dsseEnvelope.payload = Buffer.from(
    JSON.stringify(value.statement),
    "utf8",
  ).toString("base64");
}

describe("registry provenance verification", () => {
  it("binds npm's wrapped Sigstore provenance to the exact registry candidate", () => {
    const value = fixture();

    expect(verify(value)).toEqual({
      commit,
      integrity: value.metadata.dist.integrity,
      manifestSha256: sha256Hex(value.manifest),
      name,
      tarballSha256: sha256Hex(value.tarball),
      version,
    });
  });

  it("rejects registry integrity mismatch", () => {
    const value = fixture();
    value.metadata.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;

    expect(() => verify(value)).toThrow("Registry integrity mismatch");
  });

  it("rejects retained candidate bytes that do not match their manifest SHA-256", () => {
    const value = fixture();
    value.tarball = Buffer.from("tampered retained candidate tarball", "utf8");

    expect(() => verify(value)).toThrow("Candidate tarball does not match the candidate manifest");
  });

  it("rejects registry content mismatch before provenance is trusted", () => {
    const value = fixture();

    expect(() => verify(value, Buffer.from("different registry tarball", "utf8"))).toThrow(
      "Registry tarball content does not match",
    );
  });

  it("rejects provenance verified for a different installed package location", () => {
    const value = fixture();
    value.audit.verified[0]!.location = "node_modules/example/node_modules/@ahasend/sdk";

    expect(() => verify(value)).toThrow("is not the installed candidate package");
  });

  it("rejects a provenance subject for a different package", () => {
    const value = fixture();
    value.statement.subject[0]!.name = `pkg:npm/example@${version}`;
    refreshStatementBundle(value);

    expect(() => verify(value)).toThrow("subject does not identify the candidate package");
  });

  it("rejects a provenance subject digest for different registry bytes", () => {
    const value = fixture();
    value.statement.subject[0]!.digest.sha512 = "f".repeat(128);
    refreshStatementBundle(value);

    expect(() => verify(value)).toThrow("subject digest does not match the registry tarball");
  });

  it("rejects a verified provenance statement for a different source commit", () => {
    const value = fixture();
    value.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
      "f".repeat(40);
    refreshStatementBundle(value);

    expect(() => verify(value)).toThrow(
      "Verified npm provenance commit does not match the candidate commit",
    );
  });

  it("rejects an npm bundle descriptor that does not match its signed statement", () => {
    const value = fixture();
    value.audit.verified[0]!.attestationBundles[0]!.predicateType =
      "https://slsa.dev/provenance/v0.2";

    expect(() => verify(value)).toThrow("predicateType does not match its statement");
  });
});
