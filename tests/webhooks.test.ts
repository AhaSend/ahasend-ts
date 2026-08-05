import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { digestJsonArtifact, digestYamlArtifact, sha256Hex } from "../scripts/digest-artifact.mjs";
import { parseWebhookContract } from "../scripts/generate-contracts.mjs";
import { generateSdkArtifacts } from "../scripts/generate-sdk.mjs";
import { WEBHOOK_SHA256 } from "../src/generated/contract-digests.js";
import type { components as WebhookComponents } from "../src/generated/webhook-types.js";
import {
  CANONICAL_WEBHOOK_EVENT_TYPES,
  DEPRECATED_WEBHOOK_EVENT_TYPES,
  WEBHOOK_CONTRACT_SHA256,
  WEBHOOK_SCHEMA_NAMES,
} from "../src/generated/webhook-types.js";
import {
  validateKnownWebhookEvent,
  validateUnknownWebhookEvent,
  validateWebhookEvent,
} from "../src/generated/webhook-validators.js";
import { isKnownWebhookEvent } from "../src/webhooks/events.js";
import { AhaSendConfigurationError } from "../src/errors.js";
import {
  AhaSendWebhookVerificationError,
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookVerifier,
  createWebhookVerifierWithClock,
  type WebhookVerificationReason,
} from "../src/webhooks/verifier.js";

// AhaSend webhook secrets are raw strings: the HMAC key is the literal
// UTF-8 bytes of the secret as the user pastes it from the dashboard.
// This matches the Go SDK at ahasend-go/webhooks/webhooks.go.
const SECRET = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const PREFIXED_SECRET = `aha-whsec-${SECRET}`;
const ROOT = process.cwd();
const OPENAPI_SOURCE = readFileSync(resolve(ROOT, "openapi.yaml"), "utf8");
const WEBHOOK_SOURCE = readFileSync(resolve(ROOT, "webhooks.yaml"), "utf8");
const CAPTURED_PATH = resolve(ROOT, "contracts/webhooks/captured");
const SYNTHETIC_PATH = resolve(ROOT, "contracts/webhooks/synthetic");
const BODY_WEBHOOK_ID = "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1";
const IS_BOT_FIXTURE_EXPECTATIONS = new Map<string, boolean | "absent">([
  ["message-opened-bot-true", true],
  ["message-clicked-bot-false", false],
  ["message-opened-bot-absent", "absent"],
]);
const CONFIGURED_WEBHOOK_BODIES = [
  {
    type: "message.delivered",
    webhook_id: BODY_WEBHOOK_ID,
    timestamp: "2026-07-14T15:03:21.987654321Z",
    data: {
      account_id: "835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa",
      event: "on_delivered",
      from: "sender@example.com",
      recipient: "receiver@example.com",
      subject: "Test",
      message_id_header: "<delivery@example.com>",
      id: "message-1",
    },
  },
  {
    type: "message.clicked",
    webhook_id: BODY_WEBHOOK_ID,
    timestamp: "2026-07-14T15:03:22Z",
    data: {
      account_id: "835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa",
      event: "on_clicked",
      from: "sender@example.com",
      recipient: "receiver@example.com",
      subject: "Test",
      message_id_header: "<clicked@example.com>",
      url: "https://example.com/clicked",
      user_agent: "AhaSend test",
      ip: "192.0.2.1",
      id: "message-2",
    },
  },
  {
    type: "suppression.created",
    webhook_id: BODY_WEBHOOK_ID,
    timestamp: "2026-07-14T15:03:23Z",
    data: {
      account_id: "835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa",
      recipient: "receiver@example.com",
      created_at: "2026-07-14T15:03:23Z",
      expires_at: "2026-08-13T15:03:23Z",
      reason: "Too many hard bounces",
      sending_domain: "example.com",
    },
  },
  {
    type: "domain.dns_error",
    webhook_id: BODY_WEBHOOK_ID,
    timestamp: "2026-07-14T15:03:24Z",
    data: {
      domain: "example.com",
      account_id: "835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa",
      spf_valid: true,
      dkim_valid: false,
      dmarc_valid: true,
      dns_last_checked_at: "2026-07-14T15:03:24Z",
    },
  },
] as const;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected a record");
  }
  return value as Record<string, unknown>;
}

