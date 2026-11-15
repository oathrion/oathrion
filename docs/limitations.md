# Known limitations

Read this before a pilot. Everything here is a real boundary of the current
build, stated so that nobody discovers it in production.

**Nothing in this documentation claims a guarantee stronger than the code
provides.** This page is where the difference is written down.

## Authorization

**MOTIF B cannot physically stop a hostile client.** If your code calls
`/api/evaluate` and ignores the answer, Oathrion cannot prevent the action. The
guarantee is that the decision is authoritative, recorded and tamper-evident —
not that it is unavoidable. For an unavoidable check, put Oathrion in the path with
the [MCP gateway](mcp.md). The [framework adapter](../examples/framework-adapter/)
has the same limit: it protects the tool it wrapped, not the unwrapped original.

**Oathrion does not solve prompt injection.** No authorization layer does. It bounds
the blast radius — a refund ceiling holds whether or not the agent was tricked —
and that is a smaller claim than immunity.

**Unbound API keys can name any agent in their organisation — in the source, outside
production only.** Since Phase 9 the requirement is ON by default when
`NODE_ENV=production`, so a deployment fails closed without being configured.

**In the shipped bundle it is always ON, whatever `NODE_ENV` says.**
`script/build.ts` compiles with `define: { "process.env.NODE_ENV": '"production"' }`,
so the switch's read of `NODE_ENV` becomes a literal in `dist/index.cjs`. Running
the bundle with `NODE_ENV=development` therefore still requires bound credentials.
That is the fail-closed direction and it is deliberate; what Phase 12.2 fixed is the
boot banner, which used to read the runtime environment and announce "not required"
while the API refused unbound keys with 403. The banner now reports what the request
path will actually do.

