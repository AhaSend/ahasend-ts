// Read-only test: lists suppressions on the account.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/list-suppressions.mjs

import { AhaSendClient } from "../dist/index.js";

const client = AhaSendClient.fromEnv();

try {
  const res = await client.suppressions.list({ limit: 10 });
  console.log(`✓ found ${res.data.length} suppression(s)`);
  for (const s of res.data) {
    console.log(`  - ${s.email}  reason=${s.reason ?? "n/a"}  expires=${s.expires_at}`);
  }
} catch (err) {
  console.error("✗ list suppressions failed:", err.name, err.status ?? "", err.message);
  if (err.body) console.error("body:", err.body);
  process.exit(1);
}
