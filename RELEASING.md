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

**What live-gates actually does.** The live report needs a passed result for all
75 operations, and live acceptance exercises every one of them against a real
account. It does **not** deliver mail: every send
sets `sandbox: true`, and `requireSandboxMessageRequest` in
`scripts/live-acceptance.mjs` refuses to run a request without it. Routes and
webhooks are created `enabled: false`. What it _does_ do to the real account: creates and deletes
domains, routes, webhooks, SMTP credentials, API keys, contacts, lists, suppressions and
sub-accounts; updates the account settings (only the `about` text, which is
restored afterwards — the `createAccountScenarioRegistry` call in
`scripts/run-live-acceptance.mjs`); wipes all
suppressions for `suppressionDomain` (`methods.wipe({ domain })`); and adds then
removes a real account member. Treat it as destructive to the account, not as a
mail event.

The domain scenarios list the account's domains with the `sending_type:
"transactional"` filter and require every one returned to be transactional.
They create `lifecycleDomain` without a `sending_type` and require it to come
back `transactional` and not paused, with null `paused_at` and `pause_reason`,
then update it to `marketing` and require that back. The sub-account scenarios, after resuming the
disposable child, unpause `neverRegisteredDomain` on it: the child owns no
domain, so the API must answer 404 with its own `domain not found` message.
That message, not the bare status, shows the server has the route; an API
without it answers 404 too, with a different body. No domain of the child is
paused or unpaused, so the run changes nothing there.

The run therefore needs a server that has the marketing-sending domain fields,
the unpause route, the template send route, the template default sender and
the message `template_id`:
deploy the API before tagging a release that includes them, or live-gates fails
on `getDomains`, `createDomain`, `unpauseSubAccountDomain`, `listTemplates`,
`getTemplate`, `createTemplateMessage`, `getMessages` and `getMessage`.

The API cannot create a template, so the template scenarios use the one named
by `templateId` (see the account preconditions below). They walk the template
listing through the iterator until it reaches that template, read it and check
the fields the spec gives, including its default sender (`from`) and
`reply_to`. They then send it twice with `messages.sendTemplate()` and
`sandbox: true` to `disposableMailbox`: once from `verifiedDomain`, and once
without `from`, so the API sends from the template's default sender. A variable
the template marks `required` gets the placeholder value
`AhaSend SDK live acceptance` in the recipient's `substitutions`; a template
that requires none is sent with no `substitutions`.

The message scenarios check that every message they read carries
`template_id`, and that the inline message they sent reads back with
`template_id: null`.

The contact scenarios create two unique plus-addressed contacts under
`suppressionDomain`, update the first through both the single and batch APIs,
hard-delete it, and verify both contacts are absent during cleanup. They do not
add either contact to a list.

The list scenarios create two uniquely named lists and two plus-addressed
contacts under `suppressionDomain`. The second list, and the first contact's
membership of it, exist so the list listing, the member listing and the
contact's lists each span two pages at `limit: 1`, which makes every list
iterator follow a cursor. They add the first contact with a single
upsert and unsubscribe it, then batch-add it again beside the second contact and
an address no contact holds, which must report `already_member` (with the
unsubscribe kept), `added`, and `not_found`. They read the members with
`include_contacts: true`, read the first contact's lists, remove the second
contact from the list twice (the repeat must answer 404), and delete the first
list. Cleanup deletes both contacts and finds both lists by name, so a list
whose create response was lost is still removed. A `complained` membership cannot be produced
on demand, so its 409 is not exercised live.

One caveat the repo cannot verify: adding an account member is a platform
action, so AhaSend itself may email an invitation to `disposableMailbox`. "Sends
no real mail" covers the messages API, which this repo controls — not that.

### Secrets

| Secret                     | Consumed by                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AHASEND_API_KEY`          | `live-gates` (release.yml:461)                                                                  | Needs **every** scope — live acceptance exercises every operation that has a scenario, and a missing scope fails mid-run as a 403. The ones habitually left off a broad key: `contacts:read`, `contacts:write`, `contacts:delete`, `lists:read`, `lists:write`, `lists:delete`, `templates:read`, `suppressions:wipe` (deliberately separate from `suppressions:delete`), the `sub-accounts:*` family (read/write/delete/suspend/usage), and `sub-account-api-keys:*` (read/write/delete). |
| `AHASEND_ACCOUNT_ID`       | `live-gates` (release.yml:462)                                                                  | The account the live scenarios run against.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AHASEND_LIVE_CONFIG_JSON` | `live-gates` (release.yml:463)                                                                  | Schema below. Validated with **exact** key matching.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `NPM_TOKEN`                | `latest-promotion`, `github-release`, `release-compensation` (release.yml:881, 963, 1022, 1111) | Granular token with write access to `@ahasend/sdk`. Used only for `npm view`/`npm dist-tag` — publication itself is tokenless (see below).                                                                                                                                                                                                                                                                                                                                                 |

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

Exactly these nine keys — no more, no fewer
(`configKeys` in `scripts/run-live-acceptance.mjs`):

```json
{
  "verifiedDomain": "mail.example.com",
  "replacementVerifiedDomain": "mail2.example.com",
  "neverRegisteredDomain": "never-registered.example.com",
  "dnslessDomain": "no-dns.example.com",
  "lifecycleDomain": "lifecycle.example.com",
  "suppressionDomain": "suppression.example.com",
  "disposableMailbox": "sdk-live@example.com",
  "templateId": "00000000-0000-4000-8000-000000000000",
  "webhookUrl": "https://webhook.example.com/ahasend"
}
```

Validation rules the script enforces:

- The **six domains** must be six _distinct_, non-empty domain names. No `@`,
  no commas. They are lowercased before use.
- `disposableMailbox` must contain `@`. It is **added as a `Developer`-role
  member of the release account** (the `createAccountScenarioRegistry` call in
  `scripts/run-live-acceptance.mjs`) and
  removed in cleanup — so it must be an address you are willing to grant account
  access to, not a shared alias.
- `webhookUrl` must be **HTTPS**.
- `templateId` must be a UUID. It is lowercased before use.

Account preconditions:

- `verifiedDomain` and `replacementVerifiedDomain` are real, DNS-verified
  sending domains on the account.
- `dnslessDomain` must **not** exist on the account. The run creates it
  (`createMessageScenarioRegistry` in `scripts/live-acceptance.mjs`), asserts it
  is DNS-invalid, checks that a
  send to it is rejected, and deletes it in cleanup. A copy left behind by a
  failed run must be removed before re-tagging.
- `neverRegisteredDomain` must not exist on the account at all. The run also
  names it as the domain to unpause on the disposable sub-account, which owns
  no domains.
- `lifecycleDomain` must **not** exist on the account either — the run creates
  it (the `createDomainScenarioRegistry` call in
  `scripts/run-live-acceptance.mjs`), drives it through the full
  create/update/delete lifecycle, and uses it (as a bare domain, which the API
  stores as given and reads back unchanged) as the `website` of the
  disposable sub-account the sub-account scenarios create and delete
  (the `createSubAccountScenarioRegistry` call in
  `scripts/run-live-acceptance.mjs`).
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
- `templateId` is the ID of a **transactional template** on the release
  account. Create it in the AhaSend dashboard under the transactional
  templates, and save a design that:
  - has a plain ASCII subject with no `{{ }}` variable braces;
  - has an HTML or text body;
  - has no unsubscribe link and no view-in-browser link, so the send does not
    depend on AhaSend minting an unsubscribe link (`unsubscribe_url`) or a
    hosted view (`view_browser_url`);
  - uses only optional variables (each with a fallback value), or none.

  Then give the template a default sender on `verifiedDomain` in the "Sender"
  card of its page. The run sends once without `from`, which needs that
  sender, and fails `getTemplate` on a template with no sender or a sender on
  another domain.

  The template's page,
  `https://dash.ahasend.com/account/<account-id>/transactional/templates/<template-id>`,
  shows the template ID, and `<template-id>` in its URL is the same value.
  `client.templates.list()` also returns it as `id`. The template must stay on
  the account; deleting it fails `listTemplates` and `getTemplate`.

