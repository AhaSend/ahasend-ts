import {
  isKnownWebhookEventType as isGeneratedKnownWebhookEventType,
  validateKnownWebhookEvent,
} from "../generated/webhook-validators.js";
import type {
  AnyWebhookEvent as GeneratedAnyWebhookEvent,
  CanonicalWebhookEventType,
  components,
  DeprecatedWebhookEventType,
  UnknownWebhookEvent,
  WebhookEventType,
  webhookEvents,
} from "../generated/webhook-types.js";

export type { CanonicalWebhookEventType, DeprecatedWebhookEventType, WebhookEventType };

export interface WebhookEnvelope<TType extends WebhookEventType, TData> {
  type: TType;
  timestamp: string;
  webhook_id?: string;
  data: TData;
}

export type MessageEventData = components["schemas"]["MessageWebhookData"];
export type MessageClickedEventData = components["schemas"]["MessageClickedWebhookData"];
export type SuppressionEventData = components["schemas"]["SuppressionWebhookData"];
export type DomainEventData = components["schemas"]["DomainWebhookData"];
export type RouteAttachment = components["schemas"]["RouteAttachment"];
export type RouteEventData = components["schemas"]["RouteWebhookData"];

export type MessageReceptionEvent = webhookEvents["message.reception"];
export type MessageDeliveredEvent = webhookEvents["message.delivered"];
export type MessageTransientErrorEvent = webhookEvents["message.transient_error"];
export type MessageFailedEvent = webhookEvents["message.failed"];
export type MessageBouncedEvent = webhookEvents["message.bounced"];
export type MessageSuppressedEvent = webhookEvents["message.suppressed"];
export type MessageOpenedEvent = webhookEvents["message.opened"];
export type MessageClickedEvent = webhookEvents["message.clicked"];
export type SuppressionCreatedEvent = webhookEvents["suppression.created"];
export type DomainDNSErrorEvent = webhookEvents["domain.dns_error"];

/** Canonical routing event returned by `WebhookVerifier.parse()`. */
export type MessageRoutingEvent = Omit<webhookEvents["message.routing"], "type"> & {
  type: "message.routing";
};

/** @deprecated A routing event is returned as `message.routing`; `route.message` is input-only. */
export type RouteMessageEvent = MessageRoutingEvent;

/** Strict discriminated union over every canonical event returned by this SDK. */
export type WebhookEvent =
  | MessageReceptionEvent
  | MessageDeliveredEvent
  | MessageTransientErrorEvent
  | MessageFailedEvent
  | MessageBouncedEvent
  | MessageSuppressedEvent
  | MessageOpenedEvent
  | MessageClickedEvent
  | SuppressionCreatedEvent
  | DomainDNSErrorEvent
  | MessageRoutingEvent;

export type { UnknownWebhookEvent };
/**
 * Any event this SDK can hand back: one of the 11 known events, or an
 * {@link UnknownWebhookEvent} for a type added after this release.
 *
 * Because `AnyWebhookEvent` includes a forward-compatible
 * `UnknownWebhookEvent` whose `type` is a plain `string`, a bare
 * `switch (event.type)` does **not** narrow `event.data` — every branch still
 * includes the unknown member, so `data` stays `unknown`. Narrow with
 * {@link isKnownWebhookEvent} first:
 *
 * ```ts
 * if (!isKnownWebhookEvent(event)) return; // future event type
 * switch (event.type) {
 *   case "message.bounced":
 *     await suppress(event.data.recipient); // fully typed
 *     break;
 * }
 * ```
 */
export type AnyWebhookEvent = WebhookEvent | UnknownWebhookEvent;

export function isKnownWebhookEventType(type: string): type is WebhookEventType {
  return isGeneratedKnownWebhookEventType(type);
}

/**
 * Validate and narrow an event to the generated known-event schema. This guard
 * intentionally checks the complete payload instead of trusting its `type`.
 */
export function isKnownWebhookEvent(event: GeneratedAnyWebhookEvent): event is WebhookEvent {
  return event.type !== "route.message" && validateKnownWebhookEvent(event);
}
