#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalizeJson } from "./digest-artifact.mjs";
import {
  parseCanonicalJson,
  parseSha256Sidecar,
  requireExactKeys,
  requireHash,
  requireObject,
  sourceBytes,
} from "./report-validation.mjs";
import { buildDocumentationIndex } from "./verify-docs.mjs";
import { readRepositorySourceBindings, validateSourceGateReport } from "./run-source-gates.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCUMENT_PATHS = new Set(["README.md", "examples/README.md"]);
const SOURCE_WORKFLOW_OWNERS = Object.freeze([
  "source:build",
  "source:typecheck",
  "source:lint",
  "source:test",
  "source:coverage",
  "source:format",
]);
const INTERACTIVE_TIMEOUT_MS = 60_000;
const DOCUMENTATION_WORKFLOW_RESULT = "documentation-workflows";
export const TSUP_INITIAL_BUILD_MARKERS = Object.freeze([
  /^CJS .*Build success(?: in \d+ms)?\s*$/mu,
  /^ESM .*Build success(?: in \d+ms)?\s*$/mu,
  /^DTS .*Build success(?: in \d+ms)?\s*$/mu,
]);

export const DOCUMENTED_WORKFLOW_REGISTRY = Object.freeze([
  { path: "README.md", line: 26, command: "npm install @ahasend/sdk", owner: "installed-package" },
  {
    path: "README.md",
    line: 452,
    command: "git clone https://github.com/AhaSend/ahasend-ts.git",
    owner: "source-setup",
  },
  { path: "README.md", line: 453, command: "cd ahasend-ts", owner: "source-setup" },
  { path: "README.md", line: 454, command: "npm ci", owner: "source-setup" },
  {
    path: "README.md",
    line: 456,
    command: "npm run typecheck         # strict TS over src + tests",
    owner: "source:typecheck",
  },
  {
    path: "README.md",
    line: 457,
    command: "npm test                  # unit tests, fully offline",
    owner: "source:test",
  },
  {
    path: "README.md",
    line: 458,
    command: "npm run test:coverage     # coverage with enforced thresholds",
    owner: "source:coverage",
  },
  {
    path: "README.md",
    line: 459,
    command:
      "npm run test:integration:preflight  # builds, packs, and tests a disposable tarball with Prism",
    owner: "packed-example-matrix",
  },
  {
    path: "README.md",
    line: 460,
    command: "npm run build             # ESM + CJS + .d.ts/.d.cts",
    owner: "source:build",
  },
  {
    path: "README.md",
    line: 477,
    command: "./node_modules/.bin/prism mock openapi.yaml -p 4010 --errors",
    owner: "interactive:prism",
  },
  {
    path: "README.md",
    line: 479,
    command: 'export AHASEND_API_KEY="anything"',
    owner: "packed-example-matrix",
  },
  {
    path: "README.md",
    line: 480,
    command: 'export AHASEND_ACCOUNT_ID="00000000-0000-0000-0000-000000000000"',
    owner: "packed-example-matrix",
  },
  {
    path: "README.md",
    line: 481,
    command: 'export AHASEND_BASE_URL="http://127.0.0.1:4010"',
    owner: "packed-example-matrix",
  },
  {
    path: "README.md",
    line: 482,
    command: 'export AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL="true"',
    owner: "packed-example-matrix",
  },
  {
    path: "README.md",
    line: 483,
    command: "node examples/ping.mjs",
    owner: "packed-example-matrix",
  },
  {
    path: "README.md",
    line: 489,
    command: "npm run dev               # tsup in watch mode",
    owner: "interactive:dev",
  },
  {
    path: "README.md",
    line: 490,
    command: "npm run test:watch        # vitest watch",
    owner: "interactive:test-watch",
  },
  {
    path: "README.md",
    line: 491,
    command: "npm run lint              # eslint over src",
    owner: "source:lint",
  },
  {
    path: "README.md",
    line: 492,
    command: "npm run format            # prettier",
    owner: "source:format",
  },
  {
    path: "examples/README.md",
    line: 7,
    command: "npm run build",
    owner: "source:build",
  },
  {
    path: "examples/README.md",
    line: 13,
    command: '$env:AHASEND_API_KEY="aha-sk-your-64-char-key"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 14,
    command: '$env:AHASEND_ACCOUNT_ID="your-account-uuid"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 18,
    command: 'export AHASEND_API_KEY="aha-sk-your-64-char-key"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 19,
    command: 'export AHASEND_ACCOUNT_ID="your-account-uuid"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 37,
    command: "node examples/ping.mjs",
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 45,
    command: "node examples/list-domains.mjs",
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 53,
    command: "node examples/list-api-keys.mjs",
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 63,
    command: 'export AHASEND_ALLOW_MUTATIONS="1"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 64,
    command: 'export AHASEND_FROM_EMAIL="sender@your-verified-domain.com"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 65,
    command: "node examples/send-sandbox.mjs",
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 98,
    command: 'export AHASEND_ALLOW_MUTATIONS="1"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 99,
    command: 'export AHASEND_API_KEY_ID="key-uuid"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 100,
    command: 'export AHASEND_IP_ALLOW_LIST="203.0.113.0/24,198.51.100.7"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 101,
    command: "node examples/update-api-key-ip-list.mjs",
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 109,
    command: 'export AHASEND_ALLOW_MUTATIONS="1"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 110,
    command: 'export AHASEND_SUBACCOUNT_NAME="Example subsidiary"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 111,
    command: 'export AHASEND_SUBACCOUNT_WEBSITE="subsidiary.example.com"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 112,
    command: 'export AHASEND_CHILD_SECRET_FILE="./child-api-key.secret"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 113,
    command: "node examples/bootstrap-subaccount.mjs",
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 129,
    command: "./node_modules/.bin/prism mock openapi.yaml -p 4010 --errors",
    owner: "interactive:prism",
  },
  {
    path: "examples/README.md",
    line: 135,
    command: 'export AHASEND_API_KEY="aha-sk-mock-key-any-value"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 136,
    command: 'export AHASEND_ACCOUNT_ID="00000000-0000-0000-0000-000000000000"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 137,
    command: 'export AHASEND_BASE_URL="http://127.0.0.1:4010"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 138,
    command: 'export AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL="true"',
    owner: "packed-example-matrix",
  },
  {
    path: "examples/README.md",
    line: 139,
    command: "node examples/ping.mjs",
    owner: "packed-example-matrix",
  },
]);

