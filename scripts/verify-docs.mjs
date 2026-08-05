#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix, resolve, sep } from "node:path";
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
const SUPPORTING_EXAMPLE_PATHS = Object.freeze([
  "examples/next-webhook-route/create-webhook-route.mjs",
]);
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
const INSTALLED_DOCUMENT_PATHS = Object.freeze(["README.md", "CHANGELOG.md"]);
const AUTHORITATIVE_LINK_HOSTS = Object.freeze([
  "ahasend.com",
  "www.ahasend.com",
  "dash.ahasend.com",
  "github.com",
  "keepachangelog.com",
  "semver.org",
]);
export const INSTALLED_EXTERNAL_URLS = Object.freeze([
  "https://ahasend.com",
  "https://github.com/AhaSend/ahasend-ts/blob/main/CHANGELOG.md",
  "https://dash.ahasend.com",
  "https://github.com/AhaSend/ahasend-ts/blob/main/docs/api-reference.md",
  "https://github.com/AhaSend/ahasend-ts/blob/main/docs/retries-and-idempotency.md",
  "https://github.com/AhaSend/ahasend-ts/blob/main/docs/cancellation.md",
  "https://github.com/AhaSend/ahasend-ts/blob/main/docs/rate-pacing.md",
  "https://github.com/AhaSend/ahasend-ts/blob/main/docs/safe-logging.md",
  "https://github.com/AhaSend/ahasend-ts/blob/main/docs/security-and-webhooks.md",
  "https://github.com/AhaSend/ahasend-ts/blob/main/docs/subaccounts.md",
  "https://github.com/AhaSend/ahasend-ts/tree/main/examples",
  "https://github.com/AhaSend/ahasend-ts/blob/main/examples/README.md",
  "https://github.com/AhaSend/ahasend-ts/issues",
  "https://github.com/AhaSend/ahasend-ts/blob/main/SECURITY.md",
  "https://github.com/AhaSend/ahasend-ts/blob/main/LICENSE",
  "https://keepachangelog.com/en/1.1.0/",
  "https://semver.org/",
]);
const INSTALLED_LINK_TIMEOUT_MS = 10_000;
const INSTALLED_LINK_REQUEST_CAP = 64;
const INSTALLED_LINK_REDIRECT_CAP = 2;

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

function maskMarkdownCode(source) {
  const masked = source.split("");
  const mask = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };
  for (const match of source.matchAll(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gmu)) {
    const marker = match[1];
    const markerIndex = match.index + match[0].indexOf(marker);
    if (masked[markerIndex] === " ") continue;
    const closing = new RegExp(
      `^[ \\t]{0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)`,
      "gmu",
    );
    closing.lastIndex = match.index + match[0].length;
    const closingMatch = closing.exec(source);
    mask(
      match.index,
      closingMatch === null ? source.length : closingMatch.index + closingMatch[0].length,
    );
  }
  for (const match of source.matchAll(/<!--[\s\S]*?-->/gu)) {
    mask(match.index, match.index + match[0].length);
  }
  const withoutBlocks = masked.join("");
  for (let cursor = 0; cursor < withoutBlocks.length; cursor += 1) {
    if (withoutBlocks[cursor] !== "`") continue;
    let openingEnd = cursor + 1;
    while (withoutBlocks[openingEnd] === "`") openingEnd += 1;
    const marker = withoutBlocks.slice(cursor, openingEnd);
    let closing = withoutBlocks.indexOf(marker, openingEnd);
    while (
      closing !== -1 &&
      (withoutBlocks[closing - 1] === "`" || withoutBlocks[closing + marker.length] === "`")
    ) {
      closing = withoutBlocks.indexOf(marker, closing + marker.length);
    }
    if (closing === -1) {
      cursor = openingEnd - 1;
      continue;
    }
    mask(cursor, closing + marker.length);
    cursor = closing + marker.length - 1;
  }
  return masked.join("");
}

function markdownClosingBracket(source, start) {
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === "[") {
      depth += 1;
    } else if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function markdownInlineDestination(source, openParenthesis) {
  let cursor = openParenthesis + 1;
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  const start = cursor;
  if (source[cursor] === "<") {
    const end = source.indexOf(">", cursor + 1);
    if (end === -1 || source.indexOf(")", end + 1) === -1) return undefined;
    return source.slice(cursor + 1, end);
  }

  let nestedParentheses = 0;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 1;
    } else if (character === "(") {
      nestedParentheses += 1;
    } else if (character === ")") {
      if (nestedParentheses === 0) return source.slice(start, cursor);
      nestedParentheses -= 1;
    } else if (/\s/u.test(character)) {
      return source.indexOf(")", cursor) === -1 ? undefined : source.slice(start, cursor);
    }
  }
  return undefined;
}

