/**
 * Le mandat vérifiable (`shared/mandate.ts`), de bout en bout : la banque d'Acme accepte 3 200 €,
 * refuse elle-même 7 000 €, refuse un mandat révoqué, une autorisation rejouée, un agent qui n'a
 * pas la clé, une action changée — et contresigne ce qu'elle a fait.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  actionHash,
  checkAction,
  countersign,
  fingerprintOfKey,
  issueGrant,
  issueMandate,
  MANDATE_TYPE,
  presentGrant,
  publicKeyOf,
  signMandate,
  signStatus,
  verifyCountersigned,
  verifyDualReceipt,
  verifyMandate,
  verifyPresentation,
  verifyStatus,
  type Mandate,
  type MandateAction,
  type SignedMandate,
} from "./mandate";
import { canonical } from "./canonical";

const key = (): KeyObject => generateKeyPairSync("ed25519").privateKey;
const NOW = new Date("2026-12-10T10:00:00.000Z");

function world() {
  const keys = { issuer: key(), agent: key(), awa: key(), moussa: key(), bank: key(), stranger: key() };
  const mandate: Mandate = {
    type: MANDATE_TYPE,
    id: "mdt_acme_ap",
    issuer: { organization: "Acme", publicKey: publicKeyOf(keys.issuer) },
    agent: { id: "agt_compta", name: "Comptabilité", publicKey: publicKeyOf(keys.agent) },
    grants: [
      {
        actions: ["payment.transfer"],
        destinations: ["bank:acme-main"],
        constraints: {
          maxAmount: { value: 5_000, currency: "EUR" },
          periodCap: { value: 50_000, currency: "EUR", period: "P1M" },
          beneficiaries: ["FR7630006000011234567890189"],
          purpose: "supplier invoices",
        },
      },
    ],
    validity: { notBefore: "2026-12-01T00:00:00.000Z", notAfter: "2027-03-31T23:59:59.000Z" },
    approval: {
      required: 2,
      of: [
        { id: "awa@acme", role: "CFO", publicKey: publicKeyOf(keys.awa) },
        { id: "moussa@acme", role: "Controller", publicKey: publicKeyOf(keys.moussa) },
      ],
    },
    status: { url: "https://oathrion.acme.example/mandates/status", index: 4127 },
  };
  let signed = issueMandate(mandate, keys.issuer);
  signed = signMandate(signed, "awa@acme", keys.awa);
  signed = signMandate(signed, "moussa@acme", keys.moussa);
  const issuer = fingerprintOfKey(mandate.issuer.publicKey);
  const status = verifyStatus(signStatus([12, 99], keys.issuer, NOW), mandate.issuer.publicKey);
  const pay = (value: number, over: Partial<MandateAction> = {}): MandateAction => ({
    type: "payment.transfer",
    destination: "bank:acme-main",
    amount: { value, currency: "EUR" },
    beneficiary: "FR7630006000011234567890189",
    purpose: "supplier invoices",
    reference: "F-2026-114",
    ...over,
  });
  const used = new Set<string>();
  const options = { trustedIssuers: [issuer], now: NOW, status, seenNonce: (nonce: string) => used.has(nonce) };
  /* L'Oathrion d'Acme autorise l'action ; l'agent présente l'autorisation avec sa clé. */
  const present = (action: MandateAction, nonce = `n_${String(Math.random())}`, agentKey = keys.agent) =>
    presentGrant(issueGrant(signed, action, keys.issuer, { now: NOW, id: `grt_${nonce}`, nonce }), agentKey);
  return { keys, signed, issuer, status, pay, used, options, present };
}

