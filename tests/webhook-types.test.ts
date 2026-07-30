import { describe, expectTypeOf, it } from "vitest";
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
  type SuppressionCreatedEvent,
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

type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

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

  it("declares body webhook IDs optional and route IDs required", () => {
    expectTypeOf<IsOptional<MessageDeliveredEvent, "webhook_id">>().toEqualTypeOf<true>();
    expectTypeOf<IsOptional<MessageClickedEvent, "webhook_id">>().toEqualTypeOf<true>();
    expectTypeOf<IsOptional<SuppressionCreatedEvent, "webhook_id">>().toEqualTypeOf<true>();
    expectTypeOf<IsOptional<DomainDNSErrorEvent, "webhook_id">>().toEqualTypeOf<true>();
    expectTypeOf<MessageDeliveredEvent["webhook_id"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<MessageClickedEvent["webhook_id"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SuppressionCreatedEvent["webhook_id"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DomainDNSErrorEvent["webhook_id"]>().toEqualTypeOf<string | undefined>();

    expectTypeOf<IsOptional<MessageRoutingEvent, "route_id">>().toEqualTypeOf<false>();
    expectTypeOf<MessageRoutingEvent["route_id"]>().toEqualTypeOf<string>();
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
