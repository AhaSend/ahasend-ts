import type { HttpClient } from "../http.js";
import { paginate } from "../pagination.js";
import type {
  Address,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";

export interface Recipient {
  email: string;
  name?: string;
  substitutions?: Record<string, unknown>;
}

export interface Attachment {
  data: string;
  content_type: string;
  file_name: string;
  base64?: boolean;
  content_disposition?: string;
  content_id?: string;
}

export interface Tracking {
  open?: boolean;
  click?: boolean;
}

export interface Retention {
  metadata?: number;
  data?: number;
}

export interface MessageSchedule {
  first_attempt?: ISODateTime;
  expires?: ISODateTime;
}

export type SandboxResult = "deliver" | "bounce" | "defer" | "fail" | "suppress";

export interface CreateMessageRequest {
  from: Address;
  recipients: Recipient[];
  subject: string;
  reply_to?: Address;
  text_content?: string;
  html_content?: string;
  amp_content?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
  substitutions?: Record<string, unknown>;
  tags?: string[];
  sandbox?: boolean;
  sandbox_result?: SandboxResult;
  tracking?: Tracking;
  retention?: Retention;
  schedule?: MessageSchedule;
}

export interface CreateConversationMessageRequest {
  from: Address;
  to: Address[];
  subject: string;
  cc?: Address[];
  bcc?: Address[];
  reply_to?: Address;
  text_content?: string;
  html_content?: string;
  amp_content?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
  tags?: string[];
  sandbox?: boolean;
  sandbox_result?: SandboxResult;
  tracking?: Tracking;
  retention?: Retention;
  schedule?: MessageSchedule;
}

export type SendMessageStatus = "queued" | "scheduled" | "error";

export interface SendMessageResult {
  object: "message";
  id: UUID | null;
  recipient: Recipient | Address;
  status: SendMessageStatus;
  error: string | null;
  schedule?: MessageSchedule;
}

export interface SendMessageResponse {
  object: "list";
  data: SendMessageResult[];
}

export interface DeliveryAttempt {
  time: ISODateTime;
  log: string;
  status: string;
}

export interface MessageContentPart {
  content_type: string;
  content: string;
}

export interface MessageContentAttachment {
  filename: string;
  content: string;
  content_type: string;
  content_id: string | null;
}

export interface MessageContentParsed {
  parts: MessageContentPart[];
  attachments: MessageContentAttachment[];
  headers: Record<string, string[]>;
}

export interface Message {
  object: "message";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  sent_at: ISODateTime | null;
  delivered_at: ISODateTime | null;
  retain_until: ISODateTime;
  direction: "inbound" | "outbound";
  is_bounce_notification: boolean;
  bounce_classification: string;
  delivery_attempts: DeliveryAttempt[];
  message_id: string;
  subject: string;
  tags: string[];
  sender: string;
  recipient: string;
  status: string;
  num_attempts: number;
  click_count: number;
  open_count: number;
  reference_message_id: number | null;
  domain_id: UUID;
  account_id: UUID;
  content?: string | null;
  content_parsed?: MessageContentParsed;
}

export interface ListMessagesParams extends PaginationParams {
  from?: string;
  to?: string;
  domain?: string;
  subject?: string;
  status?: string;
  tag?: string;
  created_after?: ISODateTime;
  created_before?: ISODateTime;
  sort?: string;
  direction?: "asc" | "desc";
}

export class MessagesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  send(body: CreateMessageRequest, options: RequestOptions = {}): Promise<SendMessageResponse> {
    return this.http.request<SendMessageResponse>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages`,
      body,
      ...forward(options),
    });
  }

  sendConversation(
    body: CreateConversationMessageRequest,
    options: RequestOptions = {},
  ): Promise<SendMessageResponse> {
    return this.http.request<SendMessageResponse>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages/conversation`,
      body,
      ...forward(options),
    });
  }

  list(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Message>> {
    return this.http.request<PaginatedResponse<Message>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages`,
      query: params as Record<string, unknown>,
      ...forward(options),
    });
  }

  iterate(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Message, void, undefined> {
    return paginate<Message, ListMessagesParams>(
      (p) => this.list(p, options),
      params,
    );
  }

  get(messageId: UUID, options: RequestOptions = {}): Promise<Message> {
    return this.http.request<Message>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages/${encodeURIComponent(messageId)}`,
      ...forward(options),
    });
  }

  cancel(messageId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages/${encodeURIComponent(messageId)}/cancel`,
      ...forward(options),
    });
  }
}

function forward(options: RequestOptions): { signal?: AbortSignal; headers?: Record<string, string> } {
  const out: { signal?: AbortSignal; headers?: Record<string, string> } = {};
  if (options.signal) out.signal = options.signal;
  if (options.headers) out.headers = options.headers;
  return out;
}
