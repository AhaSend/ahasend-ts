#!/usr/bin/env node

const generatedCodePattern = /\.(?:[cm]?js|d\.[cm]?ts|map)$/u;
const nodeSpecifierPattern = /\bnode:[a-z0-9_./-]+/iu;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Assert that generated code in a relative-path artifact map contains no Node.js specifiers.
 *
 * Non-code package files such as README.md and CHANGELOG.md are intentionally ignored.
 */
export function assertNoNodeSpecifiers(artifacts) {
  const offendingPaths = [];

  for (const [path, bytes] of artifacts) {
    if (!generatedCodePattern.test(path)) continue;

    let source;
    try {
      source = utf8Decoder.decode(bytes);
    } catch (error) {
      throw new TypeError(`Generated artifact is not valid UTF-8: ${path}`, { cause: error });
    }

    if (nodeSpecifierPattern.test(source)) offendingPaths.push(path);
  }

  if (offendingPaths.length > 0) {
    offendingPaths.sort();
    throw new TypeError(
      `Generated artifacts contain forbidden Node.js specifiers:\n${offendingPaths
        .map((path) => `- ${path}`)
        .join("\n")}`,
    );
  }
}
