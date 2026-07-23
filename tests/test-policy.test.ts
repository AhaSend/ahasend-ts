import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TESTS_ROOT = join(process.cwd(), "tests");
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const FORBIDDEN_MODIFIERS = ["only", "skip", "todo", "skipIf", "runIf"] as const;
const OPTION_MODIFIERS = new Set<ForbiddenModifier>(["skip", "todo"]);
const VITEST_CALLABLES = new Set(["bench", "describe", "it", "suite", "test"]);

type ForbiddenModifier = (typeof FORBIDDEN_MODIFIERS)[number];

interface Marker {
  readonly file: string;
  readonly line: number;
  readonly modifier: ForbiddenModifier;
  readonly source: string;
}

interface AllowedMarker {
  readonly modifier: ForbiddenModifier;
  readonly source: string;
}

const ALLOWED_MARKERS: Readonly<Record<string, readonly AllowedMarker[]>> = {
  "tests/integration/sdk.integration.test.ts": [
    {
      modifier: "skip",
      source: `const itIntegration = RUN ? it : ${["it", "skip"].join(".")};`,
    },
    {
      modifier: "skip",
      source: `const describeIntegration = RUN ? describe : ${["describe", "skip"].join(".")};`,
    },
  ],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function repositoryPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node) && ts.isStringLiteral(node.expression)) {
    return node.expression.text;
  }
  return undefined;
}

function callableRoot(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return callableRoot(node.expression);
  }
  if (ts.isCallExpression(node)) return callableRoot(node.expression);
  return undefined;
}

function optionModifier(node: ts.Node): ForbiddenModifier | undefined {
  if (
    !ts.isPropertyAssignment(node) ||
    node.initializer.kind !== ts.SyntaxKind.TrueKeyword ||
    !ts.isObjectLiteralExpression(node.parent) ||
    !ts.isCallExpression(node.parent.parent) ||
    !node.parent.parent.arguments.includes(node.parent) ||
    !VITEST_CALLABLES.has(callableRoot(node.parent.parent.expression) ?? "")
  ) {
    return undefined;
  }

  const name = propertyName(node.name) as ForbiddenModifier | undefined;
  return name !== undefined && OPTION_MODIFIERS.has(name) ? name : undefined;
}

function propertyModifier(node: ts.Node): ForbiddenModifier | undefined {
  let name: string | undefined;
  if (ts.isPropertyAccessExpression(node)) {
    name = node.name.text;
  } else if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    name = node.argumentExpression.text;
  }

  return FORBIDDEN_MODIFIERS.find((modifier) => modifier === name);
}

function findMarkers(file: string, contents: string): Marker[] {
  const sourceFile = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const markers: Marker[] = [];
  const lines = contents.split(/\r?\n/u);

  function visit(node: ts.Node): void {
    const modifier = propertyModifier(node) ?? optionModifier(node);
    if (modifier !== undefined) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      markers.push({
        file,
        line: line + 1,
        modifier,
        source: (lines[line] ?? "").trim(),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return markers;
}

function markerKey(marker: Pick<Marker, "modifier" | "source">): string {
  return `${marker.modifier}\0${marker.source}`;
}

function auditMarkers(markers: readonly Marker[]): {
  readonly unexpected: readonly Marker[];
  readonly missingAllowances: readonly string[];
} {
  const remainingAllowances = new Map<string, number>(
    Object.entries(ALLOWED_MARKERS).flatMap(([file, allowances]) =>
      allowances.map((allowance) => [`${file}\0${markerKey(allowance)}`, 1] as const),
    ),
  );
  const unexpected: Marker[] = [];

  for (const marker of markers) {
    const key = `${marker.file}\0${markerKey(marker)}`;
    const remaining = remainingAllowances.get(key) ?? 0;
    if (remaining === 0) {
      unexpected.push(marker);
    } else {
      remainingAllowances.set(key, remaining - 1);
    }
  }

  const missingAllowances = [...remainingAllowances.entries()]
    .filter(([, remaining]) => remaining > 0)
    .map(([key]) => key.split("\0").join(": "));

  return { unexpected, missingAllowances };
}

function formatMarker(marker: Marker): string {
  return `${marker.file}:${marker.line} uses .${marker.modifier}: ${marker.source}`;
}

function auditRepository(): ReturnType<typeof auditMarkers> {
  const markers = sourceFiles(TESTS_ROOT).flatMap((path) =>
    findMarkers(repositoryPath(path), readFileSync(path, "utf8")),
  );
  return auditMarkers(markers);
}

function enforcePolicy(audit: ReturnType<typeof auditMarkers>): void {
  const violations = [
    ...audit.unexpected.map(formatMarker),
    ...audit.missingAllowances.map((allowance) => `Stale test-modifier allowance: ${allowance}`),
  ];

  if (violations.length > 0) {
    throw new Error(`Committed test policy violations:\n${violations.join("\n")}`);
  }
}

// Enforce the repository policy while this module loads. Keeping the gate outside a test or suite
// prevents a modifier on the policy tests themselves from disabling the repository scan.
const repositoryAudit = auditRepository();
enforcePolicy(repositoryAudit);

describe("committed test policy", () => {
  it.each(FORBIDDEN_MODIFIERS)("rejects an unexpected %s modifier", (modifier) => {
    const marker = findMarkers("tests/example.test.ts", `it.${modifier}("hidden", () => {});`);

    expect(marker).toEqual([
      {
        file: "tests/example.test.ts",
        line: 1,
        modifier,
        source: `it.${modifier}("hidden", () => {});`,
      },
    ]);
    expect(auditMarkers(marker).unexpected).toEqual(marker);
  });

  it.each(["skip", "todo"] as const)("rejects a true %s test option", (modifier) => {
    const source = `it("hidden", { ${modifier}: true }, () => {});`;
    const marker = findMarkers("tests/example.test.ts", source);

    expect(marker).toEqual([
      {
        file: "tests/example.test.ts",
        line: 1,
        modifier,
        source,
      },
    ]);
    expect(auditMarkers(marker).unexpected).toEqual(marker);
  });

  it("ignores test-modifier text that cannot affect Vitest execution", () => {
    const contents = [
      `const documentation = 'it.skipIf(true)';`,
      `const request = { skip: true, todo: true };`,
      `it("runs", { skip: false, todo: false }, () => {});`,
    ].join("\n");

    expect(findMarkers("tests/example.test.ts", contents)).toEqual([]);
  });

  it("contains no unexpected focused, skipped, or todo tests", () => {
    expect(repositoryAudit).toEqual({ unexpected: [], missingAllowances: [] });
  });
});
