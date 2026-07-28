// Read-only test: lists API keys on the account.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/list-api-keys.mjs

import { AhaSendClient } from "../dist/index.js";

const client = AhaSendClient.fromEnv();

try {
  const res = await client.apiKeys.list({ limit: 10 });
  console.log(`✓ found ${res.data.length} API key(s)`);
  for (const k of res.data) {
    console.log(`  - ${k.label}  scopes=${k.scopes.length}  id=${k.id}`);
  }
} catch (err) {
  console.error("✗ list api-keys failed:", err.name, err.status ?? "", err.message);
  process.exit(1);
}