describe("generated webhook schema", () => {
  it("binds generated artifacts to the pinned webhook contract digest", () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, "contracts.lock.json"), "utf8")) as {
      artifactHashes: Record<string, string>;
    };
    const digest = digestYamlArtifact(Buffer.from(WEBHOOK_SOURCE, "utf8"));

    expect(digest).toBe(lock.artifactHashes["webhooks.yaml"]);
    expect(WEBHOOK_CONTRACT_SHA256).toBe(digest);
    expect(WEBHOOK_SHA256).toBe(digest);
  });

  it(
    "regenerates webhook output deterministically and passes clean check mode",
    { timeout: 120_000 },
    async () => {
      const first = await generateSdkArtifacts(OPENAPI_SOURCE, WEBHOOK_SOURCE);
      const second = await generateSdkArtifacts(OPENAPI_SOURCE, WEBHOOK_SOURCE);
      const generatedPaths = [
        "src/generated/webhook-types.ts",
        "src/generated/webhook-validators.ts",
      ] as const;

      for (const path of generatedPaths) {
        expect(first.get(path), path).toBe(second.get(path));
        expect(readFileSync(resolve(ROOT, path), "utf8"), path).toBe(first.get(path));
      }

      const beforeCheck = generatedPaths.map((path) => readFileSync(resolve(ROOT, path), "utf8"));
      const check = spawnSync(process.execPath, ["scripts/generate-sdk.mjs", "--check"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
      expect(generatedPaths.map((path) => readFileSync(resolve(ROOT, path), "utf8"))).toEqual(
        beforeCheck,
      );
    },
  );

  it("models canonical routing, deprecated input compatibility, and optional is_bot", () => {
    expect(CANONICAL_WEBHOOK_EVENT_TYPES).toContain("message.routing");
    expect(CANONICAL_WEBHOOK_EVENT_TYPES).not.toContain("route.message");
    expect(DEPRECATED_WEBHOOK_EVENT_TYPES).toEqual(["route.message"]);

    expectTypeOf<{
      account_id: string;
      event: "on_opened";
      from: string;
      recipient: string;
      subject: string;
      message_id_header: string;
      id: string;
    }>().toExtend<WebhookComponents["schemas"]["MessageWebhookData"]>();
    expectTypeOf<WebhookComponents["schemas"]["MessageWebhookData"]["is_bot"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<{
      type: "route.message";
      route_id: string;
      timestamp: string;
      data: WebhookComponents["schemas"]["RouteWebhookData"];
    }>().toExtend<WebhookComponents["schemas"]["RouteWebhookPayload"]>();
  });

  it("covers every declared webhook schema and canonical event example", () => {
    const document = parseWebhookContract(WEBHOOK_SOURCE);
    const schemas = record(record(document["components"])["schemas"]);
    const webhooks = record(document["webhooks"]);

    expect(WEBHOOK_SCHEMA_NAMES).toEqual(Object.keys(schemas));
    expect(WEBHOOK_SCHEMA_NAMES).toHaveLength(18);
    expect(CANONICAL_WEBHOOK_EVENT_TYPES).toEqual(Object.keys(webhooks));
    expect(CANONICAL_WEBHOOK_EVENT_TYPES).toHaveLength(11);

    for (const [eventType, webhookValue] of Object.entries(webhooks)) {
      const post = record(record(webhookValue)["post"]);
      const requestBody = record(post["requestBody"]);
      const content = record(requestBody["content"]);
      const mediaType = record(content["application/json"]);
      expect(validateKnownWebhookEvent(mediaType["example"]), eventType).toBe(true);
    }
  });

  it("validates complete known envelopes and nested payload fields", () => {
    const clicked = {
      type: "message.clicked",
      webhook_id: BODY_WEBHOOK_ID,
      timestamp: "2024-05-06T09:49:16.687031577Z",
      data: {
        account_id: "4cdd7bdd-294e-4762-892f-83d40abf5a87",
        event: "on_clicked",
        from: "sender@example.com",
        recipient: "recipient@example.com",
        subject: "Hello",
        message_id_header: "<message@example.com>",
        url: "https://example.com",
        user_agent: "AhaSend test",
        ip: "192.0.2.1",
        id: "message-1",
        is_bot: false,
      },
    };

    expect(validateKnownWebhookEvent(clicked)).toBe(true);
    const withoutOptionalBoolean = structuredClone(clicked);
    Reflect.deleteProperty(withoutOptionalBoolean.data, "is_bot");
    expect(validateKnownWebhookEvent(withoutOptionalBoolean)).toBe(true);
    expect(
      validateKnownWebhookEvent({
        ...clicked,
        data: { ...clicked.data, is_bot: "false" },
      }),
    ).toBe(false);
    const withoutUrl = structuredClone(clicked);
    Reflect.deleteProperty(withoutUrl.data, "url");
    expect(validateKnownWebhookEvent(withoutUrl)).toBe(false);
  });

  it("requires webhook_id on every configured-webhook envelope", () => {
    // All six producers declare `WebhookID uuid.UUID` with no omitempty, so
    // the key is always on the wire. It was optional only because the fixture
    // it was aligned against omitted it, and that fixture was generated rather
    // than captured. Routed messages are the exception and carry route_id.
    for (const payload of CONFIGURED_WEBHOOK_BODIES) {
      expect(validateKnownWebhookEvent(payload), `${payload.type} with webhook_id`).toBe(true);

      const { webhook_id: _omitted, ...withoutWebhookId } = payload;
      expect(
        validateKnownWebhookEvent(withoutWebhookId),
        `${payload.type} without webhook_id`,
      ).toBe(false);
    }
  });

  it("validates RFC 3339 date-times and the complete UUID format", () => {
    const clicked = {
      type: "message.clicked",
      webhook_id: BODY_WEBHOOK_ID,
      timestamp: "2024-05-06t09:49:16.687031577z",
      data: {
        account_id: "00000000-0000-0000-0000-000000000000",
        event: "on_clicked",
        from: "sender@example.com",
        recipient: "recipient@example.com",
        subject: "Hello",
        message_id_header: "<message@example.com>",
        url: "https://example.com",
        user_agent: "AhaSend test",
        ip: "192.0.2.1",
        id: "message-1",
      },
    };

    expect(validateKnownWebhookEvent(clicked)).toBe(true);
    expect(
      validateKnownWebhookEvent({
        ...clicked,
        data: { ...clicked.data, account_id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      }),
    ).toBe(true);
    for (const timestamp of [
      "2024-02-29T09:49:16Z",
      "1990-12-31T23:59:60Z",
      "1990-12-31T15:59:60-08:00",
      "1991-01-01T08:59:60+09:00",
      "2024-05-06T09:49:16+23:59",
    ]) {
      expect(validateKnownWebhookEvent({ ...clicked, timestamp }), timestamp).toBe(true);
    }
    for (const timestamp of [
      "2024-99-99T99:99:99Z",
      "2023-02-29T09:49:16Z",
      "2024-04-31T09:49:16Z",
      "2024-05-06T24:00:00Z",
      "2024-05-06T09:60:00Z",
      "2024-05-06T09:49:61Z",
      "2024-05-06T09:49:60Z",
      "2024-05-06T09:49:16+24:00",
      "2024-05-06T09:49:16+00:60",
      "2024-05-06 09:49:16Z",
    ]) {
      expect(validateKnownWebhookEvent({ ...clicked, timestamp }), timestamp).toBe(false);
    }
    expect(
      validateKnownWebhookEvent({
        ...clicked,
        data: { ...clicked.data, account_id: "00000000000000000000000000000000" },
      }),
    ).toBe(false);
  });

  it("does not reject address fields on their shape", () => {
    // Previously these fields were validated as strict RFC 5321 mailboxes.
    // That rejected shapes AhaSend actually sends (campaign display-name
    // mailboxes) and shapes arbitrary inbound senders use (SMTPUTF8), and a
    // rejection costs the customer their whole webhook. Address fields are
    // now carried through verbatim; consumers parse them as they see fit.
    const clicked = {
      type: "message.clicked",
      webhook_id: BODY_WEBHOOK_ID,
      timestamp: "2024-05-06T09:49:16Z",
      data: {
        account_id: "4cdd7bdd-294e-4762-892f-83d40abf5a87",
        event: "on_clicked",
        from: "sender@example.com",
        recipient: "recipient@example.com",
        subject: "Hello",
        message_id_header: "<message@example.com>",
        url: "https://example.com",
        user_agent: "AhaSend test",
        ip: "192.0.2.1",
        id: "message-1",
      },
    };

    for (const email of [
      // Shapes the old RFC 5321 check accepted.
      '\"a@b\"@example.com',
      "postbox@mailserver1",
      "user@[127.0.0.1]",
      "user@[IPv6:2001:db8::1]",
      // Shapes it rejected that AhaSend or an inbound sender really sends.
      "Acme Campaigns <news@example.com>",
      "dörte@example.com",
      "sender@bad_domain.com",
      "sender..name@example.com",
      "a,b@example.com",
    ]) {
      expect(
        validateKnownWebhookEvent({ ...clicked, data: { ...clicked.data, from: email } }),
        email,
      ).toBe(true);
    }

    // The field must still be a string — a structural mismatch is not an
    // address-shape question.
    for (const notAString of [42, null, { address: "sender@example.com" }]) {
      expect(
        validateKnownWebhookEvent({ ...clicked, data: { ...clicked.data, from: notAString } }),
        JSON.stringify(notAString),
      ).toBe(false);
    }
  });

  it("accepts canonical and deprecated routing inputs against the same full schema", () => {
    const routing = {
      type: "message.routing",
      route_id: "abe11757-2886-4b55-96f1-0e0afc95795a",
      timestamp: "2024-05-06T13:15:46Z",
      data: {
        id: "route-message-1",
        from: "sender@example.com",
        reply_to: "sender@example.com",
        to: "support@example.com",
        subject: "Help",
        message_id: "<route@example.com>",
        size: 512,
        spam_score: 0,
        bounce: false,
        cc: "",
        date: "Mon, 06 May 2024 13:15:46 +0000",
        in_reply_to: "",
        references: "",
        auto_submitted: "",
        html_body: "<p>Help</p>",
        plain_body: "Help",
        reply_from_plain_body: "",
        attachments: [
          {
            filename: "note.txt",
            content_type: "text/plain",
            content_id: "",
            disposition: "attachment",
            data: "SGVsbG8=",
          },
        ],
        headers: { "X-Mailer": "AhaSend test" },
      },
    } as const;

    expect(validateKnownWebhookEvent(routing)).toBe(true);
    expect(validateKnownWebhookEvent({ ...routing, type: "route.message" })).toBe(true);
    for (const from of [
      "sender@example.com",
      "<sender@example.com>",
      '"AhaSend Support" <sender@example.com>',
      "Dörte Beispiel <sender@example.com>",
    ]) {
      expect(validateKnownWebhookEvent({ ...routing, data: { ...routing.data, from } }), from).toBe(
        true,
      );
    }
    const withoutRouteId = structuredClone(routing);
    Reflect.deleteProperty(withoutRouteId, "route_id");
    expect(validateKnownWebhookEvent(withoutRouteId)).toBe(false);
    expect(
      validateKnownWebhookEvent({
        ...routing,
        data: { ...routing.data, attachments: [{ filename: "note.txt" }] },
      }),
    ).toBe(false);
  });

  it("validates future event types only against the schema-defined common envelope", () => {
    const future = {
      type: "message.future_event",
      timestamp: "2026-07-22T12:00:00Z",
      data: { future_field: true },
      future_envelope_field: "preserved",
    };

    expect(validateUnknownWebhookEvent(future)).toBe(true);
    expect(validateWebhookEvent(future)).toBe(true);
    expect(validateUnknownWebhookEvent({ ...future, data: "not-an-object" })).toBe(false);
    expect(validateUnknownWebhookEvent({ type: future.type, timestamp: future.timestamp })).toBe(
      false,
    );
    expect(
      validateUnknownWebhookEvent({
        type: "message.clicked",
        timestamp: future.timestamp,
        data: {},
      }),
    ).toBe(false);
  });
});

describe("captured TypeScript verification results", () => {
  const manifest = JSON.parse(readFileSync(resolve(CAPTURED_PATH, "manifest.json"), "utf8")) as {
    headerRecordFormat: string;
    captures: Array<{
      fixtureId: string;
      bodyPath: string;
      rawBodySha256: string;
      signingResource: {
        type: "configured-webhook" | "route";
        id: string;
        keyPath: string;
        keySha256: string;
      };
      webhookId: string;
      webhookTimestamp: string;
      signature: string;
      headersSha256: string;
    }>;
  };
  const results = JSON.parse(
    readFileSync(resolve(CAPTURED_PATH, "typescript-results.json"), "utf8"),
  ) as {
    version: number;
    implementation: string;
    manifestSha256: string;
    results: unknown[];
  };

  it("binds canonical result rows to the manifest with a detached digest", () => {
    expect(results).toMatchObject({
      version: 1,
      implementation: "@ahasend/sdk",
      manifestSha256: digestJsonArtifact(manifest),
    });
    expect(readFileSync(resolve(CAPTURED_PATH, "typescript-results.sha256"), "utf8")).toBe(
      `${digestJsonArtifact(results)}\n`,
    );

    expect(results.results).toEqual(
      manifest.captures.map((capture) => ({
        fixture: capture.fixtureId,
        signingResource: {
          type: capture.signingResource.type,
          id: capture.signingResource.id,
        },
        keySha256: capture.signingResource.keySha256,
        captureSha256: digestJsonArtifact(capture),
        webhookId: capture.webhookId,
        webhookTimestamp: capture.webhookTimestamp,
        signature: capture.signature,
        bodySha256: capture.rawBodySha256,
        headersSha256: capture.headersSha256,
        result: "valid",
      })),
    );
  });

  it("reproduces every HMAC and header hash from exact persisted strings and matching keys", () => {
    for (const capture of manifest.captures) {
      const rawBody = readFileSync(resolve(ROOT, capture.bodyPath));
      const keyFile = readFileSync(resolve(ROOT, capture.signingResource.keyPath));
      const key = keyFile.subarray(0, keyFile.length - 1);
      const headerRecord = manifest.headerRecordFormat
        .replaceAll("{webhookId}", capture.webhookId)
        .replaceAll("{webhookTimestamp}", capture.webhookTimestamp)
        .replaceAll("{signature}", capture.signature);

      expect(sha256Hex(rawBody), capture.fixtureId).toBe(capture.rawBodySha256);
      expect(sha256Hex(key), capture.fixtureId).toBe(capture.signingResource.keySha256);
      expect(createHash("sha256").update(headerRecord).digest("hex"), capture.fixtureId).toBe(
        capture.headersSha256,
      );
      expect(
        sign(key.toString("utf8"), capture.webhookId, capture.webhookTimestamp, rawBody),
        capture.fixtureId,
      ).toBe(capture.signature);

      const verifier = createWebhookVerifierWithClock(
        key.toString("utf8"),
        () => Number(capture.webhookTimestamp) * 1000,
      );
      expect(() =>
        verifier.verify(
          {
            "webhook-id": capture.webhookId,
            "webhook-timestamp": capture.webhookTimestamp,
            "webhook-signature": capture.signature,
          },
          rawBody,
        ),
      ).not.toThrow();
    }
  });

  it("rejects altered exact headers, reserialized bodies, and swapped resource keys", () => {
    for (const [index, capture] of manifest.captures.entries()) {
      const rawBody = readFileSync(resolve(ROOT, capture.bodyPath));
      const keyFile = readFileSync(resolve(ROOT, capture.signingResource.keyPath));
      const key = keyFile.subarray(0, keyFile.length - 1).toString("utf8");
      const otherCapture = manifest.captures[(index + 1) % manifest.captures.length]!;
      const otherKeyFile = readFileSync(resolve(ROOT, otherCapture.signingResource.keyPath));
      const otherKey = otherKeyFile.subarray(0, otherKeyFile.length - 1).toString("utf8");
      const verifier = createWebhookVerifierWithClock(
        key,
        () => Number(capture.webhookTimestamp) * 1000,
      );
      const headers = {
        "webhook-id": capture.webhookId,
        "webhook-timestamp": capture.webhookTimestamp,
        "webhook-signature": capture.signature,
      };

      expect(
        reasonFrom(() =>
          verifier.verify({ ...headers, "webhook-id": `${capture.webhookId}x` }, rawBody),
        ),
      ).toBe("signature_mismatch");
      expect(
        reasonFrom(() =>
          verifier.verify(
            {
              ...headers,
              "webhook-timestamp": String(Number(capture.webhookTimestamp) + 1),
            },
            rawBody,
          ),
        ),
      ).toBe("signature_mismatch");
      expect(
        reasonFrom(() =>
          verifier.verify(
            { ...headers, "webhook-signature": capture.signature.replace("v1,", "v1,x") },
            rawBody,
          ),
        ),
      ).toBe("signature_mismatch");
      expect(
        reasonFrom(() =>
          verifier.verify(headers, Buffer.from(JSON.stringify(JSON.parse(rawBody.toString())))),
        ),
      ).toBe("signature_mismatch");
      expect(
        reasonFrom(() =>
          createWebhookVerifierWithClock(
            otherKey,
            () => Number(capture.webhookTimestamp) * 1000,
          ).verify(headers, rawBody),
        ),
      ).toBe("signature_mismatch");
    }
  });
});

function sign(secret: string, id: string, timestamp: string, body: string | Buffer): string {
  const hmac = createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(id, "utf-8")
    .update(".", "utf-8")
    .update(timestamp, "utf-8")
    .update(".", "utf-8")
    .update(body);
  return `v1,${hmac.digest("base64")}`;
}

function buildEnvelope(
  secret: string,
  body: object,
  options: { id?: string; timestamp?: number | string } = {},
): { headers: Record<string, string>; body: string } {
  const id = options.id ?? "msg_test_123";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  const signature = sign(secret, id, timestamp, rawBody);
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    },
    body: rawBody,
  };
}

