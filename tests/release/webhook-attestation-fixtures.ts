import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalizeJson, digestJsonArtifact } from "../../scripts/digest-artifact.mjs";

type JsonRecord = Record<string, unknown>;

interface SigningResource {
  type: "configured-webhook" | "route";
  id: string;
  keyPath: string;
  keySha256: string;
}

interface Capture extends JsonRecord {
  fixtureId: string;
  bodyPath: string;
  rawBodySha256: string;
  signingResource: SigningResource;
  webhookId: string;
  webhookTimestamp: string;
  signature: string;
  headersSha256: string;
  expectedResult: "valid" | "invalid";
}

interface EvidenceRow extends JsonRecord {
  fixture: string;
  signingResource: {
    type: "configured-webhook" | "route";
    id: string;
  };
  keySha256: string;
  captureSha256: string;
  webhookId: string;
  webhookTimestamp: string;
  signature: string;
  bodySha256: string;
  headersSha256: string;
}

interface TypeScriptRow extends EvidenceRow {
  result: "valid" | "invalid";
}

interface GoRow extends EvidenceRow {
  serverCommit: string;
  expectedResult: "valid" | "invalid";
  actualResult: "valid" | "invalid";
}

interface CapturedManifest extends JsonRecord {
  serverCommit: string;
  headerRecordFormat: string;
  captures: Capture[];
}

interface TypeScriptResults extends JsonRecord {
  version: number;
  implementation: string;
  manifestSha256: string;
  results: TypeScriptRow[];
}

interface GoResults extends JsonRecord {
  version: number;
  implementation: string;
  manifestSha256: string;
  serverCommit: string;
  results: GoRow[];
}

const root = process.cwd();
const capturedRoot = "contracts/webhooks/captured";
const manifestPath = `${capturedRoot}/manifest.json`;
const schemaPath = `${capturedRoot}/manifest.schema.json`;
const manifestSidecarPath = `${capturedRoot}/manifest.sha256`;
const typescriptResultsPath = `${capturedRoot}/typescript-results.json`;
const typescriptResultsSidecarPath = `${capturedRoot}/typescript-results.sha256`;
function read(path: string): Buffer {
  return readFileSync(resolve(root, path));
}

function parse<T>(source: Buffer): T {
  return JSON.parse(source.toString("utf8")) as T;
}

function requireRow<T>(rows: T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new TypeError(`Missing webhook fixture row ${index}`);
  return row;
}

