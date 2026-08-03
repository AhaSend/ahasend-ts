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
const OPTIONAL_WEBHOOK_ID = "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1";
const IS_BOT_FIXTURE_EXPECTATIONS = new Map<string, boolean | "absent">([
  ["message-opened-bot-true", true],
  ["message-clicked-bot-false", false],
  ["message-opened-bot-absent", "absent"],
]);
const CONFIGURED_WEBHOOK_BODIES = [
  {
    type: "message.delivered",
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

  it("regenerates webhook output deterministically and passes clean check mode", async () => {
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
  });

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

  it("accepts configured-webhook envelopes with absent or present body webhook IDs", () => {
    for (const payload of CONFIGURED_WEBHOOK_BODIES) {
      expect(validateKnownWebhookEvent(payload), `${payload.type} without webhook_id`).toBe(true);
      expect(
        validateKnownWebhookEvent({ ...payload, webhook_id: OPTIONAL_WEBHOOK_ID }),
        `${payload.type} with webhook_id`,
      ).toBe(true);
    }
  });

  it("validates RFC 3339 date-times and the complete UUID format", () => {
    const clicked = {
      type: "message.clicked",
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
        to: "support@example.com",
        subject: "Help",
        message_id: "<route@example.com>",
        size: 512,
        bounce: false,
        html_body: "<p>Help</p>",
        plain_body: "Help",
        attachments: [{ filename: "note.txt", content_type: "text/plain", data: "SGVsbG8=" }],
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
  webhook_id: "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1",
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
      for (const bodyPayload of [payload, { ...payload, webhook_id: OPTIONAL_WEBHOOK_ID }]) {
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
        to: "support@example.com",
        subject: "Help",
        message_id: "<route@example.com>",
        size: 512,
        bounce: false,
        html_body: "<p>Help</p>",
        plain_body: "Help",
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
    // The producer sends `IsBot *bool` with omitempty, so the wire carries
    // `true`, `false`, or nothing at all. Pinned so a producer regression to
    // a non-boolean is caught here rather than by a disabled webhook.
    const opened = {
      type: "message.opened" as const,
      timestamp: validDelivery.timestamp,
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