function trimBareUrl(target) {
  let trimmed = target.replace(/[!*,.:;?_~]+$/u, "");
  while (
    trimmed.endsWith(")") &&
    [...trimmed].filter((character) => character === ")").length >
      [...trimmed].filter((character) => character === "(").length
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function markdownLinks(source, path) {
  const links = [];
  const markdown = maskMarkdownCode(source);
  const add = (target, index) => {
    if (target === "") return;
    links.push({
      path,
      line: source.slice(0, index).split("\n").length,
      target,
    });
  };

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] !== "[") continue;
    const closingBracket = markdownClosingBracket(markdown, index);
    if (closingBracket === -1) continue;
    let openParenthesis = closingBracket + 1;
    while (/\s/u.test(markdown[openParenthesis] ?? "")) openParenthesis += 1;
    if (markdown[openParenthesis] !== "(") continue;
    const target = markdownInlineDestination(markdown, openParenthesis);
    if (target !== undefined) add(target, index);
  }

  const patterns = [
    /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?:(?:\r?\n)[ \t]+)?(?:<([^>\n]+)>|([^\s]+))/gmu,
    /<((?:https?):\/\/[^<>\s]+)>/giu,
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) add(match[1] ?? match[2], match.index);
  }

  for (const tag of markdown.matchAll(/<[A-Za-z][^<>]*>/gu)) {
    for (const attribute of tag[0].matchAll(
      /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu,
    )) {
      add(attribute[1] ?? attribute[2] ?? attribute[3], tag.index + attribute.index);
    }
  }

  for (const match of markdown.matchAll(/https?:\/\/[^\s<>"'\[\]]+/giu)) {
    add(trimBareUrl(match[0]), match.index);
  }
  return links;
}

function shellCommands(block) {
  return block.source
    .split("\n")
    .map((source, index) => ({ path: block.path, line: block.line + index + 1, source }))
    .filter(({ source }) => {
      const trimmed = source.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
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

async function loadSupportingExamples(root) {
  return Promise.all(
    SUPPORTING_EXAMPLE_PATHS.map(async (path) => ({
      path,
      source: await readFile(resolve(root, path), "utf8"),
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
        .filter(({ language }) =>
          ["bash", "powershell", "ps1", "pwsh", "sh", "shell"].includes(language),
        )
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
    supportingExamples: Object.freeze(await loadSupportingExamples(root)),
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

function isAllowedOutputName(name) {
  return (
    /^(?:count|status|code|errorCode|requestId|request_id)$/u.test(name) ||
    /(?:Count|_count|Id|_id)$/u.test(name) ||
    name === "id" ||
    name === "length"
  );
}

function unwrapOutputExpression(node) {
  let expression = node;
  while (
    ts.isAwaitExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function isStaticOutputValue(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  );
}

function isOutputScope(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isFunctionLike(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

function bindingForName(name, identifier) {
  if (ts.isIdentifier(name)) return name.text === identifier ? name.parent : undefined;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const binding = bindingForName(element.name, identifier);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

function isBlockScopedVariableDeclaration(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0
  );
}

function bindingInOutputScope(scope, name) {
  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) {
      const binding = bindingForName(parameter.name, name);
      if (binding !== undefined) return binding;
    }
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
    const binding = bindingForName(scope.variableDeclaration.name, name);
    if (binding !== undefined) return binding;
  }

  let binding;
  function visit(node, nestedScope = false) {
    if (binding !== undefined) return;
    if (node !== scope && isOutputScope(node)) {
      if (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) return;
      if (ts.isFunctionLike(node)) return;
      nestedScope = true;
    }
    if (ts.isVariableDeclaration(node)) {
      const blockScoped = isBlockScopedVariableDeclaration(node);
      const belongsToScope =
        ts.isFunctionLike(scope) || nestedScope
          ? !blockScoped
          : blockScoped || ts.isSourceFile(scope);
      if (belongsToScope) {
        binding = bindingForName(node.name, name);
        if (binding !== undefined) return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, nestedScope));
  }
  visit(scope);
  return binding;
}

function outputBindingAt(identifier) {
  for (let ancestor = identifier.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    if (!isOutputScope(ancestor)) continue;
    const binding = bindingInOutputScope(ancestor, identifier.text);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isExternalOutputBinding(binding) {
  return (
    ts.isParameter(binding) ||
    (ts.isVariableDeclaration(binding) && ts.isCatchClause(binding.parent))
  );
}

function staticPropertyName(name) {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return staticElementAccessName(name.expression);
  }
  return undefined;
}

function staticElementAccessName(node, seenBindings = new Set()) {
  const expression = unwrapOutputExpression(node);
  if (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const binding = outputBindingAt(expression);
  if (
    binding === undefined ||
    seenBindings.has(binding.pos) ||
    !ts.isVariableDeclaration(binding) ||
    binding.initializer === undefined ||
    !ts.isVariableDeclarationList(binding.parent) ||
    (binding.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  const nextSeen = new Set(seenBindings);
  nextSeen.add(binding.pos);
  return staticElementAccessName(binding.initializer, nextSeen);
}

function memberAccessPath(node) {
  const expression = unwrapOutputExpression(node);
  if (ts.isIdentifier(expression)) return { root: expression, properties: [] };
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = memberAccessPath(expression.expression);
    if (parent === undefined) return undefined;
    return { root: parent.root, properties: [...parent.properties, expression.name.text] };
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined) {
    const name = staticElementAccessName(expression.argumentExpression);
    const parent = memberAccessPath(expression.expression);
    if (name === undefined || parent === undefined) return undefined;
    return { root: parent.root, properties: [...parent.properties, name] };
  }
  return undefined;
}

function hasUnsafeConsoleOutput(sourceFile, enforceAllowlist = false) {
  const sensitiveIdentifiers = new Set();
  function isSensitiveReference(node) {
    const expression = unwrapOutputExpression(node);
    const path = propertyPath(expression);
    return (
      (ts.isIdentifier(expression) &&
        (expression.text === "idempotencyKey" || sensitiveIdentifiers.has(expression.text))) ||
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

  function visitBeforeOutputUse(use, inspect) {
    const invokedFunctions = new Set();
    function collectInvocations(node) {
      if (node.getStart(sourceFile) >= use.getStart(sourceFile)) return;
      if (ts.isCallExpression(node)) {
        const expression = unwrapOutputExpression(node.expression);
        if (ts.isIdentifier(expression)) invokedFunctions.add(expression.text);
      }
      ts.forEachChild(node, collectInvocations);
    }
    collectInvocations(sourceFile);

    function visit(node, inInvokedFunction = false) {
      if (!inInvokedFunction && node.getStart(sourceFile) >= use.getStart(sourceFile)) {
        if (
          ts.isFunctionDeclaration(node) &&
          node.name !== undefined &&
          invokedFunctions.has(node.name.text) &&
          node.body !== undefined
        ) {
          visit(node.body, true);
        }
        return;
      }
      inspect(node);
      ts.forEachChild(node, (child) => visit(child, inInvokedFunction));
    }
    visit(sourceFile);
  }

  function outputBindingValues(binding, use) {
    const values = [];
    const selections = [];
    let unsupportedWrite = false;
    if (ts.isVariableDeclaration(binding) || ts.isParameter(binding)) {
      if (binding.initializer !== undefined) values.push(binding.initializer);
      else if (!isExternalOutputBinding(binding)) unsupportedWrite = true;
    } else if (!ts.isBindingElement(binding)) {
      unsupportedWrite = true;
    }

    function assignmentSelections(node, properties = [], defaults = []) {
      const target = unwrapOutputExpression(node);
      if (ts.isIdentifier(target)) {
        return outputBindingAt(target) === binding
          ? { found: true, unsupported: false, values: [{ properties, defaults }] }
          : { found: false, unsupported: false, values: [] };
      }
      if (
        ts.isBinaryExpression(target) &&
        target.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        return assignmentSelections(target.left, properties, [...defaults, target.right]);
      }
      if (ts.isObjectLiteralExpression(target)) {
        let found = false;
        let unsupported = false;
        const values = [];
        for (const property of target.properties) {
          if (ts.isSpreadAssignment(property)) {
            const result = assignmentSelections(property.expression, properties, defaults);
            found ||= result.found;
            unsupported ||= result.found || result.unsupported;
            values.push(...result.values);
            continue;
          }
          const name = staticPropertyName(property.name);
          if (name === undefined) {
            unsupported = true;
            continue;
          }
          if (ts.isPropertyAssignment(property)) {
            const result = assignmentSelections(
              property.initializer,
              [...properties, name],
              defaults,
            );
            found ||= result.found;
            unsupported ||= result.unsupported;
            values.push(...result.values);
          } else if (ts.isShorthandPropertyAssignment(property)) {
            const propertyDefaults =
              property.objectAssignmentInitializer === undefined
                ? defaults
                : [...defaults, property.objectAssignmentInitializer];
            const result = assignmentSelections(
              property.name,
              [...properties, name],
              propertyDefaults,
            );
            found ||= result.found;
            unsupported ||= result.unsupported;
            values.push(...result.values);
          }
        }
        return { found, unsupported, values };
      }
      if (ts.isArrayLiteralExpression(target)) {
        let found = false;
        let unsupported = false;
        const values = [];
        for (const [index, element] of target.elements.entries()) {
          if (ts.isOmittedExpression(element)) continue;
          if (ts.isSpreadElement(element)) {
            const result = assignmentSelections(element.expression, properties, defaults);
            found ||= result.found;
            unsupported ||= result.found || result.unsupported;
            values.push(...result.values);
            continue;
          }
          const result = assignmentSelections(element, [...properties, String(index)], defaults);
          found ||= result.found;
          unsupported ||= result.unsupported;
          values.push(...result.values);
        }
        return { found, unsupported, values };
      }
      return { found: false, unsupported: false, values: [] };
    }

    function inspect(node) {
      if (
        node !== binding &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        outputBindingAt(node.name) === binding
      ) {
        values.push(node.initializer);
      }
      if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind) &&
        ts.isIdentifier(unwrapOutputExpression(node.left)) &&
        outputBindingAt(unwrapOutputExpression(node.left)) === binding
      ) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) values.push(node.right);
        else unsupportedWrite = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(unwrapOutputExpression(node.left)) ||
          ts.isArrayLiteralExpression(unwrapOutputExpression(node.left)))
      ) {
        const result = assignmentSelections(node.left);
        unsupportedWrite ||= result.unsupported;
        selections.push(
          ...result.values.map(({ properties, defaults }) => ({
            root: node.right,
            properties,
            defaults,
          })),
        );
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        ts.isIdentifier(unwrapOutputExpression(node.operand)) &&
        outputBindingAt(unwrapOutputExpression(node.operand)) === binding
      ) {
        unsupportedWrite = true;
      }
    }
    visitBeforeOutputUse(use, inspect);
    return { values, selections, unsupportedWrite };
  }

  function objectPropertyInitializers(object, name) {
    const values = [];
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) return undefined;
      if (staticPropertyName(property.name) !== name) continue;
      if (ts.isPropertyAssignment(property)) values.push(property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) values.push(property.name);
      else return undefined;
    }
    return values.length === 0 ? undefined : values;
  }

  function bindingElementPath(binding) {
    const properties = [];
    const defaults = [];
    let element = binding;
    while (ts.isBindingElement(element)) {
      if (!ts.isObjectBindingPattern(element.parent) || element.dotDotDotToken !== undefined) {
        return undefined;
      }
      const name = staticPropertyName(element.propertyName ?? element.name);
      if (name === undefined) return undefined;
      properties.unshift(name);
      if (element.initializer !== undefined) defaults.push(element.initializer);
      element = element.parent.parent;
    }
    if (!ts.isVariableDeclaration(element) && !ts.isParameter(element)) return undefined;
    return { root: element.initializer, properties, defaults };
  }

  function objectLocations(binding, properties, use, seenBindings = new Set()) {
    if (seenBindings.has(binding.pos)) return [];
    const nextSeen = new Set(seenBindings);
    nextSeen.add(binding.pos);
    const locations = [{ binding, properties }];

    function resolveValue(value, pendingProperties) {
      const expression = unwrapOutputExpression(value);
      const [name, ...remaining] = pendingProperties;
      if (name !== undefined && ts.isObjectLiteralExpression(expression)) {
        const initializers = objectPropertyInitializers(expression, name);
        if (initializers !== undefined) {
          for (const initializer of initializers) resolveValue(initializer, remaining);
        }
        return;
      }
      if (name !== undefined && ts.isArrayLiteralExpression(expression)) {
        const index = Number(name);
        const element =
          Number.isSafeInteger(index) && index >= 0 ? expression.elements[index] : undefined;
        if (element !== undefined && !ts.isOmittedExpression(element)) {
          resolveValue(ts.isSpreadElement(element) ? element.expression : element, remaining);
        }
        return;
      }
      const access = memberAccessPath(expression);
      if (access === undefined) return;
      const rootBinding = outputBindingAt(access.root);
      if (rootBinding === undefined) return;
      locations.push(
        ...objectLocations(
          rootBinding,
          [...access.properties, ...pendingProperties],
          use,
          nextSeen,
        ),
      );
    }

    function addValue(value, selectedProperties = []) {
      resolveValue(value, [...selectedProperties, ...properties]);
    }

    if (ts.isBindingElement(binding)) {
      const path = bindingElementPath(binding);
      if (path?.root !== undefined) addValue(path.root, path.properties);
      return locations;
    }

    const { values, selections } = outputBindingValues(binding, use);
    for (const value of values) addValue(value);
    for (const selection of selections) addValue(selection.root, selection.properties);
    return locations;
  }

  function propertyWritesAreAllowed(binding, properties, use, seenAliases) {
    let allowed = true;
    function inspect(node) {
      if (!allowed) return;
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        const access = memberAccessPath(node.left);
        const rootBinding = access === undefined ? undefined : outputBindingAt(access.root);
        if (access !== undefined && rootBinding !== undefined) {
          for (const location of objectLocations(rootBinding, access.properties, use)) {
            if (location.binding !== binding) continue;
            const writeIsPrefix = location.properties.every(
              (property, index) => property === properties[index],
            );
            const outputIsPrefix = properties.every(
              (property, index) => property === location.properties[index],
            );
            if (writeIsPrefix) {
              allowed =
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                isAllowedPropertyFromValue(
                  node.right,
                  properties.slice(location.properties.length),
                  use,
                  seenAliases,
                );
            } else if (outputIsPrefix) {
              allowed = false;
            }
            if (!allowed) return;
          }
        }
      }
    }
    visitBeforeOutputUse(use, inspect);
    return allowed;
  }

  function isAllowedPropertyFromValue(node, properties, use, seenAliases) {
    if (properties.length === 0) return isAllowedOutputValue(node, seenAliases);
    const [name, ...remaining] = properties;
    if (name === undefined || !isAllowedOutputName(properties.at(-1))) return false;
    const expression = unwrapOutputExpression(node);
    if (ts.isObjectLiteralExpression(expression)) {
      const initializers = objectPropertyInitializers(expression, name);
      return (
        initializers !== undefined &&
        initializers.every((initializer) =>
          isAllowedPropertyFromValue(initializer, remaining, use, seenAliases),
        )
      );
    }
    if (ts.isIdentifier(expression)) {
      const binding = outputBindingAt(expression);
      if (binding !== undefined) {
        return isAllowedBindingProperties(binding, properties, use, seenAliases);
      }
    }
    return true;
  }

  function isAllowedBindingProperties(binding, properties, use, seenAliases) {
    const key = `${binding.pos}:${properties.join(".")}`;
    if (seenAliases.has(key)) return false;
    const nextSeen = new Set(seenAliases);
    nextSeen.add(key);

    if (ts.isBindingElement(binding)) {
      const path = bindingElementPath(binding);
      const writes = outputBindingValues(binding, use);
      return (
        path !== undefined &&
        !writes.unsupportedWrite &&
        isAllowedOutputName(path.properties.at(-1) ?? "") &&
        path.defaults.every((value) => isAllowedOutputValue(value, nextSeen)) &&
        writes.values.every((value) => isAllowedOutputValue(value, nextSeen)) &&
        writes.selections.every(
          (selection) =>
            selection.defaults.every((value) => isAllowedOutputValue(value, nextSeen)) &&
            isAllowedPropertyFromValue(
              selection.root,
              [...selection.properties, ...properties],
              use,
              nextSeen,
            ),
        ) &&
        (path.root === undefined ||
          isAllowedPropertyFromValue(path.root, [...path.properties, ...properties], use, nextSeen))
      );
    }

    const { values, selections, unsupportedWrite } = outputBindingValues(binding, use);
    const externalValueIsAllowed =
      isExternalOutputBinding(binding) &&
      ((properties.length > 0 && isAllowedOutputName(properties.at(-1) ?? "")) ||
        (ts.isParameter(binding) &&
          ts.isIdentifier(binding.name) &&
          isAllowedOutputName(binding.name.text)));
    return (
      !unsupportedWrite &&
      (values.length > 0 || selections.length > 0 || externalValueIsAllowed) &&
      values.every((value) => isAllowedPropertyFromValue(value, properties, use, nextSeen)) &&
      selections.every(
        (selection) =>
          selection.defaults.every((value) => isAllowedOutputValue(value, nextSeen)) &&
          isAllowedPropertyFromValue(
            selection.root,
            [...selection.properties, ...properties],
            use,
            nextSeen,
          ),
      ) &&
      propertyWritesAreAllowed(binding, properties, use, nextSeen)
    );
  }

  function isAllowedOutputValue(node, seenAliases = new Set()) {
    const expression = unwrapOutputExpression(node);
    if (isStaticOutputValue(expression)) return true;
    if (ts.isIdentifier(expression)) {
      const binding = outputBindingAt(expression);
      if (binding !== undefined)
        return isAllowedBindingProperties(binding, [], expression, seenAliases);
      return isAllowedOutputName(expression.text);
    }
    if (ts.isTemplateExpression(expression)) {
      return expression.templateSpans.every((span) => isAllowedOutputValue(span.expression));
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        isAllowedOutputValue(expression.whenTrue) && isAllowedOutputValue(expression.whenFalse)
      );
    }
    if (ts.isBinaryExpression(expression)) {
      return (
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(expression.operatorToken.kind) &&
        isAllowedOutputValue(expression.left) &&
        isAllowedOutputValue(expression.right)
      );
    }
    const access = memberAccessPath(expression);
    if (access === undefined || access.properties.length === 0) return false;
    const binding = outputBindingAt(access.root);
    return binding === undefined
      ? isAllowedOutputName(access.properties.at(-1) ?? "")
      : isAllowedBindingProperties(binding, access.properties, expression, seenAliases);
  }

  function isAllowedOutputArgument(node) {
    const expression = unwrapOutputExpression(node);
    if (!ts.isObjectLiteralExpression(expression)) return isAllowedOutputValue(expression);
    return expression.properties.every((property) => {
      if (ts.isPropertyAssignment(property)) {
        return (
          (!ts.isComputedPropertyName(property.name) ||
            isAllowedOutputValue(property.name.expression)) &&
          !ts.isObjectLiteralExpression(unwrapOutputExpression(property.initializer)) &&
          !ts.isArrayLiteralExpression(unwrapOutputExpression(property.initializer)) &&
          isAllowedOutputValue(property.initializer)
        );
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return isAllowedOutputValue(property.name);
      }
      return false;
    });
  }

  let unsafe = false;
  function visit(node) {
    if (unsafe) return;
    if (
      ts.isCallExpression(node) &&
      /^(?:console|log|logger)\.(?:log|debug|info|warn|error)$/u.test(
        propertyPath(node.expression) ?? "",
      )
    ) {
      unsafe = enforceAllowlist
        ? node.arguments.some((argument) => !isAllowedOutputArgument(argument))
        : node.arguments.some(containsSensitiveValue);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return unsafe;
}

/** Verify one focused source fixture against the documented output allowlist. */
export function verifySafeOutput(label, source) {
  verifyJavaScriptSyntax(label, source);
  if (hasUnsafeConsoleOutput(sourceFileFor(label, source), true)) {
    throw new TypeError(`${label} contains unsafe secret or payload output.`);
  }
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
    ...index.supportingExamples.map((example) => ({ ...example, language: "mjs" })),
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

function advertisedExamplePaths(source) {
  const paths = [];
  for (const pattern of [
    /^###\s+\d+\.\s+`([A-Za-z0-9_-]+\.mjs)`/gmu,
    /^\|\s*`([A-Za-z0-9_-]+\.mjs)`\s*\|/gmu,
  ]) {
    for (const match of source.matchAll(pattern)) paths.push(`examples/${match[1]}`);
  }
  return paths;
}

function verifyExampleInventory(index) {
  const advertised = advertisedExamplePaths(index.documents["examples/README.md"] ?? "");
  const examples = index.examples.map(({ path }) => path);
  const duplicate = advertised.find((path, position) => advertised.indexOf(path) !== position);
  if (duplicate !== undefined) {
    throw new TypeError(
      `The advertised example inventory contains a duplicate entry: ${duplicate}`,
    );
  }
  const orphan = advertised.find((path) => !examples.includes(path));
  if (orphan !== undefined) {
    throw new TypeError(`The advertised example inventory contains an orphan entry: ${orphan}`);
  }
  const missing = examples.find((path) => !advertised.includes(path));
  if (missing !== undefined) {
    throw new TypeError(`The advertised example inventory is missing: ${missing}`);
  }
}

function verifyExamples(index) {
  verifyExampleInventory(index);
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
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(sample.source)) {
        throw new TypeError(`Node sample ${operationId} contains unsafe secret output.`);
      }
    }
    if (hasUnsafeConsoleOutput(sourceFile)) {
      throw new TypeError(`Node sample ${operationId} contains unsafe secret output.`);
    }
  }
  for (const snippet of index.snippets.filter(({ path }) => path === "README.md")) {
    const label = `${snippet.path}:${snippet.line}`;
    if (hasUnsafeConsoleOutput(sourceFileFor(label, snippet.source), true)) {
      throw new TypeError(`${label} contains unsafe secret or payload output.`);
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
    if (hasUnsafeConsoleOutput(sourceFile, true)) {
      throw new TypeError(`${example.path} contains unsafe secret or payload output.`);
    }
  }
  for (const example of index.supportingExamples) {
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

  for (const path of [
    "examples/webhook-express.mjs",
    "examples/next-webhook-route/create-webhook-route.mjs",
  ]) {
    const example = [...index.examples, ...index.supportingExamples].find(
      (candidate) => candidate.path === path,
    );
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
  const nextSourceFile = sourceFileFor("examples/next-webhook-route.mjs", next.source);
  const nextExports = nextSourceFile.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement)) {
      return statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : ["unsupported export"];
    }
    if (ts.isExportAssignment(statement)) return ["unsupported export"];
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) return [];
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
      );
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      return [statement.name.text];
    }
    return ["unsupported export"];
  });
  if (nextExports.sort().join(",") !== "POST,runtime") {
    throw new TypeError("The Next.js route module may export only POST and runtime.");
  }
}

async function verifyFormatting(index, root) {
  const config = (await resolveConfig(resolve(root, "README.md"))) ?? {};
  for (const [path, source] of [
    ...Object.entries(index.documents),
    ...index.examples.map((example) => [example.path, example.source]),
    ...index.supportingExamples.map((example) => [example.path, example.source]),
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

function archiveCommand(args, label) {
  const result = spawnSync("tar", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new TypeError(`${label} failed: ${result.stderr || result.stdout}`.trimEnd());
  }
  return result.stdout;
}

function installedArchivePaths(tarballPath) {
  const paths = archiveCommand(["-tzf", tarballPath], "SDK tarball inventory").split("\n");
  const installed = new Set();
  for (const archivePath of paths) {
    if (archivePath === "") continue;
    if (!archivePath.startsWith("package/")) {
      throw new TypeError(`SDK tarball contains a path outside package/: ${archivePath}`);
    }
    const packagePath = archivePath.slice("package/".length).replace(/\/$/u, "");
    if (
      packagePath !== "" &&
      (posix.isAbsolute(packagePath) || packagePath.split("/").includes(".."))
    ) {
      throw new TypeError(`SDK tarball contains an unsafe package path: ${archivePath}`);
    }
    installed.add(packagePath);
  }
  return installed;
}

function installedArchiveFile(tarballPath, path) {
  return archiveCommand(
    ["-xOzf", tarballPath, `package/${path}`],
    `Unable to read installed ${path}`,
  );
}

function validateExternalInventory(inventory) {
  const canonicalTargets = new Set();
  for (const target of inventory) {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`Installed external URL inventory has an unsupported target: ${target}`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new TypeError(`Installed external URL contains credentials: ${target}`);
    }
    if (url.hash !== "") {
      throw new TypeError(`Installed external URL contains an unverifiable fragment: ${target}`);
    }
    if (canonicalTargets.has(url.href)) {
      throw new TypeError(`Installed external URL inventory contains a duplicate entry: ${target}`);
    }
    canonicalTargets.add(url.href);
  }
  return canonicalTargets;
}

function installedLocalTarget(link, installedPaths) {
  if (link.target.includes("#")) {
    throw new TypeError(
      `${link.path}:${link.line} has an installed link with an unverifiable fragment: ${link.target}`,
    );
  }
  const targetPath = link.target.split("?", 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(targetPath);
  } catch (error) {
    throw new TypeError(`${link.path}:${link.line} has an invalid installed link: ${link.target}`, {
      cause: error,
    });
  }
  if (decoded.includes("\\") || posix.isAbsolute(decoded)) {
    throw new TypeError(`${link.path}:${link.line} has an unsafe installed link: ${link.target}`);
  }
  const packagePath = posix
    .normalize(posix.join(posix.dirname(link.path), decoded))
    .replace(/\/$/u, "");
  if (packagePath === ".." || packagePath.startsWith("../")) {
    throw new TypeError(`${link.path}:${link.line} has an unsafe installed link: ${link.target}`);
  }
  const exists =
    installedPaths.has(packagePath) ||
    [...installedPaths].some((path) => path.startsWith(`${packagePath}/`));
  if (!exists) {
    throw new TypeError(
      `${link.path}:${link.line} has an unresolved installed link: ${link.target}`,
    );
  }
}

async function defaultExternalRequest(url, { signal }) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": "@ahasend/sdk documentation verifier" },
    signal,
  });
  const result = { status: response.status, location: response.headers.get("location") };
  await response.body?.cancel();
  return result;
}

async function verifyExternalTarget(target, state) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), state.timeoutMs);
  let current = new URL(target);
  let redirects = 0;
  try {
    while (true) {
      if (!state.allowedHosts.has(current.hostname)) {
        throw new TypeError(
          `Installed external URL left the authoritative host allowlist: ${current.href}`,
        );
      }
      state.requests += 1;
      if (state.requests > state.requestCap) {
        throw new TypeError(
          `Installed external URL request cap exceeded while validating ${target}`,
        );
      }
      let response;
      try {
        response = await state.request(current, { signal: controller.signal });
      } catch (error) {
        const outcome = controller.signal.aborted ? "timed out" : "request failed";
        throw new TypeError(`Installed external URL ${outcome}: ${target}`, { cause: error });
      }
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        throw new TypeError(`Installed external URL returned an invalid status: ${target}`);
      }
      if (response.status >= 300 && response.status < 400) {
        if (response.location === null || response.location === undefined) {
          throw new TypeError(
            `Installed external URL returned a redirect without Location: ${target}`,
          );
        }
        if (redirects >= INSTALLED_LINK_REDIRECT_CAP) {
          throw new TypeError(`Installed external URL exceeded two redirects: ${target}`);
        }
        let redirected;
        try {
          redirected = new URL(response.location, current);
        } catch (error) {
          throw new TypeError(`Installed external URL redirected to an invalid target: ${target}`, {
            cause: error,
          });
        }
        if (
          (redirected.protocol !== "http:" && redirected.protocol !== "https:") ||
          redirected.username !== "" ||
          redirected.password !== "" ||
          redirected.hash !== "" ||
          redirected.port !== ""
        ) {
          throw new TypeError(`Installed external URL redirected to an unsafe target: ${target}`);
        }
        if (redirected.hostname !== current.hostname) {
          throw new TypeError(`Installed external URL crossed hosts: ${target}`);
        }
        current = redirected;
        redirects += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new TypeError(`Installed external URL returned HTTP ${response.status}: ${target}`);
      }
      return;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verify links indexed from the README and CHANGELOG present in installed package bytes.
 * Options support network-isolated tests and source preflight; retained release callers use defaults.
 */
export async function verifyInstalledLinks(documents, installedPaths, options = {}) {
  const inventory = options.externalUrls ?? INSTALLED_EXTERNAL_URLS;
  const expected = validateExternalInventory(inventory);
  const links = Object.entries(documents).flatMap(([path, source]) => markdownLinks(source, path));
  const externalTargets = [];
  for (const link of links) {
    if (link.target.startsWith("#")) {
      throw new TypeError(
        `${link.path}:${link.line} has an installed link with an unverifiable fragment: ${link.target}`,
      );
    }
    if (/^mailto:/iu.test(link.target)) continue;
    if (!/^https?:/iu.test(link.target)) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(link.target)) {
        throw new TypeError(
          `${link.path}:${link.line} has an unsupported installed link: ${link.target}`,
        );
      }
      installedLocalTarget(link, installedPaths);
      continue;
    }
    const url = new URL(link.target);
    if (url.username !== "" || url.password !== "") {
      throw new TypeError(
        `${link.path}:${link.line} has an external URL with credentials: ${link.target}`,
      );
    }
    if (url.hash !== "") {
      throw new TypeError(
        `${link.path}:${link.line} has an external URL with an unverifiable fragment: ${link.target}`,
      );
    }
    externalTargets.push(url.href);
  }

  const actual = new Set(externalTargets);
  const unregistered = [...actual].find((target) => !expected.has(target));
  if (unregistered !== undefined) {
    throw new TypeError(
      `Installed documentation contains an unregistered external URL: ${unregistered}`,
    );
  }
  const missing = [...expected].find((target) => !actual.has(target));
  if (missing !== undefined) {
    throw new TypeError(`Installed documentation is missing registered external URL: ${missing}`);
  }

  if (options.verifyExternalTargets === false) return;

  const state = {
    allowedHosts: new Set(AUTHORITATIVE_LINK_HOSTS),
    request: options.request ?? defaultExternalRequest,
    requestCap: options.requestCap ?? INSTALLED_LINK_REQUEST_CAP,
    requests: 0,
    timeoutMs: options.timeoutMs ?? INSTALLED_LINK_TIMEOUT_MS,
  };
  for (const target of expected) await verifyExternalTarget(target, state);
}

