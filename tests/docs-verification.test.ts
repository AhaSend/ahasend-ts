import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NODE_CODE_SAMPLES } from "../scripts/node-code-samples.mjs";
import {
  INSTALLED_EXTERNAL_URLS,
  buildDocumentationIndex,
  loadDocumentation,
  verifyDocumentation,
  verifyDocumentationIndex,
  verifyInstalledDocumentation,
  verifyInstalledLinks,
  verifyPackagedJavaScript,
  verifySafeOutput,
} from "../scripts/verify-docs.mjs";

const repositoryRoot = process.cwd();
const packedSdkDirectory = mkdtempSync(join(tmpdir(), "ahasend-docs-verification-test-"));
let packedSdkTarball = "";
let packedSdkChecksum = "";

beforeAll(() => {
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable === undefined ? "npm" : process.execPath;
  const args = [
    ...(npmExecutable === undefined ? [] : [npmExecutable]),
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    packedSdkDirectory,
  ];
  const pack = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  expect(pack.status, `${pack.stdout}${pack.stderr}`).toBe(0);

  const tarballs = readdirSync(packedSdkDirectory).filter((name) => name.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  packedSdkTarball = resolve(packedSdkDirectory, tarballs[0]!);
  packedSdkChecksum = createHash("sha256").update(readFileSync(packedSdkTarball)).digest("hex");
});

afterAll(() => {
  rmSync(packedSdkDirectory, { recursive: true, force: true });
});

interface LinkReply {
  readonly status?: number;
  readonly location?: string;
  readonly hang?: boolean;
}

async function withLinkServer(
  replyFor: (target: URL, method: string) => LinkReply,
  assertion: (
    request: (
      url: URL,
      options: { readonly signal: AbortSignal },
    ) => Promise<{ status: number; location: string | null }>,
  ) => Promise<void>,
) {
  const server = createServer((request, response) => {
    const target = new URL(String(request.headers["x-installed-target"]));
    const reply = replyFor(target, request.method ?? "");
    if (reply.hang === true) return;
    response.statusCode = reply.status ?? 204;
    if (reply.location !== undefined) response.setHeader("location", reply.location);
    response.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  const request = async (url: URL, { signal }: { readonly signal: AbortSignal }) => {
    const response = await fetch(`http://127.0.0.1:${port}/installed-link`, {
      method: "GET",
      redirect: "manual",
      headers: { "x-installed-target": url.href },
      signal,
    });
    const result = { status: response.status, location: response.headers.get("location") };
    await response.body?.cancel();
    return result;
  };
  try {
    await assertion(request);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error === undefined ? resolveClose() : reject(error))),
    );
  }
}

function installedDocuments(urls: readonly string[], localLink = "") {
  return {
    "README.md": `${localLink}${urls.map((url) => `[target](${url})`).join("\n")}\n`,
    "CHANGELOG.md": "",
  };
}

