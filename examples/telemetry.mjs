// Telemetry hooks: observe every request, response, retry, and error
// the SDK makes. Wire these to your logger / metrics / tracing system.
// Hooks run asynchronously; throws and returned-promise rejections are
// swallowed, so telemetry can never break or delay a request.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/telemetry.mjs

import { AhaSendClient, isAhaSendError, optionsFromEnv } from "@ahasend/sdk";

const client = new AhaSendClient({
  ...optionsFromEnv(),
  accountId: process.env.AHASEND_ACCOUNT_ID,
  hooks: {
    onRequest: () => console.log("→ request started"),
    onResponse: (e) =>
      console.log("← response received", { status: e.status, requestId: e.requestId }),
    onRetry: (e) => console.log("↻ retry scheduled", { status: e.status, requestId: e.requestId }),
    onError: (e) =>
      console.log("✗ request failed", {
        errorCode: isAhaSendError(e.error) ? e.error.code : "unknown",
        status: e.status,
        requestId: e.requestId,
      }),
  },
});

try {
  await client.ping();
  console.log("✓ done — every line above came from a telemetry hook");
} catch (err) {
  console.error("✗ ping failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
