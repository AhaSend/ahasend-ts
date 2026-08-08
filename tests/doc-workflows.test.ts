import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalizeJson, sha256Hex } from "../scripts/digest-artifact.mjs";
import { buildDocumentationIndex } from "../scripts/verify-docs.mjs";
import {
  createDocumentationWorkflowEvidence,
  createDocumentedWorkflowExecutionPlan,
  DOCUMENTED_WORKFLOW_REGISTRY,
  runBoundedInteractive,
  TSUP_INITIAL_BUILD_MARKERS,
  validateDocumentationWorkflowEvidence,
  validateDocumentedWorkflowRegistry,
  VITEST_WATCH_READY_MARKER,
  type DocumentationWorkflowEntry,
} from "../scripts/verify-doc-workflows.mjs";

const spawnedProcessIds: number[] = [];

async function waitForProcessExit(processId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (spawnSync("kill", ["-0", String(processId)]).status !== 0) return true;
    await delay(10);
  } while (Date.now() < deadline);
  return spawnSync("kill", ["-0", String(processId)]).status !== 0;
}

afterAll(() => {
  if (process.platform === "win32") return;
  for (const processId of spawnedProcessIds) {
    try {
      process.kill(processId, "SIGKILL");
    } catch {
      // The bounded runner already terminated the fixture process tree.
    }
  }
});

describe("documented workflow registry", () => {
  it("maps every advertised command exactly once", async () => {
    const index = await buildDocumentationIndex();

    expect(validateDocumentedWorkflowRegistry(index)).toEqual({ commands: 45, owners: 12 });
    expect(DOCUMENTED_WORKFLOW_REGISTRY).toHaveLength(45);
    expect(
      index.commands.filter(({ source }) => source.trimStart().startsWith("export ")),
    ).toHaveLength(19);
    expect(
      DOCUMENTED_WORKFLOW_REGISTRY.filter(({ command }) => command.startsWith("export ")),
    ).toHaveLength(19);
    expect(
      index.commands.filter(({ source }) => source.trimStart().startsWith("$env:")),
    ).toHaveLength(2);
    expect(
      DOCUMENTED_WORKFLOW_REGISTRY.filter(({ command }) => command.startsWith("$env:")),
    ).toHaveLength(2);
  });

  it.each([
    ["missing", (entries: DocumentationWorkflowEntry[]) => entries.slice(1)],
    ["duplicate", (entries: DocumentationWorkflowEntry[]) => [...entries, entries[0]!]],
    [
      "altered",
      (entries: DocumentationWorkflowEntry[]) => [
        { ...entries[0]!, command: "npm install @ahasend/sdk@latest" },
        ...entries.slice(1),
      ],
    ],
    [
      "Prism without --errors",
      (entries: DocumentationWorkflowEntry[]) =>
        entries.map((entry) =>
          entry.owner === "interactive:prism"
            ? { ...entry, command: entry.command.replace(" --errors", "") }
            : entry,
        ),
    ],
  ])("rejects a %s registry", async (_label, mutate) => {
    const index = await buildDocumentationIndex();
    const entries = DOCUMENTED_WORKFLOW_REGISTRY.map((entry) => ({ ...entry }));

    expect(() => validateDocumentedWorkflowRegistry(index, mutate(entries))).toThrow();
  });

  it("rejects an unregistered documentation command", async () => {
    const index = await buildDocumentationIndex();
    const commands = [
      ...index.commands,
      { path: "examples/README.md", line: 999, source: "node examples/iterate.mjs" },
    ];

    expect(() => validateDocumentedWorkflowRegistry({ commands })).toThrow("has no workflow owner");
  });

  it("derives source and interactive runtime argv from the exact registry", () => {
    const entries = DOCUMENTED_WORKFLOW_REGISTRY.map((entry) =>
      entry.owner === "source:typecheck"
        ? { ...entry, command: "npm run typecheck:registry-fixture" }
        : entry,
    );

    const plan = createDocumentedWorkflowExecutionPlan(entries);

    expect(plan.clone).toEqual({
      executable: "git",
      args: ["clone", "https://github.com/AhaSend/ahasend-ts.git"],
    });
    expect(plan.sourceDirectory).toBe("ahasend-ts");
    expect(plan.install).toEqual({ executable: "npm", args: ["ci"] });
    expect(plan.source.find(({ owner }) => owner === "source:typecheck")?.invocation).toEqual({
      executable: "npm",
      args: ["run", "typecheck:registry-fixture"],
    });
    expect(plan.prism).toEqual({
      executable: "./node_modules/.bin/prism",
      args: ["mock", "openapi.yaml", "-p", "4010", "--errors"],
    });
  });

  it.each([
    [
      "clone",
      536,
      "git clone https://invalid.example/not-the-sdk.git",
      "clone https://github.com/AhaSend/ahasend-ts.git",
    ],
    ["working directory", 537, "cd not-the-sdk", "enter the cloned ahasend-ts directory"],
  ])("rejects coordinated invalid source setup %s argv", async (_label, line, command, message) => {
    const index = await buildDocumentationIndex();
    const entries = DOCUMENTED_WORKFLOW_REGISTRY.map((entry) =>
      entry.path === "README.md" && entry.line === line ? { ...entry, command } : { ...entry },
    );
    const commands = index.commands.map((entry) =>
      entry.path === "README.md" && entry.line === line ? { ...entry, source: command } : entry,
    );

    expect(() => validateDocumentedWorkflowRegistry({ commands }, entries)).toThrow(message);
  });

  it("rejects runtime Prism argv without --errors", () => {
    const entries = DOCUMENTED_WORKFLOW_REGISTRY.map((entry) =>
      entry.owner === "interactive:prism"
        ? { ...entry, command: entry.command.replace(" --errors", "") }
        : entry,
    );

    expect(() => createDocumentedWorkflowExecutionPlan(entries)).toThrow("with --errors");
  });
});

