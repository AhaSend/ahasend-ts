#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { format, resolveConfig } from "prettier";
import ts from "typescript";
import { NODE_CODE_SAMPLES, NODE_OPERATION_KEYS } from "./node-code-samples.mjs";
import { SECRET_PATTERNS } from "./secret-patterns.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const EXPECTED_NODE_SAMPLE_COUNT = 56;
const EXPECTED_ITERATOR_COUNT = 9;
export const REQUIRED_DOCUMENT_PATHS = Object.freeze([
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "docs/api-reference.md",
  "docs/cancellation.md",
  "docs/rate-pacing.md",
  "docs/retries-and-idempotency.md",
  "docs/safe-logging.md",
  "docs/security-and-webhooks.md",
  "docs/subaccounts.md",
]);
const MARKDOWN_PATHS = Object.freeze([...REQUIRED_DOCUMENT_PATHS, "examples/README.md"]);

const REQUIREMENTS = Object.freeze([
  {
    label: "npm installation",
    path: "README.md",
    text: "npm install @ahasend/sdk",
  },
  {
    label: "Node 22 runtime floor",
    path: "README.md",
    text: "Node.js 22 or later",
  },
  {
    label: "JavaScript and TypeScript parity",
    path: "README.md",
    text: "same runtime API to JavaScript and TypeScript",
  },
  {
    label: "CommonJS entry point",
    path: "README.md",
    text: 'require("@ahasend/sdk")',
  },
  {
    label: "supported TypeScript resolution modes",
    path: "README.md",
    text: "`Bundler`, `Node16`, and `NodeNext`",
  },
  {
    label: "unsupported runtime boundary",
    path: "README.md",
    text: "Browsers and edge runtimes",
  },
  {
    label: "Express 5 support",
    path: "README.md",
    text: "Express 5.x",
  },
  {
    label: "pagination guidance",
    path: "README.md",
    text: "pages are fetched lazily",
  },
  {
    label: "README idempotent-operation inventory",
    path: "README.md",
    text: "all 11 endpoints whose generated operation profile marks them idempotent",
  },
  {
    label: "README parsed webhook body behavior",
    path: "README.md",
    text: "The adapters treat an already-parsed body as a setup error",
  },
  {
    label: "README allow-listed error telemetry",
    path: "README.md",
    text: 'errorCode: isAhaSendError(e.error) ? e.error.code : "unknown"',
  },
  {
    label: "README webhook metric without recipient data",
    path: "README.md",
    text: 'metrics.increment("ahasend.webhook.delivered");',
  },
  {
    label: "constructor timeout unit",
    path: "docs/cancellation.md",
    text: "`timeoutMs` is a per-network-attempt budget in **milliseconds**",
  },
  {
    label: "environment timeout unit",
    path: "docs/cancellation.md",
    text: "`AHASEND_TIMEOUT` in **seconds**",
  },
  {
    label: "end-to-end caller cancellation",
    path: "docs/cancellation.md",
    text: "waiting for a local rate-limit\ntoken, `fetch`, response-body reading, retry backoff, and later attempts",
  },
  {
    label: "pacing timeout boundary",
    path: "docs/rate-pacing.md",
    text: "Local pacing happens before the per-attempt `timeoutMs` budget starts",
  },
  {
    label: "pacing categories",
    path: "docs/rate-pacing.md",
    text: "independent in-memory token buckets for standard and statistics operations",
  },
  {
    label: "pacing header independence",
    path: "docs/rate-pacing.md",
    text: "does not learn from undocumented\nremaining-quota response headers",
  },
  {
    label: "retry status policy",
    path: "docs/retries-and-idempotency.md",
    text: "HTTP 408, 429, and 5xx responses",
  },
  {
    label: "operation-level retry gate",
    path: "docs/retries-and-idempotency.md",
    text: "`maxRetries` never overrides the operation-level gate",
  },
  {
    label: "default first-retry jitter range",
    path: "docs/retries-and-idempotency.md",
    text: "the first retry waits from 500 to 1,000 milliseconds",
  },
  {
    label: "README operation-aware retry summary",
    path: "README.md",
    text: "generated retry profile permits another attempt",
  },
  {
    label: "idempotency key reuse",
    path: "docs/retries-and-idempotency.md",
    text: "reuses the\nsame value across all internal retry attempts",
  },
  {
    label: "secret replay retention",
    path: "docs/retries-and-idempotency.md",
    text: "5-minute replay window",
  },
  {
    label: "safe telemetry shape",
    path: "docs/safe-logging.md",
    text: "They do not expose the expanded\nURL, query string, request headers, or request body",
  },
  {
    label: "sensitive logging inventory",
    path: "docs/safe-logging.md",
    text: "one-time `secret_key` values",
  },
  {
    label: "error logging warning",
    path: "docs/safe-logging.md",
    text: "do not serialize the whole error blindly",
  },
  {
    label: "IP allow-list behavior",
    path: "docs/subaccounts.md",
    text: "A non-empty list restricts the\nkey on every v2 endpoint regardless of scopes",
  },
  {
    label: "self-lockout behavior",
    path: "docs/subaccounts.md",
    text: "terminal\nHTTP 409 and persists nothing",
  },
  {
    label: "child-key boundary",
    path: "docs/subaccounts.md",
    text: "Child credentials cannot manage nested child API keys",
  },
  {
    label: "pooled usage semantics",
    path: "docs/subaccounts.md",
    text: "`allocated_cost` is an allocation of the pooled\ninvoice, not standalone pricing",
  },
  {
    label: "timestamp versus replay distinction",
    path: "docs/security-and-webhooks.md",
    text: "Timestamp-window verification is not replay deduplication.",
  },
  {
    label: "application webhook-id responsibility",
    path: "docs/security-and-webhooks.md",
    text: "Applications must deduplicate the `webhook-id` value.",
  },
  {
    label: "atomic webhook replay claim",
    path: "docs/security-and-webhooks.md",
    text:
      "Record the ID atomically after signature verification and before performing side effects, in the\n" +
      "same transaction as durable processing work.",
  },
  {
    label: "duplicate webhook rejection pattern",
    path: "docs/security-and-webhooks.md",
    text: "Duplicate delivery: acknowledge it but do not enqueue or run the application\nhandler again.",
  },
  {
    label: "verified webhook integration",
    path: "docs/security-and-webhooks.md",
    text: "expressWebhookHandler(verifier",
  },
  {
    label: "Express adapter-owned raw stream",
    path: "docs/security-and-webhooks.md",
    text: "mounts `expressWebhookHandler` directly so the adapter reads the bounded raw\nstream and owns the empty 413 response",
  },
  {
    label: "transactional durable webhook enqueue",
    path: "docs/security-and-webhooks.md",
    text: "must commit both the unique `webhook-id` record and a\ndurable work/outbox record",
  },
  {
    label: "webhook-id durable enqueue integration",
    path: "docs/security-and-webhooks.md",
    text: "const accepted = await webhookDeliveries.enqueueOnce(webhookId, event);",
  },
  {
    label: "duplicate webhook early-return integration",
    path: "docs/security-and-webhooks.md",
    text: `if (!accepted) {
      res.statusCode = 200;
      res.end();
      return;
    }`,
  },
  {
    label: "durable webhook worker retry behavior",
    path: "docs/security-and-webhooks.md",
    text: "A worker\nfailure then leaves retryable work instead of turning the sender's next delivery into a false\nsuccess.",
  },
  {
    label: "webhook adapter error semantics",
    path: "docs/security-and-webhooks.md",
    text: "`onError` is observation-only",
  },
  {
    label: "webhook adapter body outcomes",
    path: "docs/security-and-webhooks.md",
    text: "Invalid signatures and schemas receive an opaque 400 response",
  },
  {
    label: "Express native error propagation",
    path: "docs/security-and-webhooks.md",
    text: "the adapter calls `next(originalError)` exactly once",
  },
  {
    label: "private vulnerability reporting",
    path: "SECURITY.md",
    text: "Report suspected vulnerabilities privately",
  },
  {
    label: "supported release line",
    path: "SECURITY.md",
    text: "latest published minor line",
  },
  {
    label: "security response targets",
    path: "SECURITY.md",
    text: "acknowledge a report within three business days",
  },
  {
    label: "security disclosure policy",
    path: "SECURITY.md",
    text: "coordinate a disclosure date",
  },
  {
    label: "v0.1.0 surface",
    path: "CHANGELOG.md",
    text: "## [0.1.0] — 2026-07-25",
  },
]);