---

## Dependency audit policy

`npm run verify:audit` (`scripts/verify-audit.mjs`) runs `npm audit` twice,
without and with development dependencies, and applies
`security/audit-policy.json`:

- A production advisory always fails.
- A development advisory passes only with a matching entry in
  `security/audit-exceptions.json`. Each entry has a `reason`, a `reviewedOn`
  date, and an `expiresOn` date at most `maxExceptionDays` (90) days later. An
  entry fails once it expires, and it also fails when npm no longer reports
  the finding.
- Only the severities in `exceptionSeverities` (info, low, moderate) can have
  an exception. High and critical advisories always fail.
- An advisory on a direct development dependency can have an exception only
  when it is provably unpatched:
  - Every package on its chain with an advisory filed against it must be
    affected in all published versions, so npm reports its range as `*`.
  - npm offers no remedy, or only a rollback of the direct dependency to a
    release older than the installed one. The installed version comes from
    `package-lock.json`. Any upgrade that npm offers, breaking or not, is a
    fix: take the upgrade.

An entry always matches the package name, severity, and via entries that npm
reports. For a transitive finding, or a direct finding that npm can fix, it
also matches the exact vulnerable `range`. For a provably unpatched direct
finding, the entry has no `range`: npm computes that range from the published
versions, so it changes with each upstream release while the advisory stays
the same.

The rule trusts what npm reports, which has two limits:

- npm reports one range per package, for all of its advisories together. The
  `*` range proves an advisory unpatched only when it is the only via entry of
  its package. If a package on the chain has a second advisory, or an
  advisory next to a dependency, the direct finding fails, even when the
  second advisory has no fix either.
- npm also reports `fixAvailable: false` for a dependency that does not come
  from the registry, and it can copy the value from a parent finding. The rule
  accepts that value as it is. All current dependencies come from the
  registry.

The register has one entry per finding on the chain. A single advisory on a
deep dependency can therefore need several entries. Remove the entries when
upstream ships a fix.

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