function expectedEvidence(capture: Capture): EvidenceRow {
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

export const webhookManifestSource = read(manifestPath);
export const webhookManifestSchemaSource = read(schemaPath);
export const webhookManifestSidecar = read(manifestSidecarPath);
export const webhookTypescriptResultsSource = read(typescriptResultsPath);
export const webhookTypescriptResultsSidecar = read(typescriptResultsSidecarPath);
export const webhookManifest = parse<CapturedManifest>(webhookManifestSource);

export function validGoWebhookAttestation(manifest: CapturedManifest = webhookManifest): GoResults {
  return {
    version: 1,
    implementation: "ahasend-go",
    manifestSha256: digestJsonArtifact(manifest),
    serverCommit: manifest.serverCommit,
    results: manifest.captures.map((capture) => ({
      ...expectedEvidence(capture),
      serverCommit: manifest.serverCommit,
      expectedResult: capture.expectedResult,
      actualResult: capture.expectedResult,
    })),
  };
}

export function webhookAttestationFixture(mutation: string): {
  manifestSource: Buffer;
  manifestSchemaSource: Buffer;
  manifestSidecar: Buffer | string;
  typescriptResultsSource: Buffer;
  typescriptResultsSidecar: Buffer | string;
  goResultsSource: Buffer;
  fixtureSources: Record<string, Buffer>;
} {
  const manifest = structuredClone(webhookManifest);
  const schema = parse<JsonRecord>(webhookManifestSchemaSource);
  const typescriptResults = parse<TypeScriptResults>(webhookTypescriptResultsSource);
  const fixtureSources = Object.fromEntries(
    manifest.captures.flatMap((capture) => [
      [capture.bodyPath, read(capture.bodyPath)],
      [capture.signingResource.keyPath, read(capture.signingResource.keyPath)],
    ]),
  );
  let goResults = validGoWebhookAttestation(manifest);
  let manifestSource: Buffer = webhookManifestSource;
  let manifestSidecar: Buffer | string = webhookManifestSidecar;
  let manifestSchemaSource: Buffer = webhookManifestSchemaSource;
  let typescriptResultsSource: Buffer = webhookTypescriptResultsSource;
  let typescriptResultsSidecar: Buffer | string = webhookTypescriptResultsSidecar;
  let goResultsSource: Buffer;

  const rebindManifest = () => {
    const manifestDigest = digestJsonArtifact(manifest);
    manifestSource = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    manifestSidecar = `${manifestDigest}\n`;
    typescriptResults.manifestSha256 = manifestDigest;
    typescriptResults.results = manifest.captures.map((capture) => ({
      ...expectedEvidence(capture),
      result: "valid",
    }));
    typescriptResultsSource = Buffer.from(
      `${JSON.stringify(typescriptResults, null, 2)}\n`,
      "utf8",
    );
    typescriptResultsSidecar = `${digestJsonArtifact(typescriptResults)}\n`;
    goResults = validGoWebhookAttestation(manifest);
  };

  switch (mutation) {
    case "none":
      break;
    case "staleManifestSidecar":
      manifestSidecar = `${"0".repeat(64)}\n`;
      break;
    case "invalidManifestSchema":
      (schema as { required?: unknown }).required = [];
      manifestSchemaSource = Buffer.from(`${JSON.stringify(schema, null, 2)}\n`, "utf8");
      break;
    case "staleCaptureDigest":
      requireRow(goResults.results, 0).captureSha256 = "0".repeat(64);
      break;
    case "staleKeyDigest":
      requireRow(goResults.results, 0).keySha256 = "0".repeat(64);
      break;
    case "staleServerCommit":
      requireRow(goResults.results, 0).serverCommit = "0".repeat(40);
      break;
    case "substitutedServerCommit":
      goResults.serverCommit = "0".repeat(40);
      for (const row of goResults.results) {
        row.serverCommit = goResults.serverCommit;
      }
      break;
    case "swappedKeys": {
      const first = manifest.captures[0];
      const second = manifest.captures[1];
      if (first === undefined || second === undefined) {
        throw new TypeError("Webhook fixture requires two captures");
      }
      fixtureSources[first.signingResource.keyPath] = read(second.signingResource.keyPath);
      break;
    }
    case "missingFixture":
      delete fixtureSources[requireRow(manifest.captures, 0).bodyPath];
      break;
    case "alteredHeader":
      requireRow(goResults.results, 0).webhookId += "-altered";
      break;
    case "alteredBody": {
      const bodyPath = requireRow(manifest.captures, 0).bodyPath;
      fixtureSources[bodyPath] = Buffer.concat([
        fixtureSources[bodyPath] ?? Buffer.alloc(0),
        Buffer.from(" ", "utf8"),
      ]);
      break;
    }
    case "signatureMismatch":
      requireRow(manifest.captures, 0).signature =
        "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      rebindManifest();
      break;
    case "headerDigestMismatch":
      requireRow(manifest.captures, 0).headersSha256 = "0".repeat(64);
      rebindManifest();
      break;
    case "manifestExpectedResultMismatch":
      requireRow(goResults.results, 0).expectedResult = "invalid";
      break;
    case "goActualResultMismatch":
      requireRow(goResults.results, 0).actualResult = "invalid";
      break;
    case "typescriptResultMismatch":
      requireRow(typescriptResults.results, 0).result = "invalid";
      typescriptResultsSource = Buffer.from(
        `${JSON.stringify(typescriptResults, null, 2)}\n`,
        "utf8",
      );
      typescriptResultsSidecar = `${digestJsonArtifact(typescriptResults)}\n`;
      break;
    case "missingGoRow":
      goResults.results.pop();
      break;
    case "noncanonicalPayload":
      goResultsSource = Buffer.from(JSON.stringify(goResults, null, 2), "utf8");
      return {
        manifestSource,
        manifestSchemaSource,
        manifestSidecar,
        typescriptResultsSource,
        typescriptResultsSidecar,
        goResultsSource,
        fixtureSources,
      };
    default:
      throw new TypeError(`Unknown webhook attestation mutation ${mutation}`);
  }

  goResultsSource = canonicalizeJson(goResults);
  return {
    manifestSource,
    manifestSchemaSource,
    manifestSidecar,
    typescriptResultsSource,
    typescriptResultsSidecar,
    goResultsSource,
    fixtureSources,
  };
}