const PROHIBITED_PATTERNS = Object.freeze([
  {
    label: "an Express parser mounted before the webhook adapter",
    path: "README.md",
    pattern: /^\s*express\.raw\(/mu,
  },
  {
    label: "an Express parser mounted before the webhook adapter",
    path: "docs/security-and-webhooks.md",
    pattern: /^\s*express\.raw\(/mu,
  },
  {
    label: "a claim-only webhook deduplication call",
    path: "docs/security-and-webhooks.md",
    pattern: /webhookDeliveries\.claim\(/u,
  },
  {
    label: "a full SDK error sent to exception telemetry",
    path: "README.md",
    pattern: /sentry\.captureException\s*\(\s*e\.error\s*\)/u,
  },
  {
    label: "a webhook recipient sent to console output",
    path: "README.md",
    pattern:
      /(?:console|log|logger)\.(?:log|debug|info|warn|error)\s*\([^;\n]*event\.data\.recipient/u,
  },
]);

export async function loadDocumentation(root = repositoryRoot) {
  return Object.fromEntries(
    await Promise.all(
      REQUIRED_DOCUMENT_PATHS.map(async (path) => [
        path,
        await readFile(resolve(root, path), "utf8"),
      ]),
    ),
  );
}

function fencedBlocks(source, path) {
  const blocks = [];
  const pattern = /^```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gmu;
  for (const match of source.matchAll(pattern)) {
    const language = match[1].toLowerCase();
    const contents = match[2];
    const line = source.slice(0, match.index).split("\n").length;
    blocks.push({ path, line, language, source: contents });
  }
  return blocks;
}

function markdownLinks(source, path) {
  return [...source.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map((match) => ({
    path,
    line: source.slice(0, match.index).split("\n").length,
    target: match[1],
  }));
}

function shellCommands(block) {
  return block.source
    .split("\n")
    .map((source, index) => ({ path: block.path, line: block.line + index + 1, source }))
    .filter(({ source }) => {
      const trimmed = source.trim();
      return (
        trimmed !== "" &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("$env:") &&
        !trimmed.startsWith("export ") &&
        !trimmed.startsWith("set ")
      );
    });
}

async function loadExamples(root) {
  const directory = resolve(root, "examples");
  const names = (await readdir(directory)).filter((name) => extname(name) === ".mjs").sort();
  return Promise.all(
    names.map(async (name) => ({
      path: `examples/${name}`,
      source: await readFile(resolve(directory, name), "utf8"),
    })),
  );
}

/**
 * Build one deterministic inventory used by every documentation check.
 */
export async function buildDocumentationIndex(root = repositoryRoot) {
  const documents = Object.fromEntries(
    await Promise.all(
      MARKDOWN_PATHS.map(async (path) => [path, await readFile(resolve(root, path), "utf8")]),
    ),
  );
  const blocks = Object.entries(documents).flatMap(([path, source]) => fencedBlocks(source, path));
  const profile = JSON.parse(
    await readFile(resolve(root, "src/generated/operation-profile.json"), "utf8"),
  );

  return Object.freeze({
    documents,
    commands: Object.freeze(
      blocks
        .filter(({ language }) => language === "bash" || language === "sh" || language === "shell")
        .flatMap(shellCommands),
    ),
    links: Object.freeze(
      Object.entries(documents).flatMap(([path, source]) => markdownLinks(source, path)),
    ),
    snippets: Object.freeze(
      blocks.filter(({ language }) =>
        ["js", "javascript", "mjs", "ts", "typescript"].includes(language),
      ),
    ),
    examples: Object.freeze(await loadExamples(root)),
    nodeSamples: NODE_CODE_SAMPLES,
    profileSummary: Object.freeze({
      operations: profile.operations?.length,
      iterators: profile.iterators?.length,
    }),
  });
}

function syntaxDiagnostics(source, filename, scriptKind) {
  return ts
    .createSourceFile(filename, source, ts.ScriptTarget.ESNext, true, scriptKind)
    .parseDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

function verifyJavaScriptSyntax(label, source) {
  const diagnostics = syntaxDiagnostics(source, label, ts.ScriptKind.JS);
  if (diagnostics.length > 0) {
    throw new TypeError(`${label} is not valid ESM JavaScript: ${diagnostics.join("; ")}`);
  }
}

function propertyPath(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const parent = propertyPath(node.expression);
    return parent === undefined ? undefined : `${parent}.${node.name.text}`;
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    const parent = propertyPath(node.expression);
    return parent === undefined ? undefined : `${parent}.${node.argumentExpression.text}`;
  }
  return undefined;
}

function sourceFileFor(label, source, scriptKind = ts.ScriptKind.JS) {
  return ts.createSourceFile(label, source, ts.ScriptTarget.ESNext, true, scriptKind);
}

function hasUnsafeConsoleOutput(sourceFile) {
  const sensitiveIdentifiers = new Set();
  function isSensitiveReference(node) {
    if (
      ts.isAwaitExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      return isSensitiveReference(node.expression);
    }
    const path = propertyPath(node);
    return (
      (ts.isIdentifier(node) &&
        (node.text === "idempotencyKey" || sensitiveIdentifiers.has(node.text))) ||
      path?.endsWith(".secret_key") === true ||
      /(?:^|\.)(?:err|error)\.body$/u.test(path ?? "") ||
      /(?:^|\.)event\.data\.(?:recipient|subject)$/u.test(path ?? "")
    );
  }
  function containsSensitiveValue(node) {
    if (isSensitiveReference(node)) return true;
    let sensitive = false;
    ts.forEachChild(node, (child) => {
      if (containsSensitiveValue(child)) sensitive = true;
    });
    return sensitive;
  }
  function collectSensitiveIdentifiers(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isSensitiveReference(node.initializer)
    ) {
      sensitiveIdentifiers.add(node.name.text);
    }
    ts.forEachChild(node, collectSensitiveIdentifiers);
  }
  collectSensitiveIdentifiers(sourceFile);

  let unsafe = false;
  function visit(node) {
    if (unsafe) return;
    if (
      ts.isCallExpression(node) &&
      /^(?:console|log|logger)\.(?:log|debug|info|warn|error)$/u.test(
        propertyPath(node.expression) ?? "",
      )
    ) {
      unsafe = node.arguments.some(containsSensitiveValue);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return unsafe;
}

function statementTerminates(statement) {
  if (ts.isThrowStatement(statement) || ts.isReturnStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && statementTerminates(last);
  }
  return false;
}

function isMutationGuard(statement) {
  if (!ts.isIfStatement(statement) || !statementTerminates(statement.thenStatement)) return false;
  const condition = statement.expression;
  if (
    !ts.isBinaryExpression(condition) ||
    (condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken)
  ) {
    return false;
  }
  return (
    (propertyPath(condition.left) === "process.env.AHASEND_ALLOW_MUTATIONS" &&
      ts.isStringLiteral(condition.right) &&
      condition.right.text === "1") ||
    (propertyPath(condition.right) === "process.env.AHASEND_ALLOW_MUTATIONS" &&
      ts.isStringLiteral(condition.left) &&
      condition.left.text === "1")
  );
}

function hasMutationGuardBefore(sourceFile, position) {
  return sourceFile.statements.some(
    (statement) => statement.getStart(sourceFile) < position && isMutationGuard(statement),
  );
}

function hasSandboxFlag(call) {
  function objectHasSandboxFlag(node) {
    return (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ((ts.isIdentifier(property.name) && property.name.text === "sandbox") ||
            (ts.isStringLiteral(property.name) && property.name.text === "sandbox")) &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword,
      )
    );
  }
  return call.arguments.some(objectHasSandboxFlag);
}

function hasSandboxedFetch(call) {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  const body = options.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === "body") ||
        (ts.isStringLiteral(property.name) && property.name.text === "body")),
  );
  if (
    body === undefined ||
    !ts.isPropertyAssignment(body) ||
    !ts.isCallExpression(body.initializer)
  ) {
    return false;
  }
  return (
    propertyPath(body.initializer.expression) === "JSON.stringify" &&
    body.initializer.arguments.some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === "sandbox") ||
              (ts.isStringLiteral(property.name) && property.name.text === "sandbox")) &&
            property.initializer.kind === ts.SyntaxKind.TrueKeyword,
        ),
    )
  );
}

function findUnguardedClientMutation(sourceFile) {
  let unguarded = false;
  function visit(node) {
    if (unguarded) return;
    if (ts.isCallExpression(node)) {
      const path = propertyPath(node.expression);
      if (
        path !== undefined &&
        /^client\..+\.(?:create|update|delete|wipe|suspend|unsuspend|send)$/u.test(path) &&
        !hasSandboxFlag(node) &&
        !hasMutationGuardBefore(sourceFile, node.getStart(sourceFile))
      ) {
        unguarded = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return unguarded;
}

function hasDurableWebhookDeduplication(sourceFile) {
  let found = false;
  function inspectContainer(node) {
    if (found) return;
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      for (const [index, statement] of node.statements.entries()) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
          const initializer = ts.isAwaitExpression(declaration.initializer)
            ? declaration.initializer.expression
            : declaration.initializer;
          if (
            !ts.isCallExpression(initializer) ||
            !propertyPath(initializer.expression)?.endsWith(".enqueueOnce") ||
            initializer.arguments.length !== 2 ||
            propertyPath(initializer.arguments[0]) !== "webhookId" ||
            propertyPath(initializer.arguments[1]) !== "event"
          ) {
            continue;
          }
          const acceptedName = declaration.name.text;
          const candidate = node.statements[index + 1];
          const rejectsDuplicate =
            candidate !== undefined &&
            ts.isIfStatement(candidate) &&
            ts.isPrefixUnaryExpression(candidate.expression) &&
            candidate.expression.operator === ts.SyntaxKind.ExclamationToken &&
            propertyPath(candidate.expression.operand) === acceptedName &&
            statementTerminates(candidate.thenStatement);
          if (rejectsDuplicate) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, inspectContainer);
  }
  inspectContainer(sourceFile);
  return found;
}

async function verifyLint(index, root) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{js,mjs,ts}"],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaVersion: "latest", sourceType: "module" },
        },
        rules: {
          "constructor-super": "error",
          "for-direction": "error",
          "getter-return": "error",
          "no-async-promise-executor": "error",
          "no-constant-binary-expression": "error",
          "no-dupe-args": "error",
          "no-dupe-keys": "error",
          "no-new-native-nonconstructor": "error",
          "no-promise-executor-return": "error",
          "no-self-assign": "error",
          "no-unreachable": "error",
          "no-unreachable-loop": "error",
          "no-unsafe-finally": "error",
          "no-unsafe-negation": "error",
          "require-yield": "error",
          "use-isnan": "error",
          "valid-typeof": "error",
        },
      },
    ],
  });
  const sources = [
    ...index.examples.map((example) => ({ ...example, language: "mjs" })),
    ...index.snippets.filter(({ path }) => path !== "docs/api-reference.md"),
  ];
  const results = (
    await Promise.all(
      sources.map(({ path, line, language, source }, index) =>
        eslint.lintText(source, {
          filePath: resolve(
            root,
            `.documentation-lint/${index}-${path.replaceAll("/", "-")}.${language.startsWith("ts") ? "ts" : "mjs"}`,
          ),
          warnIgnored: false,
        }),
      ),
    )
  ).flat();
  const errors = results.flatMap((result, sourceIndex) =>
    result.messages
      .filter(({ severity }) => severity === 2)
      .map(
        ({ line: lintLine, column, message, ruleId }) =>
          `${sources[sourceIndex].path}:${(sources[sourceIndex].line ?? 0) + lintLine}:${column} ${message} (${ruleId ?? "parse"})`,
      ),
  );
  if (errors.length > 0) {
    throw new TypeError(`Documentation lint failed:\n${errors.join("\n")}`);
  }
}

const exportNameCache = new Map();

function publicExportNames(root, moduleName) {
  let exportsByModule = exportNameCache.get(root);
  if (exportsByModule === undefined) {
    const configPath = resolve(root, "tsconfig.json");
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error !== undefined) {
      throw new TypeError(
        `Unable to read ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
      );
    }
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    exportsByModule = new Map();
    for (const [name, path] of [
      ["@ahasend/sdk", "src/index.ts"],
      ["@ahasend/sdk/webhooks", "src/webhooks/index.ts"],
    ]) {
      const sourceFile = program.getSourceFile(resolve(root, path));
      const symbol = sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile);
      if (symbol === undefined) {
        throw new TypeError(`Unable to inspect public exports from ${path}.`);
      }
      exportsByModule.set(
        name,
        new Set(checker.getExportsOfModule(symbol).map(({ name }) => name)),
      );
    }
    exportNameCache.set(root, exportsByModule);
  }
  const names = exportsByModule.get(moduleName);
  if (names === undefined) throw new TypeError(`Unknown SDK documentation module: ${moduleName}`);
  return names;
}