Practical consequence: under `tsx` (`npm run dev`, the test suite, the quickstart)
the requirement follows `NODE_ENV`. Against `dist/index.cjs` you must bind your
credentials, or set `OATHRION_REQUIRE_AGENT_BINDING=false` explicitly — which is logged
at boot. See [Authentication](authentication.md#binding-a-key-to-an-agent).

## Audit

**Every tool run is in one per-tenant receipt chain — since 28 October 2026.** Both
paths that reach a side effect now write to it: `/api/actions/*` (the enforcement
point) and the MCP gateway (`server/gateway/gateway-ledger.ts`, which covers
`oathrion wrap`, the connectors and the intercept relay). Before that date, the
gateway's runs had only their per-execution trail (STRESS-TEST-LOG §5.41–§5.42).
Deleting a receipt breaks the chain; deleting an execution row leaves its receipt
in place.

**What is still not detected: the deletion of an execution that ran no tool.** A
blocked action, or one held and never approved, has a per-execution hash-chained
trail but no receipt — nothing was executed, so there is nothing to receipt. Remove
the whole row and nothing is left to check against. And nothing cross-checks
receipts against execution rows automatically yet: a receipt whose execution row
has disappeared is visible on inspection, not alerted on.

**Verification is internal consistency, not external authenticity.** It proves
the trail has not been edited since it was written; it does not prove to a third
party that Oathrion wrote it. There is no signature over the chain head and no
external anchor, so someone with write access to database *and* code could
produce a fresh, internally consistent chain.

## Erasure

**A tenant can be erased; a person inside a live tenant cannot.**
`npm run tenant:purge` deletes everything one organization owns — every table carrying
`organization_id`, discovered from the schema rather than from a hand-written list — and
writes a record that keeps the row counts and nothing else. It refuses an ACTIVE tenant,
refuses a confirmation that is not the organisation's name, and counts without deleting
unless `--confirm` is given. Verified by `npm run verify:erasure` (15 checks, PostgreSQL,
no `pg_dump` required) and again inside `npm run e2e:multitenant` where two real tenants
coexist.

**Erasing one person inside a tenant that keeps running is NOT implemented, and the
reason is structural.** `action_receipts` carries `approved_by` and `consumed_by` *inside
the chained hash*. Nulling those fields changes the entry hash, so the chain no longer
verifies — a lawful erasure would be indistinguishable from tampering, which is the one
thing the chain exists to tell apart. Solving it needs a re-anchoring design (a signed
tombstone, or a chain that hashes a commitment to the identity rather than the identity)
that does not exist here. Until it does, a subject-erasure request against a live tenant
is a contractual matter, not a product feature.

**The purge takes the audit chain with it.** That is correct for a tenant that no longer
exists — there is no one left to prove anything to — but it means the operator cannot
afterwards show what that customer did. Export first (`npm run tenant:export`) if anyone
needs the history; after the purge there is nothing to export.

## Execution

**A verb with no tool is authorized and not called.** The built-in registry is
five simulated tools (`server/gateway/tool-registry.ts`); an operator adds their
own with `OATHRION_TOOLS`, and a declared tool reaches a real MCP server — proven
end to end against a server that imports nothing from this repository by
`npm run verify:tools`. What remains true is the gap itself: any verb that no
tool serves comes back `runState: "skipped"` — a real decision, no downstream
call. `stripe.refund` in the [quickstart](quickstart.md) is one of the simulated
five: authorized, recorded, not sent to Stripe.

**A streamed response is never seen whole, and three bounds cut it.** A rule with
`stream: true` relays the provider's body as it arrives — the only way to sit in
front of a model API. Oathrion therefore never holds that body in one piece: it is
not inspected and not persisted (it was not before either, so nothing is lost
today), but any future response inspection is impossible on a stream. Three
bounds apply: 64 MiB, 60 s of silence, 10 minutes total. Exceeding one **cuts**
rather than refuses — the agent already has bytes, and HTTP offers no rewind — and
the receipt then carries `truncated: true`, because the agent acted on a partial
answer while the provider's side happened in full. And a request **held for
approval** is always relayed buffered: the agent received a 202 and its connection
is long closed, so there is nobody to stream to.

**An organization-wide amount ceiling blocks every verb that carries no amount.**
Measured, with the engine's own words: *"caps this action at 500,00 €, but the
action declares no numeric amount"*. A model call has no amount, a ceiling in
euros cannot bound it, and the engine refuses rather than letting it through —
fail-closed, in the right direction. The fix is one field, and the shipped
`pol_purchase_limit` already uses it: `condition.actions` restricts the ceiling to
the verbs that carry an amount (`["refund","payment","payout","charge"]`).
`appliesToAgentIds` works too and is the right tool when it is the AGENT you mean
to bound rather than the verb. A flat target refusal needs no amount and does
govern every agent.

**A declared argument cannot be marked optional.** Each entry in a declaration's
`arguments` is a projection of a field Oathrion already holds, and every one of
them must have a value at call time. When one does not — `metadata.reference` on
a call that carried no reference — the dispatch is refused with
`reason: "unprojectable_arguments"` and the receipt is `failed`. It is refused
rather than omitted on purpose: `JSON.stringify` erases an `undefined`, so the
provider would receive an instruction missing a field Oathrion believes it sent,
and a provider that fills a missing field with a default would act on an amount
nobody authorized. The cost is that a genuinely optional provider field has to be
declared on a separate tool entry, or left out.

**A declaration cannot transform a value.** No formatting, no unit conversion, no
default. A provider that wants minor units where Oathrion holds major units cannot
be served by a declaration — that needs an adapter in front of it. This is
deliberate: a transformation Oathrion invents is content Oathrion did not receive and
cannot show to an auditor.

**A tenant cannot declare its own tools.** `OATHRION_TOOLS` is read from the
deployment environment, so on a shared instance the operator declares the
connectors and scopes each destination to its tenants with `organizations`. There
is no per-tenant tool declaration and no API for one.

### Connectors

**Four connectors are real: GitHub, Slack, Linear and Stripe.** Updated on 28 October
2026 — this paragraph said « One connector is real: GitHub » long after that stopped being
true. Each one verifies a credential against the provider before storing it, acts over
authenticated HTTPS, and reconciles: it reports writes the provider saw that Oathrion did
not authorize. Their verbs, what each one proves, and the command that verifies it are in
[connectors.md](connectors.md). Every other tool reaches Oathrion as a declared MCP tool, or
through [`oathrion wrap`](wrap.md).

**Everything else in the "Integrations" screen was decorative, and is now out of the
navigation.** `client/src/pages/integrations.tsx` listed OpenAI, Slack, Gmail and
others with a `Connected` pill and a button that flipped a boolean. No credential, no
call, no test. The seeded `connected: true` rows in `shared/seed/integrations.ts` are
demonstration data and were never an integration. The real screen is "Connecteurs",
where every state comes from a call to the provider.

**Oathrion cannot revoke a credential at the provider.** Disconnecting overwrites the
sealed envelope and refuses every later action, but a GitHub personal access token
stays valid until its creator deletes it. The API answers `remoteStillValid: true` and
the console says so in red with the link. No connector calls a real revocation API,
and none claims to.

**One-click connection (OAuth) exists for Slack and Linear, and has never met the real
providers.** The flow is built and tested against simulated providers
(`server/connectors/oauth-install.ts`). It needs a registered application, a client secret
and a public HTTPS callback URL — three things that belong to a deployment — and no
deployment with all three has run it yet. Without them, the console offers the token
connection, presented as such. GitHub and Stripe connect by token only.

**A declared argument of a connector cannot be transformed.** Same limit as a declared
tool: no formatting, no unit conversion, no default.

**Schema checking compares names, not types.** Oathrion reads a downstream server's
`tools/list` and refuses a declaration whose tool does not exist, whose required
arguments are not all projected, or which projects a field the schema does not declare.
It does not check that `amount` is a number: that would mean implementing JSON Schema,
and a hand-written subset would refuse valid schemas while letting through what it does
not understand.

**A server without `tools/list` cannot be checked.** The dispatch happens and the
receipt says `schemaChecked: false` with the reason. Refusing every call because a server
does not implement an optional method would make Oathrion unusable against servers that
work; an operator who wants "unverifiable" to mean "no" writes `"requireSchema": true`.
The trade-off is explicit and visible in the receipt either way — never silent.

**A connector cannot deduplicate at the provider.** GitHub's API has no idempotency
header, so a replayed `POST /issues` would create a second issue. Oathrion does not
replay — a grant is consumed once — but a lost response means Oathrion records a failure
for an issue that exists. The execution id is written into the issue body so a
duplicate is *recognisable*; that is not deduplication and is not called one.

**Control depends on the credential living only in Oathrion's vault.** An agent holding
its own provider token calls the provider directly and Oathrion sees nothing. That is a
property of the deployment, not a guarantee of the software — the same honest limit
already recorded for `/api/evaluate`.

### The interception firewall

**It governs only the traffic that passes through it.** `POST /api/v1/intercept/…` puts
Oathrion between an agent and an API: the request is read, your rules are applied, and it is
forwarded only on ALLOW. An agent that can reach `api.stripe.com` directly is not
intercepted, and no software can prevent that from inside this process. What makes the
bypass *impossible* rather than discouraged is that **the provider credential lives only in
Oathrion** — Oathrion injects it, the agent never holds it. See [firewall.md](firewall.md).

**Traffic refused before any decision is counted, not individually traced.** A request no
rule recognises never reaches the engine, so there is no decision to record, and
fabricating an execution row would invent a verdict the engine did not reach. It increments
`oathrion_intercept_refusals_total{reason}` on `/metrics`. An operator reading the audit trail
alone will not see it.

**The request body never enters the audit trail, on purpose.** Only the extracted fields —
verb, target, amount, currency — are persisted, because those are what the policy weighed.
A financial API body carries names, addresses and sometimes a card number; putting it in
execution metadata would put it in the table this product promises it can show an auditor.
The raw request lives in memory, is taken exactly once by the relay, and is written nowhere.

**`OATHRION_INTERCEPT_KEY_<DESTINATION>` is weaker than the vault, and is a stopgap.** It is
cleartext in the process environment and applies to the whole deployment, where the vault is
AES-256-GCM, per tenant and revocable. It exists because the vault currently only accepts a
credential for a connector in the catalogue, and a firewall destination is not necessarily
one — without it the agent would have to carry its own key, which is strictly worse. A
generic connector would remove the need.

**Rule matching compares a method and a path, not a body shape.** Two different operations
on the same route are the same rule. `*` matches exactly one path segment, deliberately: a
wildcard that crossed `/` would make a rule written to *read* a charge cover refunding it.

**Downstream MCP forwarding requires an explicit allowlist.** Since Phase 9 it
is no longer loopback-only, but it will never forward to an arbitrary host: the
destination must be named in `OATHRION_MCP_ALLOWED_DESTINATIONS` *and* survive the
SSRF address rules (`server/gateway/tools/mcp-destination.ts`). An unset
allowlist permits nothing. See [MCP gateway](mcp.md#downstream-destinations).

**DNS rebinding is defended at connect time, not by the URL check.** The address
of a hostname is re-checked on the socket
(`server/notifications/webhook-transport.ts`), which is the only check that
cannot be raced. A hostname the operator allowlists that resolves to a public
address it does not control is still that operator's decision to make.

## Storage

**PostgreSQL is the production backend.** This page said the opposite until Phase
12.2, which was a leftover from Phase 11 and understated the product. Precisely,
as of Phase 12.2:

- The **migrations** work and are tested against a real PostgreSQL server,
  including a check that both engines produce an identical ledger.
- The **repositories** are ported (`server/repositories/postgres.ts`), and so are
  the identity plane (`server/identity/sync-postgres.ts`) and the action
  authority. The engine is chosen once at boot in
  `server/repositories/index.ts`, with no silent fallback.
- `NODE_ENV=production` **requires** PostgreSQL on every plane —
  `DATABASE_DRIVER`, `OATHRION_IDENTITY_PLANE`, `OATHRION_ACTION_AUTHORITY_DRIVER` and
  `RATE_LIMIT_STORE` must all say `postgres`, and no environment variable opts
  out (`validateProductionConfiguration` in `server/database-config.ts`).
- SQLite remains supported **outside** production, which is where development and
  most of the test suite run.

What is *not* claimed: a performance figure. The identity plane reaches PostgreSQL
through a synchronous worker bridge on a single connection, so each identity query
blocks the event loop for one round trip. One instance was measured at roughly
90–190 authenticated requests per second on a loopback setup — see
[COMMERCIAL_READINESS.md](COMMERCIAL_READINESS.md) for the numbers and their
scope. No remote-infrastructure measurement exists.

## Tenant configuration

**Chantier 1 is in progress; only its first step is done.** Precisely:

- **Per-tenant quota ceilings live in the database** (`organization_quotas`,
  migration 17) and are read on every guarded write, by every replica, with no
  cache: a ceiling changed in the database applies to the next request on every
  instance, without a restart (proved across processes on PostgreSQL in
  `server/test/tenant-quota-config-postgres.test.ts`).
- **`OATHRION_QUOTAS` keeps working exactly as before.** Its `org_x:` entries are
  synchronised into the table at every boot; a row imported from the environment
  follows it (edit + restart updates it, removing the line removes it). The
  `default:` entries stay in the environment: they describe the deployment.
- **There is no administration API yet.** Nothing in the shipped product writes a
  ceiling at runtime; `setOrganizationQuota` exists and is tested, but its only
  callers are tests. Until the API step, the database rows are the environment's
  copy, and changing a ceiling is still "edit `OATHRION_QUOTAS`, restart".
- **A boot refuses to start** when an `OATHRION_QUOTAS` entry contradicts a ceiling the
  application wrote (`source = 'api'`), naming the tenant, the counter and both
  values. No such row can exist before the API step, except by hand-written SQL.
- **Still in the environment or fixed at boot:** destinations (`OATHRION_DESTINATIONS`),
  the first administrator of a tenant (`OATHRION_CONSOLE_USERS` / `bootstrap:admin`),
  the currency (in the database since migration 15, but cached per process — a
  change needs a restart), tenant creation and suspension (no route; suspension is
  enforced on every request but can only be set by SQL). There is no platform
  operator role and no audit record of configuration changes.

**Cost of the database read.** One primary-key read per quota-guarded write (agent
and policy creation, persisted executions). On PostgreSQL it goes through the
synchronous identity bridge, so it adds one round trip to the event loop for those
writes; it was not measured separately from the ~90–190 req/s figure below.

**An orphaned imported row is not cleaned up.** Removal of an environment-owned
row is looked up per tenant (registered organizations plus those `OATHRION_QUOTAS`
names), never by a cross-tenant scan, which the tenant-isolation barrier forbids.
So a row imported for an organization that was never created, whose entry was
later removed from `OATHRION_QUOTAS`, stays in the table. It is inert — and it would
apply if an organization with that exact id were created later.

**Rolling deploys.** Replicas booting with different `OATHRION_QUOTAS` each rewrite
the environment-owned rows on their own boot; the last boot wins, and every
replica then enforces that same value. Before chantier 1 each replica enforced its
own environment during the same window.

## The deployment stack

**`docker compose up` is proven end to end — it had never been run.** The Phase 13
report marked it SKIPPED, for a true reason at the time: no compose plugin and no
bridge network on that machine. The kit was therefore shipped without anybody having
started it, which is how a pilot gets installed.

`npm run verify:compose` now does, in 20 checks: the four services come up, the one-shot
migration **gates** Oathrion's start (exit 0, schema at version 18, before the server
boots), the proxy answers 200 over HTTPS with HSTS and no `Server` header, port 80
redirects 308, the hardening is real (user `node`, read-only rootfs — a `touch /app`
is actually refused —, `no-new-privileges`, PostgreSQL not published on the host), a
full client path works **through the proxy**, and stopping PostgreSQL under a live
instance gives 503 on `/api/ready` while `/api/live` stays 200 and the process stays
alive, then recovers with no restart.

**The public certificate is still not proven, and this is the honest part.** Caddy
obtains it through an ACME challenge, which needs a public DNS name pointing at the
machine and port 80 reachable from the internet. The verification runs with
`OATHRION_DOMAIN=localhost`, hence Caddy's **internal CA**: the whole TLS path is exercised
except obtaining the certificate itself. What remains untested on a real domain is one
step — and it is the step that fails loudly, not silently, if DNS or the firewall is
wrong.

The script **refuses to run** if `deploy/placet.env` already exists: it would otherwise
overwrite a real deployment's secrets with test values.

## Backups

**The scripts could not run, and now they can.** `deploy/scripts/backup.sh` and
`restore.sh` call `pg_dump`, `pg_restore` and `psql`, which no image of the deploy kit
installs — on the host of a `docker compose up` both failed with "command not found".
`backup.sh` had a `COMPOSE=1` mode that was half done: it dumped inside the container,
then verified the dump on the host. Every client command now goes through one
indirection (`deploy/scripts/pg-run.sh`), and a missing toolchain exits with code 2 and
names which of the three paths to pick.

**`npm run verify:backup` is what replaced "NON TESTÉ".** 21 checks: the dump is written
600 with its checksum and no `.partial` survivor, retention deletes a 30-day-old dump
and its checksum while sparing the recent ones, restoring into a non-empty database is
refused, and Oathrion boots on the restored database with **the same receipt-chain head** as
before — a grant consumed before the backup is still consumed after, so a restore never
reopens a replay.

What it does **not** prove: that your cron fires. Scheduling belongs to the operator;
the script only guarantees that the scheduled command does what it says. And the
durations it prints come from a test-sized database — they are not an RTO.

## Rate limits

**They are configurable since the pilot's step 2, and they were not before.** The three
ceilings were literals in `server/routes.ts` — 120 decisions, 30 writes and 60 approvals
per minute — so an operator could not adjust them without recompiling, and an agent
whose real traffic exceeds them receives 429s that look exactly like an outage.

```
RATE_LIMIT_DECISION=600      # per window, default 120
RATE_LIMIT_WRITE=120         # default 30
RATE_LIMIT_APPROVAL=60       # default 60
RATE_LIMIT_WINDOW_MS=30000   # default 60000, bounded to [1000, 3600000]
```

What to know before changing them:

- **An invalid value refuses the boot**, with the offending variable named. It is never
  replaced by the default — the same rule as `RATE_LIMIT_FAIL_MODE`, and for the same
  reason the Phase 13 D3 defect existed.
- **Zero is refused.** A ceiling of zero would refuse every request of that scope; it is
  closed, therefore safe, but it is never what anybody meant to write.
- **The window is bounded to one second … one hour.** Below a second it limits nothing
  useful and almost always means a confused unit (`RATE_LIMIT_WINDOW_MS=60` meant
  sixty *seconds*). Above an hour it is no longer a burst guard but a quota, and quotas
  have their own mechanism, per organization and in the database.
- **They are per deployment, never per tenant.** A rate limiter protects the
  deployment's capacity; a customer's contractual ceiling is what `shared/quotas.ts`
  does. Two places answering "how much is this customer allowed" would be one too many.
- The ceilings in force are printed at boot, with `(configuré)` on the ones that were
  changed — a tuned limit must be readable in the logs, not discovered during an
  incident.

## The action plane's receipt chain

**It can now be verified over HTTP, and it could not before.** The authority plane
writes its own hash chain — one per tenant, `prevHash` / `entryHash` / gap-free
`entrySeq` since migration 13 — but nothing exposed it. `GET
/api/executions/:id/audit/verify` verifies a *different* chain, the one on
`executions`, and the authority plane does not write to that table: its
`executionId` is an `axn_…` naming the downstream call. A customer using the
recommended path therefore had no way to verify the trail of their own actions.
`GET /api/actions/receipts/verify` closes that; the conformance kit found it.

What it proves and what it does not, precisely:

- **Proves**: the tenant's receipts have not been edited, reordered, or removed
  from the middle since they were written. `entrySeq` is part of the hashed body,
  so a receipt cannot be moved and still verify.
- **Does not prove** anything to a third party: no signature, no external anchor.
  Someone with write access to the database *and* the code can recompute a whole
  consistent chain. Same limit as `audit-chain.ts`.
- **Does not detect a truncated tail.** Deleting the LAST receipt leaves
  1…n−1 internally consistent, and nothing records how long the chain should be.
  `receipt-chain-verify.test.ts` pins this as a known limit rather than hiding it.
  Closing it needs a persisted head per tenant — the same work the execution chain
  needs, and not done.
- **Covers `result_summary` since the Oathrion rename, and did not before.** Sixteen
  fields now enter the hash, including the human-readable summary of the result —
  the one line an auditor reads first. It used to be stored *outside* the hashed
  body, so write access to the database was enough to rewrite that text without
  breaking verification, while every other field on the receipt was protected.
  Found while writing `verify:obs`, which had tampered with exactly that field to
  prove a break and correctly found none. Closing it **invalidated every chain
  written before the change** — the same class of consequence as altering the
  `\u0000` separator — which is why it was an owner's decision, taken before the
  first pilot, when it cost nothing. There is no honest catch-up migration:
  recomputing the hashes from the database would certify rows nobody watched being
  written, which is what the chain exists to prevent.

**Verification is O(n) and nothing purges receipts.** `npm run verify:soak` measured
**16 ms at one receipt and 251 ms at 11 220** over a twelve-minute run — a slope of about
**22 µs per receipt**, linear across the whole observed range. Extrapolating that slope
(and it is an extrapolation, not a measurement) gives ~2.2 s at 100 000 receipts and
**~22 s at one million**. The same cost is paid by `GET /api/actions/receipts/verify`,
which a customer calls over HTTP, and by the hourly `audit:chains` sweep. Closing it needs
either receipt retention (which does not exist) or an incremental verifier that trusts a
persisted head — and a persisted head is the same missing piece as the truncated-tail
limit above.

## What still carries a previous name

The product was renamed three times — AgentOS → ARIA, ARIA → Placet, then Placet →
Oathrion (27 October 2026) — and some strings deliberately did **not** follow. Every one
of them is a value that is already written somewhere we do not control, or that two
versions share while a deployment is being upgraded. `notes/RENOMMAGE-OATHRION.md` lists
them, and `server/test/rename-collisions.test.ts` fails if a later mechanical pass
renames one.

**Kept from Placet, on purpose:**

- **Markers already posted at the providers** — `<!-- placet-execution: … -->` on GitHub,
  `metadata[placet_execution]` on Stripe, `event_type: placet_execution` on Slack.
  Reconciliation reads them to recognise past actions. The *human-readable* Linear line
  now says "via Oathrion"; it is read by `exécution exe_…`, so both forms are recognised.
- **Idempotency keys** — `placet-<execution>` for Stripe and as the JSON-RPC id sent to a
  tool server, `sha256("placet:" + execution)` for Linear. A retry after the upgrade must
  present the same key, or the provider would act twice.
- **The canonical action form `placet.action.v1`** — it is inside every action hash, so
  inside every grant and receipt.
- **Database lock names** — `placet:receipts:…`, `placet:quota:executions:…`,
  `placet:spend:…`. During a rolling upgrade old and new instances must take the *same*
  lock, or they stop excluding each other.
- **Stored formats and identifiers** — `placetOAuth` inside sealed OAuth secrets, the
  Slack button ids `placet_approve` / `placet_approval:` of messages already posted, the
  connector policy ids `pol_placet_…`.
- **Deployment names** — the Compose project and image `placet-local`, the
  `placet` database, user and service, the `placet.env` / `placet.local.env` files, the
  `placet-*.dump` backups, `/etc/placet`, `/var/backups/placet`. Renaming a volume or a
  database means starting from an empty one.
- **Nothing else that a person reads.** Since 28 October 2026, the command is `oathrion`,
  the Python module is `oathrion`, the npm and PyPI packages are named `oathrion`, and the
  public site (`client/site/`) says Oathrion.

**Still accepted, as aliases, with the current name winning:** `PLACET_*` environment
variables (`server/env-compat.ts`, and in the shell scripts and Compose files, which have
no such shim), `X-Placet-*` headers — sent alongside `X-Oathrion-*` with identical values,
and read when the current name is absent (`shared/wire-headers.ts`) —, API keys with the
`placet_` prefix (a key is resolved by the hash of its whole value), `withPlacet` in
the framework adapter example (whose file is still `with-placet.ts`), and the Python module
`placet`, which re-exports `oathrion` with a `DeprecationWarning`.

**No longer honoured:** `ARIA_*` variables and `X-ARIA-*` headers, like `AGENTOS_*`
before them. Two generations at most: a three-way precedence is a rule nobody can state.
A deployment still configured in `ARIA_*` refuses to boot and names the missing variable.

**Renamed without alias:** the metrics (`placet_*` → `oathrion_*` — no external dashboard
was known), the cookies `oathrion_session`, `oathrion_sso_state`,
`oathrion_connector_state` (short-lived: a sign-in in progress during the upgrade has to
be restarted), the MCP server name announced to clients, the npm package name, and the
`User-Agent` sent to providers.

**Refused credentials keep every generation.** `FORBIDDEN_CREDENTIALS` still holds
`placet-demo`, `aria-demo` and `agentos-demo`, with their `-dev-key` siblings: a refused
secret stays refused across a rename.

**Login addresses still end in `.aria.local`** when derived, and **encrypted envelopes
still start with `aria-env-v1`**: both were kept at the previous rename for the reasons
written there, and nothing about this one changes them.

**The historical documents are not rewritten.** `ARIA-*.md`, the phase reports,
`notes/`, `docs/STRESS-TEST-LOG.md` and the readiness reports keep their names and their
contents: they describe what happened under the name of the time.

## Observability

**There is a metrics page, and it is deliberately narrow.** `GET /api/metrics`,
behind `OATHRION_METRICS_TOKEN`, emits 81 fixed series: nine counters and seven gauges.
`npm run verify:obs` provokes each of the four alertable conditions for real.

- **Cardinality is bounded by construction, not by discipline.** Every metric
  declares its labels *and the finite set of their values*; a value outside that set
  is filed under `other` and counted in `oathrion_metric_label_violations_total`. It is
  not rejected with an exception, because this code runs on a customer request path
  and monitoring must never be able to fail what it observes.
- **No tenant label, ever.** Two independent reasons: cardinality is unbounded in
  the number of customers, and a per-tenant label would hand the list of your
  customers — and their volume — to anyone who can read a dashboard. Per-tenant
  figures stay on the tenant's own `GET /api/usage` and
  `GET /api/actions/receipts/verify`.
- **No latency histogram, and so no quantiles.** A useful histogram needs buckets
  chosen from a distribution measured under real load, which does not exist for
  Oathrion. Invented buckets would produce credible-looking quantiles with nothing
  behind them. What is known is the ceiling: roughly 90–190 authenticated requests
  per second per instance.
- **No distributed tracing.** The correlation available is the per-request
  `requestId` in the logs.
- **`oathrion_rate_limit_store_reachable` does not probe.** It reports what the limiter
  observed on its *last* pass, so a deployment with no traffic keeps the last value,
  and scraping does not refresh it — the metrics page is a probe and does not go
  through the limiter. Alert on `increase()` of the counter instead; `ON-CALL.md`
  says so.
- **Two signals are outside Oathrion, structurally.** Backup freshness is about files
  Oathrion cannot see (`deploy/scripts/check-backup-freshness.sh`), and chain integrity
  would be a self-check (`npm run audit:chains`). Both are cron entries, with exit
  codes as the contract and `--prometheus` output for a textfile collector.

## Tenant identifiers (migration 18)

A tenant's identifier used to be derived from its name (`"Acme Corp"` →
`org_acme_corp`). It is now opaque — `org_` plus 20 random characters — and a name
is unique, which is what lets a name be looked up instead of computed. What that
costs, precisely:

