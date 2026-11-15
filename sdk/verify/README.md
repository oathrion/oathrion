# @oathrion/verify

Accept actions from AI agents that carry an Oathrion mandate, and check Oathrion receipts.
Free, no dependency (only `node:crypto`), no network: everything is checked on your side.

## What an agent presents

With its request, an agent sends two headers:

- `Oathrion-Mandate`: what it may do, on behalf of whom, signed by its organization and by the
  people who authorized it (for example the CFO and a controller);
- `Oathrion-Grant`: an authorization for **this** action only, issued minutes ago by its
  organization's Oathrion (which also enforces monthly caps), and signed by the agent's own key.

## What you do before executing

```ts
import { countersign, verifyRequest, verifyStatus } from "./sdk/verify/src";

const check = verifyRequest(req.headers, action, {
  trustedIssuers: ["2e66 b482 4f26 7dbc 68fe b626 b3dd 3d05"], // pinned when you took the client
  now: new Date(),
  status: verifyStatus(revocationList, issuerPublicKey),        // fetched, cached a few minutes
  seenNonce: (nonce) => nonces.has(nonce),                       // each authorization works once
});
if (!check.ok) refuse(check.reason); // « above the mandate's 5,000 EUR per action », « revoked »…
```

It checks the mandate (pinned issuer, enough signatures, validity, not revoked — a mandate that
names a revocation list is refused if you have not read it recently), the authorization (from
that issuer, for that mandate, for exactly this action, not expired, never seen), the agent's
key, and the action against the mandate (action, destination, amount, beneficiary, purpose).

## What you return

```ts
const receipt = countersign(check.grant, { executed: true }, { name: "Example Bank", key }, new Date());
```

A countersigned receipt: neither side can deny the action afterwards. A refusal is
countersigned too, with its reason.

For an auditor, `verifyDualReceipt({ mandate, grant, countersigned }, { trustedIssuers })` checks
the three together, without Oathrion: the issuer signed the mandate and the authorization, the
agent presented it, the counterparty signed its receipt, and all three are about the same action.
`trustedIssuers` (the fingerprints of the organizations you expect) is required: without it,
anyone could make a mandate, an authorization and a receipt with keys of their own, and all three
would verify. `trustedCounterparties` pins the counterparty too, if you know its fingerprint.

A complete counterparty is in [`examples/mandate-bank`](../../examples/mandate-bank/README.md).

## What it proves, and does not

That the mandate was signed by the people it names and attested by the issuer you pinned, that
this action is within it, and that the agent holds the mandate's key. Not that the people were
entitled to sign under your contracts or your law: that is the enrolment you do once, when you
pin the issuer.
