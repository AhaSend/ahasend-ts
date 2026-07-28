#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promoteLatest } from "./restore-latest.mjs";

async function main() {
  const [packageName, version, ...extra] = process.argv.slice(2);
  if (packageName === undefined || version === undefined || extra.length > 0) {
    throw new TypeError("Usage: node scripts/promote-latest.mjs <package-name> <version>");
  }
  await promoteLatest({ packageName, version });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`promote-latest: ${message}\n`);
    process.exitCode = 1;
  });
}
