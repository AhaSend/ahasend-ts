import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TESTS_ROOT = join(process.cwd(), "tests");
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const FORBIDDEN_MODIFIERS = ["only", "skip", "todo", "skipIf", "runIf"] as const;
const OPTION_MODIFIERS = new Set<ForbiddenModifier>(["only", "skip", "todo"]);
const VITEST_CALLABLES = new Set(["bench", "describe", "it", "suite", "test"]);
const VITEST_BUILDERS = new Set(["each", "extend", "for", "runIf", "scoped", "skipIf"]);

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

interface BindingSegment {
  readonly name: string;
  readonly node: ts.BindingElement;
}

interface BindingAlias {
  readonly initializer: ts.Expression;
  readonly localName: string;
  readonly segments: readonly BindingSegment[];
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

function terminalProperty(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
}

function isFalseLiteral(node: ts.Expression): boolean {
  return unwrapExpression(node).kind === ts.SyntaxKind.FalseKeyword;
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
  const markerPositions = new Set<number>();
  const lines = contents.split(/\r?\n/u);
  const declarations = new Map<string, ts.Expression[]>();
  const callableAliases = new Set(VITEST_CALLABLES);
  const namespaceAliases = new Set<string>();
  const bindingAliases: BindingAlias[] = [];

  function addDeclaration(name: string, initializer: ts.Expression): void {
    const existing = declarations.get(name);
    if (existing === undefined) {
      declarations.set(name, [initializer]);
    } else {
      existing.push(initializer);
    }
  }

  function collectBindingAliases(
    pattern: ts.ObjectBindingPattern,
    initializer: ts.Expression,
    segments: readonly BindingSegment[] = [],
  ): void {
    for (const element of pattern.elements) {
      const nameNode =
        element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
      const name = nameNode === undefined ? undefined : propertyName(nameNode);
      if (name === undefined) continue;
      const nextSegments = [...segments, { name, node: element }];

      if (ts.isIdentifier(element.name)) {
        bindingAliases.push({
          initializer,
          localName: element.name.text,
          segments: nextSegments,
        });
      } else if (ts.isObjectBindingPattern(element.name)) {
        collectBindingAliases(element.name, initializer, nextSegments);
      }
    }
  }

  function collectDeclarations(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "vitest"
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        namespaceAliases.add(bindings.name.text);
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (VITEST_CALLABLES.has(importedName)) callableAliases.add(element.name.text);
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) {
        addDeclaration(node.name.text, node.initializer);
      } else if (ts.isObjectBindingPattern(node.name)) {
        collectBindingAliases(node.name, node.initializer);
      }
    }

