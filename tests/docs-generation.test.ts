import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectOperations, parseOpenApi } from "../scripts/generate-contracts.mjs";
import { generateApiReference } from "../scripts/generate-docs.mjs";
import { NODE_SAMPLE_REGISTRY } from "../scripts/node-code-samples.mjs";
import { RESOURCE_AUTHORIZATION } from "../src/generated/operations.js";
import { OPERATION_PROFILE } from "../src/generated/operation-profile.js";

const repositoryRoot = process.cwd();
const referencePath = resolve(repositoryRoot, "docs/api-reference.md");
const openApiSource = readFileSync(resolve(repositoryRoot, "openapi.yaml"), "utf8");
const clientSource = readFileSync(resolve(repositoryRoot, "src/client.ts"), "utf8");
const document = parseOpenApi(openApiSource);
const operations = collectOperations(document);

function withAPIKeysInterface(declaration: string): string {
  return clientSource
    .replace(
      'const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");',
      [
        'import type { APIKey } from "./resources/api-keys.js";',
        'import type { PaginatedResponse, PaginationParams } from "./types/common.js";',
        "",
        declaration,
        "",
        'const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");',
      ].join("\n"),
    )
    .replace("get apiKeys(): Readonly<APIKeysClient> {", "get apiKeys(): FixtureAPIKeysClient {");
}