**Existing tenants keep their derived identifier.** It is not rewritten, and will
not be. An organization identifier is referenced by seven tables *and by the audit
chain, which is append-only and tamper-evident*: rewriting it would mean rewriting audit
rows, which is exactly what the chain exists to make detectable. So a deployment
created before this migration still has identifiers that name its customers. Only
tenants created afterwards are opaque.

**The documented onboarding is now a transcript.** `DEPLOYMENT.md` §6bis was written
by running the whole sequence against the production bundle and a real PostgreSQL, and
it records what actually happened — including two traps the previous text did not
mention: a login example that could not work, and the fact that a console user declared
without an `Organisation/` prefix lands in the legacy `org_default` bucket rather than
in a tenant of its own.

**An opaque identifier has to be read somewhere, and today there is only one
place.** `OATHRION_DESTINATIONS` names the organizations allowed to use each
destination, and an operator could previously work that identifier out from the
company name. Now they cannot: the identifier exists only once the tenant does. The
sequence is therefore boot once (the tenant is created from `OATHRION_CONSOLE_USERS`),
read the identifier from the administrator's session (`GET /api/auth/session`), put
it in `OATHRION_DESTINATIONS`, restart. `npm run bootstrap:admin` prints it directly,
which is the shorter path. **No route lists organizations** — deliberately, since
one would hand every customer the names of all the others — so there is no
operator-facing listing until the administration API of chantier 1's next step.
`script/e2e-multitenant.ts` performs exactly this two-phase boot, so the cost is
reproduced rather than worked around.