const validDelivery = {
  type: "message.delivered" as const,
  webhook_id: BODY_WEBHOOK_ID,
  timestamp: "2026-07-14T15:03:21.987654321Z",
  data: {
    account_id: "835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa",
    event: "on_delivered" as const,
    from: "sender@example.com",
    recipient: "receiver@example.com",
    subject: "Test",
    message_id_header: "<delivery@example.com>",
    id: "message-1",
  },
};

/**
 * A routed-message envelope carrying every field the producer emits. Only
 * `headers` has `omitempty` on the Go struct, so everything else is present on
 * every delivery — including the empty strings.
 */
function routeEventWithAttachments(
  attachments: Array<Partial<WebhookComponents["schemas"]["RouteAttachment"]>>,
): { type: "message.routing"; route_id: string; timestamp: string; data: RouteEventDataFixture } {
  return {
    type: "message.routing",
    route_id: "b33c56aa-4bb8-4796-a44e-e204c2a9cb49",
    timestamp: "2026-07-14T15:04:07.123456789Z",
    data: {
      id: "route-message-1",
      from: "Customer <customer@example.net>",
      reply_to: "customer@example.net",
      to: "inbound@example.com",
      subject: "Attachment test",
      message_id: "<routing@example.net>",
      size: 2048,
      spam_score: 0.1,
      bounce: false,
      cc: "",
      date: "Tue, 14 Jul 2026 15:04:05 +0000",
      in_reply_to: "",
      references: "",
      auto_submitted: "",
      html_body: '<p><img src="cid:logo-123"></p>',
      plain_body: "see attached",
      reply_from_plain_body: "",
      // Deliberately NOT defaulted: a caller that omits a key must produce a
      // payload that omits it, or absence cannot be tested at all.
      attachments: attachments.map((attachment) => ({ ...attachment })),
    },
  };
}