describe("le mandat : signé par l'émetteur et par 2 personnes sur 2", () => {
  it("il est valide ; une seule signature ne suffit pas ; une clé de signataire remplacée non plus", () => {
    const { signed, options, keys } = world();
    expect(verifyMandate(signed, options)).toEqual({ ok: true });
    expect(verifyMandate({ ...signed, signatures: signed.signatures.slice(0, 1) }, options)).toEqual({ ok: false, reason: "the mandate is signed by 1 of the 2 people it needs" });
    expect(() => signMandate(signed, "moussa@acme", keys.stranger)).toThrow(/not a signer of this mandate/);
  });

  it("un plafond relevé après signature : l'émetteur ne l'a pas signé", () => {
    const { signed, options } = world();
    const raised: SignedMandate = structuredClone(signed);
    raised.mandate.grants[0]!.constraints!.maxAmount!.value = 500_000;
    expect(verifyMandate(raised, options)).toEqual({ ok: false, reason: "the mandate was changed after its issuer signed it" });
  });

  it("un émetteur que la banque ne connaît pas, un mandat expiré, révoqué, une liste de révocation absente ou trop vieille : refusés", () => {
    const { signed, options, keys } = world();
    expect(verifyMandate(signed, { ...options, trustedIssuers: ["ffff 0000"] })).toMatchObject({ ok: false, reason: expect.stringMatching(/not one this counterparty trusts/) });
    expect(verifyMandate(signed, { ...options, now: new Date("2027-04-01T00:00:00.000Z") })).toMatchObject({ ok: false, reason: "the mandate has expired" });
    const revoked = verifyStatus(signStatus([4127], keys.issuer, NOW), signed.mandate.issuer.publicKey);
    expect(verifyMandate(signed, { ...options, status: revoked })).toEqual({ ok: false, reason: "the mandate has been revoked" });
    expect(verifyMandate(signed, { ...options, status: undefined })).toEqual({ ok: false, reason: "the mandate's revocation list was not checked" });
    const old = verifyStatus(signStatus([], keys.issuer, new Date("2026-12-09T00:00:00.000Z")), signed.mandate.issuer.publicKey);
    expect(verifyMandate(signed, { ...options, status: old })).toEqual({ ok: false, reason: "the revocation list is too old to rely on" });
  });

  it("une liste de révocation signée par quelqu'un d'autre n'est pas lue", () => {
    const { keys, signed } = world();
    expect(verifyStatus(signStatus([], keys.stranger, NOW), signed.mandate.issuer.publicKey)).toBeNull();
  });
});

