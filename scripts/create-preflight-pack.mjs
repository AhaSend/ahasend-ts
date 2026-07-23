import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "ahasend-sdk-preflight-"));
const npmExecutable = process.env.npm_execpath;

function runNpm(args, env = process.env) {
  const command = npmExecutable === undefined ? "npm" : process.execPath;
  const commandArgs = npmExecutable === undefined ? args : [npmExecutable, ...args];
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

try {
  const packStatus = runNpm(["pack", "--ignore-scripts", "--pack-destination", temporaryDirectory]);
  if (packStatus !== 0) process.exitCode = packStatus;
  else {
    const tarballs = readdirSync(temporaryDirectory).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`Expected one preflight tarball, found ${tarballs.length}.`);
    }

    const tarball = join(temporaryDirectory, tarballs[0]);
    const checksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const testStatus = runNpm(["run", "test:integration"], {
      ...process.env,
      SDK_TARBALL: tarball,
      SDK_TARBALL_SHA256: checksum,
    });
    if (testStatus !== 0) process.exitCode = testStatus;
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
