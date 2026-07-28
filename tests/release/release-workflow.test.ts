import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const workflowSource = readFileSync(
  resolve(process.cwd(), ".github/workflows/release.yml"),
  "utf8",
);
const liveRunnerSource = readFileSync(
  resolve(process.cwd(), "scripts/run-live-acceptance.mjs"),
  "utf8",
);
const restoreLatestSource = readFileSync(
  resolve(process.cwd(), "scripts/restore-latest.mjs"),
  "utf8",
);
const workflow = yaml.load(workflowSource, { schema: yaml.JSON_SCHEMA }) as unknown;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function jobSteps(job: unknown, label: string): readonly Readonly<Record<string, unknown>>[] {
  return array(record(job, label)["steps"], `${label} steps`).map((step, index) =>
    record(step, `${label} step ${index}`),
  );
}

function commands(job: unknown, label: string): string {
  return jobSteps(job, label)
    .map((step) => step["run"])
    .filter((run): run is string => typeof run === "string")
    .join("\n");
}

describe("single-run release workflow", () => {
  it("starts from one final tag and advances through promotion before release", () => {
    const root = record(workflow, "workflow");
    const trigger = record(root["on"], "release trigger");
    const push = record(trigger["push"], "release push trigger");
    const jobs = record(root["jobs"], "release jobs");

    expect(push["tags"]).toEqual(["v*"]);
    expect(Object.keys(trigger)).toEqual(["push"]);
    expect(record(root["concurrency"], "release concurrency")).toEqual({
      group: "release",
      "cancel-in-progress": false,
    });
    expect(Object.keys(jobs)).toEqual([
      "source-gate",
      "candidate",
      "artifact-gates",
      "external-gates",
      "live-gates",
      "next-publish",
      "registry-smoke",
      "latest-promotion",
      "github-release",
      "release-compensation",
    ]);
    expect(record(jobs["candidate"], "candidate")["needs"]).toBe("source-gate");
    expect(record(jobs["artifact-gates"], "artifact")["needs"]).toBe("candidate");
    expect(record(jobs["external-gates"], "external")["needs"]).toBe("artifact-gates");
    expect(record(jobs["live-gates"], "live")["needs"]).toBe("external-gates");
    expect(record(jobs["next-publish"], "next")["needs"]).toBe("live-gates");
    expect(record(jobs["registry-smoke"], "smoke")["needs"]).toBe("next-publish");
    expect(record(jobs["latest-promotion"], "promotion")["needs"]).toBe("registry-smoke");
    expect(record(jobs["github-release"], "GitHub release")["needs"]).toBe("latest-promotion");
    expect(record(jobs["release-compensation"], "compensation")["needs"]).toEqual([
      "latest-promotion",
      "github-release",
    ]);
  });

  it("builds and packs only in candidate creation and never regenerates the artifact", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const allCommands = Object.entries(jobs)
      .map(([name, job]) => commands(job, name))
      .join("\n");
    const afterCandidate = Object.entries(jobs)
      .slice(2)
      .map(([name, job]) => commands(job, name))
      .join("\n");

    expect(allCommands.match(/create-candidate\.mjs/gu)).toHaveLength(1);
    expect(allCommands).not.toMatch(/\bnpm run build\b/u);
    expect(allCommands).not.toMatch(/\bnpm pack\b/u);
    expect(
      commands(jobs["source-gate"], "source gate").match(/exclude tests\/package\.test\.ts/gu),
    ).toHaveLength(2);
    expect(afterCandidate).not.toMatch(/create-candidate\.mjs/u);
    expect(afterCandidate).not.toMatch(/from ["'][./]*src\//u);
    expect(commands(jobs["registry-smoke"], "registry smoke")).toContain("verify-provenance.mjs");
    expect(commands(jobs["latest-promotion"], "latest promotion")).toContain("promote-latest.mjs");
    expect(commands(jobs["github-release"], "GitHub release")).toContain("gh release create");
  });

  it("retains and downloads every governed handoff with detached sidecars", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const artifactNames = Object.values(jobs).flatMap((job, jobIndex) =>
      jobSteps(job, `job ${jobIndex}`)
        .filter((step) => String(step["uses"] ?? "").startsWith("actions/upload-artifact@"))
        .map((step) => record(step["with"], "upload inputs")["name"]),
    );
    const downloads = Object.values(jobs).flatMap((job, jobIndex) =>
      jobSteps(job, `job ${jobIndex}`)
        .filter((step) => String(step["uses"] ?? "").startsWith("actions/download-artifact@"))
        .map((step) => record(step["with"], "download inputs")["name"]),
    );

    expect(artifactNames).toEqual([
      "source-report",
      "release-tools",
      "candidate-tarball",
      "candidate-manifest",
      "gate-report",
      "promotion-state",
    ]);
    for (const name of [
      "source-report",
      "candidate-tarball",
      "candidate-manifest",
      "gate-report",
    ]) {
      expect(downloads, `${name} handoff`).toContain(name);
    }
    expect(workflowSource).toContain("source-report.sha256");
    expect(workflowSource).toContain("*.tgz.sha256");
    expect(workflowSource).toContain("candidate-manifest.sha256");
    expect(workflowSource).toContain("gate-report.sha256");
    expect(workflowSource).toContain("live-report.sha256");
  });

  it("executes and validates the complete installed-candidate live report", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const liveCommands = commands(jobs["live-gates"], "live gates");

    expect(liveCommands).toContain("scripts/run-live-acceptance.mjs");
    expect(liveCommands).toContain("/tmp/gate-report/live-report.json");
    expect(liveCommands).toContain("/tmp/gate-report/live-report.sha256");
    expect(liveCommands).toContain("liveReportSha256");
    expect(liveRunnerSource).toContain("validateLiveReportArtifacts");
    expect(liveRunnerSource.match(/await run[A-Z][A-Za-z]+LiveScenarios/gu)).toHaveLength(10);
    expect(liveRunnerSource).toContain("combined.subAccounts.operationResults");
    expect(liveRunnerSource).toContain("combined.subAccountAPIKeys.operationResults");
    expect(liveRunnerSource).toContain(
      'import { AUTHORIZATION_REGISTRY } from "./generate-sdk.mjs";',
    );
    expect(liveRunnerSource).not.toContain("const resourceAuthorization");
    expect(liveRunnerSource).not.toMatch(/from ["'][./]*src\//u);
  });

  it("stages releases as drafts and compensates promotion and release failures", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const promotionCommands = commands(jobs["latest-promotion"], "latest promotion");
    const releaseCommands = commands(jobs["github-release"], "GitHub release");
    const compensation = record(jobs["release-compensation"], "compensation");
    const compensationCommands = commands(compensation, "compensation");

    expect(promotionCommands).toContain("promotion-state.json");
    expect(promotionCommands).toContain("promote-latest.mjs");
    expect(releaseCommands).toContain("--draft");
    expect(releaseCommands).toContain("gh release edit");
    expect(releaseCommands.indexOf("--draft")).toBeLessThan(
      releaseCommands.indexOf("--draft=false"),
    );
    expect(compensation["if"]).toBe(
      "${{ always() && needs.latest-promotion.result != 'skipped' && (needs.latest-promotion.result != 'success' || needs.github-release.result != 'success') }}",
    );
    expect(promotionCommands).not.toContain("|| true");
    expect(compensationCommands).not.toContain("|| true");
    expect(compensationCommands).not.toContain('if test "$CURRENT_LATEST"');
    expect(compensationCommands).toContain("/tmp/release-tools/scripts/restore-latest.mjs");
    expect(restoreLatestSource).toContain('"dist-tag", "add"');
    expect(restoreLatestSource).toContain('"dist-tag", "rm"');
    expect(restoreLatestSource).toContain('verification: "rollback"');
    expect(compensationCommands).toContain("gh release delete");
  });

  it("re-promotes and verifies latest before every GitHub Release attempt", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const release = record(jobs["github-release"], "GitHub release");
    const releaseCommands = commands(release, "GitHub release");
    const promotionDownloads = jobSteps(jobs["latest-promotion"], "latest promotion")
      .filter((step) => String(step["uses"] ?? "").startsWith("actions/download-artifact@"))
      .map((step) => record(step["with"], "download inputs")["name"]);
    const releaseDownloads = jobSteps(release, "GitHub release")
      .filter((step) => String(step["uses"] ?? "").startsWith("actions/download-artifact@"))
      .map((step) => record(step["with"], "download inputs")["name"]);

    expect(release["environment"]).toBe("npm-latest");
    expect(commands(jobs["source-gate"], "source gate")).toContain(
      "cp scripts/promote-latest.mjs /tmp/release-tools/scripts/",
    );
    expect(promotionDownloads).toContain("release-tools");
    expect(releaseDownloads).toContain("release-tools");
    expect(releaseCommands).toContain("promote-latest.mjs");
    expect(releaseCommands.indexOf("promote-latest.mjs")).toBeLessThan(
      releaseCommands.indexOf("gh release create"),
    );
    expect(restoreLatestSource).toContain('verification: "promotion"');
  });

  it("reuses immutable promotion state when latest promotion is retried", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const steps = jobSteps(jobs["latest-promotion"], "latest promotion");
    const reuseIndex = steps.findIndex((step) => step["name"] === "Reuse retained promotion state");
    const captureIndex = steps.findIndex((step) => step["name"] === "Capture the prior latest tag");
    const uploadIndex = steps.findIndex((step) =>
      String(step["uses"] ?? "").startsWith("actions/upload-artifact@"),
    );
    const promoteIndex = steps.findIndex(
      (step) => step["name"] === "Promote only the verified version",
    );
    const reuse = record(steps[reuseIndex], "promotion-state reuse");
    const capture = record(steps[captureIndex], "promotion-state capture");
    const upload = record(steps[uploadIndex], "promotion-state upload");

    expect(reuse["id"]).toBe("retained_promotion_state");
    expect(reuse["continue-on-error"]).toBe(true);
    expect(record(reuse["with"], "promotion-state download inputs")["name"]).toBe(
      "promotion-state",
    );
    expect(capture["if"]).toBe("${{ steps.retained_promotion_state.outcome == 'failure' }}");
    expect(upload["if"]).toBe("${{ steps.retained_promotion_state.outcome == 'failure' }}");
    expect(record(upload["with"], "promotion-state upload inputs")["name"]).toBe("promotion-state");
    expect(record(upload["with"], "promotion-state upload inputs")["overwrite"]).toBeUndefined();
    expect(reuseIndex).toBeLessThan(captureIndex);
    expect(captureIndex).toBeLessThan(uploadIndex);
    expect(uploadIndex).toBeLessThan(promoteIndex);
  });

  it("pins actions and limits publish authority to terminal mutations and compensation", () => {
    const root = record(workflow, "workflow");
    const jobs = record(root["jobs"], "jobs");
    const actionReferences = Object.values(jobs).flatMap((job, jobIndex) =>
      jobSteps(job, `job ${jobIndex}`)
        .map((step) => step["uses"])
        .filter((uses): uses is string => typeof uses === "string"),
    );

    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/u.test(reference))).toBe(true);
    expect(record(root["permissions"], "default permissions")).toEqual({ contents: "read" });
    expect(record(record(jobs["next-publish"], "next")["permissions"], "next permissions")).toEqual(
      { contents: "read", "id-token": "write" },
    );
    expect(
      record(
        record(jobs["github-release"], "GitHub release")["permissions"],
        "release permissions",
      ),
    ).toEqual({ contents: "write" });
    expect(
      record(
        record(jobs["release-compensation"], "compensation")["permissions"],
        "compensation permissions",
      ),
    ).toEqual({ contents: "write" });
  });
});
