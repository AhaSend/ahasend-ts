// Re-sign the webhook contract fixtures.
//
// Mode `verify`  — recompute every digest/signature from the files on disk and
//                  compare against the manifest. Proves the implementation
//                  before it is trusted to write anything.
// Mode `rewrite` — install new body bytes, then recompute and persist.
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file so the tool works from any checkout.
const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const MANIFEST = resolve(ROOT, "contracts/webhooks/captured/manifest.json");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function keyBytes(keyPath) {
  const file = readFileSync(resolve(ROOT, keyPath));
  // The committed key files carry a trailing newline that is not part of the key.
  return file.subarray(0, file.length - 1);
}

function signatureFor(capture, key, rawBody) {
  return `v1,${createHmac("sha256", key)
    .update(capture.webhookId)
    .update(".")
    .update(capture.webhookTimestamp)
    .update(".")
    .update(rawBody)
    .digest("base64")}`;
}

function headerRecordDigest(format, capture) {
  const record = format
    .replaceAll("{webhookId}", capture.webhookId)
    .replaceAll("{webhookTimestamp}", capture.webhookTimestamp)
    .replaceAll("{signature}", capture.signature);
  return createHash("sha256").update(record, "utf8").digest("hex");
}

const mode = process.argv[2];
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
let mismatches = 0;

for (const capture of manifest.captures) {
  const resource = capture.signingResource;
  const key = keyBytes(resource.keyPath);

  if (mode === "rewrite") {
    // Stored verbatim: exactly the bytes json.Marshal produced, with no
    // trailing newline. That keeps rawBodySha256 and signature equal to what a
    // real server would emit for this payload, so a future captured delivery
    // can be byte-compared against this one.
    const emitted = readFileSync(resolve(process.argv[3], `${capture.fixtureId}.json`));
    writeFileSync(resolve(ROOT, capture.bodyPath), emitted);
  }

  const rawBody = readFileSync(resolve(ROOT, capture.bodyPath));
  const computed = {
    rawBodySha256: sha256(rawBody),
    keySha256: sha256(key),
    signature: signatureFor(capture, key, rawBody),
  };
  const computedHeaders = headerRecordDigest(manifest.headerRecordFormat, {
    ...capture,
    signature: computed.signature,
  });

  if (mode === "verify") {
    for (const [field, value] of [
      ["rawBodySha256", computed.rawBodySha256],
      ["signature", computed.signature],
      ["headersSha256", computedHeaders],
    ]) {
      const stored = capture[field];
      const ok = stored === value;
      if (!ok) mismatches += 1;
      console.log(`${ok ? "ok  " : "FAIL"} ${capture.fixtureId} ${field}`);
      if (!ok) console.log(`       stored   ${stored}\n       computed ${value}`);
    }
    const keyOk = resource.keySha256 === computed.keySha256;
    if (!keyOk) mismatches += 1;
    console.log(`${keyOk ? "ok  " : "FAIL"} ${capture.fixtureId} keySha256`);
  } else {
    capture.rawBodySha256 = computed.rawBodySha256;
    capture.signature = computed.signature;
    capture.headersSha256 = computedHeaders;
    resource.keySha256 = computed.keySha256;
    console.log(`re-signed ${capture.fixtureId}`);
    console.log(`  rawBodySha256 ${computed.rawBodySha256}`);
    console.log(`  signature     ${computed.signature}`);
    console.log(`  headersSha256 ${computedHeaders}`);
  }
}

if (mode === "rewrite") {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("manifest updated");
}

process.exit(mismatches > 0 ? 1 : 0);
