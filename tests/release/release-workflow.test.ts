import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const workflowSource = readFileSync(
  resolve(process.cwd(), ".github/workflows/release.yml"),
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
    ]);
    expect(record(jobs["candidate"], "candidate")["needs"]).toBe("source-gate");
    expect(record(jobs["artifact-gates"], "artifact")["needs"]).toBe("candidate");
    expect(record(jobs["external-gates"], "external")["needs"]).toBe("artifact-gates");
    expect(record(jobs["live-gates"], "live")["needs"]).toBe("external-gates");
    expect(record(jobs["next-publish"], "next")["needs"]).toBe("live-gates");
    expect(record(jobs["registry-smoke"], "smoke")["needs"]).toBe("next-publish");
    expect(record(jobs["latest-promotion"], "promotion")["needs"]).toBe("registry-smoke");
    expect(record(jobs["github-release"], "GitHub release")["needs"]).toBe("latest-promotion");
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
    expect(afterCandidate).not.toMatch(/create-candidate\.mjs/u);
    expect(afterCandidate).not.toMatch(/from ["'][./]*src\//u);
    expect(commands(jobs["registry-smoke"], "registry smoke")).toContain("verify-provenance.mjs");
    expect(commands(jobs["latest-promotion"], "latest promotion")).toContain("npm dist-tag add");
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
  });

  it("pins actions and limits publish authority to the two terminal mutations", () => {
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
  });
});