describe("operational documentation verification", () => {
  it("verifies the committed guidance through the packed SDK", async () => {
    const documents = await loadDocumentation();

    expect(() => verifyDocumentation(documents)).not.toThrow();
    expect(INSTALLED_EXTERNAL_URLS).toHaveLength(17);

    await withLinkServer(
      (_target, method) => ({ status: method === "GET" ? 204 : 405 }),
      async (request) =>
        expect(
          verifyInstalledDocumentation(packedSdkTarball, packedSdkChecksum, repositoryRoot, {
            request,
          }),
        ).resolves.toBeUndefined(),
    );
  });

  it("requires local installed links to remain inside the package", async () => {
    const paths = new Set([
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "dist/index.js",
      "assets/logo.png",
    ]);
    await expect(
      verifyInstalledLinks(
        installedDocuments([], "[license](LICENSE)\n[dist](dist/)\n![logo](assets/logo.png)\n"),
        paths,
        { externalUrls: [] },
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyInstalledLinks(installedDocuments([], "[missing](docs/missing.md)\n"), paths, {
        externalUrls: [],
      }),
    ).rejects.toThrow(/unresolved installed link.*docs\/missing\.md/u);
    await expect(
      verifyInstalledLinks(installedDocuments([], "[outside](../README.md)\n"), paths, {
        externalUrls: [],
      }),
    ).rejects.toThrow(/unsafe installed link/u);
    await expect(
      verifyInstalledLinks(installedDocuments([], "![missing](assets/missing.png)\n"), paths, {
        externalUrls: [],
      }),
    ).rejects.toThrow(/unresolved installed link.*assets\/missing\.png/u);
  });

  it.each([
    [
      "reference-style links",
      "[target][reference]\n[reference]: https://ahasend.com/unregistered\n",
    ],
    ["URL autolinks", "<https://ahasend.com/unregistered>\n"],
    ["nested image links", "[![badge](LICENSE)](https://ahasend.com/unregistered)\n"],
    ["bare GFM URLs", "https://ahasend.com/unregistered\n"],
    ["HTML links", '<a href="https://ahasend.com/unregistered">target</a>\n'],
    [
      "multiline reference definitions",
      "[target][reference]\n\n[reference]:\n  https://ahasend.com/unregistered\n",
    ],
  ])("indexes installed %s", async (_label, source) => {
    await expect(
      verifyInstalledLinks(
        installedDocuments([], source),
        new Set(["README.md", "CHANGELOG.md", "LICENSE"]),
        { externalUrls: [] },
      ),
    ).rejects.toThrow(/unregistered external URL.*unregistered/u);
  });

  it("does not inventory URLs inside Markdown code or comments", async () => {
    const source = [
      "`https://ahasend.com/inline-code`",
      "<!-- https://ahasend.com/comment -->",
      "```text",
      "https://ahasend.com/fenced-code",
      "```",
    ].join("\n");
    await expect(
      verifyInstalledLinks(installedDocuments([], source), new Set(["README.md", "CHANGELOG.md"]), {
        externalUrls: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts the exact registered absolute repository target", async () => {
    // Repository links point at `main`, not a release tag: a tag link is dead
    // on the repository's landing page for the whole merge-to-tag window, no
    // offline gate can see that, and nothing binds a hand-typed tag to the
    // package version — a forgotten bump would ship working links to the
    // wrong release's docs. The unregistered case below is exactly such a
    // stray tag pin.
    const target = "https://github.com/AhaSend/ahasend-ts/blob/main/LICENSE";
    await withLinkServer(
      (_url, method) => ({ status: method === "GET" ? 200 : 405 }),
      async (request) =>
        expect(
          verifyInstalledLinks(
            installedDocuments([target]),
            new Set(["README.md", "CHANGELOG.md"]),
            {
              externalUrls: [target],
              request,
            },
          ),
        ).resolves.toBeUndefined(),
    );

    await expect(
      verifyInstalledLinks(
        installedDocuments(["https://github.com/AhaSend/ahasend-ts/blob/v0.1.0/LICENSE"]),
        new Set(["README.md", "CHANGELOG.md"]),
      ),
    ).rejects.toThrow(/unregistered external URL.*blob\/v0\.1\.0\/LICENSE/u);
  });

  it("allows two same-allowlist redirects before a final 2xx response", async () => {
    const target = "https://ahasend.com/redirect-0";
    await withLinkServer(
      (url) => {
        const redirect = Number(url.pathname.split("-").at(-1) ?? "0");
        return redirect < 2
          ? { status: 302, location: `https://ahasend.com/redirect-${redirect + 1}` }
          : { status: 204 };
      },
      async (request) =>
        expect(
          verifyInstalledLinks(
            installedDocuments([target]),
            new Set(["README.md", "CHANGELOG.md"]),
            {
              externalUrls: [target],
              request,
            },
          ),
        ).resolves.toBeUndefined(),
    );
  });

  it("rejects duplicate and drifted installed external URL inventories", async () => {
    const target = "https://ahasend.com/registered";
    await expect(
      verifyInstalledLinks(installedDocuments([target]), new Set(["README.md", "CHANGELOG.md"]), {
        externalUrls: [target, target],
      }),
    ).rejects.toThrow(/duplicate entry/u);
    await expect(
      verifyInstalledLinks(
        installedDocuments(["https://ahasend.com"]),
        new Set(["README.md", "CHANGELOG.md"]),
        { externalUrls: ["https://ahasend.com", "https://ahasend.com/"] },
      ),
    ).rejects.toThrow(/duplicate entry.*https:\/\/ahasend\.com\//u);
    await expect(
      verifyInstalledLinks(
        installedDocuments([target, "https://ahasend.com/unregistered"]),
        new Set(["README.md", "CHANGELOG.md"]),
        { externalUrls: [target] },
      ),
    ).rejects.toThrow(/unregistered external URL.*unregistered/u);
  });

  it.each([
    ["credentials", "https://user:password@ahasend.com/registered", /credentials/u],
    ["fragments", "https://ahasend.com/registered#section", /unverifiable fragment/u],
  ])("rejects external URL %s", async (_label, target, expected) => {
    await expect(
      verifyInstalledLinks(installedDocuments([target]), new Set(["README.md", "CHANGELOG.md"]), {
        externalUrls: [target],
      }),
    ).rejects.toThrow(expected);
  });

  it.each([
    ["non-2xx", () => ({ status: 503 }), /HTTP 503/u],
    [
      "excessive redirects",
      (target: URL) => ({
        status: 302,
        location: `https://ahasend.com/redirect-${Number(target.pathname.split("-").at(-1) ?? "0") + 1}`,
      }),
      /exceeded two redirects/u,
    ],
    [
      "cross-host redirects between authoritative hosts",
      () => ({ status: 302, location: "https://github.com/AhaSend/cross-host" }),
      /crossed hosts/u,
    ],
  ])("fails closed for installed-link %s", async (_label, replyFor, expected) => {
    const target = "https://ahasend.com/redirect-0";
    await withLinkServer(replyFor, async (request) =>
      expect(
        verifyInstalledLinks(installedDocuments([target]), new Set(["README.md", "CHANGELOG.md"]), {
          externalUrls: [target],
          request,
        }),
      ).rejects.toThrow(expected),
    );
  });

  it("aborts an installed-link request at the per-target timeout", async () => {
    const target = "https://ahasend.com/hang";
    await withLinkServer(
      () => ({ hang: true }),
      async (request) =>
        expect(
          verifyInstalledLinks(
            installedDocuments([target]),
            new Set(["README.md", "CHANGELOG.md"]),
            {
              externalUrls: [target],
              request,
              timeoutMs: 25,
            },
          ),
        ).rejects.toThrow(/timed out.*hang/u),
    );
  });

  it("bounds the total installed-link request count", async () => {
    const targets = ["https://ahasend.com/one", "https://ahasend.com/two"];
    await withLinkServer(
      () => ({ status: 200 }),
      async (request) =>
        expect(
          verifyInstalledLinks(
            installedDocuments(targets),
            new Set(["README.md", "CHANGELOG.md"]),
            {
              externalUrls: targets,
              request,
              requestCap: 1,
            },
          ),
        ).rejects.toThrow(/request cap exceeded.*two/u),
    );
  });

  it("detects checkout drift from the installed README and CHANGELOG bytes", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "ahasend-installed-docs-drift-"));
    try {
      writeFileSync(checkout + "/README.md", `${readFileSync("README.md", "utf8")}\nDrift\n`);
      writeFileSync(checkout + "/CHANGELOG.md", readFileSync("CHANGELOG.md", "utf8"));
      await expect(
        verifyInstalledDocumentation(packedSdkTarball, packedSdkChecksum, checkout, {
          request: async () => ({ status: 204 }),
        }),
      ).rejects.toThrow(/Installed README\.md differs from checkout documentation/u);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it.each([
    ["both artifact inputs", undefined, undefined],
    ["the checksum", packedSdkTarball, undefined],
    ["the tarball", undefined, packedSdkChecksum],
  ])("rejects verification without %s", (_label, tarball, checksum) => {
    const environment = { ...process.env };
    delete environment.SDK_TARBALL;
    delete environment.SDK_TARBALL_SHA256;
    if (tarball !== undefined) environment.SDK_TARBALL = tarball;
    if (checksum !== undefined) environment.SDK_TARBALL_SHA256 = checksum;
    const check = spawnSync(process.execPath, ["scripts/verify-docs.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });

    expect(check.stdout).toBe("");
    expect(check.stderr).toContain("Provide both SDK_TARBALL and SDK_TARBALL_SHA256.");
    expect(check.status).toBe(1);
  });

  it("keeps environment-backed preflight offline and retained-artifact checks online", () => {
    const networkGuard = resolve(packedSdkDirectory, "reject-network.mjs");
    writeFileSync(
      networkGuard,
      'globalThis.fetch = async () => { throw new Error("unexpected external request"); };\n',
    );
    const environment = {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(networkGuard).href}`.trim(),
      SDK_TARBALL: packedSdkTarball,
      SDK_TARBALL_SHA256: packedSdkChecksum,
    };

    const sourcePreflight = spawnSync(process.execPath, ["scripts/verify-docs.mjs"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
    });
    expect(sourcePreflight.status, `${sourcePreflight.stdout}${sourcePreflight.stderr}`).toBe(0);

    const retainedArtifact = spawnSync(
      process.execPath,
      ["scripts/verify-docs.mjs", packedSdkTarball, packedSdkChecksum],
      { cwd: repositoryRoot, encoding: "utf8", env: environment },
    );
    expect(retainedArtifact.stdout).toBe("");
    expect(retainedArtifact.stderr).toContain("Installed external URL request failed");
    expect(retainedArtifact.status).toBe(1);
    // Two full verify-docs spawns take ~14s on a fast machine; 20s left no
    // headroom on two-core CI runners under coverage instrumentation, where
    // this class of spawn-heavy test produced every flake the suite has had.
    // 120s matches the cap on the other spawn-heavy tests.
  }, 120_000);

  it(
    "strict-checks all 56 SDK samples against the packed declarations",
    { timeout: 120_000 },
    async () => {
      expect(Object.keys(NODE_CODE_SAMPLES)).toHaveLength(56);

      await expect(
        verifyPackagedJavaScript(packedSdkTarball, packedSdkChecksum),
      ).resolves.toBeUndefined();
    },
  );

  it(
    "rejects a packed sample that is outside the public facade declarations",
    { timeout: 120_000 },
    async () => {
      const pingSample = NODE_CODE_SAMPLES.ping;
      expect(pingSample).toBeDefined();
      const invalidSamples = {
        ...NODE_CODE_SAMPLES,
        ping: {
          ...pingSample!,
          source: pingSample!.source.replace("client.ping()", "client.notAnSdkMethod()"),
        },
      };

      await expect(
        verifyPackagedJavaScript(
          packedSdkTarball,
          packedSdkChecksum,
          repositoryRoot,
          invalidSamples,
        ),
      ).rejects.toThrow(/Property 'notAnSdkMethod' does not exist on type 'AhaSendClient'/u);
    },
  );

  it(
    "indexes and verifies commands, links, snippets, examples, samples, and profile counts",
    { timeout: 120_000 },
    async () => {
      const index = await buildDocumentationIndex();

      expect(index.commands.length).toBeGreaterThan(0);
      expect(index.links.length).toBeGreaterThan(0);
      expect(index.snippets.length).toBeGreaterThan(0);
      expect(index.examples.map(({ path }) => path)).toEqual(
        expect.arrayContaining([
          "examples/bootstrap-subaccount.mjs",
          "examples/next-webhook-route.mjs",
          "examples/update-api-key-ip-list.mjs",
          "examples/webhook-express.mjs",
        ]),
      );
      expect(index.supportingExamples.map(({ path }) => path)).toEqual([
        "examples/next-webhook-route/create-webhook-route.mjs",
      ]);
      expect(Object.keys(index.nodeSamples)).toHaveLength(56);
      expect(index.profileSummary).toEqual({ operations: 56, iterators: 9 });
      await expect(verifyDocumentationIndex(index)).resolves.toBeUndefined();
    },
  );

  it("rejects unguarded mutations and webhook handlers without durable ID deduplication", async () => {
    const index = await buildDocumentationIndex();
    const unsafeMutation = {
      ...structuredClone(index),
      examples: index.examples.map((example) =>
        example.path === "examples/update-api-key-ip-list.mjs"
          ? {
              ...example,
              source: example.source.replace(
                `if (process.env.AHASEND_ALLOW_MUTATIONS !== "1") {
  throw new Error("Refusing mutation; set AHASEND_ALLOW_MUTATIONS=1 after reviewing the script.");
}
`,
                '// process.env.AHASEND_ALLOW_MUTATIONS !== "1"\n',
              ),
            }
          : example,
      ),
    };
    await expect(verifyDocumentationIndex(unsafeMutation)).rejects.toThrow(/unguarded mutation/);

    const missingDeduplication = {
      ...structuredClone(index),
      examples: index.examples.map((example) =>
        example.path === "examples/webhook-express.mjs"
          ? {
              ...example,
              source: example.source.replace(
                `if (!accepted) {
      res.statusCode = 200;
      res.end();
      return;
    }`,
                `// enqueueOnce(webhookId, event)
    // if (!accepted) return;`,
              ),
            }
          : example,
      ),
    };
    await expect(verifyDocumentationIndex(missingDeduplication)).rejects.toThrow(
      /application-owned webhook-id deduplication/,
    );

    const missingNextDeduplication = {
      ...structuredClone(index),
      supportingExamples: index.supportingExamples.map((example) => ({
        ...example,
        source: example.source.replace(
          `if (!accepted) return new Response(null, { status: 200 });`,
          `return new Response(null, { status: accepted ? 202 : 200 });`,
        ),
      })),
    };
    await expect(verifyDocumentationIndex(missingNextDeduplication)).rejects.toThrow(
      /application-owned webhook-id deduplication/,
    );

    const unsupportedNextExport = {
      ...structuredClone(index),
      examples: index.examples.map((example) =>
        example.path === "examples/next-webhook-route.mjs"
          ? { ...example, source: `${example.source}\nexport function createWebhookRoute() {}\n` }
          : example,
      ),
    };
    await expect(verifyDocumentationIndex(unsupportedNextExport)).rejects.toThrow(
      /may export only POST and runtime/,
    );
  });

  it.each([
    ["removed", 'export const runtime = "edge"', ""],
    [
      "replaced with the obsolete Node runtime",
      'export const runtime = "edge"',
      'export const runtime = "nodejs"',
    ],
    [
      "replaced with the obsolete Node runtime while the Edge declaration remains in a comment",
      'export const runtime = "edge"',
      '// export const runtime = "edge"\nexport const runtime = "nodejs"',
    ],
  ])(
    "rejects the Next Edge runtime selection when it is %s",
    async (_label, current, replacement) => {
      const index = await buildDocumentationIndex();
      const mutatedRuntime = {
        ...structuredClone(index),
        examples: index.examples.map((example) =>
          example.path === "examples/next-webhook-route.mjs"
            ? { ...example, source: example.source.replace(current, replacement) }
            : example,
        ),
      };

      await expect(verifyDocumentationIndex(mutatedRuntime)).rejects.toThrow(
        /must select the Edge runtime explicitly/,
      );
    },
  );

  it("rejects sensitive values in multiline console output", async () => {
    const index = await buildDocumentationIndex();
    const unsafeOutput = {
      ...structuredClone(index),
      examples: index.examples.map((example) =>
        example.path === "examples/bootstrap-subaccount.mjs"
          ? {
              ...example,
              source: example.source.replace(
                "console.log(`✓ created child account id=${subAccount.id}; stored its one-time key`);",
                `console.log({
  secret: key.secret_key,
});`,
              ),
            }
          : example,
      ),
    };

    await expect(verifyDocumentationIndex(unsafeOutput)).rejects.toThrow(
      /unsafe secret or payload output/,
    );
  });

  it("enforces the strict output allowlist across top-level examples", async () => {
    const index = await buildDocumentationIndex();
    const unsafeOutput = {
      ...structuredClone(index),
      examples: index.examples.map((example) =>
        example.path === "examples/ping.mjs"
          ? { ...example, source: `${example.source}\nconsole.log(response);\n` }
          : example,
      ),
    };

    await expect(verifyDocumentationIndex(unsafeOutput)).rejects.toThrow(
      /examples\/ping\.mjs contains unsafe secret or payload output/,
    );
  });

  it("enforces the strict output allowlist across README snippets", async () => {
    const index = await buildDocumentationIndex();
    const unsafeOutput = {
      ...structuredClone(index),
      snippets: index.snippets.map((snippet) =>
        snippet.path === "README.md" && snippet.source.includes("client.messages.send")
          ? { ...snippet, source: `${snippet.source}\nconsole.log(err.message);\n` }
          : snippet,
      ),
    };

    await expect(verifyDocumentationIndex(unsafeOutput)).rejects.toThrow(
      /README\.md:\d+ contains unsafe secret or payload output/,
    );
  });

  it.each([
    ["whole objects", "console.log(response);"],
    ["nested values", "console.log(response.data);"],
    ["nested objects", "console.log({ request: { status: err.status } });"],
    ["arrays", "console.log([response.id]);"],
    [
      "aliases",
      `const recipient = event.data.recipient;
const output = recipient;
console.log(output);`,
    ],
    [
      "reassigned aliases",
      `let output = err.status;
output = err.message;
logger.error(output);`,
    ],
    [
      "shadowed aliases",
      `const output = err.message;
{
  const output = err.status;
}
logger.error(output);`,
    ],
    [
      "relabeled object properties",
      `const safe = { requestId: err.message };
logger.error(safe.requestId);`,
    ],
    [
      "reassigned object properties",
      `const safe = { requestId: err.requestId };
safe.requestId = err.message;
logger.error(safe.requestId);`,
    ],
    [
      "reassigned object properties through aliases",
      `const safe = { requestId: err.requestId };
const alias = safe;
alias.requestId = err.message;
logger.error(safe.requestId);`,
    ],
    [
      "reassigned destructured aliases",
      `let { status: output } = err;
output = err.message;
logger.error(output);`,
    ],
    [
      "destructuring assignment aliases",
      `let output = err.status;
({ message: output } = err);
logger.error(output);`,
    ],
    [
      "object-rest aliases",
      `const { ...requestId } = err;
logger.error(requestId);`,
    ],
    [
      "function-scoped var aliases",
      `function logError(err) {
  var output = err.status;
  {
    var output = err.message;
  }
  logger.error(output);
}`,
    ],
    [
      "source-scoped var aliases",
      `var output = err.status;
{
  var output = err.message;
}
logger.error(output);`,
    ],
    [
      "nested object replacements",
      `const safe = { nested: { requestId: err.requestId } };
safe.nested = { requestId: err.message };
logger.error(safe.nested.requestId);`,
    ],
    [
      "nested object mutations through aliases",
      `const safe = { nested: { requestId: err.requestId } };
const nested = safe.nested;
nested.requestId = err.message;
logger.error(safe.nested.requestId);`,
    ],
    [
      "nested-object-held aliases",
      `const safe = { requestId: err.requestId };
const aliases = { nested: { safe } };
aliases.nested.safe.requestId = err.message;
logger.error(safe.requestId);`,
    ],
    [
      "array-held aliases",
      `const safe = { requestId: err.requestId };
const aliases = [safe];
aliases[0].requestId = err.message;
logger.error(safe.requestId);`,
    ],
    [
      "computed aliases",
      `const safe = { requestId: err.requestId };
const aliasName = "safe";
const aliases = { [aliasName]: safe };
aliases[aliasName].requestId = err.message;
logger.error(safe.requestId);`,
    ],
    [
      "computed property writes through aliases",
      `const safe = { requestId: err.requestId };
const alias = safe;
const propertyName = "requestId";
alias[propertyName] = err.message;
logger.error(safe.requestId);`,
    ],
    [
      "writes in later-declared invoked functions",
      `const safe = { requestId: err.requestId };
const alias = safe;
overwrite();
logger.error(safe.requestId);

function overwrite() {
  alias.requestId = err.message;
}`,
    ],
    [
      "reassignments in later-declared invoked functions",
      `let output = err.status;
overwrite();
logger.error(output);

function overwrite() {
  output = err.message;
}`,
    ],
    ["template literals", "console.log(`recipient: ${event.data.recipient}`);"],
    ["error messages", "logger.error(err.message);"],
    [
      "computed element-access aliases",
      `const requestId = "message";
logger.error(err[requestId]);`,
    ],
    [
      "error messages on callback parameters",
      `function onError(err) {
  logger.error(err.message);
}`,
    ],
    [
      "allowlist-named catch bindings",
      `try {
  runRequest();
} catch (requestId) {
  logger.error(requestId);
}`,
    ],
    ["computed object keys", "logger.error({ [err.message]: err.status });"],
  ])("rejects unsafe output through %s", (_label, source) => {
    expect(() => verifySafeOutput("unsafe-output-fixture.mjs", source)).toThrow(
      /unsafe secret or payload output/,
    );
  });

  it("accepts only selected allowlisted SDK output", () => {
    expect(() =>
      verifySafeOutput(
        "safe-output-fixture.mjs",
        `console.log({
  count: response.data.length,
  messageId: response.data[0]?.id,
  status: err.status,
  errorCode: err.code,
  requestId: err.requestId,
});`,
      ),
    ).not.toThrow();

    expect(() =>
      verifySafeOutput(
        "safe-callback-output-fixture.mjs",
        `function onResponse(event) {
  logger.info({
    status: event.status,
    requestId: event.requestId,
  });
}

try {
  runRequest();
} catch (err) {
  logger.error({
    status: err.status,
    errorCode: err.code,
    requestId: err.requestId,
  });
}`,
      ),
    ).not.toThrow();

    expect(() =>
      verifySafeOutput(
        "safe-block-scoped-output-fixture.mjs",
        `var output = err.status;
{
  const output = err.message;
}
logger.error(output);`,
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "missing",
      (source: string) =>
        source.replace(
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n",
          "",
        ),
    ],
    [
      "duplicate",
      (source: string) =>
        source.replace(
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n",
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n| `statistics.mjs`             | Duplicate fixture                                                                                                 |\n",
        ),
    ],
    [
      "orphan",
      (source: string) =>
        source.replace(
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n",
          "| `statistics.mjs`             | Read-only deliverability statistics                                                                               |\n| `not-an-example.mjs`         | Orphan fixture                                                                                                    |\n",
        ),
    ],
  ])("rejects a %s advertised example inventory entry", async (kind, mutate) => {
    const index = await buildDocumentationIndex();
    const invalidInventory = {
      ...structuredClone(index),
      documents: {
        ...index.documents,
        "examples/README.md": mutate(index.documents["examples/README.md"]!),
      },
    };

    await expect(verifyDocumentationIndex(invalidInventory)).rejects.toThrow(
      new RegExp(`advertised example inventory.*${kind}`, "u"),
    );
  });

  it("rejects TypeScript snippets that import a missing SDK export", async () => {
    const index = await buildDocumentationIndex();
    const invalidImport = {
      ...structuredClone(index),
      snippets: index.snippets.map((snippet) =>
        snippet.path === "README.md" && snippet.source.includes("import { AhaSendClient }")
          ? {
              ...snippet,
              source: snippet.source.replace(
                "import { AhaSendClient }",
                "import { DefinitelyNotAnSdkExport }",
              ),
            }
          : snippet,
      ),
    };

    await expect(verifyDocumentationIndex(invalidImport)).rejects.toThrow(
      /imports missing @ahasend\/sdk export DefinitelyNotAnSdkExport/,
    );
  });

  it.each([
    [
      "webhook-id deduplication responsibility",
      "Applications must deduplicate the `webhook-id` value.",
    ],
    ["timestamp-window distinction", "Timestamp-window verification is not replay deduplication."],
    [
      "atomic duplicate integration pattern",
      "Record the ID atomically after signature verification and before performing side effects, in the\nsame transaction as durable processing work.",
    ],
    [
      "Express adapter-owned raw stream",
      "mounts `expressWebhookHandler` directly so the adapter reads the bounded raw\nstream and owns the empty 413 response",
    ],
    [
      "transactional durable enqueue contract",
      "must commit both the unique `webhook-id` record and a\ndurable work/outbox record",
    ],
    [
      "webhook-id durable enqueue integration code",
      "const accepted = await webhookDeliveries.enqueueOnce(webhookId, event);",
    ],
    [
      "duplicate webhook early-return integration code",
      `if (!accepted) {
      res.statusCode = 200;
      res.end();
      return;
    }`,
    ],
    [
      "durable worker retry behavior",
      "A worker\nfailure then leaves retryable work instead of turning the sender's next delivery into a false\nsuccess.",
    ],
  ])("fails if the %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "docs/security-and-webhooks.md";
    documents[path] = documents[path]!.replace(requiredText, "");

    expect(() => verifyDocumentation(documents)).toThrow(/required guidance/);
  });

  it.each([
    ["README Express parser", "README.md", '  express.raw({ type: "*/*" }),\n'],
    [
      "security-guide Express parser",
      "docs/security-and-webhooks.md",
      '  express.raw({ type: "*/*", limit: "1mb" }),\n',
    ],
    [
      "claim-only webhook deduplication",
      "docs/security-and-webhooks.md",
      "    await webhookDeliveries.claim(webhookId);\n",
    ],
    [
      "full SDK error exception telemetry",
      "README.md",
      "    onError: (e) => sentry.captureException(e.error),\n",
    ],
    [
      "webhook recipient console output",
      "README.md",
      "        console.log(`delivered → ${event.data.recipient}`);\n",
    ],
  ])("fails if the %s pattern is introduced", async (_label, path, unsafeText) => {
    const documents = await loadDocumentation();
    documents[path] = `${documents[path]}\n${unsafeText}`;

    expect(() => verifyDocumentation(documents)).toThrow(/unsafe guidance/);
  });

  it.each([
    ["Node.js maintained versions", "Node.js 22, 24, and 26."],
    ["Deno maintained version", "Deno latest 2.x."],
    ["Bun maintained version", "Bun latest."],
    ["workerd compatibility mode", "Cloudflare workerd without `nodejs_compat`."],
    ["Vercel Edge conformance runtime", "Vercel Edge through `@edge-runtime/vm`."],
    ["browser refusal", "Browser and browser Service Worker use is refused by default."],
    ["browser escape hatch", "`dangerouslyAllowBrowser: true` escape hatch"],
    ["Workers environment binding", "const client = AhaSendClient.fromEnv(env);"],
    [
      "awaited direct webhook verification",
      "await verifier.verify(headersRecordOrHeaders, rawBodyStringOrBuffer);",
    ],
    [
      "awaited direct webhook parsing",
      "const event = await verifier.parse(headersRecordOrHeaders, rawBodyStringOrBuffer);",
    ],
    [
      "existing web-standard Request adapter",
      "`nextRouteHandler` export is the web-standard `Request` adapter",
    ],
    ["fixed webhook body ceiling", "fixed 30,000,000-byte webhook body ceiling"],
    ["lower webhook deployment cap", "`maxBodyBytes` is only a lower deployment cap"],
    [
      "idempotent-operation inventory",
      "all 11 endpoints whose generated operation profile marks them idempotent",
    ],
    ["parsed webhook body behavior", "The adapters treat an already-parsed body as a setup error"],
    [
      "allow-listed error telemetry",
      'errorCode: isAhaSendError(e.error) ? e.error.code : "unknown"',
    ],
    ["webhook metric without recipient data", 'metrics.increment("ahasend.webhook.delivered");'],
  ])("fails if the README %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "README.md";
    documents[path] = documents[path]!.replace(requiredText, "");

    expect(() => verifyDocumentation(documents)).toThrow(/required guidance/);
  });

  it.each([
    [
      "awaited direct webhook verification",
      "await verifier.verify(headersRecordOrHeaders, rawBodyStringOrBuffer);",
    ],
    [
      "awaited direct webhook parsing",
      "const event = await verifier.parse(headersRecordOrHeaders, rawBodyStringOrBuffer);",
    ],
    [
      "existing web-standard Request adapter",
      "`nextRouteHandler` is the existing web-standard `Request` adapter.",
    ],
    ["fixed webhook body ceiling", "fixed 30,000,000-byte body ceiling"],
    ["lower webhook deployment cap", "is only a lower deployment cap"],
  ])("fails if the security guide %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "docs/security-and-webhooks.md";
    documents[path] = documents[path]!.replace(requiredText, "");

    expect(() => verifyDocumentation(documents)).toThrow(/required guidance/);
  });

  it.each([
    [
      "client-and-isolate scope",
      "Limiter state is scoped to one `AhaSendClient` instance in one JavaScript isolate.",
    ],
    [
      "clamped-clock zero-duration telemetry",
      "on runtimes that clamp it between I/O turns, a\nCPU-only pacing duration may validly be zero.",
    ],
    [
      "monotonic clock and workerd progress",
      "Token refill uses the\nmonotonic high-resolution clock and deliberately ignores the adjustable wall clock, so an NTP or\nhost-clock correction cannot pin queued calls at a future timestamp. The blocking workerd\nconformance burst verifies that timer-driven pacing drains without a wall-clock fallback.",
    ],
    [
      "authoritative cross-isolate server 429 handling",
      "Server HTTP 429 handling is authoritative across isolates:",
    ],
  ])("fails if the rate-pacing %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "docs/rate-pacing.md";
    documents[path] = documents[path]!.replace(requiredText, "");

    expect(() => verifyDocumentation(documents)).toThrow(/required guidance/);
  });

  it.each([
    ["Node-only", "README.md", "This is a server-side SDK for Node.js."],
    ["Node runtime requirement", "README.md", "The SDK requires Node.js 22 or later."],
    ["Node-only inverse", "README.md", "This SDK supports Node.js only."],
    ["Node-only adjective", "README.md", "This is a Node.js-only SDK."],
    [
      "Node-only security guide",
      "docs/security-and-webhooks.md",
      "This SDK supports Node.js only.",
    ],
    ["edge-unsupported", "README.md", "Cloudflare and Vercel Edge runtimes are not supported."],
    ["edge-unsupported inverse", "README.md", "This SDK does not support edge runtimes."],
    [
      "edge-unsupported inverse security guide",
      "docs/security-and-webhooks.md",
      "This SDK does not support edge runtimes.",
    ],
    [
      "alternative-runtime unsupported",
      "README.md",
      "Alternative JavaScript runtimes are not supported.",
    ],
  ])("fails if an obsolete %s claim is introduced", async (_label, path, obsoleteText) => {
    const documents = await loadDocumentation();
    documents[path] = `${documents[path]}\n${obsoleteText}\n`;

    expect(() => verifyDocumentation(documents)).toThrow(/unsafe guidance/);
  });

  it.each([
    ["Node-only README", "README.md", "This is a server-side SDK for\nNode.js."],
    ["Node-only inverse README", "README.md", "This SDK supports Node.js\nonly."],
    [
      "Node-only inverse security guide",
      "docs/security-and-webhooks.md",
      "This SDK supports Node.js\nonly.",
    ],
    [
      "edge-unsupported README",
      "README.md",
      "Cloudflare and Vercel Edge runtimes are\nnot supported.",
    ],
    [
      "alternative-runtime unsupported README",
      "README.md",
      "Alternative JavaScript runtimes are\nnot supported.",
    ],
    [
      "edge-unsupported security guide",
      "docs/security-and-webhooks.md",
      "Cloudflare and Vercel Edge runtimes are\nnot supported.",
    ],
    ["edge-unsupported inverse README", "README.md", "This SDK does not support\nedge runtimes."],
    [
      "edge-unsupported inverse security guide",
      "docs/security-and-webhooks.md",
      "This SDK does not support\nedge runtimes.",
    ],
  ])(
    "fails if a line-wrapped obsolete %s claim is introduced",
    async (_label, path, obsoleteText) => {
      const documents = await loadDocumentation();
      documents[path] = `${documents[path]}\n${obsoleteText}\n`;

      expect(() => verifyDocumentation(documents)).toThrow(/unsafe guidance/);
    },
  );

  it.each([
    ["operation-level retry gate", "`maxRetries` never overrides the operation-level gate"],
    ["default first-retry jitter range", "the first retry waits from 500 to 1,000 milliseconds"],
  ])("fails if the %s is removed", async (_label, requiredText) => {
    const documents = await loadDocumentation();
    const path = "docs/retries-and-idempotency.md";
    documents[path] = documents[path]!.replace(requiredText, "");

    expect(() => verifyDocumentation(documents)).toThrow(/required guidance/);
  });
});
