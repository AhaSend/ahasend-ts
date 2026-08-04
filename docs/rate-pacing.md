# Local rate pacing

Local rate pacing is disabled by default. Enable it when one process should smooth its own traffic
before requests reach AhaSend:

```ts
const client = new AhaSendClient({
  apiKey,
  accountId,
  rateLimit: {
    enabled: true,
    standard: { requestsPerSecond: 100, burst: 200 },
    statistics: { requestsPerSecond: 1, burst: 1 },
  },
});
```

The SDK uses independent in-memory token buckets for standard and statistics operations. Defaults
are 100 requests/second with a 200-request burst for standard calls and 1 request/second with a
one-request burst for statistics calls. Each category can be disabled independently, and every
configured burst must be at least one token.

Configured rates must be at least `1000 / 2_147_483_647` requests per second (approximately
`4.6566e-7`). Lower rates would require a token wait longer than the maximum delay supported by
Node.js timers, so the client rejects them during configuration instead of clamping or rounding
them.

Waiting calls are queued within one client instance and remain cancellable through their request
`AbortSignal`. Local pacing happens before the per-attempt `timeoutMs` budget starts. Use a caller
deadline when the queue wait must count toward an end-to-end deadline.

## Queue capacity

Each bucket admits at most `maxQueue` waiting calls, 1,000 by default. Beyond that, further calls
are refused immediately with `AhaSendRateLimitQueueFullError` rather than queued. Lowering
`maxQueue` applies to future admissions only — it never evicts calls already waiting, so the queue
can sit above the new bound until it drains. The bound exists
because a client offered work faster than its configured rate drains it would otherwise grow the
queue until the process runs out of memory.

Size it to the widest fan-out dispatched at once. `Promise.all` over N calls needs
`maxQueue >= N - available(category)`, because the tokens on hand are admitted immediately and the
rest queue. On a fresh, idle bucket that is `burst`; after traffic, or after a runtime `setLimit`,
it can be far less — read it with `client.rateLimiter.available(category)` rather than assuming:

```ts
const client = new AhaSendClient({
  apiKey,
  accountId,
  rateLimit: {
    enabled: true,
    standard: { requestsPerSecond: 100, burst: 200, maxQueue: 5_000 },
  },
});
```

The error names the bucket and the limit it hit, and is distinguishable from a server 429 by class
and by `code === "rate_limit_queue_full_error"`. Retrying it immediately will not help: it means
offered load exceeds the configured rate by more than the queue absorbs, so raise `maxQueue`, raise
the rate, or apply backpressure upstream.

**The refusal is per call, so an overflowing batch is partially applied.** Calls admitted before the
refusal keep running; only the excess is rejected. A `Promise.all` therefore rejects while some of
its requests are still in flight or already delivered — so re-running the whole batch after raising
the limit re-sends everything that already went out, which on `messages.send()` means duplicate
mail. Use `Promise.allSettled` and re-dispatch only the entries that failed with
`AhaSendRateLimitQueueFullError`:

```ts
import { AhaSendRateLimitQueueFullError } from "@ahasend/sdk";

const batch = [message];
const results = await Promise.allSettled(batch.map((entry) => client.messages.send(entry)));
const refused = batch.filter(
  (_message, index) =>
    results[index]?.status === "rejected" &&
    (results[index] as PromiseRejectedResult).reason instanceof AhaSendRateLimitQueueFullError,
);
```

## Adjusting limits at runtime

`client.rateLimiter` exposes the same controls after construction, for cases where the effective
limits are only known then — after reading a plan, or when backing off from sustained 429s:

```ts
client.rateLimiter.setEnabled(true);
client.rateLimiter.getLimit("standard"); // { requestsPerSecond, burst, enabled, maxQueue }
client.rateLimiter.setLimit("standard", { requestsPerSecond: 50, burst: 100, maxQueue: 2_000 });
client.rateLimiter.setCategoryEnabled("statistics", false);
client.rateLimiter.isCategoryEnabled("statistics"); // false
client.rateLimiter.available("standard"); // tokens on hand, fractional between refills
```

Every field of `setLimit` is optional and an omitted one keeps its current value, so the remedy for
a queue-full refusal is expressible on its own:

```ts
import { AhaSendRateLimitQueueFullError } from "@ahasend/sdk";

try {
  await client.messages.send(message);
} catch (error) {
  if (error instanceof AhaSendRateLimitQueueFullError) {
    client.rateLimiter.setLimit(error.category, { maxQueue: error.maxQueue * 4 });
  }
  throw error;
}
```

**Raising `burst` raises the ceiling; it does not grant tokens.** They accrue at
`requestsPerSecond` and are capped at the new `burst`, so a bucket raised from `burst: 1` to
`burst: 200` still holds about one token until it refills. Sizing a fan-out off the new `burst`
immediately after raising it will refuse most of the calls.

`available()` reports the bucket's token count whether or not pacing is running — a disabled bucket
admits everything regardless of the number. Pair it with `isEnabled()` and
`isCategoryEnabled(category)` before reading it as headroom.

Disabling pacing releases every waiting call immediately — all of them, in one tick — so the burst
that lands on the transport scales with `maxQueue`. Re-enabling resumes from a full burst rather
than from stale token state.

Note that turning pacing on at runtime to shed server 429s imposes `maxQueue` at the same moment:
a fan-out wider than `burst + maxQueue` converts retryable 429s into non-retryable local refusals.
Raise `maxQueue` in the same breath.

The limiter is process-local. Separate client instances, workers, containers, and hosts do not
share tokens, so this is not a distributed quota coordinator. It does not learn from undocumented
remaining-quota response headers. Server HTTP 429 responses still flow through the retry policy,
including a valid `Retry-After`.

Choose limits below the account's actual server quota when multiple processes share one key or
account. Statistics fan-out should normally retain its stricter bucket so dashboards queue locally
instead of producing bursts of 429 responses.
