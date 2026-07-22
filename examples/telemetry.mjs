// Telemetry hooks: observe every request, response, retry, and error
// the SDK makes. Wire these to your logger / metrics / tracing system.
// Hooks run asynchronously; throws and returned-promise rejections are
// swallowed, so telemetry can never break or delay a request.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/telemetry.mjs

import { AhaSendClient, optionsFromEnv } from "../dist/index.js";

const client = new AhaSendClient({
  ...optionsFromEnv(),
  accountId: process.env.AHASEND_ACCOUNT_ID,
  hooks: {
    onRequest: (e) => console.log(`→ ${e.method} ${e.routeTemplate} (attempt ${e.attempt})`),
    onResponse: (e) =>
      console.log(
        `← ${e.method} ${e.routeTemplate} ${e.status} in ${e.durationMs}ms` +
          (e.requestId ? `  request-id=${e.requestId}` : ""),
      ),
    onRetry: (e) =>
      console.log(`↻ retrying ${e.routeTemplate} in ${e.delayMs}ms (attempt ${e.attempt} failed)`),
    onError: (e) =>
      console.log(`✗ ${e.method} ${e.routeTemplate} attempt ${e.attempt}: ${e.error?.name}`),
  },
});

try {
  await client.ping();
  console.log("✓ done — every line above came from a telemetry hook");
} catch (err) {
  console.error("✗ ping failed:", err.name, err.message);
  process.exit(1);
}