describe("ce que le mandat permet", () => {
  it.each([
    [3_200, {}, null],
    [7_000, {}, "above the mandate's 5,000 EUR per action"],
    [100, { beneficiary: "FR0000000000000000000000000" }, "the beneficiary is not one the mandate allows"],
    [100, { amount: { value: 100, currency: "XOF" } }, "the mandate needs an amount in EUR"],
    [100, { purpose: "salaries" }, "the mandate is for « supplier invoices » only"],
    [100, { destination: "bank:other" }, "the mandate does not allow « bank:other » as a destination"],
    [100, { type: "payment.refund" }, "the mandate does not allow « payment.refund »"],
  ] as const)("%s € %o → %s", (value, over, reason) => {
    const { signed, pay } = world();
    expect(checkAction(signed.mandate, pay(value, over as Partial<MandateAction>))).toEqual(reason ? { ok: false, reason } : { ok: true });
  });

  it("le cumul du mois : l'émetteur le fait respecter en n'autorisant pas l'action", () => {
    const { signed, pay, keys } = world();
    expect(() => issueGrant(signed, pay(4_000), keys.issuer, { now: NOW, id: "g", nonce: "n", spent: { value: 47_000, currency: "EUR" } })).toThrow(/above the mandate's 50,000 EUR per period \(47,000 EUR already used\)/);
  });
});

describe("chez la banque, avant d'exécuter", () => {
  it("3 200 € : accepté, et la banque contresigne", () => {
    const { pay, present, signed, options, keys } = world();
    const presented = present(pay(3_200), "n1");
    expect(verifyPresentation(signed, presented, pay(3_200), options)).toEqual({ ok: true });
    const receipt = countersign(presented, { executed: true }, { name: "Banque Exemple", key: keys.bank }, NOW);
    expect(receipt.statement).toMatchObject({ outcome: "executed", mandateId: "mdt_acme_ap", actionHash: actionHash(pay(3_200)) });
    expect(verifyCountersigned(receipt, [fingerprintOfKey(publicKeyOf(keys.bank))])).toEqual({ ok: true });
    const forged = structuredClone(receipt);
    forged.statement.outcome = "refused";
    expect(verifyCountersigned(forged)).toEqual({ ok: false, reason: "the receipt was changed after the counterparty signed it" });
  });

  it("7 000 € : l'Oathrion d'Acme n'émet pas d'autorisation ; une autorisation forgée par l'agent est refusée par la banque", () => {
    const { pay, keys, signed, options, present } = world();
    expect(() => present(pay(7_000))).toThrow(/above the mandate's 5,000 EUR per action/);
    /* L'agent change le montant d'une autorisation de 3 200 € : ce n'est plus la même action. */
    const presented = present(pay(3_200), "n2");
    const tampered = presentGrant({ grant: { ...presented.grant, action: pay(7_000) }, issuerSignature: presented.issuerSignature }, keys.agent);
    expect(verifyPresentation(signed, tampered, pay(7_000), options)).toEqual({ ok: false, reason: "the authorization was not issued by the mandate's issuer, or was changed" });
    expect(verifyPresentation(signed, presented, pay(7_000), options)).toEqual({ ok: false, reason: "the authorization is for another action" });
  });

  it("un mandat volé, présenté par un autre agent : refusé", () => {
    const { pay, present, signed, options, keys } = world();
    expect(verifyPresentation(signed, present(pay(3_200), "n3", keys.stranger), pay(3_200), options)).toEqual({ ok: false, reason: "the agent presenting it does not hold the mandate's key" });
  });

  it("une autorisation rejouée, ou expirée : refusée", () => {
    const { pay, present, signed, options, used } = world();
    const presented = present(pay(3_200), "n4");
    used.add("n4");
    expect(verifyPresentation(signed, presented, pay(3_200), options)).toEqual({ ok: false, reason: "the authorization was already used" });
    used.clear();
    expect(verifyPresentation(signed, presented, pay(3_200), { ...options, now: new Date(NOW.getTime() + 10 * 60_000) })).toEqual({ ok: false, reason: "the authorization has expired" });
  });

  it("un refus aussi se contresigne : la raison est dans le reçu", () => {
    const { pay, present, keys } = world();
    const receipt = countersign(present(pay(100), "n5"), { executed: false, reason: "insufficient funds" }, { name: "Banque Exemple", key: keys.bank }, NOW);
    expect(receipt.statement).toMatchObject({ outcome: "refused", reason: "insufficient funds" });
    expect(verifyCountersigned(receipt)).toEqual({ ok: true });
  });
});

describe("le reçu à double signature, gardé par l'organisation", () => {
  it("le mandat, l'autorisation de l'émetteur, le reçu de la banque : la même action, vérifiée sans Oathrion", () => {
    const { pay, present, signed, keys, issuer } = world();
    const grant = present(pay(3_200), "d1");
    const countersigned = countersign(grant, { executed: true }, { name: "Example Bank", key: keys.bank }, NOW);
    const bank = fingerprintOfKey(publicKeyOf(keys.bank));
    expect(verifyDualReceipt({ mandate: signed, grant, countersigned }, { trustedIssuers: [issuer], trustedCounterparties: [bank] })).toEqual({ ok: true });

    /* Le reçu d'une autre action, glissé à côté de cette autorisation : refusé. */
    const other = countersign(present(pay(100), "d2"), { executed: true }, { name: "Example Bank", key: keys.bank }, NOW);
    expect(verifyDualReceipt({ mandate: signed, grant, countersigned: other }, { trustedIssuers: [issuer] })).toEqual({ ok: false, reason: "the counterparty's receipt is for another action" });
    /* Une autorisation forgée par l'agent seul : l'émetteur ne l'a pas signée. */
    const forged = { ...grant, grant: { ...grant.grant, action: pay(9_999) } };
    expect(verifyDualReceipt({ mandate: signed, grant: forged, countersigned }, { trustedIssuers: [issuer] })).toMatchObject({ ok: false, reason: expect.stringMatching(/changed after its issuer signed it/) });
  });
});

/*
 * L'AUDIT DU 8 NOVEMBRE : ce qu'un émetteur maladroit, ou un document abîmé, faisait passer.
 * La vérification échoue fermée, avec sa raison.
 */
describe("l'audit du 8 novembre : la vérification échoue fermée", () => {
  const resign = (mandate: Mandate, keys: ReturnType<typeof world>["keys"], signers: [string, KeyObject][]) => {
    let signed = issueMandate(mandate, keys.issuer);
    for (const [id, k] of signers) signed = signMandate(signed, id, k);
    return signed;
  };

  it("des dates illisibles ne font pas un mandat sans limite", () => {
    const { keys, signed, options } = world();
    const forever = resign({ ...signed.mandate, validity: { notBefore: "2026-12-01T00:00:00.000Z", notAfter: "never" } }, keys, [["awa@acme", keys.awa], ["moussa@acme", keys.moussa]]);
    expect(verifyMandate(forever, options)).toEqual({ ok: false, reason: "the mandate's validity dates are not readable" });
  });

  it("une même personne sous deux noms compte pour une seule signature", () => {
    const { keys, signed, options } = world();
    const twice: Mandate = { ...signed.mandate, approval: { required: 2, of: [{ id: "awa@acme", publicKey: publicKeyOf(keys.awa) }, { id: "awa.bis@acme", publicKey: publicKeyOf(keys.awa) }] } };
    expect(verifyMandate(resign(twice, keys, [["awa@acme", keys.awa], ["awa.bis@acme", keys.awa]]), options)).toMatchObject({ ok: false, reason: expect.stringMatching(/signed by 1 of the 2 people/) });
  });

  it("un montant qui n'est pas un nombre positif ne passe sous aucun plafond", () => {
    const { signed, pay } = world();
    for (const value of ["abc", -5_000, Number.NaN] as unknown as number[]) {
      expect(checkAction(signed.mandate, pay(value))).toEqual({ ok: false, reason: "the amount is not a valid positive number" });
    }
  });

  it("une autorisation aux dates illisibles, une liste de révocation à la date illisible : refusées", () => {
    const { keys, signed, pay, options, present } = world();
    const presented = present(pay(3_200));
    const grant = { ...presented.grant, notAfter: "later" };
    const resigned = { grant, issuerSignature: sign(null, Buffer.from(canonical(grant)), keys.issuer).toString("base64"), agentSignature: sign(null, Buffer.from(canonical(grant)), keys.agent).toString("base64") };
    expect(verifyPresentation(signed, resigned, pay(3_200), options)).toEqual({ ok: false, reason: "the authorization's dates are not readable" });
    const status = { type: "oathrion.status/v0", issuer: fingerprintOfKey(signed.mandate.issuer.publicKey), updatedAt: "today", revoked: [] };
    const read = verifyStatus({ status, signature: sign(null, Buffer.from(canonical(status)), keys.issuer).toString("base64") } as never, signed.mandate.issuer.publicKey);
    expect(verifyMandate(signed, { ...options, status: read })).toMatchObject({ ok: false });
  });

  it("un document abîmé est un refus, pas une exception chez la contrepartie", () => {
    const { signed, pay, options } = world();
    expect(verifyMandate({} as never, options)).toMatchObject({ ok: false });
    expect(verifyMandate({ ...signed, signatures: "x" } as never, options)).toEqual({ ok: false, reason: "the document is malformed" });
    expect(verifyPresentation(signed, {} as never, pay(3_200), options)).toMatchObject({ ok: false });
    expect(verifyDualReceipt(null as never, { trustedIssuers: [] })).toMatchObject({ ok: false });
    /* Sans émetteur attendu : refusé, même si tout est signé. */
    expect(verifyDualReceipt({ mandate: signed, grant: {} as never, countersigned: {} as never }, undefined as never)).toMatchObject({ ok: false });
    expect(verifyCountersigned({ statement: { type: "oathrion.countersigned/v0" } } as never)).toMatchObject({ ok: false });
    expect(verifyStatus({ status: { revoked: 3 } } as never, signed.mandate.issuer.publicKey)).toBeNull();
  });
});
