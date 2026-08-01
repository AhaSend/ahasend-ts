# Cancellation and timeouts

Every resource method accepts a trailing `RequestOptions` object with an `AbortSignal` and an
optional per-call timeout:

```ts
const controller = new AbortController();

const pending = client.messages.list(
  { limit: 100 },
  { signal: controller.signal, timeoutMs: 10_000 },
);

controller.abort("request no longer needed");
await pending; // rejects with AhaSendAbortError
```

The caller signal covers every phase of the logical SDK call: waiting for a local rate-limit
token, `fetch`, response-body reading, retry backoff, and later attempts. `AhaSendAbortError` is
terminal and is not retried. When caller cancellation and a timeout race, the first cancellation
source wins.

`timeoutMs` is a per-network-attempt budget in **milliseconds**. A call's `options.timeoutMs`
overrides the client setting for every attempt in that call. It starts after local rate pacing and
covers both `fetch` and reading the response body. Each retry receives a new attempt budget; retry
backoff and local pacing are outside that budget. Values must be finite, positive, and no greater
than 2,147,483,647 milliseconds.

`AhaSendClient.fromEnv()` reads `AHASEND_TIMEOUT` in **seconds** and converts it to milliseconds.

```ts
const client = new AhaSendClient({
  apiKey,
  accountId,
  timeoutMs: 10_000,
});
```

A timed-out attempt rejects with `AhaSendTimeoutError`, a subclass of
`AhaSendConnectionError`. Eligible operations may retry it. To cap the entire logical call,
including pacing and backoff, pass a caller deadline such as `AbortSignal.timeout(30_000)`.

Cancellation is local: it stops the SDK from waiting, but it cannot recall a request that the
server already accepted. For create operations, reuse a stable idempotency key and reconcile the
result before trying again. Message cancellation is a separate API action:

```ts
await client.messages.cancel(messageId);
```

It succeeds only before the first delivery attempt. It cannot recall a message that has already
been sent, and the operation requires `messages:cancel:all` or the matching
`messages:cancel:{domain}` scope.
