import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
    const verificationEnvironment = {
      ...process.env,
      SDK_TARBALL: tarball,
      SDK_TARBALL_SHA256: checksum,
    };
    const packageStatus = runNpm(["run", "test:package:tarball"], verificationEnvironment);
    if (packageStatus !== 0) process.exitCode = packageStatus;
    else {
      const integrationStatus = runNpm(
        ["run", "test:integration:tarball"],
        verificationEnvironment,
      );
      if (integrationStatus !== 0) process.exitCode = integrationStatus;
    }
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