function locator({ path, line, command, source }) {
  return `${path}:${line}:${command ?? source}`;
}

function parseDocumentedInvocation(entry) {
  const command = entry.command.replace(/\s+#.*$/u, "").trim();
  if (command.length === 0 || /["'`\\;&|<>()$]/u.test(command)) {
    throw new TypeError(
      `Documentation workflow registry entry ${entry.path}:${entry.line} is not a supported direct command.`,
    );
  }
  const [executable, ...args] = command.split(/\s+/u);
  if (executable === undefined) {
    throw new TypeError(
      `Documentation workflow registry entry ${entry.path}:${entry.line} has no executable.`,
    );
  }
  return Object.freeze({ executable, args: Object.freeze(args) });
}

function uniqueOwnerInvocation(registry, owner) {
  const invocations = registry
    .filter((entry) => entry.owner === owner)
    .map(parseDocumentedInvocation);
  const unique = new Map(
    invocations.map((invocation) => [
      JSON.stringify([invocation.executable, ...invocation.args]),
      invocation,
    ]),
  );
  if (unique.size !== 1) {
    throw new TypeError(`Documentation workflow owner ${owner} must map to one exact command.`);
  }
  return unique.values().next().value;
}

function requireNpmInvocation(invocation, owner) {
  if (invocation?.executable !== "npm") {
    throw new TypeError(`Documentation workflow owner ${owner} must execute npm directly.`);
  }
  return invocation;
}

/**
 * Resolve the exact source and interactive argv from the documentation registry.
 * The runner consumes this plan directly so command classification and execution
 * cannot drift into separate maps.
 */
export function createDocumentedWorkflowExecutionPlan(registry = DOCUMENTED_WORKFLOW_REGISTRY) {
  const setupInvocations = registry
    .filter((entry) => entry.owner === "source-setup")
    .map(parseDocumentedInvocation);
  if (setupInvocations.length !== 3) {
    throw new TypeError("Documentation source setup must contain clone, cd, and install commands.");
  }
  const cloneMatches = setupInvocations.filter(
    ({ executable, args }) =>
      executable === "git" &&
      args.length === 2 &&
      args[0] === "clone" &&
      args[1] === "https://github.com/AhaSend/ahasend-ts.git",
  );
  if (cloneMatches.length !== 1) {
    throw new TypeError(
      "Documentation source setup must clone https://github.com/AhaSend/ahasend-ts.git exactly once.",
    );
  }
  const clone = cloneMatches[0];
  const repositoryDirectory = basename(new URL(clone.args[1]).pathname, ".git");
  const directoryMatches = setupInvocations.filter(
    ({ executable, args }) =>
      executable === "cd" && args.length === 1 && args[0] === repositoryDirectory,
  );
  if (directoryMatches.length !== 1) {
    throw new TypeError(
      `Documentation source setup must enter the cloned ${repositoryDirectory} directory exactly once.`,
    );
  }
  const installMatches = setupInvocations.filter(
    ({ executable, args }) => executable === "npm" && args.length === 1 && args[0] === "ci",
  );
  if (installMatches.length !== 1) {
    throw new TypeError("Documentation source setup must map exactly once to npm ci.");
  }

  const source = SOURCE_WORKFLOW_OWNERS.map((owner) => ({
    owner,
    invocation: requireNpmInvocation(uniqueOwnerInvocation(registry, owner), owner),
  }));
  const prism = uniqueOwnerInvocation(registry, "interactive:prism");
  if (
    prism?.executable !== "./node_modules/.bin/prism" ||
    prism.args.join("\0") !== ["mock", "openapi.yaml", "-p", "4010", "--errors"].join("\0")
  ) {
    throw new TypeError(
      "Documentation Prism workflow must mock committed openapi.yaml on port 4010 with --errors.",
    );
  }
  const dev = requireNpmInvocation(
    uniqueOwnerInvocation(registry, "interactive:dev"),
    "interactive:dev",
  );
  const watch = requireNpmInvocation(
    uniqueOwnerInvocation(registry, "interactive:test-watch"),
    "interactive:test-watch",
  );

  return Object.freeze({
    clone,
    sourceDirectory: repositoryDirectory,
    install: installMatches[0],
    source: Object.freeze(source),
    prism,
    dev,
    watch,
  });
}

export function validateDocumentedWorkflowRegistry(index, registry = DOCUMENTED_WORKFLOW_REGISTRY) {
  const commands = index.commands.filter(({ path }) => DOCUMENT_PATHS.has(path));
  const expected = new Set(commands.map(locator));
  const seen = new Set();
  const owners = new Set();

  for (const [position, entry] of registry.entries()) {
    const label = `Documentation workflow registry entry ${position}`;
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !Number.isInteger(entry.line) ||
      typeof entry.command !== "string" ||
      typeof entry.owner !== "string"
    ) {
      throw new TypeError(`${label} is invalid.`);
    }
    const key = locator(entry);
    if (seen.has(key)) throw new TypeError(`${label} duplicates ${entry.path}:${entry.line}.`);
    seen.add(key);
    if (!expected.has(key)) throw new TypeError(`${label} is orphaned or altered: ${key}.`);
    owners.add(entry.owner);
  }

  const missing = commands.find((command) => !seen.has(locator(command)));
  if (missing !== undefined) {
    throw new TypeError(
      `Documentation command has no workflow owner: ${missing.path}:${missing.line}:${missing.source}.`,
    );
  }
  if (registry.length !== commands.length) {
    throw new TypeError(
      `Documentation workflow registry must contain exactly ${commands.length} entries.`,
    );
  }

  for (const owner of SOURCE_WORKFLOW_OWNERS) {
    if (!owners.has(owner)) {
      throw new TypeError(`Documentation workflow registry does not exercise ${owner}.`);
    }
  }
  for (const owner of [
    "source-setup",
    "installed-package",
    "interactive:prism",
    "interactive:dev",
    "interactive:test-watch",
    "packed-example-matrix",
  ]) {
    if (!owners.has(owner)) {
      throw new TypeError(`Documentation workflow registry does not exercise ${owner}.`);
    }
  }
  createDocumentedWorkflowExecutionPlan(registry);
  return Object.freeze({ commands: commands.length, owners: owners.size });
}

function npmInvocation(args) {
  const npmExecutable = process.env.npm_execpath;
  return npmExecutable === undefined
    ? { command: "npm", args }
    : { command: process.execPath, args: [npmExecutable, ...args] };
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new TypeError(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

function runNpm(args, cwd, env) {
  const invocation = npmInvocation(args);
  run(invocation.command, invocation.args, cwd, env);
}

function runnableInvocation(invocation, cwd) {
  if (invocation.executable === "npm") return npmInvocation(invocation.args);
  if (invocation.executable.startsWith("./")) {
    return { command: resolve(cwd, invocation.executable), args: invocation.args };
  }
  return { command: invocation.executable, args: invocation.args };
}

function terminateProcessTree(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function stopProcessTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  terminateProcessTree(child);
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_000)),
  ]);
  if (!exited && child.exitCode === null) {
    const forcedExit = new Promise((resolveExit) => child.once("exit", resolveExit));
    terminateProcessTree(child, "SIGKILL");
    await forcedExit;
  }
}

