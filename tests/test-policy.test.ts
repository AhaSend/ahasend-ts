import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TESTS_ROOT = join(process.cwd(), "tests");
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const FORBIDDEN_MODIFIERS = ["only", "skip", "todo", "skipIf", "runIf"] as const;
const OPTION_MODIFIERS = new Set<ForbiddenModifier>(["only", "skip", "todo"]);
const VITEST_CALLABLES = new Set(["bench", "describe", "it", "suite", "test"]);
const VITEST_BUILDERS = new Set(["each", "extend", "for", "runIf", "scoped", "skipIf"]);
const VITEST_SUITES = new Set(["describe", "suite"]);

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
  readonly segments: readonly BindingSegment[];
}

interface TestSource {
  readonly file: string;
  readonly contents: string;
}

type CallableKind = "callable" | "suite";
type ImportKindResolver = (
  importer: string,
  moduleSpecifier: string,
  importedName: string,
) => CallableKind | undefined;

function vitestCallableKind(name: string): CallableKind | undefined {
  if (!VITEST_CALLABLES.has(name)) return undefined;
  return VITEST_SUITES.has(name) ? "suite" : "callable";
}

function isCallableKind(kind: string | undefined): kind is CallableKind {
  return kind === "callable" || kind === "suite";
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

function findMarkers(
  file: string,
  contents: string,
  resolveImportKind?: ImportKindResolver,
): Marker[] {
  const sourceFile = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  compilerHost.fileExists = (fileName) => fileName === file;
  compilerHost.getSourceFile = (fileName) => (fileName === file ? sourceFile : undefined);
  compilerHost.readFile = (fileName) => (fileName === file ? contents : undefined);
  const checker = ts
    .createProgram({ rootNames: [file], options: compilerOptions, host: compilerHost })
    .getTypeChecker();
  const markers: Marker[] = [];
  const markerPositions = new Set<number>();
  const lines = contents.split(/\r?\n/u);
  type ExpressionKind = CallableKind | "namespace" | undefined;
  const directKinds = new Map<ts.Symbol, Exclude<ExpressionKind, undefined>>();
  const declarations = new Map<ts.Symbol, ts.Expression[]>();
  const bindingAliases = new Map<ts.Symbol, BindingAlias>();

  function addDeclaration(name: ts.Identifier, initializer: ts.Expression): void {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol === undefined) return;
    const existing = declarations.get(symbol);
    if (existing === undefined) {
      declarations.set(symbol, [initializer]);
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
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol === undefined) continue;
        bindingAliases.set(symbol, {
          initializer,
          segments: nextSegments,
        });
      } else if (ts.isObjectBindingPattern(element.name)) {
        collectBindingAliases(element.name, initializer, nextSegments);
      }
    }
  }

  function collectDeclarations(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text;
      const defaultImport = node.importClause?.name;
      const defaultKind = resolveImportKind?.(file, moduleSpecifier, "default");
      if (defaultImport !== undefined && defaultKind !== undefined) {
        const symbol = checker.getSymbolAtLocation(defaultImport);
        if (symbol !== undefined) directKinds.set(symbol, defaultKind);
      }

      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        if (moduleSpecifier === "vitest") {
          const symbol = checker.getSymbolAtLocation(bindings.name);
          if (symbol !== undefined) directKinds.set(symbol, "namespace");
        }
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          const symbol = checker.getSymbolAtLocation(element.name);
          const kind =
            moduleSpecifier === "vitest"
              ? vitestCallableKind(importedName)
              : resolveImportKind?.(file, moduleSpecifier, importedName);
          if (symbol !== undefined && kind !== undefined) {
            directKinds.set(symbol, kind);
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) {
        addDeclaration(node.name, node.initializer);
      } else if (ts.isObjectBindingPattern(node.name)) {
        collectBindingAliases(node.name, node.initializer);
      }
    }

    ts.forEachChild(node, collectDeclarations);
  }

  collectDeclarations(sourceFile);

  function expressionKind(
    node: ts.Expression,
    seenSymbols: ReadonlySet<ts.Symbol> = new Set(),
  ): ExpressionKind {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (symbol === undefined) return undefined;
      const directKind = directKinds.get(symbol);
      if (directKind !== undefined) return directKind;
      if (seenSymbols.has(symbol)) return undefined;

      const nextSeenSymbols = new Set(seenSymbols).add(symbol);
      for (const initializer of declarations.get(symbol) ?? []) {
        const kind = expressionKind(initializer, nextSeenSymbols);
        if (kind !== undefined) return kind;
      }
      const binding = bindingAliases.get(symbol);
      if (binding !== undefined) return bindingAliasKind(binding, nextSeenSymbols);
      for (const declaration of symbol.declarations ?? []) {
        if (
          ts.isParameter(declaration) &&
          declaration.parent.parameters[0] === declaration &&
          (ts.isArrowFunction(declaration.parent) || ts.isFunctionExpression(declaration.parent)) &&
          ts.isCallExpression(declaration.parent.parent) &&
          declaration.parent.parent.arguments.some((argument) => argument === declaration.parent) &&
          expressionKind(declaration.parent.parent.expression, nextSeenSymbols) === "suite"
        ) {
          return "callable";
        }
      }
      return undefined;
    }

    if (ts.isConditionalExpression(expression)) {
      const whenTrue = expressionKind(expression.whenTrue, seenSymbols);
      return whenTrue !== undefined &&
        whenTrue === expressionKind(expression.whenFalse, seenSymbols)
        ? whenTrue
        : undefined;
    }

    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const ownerKind = expressionKind(expression.expression, seenSymbols);
      if (isCallableKind(ownerKind)) return ownerKind;
      const name = terminalProperty(expression);
      return ownerKind === "namespace" && name !== undefined ? vitestCallableKind(name) : undefined;
    }

    if (ts.isCallExpression(expression)) {
      const name = terminalProperty(unwrapExpression(expression.expression));
      const ownerKind = expressionKind(expression.expression, seenSymbols);
      return name !== undefined && VITEST_BUILDERS.has(name) && isCallableKind(ownerKind)
        ? ownerKind
        : undefined;
    }

    return undefined;
  }

  function bindingAliasKind(
    binding: BindingAlias,
    seenSymbols: ReadonlySet<ts.Symbol> = new Set(),
  ): ExpressionKind {
    let kind = expressionKind(binding.initializer, seenSymbols);
    for (const segment of binding.segments) {
      if (isCallableKind(kind)) continue;
      if (kind === "namespace") {
        kind = vitestCallableKind(segment.name);
        if (kind === undefined) return undefined;
      } else {
        return undefined;
      }
    }
    return kind;
  }

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
  for (const binding of bindingAliases.values()) {
    let kind = expressionKind(binding.initializer);
    for (const segment of binding.segments) {
      if (isCallableKind(kind)) {
        const modifier = FORBIDDEN_MODIFIERS.find((candidate) => candidate === segment.name);
        if (modifier !== undefined) {
          bindingModifiers.set(segment.node.getStart(sourceFile), modifier);
        }
      } else if (kind === "namespace") {
        kind = vitestCallableKind(segment.name);
        if (kind !== undefined) continue;
        break;
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

  function inspectOptionExpression(node: ts.Expression, seenAliases: ReadonlySet<ts.Symbol>): void {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (symbol === undefined || seenAliases.has(symbol)) return;
      const nextSeenAliases = new Set(seenAliases).add(symbol);
      for (const initializer of declarations.get(symbol) ?? []) {
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
      isCallableKind(expressionKind(node))
    ) {
      const modifier = propertyModifier(node);
      if (modifier !== undefined) addMarker(node, modifier);
    }

    if (
      ts.isCallExpression(node) &&
      isCallableKind(expressionKind(node.expression)) &&
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

function resolveLocalModule(
  importer: string,
  moduleSpecifier: string,
  sourceNames: ReadonlySet<string>,
): string | undefined {
  if (!moduleSpecifier.startsWith(".")) return undefined;

  const requested = normalize(join(dirname(importer), moduleSpecifier))
    .split(sep)
    .join("/");
  const extension = extname(requested);
  const withoutExtension = extension === "" ? requested : requested.slice(0, -extension.length);
  const candidates =
    extension === ""
      ? [
          requested,
          ...[...SOURCE_EXTENSIONS].map((candidate) => `${requested}${candidate}`),
          ...[...SOURCE_EXTENSIONS].map((candidate) => `${requested}/index${candidate}`),
        ]
      : [
          requested,
          ...[...SOURCE_EXTENSIONS].map((candidate) => `${withoutExtension}${candidate}`),
        ];
  return candidates.find((candidate) => sourceNames.has(candidate));
}

function callableExports(
  sources: readonly TestSource[],
): ReadonlyMap<string, ReadonlyMap<string, CallableKind>> {
  const sourceNames = new Set(sources.map(({ file }) => file));
  const parsedSources = sources.map(({ file, contents }) => ({
    file,
    sourceFile: ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true),
  }));
  const exportsByFile = new Map<string, Map<string, CallableKind>>(
    sources.map(({ file }) => [file, new Map<string, CallableKind>()]),
  );

  function exportedCallables(
    moduleSpecifier: string,
    importer: string,
  ): ReadonlyMap<string, CallableKind> {
    if (moduleSpecifier === "vitest") {
      return new Map(
        [...VITEST_CALLABLES].map((name) => [name, vitestCallableKind(name)!] as const),
      );
    }
    const resolved = resolveLocalModule(importer, moduleSpecifier, sourceNames);
    return resolved === undefined
      ? new Map()
      : (exportsByFile.get(resolved) ?? new Map<string, CallableKind>());
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const { file, sourceFile } of parsedSources) {
      const localKinds = new Map<string, CallableKind>();
      const namespaces = new Set<string>();
      const declarations = new Map<string, ts.Expression>();

      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
          continue;
        }
        const moduleSpecifier = statement.moduleSpecifier.text;
        const available = exportedCallables(statement.moduleSpecifier.text, file);
        const defaultImport = statement.importClause?.name;
        const defaultKind = available.get("default");
        if (defaultImport !== undefined && defaultKind !== undefined) {
          localKinds.set(defaultImport.text, defaultKind);
        }
        const bindings = statement.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          if (moduleSpecifier === "vitest") namespaces.add(bindings.name.text);
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            const kind = available.get(importedName);
            if (kind !== undefined) localKinds.set(element.name.text, kind);
          }
        }
      }

      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
            declarations.set(declaration.name.text, declaration.initializer);
          }
        }
      }

      function expressionKind(
        node: ts.Expression,
        seenNames: ReadonlySet<string> = new Set(),
      ): CallableKind | "namespace" | undefined {
        const expression = unwrapExpression(node);
        if (ts.isIdentifier(expression)) {
          const directKind = localKinds.get(expression.text);
          if (directKind !== undefined) return directKind;
          if (namespaces.has(expression.text)) return "namespace";
          if (seenNames.has(expression.text)) return undefined;
          const initializer = declarations.get(expression.text);
          return initializer === undefined
            ? undefined
            : expressionKind(initializer, new Set(seenNames).add(expression.text));
        }

        if (ts.isConditionalExpression(expression)) {
          const whenTrue = expressionKind(expression.whenTrue, seenNames);
          return whenTrue !== undefined &&
            whenTrue === expressionKind(expression.whenFalse, seenNames)
            ? whenTrue
            : undefined;
        }

        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
          const ownerKind = expressionKind(expression.expression, seenNames);
          if (isCallableKind(ownerKind)) return ownerKind;
          const name = terminalProperty(expression);
          return ownerKind === "namespace" && name !== undefined
            ? vitestCallableKind(name)
            : undefined;
        }

        if (ts.isCallExpression(expression)) {
          const name = terminalProperty(unwrapExpression(expression.expression));
          const ownerKind = expressionKind(expression.expression, seenNames);
          return name !== undefined && VITEST_BUILDERS.has(name) && isCallableKind(ownerKind)
            ? ownerKind
            : undefined;
        }

        return undefined;
      }

      function addExport(name: string, kind: CallableKind): void {
        const fileExports = exportsByFile.get(file);
        if (fileExports === undefined || fileExports.get(name) === kind) return;
        fileExports.set(name, kind);
        changed = true;
      }

      const fileExports = exportsByFile.get(file);
      if (fileExports === undefined) continue;
      for (const statement of sourceFile.statements) {
        if (
          ts.isVariableStatement(statement) &&
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
            true
        ) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
              const kind = expressionKind(declaration.initializer);
              if (kind !== undefined && kind !== "namespace") {
                addExport(declaration.name.text, kind);
              }
            }
          }
          continue;
        }

        if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
          const kind = expressionKind(statement.expression);
          if (kind !== undefined && kind !== "namespace") addExport("default", kind);
          continue;
        }

        if (ts.isExportDeclaration(statement)) {
          const moduleSpecifier =
            statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
              ? statement.moduleSpecifier.text
              : undefined;
          const available =
            moduleSpecifier === undefined ? undefined : exportedCallables(moduleSpecifier, file);

          if (statement.exportClause === undefined) {
            for (const [name, kind] of available ?? []) addExport(name, kind);
          } else if (ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) {
              const importedName = element.propertyName?.text ?? element.name.text;
              const kind =
                available?.get(importedName) ??
                expressionKind(ts.factory.createIdentifier(importedName));
              if (kind !== undefined && kind !== "namespace") {
                addExport(element.name.text, kind);
              }
            }
          }
        }
      }
    }
  }

  return exportsByFile;
}