function verifySdkImports(index, root) {
  for (const snippet of index.snippets) {
    if (snippet.path === "docs/api-reference.md") continue;
    const scriptKind =
      snippet.language === "ts" || snippet.language === "typescript"
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
    const sourceFile = sourceFileFor(`${snippet.path}:${snippet.line}`, snippet.source, scriptKind);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        (statement.moduleSpecifier.text !== "@ahasend/sdk" &&
          statement.moduleSpecifier.text !== "@ahasend/sdk/webhooks") ||
        statement.importClause?.namedBindings === undefined ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      const names = publicExportNames(root, statement.moduleSpecifier.text);
      for (const element of statement.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (!names.has(importedName)) {
          throw new TypeError(
            `${snippet.path}:${snippet.line} imports missing ${statement.moduleSpecifier.text} export ${importedName}.`,
          );
        }
      }
    }
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function verifyLinks(index, root) {
  for (const link of index.links) {
    if (/^(?:https?:|mailto:|#)/u.test(link.target)) continue;
    const target = link.target.split("#", 1)[0];
    if (target === "") continue;
    const absolute = resolve(root, dirname(link.path), target);
    if (!absolute.startsWith(`${resolve(root)}${sep}`) || !(await pathExists(absolute))) {
      throw new TypeError(`${link.path}:${link.line} has an unresolved link: ${link.target}`);
    }
  }
}

async function verifyCommands(index, manifest, root) {
  for (const command of index.commands) {
    const npmRun = command.source.match(/\bnpm run ([A-Za-z0-9:_-]+)/u);
    if (npmRun !== null && typeof manifest.scripts?.[npmRun[1]] !== "string") {
      throw new TypeError(
        `${command.path}:${command.line} references missing package script ${npmRun[1]}`,
      );
    }
    for (const match of command.source.matchAll(
      /(?:^|\s)((?:examples|scripts)\/[A-Za-z0-9_./-]+\.(?:mjs|js)|openapi\.yaml)(?=\s|$)/gu,
    )) {
      if (!(await pathExists(resolve(root, match[1])))) {
        throw new TypeError(
          `${command.path}:${command.line} references missing command input ${match[1]}`,
        );
      }
    }
  }
}

function verifyExamples(index) {
  if (Object.keys(index.nodeSamples).length !== EXPECTED_NODE_SAMPLE_COUNT) {
    throw new TypeError(`Expected ${EXPECTED_NODE_SAMPLE_COUNT} Node samples.`);
  }
  if (
    index.profileSummary.operations !== EXPECTED_NODE_SAMPLE_COUNT ||
    index.profileSummary.iterators !== EXPECTED_ITERATOR_COUNT
  ) {
    throw new TypeError("Generated operation profile summary is out of date.");
  }

  for (const [operationId, sample] of Object.entries(index.nodeSamples)) {
    if (NODE_OPERATION_KEYS[operationId] === undefined) {
      throw new TypeError(`Node sample ${operationId} has no operation profile key.`);
    }
    const sourceFile = sourceFileFor(`Node sample ${operationId}`, sample.source);
    verifyJavaScriptSyntax(`Node sample ${operationId}`, sample.source);
    const operationKey = NODE_OPERATION_KEYS[operationId];
    if (
      operationKey !== undefined &&
      !operationKey.startsWith("GET ") &&
      !hasSandboxedFetch(
        [...sourceFile.statements]
          .flatMap((statement) => {
            const calls = [];
            function collect(node) {
              if (ts.isCallExpression(node)) calls.push(node);
              ts.forEachChild(node, collect);
            }
            collect(statement);
            return calls;
          })
          .find((call) => propertyPath(call.expression) === "fetch") ?? {
          arguments: [],
        },
      ) &&
      !hasMutationGuardBefore(sourceFile, sourceFile.end)
    ) {
      throw new TypeError(`Node sample ${operationId} performs an unguarded mutation.`);
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(sample.source)) {
        throw new TypeError(`Node sample ${operationId} contains unsafe secret output.`);
      }
    }
    if (hasUnsafeConsoleOutput(sourceFile)) {
      throw new TypeError(`Node sample ${operationId} contains unsafe secret output.`);
    }
  }
  for (const example of index.examples) {
    const sourceFile = sourceFileFor(example.path, example.source);
    verifyJavaScriptSyntax(example.path, example.source);
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(example.source)) {
        throw new TypeError(`${example.path} contains unsafe secret or payload output.`);
      }
    }
    if (hasUnsafeConsoleOutput(sourceFile)) {
      throw new TypeError(`${example.path} contains unsafe secret or payload output.`);
    }
  }
  for (const [path, source] of Object.entries(index.documents)) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(source)) {
        throw new TypeError(`${path} contains an unclassified secret signature.`);
      }
    }
  }

  for (const example of index.examples) {
    if (findUnguardedClientMutation(sourceFileFor(example.path, example.source))) {
      throw new TypeError(`${example.path} performs an unguarded mutation.`);
    }
  }

  for (const path of ["examples/webhook-express.mjs", "examples/next-webhook-route.mjs"]) {
    const example = index.examples.find((candidate) => candidate.path === path);
    if (
      example === undefined ||
      !hasDurableWebhookDeduplication(sourceFileFor(example.path, example.source))
    ) {
      throw new TypeError(`${path} must demonstrate application-owned webhook-id deduplication.`);
    }
  }
  const express = index.examples.find(({ path }) => path === "examples/webhook-express.mjs");
  if (/^\s*express\.(?:raw|json)\(/mu.test(express?.source ?? "")) {
    throw new TypeError("The Express webhook example must let the adapter own the raw stream.");
  }
  const next = index.examples.find(({ path }) => path === "examples/next-webhook-route.mjs");
  if (!next?.source.includes('export const runtime = "nodejs"')) {
    throw new TypeError("The Next.js example must select the Node.js runtime explicitly.");
  }
}

