#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { assertNoNodeSpecifiers } from "./assert-no-node-specifiers.mjs";
import { digestArtifactFile } from "./digest-artifact.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedRepositoryRoot = process.env.AHASEND_EXPECT_BUILD_ROOT;
const profileSource = resolve(repositoryRoot, "src/generated/operation-profile.json");
const digestSource = resolve(repositoryRoot, "src/generated/operation-profile.sha256");
const metadataDirectory = resolve(repositoryRoot, "dist/_metadata");
const profileDestination = resolve(metadataDirectory, "operation-profile.json");
const digestDestination = resolve(metadataDirectory, "operation-profile.sha256");

if (expectedRepositoryRoot !== undefined && resolve(expectedRepositoryRoot) !== repositoryRoot) {
  throw new Error(
    `Refusing to build ${repositoryRoot}; expected build root ${resolve(expectedRepositoryRoot)}.`,
  );
}

async function verifyMetadata(profilePath, digestPath) {
  const digestBytes = await readFile(digestPath);
  const detachedDigest = digestBytes.toString("utf8");

  if (!/^[0-9a-f]{64}\n$/.test(detachedDigest)) {
    throw new TypeError(
      "Operation profile digest must be lowercase SHA-256 followed by a newline.",
    );
  }

  const actualDigest = await digestArtifactFile(profilePath);
  if (detachedDigest !== `${actualDigest}\n`) {
    throw new Error("Operation profile does not match its detached digest.");
  }
}

async function copyMetadata() {
  await verifyMetadata(profileSource, digestSource);
  await mkdir(metadataDirectory, { recursive: true });
  await Promise.all([
    copyFile(profileSource, profileDestination),
    copyFile(digestSource, digestDestination),
  ]);

  const [sourceProfile, packagedProfile, sourceDigest, packagedDigest] = await Promise.all([
    readFile(profileSource),
    readFile(profileDestination),
    readFile(digestSource),
    readFile(digestDestination),
  ]);
  assert.deepEqual(packagedProfile, sourceProfile, "Packaged operation profile bytes changed");
  assert.deepEqual(packagedDigest, sourceDigest, "Packaged operation profile digest bytes changed");
  await verifyMetadata(profileDestination, digestDestination);
}

async function collectDistArtifacts(
  directory = resolve(repositoryRoot, "dist"),
  artifacts = new Map(),
) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectDistArtifacts(path, artifacts);
    } else if (entry.isFile()) {
      const artifactPath = relative(repositoryRoot, path).split(sep).join("/");
      artifacts.set(artifactPath, await readFile(path));
    }
  }
  return artifacts;
}

process.chdir(repositoryRoot);
await build({ config: resolve(repositoryRoot, "tsup.config.ts") });
await copyMetadata();
assertNoNodeSpecifiers(await collectDistArtifacts());
