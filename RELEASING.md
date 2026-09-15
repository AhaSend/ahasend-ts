# Releasing `@ahasend/sdk`

This is the runbook for cutting a release. Everything here is derived from
`.github/workflows/release.yml` and `scripts/run-live-acceptance.mjs` — if those
change, change this file with them.

A release is triggered **only** by pushing a `v*` tag. There is no manual
dispatch and no "publish from my laptop" path: `prepublishOnly` runs the full
gate chain, and the workflow publishes bytes it packed and verified itself.

Releases are serialised by a `release` concurrency group with
`cancel-in-progress: false` — a second tag pushed while one is running will
queue, not cancel.

---

## One-time setup

You need four GitHub Actions **secrets** and three **environments**. Without
them the workflow fails partway through, after it has already published to the
`next` dist-tag or mutated the release account.

### Environments

| Environment    | Used by                                                      | Why it exists                                                      |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `live-release` | `live-gates`                                                 | Holds real account credentials and mutates the account. See below. |
| `npm-next`     | `next-publish`                                               | First publication, to the `next` tag only.                         |
| `npm-latest`   | `latest-promotion`, `github-release`, `release-compensation` | Moves `latest` and cuts the GitHub release. Gate this one hardest. |

Put a required-reviewer protection rule on `npm-latest` at minimum. `live-gates`
mutates a real account, so `live-release` deserves one too.

**What live-gates actually does.** It exercises all 62 operations against a real
account. It does **not** deliver mail: every send sets `sandbox: true`, and
`scripts/live-acceptance.mjs:964` refuses to run a request without it. Routes and
webhooks are created `enabled: false`. What it _does_ do to the real account: creates and deletes
domains, routes, webhooks, SMTP credentials, API keys, contacts, suppressions and
sub-accounts; updates the account settings (only the `about` text, which is
restored afterwards — `scripts/run-live-acceptance.mjs:515`); wipes all
suppressions for `suppressionDomain` (`methods.wipe({ domain })`); and adds then
removes a real account member. Treat it as destructive to the account, not as a
mail event.

The contact scenarios create two unique plus-addressed contacts under
`suppressionDomain`, update the first through both the single and batch APIs,
hard-delete it, and verify both contacts are absent during cleanup. They do not
add either contact to a list.

One caveat the repo cannot verify: adding an account member is a platform
action, so AhaSend itself may email an invitation to `disposableMailbox`. "Sends
no real mail" covers the messages API, which this repo controls — not that.

### Secrets

