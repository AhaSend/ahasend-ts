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

You need four GitHub Actions **secrets** and four **environments**. Without
them the workflow fails partway through, after it has already published to the
`next` dist-tag or sent real mail.

### Environments

| Environment    | Used by                                                     | Why it exists                                                     |
| -------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `live-release` | `live-gates`                                                | Holds the real AhaSend account credentials; sends real mail.       |
| `npm-next`     | `next-publish`                                              | First publication, to the `next` tag only.                        |
| `npm-latest`   | `latest-promotion`, `github-release`, `release-compensation` | Moves `latest` and cuts the GitHub release. Gate this one hardest. |

Put a required-reviewer protection rule on `npm-latest` at minimum. `live-gates`
mutates a real account, so `live-release` deserves one too.

### Secrets

| Secret                     | Consumed by                                      | Notes                                                            |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `AHASEND_API_KEY`          | `live-gates` (release.yml:317)                   | Needs broad scopes — live acceptance exercises all 56 operations. |
| `AHASEND_ACCOUNT_ID`       | `live-gates` (release.yml:318)                   | The account the live scenarios run against.                       |
| `AHASEND_LIVE_CONFIG_JSON` | `live-gates` (release.yml:319)                   | Schema below. Validated with **exact** key matching.              |
| `NPM_TOKEN`                | `latest-promotion`, `github-release`, `release-compensation` (release.yml:722, 788, 847, 927) | Publish rights on `@ahasend/sdk`.       |

> **`next-publish` deliberately has no `NPM_TOKEN`.** It runs
> `npm publish --provenance` (release.yml:481) with `id-token: write`, which
> means it depends on **npm trusted publishing** being configured for
> `@ahasend/sdk` against this repository and the `npm-next` environment.
>
> **Trusted publishing must be configured on a package that already exists in
> the registry.** For the very first publish of a new package name, confirm the
> npm-side configuration is in place before tagging — otherwise the job fails
> *after* `live-gates` has already sent real mail, and the live run has to be
> repeated. If the first publish cannot use trusted publishing, add
> `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to that step to match its
> four siblings.

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

- The **six domains** must be six *distinct*, non-empty domain names. No `@`,
  no commas. They are lowercased before use.
- `disposableMailbox` must contain `@` — it receives real mail.
- `webhookUrl` must be **HTTPS**.

Account preconditions:

- `verifiedDomain` and `replacementVerifiedDomain` are real, DNS-verified
  sending domains on the account.
- `dnslessDomain` is registered on the account but intentionally **not**
  DNS-valid — negative-path scenarios delete and re-check it.
- `neverRegisteredDomain` must not exist on the account at all.
- `lifecycleDomain` and `suppressionDomain` are consumed by create/delete
  lifecycle scenarios; do not point them at anything you care about.
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

| Job                    | Gate                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `source-gate`          | 13 source gates incl. `verify:audit` and the repository secret scan.              |
| `candidate`            | Builds and packs the candidate tarball; everything downstream uses those bytes.   |
| `artifact-gates`       | Node 22, 24, 26 against the packed tarball. **All three block**, including 26.    |
| `live-gates`           | Real API acceptance in `live-release`. Sends real mail.                           |
| `next-publish`         | `npm publish --tag next --provenance` of the retained bytes.                      |
| `registry-smoke`       | Installs from the registry and verifies provenance.                               |
| `latest-promotion`     | Only if `live-gates` **and** `registry-smoke` succeeded (release.yml:676).        |
| `github-release`       | Cuts the GitHub release.                                                          |
| `release-compensation` | Runs on failure after promotion to unwind `latest`.                               |

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
  Note that restoring `latest` on a *first* release has nothing to restore to.
- **`live-gates` failure evidence** is uploaded as an artifact with
  `if-no-files-found: error` and retained for 30 days. Read it before re-running
  — the live scenarios mutate the account, so a partial run can leave domains in
  a state the next run's preconditions reject.

---

## Local verification without a release

```bash
npm run release:source-gate   # the 13 source gates
npm run release:candidate     # build + pack a candidate locally
npm run release:verify        # release-machinery tests
```

`npm run release:live` needs the live credentials and will send real mail. Do
not run it casually.