async function verifyFormatting(index, root) {
  const config = (await resolveConfig(resolve(root, "README.md"))) ?? {};
  for (const [path, source] of [
    ...Object.entries(index.documents),
    ...index.examples.map((example) => [example.path, example.source]),
  ]) {
    const formatted = await format(source, { ...config, filepath: resolve(root, path) });
    if (formatted !== source) {
      throw new TypeError(`${path} does not match the repository Prettier format.`);
    }
  }
}

export async function verifyDocumentationIndex(index, root = repositoryRoot) {
  verifyDocumentation(index.documents);
  verifyExamples(index);
  verifySdkImports(index, root);
  await verifyLinks(index, root);
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await verifyCommands(index, manifest, root);
  await verifyFormatting(index, root);
  await verifyLint(index, root);

  for (const snippet of index.snippets) {
    // Generated API-reference fences render method signatures, not standalone
    // programs; their shape is validated by the generator conformance suite.
    if (snippet.path === "docs/api-reference.md") continue;
    const scriptKind =
      snippet.language === "ts" || snippet.language === "typescript"
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
    const diagnostics = syntaxDiagnostics(
      snippet.source,
      `${snippet.path}:${snippet.line}`,
      scriptKind,
    );
    if (diagnostics.length > 0) {
      throw new TypeError(
        `${snippet.path}:${snippet.line} has invalid ${snippet.language} syntax: ${diagnostics.join("; ")}`,
      );
    }
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new TypeError(
      `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`.trimEnd(),
    );
  }
}

