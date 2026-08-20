// Re-sign the webhook contract fixtures.
//
// Mode `verify`  — recompute every digest/signature from the files on disk and
//                  compare against the manifests. Proves the implementation
//                  before it is trusted to write anything.
// Mode `rewrite` — install new body bytes, then recompute and persist.
//
// Both manifests are handled, because they are shaped differently and nothing
// else can rewrite either. `generate-contracts.mjs` only *validates* synthetic
// fixtures via validateSignedFixture, so a signature computed by hand would sit
// outside the regeneration workflow entirely — correct until the day it is not,
// with no tool able to say which.
//
//   captured  — `captures[]`, a nested `signingResource`, and a `headersSha256`
//               over the three signed headers.
//   synthetic — `fixtures[]`, a flat `keyPath`/`keySha256`, no resource, no
//               header digest.
//
// Every derived field is recomputed, including the resource's `idSha256` and
// `bindingSha256`. Those two are cheap to forget precisely because nothing
// reads them until `contracts:check` refuses the corpus.
//
// `rewrite` re-signs whatever body bytes it finds, so it cannot tell a
// deliberate change from a stray edit. See contracts/webhooks/README.md for
// what that means and what it does not do for you.
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file so the tool works from any checkout.
const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

const MANIFESTS = [
  {
    name: "captured",
    path: resolve(ROOT, "contracts/webhooks/captured/manifest.json"),
    entriesKey: "captures",
    captured: true,
  },
  {
    name: "synthetic",
    path: resolve(ROOT, "contracts/webhooks/synthetic/manifest.json"),
    entriesKey: "fixtures",
    captured: false,
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function keyBytes(keyPath) {
  const file = readFileSync(resolve(ROOT, keyPath));
  // The committed key files carry a trailing newline that is not part of the key.
  return file.subarray(0, file.length - 1);
}

function signatureFor(entry, key, rawBody) {
  return `v1,${createHmac("sha256", key)
    .update(entry.webhookId)
    .update(".")
    .update(entry.webhookTimestamp)
    .update(".")
    .update(rawBody)
    .digest("base64")}`;
}

function headerRecordDigest(format, entry, signature) {
  const record = format
    .replaceAll("{webhookId}", entry.webhookId)
    .replaceAll("{webhookTimestamp}", entry.webhookTimestamp)
    .replaceAll("{signature}", signature);
  return sha256Text(record);
}

// Where the key lives differs by manifest shape; everything downstream of it
// does not, so resolve the shape once here rather than branching per field.
function keyLocation(entry, captured) {
  if (!captured) return entry;
  const resource = entry.signingResource;
  if (resource === undefined) {
    throw new TypeError(`${entry.fixtureId} is missing signingResource`);
  }
  return resource;
}

// Read and validate everything before writing anything. The tool used to write
// each captured body inside the loop and persist a manifest only after its own
// loop finished, so a missing emitted body or a malformed second manifest left
// rewritten bodies against a stale manifest — the exact half-applied state its
// own header promises not to produce.
function loadManifest({ name, path, entriesKey }) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new TypeError(`${name} manifest is not readable JSON: ${cause.message}`, { cause });
  }
  const entries = manifest[entriesKey];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError(`${name} manifest has no ${entriesKey} entries`);
  }
  return manifest;
}

const mode = process.argv[2];
if (mode !== "verify" && mode !== "rewrite") {
  console.error("usage: resign-fixtures.mjs verify");
  console.error("       resign-fixtures.mjs rewrite <emitted-bodies-dir>");
  console.error("       resign-fixtures.mjs rewrite --synthetic-only");
  process.exit(2);
}
// Synthetic bodies are hand-written and this tool is the only thing that can
// sign them, so re-signing one must not require a Go toolchain, a server
// checkout, and a full re-emission of the captured corpus.
const rest = process.argv.slice(3);
const syntheticOnly = rest[0] === "--synthetic-only";
const emittedDir = syntheticOnly ? undefined : rest[0];
// `verify` covers both corpora, always: a narrowing flag there would let a
// corrupted captured body report a clean pass. And a trailing flag must not be
// ignored, or `rewrite <dir> --synthetic-only` silently does the opposite.
if (rest.length > 1 || (syntheticOnly && mode !== "rewrite")) {
  console.error("usage: resign-fixtures.mjs verify");
  console.error("       resign-fixtures.mjs rewrite <emitted-bodies-dir>");
  console.error("       resign-fixtures.mjs rewrite --synthetic-only");
  process.exit(2);
}
if (mode === "rewrite" && !syntheticOnly && emittedDir === undefined) {
  console.error("rewrite needs the directory emit-fixtures.go wrote to,");
  console.error("or --synthetic-only to re-sign just the hand-written corpus");
  process.exit(2);
}

let mismatches = 0;
const pendingBodies = [];

// `--synthetic-only` means exactly that: the captured corpus is not read, not
// recomputed, and not rewritten. Recomputing its digests from whatever is on
// disk would launder a stray edit to a captured body into signed evidence,
// which is the opposite of what a narrower mode should do.
const loaded = MANIFESTS.filter((descriptor) => !(syntheticOnly && descriptor.captured)).map(
  (descriptor) => ({
    ...descriptor,
    manifest: loadManifest(descriptor),
  }),
);

