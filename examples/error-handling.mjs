// Typed error handling: every failure mode maps to a distinct class
// so you can branch without parsing strings or status codes.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/error-handling.mjs

import { AhaSendClient, AhaSendNotFoundError, isAhaSendError } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();

// Deliberately fetch a message that doesn't exist.
try {
  await client.messages.get("00000000-0000-0000-0000-000000000000");
  console.log("unexpected: message existed");
} catch (err) {
  if (err instanceof AhaSendNotFoundError) {
    console.log(
      `✓ caught AhaSendNotFoundError status=${err.status} code=${err.code} request-id=${err.requestId ?? "n/a"}`,
    );
  } else {
    console.error("unexpected SDK outcome", {
      errorCode: isAhaSendError(err) ? err.code : "unknown",
    });
    process.exitCode = 1;
  }
}
