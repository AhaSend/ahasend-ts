import { Buffer } from "node:buffer";
import { WebhookVerifier } from "./verifier.js";
import type { WebhookEvent } from "./events.js";

/**
 * Minimal Node-style request shape — matches express, http.IncomingMessage,
 * and Fastify when raw body capture is configured.
 */
export interface NodeStyleRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string | Buffer;
  body?: unknown;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Minimal Node-style response shape — matches express's Response and the
 * raw http.ServerResponse.
 */
export interface NodeStyleResponse {
  statusCode?: number;
  writableEnded?: boolean;
  end(payload?: string | Buffer): unknown;
}

/**
 * Minimal Fastify reply shape.
 */
export interface FastifyStyleReply {
  sent?: boolean;
  code(status: number): FastifyStyleReply;
  send(payload?: unknown): unknown;
}

export type ExpressHandler<T extends WebhookEvent = WebhookEvent> = (
  event: T,
  req: NodeStyleRequest,
  res: NodeStyleResponse,
) => Promise<void> | void;

export type FastifyHandler<T extends WebhookEvent = WebhookEvent> = (
  event: T,
  request: NodeStyleRequest,
  reply: FastifyStyleReply,
) => Promise<void> | void;

export type NextHandler<T extends WebhookEvent = WebhookEvent> = (
  event: T,
  request: Request,
) => Response | Promise<Response>;

/**
 * Express middleware. Captures the raw request body (or reuses `req.rawBody`
 * if already populated by `express.raw()`), verifies the AhaSend signature,
 * parses the typed event, and dispatches to your handler. Returns 400 on
 * verification failure with a short reason string in the body.
 */
export function expressWebhookHandler<T extends WebhookEvent = WebhookEvent>(
  verifier: WebhookVerifier,
  handler: ExpressHandler<T>,
): (req: NodeStyleRequest, res: NodeStyleResponse) => Promise<void> {
  return async (req, res) => {
    let rawBody: Buffer;
    try {
      rawBody = await readNodeRawBody(req);
    } catch {
      writeError(res, 400);
      return;
    }

    let event: WebhookEvent;
    try {
      event = verifier.parse(req.headers, rawBody);
    } catch {
      writeError(res, 400);
      return;
    }

    try {
      await handler(event as T, req, res);
      if (!res.writableEnded) {
        if (!res.statusCode) res.statusCode = 200;
        res.end();
      }
    } catch {
      if (!res.writableEnded) writeError(res, 500);
    }
  };
}

/**
 * Fastify handler. Requires the route (or the global plugin) to be
 * configured with `rawBody: true` (e.g. via `fastify-raw-body`) so that
 * the request body is available unparsed for HMAC verification.
 */
export function fastifyWebhookHandler<T extends WebhookEvent = WebhookEvent>(
  verifier: WebhookVerifier,
  handler: FastifyHandler<T>,
): (request: NodeStyleRequest, reply: FastifyStyleReply) => Promise<void> {
  return async (request, reply) => {
    const rawBody = pickFastifyRawBody(request);
    if (rawBody === undefined) {
      reply.code(400).send("raw_body_required");
      return;
    }

    let event: WebhookEvent;
    try {
      event = verifier.parse(request.headers, rawBody);
    } catch {
      reply.code(400).send();
      return;
    }

    try {
      await handler(event as T, request, reply);
      if (!reply.sent) reply.code(200).send();
    } catch {
      if (!reply.sent) reply.code(500).send();
    }
  };
}

/**
 * Next.js (app router) route handler. Drop into `app/api/webhooks/route.ts`:
 *
 *     export const POST = nextRouteHandler(verifier, async (event) => {
 *       // ...
 *       return new Response(null, { status: 200 });
 *     });
 */
export function nextRouteHandler<T extends WebhookEvent = WebhookEvent>(
  verifier: WebhookVerifier,
  handler: NextHandler<T>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rawBody = await request.text();

    let event: WebhookEvent;
    try {
      event = verifier.parse(request.headers, rawBody);
    } catch {
      return new Response(null, { status: 400 });
    }

    try {
      return await handler(event as T, request);
    } catch {
      return new Response(null, { status: 500 });
    }
  };
}

async function readNodeRawBody(req: NodeStyleRequest): Promise<Buffer> {
  if (req.rawBody !== undefined) {
    return Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody, "utf-8");
  }
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return Buffer.from(req.body, "utf-8");
    // Body has been parsed into a JS object by an upstream middleware
    // such as `express.json()`. The original bytes are gone; we can't
    // verify the HMAC. Refuse explicitly rather than hanging on stream
    // events that have already fired.
    throw new Error(
      "raw_body_required: an upstream middleware parsed the body. " +
        "Mount `express.raw({ type: '*/*' })` on the webhook route, or " +
        "use a route-specific raw-body parser, before this handler.",
    );
  }
  if (typeof req.on !== "function") {
    throw new Error(
      "raw_body_required: request has no rawBody, body, or stream interface.",
    );
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on!("data", (...args) => {
      const chunk = args[0];
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf-8"));
    });
    req.on!("end", () => resolve(Buffer.concat(chunks)));
    req.on!("error", (...args) => reject(args[0] as Error));
  });
}

function pickFastifyRawBody(request: NodeStyleRequest): string | Buffer | undefined {
  if (request.rawBody !== undefined) return request.rawBody;
  if (typeof request.body === "string") return request.body;
  if (Buffer.isBuffer(request.body)) return request.body;
  return undefined;
}

function writeError(res: NodeStyleResponse, status: number, body?: string): void {
  res.statusCode = status;
  if (body !== undefined) res.end(body);
  else res.end();
}
