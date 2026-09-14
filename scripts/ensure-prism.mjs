import { spawnSync } from "node:child_process";

// The pinned Prism the documented workflows fetch. Prism is deliberately not a
// development dependency -- see the mock-server note in tests/release/audit-policy.test.ts --
// so every caller resolves it through npx at this exact version.
//
// README.md and examples/README.md spell the same version literally, because a
// documented command has to be copy-pasteable. tests/doc-workflows.test.ts pins
// the two together so they cannot drift apart silently.
export const PRISM_PACKAGE = "@stoplight/prism-cli@5.16.0";

/**
 * Populate the npx cache for PRISM_PACKAGE.
 *
 * Fetching Prism costs far more than the startup budget the suites allow a mock
 * server: the integration suite gives a hook 120s to start Prism and see it
 * answer, and the documentation workflow gives it 60s. Both are ample against a
 * warm cache and neither survives a cold download. Warming it once, outside any
 * per-test budget, keeps that cost out of the measurements.
 *
 * A failure here is left to the caller's own startup path to report, so a
 * network problem surfaces as the readiness failure it actually is rather than
 * as an opaque error from a warm-up step.
 */
export function ensurePrism() {
  spawnSync("npx", ["--yes", PRISM_PACKAGE, "--version"], {
    stdio: "ignore",
    env: { ...process.env, NO_COLOR: "1" },
  });
}
