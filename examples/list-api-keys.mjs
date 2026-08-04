// Read-only test: lists API keys on the account.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/list-api-keys.mjs

import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();

try {
  const result = await client.apiKeys.list({ limit: 10 }).withResponse();
  console.log(
    `✓ found ${result.data.data.length} API key(s) status=${result.response.status} request-id=${result.requestId ?? "n/a"}`,
  );
} catch (err) {
  console.error("✗ list api-keys failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
