// Guarded mutation: replace an API key's source IP allow-list.
//
// Requires: AHASEND_API_KEY, AHASEND_ACCOUNT_ID, AHASEND_API_KEY_ID,
// AHASEND_IP_ALLOW_LIST (comma-separated CIDRs/addresses), and the explicit
// AHASEND_ALLOW_MUTATIONS=1 acknowledgement.
//
// Updating the credential currently making this request to exclude its source
// IP is rejected by the API with HTTP 409.

import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

if (process.env.AHASEND_ALLOW_MUTATIONS !== "1") {
  throw new Error("Refusing mutation; set AHASEND_ALLOW_MUTATIONS=1 after reviewing the script.");
}

const keyId = process.env.AHASEND_API_KEY_ID;
const rawAllowList = process.env.AHASEND_IP_ALLOW_LIST;
if (!keyId || !rawAllowList) {
  throw new Error("Set AHASEND_API_KEY_ID and AHASEND_IP_ALLOW_LIST.");
}

const ipAllowList = rawAllowList
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
if (ipAllowList.length === 0) {
  throw new Error("AHASEND_IP_ALLOW_LIST must contain at least one address or CIDR.");
}

const client = AhaSendClient.fromEnv();

try {
  const updated = await client.apiKeys.update(keyId, { ip_allow_list: ipAllowList });
  console.log(`✓ updated IP allow-list with ${updated.ip_allow_list.length} canonical entries`);
} catch (err) {
  console.error("✗ IP allow-list update failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
