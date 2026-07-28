import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const TESTS_ROOT = join(process.cwd(), "tests");
const VITEST_BIN = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const temporaryDirectories: string[] = [];

interface FixtureResult {
  readonly status: number | null;
  readonly output: string;
}

function runFixture(source: string): FixtureResult {
  const directory = mkdtempSync(join(TESTS_ROOT, ".test-policy-"));
  temporaryDirectories.push(directory);
  const fixture = join(directory, "fixture.test.ts");
  writeFileSync(fixture, source);

  const result = spawnSync(
    process.execPath,
    [VITEST_BIN, "run", relative(process.cwd(), fixture), "--config", "vitest.config.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("committed test policy", () => {
  it("allows a fully executed test suite", () => {
    const result = runFixture(`
      import { expect, test } from "vitest";
      const result = { only: "value", skip: "cursor", todo: "later" };
      test("runs", () => expect(result.skip).toBe("cursor"));
    `);

    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("Committed test policy violations");
  });

  it("rejects focused, skipped, todo, and conditionally skipped tests", () => {
    const result = runFixture(`
      import { describe, suite, test } from "vitest";
      test.only("focused", () => {});
      test.skip("skipped", () => {});
      test.todo("unfinished");
      test.skipIf(true)("conditional", () => {});
      describe.skip("skipped suite", () => {});
      suite.todo("unfinished suite", () => {});
    `);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("Committed test policy violations");
    expect(result.output).toContain("Unexpected .only modifier");
    expect(result.output).toContain('test "skipped" is marked skip');
    expect(result.output).toContain('test "unfinished" is marked todo');
    expect(result.output).toContain('test "conditional" is marked skip');
    expect(result.output).toContain('suite "skipped suite" is marked skip');
    expect(result.output).toContain('suite "unfinished suite" is marked todo');
  });

  it("rejects mutated and computed skip or todo options", () => {
    const result = runFixture(`
      import { test } from "vitest";
      const skipped: Record<string, boolean> = {};
      skipped["skip"] = true;
      const modifier = "todo";
      const unfinished: Record<string, boolean> = {};
      unfinished[modifier] = true;
      test("mutated skip", skipped, () => {});
      test("computed todo", unfinished, () => {});
    `);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('test "mutated skip" is marked skip');
    expect(result.output).toContain('test "computed todo" is marked todo');
  });

  it("rejects TestContext skips called from nested functions", () => {
    const result = runFixture(`
      import { test } from "vitest";
      test("nested context skip", (context) => {
        const nested = () => context.skip("not available");
        nested();
      });
    `);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('test "nested context skip" skipped during execution');
  });
});
