import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runNpm(args, cwd, env = process.env) {
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable === undefined ? "npm" : process.execPath;
  const commandArgs = npmExecutable === undefined ? args : [npmExecutable, ...args];
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

export function runPackPreflight({
  repositoryRoot,
  build = false,
  verificationScripts,
  temporaryPrefix = "ahasend-sdk-preflight-",
}) {
  if (build) {
    const buildStatus = runNpm(["run", "build"], repositoryRoot);
    if (buildStatus !== 0) return buildStatus;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), temporaryPrefix));
  try {
    const packStatus = runNpm(
      ["pack", "--ignore-scripts", "--pack-destination", temporaryDirectory],
      repositoryRoot,
    );
    if (packStatus !== 0) return packStatus;

    const tarballs = readdirSync(temporaryDirectory).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`Expected one preflight tarball, found ${tarballs.length}.`);
    }

    const tarball = join(temporaryDirectory, tarballs[0]);
    const checksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const environment = {
      ...process.env,
      SDK_TARBALL: tarball,
      SDK_TARBALL_SHA256: checksum,
    };
    for (const script of verificationScripts) {
      const status = runNpm(["run", script], repositoryRoot, environment);
      if (status !== 0) return status;
    }
    return 0;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