    ts.forEachChild(node, collectDeclarations);
  }

  collectDeclarations(sourceFile);

  type ExpressionKind = "callable" | "namespace" | undefined;

  function expressionKind(node: ts.Expression): ExpressionKind {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) {
      if (callableAliases.has(expression.text)) return "callable";
      if (namespaceAliases.has(expression.text)) return "namespace";
      return undefined;
    }

    if (ts.isConditionalExpression(expression)) {
      const whenTrue = expressionKind(expression.whenTrue);
      return whenTrue !== undefined && whenTrue === expressionKind(expression.whenFalse)
        ? whenTrue
        : undefined;
    }

    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const ownerKind = expressionKind(expression.expression);
      if (ownerKind === "callable") return "callable";
      const name = terminalProperty(expression);
      return ownerKind === "namespace" && name !== undefined && VITEST_CALLABLES.has(name)
        ? "callable"
        : undefined;
    }

    if (ts.isCallExpression(expression)) {
      const name = terminalProperty(unwrapExpression(expression.expression));
      return name !== undefined &&
        VITEST_BUILDERS.has(name) &&
        expressionKind(expression.expression) === "callable"
        ? "callable"
        : undefined;
    }

    return undefined;
  }

  function bindingAliasKind(binding: BindingAlias): ExpressionKind {
    let kind = expressionKind(binding.initializer);
    for (const segment of binding.segments) {
      if (kind === "callable") continue;
      if (kind === "namespace" && VITEST_CALLABLES.has(segment.name)) {
        kind = "callable";
      } else {
        return undefined;
      }
    }
    return kind;
  }

  let aliasesAdded: boolean;
  do {
    aliasesAdded = false;
    for (const [name, initializers] of declarations) {
      if (
        !namespaceAliases.has(name) &&
        initializers.some((initializer) => expressionKind(initializer) === "namespace")
      ) {
        namespaceAliases.add(name);
        aliasesAdded = true;
      } else if (
        !callableAliases.has(name) &&
        initializers.some((initializer) => expressionKind(initializer) === "callable")
      ) {
        callableAliases.add(name);
        aliasesAdded = true;
      }
    }
    for (const binding of bindingAliases) {
      const kind = bindingAliasKind(binding);
      if (kind === "namespace" && !namespaceAliases.has(binding.localName)) {
        namespaceAliases.add(binding.localName);
        aliasesAdded = true;
      } else if (kind === "callable" && !callableAliases.has(binding.localName)) {
        callableAliases.add(binding.localName);
        aliasesAdded = true;
      }
    }
  } while (aliasesAdded);

  function addMarker(node: ts.Node, modifier: ForbiddenModifier): void {
    const position = node.getStart(sourceFile);
    if (markerPositions.has(position)) return;
    markerPositions.add(position);
    const line = sourceFile.getLineAndCharacterOfPosition(position).line;
    markers.push({
      file,
      line: line + 1,
      modifier,
      source: (lines[line] ?? "").trim(),
    });
  }

  const bindingModifiers = new Map<number, ForbiddenModifier>();
  for (const binding of bindingAliases) {
    let kind = expressionKind(binding.initializer);
    for (const segment of binding.segments) {
      if (kind === "callable") {
        const modifier = FORBIDDEN_MODIFIERS.find((candidate) => candidate === segment.name);
        if (modifier !== undefined) {
          bindingModifiers.set(segment.node.getStart(sourceFile), modifier);
        }
      } else if (kind === "namespace" && VITEST_CALLABLES.has(segment.name)) {
        kind = "callable";
        continue;
      } else {
        break;
      }
    }
  }

  function optionPropertyModifier(
    node: ts.ObjectLiteralElementLike,
  ): ForbiddenModifier | undefined {
    if (
      (ts.isPropertyAssignment(node) && isFalseLiteral(node.initializer)) ||
      ts.isSpreadAssignment(node)
    ) {
      return undefined;
    }

    const name = propertyName(node.name) as ForbiddenModifier | undefined;
    return name !== undefined && OPTION_MODIFIERS.has(name) ? name : undefined;
  }

  function inspectOptionExpression(node: ts.Expression, seenAliases: ReadonlySet<string>): void {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) {
      if (seenAliases.has(expression.text)) return;
      const nextSeenAliases = new Set(seenAliases).add(expression.text);
      for (const initializer of declarations.get(expression.text) ?? []) {
        inspectOptionExpression(initializer, nextSeenAliases);
      }
      return;
    }

    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          inspectOptionExpression(property.expression, seenAliases);
          continue;
        }
        const modifier = optionPropertyModifier(property);
        if (modifier !== undefined) addMarker(property, modifier);
      }
      return;
    }

    if (ts.isConditionalExpression(expression)) {
      inspectOptionExpression(expression.whenTrue, seenAliases);
      inspectOptionExpression(expression.whenFalse, seenAliases);
    } else if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      inspectOptionExpression(expression.left, seenAliases);
      inspectOptionExpression(expression.right, seenAliases);
    }
  }

  function visit(node: ts.Node): void {
    const bindingModifier = bindingModifiers.get(node.getStart(sourceFile));
    if (bindingModifier !== undefined) {
      addMarker(node, bindingModifier);
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      expressionKind(node) === "callable"
    ) {
      const modifier = propertyModifier(node);
      if (modifier !== undefined) addMarker(node, modifier);
    }

    if (
      ts.isCallExpression(node) &&
      expressionKind(node.expression) === "callable" &&
      !VITEST_BUILDERS.has(terminalProperty(unwrapExpression(node.expression)) ?? "")
    ) {
      for (const argument of node.arguments.slice(1, 3)) {
        inspectOptionExpression(argument, new Set());
      }
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

  it.each(["only", "skip", "todo"] as const)("rejects a true %s test option", (modifier) => {
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

  it("rejects conditional, separately declared, and aliased test options", () => {
    const contents = [
      `import { it as check } from "vitest";`,
      `const focused = { only: SHOULD_FOCUS };`,
      `const focusedAlias = focused;`,
      `const skipped = { skip: true };`,
      `const customCheck = check.extend({});`,
      `customCheck("focused", focusedAlias, () => {});`,
      `check("skipped", () => {}, skipped);`,
    ].join("\n");

    const markers = findMarkers("tests/example.test.ts", contents);
    expect(markers).toEqual([
      {
        file: "tests/example.test.ts",
        line: 2,
        modifier: "only",
        source: `const focused = { only: SHOULD_FOCUS };`,
      },
      {
        file: "tests/example.test.ts",
        line: 4,
        modifier: "skip",
        source: `const skipped = { skip: true };`,
      },
    ]);
    expect(auditMarkers(markers).unexpected).toEqual(markers);
  });

  it("rejects forbidden options reached through conditionals and object spreads", () => {
    const contents = [
      `const todo = { todo: true };`,
      `const options = SHOULD_SKIP ? { skip: true } : { ...todo };`,
      `test("hidden", options, () => {});`,
    ].join("\n");

    const markers = findMarkers("tests/example.test.ts", contents);
    expect(markers).toEqual([
      {
        file: "tests/example.test.ts",
        line: 2,
        modifier: "skip",
        source: `const options = SHOULD_SKIP ? { skip: true } : { ...todo };`,
      },
      {
        file: "tests/example.test.ts",
        line: 1,
        modifier: "todo",
        source: `const todo = { todo: true };`,
      },
    ]);
    expect(auditMarkers(markers).unexpected).toEqual(markers);
  });

  it("rejects namespace-import options and destructured Vitest modifiers", () => {
    const contents = [
      `import * as vitest from "vitest";`,
      `const hiddenOptions = { skip: true };`,
      `vitest.it("hidden by options", hiddenOptions, () => {});`,
      `const { test: check } = vitest;`,
      `check("focused by options", { only: SHOULD_FOCUS }, () => {});`,
      `const { todo: hiddenTodo } = check;`,
      `hiddenTodo("hidden by alias");`,
      `const { test: { skip: hiddenTest } } = vitest;`,
      `hiddenTest("hidden by nested alias", () => {});`,
    ].join("\n");

    const markers = findMarkers("tests/example.test.ts", contents);
    expect(markers).toEqual([
      {
        file: "tests/example.test.ts",
        line: 2,
        modifier: "skip",
        source: `const hiddenOptions = { skip: true };`,
      },
      {
        file: "tests/example.test.ts",
        line: 5,
        modifier: "only",
        source: `check("focused by options", { only: SHOULD_FOCUS }, () => {});`,
      },
      {
        file: "tests/example.test.ts",
        line: 6,
        modifier: "todo",
        source: `const { todo: hiddenTodo } = check;`,
      },
      {
        file: "tests/example.test.ts",
        line: 8,
        modifier: "skip",
        source: `const { test: { skip: hiddenTest } } = vitest;`,
      },
    ]);
    expect(auditMarkers(markers).unexpected).toEqual(markers);
  });

  it("ignores test-modifier text that cannot affect Vitest execution", () => {
    const contents = [
      `const documentation = 'it.skipIf(true)';`,
      `const request = { only: true, skip: true, todo: true };`,
      `const result = { skip: "page", todo: "later", only: "this" };`,
      `result.skip; result["todo"]; result.only;`,
      `it.each([{ only: true, skip: true, todo: true }])("runs case %#", () => {});`,
      `it("runs", { only: false, skip: false, todo: false }, () => {});`,
    ].join("\n");

    expect(findMarkers("tests/example.test.ts", contents)).toEqual([]);
  });

  it("contains no unexpected focused, skipped, or todo tests", () => {
    expect(repositoryAudit).toEqual({ unexpected: [], missingAllowances: [] });
  });
});
