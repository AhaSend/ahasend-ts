import { describe, expect, expectTypeOf, it } from "vitest";
import * as publicWebhooks from "../src/webhooks/index.js";
import {
  AhaSendWebhookVerificationError,
  WebhookVerifier,
  isKnownWebhookEvent,
  type AnyWebhookEvent,
  type DomainDNSErrorEvent,
  type MessageClickedEvent,
  type MessageDeliveredEvent,
  type MessageOpenedEvent,
  type MessageRoutingEvent,
  type RouteAttachment,
  type SuppressionCreatedEvent,
  type WebhookEvent,
  type WebhookVerifierOptions,
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

type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

describe("webhook public types", () => {
  it("exposes only tolerance configuration and no test-clock or signing facilities", () => {
    expectTypeOf<WebhookVerifierOptions>().toEqualTypeOf<{
      toleranceSeconds?: number;
    }>();
    expect(publicWebhooks).not.toHaveProperty("createWebhookVerifierWithClock");
    expect(publicWebhooks).not.toHaveProperty("sign");

    if (false) {
      // @ts-expect-error the public verifier clock is always Date.now
      new WebhookVerifier("test-secret", { nowMs: () => 0 });
      // @ts-expect-error the source-test clock factory is not a public entry-point export
      publicWebhooks.createWebhookVerifierWithClock;
      // @ts-expect-error webhook signing is verifier-internal
      publicWebhooks.sign;
    }
  });

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
            Array<{
              filename: string;
              content_type: string;
              content_id: string;
              disposition: string;
              data: string;
            }>
          >();
        }
      }
    }
    expectTypeOf(assertNarrowing).parameter(0).toEqualTypeOf<AnyWebhookEvent>();
  });

  it("declares body webhook IDs and route IDs required", () => {
    // Every producer declares `WebhookID uuid.UUID` with no omitempty, so the
    // key is on the wire for all four envelopes. These were optional only
    // because the fixture they were aligned against omitted it, and that
    // fixture turned out to be generated rather than captured.
    expectTypeOf<IsOptional<MessageDeliveredEvent, "webhook_id">>().toEqualTypeOf<false>();
    expectTypeOf<IsOptional<MessageClickedEvent, "webhook_id">>().toEqualTypeOf<false>();
    expectTypeOf<IsOptional<SuppressionCreatedEvent, "webhook_id">>().toEqualTypeOf<false>();
    expectTypeOf<IsOptional<DomainDNSErrorEvent, "webhook_id">>().toEqualTypeOf<false>();
    expectTypeOf<MessageDeliveredEvent["webhook_id"]>().toEqualTypeOf<string>();
    expectTypeOf<MessageClickedEvent["webhook_id"]>().toEqualTypeOf<string>();
    expectTypeOf<SuppressionCreatedEvent["webhook_id"]>().toEqualTypeOf<string>();
    expectTypeOf<DomainDNSErrorEvent["webhook_id"]>().toEqualTypeOf<string>();

    expectTypeOf<IsOptional<MessageRoutingEvent, "route_id">>().toEqualTypeOf<false>();
    expectTypeOf<MessageRoutingEvent["route_id"]>().toEqualTypeOf<string>();
  });

  it("declares route attachment disposition as a required open string", () => {
    // Required because the producer emits it unconditionally, but NOT
    // `"attachment" | "inline" | ""` as the upstream spec declares. The value
    // is parsed from an inbound message's Content-Disposition header, and an
    // application/octet-stream part carries any RFC 2183 extension token
    // through verbatim, so a literal union would tell consumers a `switch` is
    // exhaustive when it is not.
    expectTypeOf<IsOptional<RouteAttachment, "disposition">>().toEqualTypeOf<false>();
    expectTypeOf<RouteAttachment["disposition"]>().toEqualTypeOf<string>();
  });

  it("declares opened and clicked is_bot fields as optional booleans", () => {
    expectTypeOf<IsOptional<MessageOpenedEvent["data"], "is_bot">>().toEqualTypeOf<true>();
    expectTypeOf<MessageOpenedEvent["data"]["is_bot"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<{
      account_id: string;
      event: "on_opened";
      from: string;
      recipient: string;
      subject: string;
      message_id_header: string;
      id: string;
    }>().toExtend<MessageOpenedEvent["data"]>();
    expectTypeOf<{
      account_id: string;
      event: "on_opened";
      from: string;
      recipient: string;
      subject: string;
      message_id_header: string;
      id: string;
      is_bot: true;
    }>().toExtend<MessageOpenedEvent["data"]>();

    expectTypeOf<IsOptional<MessageClickedEvent["data"], "is_bot">>().toEqualTypeOf<true>();
    expectTypeOf<MessageClickedEvent["data"]["is_bot"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<{
      account_id: string;
      event: "on_clicked";
      from: string;
      recipient: string;
      subject: string;
      message_id_header: string;
      url: string;
      user_agent: string;
      ip: string;
      id: string;
    }>().toExtend<MessageClickedEvent["data"]>();
    expectTypeOf<{
      account_id: string;
      event: "on_clicked";
      from: string;
      recipient: string;
      subject: string;
      message_id_header: string;
      url: string;
      user_agent: string;
      ip: string;
      id: string;
      is_bot: false;
    }>().toExtend<MessageClickedEvent["data"]>();
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
