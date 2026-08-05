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

**What live-gates actually does.** It exercises all 56 operations against a real
account. It does **not** deliver mail: every send sets `sandbox: true`, and
`scripts/live-acceptance.mjs:964` refuses to run a request without it. Routes and
webhooks are created `enabled: false`. What it _does_ do to the real account: creates and deletes
domains, routes, webhooks, SMTP credentials, API keys, suppressions and
sub-accounts; updates the account settings (only the `about` text, which is
restored afterwards — `scripts/run-live-acceptance.mjs:515`); wipes all
suppressions for `suppressionDomain` (`methods.wipe({ domain })`); and adds then
removes a real account member. Treat it as destructive to the account, not as a
mail event.

One caveat the repo cannot verify: adding an account member is a platform
action, so AhaSend itself may email an invitation to `disposableMailbox`. "Sends
no real mail" covers the messages API, which this repo controls — not that.

### Secrets

| Secret                     | Consumed by                                                                                                                                        | Notes                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `AHASEND_API_KEY`          | `live-gates` (release.yml:317)                                                                                                                     | Needs broad scopes — live acceptance exercises all 56 operations. |
| `AHASEND_ACCOUNT_ID`       | `live-gates` (release.yml:318)                                                                                                                     | The account the live scenarios run against.                       |
| `AHASEND_LIVE_CONFIG_JSON` | `live-gates` (release.yml:319)                                                                                                                     | Schema below. Validated with **exact** key matching.              |
| `NPM_TOKEN`                | `next-publish` (first release only, see below), `latest-promotion`, `github-release`, `release-compensation` (release.yml:480, 724, 803, 862, 951) | Publish rights on `@ahasend/sdk`.                                 |

> **`next-publish` normally has no `NPM_TOKEN`.** It runs
> `npm publish --provenance` (release.yml:483) with `id-token: write`, which
> means it depends on **npm trusted publishing** being configured for
> `@ahasend/sdk` against this repository and the `npm-next` environment.
>
> **Trusted publishing must be configured on a package that already exists in
> the registry**, which a first release cannot satisfy — so the step currently
> carries `NODE_AUTH_TOKEN` (release.yml:480) as a first-release exception.
> After v0.1.0 is published: configure trusted publishing on npmjs.com
> (`@ahasend/sdk` → Settings → Trusted publisher: this repository,
> `release.yml`, environment `npm-next`), then remove that `env` block so
> publication returns to the tokenless path.

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
  create/update/delete lifecycle, and uses `https://<lifecycleDomain>` as the
  `website` of the disposable sub-account the sub-account scenarios create and
  delete (`scripts/run-live-acceptance.mjs:557`).
  Like `dnslessDomain`, a copy left behind by a cancelled run must be removed
  before re-tagging.
- `suppressionDomain` has **every suppression deleted** for it
  (`deleteAllSuppressions` scoped to that domain). Never point it at a real
  sending domain whose suppression list matters.
- `webhookUrl` must accept POSTs and return 2xx.

---

## Cutting a release

### 1. Before you tag

Run the same gates CI will run, locally:

```bash
npm ci
npm run ci
```

That chain is `typecheck → lint → docs:check → test → verify:audit →
test:package:preflight`. If it is not green locally it will not be green on the
tag.

Then confirm:

- [ ] `package.json` `version`, `src/version.ts`, and the `CHANGELOG.md` heading
      all agree.
- [ ] `CHANGELOG.md` describes what actually ships.
- [ ] npm trusted publishing is configured for `@ahasend/sdk` (see above), or
      `next-publish` has been given a token.
- [ ] The `AHASEND_LIVE_CONFIG_JSON` account preconditions still hold — domains
      get deleted and recreated by previous live runs.

### 2. Tag

```bash
git tag v0.1.0
git push origin v0.1.0
```

### 3. What runs, in order

| Job                    | Gate                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `source-gate`          | 13 source gates incl. `verify:audit` and the repository secret scan.            |
| `candidate`            | Builds and packs the candidate tarball; everything downstream uses those bytes. |
| `artifact-gates`       | Node 22, 24, 26 against the packed tarball. **All three block**, including 26.  |
| `live-gates`           | Real API acceptance in `live-release`. Mutates the account; sends no real mail. |
| `next-publish`         | `npm publish --tag next --provenance` of the retained bytes.                    |
| `registry-smoke`       | Installs from the registry and verifies provenance.                             |
| `latest-promotion`     | Only if `live-gates` **and** `registry-smoke` succeeded (release.yml:678).      |
| `github-release`       | Cuts the GitHub release.                                                        |
| `release-compensation` | Runs on failure after promotion to unwind `latest`.                             |

Note that **Node 26 blocks the release** here but is `continue-on-error` in
`ci.yml`, so a Node 26 break is invisible until you tag.

### 4. If it fails

- **Before `next-publish`** — nothing was published. Fix and re-tag (delete the
  tag first: `git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0`).
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

These three take no arguments and run to completion locally:

```bash
npm run ci                      # typecheck, lint, docs, tests, audit, packed-package preflight
npm run release:verify          # release-machinery tests
npm run test:package:preflight  # build, pack, then verify the tarball as a consumer would
```

`npm run ci` is the one to run before opening a pull request. It is a superset
of the other two.

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
