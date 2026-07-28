import { describe, expectTypeOf, it } from "vitest";
import {
  AhaSendWebhookVerificationError,
  WebhookVerifier,
  isKnownWebhookEvent,
  type AnyWebhookEvent,
  type MessageDeliveredEvent,
  type MessageRoutingEvent,
  type WebhookEvent,
  type WebhookVerificationReason,
} from "../src/webhooks/index.js";

type ExpectedVerificationReason =
  | "missing_webhook_id"
  | "missing_webhook_timestamp"
  | "missing_webhook_signature"
  | "invalid_timestamp"
  | "timestamp_outside_tolerance"
  | "signature_mismatch"
  | "invalid_json"
  | "invalid_payload"
  | "invalid_event"
  | "body_too_large";

describe("webhook public types", () => {
  it("returns AnyWebhookEvent and narrows validated known payloads", () => {
    const verifier = new WebhookVerifier("test-secret");
    expectTypeOf(verifier.parse).returns.toEqualTypeOf<AnyWebhookEvent>();

    function assertNarrowing(event: AnyWebhookEvent): void {
      if (isKnownWebhookEvent(event)) {
        expectTypeOf(event).toEqualTypeOf<WebhookEvent>();
        if (event.type === "message.delivered") {
          expectTypeOf(event).toEqualTypeOf<MessageDeliveredEvent>();
          expectTypeOf(event.data.recipient).toEqualTypeOf<string>();
        }
        if (event.type === "message.routing") {
          expectTypeOf(event).toEqualTypeOf<MessageRoutingEvent>();
          expectTypeOf(event.data.attachments).toEqualTypeOf<
            | Array<{ filename: string; content_type: string; content_id?: string; data: string }>
            | undefined
          >();
        }
      }
    }
    expectTypeOf(assertNarrowing).parameter(0).toEqualTypeOf<AnyWebhookEvent>();
  });

  it("exposes the exact closed verification-reason union", () => {
    expectTypeOf<WebhookVerificationReason>().toEqualTypeOf<ExpectedVerificationReason>();
    const error = new AhaSendWebhookVerificationError("invalid_event");
    expectTypeOf(error.reason).toEqualTypeOf<WebhookVerificationReason>();

    if (false) {
      // @ts-expect-error verification reasons are closed to documented failures
      new AhaSendWebhookVerificationError("caller_defined_reason");
    }
  });

  it("does not permit callers to select a parse result generic", () => {
    const verifier = new WebhookVerifier("test-secret");
    if (false) {
      // @ts-expect-error parse validates the runtime event and owns its result type
      verifier.parse<MessageDeliveredEvent>({}, "{}");
    }
  });
});
