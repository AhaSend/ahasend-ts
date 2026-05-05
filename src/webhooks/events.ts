import type { ISODateTime, UUID } from "../types/common.js";

export type WebhookEventType =
  | "message.reception"
  | "message.delivered"
  | "message.transient_error"
  | "message.failed"
  | "message.bounced"
  | "message.suppressed"
  | "message.opened"
  | "message.clicked"
  | "suppression.created"
  | "domain.dns_error"
  | "route.message";

export interface WebhookEnvelope<TType extends WebhookEventType, TData> {
  type: TType;
  timestamp: ISODateTime;
  webhook_id?: string;
  data: TData;
}

export interface MessageEventData {
  account_id: UUID;
  event: string;
  from: string;
  recipient: string;
  subject: string;
  message_id_header: string;
  id: UUID;
  user_agent?: string;
  ip?: string;
  is_bot?: boolean;
}

export interface MessageClickedEventData extends MessageEventData {
  url: string;
}

export interface SuppressionEventData {
  account_id: UUID;
  recipient: string;
  created_at: ISODateTime;
  expires_at?: ISODateTime;
  reason: string;
  sending_domain: string;
}

export interface DomainEventData {
  domain: string;
  account_id: UUID;
  spf_valid: boolean;
  dkim_valid: boolean;
  dmarc_valid: boolean;
  dns_last_checked_at: ISODateTime;
}

export interface RouteAttachment {
  filename: string;
  content_type: string;
  content_id?: string;
  data: string;
}

export interface RouteEventData {
  id: UUID;
  from: string;
  reply_to?: string;
  to: string;
  subject: string;
  message_id: string;
  size: number;
  spam_score: number;
  bounce: boolean;
  cc?: string;
  date: ISODateTime;
  in_reply_to?: string;
  references?: string;
  auto_submitted?: string;
  html_body?: string;
  plain_body?: string;
  reply_from_plain_body?: string;
  attachments?: RouteAttachment[];
  headers?: Record<string, string[]>;
}

export type MessageReceptionEvent = WebhookEnvelope<"message.reception", MessageEventData>;
export type MessageDeliveredEvent = WebhookEnvelope<"message.delivered", MessageEventData>;
export type MessageTransientErrorEvent = WebhookEnvelope<"message.transient_error", MessageEventData>;
export type MessageFailedEvent = WebhookEnvelope<"message.failed", MessageEventData>;
export type MessageBouncedEvent = WebhookEnvelope<"message.bounced", MessageEventData>;
export type MessageSuppressedEvent = WebhookEnvelope<"message.suppressed", MessageEventData>;
export type MessageOpenedEvent = WebhookEnvelope<"message.opened", MessageEventData>;
export type MessageClickedEvent = WebhookEnvelope<"message.clicked", MessageClickedEventData>;
export type SuppressionCreatedEvent = WebhookEnvelope<"suppression.created", SuppressionEventData>;
export type DomainDNSErrorEvent = WebhookEnvelope<"domain.dns_error", DomainEventData>;

export type RouteMessageEvent = WebhookEnvelope<"route.message", RouteEventData> & {
  route_id?: UUID;
};

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
  | RouteMessageEvent;
