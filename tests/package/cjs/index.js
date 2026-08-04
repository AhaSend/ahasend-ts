const assert = require("node:assert/strict");
const { inspect } = require("node:util");
const {
  AhaSendAPIError,
  AhaSendClient,
  AhaSendConfigurationError,
  AhaSendError,
  AhaSendIdempotencyConflictError,
  isAhaSendError,
} = require("@ahasend/sdk");
const { AhaSendWebhookVerificationError, WebhookVerifier } = require("@ahasend/sdk/webhooks");

const verificationError = new AhaSendWebhookVerificationError("signature_mismatch");
assert.ok(verificationError instanceof AhaSendError);
assert.equal(isAhaSendError(verificationError), true);

assert.throws(
  () => new WebhookVerifier(""),
  (error) =>
    error instanceof AhaSendConfigurationError && error.constructor === AhaSendConfigurationError,
);

let requestCount = 0;
const accountBody = {
  object: "account",
  id: "11111111-1111-4111-8111-111111111111",
  parent_account_id: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  name: "Package fixture",
  website: "https://example.com",
  about: "CommonJS package response fixture",
  track_opens: true,
  track_clicks: true,
  reject_bad_recipients: true,
  reject_mistyped_recipients: true,
  message_metadata_retention: 30,
  message_data_retention: 7,
  owner_id: "22222222-2222-4222-8222-222222222222",
};
const client = new AhaSendClient({
  apiKey: "aha-sk-test",
  accountId: "11111111-1111-4111-8111-111111111111",
  baseUrl: "https://api.test",
  fetch: async (input, init) => {
    requestCount += 1;
    assert.equal(new URL(input).pathname, "/v2/accounts/11111111-1111-4111-8111-111111111111");
    assert.equal(init.method, "GET");
    return Response.json(accountBody, { headers: { "x-request-id": "req_cjs_account" } });
  },
});

assert.throws(
  () => client.suppressions.wipe({ domian: "example.com" }),
  /Unknown query parameter "domian"/,
);
assert.throws(
  () => client.suppressions.delete({ domain: "example.com" }),
  /Missing required query parameter "email"/,
);
assert.throws(
  () => client.messages.list({ after: "next", before: "previous" }),
  /must not include both "after" and "before"/,
);
assert.throws(() => client.apiKeys.get("not-a-uuid"), /expected uuid/);
assert.throws(() => client.domains.get("invalid_hostname.example"), /expected hostname/);
assert.throws(
  () => client.subAccounts.apiKeys.delete("22222222-2222-4222-8222-222222222222", ".."),
  /path segments must not be empty/,
);
assert.equal(requestCount, 0);

async function verifyInstalledPackageBehavior() {
  const [esmRoot, esmWebhooks] = await Promise.all([
    import("@ahasend/sdk"),
    import("@ahasend/sdk/webhooks"),
  ]);
  const esmVerificationError = new esmWebhooks.AhaSendWebhookVerificationError(
    "signature_mismatch",
  );

  assert.notEqual(esmRoot.AhaSendError, AhaSendError);
  assert.equal(esmVerificationError instanceof AhaSendError, false);
  assert.equal(isAhaSendError(esmVerificationError), true);
  assert.equal(AhaSendError.is(esmVerificationError), true);
  assert.equal(verificationError instanceof esmRoot.AhaSendError, false);
  assert.equal(esmRoot.isAhaSendError(verificationError), true);
  assert.equal(esmRoot.AhaSendError.is(verificationError), true);

  const cjsApiError = new AhaSendAPIError({
    status: 418,
    message: "CommonJS API error",
    body: null,
  });
  const esmApiError = new esmRoot.AhaSendAPIError({
    status: 418,
    message: "ESM API error",
    body: null,
  });

  assert.equal(esmApiError instanceof AhaSendAPIError, false);
  assert.equal(AhaSendError.is(esmApiError), true);
  assert.equal(AhaSendAPIError.is(esmApiError), true);
  assert.equal(cjsApiError instanceof esmRoot.AhaSendAPIError, false);
  assert.equal(esmRoot.AhaSendError.is(cjsApiError), true);
  assert.equal(esmRoot.AhaSendAPIError.is(cjsApiError), true);
  assert.equal(AhaSendAPIError.is(esmVerificationError), false);
  assert.equal(esmRoot.AhaSendAPIError.is(verificationError), false);

  const accountRequest = client.accounts.get();
  const account = await accountRequest;
  const envelope = await accountRequest.withResponse();

  assert.deepEqual(account, accountBody);
  assert.equal(envelope.data, account);
  assert.equal(envelope.response.status, 200);
  assert.equal(envelope.requestId, "req_cjs_account");
  assert.equal(requestCount, 1);

  const conflictKeys = [];
  const conflictClient = new AhaSendClient({
    apiKey: "aha-sk-test",
    accountId: "11111111-1111-4111-8111-111111111111",
    baseUrl: "https://api.test",
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      strategy: "constant",
      jitter: false,
    },
    fetch: async (_input, init) => {
      conflictKeys.push(new Headers(init.headers).get("idempotency-key"));
      return Response.json(
        { message: "idempotent request is still processing" },
        {
          status: 409,
          headers: { "idempotent-replayed": "false", "retry-after": "1" },
        },
      );
    },
  });

  let conflictError;
  try {
    await conflictClient.domains.create({ domain: "conflict.example.com" });
  } catch (error) {
    conflictError = error;
  }

  assert.ok(conflictError instanceof AhaSendIdempotencyConflictError);
  const recoveryKey = conflictKeys[0];
  assert.equal(typeof recoveryKey, "string");
  assert.ok(recoveryKey.length > 0);
  assert.deepEqual(conflictKeys, [recoveryKey, recoveryKey]);
  assert.equal(conflictError.idempotencyKey, recoveryKey);
  const recoveryKeyDescriptor = Object.getOwnPropertyDescriptor(conflictError, "idempotencyKey");
  assert.equal(recoveryKeyDescriptor.enumerable, false);
  assert.equal(recoveryKeyDescriptor.value, recoveryKey);
  assert.equal(recoveryKeyDescriptor.writable, false);
  assert.equal(Object.keys(conflictError).includes("idempotencyKey"), false);

  for (const diagnostic of [
    JSON.stringify(conflictError),
    inspect(conflictError),
    inspect(conflictError, { showHidden: true }),
  ]) {
    assert.equal(diagnostic.includes(recoveryKey), false);
    assert.equal(diagnostic.includes("idempotencyKey"), false);
  }
}

verifyInstalledPackageBehavior().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
