import { relative, sep } from "node:path";
import type { Reporter } from "vitest/reporters";

const INTEGRATION_FILE = "tests/integration/sdk.integration.test.ts";
const INTEGRATION_SUITE = "Integration: SDK against Prism mock";
const INTEGRATION_TESTS = new Set([
  "ping returns a typed envelope",
  "messages.send returns a typed SendMessageResponse",
  "messages.list returns a paginated response",
  "domains.list returns a paginated response",
  "apiKeys.list returns a paginated response",
  "suppressions.list returns a paginated response",
  "routes.list returns a paginated response",
  "accounts.get returns the account",
  "smtpCredentials.list returns a paginated response",
  "statistics.deliverability returns a list envelope",
  "messages.iterate yields items via the async generator",
  "messages.cancel hits DELETE /messages/{id}/cancel",
  "webhooks.list reaches the account-scoped /webhooks endpoint",
  "webhooks.create / get / update / delete round-trip",
  "suppressions.delete sends email/domain query params (per spec)",
  "suppressions.wipe DELETEs /suppressions/all",
  "statistics.bounces hits /statistics/transactional/bounce (singular)",
  "statistics.deliveryTimes hits /statistics/transactional/delivery-time (singular)",
  "accounts.addMember + listMembers + removeMember lifecycle",
  "routes.create no longer requires the (formerly-invented) `domain` field",
]);

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

function isAllowedIntegrationSuite(task: TestSuite): boolean {
  return (
    process.env.RUN_INTEGRATION !== "1" &&
    repositoryPath(task.module.moduleId) === INTEGRATION_FILE &&
    task.name === INTEGRATION_SUITE &&
    task.options.mode === "skip"
  );
}

function isAllowedIntegrationTest(test: TestCase): boolean {
  return (
    process.env.RUN_INTEGRATION !== "1" &&
    repositoryPath(test.module.moduleId) === INTEGRATION_FILE &&
    test.parent.type === "suite" &&
    isAllowedIntegrationSuite(test.parent) &&
    INTEGRATION_TESTS.has(test.name)
  );
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
      if (suite.options.mode !== "run" && !isAllowedIntegrationSuite(suite)) {
        violations.push(`${taskLabel(suite)} is marked ${suite.options.mode}`);
      }
    }

    for (const test of testModule.children.allTests()) {
      if (test.options.mode !== "run" && !isAllowedIntegrationTest(test)) {
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