/** Verify installed documentation from checksum-bound candidate bytes. */
export async function verifyInstalledDocumentation(
  tarballPath,
  expectedChecksum,
  root = repositoryRoot,
  options = {},
) {
  const tarball = resolve(tarballPath);
  await assertTarball(tarball, expectedChecksum);
  const installedPaths = installedArchivePaths(tarball);
  const documents = Object.fromEntries(
    INSTALLED_DOCUMENT_PATHS.map((path) => [path, installedArchiveFile(tarball, path)]),
  );
  for (const path of INSTALLED_DOCUMENT_PATHS) {
    const checkoutSource = await readFile(resolve(root, path), "utf8");
    if (documents[path] !== checkoutSource) {
      throw new TypeError(`Installed ${path} differs from checkout documentation.`);
    }
  }
  await verifyInstalledLinks(documents, installedPaths, options);
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
    throw new TypeError("Usage: node scripts/verify-docs.mjs <tarball> <sha256>");
  }
  const tarball = process.argv[2] ?? process.env.SDK_TARBALL;
  const checksum = process.argv[3] ?? process.env.SDK_TARBALL_SHA256;
  if (tarball === undefined || checksum === undefined) {
    throw new TypeError("Provide both SDK_TARBALL and SDK_TARBALL_SHA256.");
  }
  const index = await buildDocumentationIndex();
  await verifyDocumentationIndex(index);
  const retainedArtifactInvocation = process.argv[2] !== undefined && process.argv[3] !== undefined;
  await verifyInstalledDocumentation(tarball, checksum, repositoryRoot, {
    verifyExternalTargets: retainedArtifactInvocation,
  });
  await verifyPackagedJavaScript(tarball, checksum);
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
