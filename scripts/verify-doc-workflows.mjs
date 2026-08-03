#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

export const DOCUMENTED_WORKFLOW_REGISTRY = Object.freeze([
  { path: "README.md", line: 26, command: "npm install @ahasend/sdk", owner: "installed-package" },
  {
    path: "README.md",
    line: 438,
    command: "git clone https://github.com/AhaSend/ahasend-ts.git",
    owner: "source-setup",
  },
  { path: "README.md", line: 439, command: "cd ahasend-ts", owner: "source-setup" },
  { path: "README.md", line: 440, command: "npm ci", owner: "source-setup" },
  {
    path: "README.md",
    line: 442,
    command: "npm run typecheck         # strict TS over src + tests",
    owner: "source:typecheck",
  },
  {
    path: "README.md",
    line: 443,
    command: "npm test                  # unit tests, fully offline",
    owner: "source:test",
  },
  {
    path: "README.md",
    line: 444,
    command: "npm run test:coverage     # coverage with enforced thresholds",
    owner: "source:coverage",
  },
  {
    path: "README.md",
    line: 445,
    command:
      "npm run test:integration:preflight  # builds, packs, and tests a disposable tarball with Prism",
    owner: "packed-example-matrix",
  },
  {
    path: "README.md",
    line: 446,
    command: "npm run build             # ESM + CJS + .d.ts/.d.cts",
    owner: "source:build",
  },
  {
    path: "README.md",
    line: 463,
    command: "./node_modules/.bin/prism mock openapi.yaml -p 4010 --errors",
    owner: "interactive:prism",
  },
  {
    path: "README.md",
    line: 469,
    command: "node examples/ping.mjs",
    owner: "packed-example-matrix",
  },
  {
    path: "README.md",
    line: 475,
    command: "npm run dev               # tsup in watch mode",
    owner: "interactive:dev",
  },
  {
    path: "README.md",
    line: 476,
    command: "npm run test:watch        # vitest watch",
    owner: "interactive:test-watch",
  },
  {
    path: "README.md",
    line: 477,
    command: "npm run lint              # eslint over src",
    owner: "source:lint",
  },
  {
    path: "README.md",
    line: 478,
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
    line: 65,
    command: "node examples/send-sandbox.mjs",
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
  const invocations = registry.filter((entry) => entry.owner === owner).map(parseDocumentedInvocation);
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
export function createDocumentedWorkflowExecutionPlan(
  registry = DOCUMENTED_WORKFLOW_REGISTRY,
) {
  const installMatches = registry
    .filter((entry) => entry.owner === "source-setup")
    .map(parseDocumentedInvocation)
    .filter(
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
    const inspect = () => {
      if (marker?.test(output) === true) finish();
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

async function temporarySourceTree(root) {
  const parent = await mkdtemp(join(tmpdir(), "ahasend-sdk-doc-workflows-"));
  const target = resolve(parent, "ahasend-ts");
  await cp(root, target, {
    recursive: true,
    filter(source) {
      const relative = source.slice(root.length).replace(/^[/\\]/u, "");
      const first = relative.split(/[/\\]/u, 1)[0];
      return ![
        ".betterborg-task",
        ".orchestry",
        ".betterborg-analysis",
        "node_modules",
        "dist",
        "coverage",
      ].includes(first);
    },
  });
  return { parent, target };
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
  const temporary = await temporarySourceTree(root);
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
      marker: /Build success|Watching for changes/iu,
    });
    const watch = runnableInvocation(plan.watch, temporary.target);
    await runBoundedInteractive({
      label: "Documented test watch workflow",
      ...watch,
      cwd: temporary.target,
      marker: /Test Files|Watching for file changes/iu,
    });
    return Object.freeze({ ...summary, result: "documentation-workflows", passed: true });
  } finally {
    await rm(temporary.parent, { recursive: true, force: true });
  }
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
  root = repositoryRoot,
}) {
  const index = await buildDocumentationIndex(root);
  const summary = validateDocumentedWorkflowRegistry(index);
  const tarball = resolve(tarballPath);
  await assertTarball(tarball, checksum);
  const [reportSource, reportSidecar, expectedBindings] = await Promise.all([
    readFile(resolve(sourceReportPath)),
    readFile(resolve(sourceReportSidecarPath)),
    readRepositorySourceBindings(),
  ]);
  validateSourceGateReport({ reportSource, reportSidecar, expectedBindings });

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
  if (mode === "--source" && args.length === 0) {
    const result = await runSourceDocumentationWorkflows();
    process.stdout.write(`verify-doc-workflows: ${result.commands} documented commands passed\n`);
    return;
  }
  if (mode === "--artifact" && args.length === 4) {
    const result = await runArtifactDocumentationWorkflows({
      tarballPath: args[0],
      checksum: args[1],
      sourceReportPath: args[2],
      sourceReportSidecarPath: args[3],
    });
    process.stdout.write(`verify-doc-workflows: ${result.commands} retained workflows passed\n`);
    return;
  }
  throw new TypeError(
    "Usage: node scripts/verify-doc-workflows.mjs --source | --artifact <tarball> <sha256> <source-report.json> <source-report.sha256>",
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
