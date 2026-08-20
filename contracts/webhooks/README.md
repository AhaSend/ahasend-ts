# Webhook contract fixtures

Signed webhook payloads the SDK's verifier is tested against. Two corpora, and
the difference between them is the point:

- **`captured/`** — bodies serialised by Go's `encoding/json` over the AhaSend
  server's own payload structs, extracted verbatim from a pinned commit. These
  carry the producer's real serialisation semantics: field order, `omitempty`,
  RFC3339Nano timestamps, `[]` vs `null`, HTML escaping. They are evidence
  about the _producer_, and their manifest attests to the commit they came
  from.
- **`synthetic/`** — hand-written bodies for cases the producer cannot be made
  to emit on demand: a field a future server might add, a value outside the
  known set, an explicit `null`. They are evidence about the _SDK's tolerance_,
  and they claim no provenance.

## Regenerating

Needed when the server's payload structs change, and whenever a captured
fixture is added or any of its values change. The server checkout must
be a normal clone — so `origin/master` exists for the reachability check —
detached at the commit being attested to, and outside both repositories. A git
worktree inside either repo breaks the secret scanner and the docs preflight.
The output directory must already exist — the emitter panics otherwise — is
resolved relative to the tools directory, so pass an absolute path, and must
hold nothing but the emitted bodies: the resigner refuses files no manifest
claims, so a fixture added to the emitter cannot go unnoticed.

```bash
git clone <server> /tmp/server-pin && git -C /tmp/server-pin checkout --detach <sha>

./contracts/webhooks/tools/extract-producer-structs.sh /tmp/server-pin <sha>
(cd contracts/webhooks/tools && go run . /abs/path/to/out)   # its own Go module
node contracts/webhooks/tools/resign-fixtures.mjs rewrite /abs/path/to/out
npm run contracts:generate
```

To re-sign only the hand-written corpus — adding a synthetic fixture, say — no
server checkout or Go toolchain is needed:

```bash
node contracts/webhooks/tools/resign-fixtures.mjs rewrite --synthetic-only
npm run contracts:generate
```

`node contracts/webhooks/tools/resign-fixtures.mjs verify` recomputes every
digest and signature from the files on disk and changes nothing.

## What no tool will do for you

Signatures prove that a body and its manifest agree. They cannot prove the body
still says what it was written to say — `rewrite` re-signs whatever bytes it
finds, so a stray local edit becomes signed evidence. Four things therefore live
outside the corpus, and each one makes an attestation quietly false if skipped:

- **`serverCommit`** in `captured/manifest.json` — copy the value the extractor
  prints. A test ties it to the header stamped into `producer-structs.go`, so
  the two cannot drift apart, but neither is set for you.
- **`provenance.derivedAt`** on every re-derived capture. The resigner
  recomputes digests and deliberately leaves provenance alone.
- **The literal digest tables** — `CAPTURED_PINS` in `tests/contracts.test.ts`
  and `SYNTHETIC_BODY_DIGESTS` in `tests/webhooks.test.ts`, plus the sha256 pin
  on `producer-structs.go` itself, which is what makes a re-extraction a
  deliberate edit rather than an invisible one. These are the out-of-band
  evidence, so they must move deliberately. If you cannot say why a digest
  changed, do not paste the new one in.
- **The content expectations** — `DELIVERY_ATTEMPT_FIXTURE_EXPECTATIONS` and
  `IS_BOT_FIXTURE_EXPECTATIONS` in `tests/webhooks.test.ts`, and the captured
  equivalents in `tests/contracts.test.ts`. A fixture id is a claim; these are
  what check it.

Everything else fails loudly: fixture counts, `toHaveLength` assertions, and
`npm run contracts:check` all move on their own.

## Choosing fixture values

Captured bodies must be shapes the producer actually emits — that is the whole
difference between derived evidence and a guess, and nothing in the pipeline
checks it: digests, signatures, and schema validation all pass just as happily
on an invention.

The cheap way to get this right is to not invent anything. Each event has a
published reference attempt — what a test webhook actually delivers — so use
those values verbatim. Don't try to derive a payload by reasoning about mail
transport or bounce classification; the SDK treats `classification` and friends
as opaque strings and forwards them untouched, so a fixture's job is to exercise
serialisation and parsing, not to model upstream behaviour.

Anything the samples don't cover — `description`, an unknown classification, an
explicit `null` — belongs in `synthetic/`, which claims no provenance.
