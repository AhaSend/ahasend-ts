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

The limiter is process-local. Separate client instances, workers, containers, and hosts do not
share tokens, so this is not a distributed quota coordinator. It does not learn from undocumented
remaining-quota response headers. Server HTTP 429 responses still flow through the retry policy,
including a valid `Retry-After`.

Choose limits below the account's actual server quota when multiple processes share one key or
account. Statistics fan-out should normally retain its stricter bucket so dashboards queue locally
instead of producing bursts of 429 responses.
