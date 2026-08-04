// Read-only test: fetches the bound account.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/get-account.mjs

import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();

try {
  const result = await client.accounts.get().withResponse();
  console.log(
    `✓ account id=${result.data.id} status=${result.response.status} request-id=${result.requestId ?? "n/a"}`,
  );
} catch (err) {
  console.error("✗ get account failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
