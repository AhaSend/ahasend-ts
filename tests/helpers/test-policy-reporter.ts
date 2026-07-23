import { relative, sep } from "node:path";
import type { Reporter } from "vitest/reporters";

type OnTestRunEnd = Exclude<Reporter["onTestRunEnd"], undefined>;
type TestModule = Parameters<OnTestRunEnd>[0][number];
type TestCase =
  ReturnType<TestModule["children"]["allTests"]> extends Generator<infer Test, undefined, void>
    ? Test
    : never;
type TestSuite =
  ReturnType<TestModule["children"]["allSuites"]> extends Generator<infer Suite, undefined, void>
    ? Suite
    : never;
type PolicyTask = TestCase | TestSuite;

function repositoryPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}

function taskLocation(task: PolicyTask): string {
  const file = repositoryPath(task.module.moduleId);
  return task.location === undefined ? file : `${file}:${task.location.line}`;
}

function taskLabel(task: PolicyTask): string {
  return `${taskLocation(task)} ${task.type} "${task.fullName}"`;
}

function hasNonRunningParent(test: TestCase): boolean {
  let parent = test.parent;
  while (parent.type === "suite") {
    if (parent.options.mode !== "run") return true;
    parent = parent.parent;
  }
  return false;
}

export function findPolicyViolations(testModules: ReadonlyArray<TestModule>): string[] {
  const violations: string[] = [];

  for (const testModule of testModules) {
    for (const suite of testModule.children.allSuites()) {
      if (suite.options.mode !== "run") {
        violations.push(`${taskLabel(suite)} is marked ${suite.options.mode}`);
      }
    }

    for (const test of testModule.children.allTests()) {
      if (test.options.mode !== "run") {
        violations.push(`${taskLabel(test)} is marked ${test.options.mode}`);
      } else if (test.result().state === "skipped" && !hasNonRunningParent(test)) {
        violations.push(`${taskLabel(test)} skipped during execution`);
      }
    }
  }

  return violations;
}

export class CommittedTestPolicyReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const violations = findPolicyViolations(testModules);
    if (violations.length > 0) {
      throw new Error(`Committed test policy violations:\n${violations.join("\n")}`);
    }
  }
}
