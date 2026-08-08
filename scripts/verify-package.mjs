#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoNodeSpecifiers } from "./assert-no-node-specifiers.mjs";
import { digestJsonArtifact } from "./digest-artifact.mjs";
import { validateSecretScanAllowlist } from "./generate-contracts.mjs";
import { SECRET_PATTERNS } from "./secret-patterns.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repositoryRoot, "tests/package");
const require = createRequire(import.meta.url);
const [tarballArgument, checksumArgument] = process.argv.slice(2);
const tarball = resolve(tarballArgument ?? process.env.SDK_TARBALL ?? "");
const expectedChecksum = (checksumArgument ?? process.env.SDK_TARBALL_SHA256 ?? "").toLowerCase();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const fixedPackageFiles = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "dist/_internal/errors.cjs",
  "dist/_internal/errors.cjs.map",
  "dist/_internal/errors.js",
  "dist/_internal/errors.js.map",
  "dist/_metadata/operation-profile.json",
  "dist/_metadata/operation-profile.sha256",
  "dist/index.cjs",
  "dist/index.cjs.map",
  "dist/index.d.cts",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/webhooks/index.cjs",
  "dist/webhooks/index.cjs.map",
  "dist/webhooks/index.d.cts",
  "dist/webhooks/index.d.ts",
  "dist/webhooks/index.js",
  "dist/webhooks/index.js.map",
  "package.json",
]);
const runtimeFiles = [
  "dist/_internal/errors.cjs",
  "dist/_internal/errors.js",
  "dist/index.cjs",
  "dist/index.js",
  "dist/webhooks/index.cjs",
  "dist/webhooks/index.js",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function packageJsonPath(packageName) {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch (packageJsonError) {
    let directory = dirname(require.resolve(packageName));

    while (true) {
      const candidate = join(directory, "package.json");
      try {
        const packageJson = JSON.parse(readFileSync(candidate, "utf8"));
        if (packageJson.name === packageName) return candidate;
      } catch {
        // Keep walking toward the package root.
      }

      const parent = dirname(directory);
      if (parent === directory) throw packageJsonError;
      directory = parent;
    }
  }
}

function packageExecutable(packageName, executableName) {
  const manifestPath = packageJsonPath(packageName);
  const packageJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = packageJson.bin;
  const relativeExecutable =
    typeof bin === "string" ? bin : (bin?.[executableName] ?? bin?.[packageName]);

  if (typeof relativeExecutable !== "string") {
    throw new Error(`Package ${packageName} does not provide the ${executableName} executable.`);
  }
  return resolve(dirname(manifestPath), relativeExecutable);
}

function run(label, command, args, cwd) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

function collectFiles(directory, prefix = "", files = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = resolve(directory, entry.name);
    const metadata = lstatSync(absolutePath);

    if (metadata.isSymbolicLink()) {
      throw new TypeError(`Package contains a symbolic link: ${path}`);
    }
    if (metadata.isDirectory()) {
      collectFiles(absolutePath, path, files);
    } else if (metadata.isFile()) {
      files.set(path, readFileSync(absolutePath));
    } else {
      throw new TypeError(`Package contains an unsupported filesystem entry: ${path}`);
    }
  }
  return files;
}

function trackedSourceFiles() {
  const output = capture("git", ["ls-files", "-z"], repositoryRoot);
  const paths = output.split("\0").filter(Boolean);
  return new Map(paths.map((path) => [path, readFileSync(resolve(repositoryRoot, path))]));
}

function reportFiles(sourceFiles) {
  const reports = new Map(
    [...sourceFiles].filter(([path]) => path.startsWith("etc/") && path.endsWith(".api.md")),
  );
  if (reports.size !== 2) {
    throw new TypeError(`Expected two reviewed API reports, received ${reports.size}.`);
  }
  return reports;
}

