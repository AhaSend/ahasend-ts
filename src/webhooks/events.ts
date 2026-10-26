import {
  KNOWN_COMPLAINT_REPORTERS,
  KNOWN_CONTACT_CHANGED_FIELDS,
  KNOWN_DELIVERY_ATTEMPT_CLASSIFICATIONS,
  KNOWN_WEBHOOK_ORIGINS,
} from "../generated/webhook-types.js";
import {
  isKnownWebhookEventType as isGeneratedKnownWebhookEventType,
  validateKnownWebhookEvent,
} from "../generated/webhook-validators.js";
import type {
  AnyWebhookEvent as GeneratedAnyWebhookEvent,
  CanonicalWebhookEventType,
  components,
  DeprecatedWebhookEventType,
  KnownComplaintReporter as GeneratedKnownComplaintReporter,
  KnownContactChangedField as GeneratedKnownContactChangedField,
  KnownDeliveryAttemptClassification,
  KnownWebhookOrigin as GeneratedKnownWebhookOrigin,
  UnknownWebhookEvent,
  WebhookEventType,
  WebhookJSONValue as GeneratedWebhookJSONValue,
  webhookEvents,
} from "../generated/webhook-types.js";

export type {
  CanonicalWebhookEventType,
  DeprecatedWebhookEventType,
  KnownDeliveryAttemptClassification,
  WebhookEventType,
};

/**
 * The complaint `reporter` values AhaSend sends today: the feedback loops it
 * reads. A delivery can carry another value; narrow with
 * {@link isKnownComplaintReporter}.
 */
export type KnownComplaintReporter = GeneratedKnownComplaintReporter;

/**
 * The `contact.updated` `changed_fields` values AhaSend sends today. A
 * contact field added later can appear too; narrow with
 * {@link isKnownContactChangedField}.
 */
export type KnownContactChangedField = GeneratedKnownContactChangedField;

/**
 * The `origin` values AhaSend sends today: `recipient`, `api`, `dashboard`,
 * and `system`. A delivery can carry another value; narrow with
 * {@link isKnownWebhookOrigin}.
 */
export type KnownWebhookOrigin = GeneratedKnownWebhookOrigin;

/**
 * Any JSON value: the value of a contact attribute. Values can be `null`,
 * booleans, numbers, strings, arrays, or nested objects.
 */
export type WebhookJSONValue = GeneratedWebhookJSONValue;

/**
 * Shape shared by the configured-webhook events. Routed messages are not
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

/**
 * Data of every message event except `message.clicked`.
 *
 * The events of a campaign message also carry `campaign_id`, `list_id`, and
 * `segment_id`. `list_id` is `null` when the campaign did not reach the
 * recipient through a list, and `segment_id` is `null` when it did not reach
 * the recipient through a segment. Treat `null` and an absent field the same:
 * `event.data.list_id ?? undefined`.
 *
 * `unsubscribe` is present only on `message.unsubscribed`, and `complaint`
 * only on `message.complained`.
 */
export type MessageEventData = components["schemas"]["MessageWebhookData"];
/**
 * Data of `message.clicked`. Like {@link MessageEventData}, a campaign message
 * also carries `campaign_id`, and `list_id` and `segment_id`, which can be
 * `null`.
 */
export type MessageClickedEventData = components["schemas"]["MessageClickedWebhookData"];
/**
 * Data of `suppression.created` and `suppression.deleted`: the suppression as
 * it was right after the change, or right before the delete. `origin` says
 * who made the change.
 */
export type SuppressionEventData = components["schemas"]["SuppressionWebhookData"];
export type DomainEventData = components["schemas"]["DomainWebhookData"];

/**
 * How the recipient unsubscribed, on `message.unsubscribed`: `one_click` for a
 * one-click unsubscribe from the email client (RFC 8058), and `link` for any
 * other unsubscribe.
 */
export type WebhookUnsubscribe = components["schemas"]["WebhookUnsubscribe"];

/**
 * A spam complaint report, on `message.complained` and `contact.complained`.
 *
 * `feedback_type` is the ARF `Feedback-Type` in lower case, `abuse` or
 * `fraud`. `reporter` is the feedback loop that sent the report. It is a plain
 * `string` because AhaSend can add feedback loops at any time; narrow it with
 * {@link isKnownComplaintReporter} and keep a fallback for other values.
 */
export type WebhookComplaint = components["schemas"]["WebhookComplaint"];