**Two organizations cannot share a name.** The name is the key a tenant is found by
when a deployment restarts, so it carries a UNIQUE index on its normalised form.
The normalisation is **lowercase and trim only** — it does not collapse internal
whitespace, because migration 18's backfill has to apply the identical rule in SQL
on both engines (`lower` and `trim` exist on both, `regexp_replace` does not).
Consequence: `"Acme Corp"` and `"Acme  Corp"` (two spaces) are two different
organizations.

**Migration 18 fails on a database that already holds two equivalent names.** The
migration framework is pure SQL and synchronous, so it cannot read data to produce
a readable message; the engine's unique-violation error is what an operator would
see. This was first written here as unreachable on a database produced by this code —
the normalised name is *finer* than the old slug, so two equal keys implied the
same identifier and therefore one row. That was wrong on the first run of the
suite: a test fixture gave the same literal name to three organizations with
different identifiers, and the migration failed on the index. Writing one name for
two hand-picked identifiers is a real path, not a theoretical one. The fix, on a
test database or a real one, is to rename one of the two before starting again.

**User identifiers and API-key identifiers still embed the organization's name.**
The *tenant* identifier no longer leaks it, but two others do, and this step did not
change them (`server/auth.ts`): a console user configured without an e-mail address
gets the derived address `<name>@<organization-slug>.aria.local`, and a service key
from `OATHRION_API_KEYS` gets the identifier `svc:<organization-slug>/<name>`. Both
appear in logs and audit rows. Closing that is a separate change with its own
migration, since those identifiers are also referenced by existing rows.

