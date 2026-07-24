import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPackPreflight } from "./preflight-pack.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

process.exitCode = runPackPreflight({
  repositoryRoot,
  verificationScripts: ["test:docs:tarball", "test:package:tarball", "test:integration:tarball"],
});
