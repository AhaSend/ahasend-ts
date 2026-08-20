import { KNOWN_DELIVERY_ATTEMPT_CLASSIFICATIONS } from "../generated/webhook-types.js";
import {
  isKnownWebhookEventType as isGeneratedKnownWebhookEventType,
  validateKnownWebhookEvent,
} from "../generated/webhook-validators.js";
import type {
  AnyWebhookEvent as GeneratedAnyWebhookEvent,
  CanonicalWebhookEventType,
  components,
  DeprecatedWebhookEventType,
  KnownDeliveryAttemptClassification,
  UnknownWebhookEvent,
  WebhookEventType,
  webhookEvents,
} from "../generated/webhook-types.js";

export type {
  CanonicalWebhookEventType,
  DeprecatedWebhookEventType,
  KnownDeliveryAttemptClassification,
  WebhookEventType,
};

/**
 * Shape shared by the ten configured-webhook events. Routed messages are not
 * expressible here: they identify their source with `route_id` and carry no
 * `webhook_id`.
 */
export interface WebhookEnvelope<
  TType extends Exclude<WebhookEventType, "message.routing" | "route.message">,
  TData,
> {
  type: TType;
  timestamp: string;
  webhook_id: string;
  data: TData;
}

/**
 * Diagnostics from one delivery attempt, carried by `message.delivered`,
 * `message.bounced`, and `message.transient_error` when an SMTP attempt was
 * recorded.
 *
 * The wire schema also admits `null`, which means the same as the field being
 * absent; this alias is the object alone, so it can be written down in a
 * helper signature without dragging a null the caller already ruled out:
 *
 * ```ts
 * function record(attempt: WebhookDeliveryAttempt): void {
 *   // Codes, `classification`, and `command` are allow-listed. `response` and
 *   // `description` are free-form text that can carry the recipient, so they
 *   // do not belong in logs or metric labels.
 *   metrics.increment("bounce", { code: attempt.smtp_code });
 * }
 *
 * const attempt = event.data.delivery_attempt;
 * if (attempt) record(attempt);
 * ```
 *
 * To forward the field itself rather than a narrowed value, collapse the
 * `null` first — the field is `WebhookDeliveryAttempt | null | undefined`:
 *
 * ```ts
 * declare function store(attempt: WebhookDeliveryAttempt | undefined): void;
 *
 * store(event.data.delivery_attempt ?? undefined);
 * ```
 *
 * Named `WebhookDeliveryAttempt` rather than `DeliveryAttempt` because the
 * package root already exports an unrelated `DeliveryAttempt` — the per-hop
 * log on `Message.delivery_attempts`.
 */
export type WebhookDeliveryAttempt = NonNullable<components["schemas"]["DeliveryAttempt"]>;

export type MessageEventData = components["schemas"]["MessageWebhookData"];
export type MessageClickedEventData = components["schemas"]["MessageClickedWebhookData"];
export type SuppressionEventData = components["schemas"]["SuppressionWebhookData"];
export type DomainEventData = components["schemas"]["DomainWebhookData"];
/**
 * One MIME part from an inbound routed message.
 *
 * `attachments` mixes conventional attachments, inline parts, and
 * filename-bearing parts that carried no `Content-Disposition` header at all.
 *
 * **Split them by `content_id`, not by `disposition`.** The most common
 * embedded image — a `multipart/related` part that Gmail and Outlook send with
 * a `Content-ID` and no `Content-Disposition` — arrives as
 * `disposition: ""`, so a `disposition === "inline"` filter misfiles it as a
 * regular attachment:
 *
 * ```ts
 * const { attachments, html_body } = event.data;
 *
 * // Collect the cid: URLs the HTML actually references, decoded to match
 * // `content_id`. Pull them out rather than substring-testing each
 * // `content_id` against the HTML: `cid:logo` is a substring of
 * // `cid:logo-123`, so a bare `includes` drops an unreferenced `logo` part
 * // from both lists.
 * const referenced = new Set(
 *   [...html_body.matchAll(/cid:([^"'\s>)]+)/gu)].map((m) =>
 *     decodeURIComponent(m[1]!.replaceAll("+", " ")),
 *   ),
 * );
 *
 * const embedded = new Map(
 *   attachments.filter((a) => a.content_id).map((a) => [a.content_id, a]),
 * );
 * const files = attachments.filter((a) => !(a.content_id && referenced.has(a.content_id)));
 * ```
 *
 * `content_id` is `""`, not absent, when the part had no `Content-ID` — the
 * producer sends the key either way — so test it for truthiness rather than
 * for `undefined`. It is also not the raw header value: the angle brackets are
 * stripped and the remainder is percent-decoded, so `<a+b%40x>` arrives as
 * `a b@x` while `html_body` still carries `cid:a+b%40x`. That is why the
 * snippet decodes the URLs it lifts from the HTML instead of comparing them
 * raw — without it, an escaped Content-ID both fails to resolve and shows up
 * as a spurious downloadable file.
 *
 * `disposition` is required, matching the producer, but is typed as an open
 * string rather than the `attachment | inline | ""` the upstream spec declares.
 * That enum does not hold on the wire: the value is whatever token the sending
 * server wrote, lowercased and stripped of parameters. Verified against the
 * producer's MIME parser — an `application/octet-stream` part, or any
 * single-part binary body, carries its token through verbatim, so
 * `Content-Disposition: form-data` arrives as `"form-data"`. A receiver that
 * rejected it would answer 400, and 100 consecutive errors disable the
 * webhook. Treat an unrecognized value as an attachment.
 */
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

/**
 * Narrow a `classification` to the buckets the bounce classifier emits today.
 *
 * `classification` is a plain `string` on purpose: the set of buckets is open
 * and can grow, so a value outside this list is ordinary data, not a malformed
 * event. Nothing in this SDK rejects one, and neither should you — use this to
 * take a known branch and keep a fallback for everything else.
 *
 * Three cases, not two. An absent `classification` is not an unrecognized one:
 * successful deliveries carry no classification at all, and neither does a
 * failure the classifier declined to label. Folding those into the
 * unrecognized branch turns every delivery into a false alarm on exactly the
 * signal worth alerting on.
 *
 * ```ts
 * const { classification } = attempt;
 * if (classification === undefined) {
 *   // nothing was classified — normal on a delivery
 * } else if (isKnownDeliveryAttemptClassification(classification)) {
 *   route(classification);
 * } else {
 *   routeUnrecognized(classification); // a bucket added after this release
 * }
 * ```
 *
 * This takes a `string` rather than `string | undefined` so that absence has
 * to be handled deliberately rather than collapsing into "not known".
 *
 * TypeScript will not flag a `switch` over a plain `string` for missing a
 * case, so the fallback branch is yours to remember; this guard is what makes
 * one possible.
 */
export function isKnownDeliveryAttemptClassification(
  classification: string,
): classification is KnownDeliveryAttemptClassification {
  return (KNOWN_DELIVERY_ATTEMPT_CLASSIFICATIONS as readonly string[]).includes(classification);
}

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