| Secret                     | Consumed by                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AHASEND_API_KEY`          | `live-gates` (release.yml:461)                                                                  | Needs **every** scope — live acceptance exercises all 62 operations, and a missing scope fails mid-run as a 403. The ones habitually left off a broad key: `contacts:read`, `contacts:write`, `contacts:delete`, `suppressions:wipe` (deliberately separate from `suppressions:delete`), the `sub-accounts:*` family (read/write/delete/suspend/usage), and `sub-account-api-keys:*` (read/write/delete). |
| `AHASEND_ACCOUNT_ID`       | `live-gates` (release.yml:462)                                                                  | The account the live scenarios run against.                                                                                                                                                                                                                                                                                                                                                               |
| `AHASEND_LIVE_CONFIG_JSON` | `live-gates` (release.yml:463)                                                                  | Schema below. Validated with **exact** key matching.                                                                                                                                                                                                                                                                                                                                                      |
| `NPM_TOKEN`                | `latest-promotion`, `github-release`, `release-compensation` (release.yml:881, 963, 1022, 1111) | Granular token with write access to `@ahasend/sdk`. Used only for `npm view`/`npm dist-tag` — publication itself is tokenless (see below).                                                                                                                                                                                                                                                                |

> **`next-publish` has no `NPM_TOKEN`.** It runs
> `npm publish --provenance` (release.yml:640) with `id-token: write`, which
> means it depends on **npm trusted publishing** being configured for
> `@ahasend/sdk` against this repository, `release.yml`, and the `npm-next`
> environment. That configuration exists on npmjs.com since v0.1.0 shipped
> (trusted publishing cannot be configured on a package that does not exist
> yet, so the first release carried a `NODE_AUTH_TOKEN` exception on the
> publish step; it has been removed). If the trusted-publisher entry is ever
> deleted, `next-publish` fails with an authentication error — restore the
> entry, or as a stopgap re-add
> `env: { NODE_AUTH_TOKEN: secrets.NPM_TOKEN }` to the publish step.

### `AHASEND_LIVE_CONFIG_JSON`

Exactly these eight keys — no more, no fewer
(`scripts/run-live-acceptance.mjs:39`):

```json
{
  "verifiedDomain": "mail.example.com",
  "replacementVerifiedDomain": "mail2.example.com",
  "neverRegisteredDomain": "never-registered.example.com",
  "dnslessDomain": "no-dns.example.com",
  "lifecycleDomain": "lifecycle.example.com",
  "suppressionDomain": "suppression.example.com",
  "disposableMailbox": "sdk-live@example.com",
  "webhookUrl": "https://webhook.example.com/ahasend"
}
```

Validation rules the script enforces:

- The **six domains** must be six _distinct_, non-empty domain names. No `@`,
  no commas. They are lowercased before use.
- `disposableMailbox` must contain `@`. It is **added as a `Developer`-role
  member of the release account** (`scripts/run-live-acceptance.mjs:516-519`) and
  removed in cleanup — so it must be an address you are willing to grant account
  access to, not a shared alias.
- `webhookUrl` must be **HTTPS**.

Account preconditions:

- `verifiedDomain` and `replacementVerifiedDomain` are real, DNS-verified
  sending domains on the account.
- `dnslessDomain` must **not** exist on the account. The run creates it
  (`scripts/live-acceptance.mjs:1190`), asserts it is DNS-invalid, checks that a
  send to it is rejected, and deletes it in cleanup. A copy left behind by a
  failed run must be removed before re-tagging.
- `neverRegisteredDomain` must not exist on the account at all.
- `lifecycleDomain` must **not** exist on the account either — the run creates
  it (`scripts/run-live-acceptance.mjs:351`), drives it through the full
  create/update/delete lifecycle, and uses it (as a bare FQDN — the API
  validates `website` as `format: fqdn`, not a URL) as the `website` of the
  disposable sub-account the sub-account scenarios create and delete
  (`scripts/run-live-acceptance.mjs:557`).
  Like `dnslessDomain`, a copy left behind by a cancelled run must be removed
  before re-tagging.
- `suppressionDomain` must **exist as a domain on the account** — the API
  refuses to create a suppression scoped to a domain it does not know
  (`invalid domain`, HTTP 400). DNS verification is not required: register the
  name on the account and leave it unverified. The run then has **every
  suppression deleted** for it (`deleteAllSuppressions` scoped to that
  domain), so keep it a dedicated throwaway — never a real sending domain
  whose suppression list matters.
- `disposableMailbox` must **not already be a member** of the release account.
  The run adds it and removes it again, but a partial run (or a local
  `release:live` during development) can leave the membership behind, and the
  member list exposes no email, so the suite cannot find a leftover on its
  own — the next `addAccountMember` then fails on the duplicate. Remove the
  member in the dashboard before re-running.
- `webhookUrl` must accept POSTs and return 2xx.

---

## Cutting a release

### 1. Before you tag

Install dependencies and run the core Node/package gate locally:

```bash
npm ci
npm run ci
```

That chain is `typecheck → lint → docs:check → test → verify:audit →
test:package:preflight`. It does not include the separately maintained workerd,
Deno, or Bun gates; run those with the commands under
[Local verification without a release](#local-verification-without-a-release).
If any required gate is not green locally, do not tag.

Then confirm:

- [ ] `package.json` `version`, `src/version.ts`, and the `CHANGELOG.md` heading
      all agree.
- [ ] `CHANGELOG.md` describes what actually ships.
- [ ] npm trusted publishing is configured for `@ahasend/sdk` (see above), or
      `next-publish` has been given a token.
- [ ] The core Node/package gate and the separate workerd, Deno, and Bun gates
      are green.
- [ ] The `AHASEND_LIVE_CONFIG_JSON` account preconditions still hold — domains
      get deleted and recreated by previous live runs.

### 2. Tag

```bash
git tag v0.2.1
git push origin v0.2.1
```

### 3. What runs, in order

| Job                    | Gate                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `source-gate`          | 13 source gates incl. `verify:audit` and the repository secret scan.            |
| `candidate`            | Builds and packs the candidate tarball; everything downstream uses those bytes. |
| `artifact-gates`       | Node 22, 24, 26 against the packed tarball. **All three block**, including 26.  |
| `runtime-workerd`      | Both maintained workerd compatibility dates against extracted candidate `dist`. |
| `runtime-deno`         | Deno 2.x smoke after installing the retained candidate tarball.                 |
| `runtime-bun`          | Bun smoke after installing the retained candidate tarball.                      |
| `live-gates`           | Real API acceptance in `live-release`. Mutates the account; sends no real mail. |
| `next-publish`         | `npm publish --tag next --provenance` of the retained bytes.                    |
| `registry-smoke`       | Installs from the registry and verifies provenance.                             |
| `latest-promotion`     | Only if `live-gates` **and** `registry-smoke` succeeded (release.yml:835).      |
| `github-release`       | Cuts the GitHub release.                                                        |
| `release-compensation` | Runs on failure after promotion to unwind `latest`.                             |

Node 22, 24, and 26 are maintained, blocking gates in both `ci.yml` and the
retained-candidate release matrix.

The workerd, Deno, and Bun jobs all download and verify the same retained
candidate and block `live-gates`. Their passed results are included in the
candidate-bound gate report that is validated before both publication and
promotion.

### 4. If it fails

- **Before `next-publish`** — nothing was published. Fix and re-tag (delete the
  tag first: `git tag -d v0.2.1 && git push origin :refs/tags/v0.2.1`).
- **After `next-publish`** — the version exists on npm under `next`. npm does
  not allow republishing a version, so the next attempt needs a new version
  number. Do not try to reuse it.
- **After `latest-promotion`** — `release-compensation` attempts to restore the
  previous `latest`. Verify it actually did: `npm dist-tag ls @ahasend/sdk`.
  Note that restoring `latest` on a _first_ release has nothing to restore to.
- **`live-gates` failure evidence** is uploaded as an artifact with
  `if-no-files-found: error` and retained for 30 days. Read it before re-running
  — the live scenarios mutate the account, so a partial run can leave domains in
  a state the next run's preconditions reject.

---

## Local verification without a release

These three core Node/package and release-policy commands take no arguments and
run to completion locally:

```bash
npm run ci                      # typecheck, lint, docs, tests, audit, packed-package preflight
npm run release:verify          # release-machinery tests
npm run test:package:preflight  # build, pack, then verify the tarball as a consumer would
```

`npm run ci` is the core gate to run before opening a pull request. The other
commands cover release-policy and focused packed-package checks.

Run the maintained workerd conformance gate separately:

```bash
npm run test:conformance:workerd
```

The maintained Deno and Bun gates test installed package bytes. Build and pack
one candidate, then pass that exact tarball to both commands (with Deno 2.x and
Bun installed):

```bash
npm run build
RUNTIME_SMOKE_DIR="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$RUNTIME_SMOKE_DIR"
CANDIDATE_TARBALL="$(find "$RUNTIME_SMOKE_DIR" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
test -n "$CANDIDATE_TARBALL"
npm run test:runtime:deno -- "$CANDIDATE_TARBALL"
npm run test:runtime:bun -- "$CANDIDATE_TARBALL"
```

Do not repack between the Deno and Bun commands: using the same candidate keeps
both results bound to the same package bytes, as the blocking CI gates require.

### The `release:*` artifact validators are not local commands

`release:source-gate`, `release:candidate` and `release:live` each **validate or
consume an artifact that the release workflow produced**. None of them runs the
gates its name suggests, and none of them works without arguments — invoking
them bare prints a usage line and exits non-zero:

```bash
node scripts/run-source-gates.mjs   <source-report.json> [source-report.sha256]
node scripts/create-candidate.mjs   <source-report.json> <output-directory> [source-report.sha256]
node scripts/run-live-acceptance.mjs <candidate-manifest.json> <candidate.tgz> <install-directory> <live-report.json> <live-report.sha256> [candidate-manifest.sha256]
```

In particular `release:source-gate` does **not** run the 13 source gates. It
checks that a report already contains a passing result for each of them, bound
to the current commit. The gates themselves run in the `source-gate` job of
`.github/workflows/release.yml`, which imports this script's helpers rather than
calling it as a command. To exercise the same checks locally, run `npm run ci`.

`npm run release:live` additionally needs the live credentials and mutates the
real account (creating and deleting domains, routes, webhooks, credentials and
an account member). Sends are sandboxed, but do not run it casually.

## What `npm publish` runs

`prepublishOnly` is the last gate before the registry, so it runs the full chain
rather than a subset: `clean`, `contracts:check`, `sdk:check`, `docs:check`,
`verify:audit`, `typecheck`, `lint`, `test`, and `test:package:preflight`. The
last of those packs the tarball and verifies it as a consumer would — including
the type-declaration fixtures that compile the published `.d.ts` and `.d.cts`
with no `@types/node` installed. It packs with `--ignore-scripts`, so it does
not re-enter this chain.

`clean` removes `dist/`; `contracts:check` rebuilds it (it invokes
`scripts/build.mjs` directly), so every later step sees a fresh build.
