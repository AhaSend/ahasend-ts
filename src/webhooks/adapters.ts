import { Buffer } from "node:buffer";
import type { ReadableStreamReadResult } from "node:stream/web";
import { AhaSendWebhookVerificationError } from "../errors.js";
import { MAX_WEBHOOK_BODY_BYTES, WebhookVerifier } from "./verifier.js";
import type { AnyWebhookEvent } from "./events.js";

const DEFAULT_MAX_BODY_BYTES = MAX_WEBHOOK_BODY_BYTES;

export type WebhookAdapter = "express" | "fastify" | "next";
export type WebhookAdapterErrorStage = "setup" | "stream" | "application";

/** Non-sensitive metadata supplied to adapter error observers. */
export interface WebhookAdapterErrorContext {
  readonly adapter: WebhookAdapter;
  readonly stage: WebhookAdapterErrorStage;
}

/** Options shared by every framework adapter. */
export interface WebhookAdapterOptions {
  /**
   * Maximum raw body bytes to buffer. Defaults to the fixed 30,000,000-byte
   * verifier ceiling and may only narrow that ceiling.
   */
  maxBodyBytes?: number;
  onError?: (error: unknown, context: WebhookAdapterErrorContext) => void | Promise<void>;
}

/**
 * Minimal Node-style request shape — matches express, http.IncomingMessage,
 * and Fastify when raw body capture is configured.
 */
export interface NodeStyleRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string | Buffer;
  body?: unknown;
  readableEnded?: boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
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

/** Minimal Fastify reply shape. */
export interface FastifyStyleReply {
  sent?: boolean;
  code(status: number): FastifyStyleReply;
  send(payload?: unknown): unknown;
}

export type ExpressHandler = (
  event: AnyWebhookEvent,
  req: NodeStyleRequest,
  res: NodeStyleResponse,
) => Promise<void> | void;

export type FastifyHandler = (
  event: AnyWebhookEvent,
  request: NodeStyleRequest,
  reply: FastifyStyleReply,
) => Promise<void> | void;

export type NextHandler = (
  event: AnyWebhookEvent,
  request: Request,
) => Response | Promise<Response>;

/**
 * Express middleware. Mount directly so it can buffer the unconsumed raw
 * request stream. It can also reuse raw bytes already provided as a string or
 * Buffer in `req.rawBody` or `req.body`; a parsed object cannot be verified.
 * Verifies the AhaSend signature, parses the typed event, and dispatches to
 * your handler.
 */
export function expressWebhookHandler(
  verifier: WebhookVerifier,
  handler: ExpressHandler,
  options: WebhookAdapterOptions = {},
): (
  req: NodeStyleRequest,
  res: NodeStyleResponse,
  next: (error: unknown) => void,
) => Promise<void> {
  const adapterOptions = normalizeOptions(options);

  return async (req, res, next) => {
    let rawBody: Buffer;
    try {
      const availableBody = pickNodeRawBody(req, adapterOptions.maxBodyBytes);
      rawBody = availableBody ?? (await readNodeRawBody(req, adapterOptions.maxBodyBytes));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        completeExpress(res, 413, next, adapterOptions.onError);
        return;
      }
      propagateExpress(error, stageForNodeReadError(error), next, adapterOptions.onError);
      return;
    }

    let event: AnyWebhookEvent;
    try {
      event = verifier.parse(req.headers, rawBody);
    } catch (error) {
      if (error instanceof AhaSendWebhookVerificationError) {
        completeExpress(
          res,
          error.reason === "body_too_large" ? 413 : 400,
          next,
          adapterOptions.onError,
        );
        return;
      }
      propagateExpress(error, "setup", next, adapterOptions.onError);
      return;
    }

    try {
      await handler(event, req, res);
      if (!res.writableEnded) {
        if (!res.statusCode) res.statusCode = 200;
        res.end();
      }
    } catch (error) {
      propagateExpress(error, "application", next, adapterOptions.onError);
    }
  };
}

