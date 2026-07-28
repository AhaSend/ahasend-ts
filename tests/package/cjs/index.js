const assert = require("node:assert/strict");
const { AhaSendConfigurationError, AhaSendError, isAhaSendError } = require("@ahasend/sdk");
const { AhaSendWebhookVerificationError, WebhookVerifier } = require("@ahasend/sdk/webhooks");

const verificationError = new AhaSendWebhookVerificationError("signature_mismatch");
assert.ok(verificationError instanceof AhaSendError);
assert.equal(isAhaSendError(verificationError), true);

assert.throws(
  () => new WebhookVerifier(""),
  (error) =>
    error instanceof AhaSendConfigurationError && error.constructor === AhaSendConfigurationError,
);
