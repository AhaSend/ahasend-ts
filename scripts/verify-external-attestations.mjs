#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRendererReport } from "./verify-renderer-report.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function validateExternalAttestations({
  rendererHandoffSource,
  rendererHandoffSidecar,
  rendererReportSource,
}) {
  return {
    renderer: validateRendererReport({
      handoffSource: rendererHandoffSource,
      handoffSidecar: rendererHandoffSidecar,
      reportSource: rendererReportSource,
    }),
  };
}

async function main() {
  const [rendererReportPath, ...extraArguments] = process.argv.slice(2);
  if (rendererReportPath === undefined || extraArguments.length > 0) {
    throw new TypeError(
      "Usage: node scripts/verify-external-attestations.mjs <renderer-report.json>",
    );
  }

  const [rendererHandoffSource, rendererHandoffSidecar, rendererReportSource] = await Promise.all([
    readFile(resolve(repositoryRoot, "docs/renderer-handoff.json")),
    readFile(resolve(repositoryRoot, "docs/renderer-handoff.sha256")),
    readFile(resolve(rendererReportPath)),
  ]);
  const { renderer } = validateExternalAttestations({
    rendererHandoffSource,
    rendererHandoffSidecar,
    rendererReportSource,
  });
  process.stdout.write(
    `External attestations passed: renderer report covers ${renderer.operations} operations and ${renderer.tabs} tabs for handoff ${renderer.handoffDigest}.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-external-attestations: ${message}\n`);
    process.exitCode = 1;
  });
}
