import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectOperations, parseOpenApi } from "../scripts/generate-contracts.mjs";
import { generateApiReference } from "../scripts/generate-docs.mjs";
import { RESOURCE_AUTHORIZATION } from "../src/generated/operations.js";
import { OPERATION_PROFILE } from "../src/generated/operation-profile.js";

const repositoryRoot = process.cwd();
const referencePath = resolve(repositoryRoot, "docs/api-reference.md");
const openApiSource = readFileSync(resolve(repositoryRoot, "openapi.yaml"), "utf8");
const document = parseOpenApi(openApiSource);
const operations = collectOperations(document);

function section(reference: string, kind: "operation" | "iterator", operationId: string): string {
  const marker = `<!-- ${kind}: ${operationId} -->`;
  const start = reference.indexOf(marker);
  if (start < 0) throw new TypeError(`Missing ${marker}`);
  const next = reference.indexOf("<!-- ", start + marker.length);
  return reference.slice(start, next < 0 ? undefined : next);
}

function securityScopes(operation: Readonly<Record<string, unknown>>): string[] {
  const requirements = operation["security"];
  if (!Array.isArray(requirements)) return [];
  return requirements.flatMap((requirement) =>
    Object.values(requirement as Readonly<Record<string, string[]>>).flat(),
  );
}

describe("generated API reference", () => {
  it("reproduces the committed reference byte-for-byte", async () => {
    const generated = await generateApiReference();
    expect(readFileSync(referencePath, "utf8")).toBe(generated);

    const check = spawnSync(process.execPath, ["scripts/generate-docs.mjs", "--check"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it("accounts for all 56 methods and nine iterators exactly once", async () => {
    const reference = await generateApiReference();
    const methodMarkers = [...reference.matchAll(/<!-- operation: ([A-Za-z0-9]+) -->/g)].map(
      ([, operationId]) => operationId,
    );
    const iteratorMarkers = [...reference.matchAll(/<!-- iterator: ([A-Za-z0-9]+) -->/g)].map(
      ([, operationId]) => operationId,
    );

    expect(methodMarkers).toEqual(
      OPERATION_PROFILE.operations.map(({ operationId }) => operationId),
    );
    expect(iteratorMarkers).toEqual(
      OPERATION_PROFILE.iterators.map(({ operationId }) => operationId),
    );
    expect(new Set(methodMarkers)).toHaveLength(56);
    expect(new Set(iteratorMarkers)).toHaveLength(9);

    for (const mapping of [...OPERATION_PROFILE.operations, ...OPERATION_PROFILE.iterators]) {
      const kind = OPERATION_PROFILE.iterators.includes(mapping) ? "iterator" : "operation";
      const contents = section(reference, kind, mapping.operationId);
      expect(contents).toContain(`### ${mapping.facade}.${mapping.method}`);
      expect(contents).toContain(
        `client.${mapping.facade === "client" ? "" : `${mapping.facade}.`}`,
      );
      expect(contents).toMatch(/\*\*Models:\*\* \[[A-Za-z]/);
    }
  });

  it("retains OpenAPI scopes, security alternatives, idempotency, and authorization", async () => {
    const reference = await generateApiReference();

    for (const { operationId, operation } of operations) {
      const contents = section(reference, "operation", operationId);
      const scopes = securityScopes(operation);
      for (const scope of scopes) expect(contents).toContain(`\`${scope}\``);

      const alternatives = operation["security"];
      expect(contents.match(/\*\*Security alternatives:\*\*/g)).toHaveLength(1);
      const alternativeCount = Array.isArray(alternatives) ? alternatives.length : 0;
      expect(contents.match(/ \*\*or\*\* /g) ?? []).toHaveLength(Math.max(0, alternativeCount - 1));
      if (Array.isArray(alternatives)) {
        for (const alternative of alternatives) {
          for (const scheme of Object.keys(alternative as object)) {
            expect(contents).toContain(scheme);
          }
        }
      }

      const parameters = operation["parameters"];
      const idempotent =
        Array.isArray(parameters) &&
        parameters.some(
          (parameter) =>
            typeof parameter === "object" &&
            parameter !== null &&
            "$ref" in parameter &&
            parameter.$ref === "#/components/parameters/IdempotencyKey",
        );
      expect(contents).toContain(
        idempotent
          ? "**Idempotency:** Supported;"
          : "**Idempotency:** Not supported by this operation.",
      );

      const authorization =
        RESOURCE_AUTHORIZATION[operationId as keyof typeof RESOURCE_AUTHORIZATION];
      if (authorization === undefined) {
        expect(contents).toContain("**Authorization rule:** `none`");
      } else {
        expect(contents).toContain(`**Resource authorization:** ${authorization.summary}`);
        expect(contents).toContain(`**Authorization rule:** \`${authorization.kind}\``);
        expect(contents).toContain(`global role \`${authorization.roles.global}\``);
        expect(contents).toContain(`domain role \`${authorization.roles.domain}\``);
      }
    }
  });

  it("documents list limits and cursor XOR for every paginated method and iterator", async () => {
    const reference = await generateApiReference();

    for (const mapping of OPERATION_PROFILE.iterators) {
      const method = section(reference, "operation", mapping.operationId);
      const iterator = section(reference, "iterator", mapping.operationId);
      for (const contents of [method, iterator]) {
        expect(contents).toContain("`limit` accepts at most 100 items");
        expect(contents).toContain("Pass at most one of `after` or `before`");
        expect(contents).toContain("`pagination.next_cursor` as `after`");
        expect(contents).toContain("`pagination.previous_cursor` as `before`");
      }
    }
  });

  it("keeps every public model link resolvable", async () => {
    const reference = await generateApiReference();
    const links = [...reference.matchAll(/\[[A-Za-z][A-Za-z0-9_]*\]\((\.\.\/src\/[^)]+)\)/g)].map(
      ([, link]) => link!,
    );

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(existsSync(resolve(repositoryRoot, "docs", link)), link).toBe(true);
    }
  });

  it("rejects operation and iterator inventory drift", async () => {
    const profile = structuredClone(OPERATION_PROFILE) as {
      version: 1;
      operations: Array<{ operationId: string; facade: string; method: string }>;
      iterators: Array<{ operationId: string; facade: string; method: string }>;
    };
    profile.operations[0] = profile.operations[1]!;
    await expect(
      generateApiReference({
        openApiSource,
        profileSource: JSON.stringify(profile),
      }),
    ).rejects.toThrow(/parity failure/);

    const missingIterator = structuredClone(OPERATION_PROFILE) as {
      version: 1;
      operations: Array<{ operationId: string; facade: string; method: string }>;
      iterators: Array<{ operationId: string; facade: string; method: string }>;
    };
    missingIterator.iterators.pop();
    await expect(
      generateApiReference({
        openApiSource,
        profileSource: JSON.stringify(missingIterator),
      }),
    ).rejects.toThrow(/must contain 9 iterator mappings/);

    const duplicateAlias = structuredClone(OPERATION_PROFILE) as {
      version: 1;
      operations: Array<{ operationId: string; facade: string; method: string }>;
      iterators: Array<{ operationId: string; facade: string; method: string }>;
    };
    duplicateAlias.operations[1]!.facade = duplicateAlias.operations[0]!.facade;
    duplicateAlias.operations[1]!.method = duplicateAlias.operations[0]!.method;
    await expect(
      generateApiReference({
        openApiSource,
        profileSource: JSON.stringify(duplicateAlias),
      }),
    ).rejects.toThrow(/Duplicate facade mappings/);
  });
});