## Documentation

The `.md` files at the repository root quote test counts from earlier phases and
are stale. `docs/` is current.

## Dependencies

`npm audit` reports **0 vulnerabilities** as of this checkpoint. Two advisories
present earlier in Phase 8 — `fast-uri` (high, via `@hookform/resolvers` → `ajv`)
and `qs` (moderate, via `express` → `body-parser`) — were resolved by patch
upgrades to `fast-uri@3.1.7` and `qs@6.16.0`. Lockfile-only change, no
`package.json` edit, no breaking version bumps, full suite green afterwards.

## Single sign-on (OIDC)

### Ce qui est éprouvé

Les **neuf algorithmes de signature annoncés** — RS256/384/512, PS256/384/512,
ES256/384/512 — sont éprouvés un par un avec de vraies clés générées à l'exécution,
quatre cas chacun : signature valide acceptée, signature d'une autre clé du même type
refusée, un octet retourné refusé, en-tête qui annonce un autre algorithme refusé. Le test
**itère sur la liste d'autorisation du code de production**, donc ajouter un algorithme
sans pouvoir le signer fait tomber la suite.

Ce garde existe à cause d'un défaut mesuré : la version précédente annonçait les neuf et
en éprouvait deux, et trois des sept non éprouvés (les PS*) **refusaient toute signature
valide**. Voir `docs/PILOT-READINESS.md` §5duodecies.

