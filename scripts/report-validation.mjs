import { canonicalizeJson } from "./digest-artifact.mjs";

const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

export function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new TypeError(
      `${label} fields must be canonical: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(unexpected)}.`,
    );
  }
}

export function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty canonical string.`);
  }
  return value;
}

export function requireHash(value, label) {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase hexadecimal SHA-256 value.`);
  }
  return value;
}

export function sourceBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`${label} must be bytes or a UTF-8 string.`);
}

export function decodeUtf8(source, label) {
  try {
    return utf8Decoder.decode(sourceBytes(source, label));
  } catch (error) {
    throw new TypeError(`${label} must be UTF-8.`, { cause: error });
  }
}

export function parseCanonicalJson(source, label) {
  const bytes = sourceBytes(source, label);
  let value;
  try {
    value = JSON.parse(decodeUtf8(bytes, label));
  } catch (error) {
    throw new TypeError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }

  let canonical;
  try {
    canonical = canonicalizeJson(value);
  } catch (error) {
    if (error instanceof Error && error.message.includes("forbidden self-digest")) {
      throw error;
    }
    throw new TypeError(`${label} is not a canonical JSON payload.`, { cause: error });
  }
  if (!bytes.equals(canonical)) {
    throw new TypeError(`${label} must use RFC 8785 canonical JSON bytes.`);
  }
  return { value: requireObject(value, label), bytes };
}

export function parseSha256Sidecar(source, label) {
  const value = decodeUtf8(source, label);
  if (!/^[0-9a-f]{64}\n$/u.test(value)) {
    throw new TypeError(`${label} must contain one lowercase SHA-256 value and a newline.`);
  }
  return value.slice(0, -1);
}

export function requireExactPassedGateResults(
  value,
  requiredGates,
  { reportLabel, resultLabel, gateLabel, gatesLabel },
) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${reportLabel} results must be an array.`);
  }

  const seen = new Set();
  for (const [index, resultValue] of value.entries()) {
    const label = `${resultLabel} ${index}`;
    const result = requireObject(resultValue, label);
    requireExactKeys(result, ["name", "passed"], label);
    if (typeof result.name !== "string" || !requiredGates.includes(result.name)) {
      throw new TypeError(`${label}.name is not a required ${gateLabel}.`);
    }
    if (seen.has(result.name)) {
      throw new TypeError(`${reportLabel} contains duplicate result ${result.name}.`);
    }
    seen.add(result.name);
    if (result.passed !== true) {
      throw new TypeError(`Required ${gateLabel} ${result.name} did not pass.`);
    }
  }

  const missing = requiredGates.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new TypeError(`${reportLabel} is missing required ${gatesLabel}: ${missing.join(", ")}.`);
  }
  if (value.length !== requiredGates.length) {
    throw new TypeError(`${reportLabel} must contain exactly ${requiredGates.length} results.`);
  }
}

function parseRequiredGates(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Required gate names must be a non-empty array.");
  }
  const names = value.map((name, index) => requireString(name, `Required gate name ${index}`));
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new TypeError(`Required gate names contain duplicate ${duplicate}.`);
  }
  return names;
}

/** Validate an exact final gate report before it is used at a publication boundary. */
export function validateGateReport({
  report: reportValue,
  requiredGates: requiredGateValue,
  expectedManifestSha256: expectedManifestValue,
  expectedTarballSha256: expectedTarballValue,
}) {
  const expectedManifestSha256 = requireHash(
    expectedManifestValue,
    "Expected gate report manifestSha256",
  );
  const expectedTarballSha256 = requireHash(
    expectedTarballValue,
    "Expected gate report tarballSha256",
  );
  const requiredGates = parseRequiredGates(requiredGateValue);
  const report = requireObject(reportValue, "Gate report");
  requireExactKeys(
    report,
    ["commit", "liveReportSha256", "manifestSha256", "results", "tarballSha256", "version"],
    "Gate report",
  );
  if (report.version !== 1) throw new TypeError("Gate report version must be 1.");
  if (typeof report.commit !== "string" || !GIT_COMMIT.test(report.commit)) {
    throw new TypeError("Gate report commit must be a full lowercase Git commit.");
  }
  const manifestSha256 = requireHash(report.manifestSha256, "Gate report manifestSha256");
  const tarballSha256 = requireHash(report.tarballSha256, "Gate report tarballSha256");
  const liveReportSha256 = requireHash(report.liveReportSha256, "Gate report liveReportSha256");
  if (manifestSha256 !== expectedManifestSha256) {
    throw new TypeError("Gate report references a stale candidate manifest.");
  }
  if (tarballSha256 !== expectedTarballSha256) {
    throw new TypeError("Gate report references a stale candidate tarball.");
  }
  requireExactPassedGateResults(report.results, requiredGates, {
    reportLabel: "Gate report",
    resultLabel: "Gate report result",
    gateLabel: "gate",
    gatesLabel: "gates",
  });

  return Object.freeze({
    commit: report.commit,
    manifestSha256,
    tarballSha256,
    liveReportSha256,
    gates: requiredGates.length,
  });
}