export async function runBoundedInteractive({
  label,
  command,
  args,
  cwd,
  marker,
  requiredMarkers,
  readiness,
  timeoutMs = INTERACTIVE_TIMEOUT_MS,
  environment = {},
}) {
  return await new Promise((resolveRun, rejectRun) => {
    let output = "";
    let settled = false;
    let readinessTimer;
    let timeout;
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (readinessTimer !== undefined) clearInterval(readinessTimer);
      stopProcessTree(child).then(() => {
        if (error === undefined) resolveRun(output);
        else rejectRun(error);
      }, rejectRun);
    };
    const matches = (candidate) => {
      candidate.lastIndex = 0;
      return candidate.test(output);
    };
    const inspect = () => {
      if (
        (marker !== undefined && matches(marker)) ||
        (requiredMarkers !== undefined &&
          requiredMarkers.length > 0 &&
          requiredMarkers.every(matches))
      ) {
        finish();
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk) => {
        output += chunk;
        inspect();
      });
    }
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(
          new TypeError(
            `${label} exited before readiness (${code ?? signal ?? "unknown"}):\n${output}`,
          ),
        );
      }
    });
    if (readiness !== undefined) {
      readinessTimer = setInterval(() => {
        Promise.resolve(readiness()).then(
          (ready) => {
            if (ready) finish();
          },
          () => {},
        );
      }, 200);
    }
    timeout = setTimeout(
      () =>
        finish(new TypeError(`${label} did not become ready within ${timeoutMs}ms:\n${output}`)),
      timeoutMs,
    );
  });
}