Les revendications vérifiées : `iss`, `aud` (chaîne ou tableau), **`azp` exigé dès que
`aud` est multiple** (OIDC Core §3.1.3.7 règle 3), `exp`, `iat`, **`nbf` honoré s'il est
présent**, `nonce`, `sub`, `email`, `email_verified`, et l'attestation d'authentification
forte par `acr` ou `amr`. La signature est vérifiée **avant** la lecture de toute
revendication.

### Ce qui n'est PAS éprouvé, et doit être lu avant un pilote

**Aucun fournisseur d'identité réel n'a été utilisé.** Les tests emploient un faux
fournisseur local qui signe de vrais jetons avec de vraies clés RSA et sert un vrai
document de découverte — ce qui prouve qu'Oathrion parle le protocole, et **non** qu'un
tenant Entra ID, Okta ou Google particulier se comporte comme sa documentation. Le premier
branchement chez un client reste la première vraie épreuve.

**SAML n'existe pas.** Un client qui n'a que du SAML ne peut pas se connecter par son
annuaire.

**Un seul émetteur à la fois.** `OATHRION_OIDC` est un objet unique. La liaison
`(issuer, sub)` laisse la place à un second fournisseur sans migration, mais la
configuration n'en accepte qu'un.

### Le SSO exige UNE SEULE INSTANCE

