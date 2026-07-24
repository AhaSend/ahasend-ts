#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPackPreflight } from "./preflight-pack.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

process.exitCode = runPackPreflight({
  repositoryRoot,
  build: true,
  verificationScripts: ["test:docs:tarball"],
  temporaryPrefix: "ahasend-sdk-docs-preflight-",
});