describe("test watch readiness marker", () => {
  it("treats the vitest run banner as readiness, before any test completes", async () => {
    // The banner appears within seconds of launch. Waiting for the end-of-run
    // `Test Files` summary instead made the 60-second readiness budget cover
    // the whole initial suite pass, which two-core CI runners cannot fit —
    // every hosted run of this gate timed out while faster machines passed.
    const output = await runBoundedInteractive({
      label: "vitest watch banner fixture",
      command: process.execPath,
      args: [
        "-e",
        'console.log(" RUN  v3.2.6 /tmp/doc-workflows-fixture"); setInterval(() => {}, 1000)',
      ],
      cwd: process.cwd(),
      marker: VITEST_WATCH_READY_MARKER,
      timeoutMs: 5_000,
    });

    expect(output).toContain("RUN  v3.2.6");
  });

  it("matches the summary and both watch-prompt spellings as fallbacks", () => {
    // `Test Files  38 passed` (or failed — readiness never proved green) and
    // vitest's actual "Waiting for file changes"; the pre-fix marker's
    // "Watching" spelling matched no vitest version at all.
    for (const line of [
      "Test Files  38 passed (38)",
      "Test Files  1 failed | 37 passed (38)",
      " Waiting for file changes...",
      "Watching for file changes",
    ]) {
      expect(VITEST_WATCH_READY_MARKER.test(line), line).toBe(true);
    }
  });

  it("does not fire on npm's own preamble before vitest starts", () => {
    for (const line of [
      "npm notice run @ahasend/sdk@0.1.0 test:watch",
      "> @ahasend/sdk@0.1.0 test:watch",
      "> vitest",
      "npm run v10.0.0", // lowercase run: not the banner
    ]) {
      expect(VITEST_WATCH_READY_MARKER.test(line), line).toBe(false);
    }
  });
});

describe("bounded documented processes", () => {
  it.runIf(process.platform !== "win32")(
    "terminates a process tree after its startup marker",
    async () => {
      const output = await runBoundedInteractive({
        label: "ready fixture",
        command: process.execPath,
        args: [
          "-e",
          [
            'const { spawn } = require("node:child_process");',
            'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
            "console.log(`child-pid=${child.pid}`);",
            'console.log("ready");',
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        marker: /ready/u,
        timeoutMs: 2_000,
      });

      expect(output).toContain("ready");
      const processId = Number(output.match(/child-pid=(\d+)/u)?.[1]);
      expect(processId).toBeGreaterThan(0);
      spawnedProcessIds.push(processId);
      await expect(waitForProcessExit(processId, 1_000)).resolves.toBe(true);
    },
  );

  it("rejects a dev build that fails after an early per-format success", async () => {
    await expect(
      runBoundedInteractive({
        label: "failing dev build fixture",
        command: process.execPath,
        args: [
          "-e",
          [
            'console.log("CJS ⚡️ Build success in 10ms");',
            'console.error("DTS Build error");',
            "process.exitCode = 1;",
          ].join(" "),
        ],
        cwd: process.cwd(),
        requiredMarkers: TSUP_INITIAL_BUILD_MARKERS,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("exited before readiness");
  });

  it.runIf(process.platform !== "win32")(
    "reports a hanging process timeout as failure",
    async () => {
      let failure: unknown;
      try {
        await runBoundedInteractive({
          label: "hanging fixture",
          command: process.execPath,
          args: ["-e", ["setInterval(() => {}, 1000);"].join(" ")],
          cwd: process.cwd(),
          marker: /never-ready/u,
          timeoutMs: 100,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(TypeError);
      const message = failure instanceof Error ? failure.message : "";
      expect(message).toContain("did not become ready");
    },
  );
});

describe("documentation workflow source evidence", () => {
  const sourceSummary = {
    commit: "a".repeat(40),
    reportDigest: "b".repeat(64),
    gates: 12,
  };

  function evidence(result: unknown = { name: "documentation-workflows", passed: true }) {
    const source = canonicalizeJson({
      version: 1,
      commit: sourceSummary.commit,
      sourceReportSha256: sourceSummary.reportDigest,
      result,
    });
    return { evidenceSource: source, evidenceSidecar: `${sha256Hex(source)}\n`, sourceSummary };
  }

  it("accepts the documentation-workflows result bound to the retained source report", () => {
    const retained = createDocumentationWorkflowEvidence(sourceSummary, {
      result: "documentation-workflows",
      passed: true,
    });

    expect(validateDocumentationWorkflowEvidence({ ...retained, sourceSummary })).toEqual({
      commit: sourceSummary.commit,
      evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      result: "documentation-workflows",
      passed: true,
    });
  });

  it("rejects retained source evidence without a documentation-workflows result", () => {
    expect(() =>
      validateDocumentationWorkflowEvidence(evidence({ name: "audit", passed: true })),
    ).toThrow("must contain the documentation-workflows result");
  });

  it("rejects documentation evidence bound to a different source report", () => {
    expect(() =>
      validateDocumentationWorkflowEvidence({
        ...evidence(),
        sourceSummary: { ...sourceSummary, reportDigest: "c".repeat(64) },
      }),
    ).toThrow("references a stale source report");
  });
});
