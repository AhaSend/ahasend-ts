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

async function verifyLatest({ attempts, delay, expectedLatest, packageName, runNpm }) {
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
    throw new Error(`Could not verify the restored latest tag for ${packageName}.`, {
      cause: failure,
    });
  }
  throw new Error(
    `Latest rollback verification failed for ${packageName}: expected ${JSON.stringify(expectedLatest)}, received ${JSON.stringify(observedLatest)}.`,
    { cause: failure },
  );
}

export async function restoreLatest({
  packageName,
  previousLatest,
  attempts = 5,
  delay = defaultDelay,
  runNpm = defaultRunNpm,
}) {
  if (typeof packageName !== "string" || packageName.trim() === "") {
    throw new TypeError("Package name must be a non-empty string.");
  }
  if (previousLatest !== null && typeof previousLatest !== "string") {
    throw new TypeError("Previous latest must be a string or null.");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError("Rollback attempts must be a positive safe integer.");
  }

  const expectedLatest = previousLatest ?? "";
  const mutationArgs =
    previousLatest === null
      ? ["dist-tag", "rm", packageName, "latest"]
      : ["dist-tag", "add", `${packageName}@${previousLatest}`, "latest"];

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
    });
  } catch (error) {
    if (mutation.failure === null || !(error instanceof Error) || error.cause !== undefined) {
      throw error;
    }
    throw new Error(error.message, { cause: mutation.failure });
  }
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
