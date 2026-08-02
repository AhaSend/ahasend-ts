// Guarded bootstrap: create a child account and its first message-send key.
//
// The one-time secret is written to a new mode-0600 file and never printed.
// Move it into your secret manager, then securely remove the file.
//
// Requires: AHASEND_API_KEY, AHASEND_ACCOUNT_ID, AHASEND_SUBACCOUNT_NAME,
// AHASEND_SUBACCOUNT_WEBSITE, AHASEND_CHILD_SECRET_FILE, and the explicit
// AHASEND_ALLOW_MUTATIONS=1 acknowledgement.

import { writeFile } from "node:fs/promises";
import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

if (process.env.AHASEND_ALLOW_MUTATIONS !== "1") {
  throw new Error("Refusing mutation; set AHASEND_ALLOW_MUTATIONS=1 after reviewing the script.");
}

const name = process.env.AHASEND_SUBACCOUNT_NAME;
const website = process.env.AHASEND_SUBACCOUNT_WEBSITE;
const secretFile = process.env.AHASEND_CHILD_SECRET_FILE;
if (!name || !website || !secretFile) {
  throw new Error(
    "Set AHASEND_SUBACCOUNT_NAME, AHASEND_SUBACCOUNT_WEBSITE, and AHASEND_CHILD_SECRET_FILE.",
  );
}

const client = AhaSendClient.fromEnv();

try {
  const subAccount = await client.subAccounts.create({ name, website });
  const key = await client.subAccounts.apiKeys.create(subAccount.id, {
    label: "Bootstrap message sender",
    scopes: ["messages:send:all"],
  });

  await writeFile(secretFile, key.secret_key, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(`✓ created child account id=${subAccount.id}; stored its one-time key`);
} catch (err) {
  console.error("✗ bootstrap failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
