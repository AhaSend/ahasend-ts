import { describe, expect, it, vi } from "vitest";
import { restoreLatest } from "../../scripts/restore-latest.mjs";

describe("latest-tag restoration", () => {
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
    ).rejects.toThrow("Could not verify the restored latest tag");
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
