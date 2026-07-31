import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expressWebhookHandler } from "../src/webhooks/adapters.js";
import { MAX_WEBHOOK_BODY_BYTES, WebhookVerifier } from "../src/webhooks/verifier.js";

const SECRET = "aha-whsec-express-integration-secret";
const eventBody = JSON.stringify({
  type: "message.delivered",
  webhook_id: "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1",
  timestamp: new Date().toISOString(),
  data: {
    account_id: "835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa",
    event: "on_delivered",
    from: "sender@example.com",
    recipient: "recipient@example.com",
    subject: "integration",
    message_id_header: "<integration@example.com>",
    id: "message-integration",
  },
});

function signedHeaders(body: string | Buffer = eventBody): Record<string, string> {
  const id = "msg_express_integration";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from(SECRET, "utf-8"))
    .update(id)
    .update(".")
    .update(timestamp)
    .update(".")
    .update(body)
    .digest("base64");
  return {
    connection: "close",
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe("Express 5 webhook adapter integration", () => {
  it("accepts exactly 30,000,000 bytes and owns the opaque over-limit response", async () => {
    const handler = vi.fn();
    const app = express();
    app.post("/webhook", expressWebhookHandler(new WebhookVerifier(SECRET), handler));
    const baseUrl = await listen(app);
    const atLimit = Buffer.from(eventBody.padEnd(MAX_WEBHOOK_BODY_BYTES, " "), "utf-8");

    const accepted = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: signedHeaders(atLimit),
      body: atLimit,
    });

    expect(accepted.status).toBe(200);
    await expect(accepted.text()).resolves.toBe("");
    expect(handler).toHaveBeenCalledOnce();

    const overLimit = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1, 0x61);
    const rejected = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: signedHeaders(overLimit),
      body: overLimit,
    });

    expect(rejected.status).toBe(413);
    expect(rejected.headers.get("content-type")).toBeNull();
    await expect(rejected.text()).resolves.toBe("");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("passes a consumed parsed Express body to terminal error middleware", async () => {
    const handler = vi.fn();
    const terminal = vi.fn<ErrorRequestHandler>((error, _request, response, _next) => {
      expect(error).toBeInstanceOf(Error);
      response.status(598).end();
    });
    const app = express();
    app.post(
      "/webhook",
      express.json(),
      expressWebhookHandler(new WebhookVerifier(SECRET), handler),
    );
    app.use(terminal);
    const baseUrl = await listen(app);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: signedHeaders(),
      body: eventBody,
    });

    expect(response.status).toBe(598);
    expect(terminal).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers the original application failure to terminal error middleware", async () => {
    const original = new Error("local application failure");
    const terminal = vi.fn<ErrorRequestHandler>((error, _request, response, _next) => {
      expect(error).toBe(original);
      response.status(598).end();
    });
    const app = express();
    app.post(
      "/webhook",
      express.raw({ type: "*/*" }),
      expressWebhookHandler(new WebhookVerifier(SECRET), () => {
        throw original;
      }),
    );
    app.use(terminal);
    const baseUrl = await listen(app);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: signedHeaders(),
      body: eventBody,
    });

    expect(response.status).toBe(598);
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0]![0]).toBe(original);
  });

  it("still delivers the original failure after the response has ended", async () => {
    const original = new Error("failure after end");
    let resolveTerminal: ((error: unknown) => void) | undefined;
    const terminalError = new Promise<unknown>((resolve) => {
      resolveTerminal = resolve;
    });
    const app = express();
    app.post(
      "/webhook",
      express.raw({ type: "*/*" }),
      expressWebhookHandler(new WebhookVerifier(SECRET), (_event, _request, response) => {
        response.statusCode = 202;
        response.end();
        throw original;
      }),
    );
    app.use(((error, _request, _response, _next) => {
      resolveTerminal?.(error);
    }) satisfies ErrorRequestHandler);
    const baseUrl = await listen(app);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: signedHeaders(),
      body: eventBody,
    });

    expect(response.status).toBe(202);
    await expect(terminalError).resolves.toBe(original);
  });
});

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve, reject) => {
    const pending = app.listen(0, "127.0.0.1", () => resolve(pending));
    pending.once("error", reject);
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
