#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  collectContractInventory,
  parseOpenApi,
  parseWebhookContract,
  validateWebhookContract,
} from "./generate-contracts.mjs";
import { ITERATOR_MAPPINGS, PRIMARY_OPERATION_MAPPINGS } from "./generate-sdk.mjs";
import { NODE_OPERATION_KEYS } from "./node-code-samples.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SPEC_REPOSITORY = "AhaSend/AhaSend";
export const DEFAULT_SPEC_REF = "master";
export const SPEC_FILES = Object.freeze(["openapi.yaml", "webhooks.yaml"]);

/**
 * The server repository owns webhooks.yaml and everything in openapi.yaml
 * except the code samples. Each SDK owns its own language's samples, so this
 * repository regenerates the Node ones after the copy.
 *
 * The SDK generator runs twice: first so the operation profile carries any new
 * facade mapping the sample check reads, then again so the contract digests
 * cover the spec with its Node samples injected.
 */
export const GENERATOR_SCRIPTS = Object.freeze([
  "scripts/generate-sdk.mjs",
  "scripts/generate-contracts.mjs",
  "scripts/generate-sdk.mjs",
  "scripts/generate-docs.mjs",
]);

export function parseSyncArguments(arguments_) {
  if (arguments_.length === 0) return { ref: DEFAULT_SPEC_REF };
  if (arguments_.length === 2 && arguments_[0] === "--ref" && arguments_[1].trim() !== "") {
    return { ref: arguments_[1] };
  }
  throw new TypeError("Usage: node scripts/sync-spec.mjs [--ref <branch>]");
}

async function downloadSpec(file, ref) {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${SPEC_REPOSITORY}/contents/${file}?ref=${encodeURIComponent(ref)}`,
    ],
    { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Name what the generators would otherwise report as inventory drift: an
 * operation needs a facade mapping and a Node sample before anything can be
 * generated, and every contract inventory in contracts.lock.json must match.
 */
export function describeUnmappedContract(document, lock) {
  const inventory = collectContractInventory(document);
  const problems = [];
  const mapped = new Set(PRIMARY_OPERATION_MAPPINGS.map(([operationId]) => operationId));
  const unmapped = inventory.operationIds.filter((operationId) => !mapped.has(operationId));
  if (unmapped.length > 0) {
    problems.push(
      `operations without a facade mapping in scripts/generate-sdk.mjs: ${unmapped.join(", ")}`,
    );
  }
  const unsampled = inventory.operationIds.filter(
    (operationId) => !Object.hasOwn(NODE_OPERATION_KEYS, operationId),
  );
  if (unsampled.length > 0) {
    problems.push(
      `operations without a Node sample in scripts/node-code-samples.mjs: ${unsampled.join(", ")}`,
    );
  }
  const operationIds = new Set(inventory.operationIds);
  const orphaned = [
    ...PRIMARY_OPERATION_MAPPINGS.map(([operationId]) => operationId),
    ...ITERATOR_MAPPINGS.map(([operationId]) => operationId),
  ].filter(
    (operationId, index, all) =>
      !operationIds.has(operationId) && all.indexOf(operationId) === index,
  );
  if (orphaned.length > 0) {
    problems.push(`mappings for operations the spec no longer has: ${orphaned.join(", ")}`);
  }
  for (const [key, expected] of Object.entries(lock.inventories ?? {})) {
    const actual = inventory[key] ?? [];
    const added = actual.filter((name) => !expected.includes(name));
    const removed = expected.filter((name) => !actual.includes(name));
    if (added.length > 0 || removed.length > 0) {
      problems.push(
        `contracts.lock.json ${key} drift: added ${JSON.stringify(added)}, removed ${JSON.stringify(removed)}`,
      );
    }
  }
  return problems;
}

async function runGenerators() {
  for (const script of GENERATOR_SCRIPTS) {
    process.stdout.write(`> node ${script}\n`);
    const { stdout } = await execFileAsync(process.execPath, [resolve(repositoryRoot, script)], {
      cwd: repositoryRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(stdout);
  }
}

/**
 * Write the downloaded files into `root` without leaving a mixed pair behind: every file goes to
 * a temporary sibling first, and only once all of them are written are they renamed into place.
 */
export async function writeSpecFiles(sources, root = repositoryRoot) {
  const staged = [...sources].map(([file, source]) => ({
    source,
    target: resolve(root, file),
    temporary: resolve(root, `${file}.sync-tmp`),
  }));
  const written = [];
  try {
    for (const { source, temporary } of staged) {
      await writeFile(temporary, source);
      written.push(temporary);
    }
  } catch (error) {
    await Promise.allSettled(written.map((temporary) => rm(temporary, { force: true })));
    throw error;
  }
  for (const { target, temporary } of staged) await rename(temporary, target);
}

const defaultSyncSteps = Object.freeze({
  download: downloadSpec,
  readLock: async () =>
    JSON.parse(await readFile(resolve(repositoryRoot, "contracts.lock.json"), "utf8")),
  writeFiles: (sources) => writeSpecFiles(sources),
  generate: runGenerators,
});

/**
 * Copy both spec files from `ref` and regenerate. Both files are downloaded and checked before
 * either is written, so a failed download, an unparseable file, or a contract change the
 * repository is not ready for leaves the committed pair as it was. The steps default to gh, the
 * repository files and the generators; tests replace them.
 */
export async function syncSpec({ ref }, steps = defaultSyncSteps) {
  const sources = new Map();
  for (const file of SPEC_FILES) sources.set(file, await steps.download(file, ref));
  const lock = await steps.readLock();

  validateWebhookContract(parseWebhookContract(sources.get("webhooks.yaml")));
  const problems = describeUnmappedContract(parseOpenApi(sources.get("openapi.yaml")), lock);
  if (problems.length > 0) {
    throw new TypeError(
      `the new spec changes the contract; update these before generating:\n- ${problems.join("\n- ")}`,
    );
  }

  await steps.writeFiles(sources);
  for (const file of sources.keys()) {
    process.stdout.write(`Copied ${file} from ${SPEC_REPOSITORY}@${ref}\n`);
  }
  await steps.generate();
}

async function main() {
  await syncSpec(parseSyncArguments(process.argv.slice(2)));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const detail =
      typeof error?.stderr === "string" && error.stderr.trim() !== ""
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`sync-spec: ${detail}\n`);
    process.exitCode = 1;
  });
}
