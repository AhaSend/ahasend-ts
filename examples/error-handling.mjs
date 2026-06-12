// Typed error handling: every failure mode maps to a distinct class
// so you can branch without parsing strings or status codes.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/error-handling.mjs

import {
  AhaSendClient,
  AhaSendAuthenticationError,
  AhaSendNotFoundError,
  AhaSendRateLimitError,
  AhaSendConnectionError,
  AhaSendAPIError,
} from "../dist/index.js";

const client = AhaSendClient.fromEnv();

// Deliberately fetch a message that doesn't exist.
try {
  await client.messages.get("00000000-0000-0000-0000-000000000000");
  console.log("unexpected: message existed");
} catch (err) {
  if (err instanceof AhaSendNotFoundError) {
    console.log(`✓ caught AhaSendNotFoundError (HTTP ${err.status})`);
    console.log(`  request-id: ${err.requestId ?? "n/a"}`);
  } else if (err instanceof AhaSendAuthenticationError) {
    console.log("✗ bad API key — check AHASEND_API_KEY");
    process.exit(1);
  } else if (err instanceof AhaSendRateLimitError) {
    console.log(`rate limited — server says retry after ${err.retryAfterSeconds}s`);
  } else if (err instanceof AhaSendConnectionError) {
    console.log("network problem:", err.message);
  } else if (err instanceof AhaSendAPIError) {
    console.log(`API error ${err.status}:`, err.body);
  } else {
    throw err; // not an SDK error — rethrow
  }
}