function section(
  reference: string,
  kind: "operation" | "sdk-sample" | "iterator",
  operationId: string,
): string {
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
  it("reproduces the committed reference byte-for-byte", { timeout: 120_000 }, async () => {
    const generated = await generateApiReference();
    expect(readFileSync(referencePath, "utf8")).toBe(generated);

    const check = spawnSync(process.execPath, ["scripts/generate-docs.mjs", "--check"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it(
    "accounts for all 62 methods and ten iterators exactly once",
    { timeout: 120_000 },
    async () => {
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
      expect(new Set(methodMarkers)).toHaveLength(62);
      expect(new Set(iteratorMarkers)).toHaveLength(10);

      for (const mapping of [...OPERATION_PROFILE.operations, ...OPERATION_PROFILE.iterators]) {
        const kind = OPERATION_PROFILE.iterators.includes(mapping) ? "iterator" : "operation";
        const contents = section(reference, kind, mapping.operationId);
        expect(contents).toContain(`### ${mapping.facade}.${mapping.method}`);
        expect(contents).toContain(
          `client.${mapping.facade === "client" ? "" : `${mapping.facade}.`}`,
        );
        expect(contents).toMatch(/\*\*Models:\*\* \[[A-Za-z]/);
      }
    },
  );

  it("renders one registry SDK sample on its matching public facade", async () => {
    const reference = await generateApiReference();
    const sampleMarkers = [...reference.matchAll(/<!-- sdk-sample: ([A-Za-z0-9]+) -->/g)].map(
      ([, operationId]) => operationId,
    );

    expect(sampleMarkers).toEqual(
      OPERATION_PROFILE.operations.map(({ operationId }) => operationId),
    );
    expect(sampleMarkers).toEqual(NODE_SAMPLE_REGISTRY.map(({ operationId }) => operationId));

    for (const [index, mapping] of OPERATION_PROFILE.operations.entries()) {
      const registryEntry = NODE_SAMPLE_REGISTRY[index]!;
      const facade = `client.${mapping.facade === "client" ? "" : `${mapping.facade}.`}${mapping.method}`;
      const contents = section(reference, "sdk-sample", mapping.operationId);

      expect(registryEntry.facade, mapping.operationId).toBe(facade);
      expect(registryEntry.sample.source, mapping.operationId).toContain(`${facade}(`);
      expect(contents, mapping.operationId).toContain(`#### ${registryEntry.sample.label}`);
      expect(contents, mapping.operationId).toContain(
        `\`\`\`${registryEntry.sample.lang}\n${registryEntry.sample.source.trimEnd()}\n\`\`\``,
      );
    }
  });

  it("uses the canonical registry validator for generated SDK samples", async () => {
    const incompatibleOpenApi = openApiSource.replace(
      "    CreateDomainRequest:\n      type: object\n      required:\n        - domain",
      "    CreateDomainRequest:\n      type: object\n      required:\n        - domain\n        - dkim_private_key",
    );
    expect(incompatibleOpenApi).not.toBe(openApiSource);

    await expect(generateApiReference({ openApiSource: incompatibleOpenApi })).rejects.toThrow(
      /createDomain sample request body does not match its schema/,
    );
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

  it("documents the complete contact safety and lifecycle boundary", async () => {
    const reference = await generateApiReference();

    for (const phrase of [
      "`contacts:read`, `contacts:write`, and `contacts:delete` permissions",
      "definitions managed in the AhaSend dashboard",
      "neither definition CRUD nor list membership",
      "percent-encodes the value exactly once",
      "Prefer unsubscribe over delete",
      "hard delete permanently removes contact history",
      "measure end-to-end latency",
      "no fixed throughput guarantee",
    ]) {
      expect(reference).toContain(phrase);
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

  it("renders typed interface method signatures from facade property types", async () => {
    const fixture = withAPIKeysInterface(`interface FixtureAPIKeysClient
  extends Omit<Readonly<APIKeysClient>, "list"> {
  /** Fetch one documented page from a structural facade. */
  list(
    params?: PaginationParams,
    options?: RequestOptions,
  ): Promise<PaginatedResponse<APIKey>>;
}`);

    const reference = await generateApiReference({ clientSource: fixture });

    expect(section(reference, "operation", "getAPIKeys")).toContain(
      "client.apiKeys.list(params?: PaginationParams, options?: RequestOptions): Promise<PaginatedResponse<APIKey>>",
    );
  });

  it(
    "rejects missing and overloaded interface method declarations",
    { timeout: 120_000 },
    async () => {
      const missing = withAPIKeysInterface(
        'interface FixtureAPIKeysClient extends Omit<Readonly<APIKeysClient>, "list"> {}',
      );
      await expect(generateApiReference({ clientSource: missing })).rejects.toThrow(
        "Profile method apiKeys.list is not public",
      );

      const overloaded = withAPIKeysInterface(`interface FixtureAPIKeysClient
  extends Omit<Readonly<APIKeysClient>, "list"> {
  list(params?: PaginationParams): Promise<PaginatedResponse<APIKey>>;
  list(
    params: PaginationParams,
    options?: RequestOptions,
  ): Promise<PaginatedResponse<APIKey>>;
}`);
      await expect(generateApiReference({ clientSource: overloaded })).rejects.toThrow(
        "apiKeys.list must have exactly one public call signature",
      );
    },
  );

  it(
    "requires public JSDoc on every structural method and iterator",
    { timeout: 120_000 },
    async () => {
      const undocumentedMethod = withAPIKeysInterface(`interface FixtureAPIKeysClient
  extends Omit<Readonly<APIKeysClient>, "list"> {
  list(
    params?: PaginationParams,
    options?: RequestOptions,
  ): Promise<PaginatedResponse<APIKey>>;
}`);
      await expect(generateApiReference({ clientSource: undocumentedMethod })).rejects.toThrow(
        "apiKeys.list must have public JSDoc",
      );

      const undocumentedIterator = withAPIKeysInterface(`interface FixtureAPIKeysClient
  extends Omit<Readonly<APIKeysClient>, "iterate"> {
  iterate(
    params?: PaginationParams,
    options?: RequestOptions,
  ): AsyncGenerator<APIKey, void, undefined>;
}`);
      await expect(generateApiReference({ clientSource: undocumentedIterator })).rejects.toThrow(
        "apiKeys.iterate must have public JSDoc",
      );
    },
  );

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
    ).rejects.toThrow(/must contain 10 iterator mappings/);

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