/**
 * Fastify handler. Requires the route (or the global plugin) to capture the
 * authentic bytes in `request.rawBody`, typically by configuring
 * `rawBody: true`. A parsed object in `request.body` is not a substitute.
 */
export function fastifyWebhookHandler(
  verifier: WebhookVerifier,
  handler: FastifyHandler,
  options: WebhookAdapterOptions = {},
): (request: NodeStyleRequest, reply: FastifyStyleReply) => Promise<void> {
  const adapterOptions = normalizeOptions(options);

  return async (request, reply) => {
    let rawBody: string | Buffer;
    try {
      rawBody = pickFastifyRawBody(request, adapterOptions.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        completeFastify(reply, 413, adapterOptions.onError);
        return;
      }
      if (error instanceof ParsedFastifyBodyError) {
        completeFastify(reply, 400, adapterOptions.onError);
        return;
      }
      observeError(adapterOptions.onError, error, "fastify", "setup");
      throw error;
    }

    let event: AnyWebhookEvent;
    try {
      event = verifier.parse(request.headers, rawBody);
    } catch (error) {
      if (error instanceof AhaSendWebhookVerificationError) {
        completeFastify(
          reply,
          error.reason === "body_too_large" ? 413 : 400,
          adapterOptions.onError,
        );
        return;
      }
      observeError(adapterOptions.onError, error, "fastify", "setup");
      throw error;
    }

    try {
      await handler(event, request, reply);
      if (!reply.sent) reply.code(200).send();
    } catch (error) {
      observeError(adapterOptions.onError, error, "fastify", "application");
      throw error;
    }
  };
}

/** Next.js app-router route handler. */
export function nextRouteHandler(
  verifier: WebhookVerifier,
  handler: NextHandler,
  options: WebhookAdapterOptions = {},
): (request: Request) => Promise<Response> {
  const adapterOptions = normalizeOptions(options);

  return async (request) => {
    let rawBody: Buffer;
    try {
      rawBody = await readWebRawBody(request, adapterOptions.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return opaqueResponse(413);
      observeError(adapterOptions.onError, error, "next", "stream");
      throw error;
    }

    let event: AnyWebhookEvent;
    try {
      event = verifier.parse(request.headers, rawBody);
    } catch (error) {
      if (error instanceof AhaSendWebhookVerificationError) {
        return opaqueResponse(error.reason === "body_too_large" ? 413 : 400);
      }
      observeError(adapterOptions.onError, error, "next", "setup");
      throw error;
    }

    try {
      return await handler(event, request);
    } catch (error) {
      observeError(adapterOptions.onError, error, "next", "application");
      throw error;
    }
  };
}

interface NormalizedAdapterOptions {
  maxBodyBytes: number;
  onError: WebhookAdapterOptions["onError"];
}

class BodyTooLargeError extends Error {}

class ParsedFastifyBodyError extends Error {}

class NodeStreamError extends Error {
  constructor(readonly originalCause: unknown) {
    super("Webhook request stream failed", { cause: originalCause });
  }
}

function normalizeOptions(options: WebhookAdapterOptions): NormalizedAdapterOptions {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > MAX_WEBHOOK_BODY_BYTES
  ) {
    throw new TypeError(
      `maxBodyBytes must be an integer from 1 through ${String(MAX_WEBHOOK_BODY_BYTES)}`,
    );
  }
  return { maxBodyBytes, onError: options.onError };
}

function pickNodeRawBody(req: NodeStyleRequest, maxBodyBytes: number): Buffer | undefined {
  if (req.rawBody !== undefined) return toBoundedBuffer(req.rawBody, maxBodyBytes);
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
      return toBoundedBuffer(req.body, maxBodyBytes);
    }
    throw new Error("Raw webhook body unavailable: configure a route-specific raw-body parser.");
  }
  if (req.readableEnded === true) {
    throw new Error("Raw webhook body unavailable: the request stream was already consumed.");
  }
  if (typeof req.on !== "function") {
    throw new Error("Raw webhook body unavailable: request has no readable stream.");
  }
  return undefined;
}