// Stage every input up front — emitted bodies, on-disk bodies, and signing
// keys — so a missing file fails before the first write rather than halfway
// through the corpus. Writing one body at a time and persisting each manifest
// at the end of its own loop left exactly the half-applied state this file's
// header promises not to produce.
const rewriteCaptured = mode === "rewrite" && !syntheticOnly;
const staged = new Map();
if (rewriteCaptured) {
  const emitted = new Set(readdirSync(emittedDir).filter((file) => file.endsWith(".json")));
  for (const { manifest, entriesKey, captured } of loaded) {
    if (!captured) continue;
    for (const entry of manifest[entriesKey]) {
      const file = `${entry.fixtureId}.json`;
      if (!emitted.has(file)) {
        throw new TypeError(`${emittedDir} has no ${file}; re-run emit-fixtures.go`);
      }
      emitted.delete(file);
      staged.set(`${entriesKey}/${entry.fixtureId}`, readFileSync(resolve(emittedDir, file)));
    }
  }
  // An emitted body nobody claims means emit-fixtures.go grew a fixture that
  // never entered the corpus — silence there is how a fixture goes missing.
  if (emitted.size > 0) {
    throw new TypeError(
      `${emittedDir} has bodies no manifest claims: ${[...emitted].sort().join(", ")}`,
    );
  }
}

// Keys and current bodies too: a wrong keyPath on the third capture used to
// surface only after the first two were already overwritten.
const keys = new Map();
const bodies = new Map();
for (const { name, entriesKey, captured, manifest } of loaded) {
  for (const entry of manifest[entriesKey]) {
    const where = keyLocation(entry, captured);
    try {
      keys.set(`${entriesKey}/${entry.fixtureId}`, keyBytes(where.keyPath));
    } catch (cause) {
      throw new TypeError(`${name} ${entry.fixtureId}: ${where.keyPath} is unreadable`, { cause });
    }
    if (captured && rewriteCaptured) continue;
    try {
      bodies.set(`${entriesKey}/${entry.fixtureId}`, readFileSync(resolve(ROOT, entry.bodyPath)));
    } catch (cause) {
      throw new TypeError(`${name} ${entry.fixtureId}: ${entry.bodyPath} is unreadable`, { cause });
    }
  }
}

for (const { name, entriesKey, captured, manifest } of loaded) {
  const entries = manifest[entriesKey];

  for (const entry of entries) {
    const location = keyLocation(entry, captured);
    const staging = `${entriesKey}/${entry.fixtureId}`;
    const key = keys.get(staging);

    // Only captured bodies come from the emitter. Synthetic bodies are
    // hand-written to exercise cases the emitter cannot be made to produce on
    // demand, so a rewrite re-signs them in place rather than replacing them.
    if (rewriteCaptured && captured) {
      // Stored verbatim: exactly the bytes json.Marshal produced, with no
      // trailing newline. That keeps rawBodySha256 and signature equal to what
      // a real server would emit for this payload, so a future captured
      // delivery can be byte-compared against this one.
      pendingBodies.push([resolve(ROOT, entry.bodyPath), staged.get(staging)]);
    }

    const rawBody = staged.get(staging) ?? bodies.get(staging);
    const computed = {
      rawBodySha256: sha256(rawBody),
      keySha256: sha256(key),
      signature: signatureFor(entry, key, rawBody),
    };
    const fields = [
      ["rawBodySha256", computed.rawBodySha256],
      ["signature", computed.signature],
    ];
    if (captured) {
      const resource = entry.signingResource;
      computed.headersSha256 = headerRecordDigest(
        manifest.headerRecordFormat,
        entry,
        computed.signature,
      );
      computed.idSha256 = sha256Text(`${resource.type}:${resource.id}`);
      computed.bindingSha256 = sha256Text(`${resource.type}:${resource.id}:${computed.keySha256}`);
      fields.push(["headersSha256", computed.headersSha256]);
    }

    if (mode === "verify") {
      for (const [field, value] of fields) {
        const ok = entry[field] === value;
        if (!ok) mismatches += 1;
        console.log(`${ok ? "ok  " : "FAIL"} ${name} ${entry.fixtureId} ${field}`);
        if (!ok) console.log(`       stored   ${entry[field]}\n       computed ${value}`);
      }
      const resourceFields = captured
        ? [
            ["keySha256", computed.keySha256],
            ["idSha256", computed.idSha256],
            ["bindingSha256", computed.bindingSha256],
          ]
        : [["keySha256", computed.keySha256]];
      for (const [field, value] of resourceFields) {
        const ok = location[field] === value;
        if (!ok) mismatches += 1;
        console.log(`${ok ? "ok  " : "FAIL"} ${name} ${entry.fixtureId} ${field}`);
        if (!ok) console.log(`       stored   ${location[field]}\n       computed ${value}`);
      }
    } else {
      entry.rawBodySha256 = computed.rawBodySha256;
      entry.signature = computed.signature;
      location.keySha256 = computed.keySha256;
      if (captured) {
        entry.headersSha256 = computed.headersSha256;
        location.idSha256 = computed.idSha256;
        location.bindingSha256 = computed.bindingSha256;
      }
      console.log(`re-signed ${name} ${entry.fixtureId}`);
      console.log(`  rawBodySha256 ${computed.rawBodySha256}`);
      console.log(`  signature     ${computed.signature}`);
      if (captured) console.log(`  headersSha256 ${computed.headersSha256}`);
    }
  }
}

if (mode === "rewrite") {
  // Everything only after every entry in every manifest has been recomputed, so
  // a throw part-way through cannot leave rewritten bodies against a stale
  // manifest.
  for (const [target, contents] of pendingBodies) writeFileSync(target, contents);
  for (const { name, path, manifest } of loaded) {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${name} manifest updated`);
  }
}

process.exit(mismatches > 0 ? 1 : 0);