interface RouteEventDataFixture {
  id: string;
  from: string;
  reply_to: string;
  to: string;
  subject: string;
  message_id: string;
  size: number;
  spam_score: number;
  bounce: boolean;
  cc: string;
  date: string;
  in_reply_to: string;
  references: string;
  auto_submitted: string;
  html_body: string;
  plain_body: string;
  reply_from_plain_body: string;
  attachments: Array<Partial<WebhookComponents["schemas"]["RouteAttachment"]>>;
}

function reasonFrom(run: () => unknown): WebhookVerificationReason {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AhaSendWebhookVerificationError);
    return (error as AhaSendWebhookVerificationError).reason;
  }
  throw new Error("expected webhook verification to fail");
}

describe("WebhookVerifier", () => {
  it("verifies a correctly signed payload", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: { id: "msg_1" },
    });
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("parses verified payload as a typed event", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, validDelivery);
    const event = verifier.parse(headers, body);
    expect(event.type).toBe("message.delivered");
    expect(isKnownWebhookEvent(event)).toBe(true);
    if (isKnownWebhookEvent(event) && event.type === "message.delivered") {
      expect(event.data.recipient).toBe("receiver@example.com");
    }
  });

  it("parses signed configured-webhook bodies with absent or present webhook IDs", () => {
    const verifier = new WebhookVerifier(SECRET);

    for (const payload of CONFIGURED_WEBHOOK_BODIES) {
      for (const bodyPayload of [payload, { ...payload, webhook_id: BODY_WEBHOOK_ID }]) {
        const { headers, body } = buildEnvelope(SECRET, bodyPayload);
        expect(verifier.parse(headers, body)).toEqual(bodyPayload);
      }
    }
  });

  it("validates every signed synthetic body and preserves is_bot compatibility cases", () => {
    const manifest = JSON.parse(readFileSync(resolve(SYNTHETIC_PATH, "manifest.json"), "utf8")) as {
      fixtures: Array<{
        fixtureId: string;
        bodyPath: string;
        rawBodySha256: string;
        keyPath: string;
        keySha256: string;
        webhookId: string;
        webhookTimestamp: string;
        signature: string;
        expectedResult: "valid";
      }>;
    };

    expect(
      manifest.fixtures
        .map(({ fixtureId }) => fixtureId)
        .filter((fixtureId) => IS_BOT_FIXTURE_EXPECTATIONS.has(fixtureId)),
    ).toEqual([...IS_BOT_FIXTURE_EXPECTATIONS.keys()]);

    for (const fixture of manifest.fixtures) {
      const rawBody = readFileSync(resolve(ROOT, fixture.bodyPath));
      const keyFile = readFileSync(resolve(ROOT, fixture.keyPath));
      const key = keyFile.subarray(0, keyFile.length - 1);
      const payload = JSON.parse(rawBody.toString("utf8")) as unknown;

      expect(sha256Hex(rawBody), fixture.fixtureId).toBe(fixture.rawBodySha256);
      expect(sha256Hex(key), fixture.fixtureId).toBe(fixture.keySha256);
      expect(
        sign(key.toString("utf8"), fixture.webhookId, fixture.webhookTimestamp, rawBody),
        fixture.fixtureId,
      ).toBe(fixture.signature);
      expect(validateKnownWebhookEvent(payload), fixture.fixtureId).toBe(true);

      const event = createWebhookVerifierWithClock(
        key.toString("utf8"),
        () => Number(fixture.webhookTimestamp) * 1000,
      ).parse(
        {
          "webhook-id": fixture.webhookId,
          "webhook-timestamp": fixture.webhookTimestamp,
          "webhook-signature": fixture.signature,
        },
        rawBody,
      );
      expect(event, fixture.fixtureId).toEqual(payload);

      const expectedIsBot = IS_BOT_FIXTURE_EXPECTATIONS.get(fixture.fixtureId);
      if (expectedIsBot !== undefined) {
        const data = record(event.data);
        if (expectedIsBot === "absent") {
          expect(Object.hasOwn(data, "is_bot"), fixture.fixtureId).toBe(false);
        } else {
          expect(data["is_bot"], fixture.fixtureId).toBe(expectedIsBot);
        }
      }
    }
  });

  it("rejects a tampered body", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    const tamperedBody = body.replace("message.delivered", "message.opened");
    try {
      verifier.verify(headers, tamperedBody);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AhaSendWebhookVerificationError);
      expect((err as AhaSendWebhookVerificationError).reason).toBe("signature_mismatch");
    }
  });

  it("rejects a wrong secret", () => {
    const verifier = new WebhookVerifier("a-different-secret-entirely");
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, body)).toThrow(AhaSendWebhookVerificationError);
  });

  it("rejects an outdated timestamp (replay attack)", () => {
    const verifier = new WebhookVerifier(SECRET, { toleranceSeconds: 300 });
    const oldTs = Math.floor(Date.now() / 1000) - 1000;
    const { headers, body } = buildEnvelope(
      SECRET,
      { type: "message.delivered", timestamp: "2020-01-01T00:00:00Z", data: {} },
      { timestamp: oldTs },
    );
    try {
      verifier.verify(headers, body);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as AhaSendWebhookVerificationError).reason).toBe("timestamp_outside_tolerance");
    }
  });

  it("rejects when required headers are missing", () => {
    const verifier = new WebhookVerifier(SECRET);
    expect(() => verifier.verify({}, "{}")).toThrow(/missing_webhook_id/);
  });

  it("treats the aha-whsec- prefix as part of the secret bytes (matches Go SDK)", () => {
    // AhaSend's secret format is `aha-whsec-<key>`. The Go SDK uses the
    // entire string (prefix included) as the HMAC key bytes, and so does
    // the AhaSend server. The TS verifier must do the same.
    const verifier = new WebhookVerifier(PREFIXED_SECRET);
    const { headers, body } = buildEnvelope(PREFIXED_SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("CROSS-SDK FIXTURE: accepts a base64-legal raw secret without decoding it", () => {
    // `MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw` is 32 alphanumeric characters —
    // it is base64-legal (length % 4 == 0, only base64 alphabet). The
    // previous verifier base64-decoded it, producing different key bytes
    // from what the Go SDK and the AhaSend server produce, and rejected
    // every webhook with signature_mismatch. This test pins the fix.
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("accepts a Buffer body", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, Buffer.from(body, "utf-8"))).not.toThrow();
  });

  it("accepts a plain Uint8Array body and decodes it as UTF-8", () => {
    // A Buffer passes either way, because `Buffer#toString("utf-8")` honours
    // its argument. A plain Uint8Array is the case the published type now
    // admits, and it is the one that breaks under `rawBody.toString("utf-8")`:
    // `Uint8Array#toString` ignores every argument and returns comma-joined
    // byte values, so a valid webhook reaches JSON.parse as "123,34,116,..."
    // and is rejected as invalid_json. The non-ASCII subject additionally pins
    // UTF-8 decoding rather than one character per byte.
    const payload = {
      ...validDelivery,
      data: { ...validDelivery.data, subject: "Grüße 🎉" },
    };
    const { headers, body } = buildEnvelope(SECRET, payload);
    const bytes = Uint8Array.from(Buffer.from(body, "utf-8"));
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect(bytes.byteLength).toBeGreaterThan(body.length);

    const verifier = new WebhookVerifier(SECRET);
    expect(() => verifier.verify(headers, bytes)).not.toThrow();
    expect(verifier.parse(headers, bytes)).toEqual(payload);
  });

  it("keeps a leading byte-order mark in the decoded body", () => {
    // Decoding moved from `Buffer#toString("utf-8")` to a TextDecoder, which
    // strips a leading U+FEFF by default. That would quietly start accepting
    // bodies that were previously rejected, so the decoder is constructed with
    // `ignoreBOM: true` and this pins the result. The signature covers the raw
    // bytes either way, so nothing here is load-bearing for verification —
    // only for which bodies reach JSON.parse intact.
    const json = JSON.stringify(validDelivery);
    const bytes = Uint8Array.from(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf-8")]),
    );
    const id = "msg_bom";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign(SECRET, id, timestamp, Buffer.from(bytes)),
    };

    const verifier = new WebhookVerifier(SECRET);
    expect(() => verifier.verify(headers, bytes)).not.toThrow();
    expect(() => verifier.parse(headers, bytes)).toThrowError(
      expect.objectContaining({ reason: "invalid_json" }),
    );
  });

  it("accepts multiple signatures separated by spaces (key rotation)", () => {
    const verifier = new WebhookVerifier(SECRET);
    const ts = Math.floor(Date.now() / 1000);
    const id = "msg_1";
    const body = JSON.stringify({ type: "message.delivered", data: {} });
    const validSig = sign(SECRET, id, String(ts), body);
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": `v1,wrong-signature ${validSig} v1,another-wrong`,
    };
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("rejects malformed non-ASCII signatures with the closed mismatch reason", () => {
    const { headers, body } = buildEnvelope(SECRET, validDelivery);
    headers["webhook-signature"] = "é".repeat(headers["webhook-signature"]!.length);

    expect(reasonFrom(() => new WebhookVerifier(SECRET).verify(headers, body))).toBe(
      "signature_mismatch",
    );
  });

  it("accepts a Headers instance", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    const h = new Headers(headers);
    expect(() => verifier.verify(h, body)).not.toThrow();
  });

  it("accepts a Headers that is not the realm's global one", () => {
    // A separately installed undici or node-fetch, an edge runtime, or any
    // value that crossed a realm boundary is not `instanceof` the realm's
    // global Headers. Detecting by class sent those down the plain-record
    // path, where Object.entries returns [] because the headers live in
    // internal slots — so every header read as missing, the adapters answered
    // 400, and 100 consecutive errors disabled the webhook. Nothing here
    // inherits from the global Headers.
    const { headers, body } = buildEnvelope(SECRET, validDelivery);

    class ForeignHeaders {
      readonly #entries = new Map<string, string>();
      constructor(init: Record<string, string>) {
        for (const [name, value] of Object.entries(init)) {
          this.#entries.set(name.toLowerCase(), value);
        }
      }
      get(name: string): string | null {
        return this.#entries.get(name.toLowerCase()) ?? null;
      }
    }

    const foreign = new ForeignHeaders(headers);
    expect(foreign).not.toBeInstanceOf(Headers);
    expect(new WebhookVerifier(SECRET).parse(foreign, body)).toEqual(validDelivery);

    // A bare getter object — the minimum a header source can offer.
    const minimal = { get: (name: string) => headers[name] };
    expect(() => new WebhookVerifier(SECRET).verify(minimal, body)).not.toThrow();

    // Case-insensitive lookup remains the header source's responsibility, as
    // it is for the global Headers.
    const map = new Map(Object.entries(headers));
    expect(() => new WebhookVerifier(SECRET).verify(map, body)).not.toThrow();
  });

  it("keeps reading a plain record that happens to carry a get header", () => {
    // Capability detection must not misread a header literally named `get`.
    // A plain record's values are strings or string arrays, never functions,
    // so the two shapes stay distinguishable.
    const { headers, body } = buildEnvelope(SECRET, validDelivery);
    const withGetHeader = { ...headers, get: "max-age=0" };

    expect(new WebhookVerifier(SECRET).parse(withGetHeader, body)).toEqual(validDelivery);
  });

  it("treats a record whose get is a function as a header getter", () => {
    // The one shape whose behaviour the capability check actually changed, and
    // the boundary of the guarantee above: a *function* under `get` wins over
    // the sibling header keys. TypeScript cannot produce this from the
    // documented record type, but an untyped caller can, so pin it as intended
    // rather than accidental. Delegating to the record makes it verify;
    // ignoring the record makes every header missing.
    const { headers, body } = buildEnvelope(SECRET, validDelivery);

    const delegating = { ...headers, get: (name: string) => headers[name] };
    expect(new WebhookVerifier(SECRET).parse(delegating, body)).toEqual(validDelivery);

    const ignoring = { ...headers, get: () => undefined };
    expect(reasonFrom(() => new WebhookVerifier(SECRET).verify(ignoring, body))).toBe(
      "missing_webhook_id",
    );
  });

  it("treats a non-string header value as absent, from either header shape", () => {
    // A header source is caller supplied: a foreign Headers is not bound by
    // the WHATWG return contract, and a JavaScript caller can put anything in
    // a plain record. Both must report a missing header rather than handing a
    // number to node:crypto, which throws a bare ERR_INVALID_ARG_TYPE from
    // inside sign(). Failing closed is correct on the signature path.
    const { headers, body } = buildEnvelope(SECRET, validDelivery);
    const numericTimestamp = Number(headers[WEBHOOK_TIMESTAMP_HEADER]);

    const foreign = {
      get: (name: string) =>
        name === WEBHOOK_TIMESTAMP_HEADER ? (numericTimestamp as unknown as string) : headers[name],
    };
    expect(reasonFrom(() => new WebhookVerifier(SECRET).verify(foreign, body))).toBe(
      "missing_webhook_timestamp",
    );

    const record = {
      ...headers,
      [WEBHOOK_TIMESTAMP_HEADER]: numericTimestamp as unknown as string,
    };
    expect(reasonFrom(() => new WebhookVerifier(SECRET).verify(record, body))).toBe(
      "missing_webhook_timestamp",
    );
  });

  it("constructor throws on empty secret", () => {
    expect(() => new WebhookVerifier("")).toThrow(/secret/);
  });

  it("PINNED CROSS-SDK FIXTURE: signature byte-stability under decodeSecret refactors", () => {
    // (secret, id, timestamp, body) tuple. The expected signature is
    // computed once using the byte-exact algorithm the Go SDK
    // (ahasend-go/webhooks/webhooks.go) and the AhaSend server use,
    // then hardcoded so that any future change to `decodeSecret` —
    // including a well-intentioned base64 reintroduction or an attempt
    // to strip a prefix — will fail this test loudly.
    const secret = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const id = "msg_2KbAaY8M";
    const timestamp = 1700000000;
    const body = '{"type":"message.delivered","data":{}}';

    // The expected signature is independently computed so a secret decoding,
    // prefix stripping, timestamp reconstruction, or raw-byte regression fails.
    const expectedDigest = createHmac("sha256", Buffer.from(secret, "utf-8"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    const expectedSignature = `v1,${expectedDigest}`;

    const verifier = createWebhookVerifierWithClock(secret, () => timestamp * 1000);
    expect(() =>
      verifier.verify(
        {
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": expectedSignature,
        },
        body,
      ),
    ).not.toThrow();
  });

  it("normalizes deprecated route.message input after full validation", () => {
    const payload = {
      type: "route.message",
      route_id: "abe11757-2886-4b55-96f1-0e0afc95795a",
      timestamp: "2026-07-14T15:04:07Z",
      data: {
        id: "route-message-1",
        from: "sender@example.com",
        reply_to: "sender@example.com",
        to: "support@example.com",
        subject: "Help",
        message_id: "<route@example.com>",
        size: 512,
        spam_score: 0,
        bounce: false,
        cc: "",
        date: "Tue, 14 Jul 2026 15:04:05 +0000",
        in_reply_to: "",
        references: "",
        auto_submitted: "",
        reply_from_plain_body: "",
        html_body: "<p>Help</p>",
        plain_body: "Help",
        // Emitted even when a route does not include attachments: the Go
        // slice is initialised to empty rather than left nil.
        attachments: [],
      },
    };
    const { headers, body } = buildEnvelope(SECRET, payload);

    const event = new WebhookVerifier(SECRET).parse(headers, body);

    expect(event).toEqual({ ...payload, type: "message.routing" });
    expect(isKnownWebhookEvent(event)).toBe(true);
  });

  it("validates complete known payloads and complete unknown envelopes", () => {
    const invalidKnown = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: validDelivery.timestamp,
      data: { id: "incomplete" },
    });
    expect(
      reasonFrom(() => new WebhookVerifier(SECRET).parse(invalidKnown.headers, invalidKnown.body)),
    ).toBe("invalid_event");

    const future = {
      type: "message.future_event",
      timestamp: "2026-07-22T12:00:00Z",
      data: { future_field: true },
      future_envelope_field: "preserved",
    };
    const validUnknown = buildEnvelope(SECRET, future);
    expect(new WebhookVerifier(SECRET).parse(validUnknown.headers, validUnknown.body)).toEqual(
      future,
    );

    const incompleteUnknown = buildEnvelope(SECRET, {
      type: "message.future_event",
      timestamp: future.timestamp,
      data: "not-an-object",
    });
    expect(
      reasonFrom(() =>
        new WebhookVerifier(SECRET).parse(incompleteUnknown.headers, incompleteUnknown.body),
      ),
    ).toBe("invalid_payload");
  });

  it("accepts sender and recipient mailboxes that are not bare RFC 5321 addresses", () => {
    // Campaign deliveries carry a display-name mailbox built from the
    // campaign's from-name, and inbound routes carry whatever an arbitrary
    // external sender used. Rejecting these returns 400 to AhaSend, and 100
    // consecutive 400s disable the webhook — including its transactional
    // events. A receiver must be liberal about address shape.
    const mailboxes = [
      "Acme Campaigns <news@example.com>",
      '"Doe, John" <john@example.com>',
      "josé@example.com",
      "user@localhost",
    ];

    for (const mailbox of mailboxes) {
      const payload = {
        ...validDelivery,
        data: { ...validDelivery.data, from: mailbox, recipient: mailbox },
      };
      const { headers, body } = buildEnvelope(SECRET, payload);
      expect(new WebhookVerifier(SECRET).parse(headers, body), mailbox).toEqual(payload);
    }
  });

  it("carries attachment disposition through to the parsed route event", () => {
    // Route attachments mix conventional attachments, inline `cid:` parts, and
    // filename-bearing parts with no Content-Disposition header. Without
    // `disposition` a receiver cannot tell an embedded image from a real
    // attachment, and the field was present on the wire but absent from the
    // type. The producer sends it without omitempty
    // (ahasend/cmd/job-runner/jobs/routes/message_routing.go:78).
    const payload = routeEventWithAttachments([
      {
        filename: "logo.png",
        content_type: "image/png",
        content_id: "logo-123",
        disposition: "inline",
        data: "AAAA",
      },
      {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        content_id: "",
        disposition: "attachment",
        data: "BBBB",
      },
    ]);

    const { headers, body } = buildEnvelope(SECRET, payload);
    const event = new WebhookVerifier(SECRET).parse(headers, body);

    expect(event).toEqual(payload);
    if (isKnownWebhookEvent(event) && event.type === "message.routing") {
      const attachments = event.data.attachments ?? [];
      expect(attachments.map((attachment) => attachment.disposition)).toEqual([
        "inline",
        "attachment",
      ]);
      expect(
        attachments.filter((attachment) => attachment.disposition === "inline")[0]?.content_id,
      ).toBe("logo-123");
    } else {
      throw new Error("expected a routing event");
    }
  });

  it("separates a Content-Disposition-less embedded image from a real attachment", () => {
    // The shape Gmail and Outlook actually produce: a multipart/related part
    // with a Content-ID and NO Content-Disposition header. Verified against
    // enmime v1.1.0 (the revision ahasend/go.mod pins) driving the
    // producer's own routeAttachments(), which emits
    // it as disposition "" with a populated content_id. `content_id` is ""
    // rather than absent when there is no Content-ID, because the producer
    // struct has no omitempty.
    //
    // This is why the documented split keys off content_id: a
    // `disposition === "inline"` filter files this embedded image under real
    // attachments, which is the exact confusion `disposition` was added to
    // resolve.
    const payload = routeEventWithAttachments([
      {
        filename: "logo.png",
        content_type: "image/png",
        content_id: "logo-123",
        disposition: "",
        data: "AAAA",
      },
      {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        content_id: "",
        disposition: "attachment",
        data: "BBBB",
      },
    ]);
    const { headers, body } = buildEnvelope(SECRET, payload);
    const event = new WebhookVerifier(SECRET).parse(headers, body);

    if (!isKnownWebhookEvent(event) || event.type !== "message.routing") {
      throw new Error("expected a routing event");
    }
    const attachments = event.data.attachments ?? [];

    const embedded = new Map(
      attachments.filter((attachment) => attachment.content_id).map((a) => [a.content_id, a]),
    );
    const files = attachments.filter(
      (attachment) =>
        !(attachment.content_id && event.data.html_body.includes(`cid:${attachment.content_id}`)),
    );

    expect([...embedded.keys()]).toEqual(["logo-123"]);
    expect(files.map((file) => file.filename)).toEqual(["invoice.pdf"]);

    // The naive disposition-only split gets this wrong, which is why the
    // documentation steers away from it.
    expect(attachments.filter((attachment) => attachment.disposition === "inline")).toHaveLength(0);
  });

  it("accepts any disposition token the sending server wrote", () => {
    // The divergence from the upstream spec is on the ENUM, not on presence.
    // `disposition` is parsed from an inbound message's Content-Disposition
    // header, and an application/octet-stream part carries any RFC 2183
    // extension token through verbatim, so constraining the value would let a
    // stranger's email return 400 and disable the route webhook after 100 of
    // them. Presence is a different question and is mirrored from the producer
    // — see the required-key coverage below.
    const attachment = {
      filename: "f.bin",
      content_type: "application/octet-stream",
      data: "AAAA",
    };
    for (const disposition of ["attachment", "inline", "", "form-data", "x-vendor-thing"]) {
      const payload = routeEventWithAttachments([{ ...attachment, content_id: "", disposition }]);
      const { headers, body } = buildEnvelope(SECRET, payload);
      expect(new WebhookVerifier(SECRET).parse(headers, body), disposition).toEqual(payload);
    }

    // Still a string, though — a receiver that reads it must not get an object.
    const wrongType = routeEventWithAttachments([
      { ...attachment, content_id: "", disposition: "" },
    ]);
    (wrongType.data.attachments[0] as Record<string, unknown>)["disposition"] = 1;
    const bad = buildEnvelope(SECRET, wrongType);
    expect(reasonFrom(() => new WebhookVerifier(SECRET).parse(bad.headers, bad.body))).toBe(
      "invalid_event",
    );
  });

  it("requires every key the route producer emits unconditionally", () => {
    // `required` mirrors the producer's struct tags: in MessageData and
    // MessageAttachmentsPayload only `headers` carries `omitempty`, so every
    // other key is on the wire for every delivery.
    //
    // Without these assertions the only thing holding the required lists in
    // place is the artifact-vs-source regeneration check, which a spec resync
    // satisfies trivially — it compares the generated files to the YAML, not
    // the YAML to the producer. That is exactly the path by which upstream's
    // `disposition` enum could come back.
    const complete = routeEventWithAttachments([
      {
        filename: "logo.png",
        content_type: "image/png",
        content_id: "logo-123",
        disposition: "",
        data: "AAAA",
      },
    ]);
    expect(validateKnownWebhookEvent(complete)).toBe(true);

    const dataKeys = [
      "id",
      "from",
      "reply_to",
      "to",
      "subject",
      "message_id",
      "size",
      "spam_score",
      "bounce",
      "cc",
      "date",
      "in_reply_to",
      "references",
      "auto_submitted",
      "html_body",
      "plain_body",
      "reply_from_plain_body",
      "attachments",
    ] as const;
    for (const key of dataKeys) {
      const missing = structuredClone(complete);
      Reflect.deleteProperty(missing.data, key);
      expect(validateKnownWebhookEvent(missing), `data.${key}`).toBe(false);
    }

    for (const key of ["filename", "content_type", "content_id", "disposition", "data"] as const) {
      const missing = structuredClone(complete);
      Reflect.deleteProperty(missing.data.attachments[0]!, key);
      expect(validateKnownWebhookEvent(missing), `attachment.${key}`).toBe(false);
    }

    // `headers` is the one field the producer marks omitempty, and `complete`
    // already omits it — so the passing assertion above is also the proof that
    // it stayed optional.
    expect(Object.hasOwn(complete.data, "headers")).toBe(false);
  });

  it("keeps enforcing structural formats that discriminate the envelope", () => {
    // Relaxing address formats must not relax uuid or date-time, which
    // identify the account and order the event stream.
    const badAccountId = buildEnvelope(SECRET, {
      ...validDelivery,
      data: { ...validDelivery.data, account_id: "not-a-uuid" },
    });
    expect(
      reasonFrom(() => new WebhookVerifier(SECRET).parse(badAccountId.headers, badAccountId.body)),
    ).toBe("invalid_event");

    const badTimestamp = buildEnvelope(SECRET, { ...validDelivery, timestamp: "last Tuesday" });
    expect(
      reasonFrom(() => new WebhookVerifier(SECRET).parse(badTimestamp.headers, badTimestamp.body)),
    ).toBe("invalid_event");
  });

  it("accepts is_bot as a boolean or absent, matching the wire contract", () => {
    // Optional here covers both producers. The open event declares
    // `IsBot *bool` with omitempty, so the wire carries `true`, `false`, or
    // nothing; the click event declares a bare `bool` and always sends it. A
    // contract rule (scripts/generate-contracts.mjs) forbids ever requiring
    // this field, because a campaign producer has shipped a `string` zero
    // value here and failing closed on it costs the whole webhook. Pinned so a
    // producer regression to a non-boolean is caught here rather than by a
    // disabled webhook.
    const opened = {
      ...validDelivery,
      type: "message.opened" as const,
      data: {
        ...validDelivery.data,
        event: "on_opened" as const,
        user_agent: "Mozilla/5.0",
        ip: "192.0.2.1",
      },
    };

    for (const isBot of [true, false]) {
      const payload = { ...opened, data: { ...opened.data, is_bot: isBot } };
      const { headers, body } = buildEnvelope(SECRET, payload);
      expect(new WebhookVerifier(SECRET).parse(headers, body), String(isBot)).toEqual(payload);
    }

    const absent = buildEnvelope(SECRET, opened);
    expect(new WebhookVerifier(SECRET).parse(absent.headers, absent.body)).toEqual(opened);

    const stringified = buildEnvelope(SECRET, {
      ...opened,
      data: { ...opened.data, is_bot: "" },
    });
    expect(
      reasonFrom(() => new WebhookVerifier(SECRET).parse(stringified.headers, stringified.body)),
    ).toBe("invalid_event");
  });

  it("reports malformed JSON separately from invalid envelopes", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const id = "msg-json";
    const malformed = "{";
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign(SECRET, id, timestamp, malformed),
    };
    expect(reasonFrom(() => new WebhookVerifier(SECRET).parse(headers, malformed))).toBe(
      "invalid_json",
    );

    for (const body of ["null", "[]", '{"type":1,"data":{}}']) {
      headers["webhook-signature"] = sign(SECRET, id, timestamp, body);
      expect(reasonFrom(() => new WebhookVerifier(SECRET).parse(headers, body))).toBe(
        "invalid_payload",
      );
    }
  });

  it("looks up plain header records case-insensitively without changing signed values", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const id = "Case-Sensitive-Value";
    const body = JSON.stringify(validDelivery);
    const signature = sign(SECRET, id, timestamp, body);
    const headers = {
      "WebHook-ID": [id],
      "WEBHOOK-TIMESTAMP": timestamp,
      "Webhook-Signature": signature,
    };

    expect(() => new WebhookVerifier(SECRET).verify(headers, body)).not.toThrow();
    expect(() =>
      new WebhookVerifier(SECRET).verify({ ...headers, "WebHook-ID": [id.toLowerCase()] }, body),
    ).toThrow(/signature_mismatch/);
  });

  it("signs the exact body bytes and rejects JSON reserialization", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const id = "msg-raw-body";
    const body = '{"type":"future.event", "timestamp":"2026-07-22T12:00:00Z","data":{}}';
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign(SECRET, id, timestamp, Buffer.from(body, "utf-8")),
    };

    expect(() => new WebhookVerifier(SECRET).verify(headers, Buffer.from(body))).not.toThrow();
    expect(
      reasonFrom(() =>
        new WebhookVerifier(SECRET).verify(headers, JSON.stringify(JSON.parse(body))),
      ),
    ).toBe("signature_mismatch");
  });

  it("preserves the exact timestamp header string when calculating the HMAC", () => {
    const timestamp = "01784041401";
    const id = "msg-exact-timestamp";
    const body = "{}";
    const verifier = createWebhookVerifierWithClock(SECRET, () => Number(timestamp) * 1000);
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign(SECRET, id, timestamp, body),
    };

    expect(() => verifier.verify(headers, body)).not.toThrow();
    expect(headers["webhook-signature"]).not.toBe(
      sign(SECRET, id, String(Number(timestamp)), body),
    );
  });

  it("accepts the tolerance boundary and rejects ancient and future timestamps", () => {
    const nowSeconds = 1_800_000_000;
    const verifier = createWebhookVerifierWithClock(SECRET, () => nowSeconds * 1000, {
      toleranceSeconds: 300,
    });
    const body = "{}";
    for (const timestamp of [nowSeconds - 300, nowSeconds + 300]) {
      const value = String(timestamp);
      expect(() =>
        verifier.verify(
          {
            "webhook-id": "msg-boundary",
            "webhook-timestamp": value,
            "webhook-signature": sign(SECRET, "msg-boundary", value, body),
          },
          body,
        ),
      ).not.toThrow();
    }
    for (const timestamp of [nowSeconds - 301, nowSeconds + 301]) {
      const value = String(timestamp);
      expect(
        reasonFrom(() =>
          verifier.verify(
            {
              "webhook-id": "msg-outside",
              "webhook-timestamp": value,
              "webhook-signature": sign(SECRET, "msg-outside", value, body),
            },
            body,
          ),
        ),
      ).toBe("timestamp_outside_tolerance");
    }
  });

  it("rejects non-integer, nonfinite, negative, and unsafe timestamp values", () => {
    const verifier = new WebhookVerifier(SECRET);
    for (const timestamp of ["NaN", "Infinity", "1.5", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(
        reasonFrom(() =>
          verifier.verify(
            {
              "webhook-id": "msg-invalid-time",
              "webhook-timestamp": timestamp,
              "webhook-signature": "v1,invalid",
            },
            "{}",
          ),
        ),
        timestamp,
      ).toBe("invalid_timestamp");
    }
  });

  it("accepts safe-integer timestamp endpoints before applying the time window", () => {
    const verifier = createWebhookVerifierWithClock(SECRET, () => 0, {
      toleranceSeconds: Number.MAX_SAFE_INTEGER,
    });
    const body = "{}";
    for (const timestamp of ["0", String(Number.MAX_SAFE_INTEGER)]) {
      expect(() =>
        verifier.verify(
          {
            "webhook-id": "msg-safe-endpoint",
            "webhook-timestamp": timestamp,
            "webhook-signature": sign(SECRET, "msg-safe-endpoint", timestamp, body),
          },
          body,
        ),
      ).not.toThrow();
    }
  });

  it("requires a finite positive safe-integer tolerance and a valid clock", () => {
    for (const toleranceSeconds of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        () => new WebhookVerifier(SECRET, { toleranceSeconds }),
        String(toleranceSeconds),
      ).toThrow(AhaSendConfigurationError);
    }
    expect(
      () => new WebhookVerifier(SECRET, { toleranceSeconds: Number.MAX_SAFE_INTEGER }),
    ).not.toThrow();

    const envelope = buildEnvelope(SECRET, validDelivery);
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() =>
        createWebhookVerifierWithClock(SECRET, () => nowMs).verify(envelope.headers, envelope.body),
      ).toThrow(AhaSendConfigurationError);
    }
  });

  it("returns the closed missing-header reasons", () => {
    const verifier = new WebhookVerifier(SECRET);
    expect(reasonFrom(() => verifier.verify({}, "{}"))).toBe("missing_webhook_id");
    expect(reasonFrom(() => verifier.verify({ "webhook-id": "msg" }, "{}"))).toBe(
      "missing_webhook_timestamp",
    );
    expect(
      reasonFrom(() => verifier.verify({ "webhook-id": "msg", "webhook-timestamp": "1" }, "{}")),
    ).toBe("missing_webhook_signature");
  });

  it("bounds raw string and Buffer bodies by their actual byte length", () => {
    const verifier = new WebhookVerifier(SECRET, { toleranceSeconds: Number.MAX_SAFE_INTEGER });
    const timestamp = "1";
    const id = "msg-body-limit";
    const atLimit = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES, 0x61);
    expect(() =>
      verifier.verify(
        {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": sign(SECRET, id, timestamp, atLimit),
        },
        atLimit,
      ),
    ).not.toThrow();

    expect(reasonFrom(() => verifier.verify({}, Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1)))).toBe(
      "body_too_large",
    );
    expect(reasonFrom(() => verifier.verify({}, "é".repeat(MAX_WEBHOOK_BODY_BYTES / 2 + 1)))).toBe(
      "body_too_large",
    );
  });

  it("keeps secret, tolerance, and clock state out of reflection", () => {
    const verifier = createWebhookVerifierWithClock(SECRET, () => 0, {
      toleranceSeconds: 1,
    });
    expect(Object.keys(verifier)).toEqual([]);
    expect(Reflect.ownKeys(verifier)).toEqual([]);
    expect(verifier).not.toHaveProperty("key");
    expect(verifier).not.toHaveProperty("toleranceSeconds");
    expect(verifier).not.toHaveProperty("nowMs");
    expect(verifier).not.toHaveProperty("sign");
  });
});