/**
 * Who made the change that a contact or suppression event reports:
 *
 * - `recipient`: the contact or recipient, through an unsubscribe link, a
 *   one-click unsubscribe, or a spam complaint
 * - `api`: you, through the AhaSend API
 * - `dashboard`: you, through the AhaSend dashboard
 * - `system`: AhaSend, for example after a bounce, an expired message or an
 *   email validation, or when AhaSend support makes the change
 *
 * Message events and `domain.dns_error` have no origin.
 *
 * It is a plain `string` because AhaSend can add an origin, and a webhook whose
 * origin filter is `null` gets its events. Narrow it with
 * {@link isKnownWebhookOrigin} and keep a fallback for other values.
 */
export type WebhookOrigin = components["schemas"]["WebhookOrigin"];

/**
 * A contact, in the shape that the Contacts API returns.
 *
 * `attributes` values are any JSON value ({@link WebhookJSONValue}).
 * `unsubscribed` is the contact's unsubscribe from all lists.
 *
 * Named `WebhookContact` rather than `Contact` because the package root
 * already exports the Contacts API's `Contact`.
 */
export type WebhookContact = components["schemas"]["Contact"];

/** The list of a membership: its `id` and `name`. */
export type WebhookList = components["schemas"]["WebhookList"];

/**
 * One contact's membership of one list, in the shape that the Lists API
 * returns, without the embedded `contact` and `list`. It has no id of its
 * own: the `(list_id, contact_id)` pair addresses it.
 */
export type WebhookListContact = components["schemas"]["WebhookListContact"];

/**
 * Data of `contact.created` and `contact.deleted`, and the base of the other
 * contact event data.
 *
 * `contact` is the contact as it was right after the change, or right before
 * the delete for `contact.deleted`. `campaign_id` is the campaign whose email
 * caused the change, when a recipient unsubscribed from a campaign email or
 * reported it as spam, and `segment_id` the segment that campaign was sent to.
 * Both are absent otherwise, never `null`.
 */
export type ContactEventData = components["schemas"]["ContactWebhookData"];

/**
 * Data of `contact.updated`.
 *
 * `changed_fields` lists the `contact` fields whose values changed; a change
 * to any key of `attributes` lists `attributes`. The set is open, so a new
 * contact field can appear: narrow each entry with
 * {@link isKnownContactChangedField}.
 *
 * A handler that writes to the AhaSend API on every `contact.updated` gets its
 * own write back as a new event with `origin: "api"`. Skip the write when the
 * contact already has the values it wants.
 */
export type ContactUpdatedEventData = components["schemas"]["ContactUpdatedWebhookData"];

/**
 * Data of the contact events that can be about a list membership:
 * `contact.added_to_list`, `contact.removed_from_list`, `contact.subscribed`,
 * `contact.unsubscribed`, and `contact.complained`.
 *
 * `list` and `list_contact` are `null` when the event is about the contact's
 * unsubscribe from all lists rather than one membership: `contact.unsubscribed`
 * when it is set, `contact.subscribed` when it is cleared, and
 * `contact.complained` for a complaint about a campaign sent to a segment.
 * Check `list` before you read a membership, and read the event type to tell
 * a set unsubscribe from a cleared one:
 *
 * ```ts
 * const { list, list_contact, contact } = event.data;
 * if (list === null || list_contact === null) {
 *   // contact.subscribed clears the unsubscribe from all lists; the others set it.
 *   await setUnsubscribedEverywhere(contact.id, event.type !== "contact.subscribed");
 * } else {
 *   await setStatus(list.id, list_contact.contact_id, list_contact.subscription_status);
 * }
 * ```
 *
 * `previous_subscription_status` is the membership's status before the
 * change, present only on `contact.subscribed`, `contact.unsubscribed`, and
 * `contact.complained` when `list` is not `null`. `complaint` is present only
 * on `contact.complained`.
 */
export type ContactListEventData = components["schemas"]["ContactListWebhookData"];
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
 * rejected it would answer 400, and when more than 100 attempts in a row fail,
 * retries included, AhaSend disables the route. Treat an unrecognized value as
 * an attachment.
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
/**
 * Sent when the recipient unsubscribes through the unsubscribe link of a
 * campaign email or the email client's one-click unsubscribe. It is sent for
 * every unsubscribe request that AhaSend accepts, so drop repeats by `type`
 * and `data.id`.
 */
export type MessageUnsubscribedEvent = webhookEvents["message.unsubscribed"];
/**
 * Sent when the recipient's mailbox provider reports a campaign email as spam
 * through its feedback loop. Drop repeats by `type` and `data.id`.
 */