async function temporarySourceTree(root, plan) {
  const parent = await mkdtemp(join(tmpdir(), "ahasend-sdk-doc-workflows-"));
  const localOrigin = resolve(parent, "documentation-source-origin");
  try {
    await cp(root, localOrigin, {
      recursive: true,
      filter(source) {
        const relative = source.slice(root.length).replace(/^[/\\]/u, "");
        const first = relative.split(/[/\\]/u, 1)[0];
        return ![
          ".git",
          ".betterborg-task",
          ".orchestry",
          ".betterborg-analysis",
          "node_modules",
          "dist",
          "coverage",
        ].includes(first);
      },
    });
    run("git", ["init", "--quiet"], localOrigin);
    run("git", ["add", "--all"], localOrigin);
    run(
      "git",
      [
        "-c",
        "user.name=AhaSend documentation workflow",
        "-c",
        "user.email=documentation-workflow@invalid.example",
        "commit",
        "--quiet",
        "-m",
        "documentation workflow source",
      ],
      localOrigin,
    );

    const clone = runnableInvocation(plan.clone, parent);
    run(clone.command, clone.args, parent, {
      ...process.env,
      GIT_ALLOW_PROTOCOL: "file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(localOrigin).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: plan.clone.args[1],
    });
    const target = resolve(parent, plan.sourceDirectory);
    if (dirname(target) !== parent || !(await stat(target)).isDirectory()) {
      throw new TypeError(
        `Documented source setup did not enter cloned directory ${plan.sourceDirectory}.`,
      );
    }
    return { parent, target };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

async function formattedSourceDigests(root) {
  const digests = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        digests.set(
          path.slice(root.length + 1),
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        );
      }
    }
  }
  await Promise.all([visit(resolve(root, "src")), visit(resolve(root, "tests"))]);
  return digests;
}

function requireUnchangedFormatting(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed = [...paths].filter((path) => before.get(path) !== after.get(path));
  if (changed.length > 0) {
    throw new TypeError(`Documented format workflow changed source files: ${changed.join(", ")}.`);
  }
}

