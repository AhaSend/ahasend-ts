#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { collectContractInventory, parseOpenApi } from "./generate-contracts.mjs";
import { ITERATOR_MAPPINGS, PRIMARY_OPERATION_MAPPINGS } from "./generate-sdk.mjs";
import { NODE_OPERATION_KEYS } from "./node-code-samples.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SPEC_REPOSITORY = "AhaSend/AhaSend";
export const DEFAULT_SPEC_REF = "devel";

/**
 * The server repository owns everything in openapi.yaml except the code
 * samples. Each SDK owns its own language's samples, so this repository
 * regenerates the Node ones after the copy.
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

async function downloadSpec(ref) {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${SPEC_REPOSITORY}/contents/openapi.yaml?ref=${encodeURIComponent(ref)}`,
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

async function run({ ref }) {
  const source = await downloadSpec(ref);
  const lock = JSON.parse(await readFile(resolve(repositoryRoot, "contracts.lock.json"), "utf8"));
  await writeFile(resolve(repositoryRoot, "openapi.yaml"), source);
  process.stdout.write(`Copied openapi.yaml from ${SPEC_REPOSITORY}@${ref}\n`);

  const problems = describeUnmappedContract(parseOpenApi(source), lock);
  if (problems.length > 0) {
    throw new TypeError(
      `the new spec changes the contract; update these before generating:\n- ${problems.join("\n- ")}`,
    );
  }
  await runGenerators();
}

async function main() {
  await run(parseSyncArguments(process.argv.slice(2)));
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
