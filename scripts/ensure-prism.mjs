import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The pinned Prism the documented workflows fetch. Prism is deliberately not a
// development dependency -- see the mock-server note in
// tests/release/audit-policy.test.ts -- so every caller names this version.
//
// README.md and examples/README.md spell it literally, because a documented
// command has to be copy-pasteable. tests/doc-workflows.test.ts pins the two
// together so they cannot drift apart silently.
export const PRISM_PACKAGE = "@stoplight/prism-cli@5.16.0";

const PRISM_PREFIX = join(tmpdir(), `ahasend-prism-${PRISM_PACKAGE.replaceAll(/[^\w.-]/gu, "-")}`);

/**
 * Populate the npx cache for PRISM_PACKAGE.
 *
 * For callers that run the documented `npx` command verbatim, which is the
 * point of the documentation workflow. Fetching Prism costs more than the
 * window that workflow allows the mock to answer in, so the download happens
 * here instead of inside the measurement.
 *
 * A failure is left to the caller's own readiness check to report, so a network
 * problem surfaces as the startup failure it is rather than as an opaque error
 * from a warm-up step.
 */
export function warmPrismCache() {
  spawnSync("npx", ["--yes", PRISM_PACKAGE, "--version"], {
    stdio: "ignore",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/**
 * Install PRISM_PACKAGE once into a temporary prefix and return its entry
 * script, for callers that need to spawn Prism as a process they can kill.
 *
 * `npx` is a wrapper: it runs Prism as a child, so a spawner that signals only
 * its direct child leaves Prism holding the port. The integration suite's
 * teardown does exactly that, and one of its tests exists to prove a ready
 * Prism is torn down, so it needs the real executable rather than a wrapper.
 *
 * The prefix is keyed by version and reused, so this costs a download once per
 * machine rather than once per run.
 */
export function installPrism() {
  const manifestPath = join(
    PRISM_PREFIX,
    "node_modules",
    "@stoplight",
    "prism-cli",
    "package.json",
  );

  if (!existsSync(manifestPath)) {
    const install = spawnSync(
      "npm",
      ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", PRISM_PREFIX, PRISM_PACKAGE],
      { stdio: "ignore", env: { ...process.env, NO_COLOR: "1" } },
    );
    if (install.status !== 0 || !existsSync(manifestPath)) {
      throw new Error(`Unable to install ${PRISM_PACKAGE} into ${PRISM_PREFIX}.`);
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const relativeBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.prism;
  if (relativeBin === undefined) {
    throw new Error(`${PRISM_PACKAGE} does not declare its prism executable.`);
  }
  return resolve(dirname(manifestPath), relativeBin);
}