async function prismReadiness() {
  try {
    const response = await fetch("http://127.0.0.1:4010/v2/ping", {
      headers: { authorization: "Bearer documentation-workflow" },
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function runSourceDocumentationWorkflows(root = repositoryRoot) {
  const index = await buildDocumentationIndex(root);
  const summary = validateDocumentedWorkflowRegistry(index);
  const plan = createDocumentedWorkflowExecutionPlan();
  const temporary = await temporarySourceTree(root, plan);
  try {
    const install = runnableInvocation(plan.install, temporary.target);
    run(install.command, install.args, temporary.target);
    for (const { owner, invocation } of plan.source) {
      const beforeFormatting =
        owner === "source:format" ? await formattedSourceDigests(temporary.target) : undefined;
      const source = runnableInvocation(invocation, temporary.target);
      run(source.command, source.args, temporary.target);
      if (beforeFormatting !== undefined) {
        requireUnchangedFormatting(
          beforeFormatting,
          await formattedSourceDigests(temporary.target),
        );
      }
    }

    const prism = runnableInvocation(plan.prism, temporary.target);
    await runBoundedInteractive({
      label: "Documented Prism workflow",
      ...prism,
      cwd: temporary.target,
      readiness: prismReadiness,
    });
    const dev = runnableInvocation(plan.dev, temporary.target);
    await runBoundedInteractive({
      label: "Documented development workflow",
      ...dev,
      cwd: temporary.target,
      requiredMarkers: TSUP_INITIAL_BUILD_MARKERS,
    });
    const watch = runnableInvocation(plan.watch, temporary.target);
    await runBoundedInteractive({
      label: "Documented test watch workflow",
      ...watch,
      cwd: temporary.target,
      marker: /Test Files|Watching for file changes/iu,
    });
    return Object.freeze({ ...summary, result: DOCUMENTATION_WORKFLOW_RESULT, passed: true });
  } finally {
    await rm(temporary.parent, { recursive: true, force: true });
  }
}

export function validateDocumentationWorkflowEvidence({
  evidenceSource,
  evidenceSidecar,
  sourceSummary,
}) {
  const evidenceBytes = sourceBytes(evidenceSource, "Documentation workflow evidence");
  const evidenceDigest = createHash("sha256").update(evidenceBytes).digest("hex");
  const detachedDigest = parseSha256Sidecar(
    evidenceSidecar,
    "Documentation workflow evidence sidecar",
  );
  if (detachedDigest !== evidenceDigest) {
    throw new TypeError(
      `Documentation workflow evidence sidecar mismatch: expected ${evidenceDigest}, received ${detachedDigest}.`,
    );
  }

  const evidence = parseCanonicalJson(evidenceBytes, "Documentation workflow evidence").value;
  requireExactKeys(
    evidence,
    ["commit", "result", "sourceReportSha256", "version"],
    "Documentation workflow evidence",
  );
  if (evidence.version !== 1) {
    throw new TypeError("Documentation workflow evidence version must be 1.");
  }
  if (evidence.commit !== sourceSummary.commit) {
    throw new TypeError("Documentation workflow evidence references a stale source commit.");
  }
  const sourceReportSha256 = requireHash(
    evidence.sourceReportSha256,
    "Documentation workflow evidence sourceReportSha256",
  );
  if (sourceReportSha256 !== sourceSummary.reportDigest) {
    throw new TypeError("Documentation workflow evidence references a stale source report.");
  }

  const result = requireObject(evidence.result, "Documentation workflow evidence result");
  requireExactKeys(result, ["name", "passed"], "Documentation workflow evidence result");
  if (result.name !== DOCUMENTATION_WORKFLOW_RESULT) {
    throw new TypeError(
      "Documentation workflow evidence must contain the documentation-workflows result.",
    );
  }
  if (result.passed !== true) {
    throw new TypeError("Documentation workflow evidence result did not pass.");
  }

  return Object.freeze({
    commit: sourceSummary.commit,
    evidenceDigest,
    result: DOCUMENTATION_WORKFLOW_RESULT,
    passed: true,
  });
}

export function createDocumentationWorkflowEvidence(sourceSummary, workflowResult) {
  const evidenceSource = canonicalizeJson({
    version: 1,
    commit: sourceSummary.commit,
    sourceReportSha256: sourceSummary.reportDigest,
    result: { name: workflowResult.result, passed: workflowResult.passed },
  });
  const evidenceSidecar = Buffer.from(
    `${createHash("sha256").update(evidenceSource).digest("hex")}\n`,
    "utf8",
  );
  validateDocumentationWorkflowEvidence({ evidenceSource, evidenceSidecar, sourceSummary });
  return Object.freeze({ evidenceSource, evidenceSidecar });
}

async function readValidatedSourceReport(sourceReportPath, sourceReportSidecarPath) {
  const [reportSource, reportSidecar, expectedBindings] = await Promise.all([
    readFile(resolve(sourceReportPath)),
    readFile(resolve(sourceReportSidecarPath)),
    readRepositorySourceBindings(),
  ]);
  return validateSourceGateReport({ reportSource, reportSidecar, expectedBindings });
}

async function writeDocumentationWorkflowEvidence(
  evidencePath,
  evidenceSidecarPath,
  sourceSummary,
  workflowResult,
) {
  const { evidenceSource, evidenceSidecar } = createDocumentationWorkflowEvidence(
    sourceSummary,
    workflowResult,
  );
  await Promise.all([
    writeFile(resolve(evidencePath), evidenceSource, { flag: "wx" }),
    writeFile(resolve(evidenceSidecarPath), evidenceSidecar, { flag: "wx" }),
  ]);
}

async function assertTarball(tarball, expectedChecksum) {
  if (!/^[0-9a-f]{64}$/u.test(expectedChecksum)) {
    throw new TypeError("Retained tarball checksum must be a lowercase SHA-256 digest.");
  }
  const actual = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  if (actual !== expectedChecksum) {
    throw new TypeError(
      `Retained tarball checksum mismatch: expected ${expectedChecksum}, got ${actual}.`,
    );
  }
}

export async function runArtifactDocumentationWorkflows({
  tarballPath,
  checksum,
  sourceReportPath,
  sourceReportSidecarPath,
  documentationEvidencePath,
  documentationEvidenceSidecarPath,
  root = repositoryRoot,
}) {
  const index = await buildDocumentationIndex(root);
  const summary = validateDocumentedWorkflowRegistry(index);
  const tarball = resolve(tarballPath);
  await assertTarball(tarball, checksum);
  const [sourceSummary, evidenceSource, evidenceSidecar] = await Promise.all([
    readValidatedSourceReport(sourceReportPath, sourceReportSidecarPath),
    readFile(resolve(documentationEvidencePath)),
    readFile(resolve(documentationEvidenceSidecarPath)),
  ]);
  validateDocumentationWorkflowEvidence({ evidenceSource, evidenceSidecar, sourceSummary });

  run(process.execPath, [resolve(root, "scripts/verify-package.mjs"), tarball, checksum], root);
  run(process.execPath, [resolve(root, "scripts/verify-docs.mjs"), tarball, checksum], root);
  runNpm(["run", "test:integration:tarball"], root, {
    ...process.env,
    SDK_TARBALL: tarball,
    SDK_TARBALL_SHA256: checksum,
  });
  return Object.freeze({ ...summary, artifact: true, passed: true });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--source" && (args.length === 0 || args.length === 4)) {
    const sourceSummary =
      args.length === 4 ? await readValidatedSourceReport(args[0], args[1]) : undefined;
    const result = await runSourceDocumentationWorkflows();
    if (sourceSummary !== undefined) {
      await writeDocumentationWorkflowEvidence(args[2], args[3], sourceSummary, result);
    }
    process.stdout.write(`verify-doc-workflows: ${result.commands} documented commands passed\n`);
    return;
  }
  if (mode === "--artifact" && args.length === 6) {
    const result = await runArtifactDocumentationWorkflows({
      tarballPath: args[0],
      checksum: args[1],
      sourceReportPath: args[2],
      sourceReportSidecarPath: args[3],
      documentationEvidencePath: args[4],
      documentationEvidenceSidecarPath: args[5],
    });
    process.stdout.write(`verify-doc-workflows: ${result.commands} retained workflows passed\n`);
    return;
  }
  throw new TypeError(
    "Usage: node scripts/verify-doc-workflows.mjs --source [<source-report.json> <source-report.sha256> <documentation-workflows.json> <documentation-workflows.sha256>] | --artifact <tarball> <sha256> <source-report.json> <source-report.sha256> <documentation-workflows.json> <documentation-workflows.sha256>",
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-doc-workflows: ${message}\n`);
    process.exitCode = 1;
  });
}