function findMarkersInSources(sources: readonly TestSource[]): Marker[] {
  const sourceNames = new Set(sources.map(({ file }) => file));
  const exportsByFile = callableExports(sources);
  const resolveImportKind: ImportKindResolver = (importer, moduleSpecifier, importedName) => {
    const resolved = resolveLocalModule(importer, moduleSpecifier, sourceNames);
    return resolved === undefined ? undefined : exportsByFile.get(resolved)?.get(importedName);
  };
  return sources.flatMap(({ file, contents }) => findMarkers(file, contents, resolveImportKind));
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
  const sources = sourceFiles(TESTS_ROOT).map((path) => ({
    file: repositoryPath(path),
    contents: readFileSync(path, "utf8"),
  }));
  return auditMarkers(findMarkersInSources(sources));
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
    const invocation = `it.${modifier}("hidden", () => {});`;
    const marker = findMarkers(
      "tests/example.test.ts",
      [`import { it } from "vitest";`, invocation].join("\n"),
    );

    expect(marker).toEqual([
      {
        file: "tests/example.test.ts",
        line: 2,
        modifier,
        source: invocation,
      },
    ]);
    expect(auditMarkers(marker).unexpected).toEqual(marker);
    expect(() => enforcePolicy(auditMarkers(marker))).toThrowError(
      [
        "Committed test policy violations:",
        `tests/example.test.ts:2 uses .${modifier}: ${invocation}`,
      ].join("\n"),
    );
  });

  it.each(["only", "skip", "todo"] as const)("rejects a true %s test option", (modifier) => {
    const source = `it("hidden", { ${modifier}: true }, () => {});`;
    const marker = findMarkers(
      "tests/example.test.ts",
      [`import { it } from "vitest";`, source].join("\n"),
    );

    expect(marker).toEqual([
      {
        file: "tests/example.test.ts",
        line: 2,
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
      `import { test } from "vitest";`,
      `const todo = { todo: true };`,
      `const options = SHOULD_SKIP ? { skip: true } : { ...todo };`,
      `test("hidden", options, () => {});`,
    ].join("\n");

    const markers = findMarkers("tests/example.test.ts", contents);
    expect(markers).toEqual([
      {
        file: "tests/example.test.ts",
        line: 3,
        modifier: "skip",
        source: `const options = SHOULD_SKIP ? { skip: true } : { ...todo };`,
      },
      {
        file: "tests/example.test.ts",
        line: 2,
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
      `import { it } from "vitest";`,
      `const documentation = 'it.skipIf(true)';`,
      `const request = { only: true, skip: true, todo: true };`,
      `const result = { skip: "page", todo: "later", only: "this" };`,
      `result.skip; result["todo"]; result.only;`,
      `it.each([{ only: true, skip: true, todo: true }])("runs case %#", () => {});`,
      `it("runs", { only: false, skip: false, todo: false }, () => {});`,
    ].join("\n");

    expect(findMarkers("tests/example.test.ts", contents)).toEqual([]);
  });

  it("ignores locally shadowed Vitest callable names", () => {
    const topLevelShadow = [`const test = { skip: "cursor" };`, `test.skip;`].join("\n");
    const nestedShadow = [
      `import { test } from "vitest";`,
      `function readCursor() {`,
      `  const test = { skip: "cursor" };`,
      `  return test.skip;`,
      `}`,
      `test("runs", () => {});`,
    ].join("\n");

    expect(findMarkers("tests/example.test.ts", topLevelShadow)).toEqual([]);
    expect(findMarkers("tests/example.test.ts", nestedShadow)).toEqual([]);
  });

  it("rejects modifiers reached through local Vitest re-exports", () => {
    const markers = findMarkersInSources([
      {
        file: "tests/helpers/vitest.ts",
        contents: `export { test as check } from "vitest";`,
      },
      {
        file: "tests/helpers/index.ts",
        contents: `export * from "./vitest.js";`,
      },
      {
        file: "tests/example.test.ts",
        contents: [
          `import { check } from "./helpers/index.js";`,
          `check.skip("hidden", () => {});`,
          `check.todo("unfinished");`,
        ].join("\n"),
      },
    ]);

    expect(markers).toEqual([
      {
        file: "tests/example.test.ts",
        line: 2,
        modifier: "skip",
        source: `check.skip("hidden", () => {});`,
      },
      {
        file: "tests/example.test.ts",
        line: 3,
        modifier: "todo",
        source: `check.todo("unfinished");`,
      },
    ]);
    expect(() => enforcePolicy(auditMarkers(markers))).toThrowError(
      "Committed test policy violations:",
    );
  });

  it("rejects modifiers on the TestAPI passed to suite callbacks", () => {
    const markers = findMarkersInSources([
      {
        file: "tests/helpers/vitest.ts",
        contents: `export { describe as group, suite } from "vitest";`,
      },
      {
        file: "tests/example.test.ts",
        contents: [
          `import { group, suite } from "./helpers/vitest.js";`,
          `group("group", (check) => {`,
          `  check.skip("hidden", () => {});`,
          `});`,
          `suite.each(["case"])("suite", (check) => {`,
          `  check.todo("unfinished");`,
          `});`,
        ].join("\n"),
      },
    ]);
    expect(markers).toEqual([
      {
        file: "tests/example.test.ts",
        line: 3,
        modifier: "skip",
        source: `check.skip("hidden", () => {});`,
      },
      {
        file: "tests/example.test.ts",
        line: 6,
        modifier: "todo",
        source: `check.todo("unfinished");`,
      },
    ]);
    expect(() => enforcePolicy(auditMarkers(markers))).toThrowError(
      "Committed test policy violations:",
    );
  });

  it("rejects modifiers reached through exported custom test aliases", () => {
    const markers = findMarkersInSources([
      {
        file: "tests/helpers/fixture.ts",
        contents: [
          `import { test as base } from "vitest";`,
          `const extended = base.extend({});`,
          `export const check = extended;`,
          `export { extended as verify };`,
          `export default base.extend({});`,
        ].join("\n"),
      },
      {
        file: "tests/example.test.ts",
        contents: [
          `import customCheck, { check, verify } from "./helpers/fixture.js";`,
          `check.skip("hidden", () => {});`,
          `verify.todo("unfinished");`,
          `customCheck.skip("also hidden", () => {});`,
        ].join("\n"),
      },
    ]);

    expect(markers).toEqual([
      {
        file: "tests/example.test.ts",
        line: 2,
        modifier: "skip",
        source: `check.skip("hidden", () => {});`,
      },
      {
        file: "tests/example.test.ts",
        line: 3,
        modifier: "todo",
        source: `verify.todo("unfinished");`,
      },
      {
        file: "tests/example.test.ts",
        line: 4,
        modifier: "skip",
        source: `customCheck.skip("also hidden", () => {});`,
      },
    ]);
    expect(() => enforcePolicy(auditMarkers(markers))).toThrowError(
      "Committed test policy violations:",
    );
  });

  it("contains no unexpected focused, skipped, or todo tests", () => {
    expect(repositoryAudit).toEqual({ unexpected: [], missingAllowances: [] });
  });
});
