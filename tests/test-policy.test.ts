import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const TESTS_ROOT = join(process.cwd(), "tests");
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const FORBIDDEN_MODIFIERS = ["only", "skip", "todo"] as const;

type ForbiddenModifier = (typeof FORBIDDEN_MODIFIERS)[number];

interface Marker {
  readonly file: string;
  readonly line: number;
  readonly modifier: ForbiddenModifier;
  readonly source: string;
}

interface AllowedMarker {
  readonly modifier: ForbiddenModifier;
  readonly source: string;
}

const ALLOWED_MARKERS: Readonly<Record<string, readonly AllowedMarker[]>> = {
  "tests/integration/sdk.integration.test.ts": [
    {
      modifier: "skip",
      source: `const itIntegration = RUN ? it : ${["it", "skip"].join(".")};`,
    },
    {
      modifier: "skip",
      source: `const describeIntegration = RUN ? describe : ${["describe", "skip"].join(".")};`,
    },
  ],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function repositoryPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}

function findMarkers(file: string, contents: string): Marker[] {
  const pattern = new RegExp(`\\.(${FORBIDDEN_MODIFIERS.join("|")})\\b`, "g");
  const markers: Marker[] = [];

  for (const [index, source] of contents.split(/\r?\n/u).entries()) {
    for (const match of source.matchAll(pattern)) {
      markers.push({
        file,
        line: index + 1,
        modifier: match[1] as ForbiddenModifier,
        source: source.trim(),
      });
    }
  }

  return markers;
}

function markerKey(marker: Pick<Marker, "modifier" | "source">): string {
  return `${marker.modifier}\0${marker.source}`;
}

function auditMarkers(markers: readonly Marker[]): {
  readonly unexpected: readonly Marker[];
  readonly missingAllowances: readonly string[];
} {
  const remainingAllowances = new Map<string, number>(
    Object.entries(ALLOWED_MARKERS).flatMap(([file, allowances]) =>
      allowances.map((allowance) => [`${file}\0${markerKey(allowance)}`, 1] as const),
    ),
  );
  const unexpected: Marker[] = [];

  for (const marker of markers) {
    const key = `${marker.file}\0${markerKey(marker)}`;
    const remaining = remainingAllowances.get(key) ?? 0;
    if (remaining === 0) {
      unexpected.push(marker);
    } else {
      remainingAllowances.set(key, remaining - 1);
    }
  }

  const missingAllowances = [...remainingAllowances.entries()]
    .filter(([, remaining]) => remaining > 0)
    .map(([key]) => key.split("\0").join(": "));

  return { unexpected, missingAllowances };
}

function formatMarker(marker: Marker): string {
  return `${marker.file}:${marker.line} uses .${marker.modifier}: ${marker.source}`;
}

describe("committed test policy", () => {
  it.each(FORBIDDEN_MODIFIERS)("rejects an unexpected %s modifier", (modifier) => {
    const marker = findMarkers("tests/example.test.ts", `it.${modifier}("hidden", () => {});`);

    expect(marker).toEqual([
      {
        file: "tests/example.test.ts",
        line: 1,
        modifier,
        source: `it.${modifier}("hidden", () => {});`,
      },
    ]);
    expect(auditMarkers(marker).unexpected).toEqual(marker);
  });

  it("contains no unexpected focused, skipped, or todo tests", () => {
    const markers = sourceFiles(TESTS_ROOT).flatMap((path) =>
      findMarkers(repositoryPath(path), readFileSync(path, "utf8")),
    );
    const audit = auditMarkers(markers);

    expect(audit.unexpected.map(formatMarker), "Unexpected test modifiers").toEqual([]);
    expect(audit.missingAllowances, "Stale test-modifier allowances").toEqual([]);
  });
});