function packageDirectory(packageName) {
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    // Some packages hide package.json behind an export map.
  }
  let directory = dirname(require.resolve(packageName));
  while (true) {
    const candidate = resolve(directory, "package.json");
    try {
      if (require(candidate).name === packageName) return directory;
    } catch {
      // Continue toward the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new TypeError(`Unable to find the installed ${packageName} package directory.`);
    }
    directory = parent;
  }
}

async function assertTarball(tarballPath, expectedChecksum) {
  if (!/^[a-f0-9]{64}$/u.test(expectedChecksum)) {
    throw new TypeError("SDK_TARBALL_SHA256 must be a lowercase SHA-256 digest.");
  }
  const bytes = await readFile(tarballPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedChecksum, "hex"))) {
    throw new TypeError(
      `SDK tarball checksum mismatch: expected ${expectedChecksum}, received ${actual}.`,
    );
  }
}

/**
 * Type-check runnable examples and all generated Node samples against an
 * installed, checksum-verified package tarball.
 */
export async function verifyPackagedJavaScript(
  tarballPath,
  expectedChecksum,
  root = repositoryRoot,
  nodeSamples = NODE_CODE_SAMPLES,
) {
  const tarball = resolve(tarballPath);
  await assertTarball(tarball, expectedChecksum);
  if (Object.keys(nodeSamples).length !== EXPECTED_NODE_SAMPLE_COUNT) {
    throw new TypeError(`Expected ${EXPECTED_NODE_SAMPLE_COUNT} packaged Node samples.`);
  }
  const index = await buildDocumentationIndex(root);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ahasend-sdk-docs-"));
  try {
    await writeFile(
      resolve(temporaryRoot, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    const npmExecutable = process.env.npm_execpath;
    const npmCommand = npmExecutable === undefined ? "npm" : process.execPath;
    const localTypePackages = ["@types/node", "undici-types", "express", "@types/express"].map(
      packageDirectory,
    );
    const npmArguments =
      npmExecutable === undefined
        ? [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            tarball,
            ...localTypePackages,
          ]
        : [
            npmExecutable,
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            tarball,
            ...localTypePackages,
          ];
    run(npmCommand, npmArguments, temporaryRoot);

    const examplesDirectory = resolve(temporaryRoot, "examples");
    const samplesDirectory = resolve(temporaryRoot, "node-samples");
    const snippetsDirectory = resolve(temporaryRoot, "snippets");
    await mkdir(samplesDirectory);
    await mkdir(snippetsDirectory);
    await cp(resolve(root, "examples"), examplesDirectory, { recursive: true });
    for (const name of await readdir(examplesDirectory)) {
      if (extname(name) !== ".mjs") continue;
      const path = resolve(examplesDirectory, name);
      const source = (await readFile(path, "utf8"))
        .replaceAll("../dist/webhooks/index.js", "@ahasend/sdk/webhooks")
        .replaceAll("../dist/index.js", "@ahasend/sdk");
      await writeFile(path, source);
      run(process.execPath, ["--check", path], temporaryRoot);
    }
    for (const [operationId, sample] of Object.entries(nodeSamples)) {
      const path = resolve(samplesDirectory, `${operationId}.mjs`);
      await writeFile(path, sample.source);
      run(process.execPath, ["--check", path], temporaryRoot);
    }
    const runnableSnippets = index.snippets.filter(({ path }) => path !== "docs/api-reference.md");
    for (const [snippetIndex, snippet] of runnableSnippets.entries()) {
      const isTypeScript = snippet.language === "ts" || snippet.language === "typescript";
      const path = resolve(
        snippetsDirectory,
        `snippet-${snippetIndex}.${isTypeScript ? "ts" : "mjs"}`,
      );
      await writeFile(path, snippet.source);
      if (!isTypeScript) run(process.execPath, ["--check", path], temporaryRoot);
    }
    await writeFile(
      resolve(snippetsDirectory, "documentation-globals.d.ts"),
      `export {};
declare global {
  const AhaSendClient: typeof import("@ahasend/sdk").AhaSendClient;
  const client: import("@ahasend/sdk").AhaSendClient;
  const verifier: InstanceType<typeof import("@ahasend/sdk/webhooks").WebhookVerifier>;
  const accountId: string;
  const apiKey: string;
  const body: any;
  const child: any;
  const customerId: string;
  const fastify: any;
  const headersRecordOrHeaders: any;
  const log: any;
  const logger: any;
  const message: any;
  const messageId: string;
  const metrics: any;
  const orderId: string;
  const rawBodyStringOrBuffer: string | Buffer;
  const reportLocalFailure: (value: unknown) => void;
  const secretStore: any;
  const traceId: string;
  const webhookDeliveries: any;
}
`,
    );

    await writeFile(
      resolve(temporaryRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            allowJs: true,
            checkJs: true,
            noEmit: true,
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: false,
            skipLibCheck: true,
          },
          include: [
            "examples/**/*.mjs",
            "snippets/**/*.mjs",
            "snippets/**/*.ts",
            "snippets/**/*.d.ts",
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      resolve(temporaryRoot, "tsconfig.node-samples.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            allowJs: true,
            checkJs: true,
            noEmit: true,
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
          },
          include: ["node-samples/**/*.mjs"],
        },
        null,
        2,
      )}\n`,
    );
    run(
      process.execPath,
      [
        resolve(root, "node_modules/typescript/bin/tsc"),
        "--project",
        "tsconfig.node-samples.json",
        "--pretty",
        "false",
      ],
      temporaryRoot,
    );
    run(
      process.execPath,
      [
        resolve(root, "node_modules/typescript/bin/tsc"),
        "--project",
        "tsconfig.json",
        "--pretty",
        "false",
      ],
      temporaryRoot,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function verifyDocumentation(documents) {
  if (documents === null || typeof documents !== "object" || Array.isArray(documents)) {
    throw new TypeError("Documentation input must be a path-to-source record.");
  }

  for (const path of REQUIRED_DOCUMENT_PATHS) {
    if (typeof documents[path] !== "string") {
      throw new TypeError(`Missing required documentation file: ${path}`);
    }
  }

  for (const requirement of REQUIREMENTS) {
    if (!documents[requirement.path].includes(requirement.text)) {
      throw new TypeError(`${requirement.path} is missing required guidance: ${requirement.label}`);
    }
  }

  for (const prohibited of PROHIBITED_PATTERNS) {
    if (prohibited.pattern.test(documents[prohibited.path])) {
      throw new TypeError(`${prohibited.path} contains unsafe guidance: ${prohibited.label}`);
    }
  }
}

async function main() {
  if (process.argv.length > 4) {
    throw new TypeError("Usage: node scripts/verify-docs.mjs [tarball sha256]");
  }
  const index = await buildDocumentationIndex();
  await verifyDocumentationIndex(index);
  const tarball = process.argv[2] ?? process.env.SDK_TARBALL;
  const checksum = process.argv[3] ?? process.env.SDK_TARBALL_SHA256;
  if ((tarball === undefined) !== (checksum === undefined)) {
    throw new TypeError("Provide both SDK_TARBALL and SDK_TARBALL_SHA256.");
  }
  if (tarball !== undefined && checksum !== undefined) {
    await verifyPackagedJavaScript(tarball, checksum);
  }
  process.stdout.write(
    `verify-docs: ${REQUIRED_DOCUMENT_PATHS.length} documents passed; ${index.examples.length} examples and ${Object.keys(index.nodeSamples).length} Node samples passed\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-docs: ${message}\n`);
    process.exitCode = 1;
  });
}
