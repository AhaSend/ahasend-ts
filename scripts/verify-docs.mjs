#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import ts from "typescript";
import { NODE_CODE_SAMPLES, NODE_OPERATION_KEYS } from "./node-code-samples.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const EXPECTED_NODE_SAMPLE_COUNT = 56;
const EXPECTED_ITERATOR_COUNT = 9;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:^|[\s:])_authToken\s*=/u,
  /(?<![A-Za-z0-9_-])aha-sk-[A-Za-z0-9_-]{64}(?![A-Za-z0-9_-])/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{20,}\b/u,
]);
const UNSAFE_OUTPUT_PATTERNS = Object.freeze([
  /console\.(?:log|error|warn|info)\s*\([^;\n]*(?:secret_key|idempotencyKey)/u,
  /console\.(?:log|error|warn|info)\s*\([^;\n]*\berr(?:or)?\.body\b/u,
  /console\.(?:log|error|warn|info)\s*\([^;\n]*event\.data\.(?:recipient|subject)\b/u,
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
    text: "## [0.1.0] — Unreleased",
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
    verifyJavaScriptSyntax(`Node sample ${operationId}`, sample.source);
    const operationKey = NODE_OPERATION_KEYS[operationId];
    if (
      operationKey !== undefined &&
      !operationKey.startsWith("GET ") &&
      !sample.source.includes('"sandbox": true') &&
      !sample.source.includes('process.env.AHASEND_ALLOW_MUTATIONS !== "1"')
    ) {
      throw new TypeError(`Node sample ${operationId} performs an unguarded mutation.`);
    }
    for (const pattern of [...SECRET_PATTERNS, ...UNSAFE_OUTPUT_PATTERNS]) {
      if (pattern.test(sample.source)) {
        throw new TypeError(`Node sample ${operationId} contains unsafe secret output.`);
      }
    }
  }
  for (const example of index.examples) {
    verifyJavaScriptSyntax(example.path, example.source);
    for (const pattern of [...SECRET_PATTERNS, ...UNSAFE_OUTPUT_PATTERNS]) {
      if (pattern.test(example.source)) {
        throw new TypeError(`${example.path} contains unsafe secret or payload output.`);
      }
    }
  }
  for (const [path, source] of Object.entries(index.documents)) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(source)) {
        throw new TypeError(`${path} contains an unclassified secret signature.`);
      }
    }
  }

  const mutationPattern =
    /\bclient\.[A-Za-z.]+\.(?:create|update|delete|wipe|suspend|unsuspend|send)\s*\(/u;
  for (const example of index.examples) {
    if (
      mutationPattern.test(example.source) &&
      !example.source.includes("sandbox: true") &&
      !example.source.includes('process.env.AHASEND_ALLOW_MUTATIONS !== "1"')
    ) {
      throw new TypeError(`${example.path} performs an unguarded mutation.`);
    }
  }

  for (const path of ["examples/webhook-express.mjs", "examples/next-webhook-route.mjs"]) {
    const example = index.examples.find((candidate) => candidate.path === path);
    if (
      example === undefined ||
      !example.source.includes("enqueueOnce(webhookId, event)") ||
      !example.source.includes("if (!accepted)")
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
  await verifyLinks(index, root);
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await verifyCommands(index, manifest, root);
  await verifyFormatting(index, root);

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
) {
  const tarball = resolve(tarballPath);
  await assertTarball(tarball, expectedChecksum);
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
    for (const [operationId, sample] of Object.entries(NODE_CODE_SAMPLES)) {
      const path = resolve(samplesDirectory, `${operationId}.mjs`);
      await writeFile(path, sample.source);
      run(process.execPath, ["--check", path], temporaryRoot);
    }
    const javaScriptSnippets = index.snippets.filter(({ language }) =>
      ["js", "javascript", "mjs"].includes(language),
    );
    for (const [snippetIndex, snippet] of javaScriptSnippets.entries()) {
      const path = resolve(snippetsDirectory, `snippet-${snippetIndex}.mjs`);
      await writeFile(path, snippet.source);
      run(process.execPath, ["--check", path], temporaryRoot);
    }

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
          include: ["examples/**/*.mjs", "node-samples/**/*.mjs", "snippets/**/*.mjs"],
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