Les tentatives de connexion en cours (`state`, `nonce`) et les tickets de passage vivent
dans des `Map` **du processus**. Derrière plusieurs instances, un rappel qui atterrit sur
une autre instance que celle qui a ouvert la tentative est **REFUSÉ**.

La distinction compte pour qui lit une liste de risques : **le mode de panne est fermé.**
C'est une panne de disponibilité — une connexion échouée — et non une session usurpée.
Avec deux instances sans affinité de session, une connexion sur deux échoue, et le symptôme
est le pire des symptômes : intermittent, et il désigne le fournisseur d'identité plutôt
qu'Oathrion.

Le `docker-compose.yml` livré lance **une seule** instance `placet`, donc la configuration
livrée est correcte. Un avis de démarrage (`sso instance affinity:`) nomme la contrainte
pour qui la fera grossir ; au-delà d'une instance, exigez l'affinité de session sur
`/api/auth/sso` du répartiteur.

### Le refus de conflit d'identité a un coût d'exploitation

Si le fournisseur réémet un `sub` pour la **même** personne — annuaire reconstruit,
utilisateur re-provisionné, migration d'IdP — le compte devient inaccessible : l'adresse
désigne un compte déjà lié à une autre identité, et Oathrion refuse plutôt que de trancher
une question d'identité.

