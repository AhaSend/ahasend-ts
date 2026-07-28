# Subaccounts and child API keys

`client.subAccounts` manages child accounts from a parent-account client. Parent credentials need
the operation-specific `sub-accounts:*` or `sub-account-api-keys:*` scope shown in the
[API reference](api-reference.md).

## Lifecycle

```ts
const child = await client.subAccounts.create(
  {
    name: "Acme EU",
    website: "eu.acme.example",
    monthly_credit: 50_000,
  },
  { idempotencyKey: `create-child-${customerId}` },
);

await client.subAccounts.suspend(child.id, {
  reason: "Customer requested a temporary pause",
});
await client.subAccounts.unsuspend(child.id);
```

`monthly_credit` accepts 0 through 1 billion; 0 means no cap. Suspend and unsuspend are deliberate
state transitions and are not automatically retried. Deletion is soft from the parent's list, but
usage already incurred by children deleted during the billing period remains in the
`removed_sub_accounts` aggregate.

## Bootstrap a child key

Child credentials cannot manage nested child API keys. Use a parent credential with
`sub-account-api-keys:write`, create the child key through the nested facade, and then use the
returned secret with the child's ID on an ordinary client:

```ts
const createdKey = await client.subAccounts.apiKeys.create(
  child.id,
  {
    label: "Child production sender",
    scopes: ["messages:send:all"],
    ip_allow_list: ["203.0.113.0/24"],
  },
  { idempotencyKey: `bootstrap-key-${customerId}` },
);

await secretStore.put(`ahasend/${child.id}`, createdKey.secret_key);

const childClient = new AhaSendClient({
  apiKey: createdKey.secret_key,
  accountId: child.id,
});
```

`secret_key` is visible only on creation. Store it immediately and never log it. Exact idempotent
replays within 5 minutes return the same child secret; use a different idempotency key for the
subaccount creation and the key creation.

## IP allow lists and self-lockout

An empty `ip_allow_list` allows authentication from any source IP. A non-empty list restricts the
key on every v2 endpoint regardless of scopes. Entries may be CIDR blocks or bare IPv4/IPv6
addresses, are canonicalized and deduplicated by the API, and are limited to 100 entries.
Allow-all prefixes `0.0.0.0/0` and `::/0` are rejected.

On update, omit `ip_allow_list` or pass `null` to leave it unchanged, pass `[]` to clear the
restriction, or pass a non-empty list to replace it. When a key updates its own list so the
caller's current source IP would no longer be covered, the API rejects the change with a terminal
HTTP 409 and persists nothing. This self-lockout guard does not apply when a parent key updates a
child key, so confirm the child's egress addresses before replacing its list.

## Pooled usage

```ts
const usage = await client.subAccounts.usage();
console.log(usage.billing_period, usage.currency, usage.total);
```

The response allocates the parent's pooled invoice proportionally across the parent, current
children, and a `removed_sub_accounts` bucket. `allocated_cost` is an allocation of the pooled
invoice, not standalone pricing for what a child would pay on its own plan. Preserve and display
the server's `allocation_note` with derived reports.
