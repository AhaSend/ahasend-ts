#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [runtime, tarballArgument] = process.argv.slice(2);

if (runtime !== "deno" && runtime !== "bun") {
  throw new TypeError('Runtime smoke requires exactly one runtime: "deno" or "bun".');
}

const tarballSource = tarballArgument ?? process.env.SDK_TARBALL;
if (tarballSource === undefined || tarballSource.trim() === "") {
  throw new TypeError("Runtime smoke requires an exact tarball path via SDK_TARBALL or argv.");
}
const tarball = resolve(tarballSource);
if (!tarball.endsWith(".tgz") || !statSync(tarball).isFile()) {
  throw new TypeError(`Runtime smoke tarball is not a .tgz file: ${tarball}`);
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function runNpm(args, cwd) {
  const npmExecutable = process.env.npm_execpath;
  return npmExecutable === undefined
    ? run("npm", args, cwd)
    : run(process.execPath, [npmExecutable, ...args], cwd);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), `ahasend-sdk-${runtime}-smoke-`));
try {
  writeFileSync(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify({ name: "ahasend-runtime-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  copyFileSync(
    resolve(repositoryRoot, "tests/runtime-smoke.mjs"),
    join(temporaryDirectory, "smoke.mjs"),
  );

  const installStatus = runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", tarball],
    temporaryDirectory,
  );
  if (installStatus !== 0) {
    throw new Error(`Installing ${basename(tarball)} failed with exit code ${installStatus}.`);
  }

  const runtimeArguments =
    runtime === "deno" ? ["run", "--node-modules-dir=manual", "smoke.mjs"] : ["run", "smoke.mjs"];
  const runtimeStatus = run(runtime, runtimeArguments, temporaryDirectory);
  if (runtimeStatus !== 0) {
    throw new Error(`${runtime} runtime smoke failed with exit code ${runtimeStatus}.`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