function readNodeRawBody(req: NodeStyleRequest, maxBodyBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const onData = (...args: unknown[]) => {
      if (settled) return;
      const value = args[0];
      let chunk: Buffer;
      if (Buffer.isBuffer(value)) chunk = value;
      else if (typeof value === "string") chunk = Buffer.from(value, "utf-8");
      else {
        settled = true;
        cleanup();
        reject(
          new NodeStreamError(new TypeError("Webhook request stream emitted a non-byte chunk")),
        );
        return;
      }
      byteLength += chunk.length;
      if (byteLength > maxBodyBytes) {
        settled = true;
        cleanup();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks, byteLength));
      } else {
        cleanup();
      }
    };
    const onStreamError = (...args: unknown[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new NodeStreamError(args[0]));
    };
    const cleanup = () => {
      req.off?.("data", onData);
      req.off?.("end", onEnd);
      req.off?.("error", onStreamError);
    };

    req.on!("data", onData);
    req.on!("end", onEnd);
    req.on!("error", onStreamError);
  });
}

function pickFastifyRawBody(request: NodeStyleRequest, maxBodyBytes: number): string | Buffer {
  if (request.rawBody !== undefined) {
    assertBodyWithinLimit(request.rawBody, maxBodyBytes);
    return request.rawBody;
  }
  if (typeof request.body === "string" || Buffer.isBuffer(request.body)) {
    assertBodyWithinLimit(request.body, maxBodyBytes);
    return request.body;
  }
  if (request.body !== undefined) {
    throw new ParsedFastifyBodyError(
      "Raw webhook body unavailable: enable Fastify raw-body capture.",
    );
  }
  throw new Error("Raw webhook body unavailable: enable Fastify raw-body capture.");
}

async function readWebRawBody(request: Request, maxBodyBytes: number): Promise<Buffer> {
  if (request.body === null) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (done) return Buffer.concat(chunks, byteLength);
      const chunk = Buffer.from(value);
      byteLength += chunk.length;
      if (byteLength > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

function toBoundedBuffer(body: string | Buffer, maxBodyBytes: number): Buffer {
  assertBodyWithinLimit(body, maxBodyBytes);
  return Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
}

function assertBodyWithinLimit(body: string | Buffer, maxBodyBytes: number): void {
  const byteLength = typeof body === "string" ? Buffer.byteLength(body, "utf-8") : body.length;
  if (byteLength > maxBodyBytes) throw new BodyTooLargeError();
}

function stageForNodeReadError(error: unknown): WebhookAdapterErrorStage {
  return error instanceof NodeStreamError ? "stream" : "setup";
}

function unwrapNodeReadError(error: unknown): unknown {
  return error instanceof NodeStreamError ? error.originalCause : error;
}

function completeExpress(
  res: NodeStyleResponse,
  status: number,
  next: (error: unknown) => void,
  onError: WebhookAdapterOptions["onError"],
): void {
  try {
    res.statusCode = status;
    res.end();
  } catch (error) {
    propagateExpress(error, "setup", next, onError);
  }
}

function propagateExpress(
  error: unknown,
  stage: WebhookAdapterErrorStage,
  next: (error: unknown) => void,
  onError: WebhookAdapterOptions["onError"],
): void {
  const originalError = unwrapNodeReadError(error);
  observeError(onError, originalError, "express", stage);
  next(originalError);
}

function completeFastify(
  reply: FastifyStyleReply,
  status: number,
  onError: WebhookAdapterOptions["onError"],
): void {
  try {
    reply.code(status).send();
  } catch (error) {
    observeError(onError, error, "fastify", "setup");
    throw error;
  }
}

function opaqueResponse(status: number): Response {
  return new Response(null, { status });
}

function observeError(
  observer: WebhookAdapterOptions["onError"],
  error: unknown,
  adapter: WebhookAdapter,
  stage: WebhookAdapterErrorStage,
): void {
  if (observer === undefined) return;
  const context = Object.freeze({ adapter, stage });
  try {
    const pending = observer(error, context);
    if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // Error observers are diagnostic only and never replace the native path.
  }
}
