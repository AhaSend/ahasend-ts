#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function defaultRunNpm(args) {
  return execFileSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function defaultDelay() {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
}

async function runWithRetries({ args, attempts, delay, runNpm }) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { output: await runNpm(args), failure: null };
    } catch (error) {
      failure = error;
      if (attempt < attempts) await delay();
    }
  }
  return { output: null, failure };
}

async function verifyLatest({
  attempts,
  delay,
  expectedLatest,
  packageName,
  runNpm,
  verification,
}) {
  let failure;
  let observedLatest;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      observedLatest = (await runNpm(["view", packageName, "dist-tags.latest"])).trim();
      if (observedLatest === expectedLatest) return;
    } catch (error) {
      failure = error;
    }
    if (attempt < attempts) await delay();
  }
  if (observedLatest === undefined) {
    throw new Error(`Could not verify the ${verification} latest tag for ${packageName}.`, {
      cause: failure,
    });
  }
  throw new Error(
    `Latest ${verification} verification failed for ${packageName}: expected ${JSON.stringify(expectedLatest)}, received ${JSON.stringify(observedLatest)}.`,
    { cause: failure },
  );
}

async function updateLatest({
  packageName,
  targetLatest,
  verification,
  attempts = 5,
  delay = defaultDelay,
  runNpm = defaultRunNpm,
}) {
  if (typeof packageName !== "string" || packageName.trim() === "") {
    throw new TypeError("Package name must be a non-empty string.");
  }
  if (targetLatest !== null && (typeof targetLatest !== "string" || targetLatest.trim() === "")) {
    throw new TypeError("Target latest must be a non-empty string or null.");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError("Latest-tag attempts must be a positive safe integer.");
  }

  const expectedLatest = targetLatest ?? "";
  const mutationArgs =
    targetLatest === null
      ? ["dist-tag", "rm", packageName, "latest"]
      : ["dist-tag", "add", `${packageName}@${targetLatest}`, "latest"];

  // A registry response can be lost after the mutation commits. Always verify
  // the resulting tag instead of treating the command's exit status as truth.
  const mutation = await runWithRetries({ args: mutationArgs, attempts, delay, runNpm });
  try {
    await verifyLatest({
      attempts,
      delay,
      expectedLatest,
      packageName,
      runNpm,
      verification,
    });
  } catch (error) {
    if (mutation.failure === null || !(error instanceof Error) || error.cause !== undefined) {
      throw error;
    }
    throw new Error(error.message, { cause: mutation.failure });
  }
}

export async function promoteLatest({
  packageName,
  version,
  attempts = 5,
  delay = defaultDelay,
  runNpm = defaultRunNpm,
}) {
  if (typeof version !== "string" || version.trim() === "") {
    throw new TypeError("Promotion version must be a non-empty string.");
  }
  await updateLatest({
    packageName,
    targetLatest: version,
    verification: "promotion",
    attempts,
    delay,
    runNpm,
  });
}

export async function restoreLatest({
  packageName,
  previousLatest,
  attempts = 5,
  delay = defaultDelay,
  runNpm = defaultRunNpm,
}) {
  if (previousLatest !== null && typeof previousLatest !== "string") {
    throw new TypeError("Previous latest must be a string or null.");
  }
  await updateLatest({
    packageName,
    targetLatest: previousLatest,
    verification: "rollback",
    attempts,
    delay,
    runNpm,
  });
}

async function main() {
  const [packageName, previousLatest, ...extra] = process.argv.slice(2);
  if (packageName === undefined || previousLatest === undefined || extra.length > 0) {
    throw new TypeError(
      "Usage: node scripts/restore-latest.mjs <package-name> <previous-latest-or-empty>",
    );
  }
  await restoreLatest({
    packageName,
    previousLatest: previousLatest === "" ? null : previousLatest,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`restore-latest: ${message}\n`);
    process.exitCode = 1;
  });
}