export type MessageComplainedEvent = webhookEvents["message.complained"];
export type SuppressionCreatedEvent = webhookEvents["suppression.created"];
/** Sent when a suppression is deleted; `data` is the suppression as it was right before. */
export type SuppressionDeletedEvent = webhookEvents["suppression.deleted"];
export type DomainDNSErrorEvent = webhookEvents["domain.dns_error"];
/** Sent when a contact is created through the API or the dashboard. */
export type ContactCreatedEvent = webhookEvents["contact.created"];
/** Sent when a field of a contact changes; `data.changed_fields` lists which. */
export type ContactUpdatedEvent = webhookEvents["contact.updated"];
/** Sent when a contact is deleted, with all its list memberships. */
export type ContactDeletedEvent = webhookEvents["contact.deleted"];
/** Sent when a contact is added to a list, with any subscription status. */
export type ContactAddedToListEvent = webhookEvents["contact.added_to_list"];
/** Sent when a contact is removed from a list. */
export type ContactRemovedFromListEvent = webhookEvents["contact.removed_from_list"];
/**
 * Sent when a membership becomes `confirmed`, or when the contact's
 * unsubscribe from all lists is cleared (`list` is then `null`).
 */
export type ContactSubscribedEvent = webhookEvents["contact.subscribed"];
/**
 * Sent when a membership becomes `unsubscribed`, or when the contact's
 * unsubscribe from all lists is set (`list` is then `null`).
 */
export type ContactUnsubscribedEvent = webhookEvents["contact.unsubscribed"];
/**
 * Sent when a membership becomes `complained`, or when a complaint about a
 * campaign sent to a segment is recorded (`list` is then `null`).
 */
export type ContactComplainedEvent = webhookEvents["contact.complained"];

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
  | MessageUnsubscribedEvent
  | MessageComplainedEvent
  | SuppressionCreatedEvent
  | SuppressionDeletedEvent
  | DomainDNSErrorEvent
  | ContactCreatedEvent
  | ContactUpdatedEvent
  | ContactDeletedEvent
  | ContactAddedToListEvent
  | ContactRemovedFromListEvent
  | ContactSubscribedEvent
  | ContactUnsubscribedEvent
  | ContactComplainedEvent
  | MessageRoutingEvent;

export type { UnknownWebhookEvent };
/**
 * Any event this SDK can hand back: one of the 22 known events, or an
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

/**
 * Narrow a complaint `reporter` to the feedback loops AhaSend reads today.
 *
 * `reporter` is a plain `string` because AhaSend can add feedback loops at any
 * time. A value outside this list is ordinary data: keep a fallback branch for
 * it and never reject a delivery because of it.
 *
 * ```ts
 * const reporter = event.data.complaint?.reporter;
 * if (reporter === undefined) {
 *   // not a complaint event
 * } else if (isKnownComplaintReporter(reporter)) {
 *   count(reporter);
 * } else {
 *   countUnrecognized(reporter); // a feedback loop added after this release
 * }
 * ```
 */
export function isKnownComplaintReporter(reporter: string): reporter is KnownComplaintReporter {
  return (KNOWN_COMPLAINT_REPORTERS as readonly string[]).includes(reporter);
}

/**
 * Narrow an `origin` to the values AhaSend sends today.
 *
 * `origin` is a plain `string` because AhaSend can add an origin. A value
 * outside this list is ordinary data: keep a fallback branch for it and never
 * reject a delivery because of it.
 *
 * ```ts
 * const { origin } = event.data;
 * if (isKnownWebhookOrigin(origin)) {
 *   audit(origin);
 * } else {
 *   auditUnrecognized(origin); // an origin added after this release
 * }
 * ```
 */
export function isKnownWebhookOrigin(origin: string): origin is KnownWebhookOrigin {
  return (KNOWN_WEBHOOK_ORIGINS as readonly string[]).includes(origin);
}

/**
 * Narrow one `contact.updated` `changed_fields` entry to the contact fields
 * known today.
 *
 * The set is open: a contact field added after this release can appear in
 * `changed_fields`. Keep a fallback branch for it and never reject a delivery
 * because of it.
 *
 * ```ts
 * for (const field of event.data.changed_fields) {
 *   if (isKnownContactChangedField(field)) {
 *     sync(field, event.data.contact);
 *   } else {
 *     syncAll(event.data.contact); // a field added after this release
 *   }
 * }
 * ```
 */
export function isKnownContactChangedField(field: string): field is KnownContactChangedField {
  return (KNOWN_CONTACT_CHANGED_FIELDS as readonly string[]).includes(field);
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
