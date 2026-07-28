#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { digestArtifactFile } from "./digest-artifact.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileSource = resolve(repositoryRoot, "src/generated/operation-profile.json");
const digestSource = resolve(repositoryRoot, "src/generated/operation-profile.sha256");
const metadataDirectory = resolve(repositoryRoot, "dist/_metadata");
const profileDestination = resolve(metadataDirectory, "operation-profile.json");
const digestDestination = resolve(metadataDirectory, "operation-profile.sha256");

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

process.chdir(repositoryRoot);
await build({ config: resolve(repositoryRoot, "tsup.config.ts") });
await copyMetadata();