C'est voulu, et la sortie de secours existe : `ssoIdentityStore.unbind(issuer, subject)` ou
`unbindUser(issuer, userId)`. Sans elle, la procédure d'incident aurait été un `DELETE` à
la main en production. **Il n'y a pas encore d'écran de console pour cela** — c'est un
appel à faire depuis un script d'administration.

### Le ticket de passage, et ce qu'il implique

Le rappel ne rend pas de jeton : il rend un **ticket** opaque de 32 octets, valable 60
secondes, consommable une fois, et la session naît à l'**échange**. Ce qui voyage dans
l'URL est donc inutilisable une seconde fois — c'est exactement ce qu'est un code
d'autorisation OAuth.

Conséquence à connaître : un ticket non échangé ne laisse **aucune** session ouverte, mais
un utilisateur dont l'onglet se ferme pendant la redirection doit recommencer la connexion.
C'est le bon compromis, et il est explicite.

## Verified vs. not

Verified on the release machine: all 1741 JS tests across 85 files, 37 Python
tests, 21 PostgreSQL migration tests against a real server, typecheck, lint,
build, secret scan, and every example in `examples/` executed end to end.

### Agent frameworks

The [adapter](../examples/framework-adapter/) is framework-agnostic, and that claim now
has three different kinds of evidence behind it rather than one assertion:

- **No dependency, proved structurally.** The adapter imports exactly one module — this
  repository's own SDK — and names no framework outside its comments.
  `with-placet.test.ts` asserts both by reading the source. This is the only evidence
  that does not expire: enumerating frameworks that work says nothing about the one
  released next month, while an absence of dependency stays true.
- **Every shape a framework gives to "execute", tested**: `execute` (Vercel's ai SDK),
  `invoke` and `func` (LangChain, LangGraph), `call` (LlamaIndex), `run`, `_run`
  (CrewAI's convention), and a bare function. Each is proved to run on ALLOW and **not**
  to run on APPROVAL_REQUIRED.
- **One real framework**, `@langchain/core` 1.2.9: a genuine `DynamicStructuredTool`,
  wrapped directly and invoked. When the package is absent these tests **skip with a
  printed reason** rather than passing quietly.

What is still **NOT VERIFIED**, stated precisely: the shape tests use objects written by
hand from each framework's published API. **A shape is not the framework.** They prove the
adapter wraps that signature correctly; they do not prove a given version of LlamaIndex or
CrewAI behaves as its documentation says. Only LangChain is loaded as real third-party
code.

Two defects this work found in the previous adapter, both of which had compiled fine:

- it required a method named `execute`, which is Vercel's ai SDK convention and nobody
  else's. Using it with LangChain meant hand-writing an `{ name, execute }` shim — the
  client paying for an adaptation the adapter claimed to provide;
- it rebuilt `{ name, execute }` and discarded everything else, so a wrapped LangChain
  tool lost its `schema` and LangChain refused to call it.

It now wraps whichever method it finds, forwards **all** arguments (LangChain calls
`invoke(input, config)`), preserves the prototype, and calls the method on the original
object so `this` is what it expects. Each of those four points is pinned by a mutant that
fails without it.
