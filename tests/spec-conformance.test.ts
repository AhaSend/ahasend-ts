/**
 * Spec-conformance test.
 *
 * Parses the canonical AhaSend OpenAPI spec at the repository root and
 * asserts that every public resource method on `AhaSendClient` issues a
 * request whose (HTTP verb, URL-path template) is a real operation in
 * the spec. Catches:
 *
 *   - wrong verb (`POST` vs `DELETE`),
 *   - wrong path (`/wipe` vs `/all`, `/bounces` vs `/bounce`),
 *   - invented path segments (e.g. `/domains/{domain}/webhooks`),
 *   - methods that have no corresponding spec operation at all.
 *
 * Failure messages include the offending verb+path and the closest
 * spec entries, so reviewers can read the diff without opening the
 * spec.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";

type Op = { verb: string; path: string };
let specOps: Set<string>;

const SPEC_PATH = resolve(process.cwd(), "openapi.yaml");

const SENTINELS = {
  ACCOUNT_ID: "00000000-0000-0000-0000-aaaaaaaaaaaa",
  MESSAGE_ID: "msg-sentinel-id",
  KEY_ID: "key-sentinel-id",
  DOMAIN: "sentinel.example.test",
  WEBHOOK_ID: "wh-sentinel-id",
  SUPPRESSION_ID: "sup-sentinel-id",
  ROUTE_ID: "route-sentinel-id",
  USER_ID: "user-sentinel-id",
  CREDENTIAL_ID: "cred-sentinel-id",
} as const;

const SUBSTITUTIONS: Array<[string, string]> = [
  [SENTINELS.ACCOUNT_ID, "{account_id}"],
  [SENTINELS.MESSAGE_ID, "{message_id}"],
  [SENTINELS.KEY_ID, "{key_id}"],
  [SENTINELS.DOMAIN, "{domain}"],
  [SENTINELS.WEBHOOK_ID, "{webhook_id}"],
  [SENTINELS.SUPPRESSION_ID, "{suppression_id}"],
  [SENTINELS.ROUTE_ID, "{route_id}"],
  [SENTINELS.USER_ID, "{user_id}"],
  [SENTINELS.CREDENTIAL_ID, "{smtp_credential_id}"],
];

interface OpenAPIDoc {
  paths: Record<string, Record<string, unknown>>;
}

beforeAll(() => {
  const raw = readFileSync(SPEC_PATH, "utf-8");
  const doc = yaml.load(raw) as OpenAPIDoc;
  specOps = new Set();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const verb of ["get", "post", "put", "patch", "delete"]) {
      if (verb in ops) specOps.add(`${verb.toUpperCase()} ${path}`);
    }
  }
});

function templateFor(actualPath: string): string {
  let out = actualPath;
  for (const [sentinel, placeholder] of SUBSTITUTIONS) {
    out = out.split(sentinel).join(placeholder);
  }
  return out;
}

function captureClient(): { client: AhaSendClient; calls: Op[] } {
  const calls: Op[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push({
      verb: (init?.method ?? "GET").toUpperCase(),
      path: templateFor(url.pathname),
    });
    return new Response(
      JSON.stringify({
        object: "list",
        data: [],
        pagination: { has_more: false },
        message: "ok",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const client = new AhaSendClient({
    apiKey: "aha-sk-conformance",
    accountId: SENTINELS.ACCOUNT_ID,
    baseUrl: "https://api.test",
    retry: { enabled: false },
    fetch: fetchImpl,
  });

  return { client, calls };
}

function expectMatchesSpec(call: Op): void {
  const key = `${call.verb} ${call.path}`;
  if (specOps.has(key)) return;
  const samePathOps = Array.from(specOps).filter((k) => k.endsWith(call.path));
  const samePrefix = Array.from(specOps)
    .filter((k) => k.split(" ")[1]!.startsWith(call.path.split("/{")[0]!))
    .slice(0, 6);
  const hint =
    samePathOps.length > 0
      ? `Other verbs defined for this path: ${samePathOps.join(", ")}`
      : `Closest spec paths: ${samePrefix.join(", ") || "(none)"}`;
  throw new Error(
    `SDK called \`${key}\` which is not defined in openapi.yaml. ${hint}`,
  );
}

describe("Spec conformance — every SDK method maps to a real OpenAPI operation", () => {
  it("client.ping()", async () => {
    const { client, calls } = captureClient();
    await client.ping();
    expect(calls[0]).toBeDefined();
    expectMatchesSpec(calls[0]!);
  });

  describe("messages", () => {
    it("send", async () => {
      const { client, calls } = captureClient();
      await client.messages.send({
        from: { email: "a@b.com" },
        recipients: [{ email: "x@y.com" }],
        subject: "x",
      });
      expectMatchesSpec(calls[0]!);
    });

    it("sendConversation", async () => {
      const { client, calls } = captureClient();
      await client.messages.sendConversation({
        from: { email: "a@b.com" },
        to: [{ email: "x@y.com" }],
        subject: "x",
      });
      expectMatchesSpec(calls[0]!);
    });

    it("list", async () => {
      const { client, calls } = captureClient();
      await client.messages.list();
      expectMatchesSpec(calls[0]!);
    });

    it("get", async () => {
      const { client, calls } = captureClient();
      await client.messages.get(SENTINELS.MESSAGE_ID);
      expectMatchesSpec(calls[0]!);
    });

    it("cancel", async () => {
      const { client, calls } = captureClient();
      await client.messages.cancel(SENTINELS.MESSAGE_ID);
      expectMatchesSpec(calls[0]!);
    });
  });

  describe("domains", () => {
    it("list", async () => {
      const { client, calls } = captureClient();
      await client.domains.list();
      expectMatchesSpec(calls[0]!);
    });

    it("create", async () => {
      const { client, calls } = captureClient();
      await client.domains.create({ domain: "x.com" });
      expectMatchesSpec(calls[0]!);
    });

    it("get", async () => {
      const { client, calls } = captureClient();
      await client.domains.get(SENTINELS.DOMAIN);
      expectMatchesSpec(calls[0]!);
    });

    it("update", async () => {
      const { client, calls } = captureClient();
      await client.domains.update(SENTINELS.DOMAIN, {});
      expectMatchesSpec(calls[0]!);
    });

    it("delete", async () => {
      const { client, calls } = captureClient();
      await client.domains.delete(SENTINELS.DOMAIN);
      expectMatchesSpec(calls[0]!);
    });

    it("checkDns", async () => {
      const { client, calls } = captureClient();
      await client.domains.checkDns(SENTINELS.DOMAIN);
      expectMatchesSpec(calls[0]!);
    });
  });

  describe("apiKeys", () => {
    it("list", async () => {
      const { client, calls } = captureClient();
      await client.apiKeys.list();
      expectMatchesSpec(calls[0]!);
    });

    it("create", async () => {
      const { client, calls } = captureClient();
      await client.apiKeys.create({ label: "x", scopes: ["a"] });
      expectMatchesSpec(calls[0]!);
    });

    it("get", async () => {
      const { client, calls } = captureClient();
      await client.apiKeys.get(SENTINELS.KEY_ID);
      expectMatchesSpec(calls[0]!);
    });

    it("update", async () => {
      const { client, calls } = captureClient();
      await client.apiKeys.update(SENTINELS.KEY_ID, {});
      expectMatchesSpec(calls[0]!);
    });

    it("delete", async () => {
      const { client, calls } = captureClient();
      await client.apiKeys.delete(SENTINELS.KEY_ID);
      expectMatchesSpec(calls[0]!);
    });
  });

  describe("webhooks", () => {
    it("list", async () => {
      const { client, calls } = captureClient();
      await client.webhooks.list();
      expectMatchesSpec(calls[0]!);
    });

    it("create", async () => {
      const { client, calls } = captureClient();
      await client.webhooks.create({
        name: "x",
        url: "https://x",
        scope: "global",
      });
      expectMatchesSpec(calls[0]!);
    });

    it("get", async () => {
      const { client, calls } = captureClient();
      await client.webhooks.get(SENTINELS.WEBHOOK_ID);
      expectMatchesSpec(calls[0]!);
    });

    it("update", async () => {
      const { client, calls } = captureClient();
      await client.webhooks.update(SENTINELS.WEBHOOK_ID, {});
      expectMatchesSpec(calls[0]!);
    });

    it("delete", async () => {
      const { client, calls } = captureClient();
      await client.webhooks.delete(SENTINELS.WEBHOOK_ID);
      expectMatchesSpec(calls[0]!);
    });
  });

  describe("statistics", () => {
    const params = {
      from_time: "2026-01-01T00:00:00Z",
      to_time: "2026-01-02T00:00:00Z",
    };

    it("deliverability", async () => {
      const { client, calls } = captureClient();
      await client.statistics.deliverability(params);
      expectMatchesSpec(calls[0]!);
    });

    it("bounces", async () => {
      const { client, calls } = captureClient();
      await client.statistics.bounces(params);
      expectMatchesSpec(calls[0]!);
    });

    it("deliveryTimes", async () => {
      const { client, calls } = captureClient();
      await client.statistics.deliveryTimes(params);
      expectMatchesSpec(calls[0]!);
    });
  });

  describe("suppressions", () => {
    it("list", async () => {
      const { client, calls } = captureClient();
      await client.suppressions.list();
      expectMatchesSpec(calls[0]!);
    });

    it("create", async () => {
      const { client, calls } = captureClient();
      await client.suppressions.create({
        email: "x@y.com",
        expires_at: "2027-01-01T00:00:00Z",
      });
      expectMatchesSpec(calls[0]!);
    });

    it("delete", async () => {
      const { client, calls } = captureClient();
      await client.suppressions.delete({ email: "x@y.com" });
      expectMatchesSpec(calls[0]!);
    });

    it("wipe", async () => {
      const { client, calls } = captureClient();
      await client.suppressions.wipe();
      expectMatchesSpec(calls[0]!);
    });
  });

  describe("routes", () => {
    it("list", async () => {
      const { client, calls } = captureClient();
      await client.routes.list();
      expectMatchesSpec(calls[0]!);
    });

    it("create", async () => {
      const { client, calls } = captureClient();
      await client.routes.create({
        name: "r",
        url: "https://x",
        recipient: "x@y.com",
      });
      expectMatchesSpec(calls[0]!);
    });

    it("get", async () => {
      const { client, calls } = captureClient();
      await client.routes.get(SENTINELS.ROUTE_ID);
      expectMatchesSpec(calls[0]!);
    });

    it("update", async () => {
      const { client, calls } = captureClient();
      await client.routes.update(SENTINELS.ROUTE_ID, {});
      expectMatchesSpec(calls[0]!);
    });

    it("delete", async () => {
      const { client, calls } = captureClient();
      await client.routes.delete(SENTINELS.ROUTE_ID);
      expectMatchesSpec(calls[0]!);
    });
  });

  describe("accounts", () => {
    it("get", async () => {
      const { client, calls } = captureClient();
      await client.accounts.get();
      expectMatchesSpec(calls[0]!);
    });

    it("update", async () => {
      const { client, calls } = captureClient();
      await client.accounts.update({});
      expectMatchesSpec(calls[0]!);
    });

    it("listMembers", async () => {
      const { client, calls } = captureClient();
      await client.accounts.listMembers();
      expectMatchesSpec(calls[0]!);
    });

    it("addMember", async () => {
      const { client, calls } = captureClient();
      await client.accounts.addMember({ email: "x@y.com", role: "Developer" });
      expectMatchesSpec(calls[0]!);
    });

    it("removeMember", async () => {
      const { client, calls } = captureClient();
      await client.accounts.removeMember(SENTINELS.USER_ID);
      expectMatchesSpec(calls[0]!);
    });
  });

  describe("smtpCredentials", () => {
    it("list", async () => {
      const { client, calls } = captureClient();
      await client.smtpCredentials.list();
      expectMatchesSpec(calls[0]!);
    });

    it("create", async () => {
      const { client, calls } = captureClient();
      await client.smtpCredentials.create({ name: "c", scope: "global" });
      expectMatchesSpec(calls[0]!);
    });

    it("get", async () => {
      const { client, calls } = captureClient();
      await client.smtpCredentials.get(SENTINELS.CREDENTIAL_ID);
      expectMatchesSpec(calls[0]!);
    });

    it("delete", async () => {
      const { client, calls } = captureClient();
      await client.smtpCredentials.delete(SENTINELS.CREDENTIAL_ID);
      expectMatchesSpec(calls[0]!);
    });
  });
});
