import assert from "node:assert/strict";
import { AhaSendConfigurationError, AhaSendError, isAhaSendError } from "@ahasend/sdk";
import { AhaSendWebhookVerificationError, WebhookVerifier } from "@ahasend/sdk/webhooks";

const verificationError = new AhaSendWebhookVerificationError("signature_mismatch");
assert.ok(verificationError instanceof AhaSendError);
assert.equal(isAhaSendError(verificationError), true);

assert.throws(
  () => new WebhookVerifier(""),
  (error) =>
    error instanceof AhaSendConfigurationError && error.constructor === AhaSendConfigurationError,
);
