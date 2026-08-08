import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime smoke orchestrator", () => {
  it("removes the isolated consumer when the selected runtime fails", () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "ahasend-runtime-orchestrator-test-"));
    temporaryDirectories.push(fixtureDirectory);
    const binDirectory = join(fixtureDirectory, "bin");
    const npmStub = join(fixtureDirectory, "npm-stub.mjs");
    const runtimeStub = join(binDirectory, "deno");
    const npmLog = join(fixtureDirectory, "npm-log.json");
    const runtimeLog = join(fixtureDirectory, "runtime-log.json");
    const tarball = join(fixtureDirectory, "ahasend-sdk-test.tgz");
    mkdirSync(binDirectory);
    writeFileSync(tarball, "stub tarball");
    writeFileSync(
      npmStub,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.NPM_STUB_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
`,
    );
    writeFileSync(
      runtimeStub,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(process.env.RUNTIME_STUB_LOG, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  manifest: JSON.parse(readFileSync("package.json", "utf8")),
}));
process.exit(9);
`,
    );
    chmodSync(runtimeStub, 0o755);

    const result = spawnSync(process.execPath, ["scripts/run-runtime-smoke.mjs", "deno", tarball], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NPM_STUB_LOG: npmLog,
        RUNTIME_STUB_LOG: runtimeLog,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
        npm_execpath: npmStub,
      },
    });

    const npmCall = JSON.parse(readFileSync(npmLog, "utf8")) as {
      readonly args: readonly string[];
      readonly cwd: string;
    };
    const runtimeCall = JSON.parse(readFileSync(runtimeLog, "utf8")) as {
      readonly args: readonly string[];
      readonly cwd: string;
      readonly manifest: Readonly<Record<string, unknown>>;
    };
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("deno runtime smoke failed with exit code 9");
    expect(npmCall.args).toEqual([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      tarball,
    ]);
    expect(runtimeCall).toMatchObject({
      args: ["run", "--node-modules-dir=manual", "smoke.mjs"],
      cwd: npmCall.cwd,
      manifest: { name: "ahasend-runtime-smoke", private: true, type: "module" },
    });
    expect(existsSync(join(runtimeCall.cwd, "smoke.mjs"))).toBe(false);
    expect(existsSync(runtimeCall.cwd)).toBe(false);
  });
});