function createTarballApiExtractorConfig(configName, packageDirectory, temporaryDirectory) {
  const sourceConfigPath = resolve(repositoryRoot, "config", configName);
  const config = JSON.parse(readFileSync(sourceConfigPath, "utf8"));
  const generatedConfigPath = resolve(packageDirectory, `.verification-${configName}`);

  if (!config.mainEntryPointFilePath.startsWith("<projectFolder>/dist/")) {
    throw new TypeError(`${configName} must resolve its declaration entry point from the package.`);
  }
  config.projectFolder = packageDirectory;
  config.compiler.tsconfigFilePath = resolve(repositoryRoot, "tsconfig.json");
  config.apiReport.reportFolder = resolve(repositoryRoot, "etc");
  config.apiReport.reportTempFolder = resolve(temporaryDirectory, "api-reports");
  writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  return generatedConfigPath;
}

function listArchiveEntries() {
  const entries = capture("tar", ["-tzf", tarball], repositoryRoot).split("\n").filter(Boolean);
  const verboseEntries = capture("tar", ["-tvzf", tarball], repositoryRoot)
    .split("\n")
    .filter(Boolean);

  if (entries.length !== verboseEntries.length) {
    throw new TypeError("Package archive listings disagree.");
  }
  for (const entry of verboseEntries) {
    if (!entry.startsWith("-")) {
      throw new TypeError("Package archive must contain regular files only.");
    }
  }

  const paths = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.startsWith("package/")) {
      throw new TypeError(`Package archive entry is outside package/: ${entry}`);
    }
    const path = entry.slice("package/".length);
    if (
      path === "" ||
      path.includes("\\") ||
      path.includes("\0") ||
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path.startsWith("../")
    ) {
      throw new TypeError(`Package archive contains an unsafe path: ${entry}`);
    }
    if (seen.has(path)) throw new TypeError(`Package archive contains duplicate path: ${path}`);
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function verifyPackageContents(packageFiles) {
  const paths = [...packageFiles.keys()].sort();
  const declarationChunks = paths.filter((path) =>
    /^dist\/errors-[A-Za-z0-9_-]+\.d\.(?:cts|ts)$/.test(path),
  );
  if (declarationChunks.length !== 2) {
    throw new TypeError(
      `Package must contain one ESM and one CJS declaration chunk; received ${JSON.stringify(declarationChunks)}.`,
    );
  }
  const declarationStem = declarationChunks[0].replace(/\.d\.(?:cts|ts)$/, "");
  if (
    !declarationChunks.includes(`${declarationStem}.d.cts`) ||
    !declarationChunks.includes(`${declarationStem}.d.ts`)
  ) {
    throw new TypeError("ESM and CJS declaration chunks must share one generated name.");
  }

  const allowedFiles = new Set([...fixedPackageFiles, ...declarationChunks]);
  const unexpected = paths.filter((path) => !allowedFiles.has(path));
  const missing = [...allowedFiles].filter((path) => !packageFiles.has(path)).sort();
  if (unexpected.length > 0 || missing.length > 0 || paths.length !== allowedFiles.size) {
    throw new TypeError(
      `Package content allowlist violation: unexpected ${JSON.stringify(unexpected)}, missing ${JSON.stringify(missing)}.`,
    );
  }
}

