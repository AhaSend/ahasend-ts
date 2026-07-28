import { describe, expect, it, vi } from "vitest";
import { promoteLatest, restoreLatest } from "../../scripts/restore-latest.mjs";

describe("latest-tag restoration", () => {
  it("re-promotes the candidate after a failed release is rolled back and retried", async () => {
    let latest = "0.9.0";
    const runNpm = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "view") return `${latest}\n`;
      if (args[0] === "dist-tag" && args[1] === "add") {
        latest = String(args[2]).split("@").at(-1) ?? "";
      }
      return "";
    });
    const options = {
      packageName: "@ahasend/sdk",
      attempts: 1,
      runNpm,
    };

    await promoteLatest({ ...options, version: "1.0.0" });
    await restoreLatest({ ...options, previousLatest: "0.9.0" });
    await promoteLatest({ ...options, version: "1.0.0" });

    expect(latest).toBe("1.0.0");
    expect(runNpm.mock.calls).toEqual([
      [["dist-tag", "add", "@ahasend/sdk@1.0.0", "latest"]],
      [["view", "@ahasend/sdk", "dist-tags.latest"]],
      [["dist-tag", "add", "@ahasend/sdk@0.9.0", "latest"]],
      [["view", "@ahasend/sdk", "dist-tags.latest"]],
      [["dist-tag", "add", "@ahasend/sdk@1.0.0", "latest"]],
      [["view", "@ahasend/sdk", "dist-tags.latest"]],
    ]);
  });

  it("restores and verifies the prior tag after mutation responses fail", async () => {
    const runNpm = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "dist-tag") throw new Error("response lost");
      return "0.9.0\n";
    });

    await restoreLatest({
      packageName: "@ahasend/sdk",
      previousLatest: "0.9.0",
      attempts: 2,
      delay: vi.fn(),
      runNpm,
    });

    expect(runNpm.mock.calls).toEqual([
      [["dist-tag", "add", "@ahasend/sdk@0.9.0", "latest"]],
      [["dist-tag", "add", "@ahasend/sdk@0.9.0", "latest"]],
      [["view", "@ahasend/sdk", "dist-tags.latest"]],
    ]);
  });

  it("treats an already-absent latest tag as a successful first-release rollback", async () => {
    const runNpm = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "dist-tag") throw new Error("tag does not exist");
      return "\n";
    });

    await expect(
      restoreLatest({
        packageName: "@ahasend/sdk",
        previousLatest: null,
        attempts: 1,
        runNpm,
      }),
    ).resolves.toBeUndefined();
    expect(runNpm.mock.calls).toEqual([
      [["dist-tag", "rm", "@ahasend/sdk", "latest"]],
      [["view", "@ahasend/sdk", "dist-tags.latest"]],
    ]);
  });

  it("fails loudly when registry errors prevent rollback verification", async () => {
    const runNpm = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "view") throw new Error("registry unavailable");
      return "";
    });

    await expect(
      restoreLatest({
        packageName: "@ahasend/sdk",
        previousLatest: "0.9.0",
        attempts: 2,
        delay: vi.fn(),
        runNpm,
      }),
    ).rejects.toThrow("Could not verify the rollback latest tag");
    expect(runNpm.mock.calls.filter(([args]) => args[0] === "view")).toHaveLength(2);
  });

  it("rejects a promotion that cannot be observed on the registry", async () => {
    const runNpm = vi.fn(async (args: readonly string[]) => (args[0] === "view" ? "0.9.0\n" : ""));

    await expect(
      promoteLatest({
        packageName: "@ahasend/sdk",
        version: "1.0.0",
        attempts: 2,
        delay: vi.fn(),
        runNpm,
      }),
    ).rejects.toThrow('Latest promotion verification failed for @ahasend/sdk: expected "1.0.0"');
    expect(runNpm.mock.calls.filter(([args]) => args[0] === "view")).toHaveLength(2);
  });

  it("rejects a latest tag that still points at the failed version", async () => {
    const runNpm = vi.fn(async (args: readonly string[]) => (args[0] === "view" ? "1.0.0\n" : ""));

    await expect(
      restoreLatest({
        packageName: "@ahasend/sdk",
        previousLatest: "0.9.0",
        attempts: 2,
        delay: vi.fn(),
        runNpm,
      }),
    ).rejects.toThrow('expected "0.9.0", received "1.0.0"');
    expect(runNpm.mock.calls.filter(([args]) => args[0] === "view")).toHaveLength(2);
  });

  it("retries stale registry reads until the restored tag is visible", async () => {
    let views = 0;
    const runNpm = vi.fn(async (args: readonly string[]) => {
      if (args[0] !== "view") return "";
      views += 1;
      return views === 1 ? "1.0.0\n" : "0.9.0\n";
    });

    await restoreLatest({
      packageName: "@ahasend/sdk",
      previousLatest: "0.9.0",
      attempts: 2,
      delay: vi.fn(),
      runNpm,
    });
    expect(runNpm.mock.calls.filter(([args]) => args[0] === "view")).toHaveLength(2);
  });
});
