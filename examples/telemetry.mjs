// Telemetry hooks: observe every request, response, retry, and error
// the SDK makes. Wire these to your logger / metrics / tracing system.
// Hooks that throw are swallowed — they can never break a request.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/telemetry.mjs

import { AhaSendClient, optionsFromEnv } from "../dist/index.js";

const client = new AhaSendClient({
  ...optionsFromEnv(),
  accountId: process.env.AHASEND_ACCOUNT_ID,
  hooks: {
    onRequest: (e) => console.log(`→ ${e.method} ${e.path} (attempt ${e.attempt})`),
    onResponse: (e) =>
      console.log(
        `← ${e.method} ${e.path} ${e.status} in ${e.durationMs}ms` +
          (e.requestId ? `  request-id=${e.requestId}` : ""),
      ),
    onRetry: (e) => console.log(`↻ retrying ${e.path} in ${e.delayMs}ms (attempt ${e.attempt} failed)`),
    onError: (e) => console.log(`✗ ${e.method} ${e.path} attempt ${e.attempt}: ${e.error?.name}`),
  },
});

try {
  await client.ping();
  console.log("✓ done — every line above came from a telemetry hook");
} catch (err) {
  console.error("✗ ping failed:", err.name, err.message);
  process.exit(1);
}
