# Retries and idempotency

The SDK retries only operations that its generated operation profile classifies as safe,
idempotent, or protected by an idempotency key. It does not infer safety from an HTTP method at
runtime.

## Retry policy

Retry handling is enabled by default, but `maxRetries` never overrides the operation-level gate
described above. For an eligible operation, `maxRetries: 3` means one initial attempt and at most
three retry attempts. The default backoff is exponential with a 1,000-millisecond base delay and
jitter, so the first retry waits from 500 to 1,000 milliseconds. Delays are capped at 30 seconds.
Linear and constant strategies are also available.

The SDK retries:

- HTTP 408, 429, and 5xx responses;
- network failures and per-attempt timeouts; and
- an idempotency-in-progress HTTP 409 only when the request was made to an idempotent operation
  with a key and the response has `Idempotent-Replayed: false` plus a positive integer
  `Retry-After`.

Caller cancellation is never retried. Ordinary 4xx responses, including an API-key self-lockout
409, are terminal. `domains.checkDns()`, `subAccounts.suspend()`, and
`subAccounts.unsuspend()` are also never retried because the API does not declare them retry-safe.

For HTTP 429, a valid `Retry-After` in seconds or HTTP-date form is authoritative and capped at
`maxDelayMs`. An eligible idempotency-in-progress 409 accepts only the positive integer seconds
form. Other retryable responses use the configured backoff.

```ts
const client = new AhaSendClient({
  apiKey,
  accountId,
  retry: {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    strategy: "exponential",
    jitter: true,
  },
});
```

See [Cancellation and timeouts](cancellation.md) for the boundaries of attempt timeouts and abort
signals.

## Idempotency keys

Every create operation documented by the API as idempotent receives an automatically generated
UUID `Idempotency-Key` by default. The SDK generates it once for the logical call and reuses the
same value across all internal retry attempts.

For a business operation that your application may retry later, supply a stable key:

```ts
await client.messages.send(message, {
  idempotencyKey: `order-email-${orderId}`,
});
```

Use the same key only for the same operation and exact request payload. Reusing it with different
content produces `AhaSendIdempotencyMismatchError`. A completed replay can be identified through
the response envelope:

```ts
const result = await client.messages
  .send(message, { idempotencyKey: `order-email-${orderId}` })
  .withResponse();

if (result.idempotentReplayed) {
  // The server returned the stored result of an earlier identical request.
}
```

Non-secret idempotency results expire after 24 hours. API-key creation responses contain a
one-time secret and have a 5-minute replay window; an exact replay during that window returns the
same secret. Persist that secret immediately. Do not assume a key prevents a second operation
after its server retention window expires.

`idempotency.autoGenerate: false` disables automatic keys. Create operations without a key are
then attempted only once because they are no longer retry-safe. `IdempotencyKeyBuilder` is useful
for related but distinct operations; its prefix is prepended literally, so include any desired
separator yourself.

An abort or timeout does not prove that the server did no work. Reconcile using the stable
idempotency key or a subsequent read before issuing a new business operation.