function parseJson(bytes, location) {
  try {
    return JSON.parse(utf8Decoder.decode(bytes));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid UTF-8 JSON in ${location}: ${message}`, { cause: error });
  }
}

function requirePackageFile(packageFiles, path) {
  const bytes = packageFiles.get(path);
  if (bytes === undefined) throw new TypeError(`Package is missing ${path}.`);
  return bytes;
}

function verifySourceMaps(packageFiles, sourceFiles) {
  for (const runtimePath of runtimeFiles) {
    const runtime = utf8Decoder.decode(requirePackageFile(packageFiles, runtimePath));
    const mapPath = `${runtimePath}.map`;
    const map = parseJson(requirePackageFile(packageFiles, mapPath), mapPath);
    if (
      map === null ||
      typeof map !== "object" ||
      map.version !== 3 ||
      map.file !== posix.basename(runtimePath) ||
      !Array.isArray(map.sources) ||
      !Array.isArray(map.sourcesContent) ||
      map.sources.length === 0 ||
      map.sources.length !== map.sourcesContent.length
    ) {
      throw new TypeError(`Invalid source-map structure in ${mapPath}.`);
    }
    if ("sourceRoot" in map) {
      throw new TypeError(`${mapPath} must not define sourceRoot.`);
    }

    for (const [index, sourcePath] of map.sources.entries()) {
      const sourceContent = map.sourcesContent[index];
      if (
        typeof sourcePath !== "string" ||
        typeof sourceContent !== "string" ||
        sourcePath.includes("\\") ||
        sourcePath.includes("\0") ||
        posix.isAbsolute(sourcePath) ||
        posix.normalize(sourcePath) !== sourcePath
      ) {
        throw new TypeError(`${mapPath} contains an unsafe source path.`);
      }
      const repositoryPath = posix.normalize(posix.join(posix.dirname(runtimePath), sourcePath));
      if (!repositoryPath.startsWith("src/") || !repositoryPath.endsWith(".ts")) {
        throw new TypeError(`${mapPath} source escapes the TypeScript source tree: ${sourcePath}`);
      }
      const sourceBytes = sourceFiles.get(repositoryPath);
      if (sourceBytes === undefined || !sourceBytes.equals(Buffer.from(sourceContent, "utf8"))) {
        throw new TypeError(`${mapPath} does not embed exact source bytes for ${repositoryPath}.`);
      }
    }

    const sourceMapUrls = [...runtime.matchAll(/\/\/# sourceMappingURL=([^\s]+)/g)].map(
      (match) => match[1],
    );
    if (
      sourceMapUrls.length === 0 ||
      sourceMapUrls.some((sourceMapUrl) => sourceMapUrl !== posix.basename(mapPath))
    ) {
      throw new TypeError(`${runtimePath} contains an invalid source-map URL.`);
    }
  }
}

function normalizeExportTargetPath(value) {
  const pathEnd = value.search(/[?#]/);
  const pathValue = pathEnd === -1 ? value : value.slice(0, pathEnd);
  try {
    return posix.normalize(decodeURIComponent(pathValue));
  } catch {
    return posix.normalize(pathValue);
  }
}

function exportTargetMatchesPath(target, path) {
  target = normalizeExportTargetPath(target);
  path = normalizeExportTargetPath(path);
  const parts = target.split("*");
  if (parts.length === 1) return target === path;

  const escapeRegExp = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern = `^${escapeRegExp(parts[0])}(?<replacement>.+)`;
  for (const part of parts.slice(1, -1)) {
    pattern += `${escapeRegExp(part)}\\k<replacement>`;
  }
  pattern += `${escapeRegExp(parts.at(-1))}$`;
  return new RegExp(pattern).test(path);
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

function verifyMetadata(packageFiles) {
  const profilePath = "dist/_metadata/operation-profile.json";
  const digestPath = "dist/_metadata/operation-profile.sha256";
  const profile = requirePackageFile(packageFiles, profilePath);
  const digest = requirePackageFile(packageFiles, digestPath);
  const sourceProfile = readFileSync(
    resolve(repositoryRoot, "src/generated/operation-profile.json"),
  );
  const sourceDigest = readFileSync(
    resolve(repositoryRoot, "src/generated/operation-profile.sha256"),
  );

  if (!profile.equals(sourceProfile) || !digest.equals(sourceDigest)) {
    throw new TypeError("Packaged operation metadata must match generated source bytes exactly.");
  }
  const detachedDigest = utf8Decoder.decode(digest);
  if (!/^[0-9a-f]{64}\n$/.test(detachedDigest)) {
    throw new TypeError("Packaged operation profile digest has an invalid representation.");
  }
  if (`${digestJsonArtifact(parseJson(profile, profilePath))}\n` !== detachedDigest) {
    throw new TypeError("Packaged operation profile does not match its detached digest.");
  }

  const manifest = parseJson(requirePackageFile(packageFiles, "package.json"), "package.json");
  const privateMetadataPaths = [`./${profilePath}`, `./${digestPath}`];
  const targets = exportTargets(manifest.exports);
  if (
    manifest.exports === undefined ||
    targets.some((target) =>
      privateMetadataPaths.some((metadataPath) => exportTargetMatchesPath(target, metadataPath)),
    )
  ) {
    throw new TypeError("Packaged operation metadata must remain unexported.");
  }
}

async function loadSecretRules(sourceFiles) {
  const policyPath = "security/secret-scan-allowlist.json";
  const policy = parseJson(requirePackageFile(sourceFiles, policyPath), policyPath);
  const rules = await validateSecretScanAllowlist(policy, repositoryRoot);
  return rules.map((rule) => {
    const keyFile = requirePackageFile(sourceFiles, rule.allowedPath);
    return { ...rule, secret: keyFile.subarray(0, -1) };
  });
}

function countOccurrences(bytes, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = bytes.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function verifySecretPatterns(files, label) {
  for (const [path, bytes] of files) {
    const source = bytes.toString("utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(source)) {
        throw new TypeError(`${label} contains an unclassified secret signature in ${path}.`);
      }
    }
  }
}

function verifySourceSecrets(sourceFiles, rules) {
  const classifiedPaths = new Set(rules.map((rule) => rule.allowedPath));
  const fixtureKeyPaths = [...sourceFiles.keys()].filter((path) =>
    /^contracts\/webhooks\/(?:captured|synthetic)\/keys\/[^/]+\.key$/.test(path),
  );
  const unclassifiedKeys = fixtureKeyPaths.filter((path) => !classifiedPaths.has(path));
  if (unclassifiedKeys.length > 0) {
    throw new TypeError(
      `Source contains unclassified fixture keys: ${JSON.stringify(unclassifiedKeys)}.`,
    );
  }

  for (const rule of rules) {
    const occurrences = [];
    for (const [path, bytes] of sourceFiles) {
      const count = countOccurrences(bytes, rule.secret);
      for (let index = 0; index < count; index += 1) occurrences.push(path);
    }
    if (occurrences.length !== 1 || occurrences[0] !== rule.allowedPath) {
      throw new TypeError(
        `${rule.id} source secret classification violation: ${JSON.stringify(occurrences)}.`,
      );
    }
  }
  verifySecretPatterns(sourceFiles, "Source");
}

function verifyNoClassifiedSecrets(files, rules, label) {
  for (const rule of rules) {
    for (const [path, bytes] of files) {
      if (bytes.includes(rule.secret)) {
        throw new TypeError(`${label} contains fixture key ${rule.id} in ${path}.`);
      }
    }
  }
  verifySecretPatterns(files, label);
}

function expectValidationFailure(label, validation, pattern) {
  try {
    validation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`${label} failed for the wrong reason: ${message}`, { cause: error });
  }
  throw new Error(`${label} did not fail validation.`);
}

function verifyNegativeCases(packageFiles, sourceFiles, rules) {
  const withFixture = new Map(packageFiles);
  withFixture.set("contracts/webhooks/captured/keys/leaked.key", Buffer.from("fixture"));
  expectValidationFailure(
    "negative package-content case",
    () => verifyPackageContents(withFixture),
    /content allowlist violation/,
  );

  const withUnsafeMap = new Map(packageFiles);
  const mapPath = "dist/index.js.map";
  const unsafeMap = structuredClone(parseJson(requirePackageFile(packageFiles, mapPath), mapPath));
  unsafeMap.sources[0] = resolve(repositoryRoot, unsafeMap.sources[0]);
  withUnsafeMap.set(mapPath, Buffer.from(JSON.stringify(unsafeMap)));
  expectValidationFailure(
    "negative source-map case",
    () => verifySourceMaps(withUnsafeMap, sourceFiles),
    /unsafe source path/,
  );

  const withTransformedMetadata = new Map(packageFiles);
  const profilePath = "dist/_metadata/operation-profile.json";
  withTransformedMetadata.set(
    profilePath,
    Buffer.from(
      JSON.stringify(parseJson(requirePackageFile(packageFiles, profilePath), profilePath)),
    ),
  );
  expectValidationFailure(
    "negative transformed-metadata case",
    () => verifyMetadata(withTransformedMetadata),
    /match generated source bytes exactly/,
  );

  const withPatternExport = new Map(packageFiles);
  const manifest = structuredClone(
    parseJson(requirePackageFile(packageFiles, "package.json"), "package.json"),
  );
  manifest.exports["./meta*"] = "./dist/_meta*";
  withPatternExport.set("package.json", Buffer.from(JSON.stringify(manifest)));
  expectValidationFailure(
    "negative metadata export-pattern case",
    () => verifyMetadata(withPatternExport),
    /must remain unexported/,
  );

  const withNormalizedExport = new Map(packageFiles);
  const normalizedManifest = structuredClone(
    parseJson(requirePackageFile(packageFiles, "package.json"), "package.json"),
  );
  normalizedManifest.exports["./metadata"] = "./dist//_metadata/operation-profile.json";
  withNormalizedExport.set("package.json", Buffer.from(JSON.stringify(normalizedManifest)));
  expectValidationFailure(
    "negative normalized metadata export case",
    () => verifyMetadata(withNormalizedExport),
    /must remain unexported/,
  );

  const withFixtureKey = new Map(packageFiles);
  withFixtureKey.set(
    "README.md",
    Buffer.concat([requirePackageFile(packageFiles, "README.md"), rules[0].secret]),
  );
  expectValidationFailure(
    "negative fixture-key case",
    () => verifyNoClassifiedSecrets(withFixtureKey, rules, "Package"),
    /contains fixture key/,
  );

  const withAhaSendApiKey = new Map(packageFiles);
  const ahaSendApiKey = ["aha", "-sk-", "A".repeat(64)].join("");
  withAhaSendApiKey.set(
    "README.md",
    Buffer.concat([
      requirePackageFile(packageFiles, "README.md"),
      Buffer.from(`\n${ahaSendApiKey}\n`),
    ]),
  );
  expectValidationFailure(
    "negative AhaSend API-key case",
    () => verifyNoClassifiedSecrets(withAhaSendApiKey, rules, "Package"),
    /unclassified secret signature/,
  );

  const withRegistryToken = new Map(packageFiles);
  const registryToken = ["//registry.npmjs.org/", ":", "_auth", "Token", "=", "legacy-token"].join(
    "",
  );
  withRegistryToken.set(
    "README.md",
    Buffer.concat([
      requirePackageFile(packageFiles, "README.md"),
      Buffer.from(`\n${registryToken}\n`),
    ]),
  );
  expectValidationFailure(
    "negative registry token case",
    () => verifyNoClassifiedSecrets(withRegistryToken, rules, "Package"),
    /unclassified secret signature/,
  );
}

function installTarball(directory, additionalPackages = []) {
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable === undefined ? "npm" : process.execPath;
  const args =
    npmExecutable === undefined
      ? [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--no-save",
          "--install-links",
          tarball,
          ...additionalPackages,
        ]
      : [
          npmExecutable,
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--no-save",
          "--install-links",
          tarball,
          ...additionalPackages,
        ];
  run(`install ${basename(tarball)}`, command, args, directory);
}

if (!tarballArgument && !process.env.SDK_TARBALL) {
  fail(
    "Usage: node scripts/verify-package.mjs <tarball> <sha256> (or set SDK_TARBALL and SDK_TARBALL_SHA256).",
  );
}
if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) {
  fail("A lowercase 64-character SDK_TARBALL_SHA256 checksum is required.");
}

try {
  if (!statSync(tarball).isFile()) fail(`SDK tarball is not a file: ${tarball}`);
} catch {
  fail(`SDK tarball does not exist: ${tarball}`);
}

const actualChecksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
if (!timingSafeEqual(Buffer.from(actualChecksum, "hex"), Buffer.from(expectedChecksum, "hex"))) {
  fail(`SDK tarball checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}.`);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "ahasend-sdk-package-verification-"));

try {
  console.log("\n> artifact boundary");
  const archiveEntries = listArchiveEntries();
  run(
    "extract package artifact",
    "tar",
    ["-xzf", tarball, "-C", temporaryRoot, "--no-same-owner", "--no-same-permissions"],
    repositoryRoot,
  );
  const packageFiles = collectFiles(resolve(temporaryRoot, "package"));
  if (
    archiveEntries.length !== packageFiles.size ||
    archiveEntries.some((path) => !packageFiles.has(path))
  ) {
    throw new TypeError("Extracted package files do not match the archive listing.");
  }
  const sourceFiles = trackedSourceFiles();
  const rules = await loadSecretRules(sourceFiles);
  verifyPackageContents(packageFiles);
  assertNoNodeSpecifiers(packageFiles);
  verifySourceMaps(packageFiles, sourceFiles);
  verifyMetadata(packageFiles);
  verifySourceSecrets(sourceFiles, rules);
  verifyNoClassifiedSecrets(packageFiles, rules, "Package");
  verifyNegativeCases(packageFiles, sourceFiles, rules);

  const publint = packageExecutable("publint", "publint");
  const attw = packageExecutable("@arethetypeswrong/cli", "attw");
  const apiExtractor = packageExecutable("@microsoft/api-extractor", "api-extractor");
  const compilers = [
    ["TypeScript 5.6", packageExecutable("typescript", "tsc")],
    ["current TypeScript", packageExecutable("typescript-current", "tsc")],
  ];

  run("publint", process.execPath, [publint, tarball, "--strict"], repositoryRoot);
  run(
    "Are The Types Wrong",
    process.execPath,
    [attw, tarball, "--profile", "node16", "--no-emoji", "--no-summary"],
    repositoryRoot,
  );

  for (const fixture of ["esm", "cjs"]) {
    const fixtureDirectory = resolve(temporaryRoot, fixture);
    cpSync(resolve(fixtureRoot, fixture), fixtureDirectory, { recursive: true });
    installTarball(fixtureDirectory);
    run(
      `${fixture.toUpperCase()} package consumer`,
      process.execPath,
      ["index.js"],
      fixtureDirectory,
    );
  }

  const typesDirectory = resolve(temporaryRoot, "types");
  cpSync(resolve(fixtureRoot, "types"), typesDirectory, { recursive: true });
  installTarball(typesDirectory, [
    dirname(packageJsonPath("@types/node")),
    dirname(packageJsonPath("undici-types")),
  ]);

  // The same declarations, type-checked by a consumer that has no @types/node
  // at all. The package declares no dependency on it, so the published
  // declarations must not name `Buffer`, `NodeJS.*`, or import a `node:`
  // module — none of which the fixture above can catch, since it installs
  // @types/node itself.
  //
  // Two fixtures, because the export map serves different declaration files to
  // each module system and a leak in one is invisible to the other. The ESM
  // fixture loads the `.d.ts` trio; the CommonJS one omits `"type": "module"`
  // so Node16/NodeNext take the `require` condition and load the `.d.cts`
  // trio, which nothing else in this pipeline reads — api-extractor is pointed
  // at the `.d.ts` pair and the cjs runtime fixture is plain JavaScript.
  // `bundler` resolution always takes the `import` condition, so it is not
  // repeated for the CommonJS fixture.
  const typesNoNodeDirectory = resolve(temporaryRoot, "types-no-node");
  cpSync(resolve(fixtureRoot, "types-no-node"), typesNoNodeDirectory, { recursive: true });
  installTarball(typesNoNodeDirectory);

  const typesNoNodeCjsDirectory = resolve(temporaryRoot, "types-no-node-cjs");
  cpSync(resolve(fixtureRoot, "types-no-node-cjs"), typesNoNodeCjsDirectory, { recursive: true });
  installTarball(typesNoNodeCjsDirectory);

  for (const [compilerName, compiler] of compilers) {
    for (const resolution of ["node16", "nodenext", "bundler"]) {
      run(
        `${compilerName} / ${resolution}`,
        process.execPath,
        [compiler, "--project", `tsconfig.${resolution}.json`, "--pretty", "false"],
        typesDirectory,
      );
      run(
        `${compilerName} / ${resolution} / no @types/node (esm, .d.ts)`,
        process.execPath,
        [compiler, "--project", `tsconfig.${resolution}.json`, "--pretty", "false"],
        typesNoNodeDirectory,
      );
      if (resolution === "bundler") continue;
      run(
        `${compilerName} / ${resolution} / no @types/node (cjs, .d.cts)`,
        process.execPath,
        [compiler, "--project", `tsconfig.${resolution}.json`, "--pretty", "false"],
        typesNoNodeCjsDirectory,
      );
    }
  }

  const packageDirectory = resolve(temporaryRoot, "package");
  for (const configName of ["api-extractor.json", "api-extractor.webhooks.json"]) {
    const config = createTarballApiExtractorConfig(configName, packageDirectory, temporaryRoot);
    run(
      `API Extractor / ${configName}`,
      process.execPath,
      [apiExtractor, "run", "--config", config],
      repositoryRoot,
    );
  }
  verifyNoClassifiedSecrets(reportFiles(trackedSourceFiles()), rules, "API report");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
