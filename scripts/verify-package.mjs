#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repositoryRoot, "tests/package");
const require = createRequire(import.meta.url);
const [tarballArgument, checksumArgument] = process.argv.slice(2);
const tarball = resolve(tarballArgument ?? process.env.SDK_TARBALL ?? "");
const expectedChecksum = (checksumArgument ?? process.env.SDK_TARBALL_SHA256 ?? "").toLowerCase();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function packageJsonPath(packageName) {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch (packageJsonError) {
    let directory = dirname(require.resolve(packageName));

    while (true) {
      const candidate = join(directory, "package.json");
      try {
        const packageJson = JSON.parse(readFileSync(candidate, "utf8"));
        if (packageJson.name === packageName) return candidate;
      } catch {
        // Keep walking toward the package root.
      }

      const parent = dirname(directory);
      if (parent === directory) throw packageJsonError;
      directory = parent;
    }
  }
}

function packageExecutable(packageName, executableName) {
  const manifestPath = packageJsonPath(packageName);
  const packageJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = packageJson.bin;
  const relativeExecutable =
    typeof bin === "string" ? bin : (bin?.[executableName] ?? bin?.[packageName]);

  if (typeof relativeExecutable !== "string") {
    throw new Error(`Package ${packageName} does not provide the ${executableName} executable.`);
  }
  return resolve(dirname(manifestPath), relativeExecutable);
}

function run(label, command, args, cwd) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function installTarball(directory) {
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable === undefined ? "npm" : process.execPath;
  const args =
    npmExecutable === undefined
      ? [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--no-save",
          tarball,
        ]
      : [
          npmExecutable,
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--no-save",
          tarball,
        ];
  run(`install ${basename(tarball)}`, command, args, directory);
}

if (!tarballArgument && !process.env.SDK_TARBALL) {
  fail(
    "Usage: node scripts/verify-package.mjs <tarball> <sha256> (or set SDK_TARBALL and SDK_TARBALL_SHA256).",
  );
}
if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) {
  fail("A lowercase 64-character SDK_TARBALL_SHA256 checksum is required.");
}

try {
  if (!statSync(tarball).isFile()) fail(`SDK tarball is not a file: ${tarball}`);
} catch {
  fail(`SDK tarball does not exist: ${tarball}`);
}

const actualChecksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
if (!timingSafeEqual(Buffer.from(actualChecksum, "hex"), Buffer.from(expectedChecksum, "hex"))) {
  fail(`SDK tarball checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}.`);
}

const temporaryRoot = mkdtempSync(resolve(repositoryRoot, ".package-verification-"));

try {
  const publint = packageExecutable("publint", "publint");
  const attw = packageExecutable("@arethetypeswrong/cli", "attw");
  const apiExtractor = packageExecutable("@microsoft/api-extractor", "api-extractor");
  const compilers = [
    ["TypeScript 5.6", packageExecutable("typescript", "tsc")],
    ["current TypeScript", packageExecutable("typescript-current", "tsc")],
  ];

  run("publint", process.execPath, [publint, tarball, "--strict"], repositoryRoot);
  run(
    "Are The Types Wrong",
    process.execPath,
    [attw, tarball, "--profile", "node16", "--no-emoji", "--no-summary"],
    repositoryRoot,
  );

  for (const fixture of ["esm", "cjs"]) {
    const fixtureDirectory = resolve(temporaryRoot, fixture);
    cpSync(resolve(fixtureRoot, fixture), fixtureDirectory, { recursive: true });
    installTarball(fixtureDirectory);
    run(
      `${fixture.toUpperCase()} package consumer`,
      process.execPath,
      ["index.js"],
      fixtureDirectory,
    );
  }

  const typesDirectory = resolve(temporaryRoot, "types");
  cpSync(resolve(fixtureRoot, "types"), typesDirectory, { recursive: true });
  installTarball(typesDirectory);
  for (const [compilerName, compiler] of compilers) {
    for (const resolution of ["node16", "nodenext", "bundler"]) {
      run(
        `${compilerName} / ${resolution}`,
        process.execPath,
        [compiler, "--project", `tsconfig.${resolution}.json`, "--pretty", "false"],
        typesDirectory,
      );
    }
  }

  for (const config of ["api-extractor.json", "api-extractor.webhooks.json"]) {
    run(
      `API Extractor / ${config}`,
      process.execPath,
      [apiExtractor, "run", "--config", resolve(repositoryRoot, "config", config)],
      repositoryRoot,
    );
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
