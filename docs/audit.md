# Audit

Every persisted decision is recorded: what was asked, who asked, what Oathrion
answered, which rule decided it, and what happened downstream.

```bash
curl -sf $OATHRION_URL/api/audit -H "Authorization: Bearer $KEY"
```

```json
{ "total": 4, "limit": 50, "offset": 0, "windowTruncated": false,
  "events": [ { "at": "...", "actor": "...", "event": "...", "detail": { ... } } ] }
```

The key is **`events`**. Supports `limit` and `offset`; `windowTruncated` tells
you the window was cut rather than exhausted, so an empty-looking tail is not
mistaken for the end of history.

## Dry runs record nothing

`/api/evaluate` defaults to `persist: false`, and a dry run writes **no audit
entry**. If your audit trail is empty after a run of test calls, this is almost
certainly why. See [the HTTP API](http-api.md#persist-dry-run-by-default).

## Tamper-evidence, and its exact limit

Each entry carries `prevHash` and `hash`:

```
hash = sha256( prevHash | canonical(at, actor, event, detail) )
```

Any edit, reordering, insertion or removal **inside an execution's trail**
breaks the link, and verification names the index where it broke. An entry
quietly rewritten after the fact no longer verifies.

The chain is seeded per `(organization, execution)` — not globally. The tenant
id is in the genesis hash, so an identical trail does not produce identical
hashes under two tenants, and a trail copied from one organisation to another
fails at index 0 rather than verifying happily.

**The limit, stated plainly.** This detects tampering *within* an execution's
trail. It does **not** detect the deletion of an entire execution row, because
nothing is left to check the link against. Closing that needs a per-tenant
ledger with a persisted head. That is real work, it has not been done, and it is
not claimed here.

Second limit: verification is **internal consistency**, not external
cryptographic authenticity. It proves the trail has not been edited since it was
written. It does not prove to a third party that Oathrion wrote it — there is no
signature over the chain head and no external anchor. Someone with write access
to the database and the code could produce a fresh, internally consistent chain.
If you need a trail that survives a compromised host, this is not yet that.

## What is recorded

The decision, the rule, the agent, the resolved approver identity (taken from
the verified credential, never from the request body), and the downstream
outcome including `succeeded: false` when a released action failed in its tool.

Secrets are redacted from logs (`server/log-redaction.ts`). Do not put
credentials in `input` or `context` regardless — they are policy inputs and
audit content, and they are meant to be read by humans later.
