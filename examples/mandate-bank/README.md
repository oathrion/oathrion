# A bank that checks the agent's mandate

An agent of Acme pays supplier invoices. Its mandate — up to 5,000 EUR each, 50,000 EUR a month,
to one IBAN, signed by the CFO and a controller — travels with each payment. The bank checks
everything itself, before executing, and countersigns what it did.

```bash
npx tsx examples/mandate-bank/demo.ts          # --slow: paced for a screen recording
```

1. 3,200 EUR: executed, countersigned receipt.
2. 7,000 EUR: Acme's Oathrion does not authorize it (« above the mandate's 5,000 EUR per action »).
3. The agent forges it, presenting a valid 900 EUR authorization for 7,000 EUR: **the bank**
   refuses (« the authorization is for another action »).
4. The agent keeps an authorization, then the CFO revokes the mandate.
5. The agent presents the kept authorization: **the bank** refuses (« the mandate has been
   revoked »).

Acme keeps every answer with its own authorization: a receipt signed by both sides
(`verifyDualReceipt`), that neither can deny.

- [`bank.ts`](bank.ts): what a counterparty integrates — [`@oathrion/verify`](../../sdk/verify/README.md),
  a pinned issuer fingerprint, the issuer's revocation list, a store of used authorizations.
- [`acme.ts`](acme.ts): the issuer side, reduced to the essentials (in the product, Oathrion's
  team version).
- [`demo.ts`](demo.ts): the scenario; [`demo.test.ts`](demo.test.ts) plays it in the test suite.
