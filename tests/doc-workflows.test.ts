import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { buildDocumentationIndex } from "../scripts/verify-docs.mjs";
import {
  DOCUMENTED_WORKFLOW_REGISTRY,
  runBoundedInteractive,
  validateDocumentedWorkflowRegistry,
  type DocumentationWorkflowEntry,
} from "../scripts/verify-doc-workflows.mjs";

const spawnedProcessIds: number[] = [];

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

    expect(validateDocumentedWorkflowRegistry(index)).toEqual({ commands: 24, owners: 12 });
    expect(DOCUMENTED_WORKFLOW_REGISTRY).toHaveLength(24);
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
});

describe("bounded documented processes", () => {
  it("terminates a process tree after its startup marker", async () => {
    const output = await runBoundedInteractive({
      label: "ready fixture",
      command: process.execPath,
      args: ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      marker: /ready/u,
      timeoutMs: 2_000,
    });

    expect(output).toContain("ready");
  });

  it.runIf(process.platform !== "win32")(
    "kills a hanging child process tree and reports timeout as failure",
    async () => {
      let failure: unknown;
      try {
        await runBoundedInteractive({
          label: "hanging fixture",
          command: process.execPath,
          args: [
            "-e",
            [
              'const { spawn } = require("node:child_process");',
              'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
              "console.log(`child-pid=${child.pid}`);",
              "setInterval(() => {}, 1000);",
            ].join(" "),
          ],
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
      const processId = Number(message.match(/child-pid=(\d+)/u)?.[1]);
      expect(processId).toBeGreaterThan(0);
      spawnedProcessIds.push(processId);
      const probe = spawnSync("kill", ["-0", String(processId)]);
      expect(probe.status).not.toBe(0);
    },
  );
});
