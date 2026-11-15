/**
 * Les mandats d'une organisation (`server/mandates.ts`), sur une vraie base créée par la
 * migration 30 : créés, signés par chaque personne avec SA clé (comme son navigateur le fait),
 * actifs, autorisés dans leurs limites et leurs cumuls, révoqués — et le mandat exporté passe la
 * vérification d'une banque.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countersign, fingerprintOfKey, presentGrant, publicKeyOf, verifyDualReceipt, verifyPresentation, verifyStatus, type MandateAction } from "@shared/mandate";
import { canonical } from "@shared/receipt-share";
import type { OrganizationId } from "@shared/tenancy";

import { resetVaultKeyring } from "../connectors/vault";
import { MandateError, MandateService } from "../mandates";
import { mandates } from "../migrations/030-mandates";
import { mandateReceipts } from "../migrations/031-mandate-receipts";
import { sqliteExecutor } from "../sql/executor";

const ORG = "org_acme000000000000000000" as OrganizationId;
const OTHER = "org_other00000000000000000" as OrganizationId;
const WITH_KEK = { OATHRION_KEK: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;
const NOW = new Date("2026-12-10T10:00:00.000Z");
const key = (): KeyObject => generateKeyPairSync("ed25519").privateKey;

let database: Database.Database;

beforeEach(() => {
  resetVaultKeyring();
  database = new Database(":memory:");
  for (const migration of [mandates, mandateReceipts]) {
    for (const statement of migration.statements({ dialect: "sqlite", tableExists: () => false, columns: () => new Set<string>() })) database.exec(statement);
  }
});
afterEach(() => {
  database.close();
  resetVaultKeyring();
});

const pay = (value: number): MandateAction => ({ type: "payment.transfer", destination: "bank:acme-main", amount: { value, currency: "EUR" }, beneficiary: "FR76", purpose: "supplier invoices" });

async function acme(env: NodeJS.ProcessEnv = WITH_KEK) {
  const service = new MandateService(sqliteExecutor(database), ORG, env);
  const keys = { awa: key(), moussa: key(), agent: key() };
  await service.registerSignerKey("awa", publicKeyOf(keys.awa), NOW);
  await service.registerSignerKey("moussa", publicKeyOf(keys.moussa), NOW);
  const created = await service.create(
    {
      agent: { id: "agt_ap", name: "Accounts payable", publicKey: publicKeyOf(keys.agent) },
      grants: [{ actions: ["payment.transfer"], constraints: { maxAmount: { value: 5_000, currency: "EUR" }, periodCap: { value: 10_000, currency: "EUR", period: "P1M" } } }],
      notBefore: "2026-12-01T00:00:00.000Z",
      notAfter: "2027-03-31T00:00:00.000Z",
      required: 2,
      signers: [{ userId: "awa", role: "CFO" }, { userId: "moussa", role: "Controller" }],
    },
    "user:admin",
    "https://oathrion.acme.example/status",
    NOW,
  );
  /* Ce que fait le navigateur de chaque signataire : signer la forme canonique du mandat. */
  const signAs = (who: "awa" | "moussa") => sign(null, Buffer.from(canonical(created.signed.mandate), "utf8"), keys[who]).toString("base64");
  return { service, keys, created, signAs };
}

describe("le cycle d'un mandat", () => {
  it("créé en attente ; actif à la deuxième signature ; une signature étrangère refusée", async () => {
    const { service, created, signAs, keys } = await acme();
    expect(created).toMatchObject({ state: "pending", required: 2, signedBy: [] });
    expect((await service.sign(created.id, "awa", signAs("awa"), NOW)).state).toBe("pending");
    await expect(service.sign(created.id, "moussa", sign(null, Buffer.from("autre chose"), keys.moussa).toString("base64"), NOW)).rejects.toThrow(/not yours, or not on this mandate/);
    await expect(service.sign(created.id, "eve", signAs("awa"), NOW)).rejects.toThrow(/not one of this mandate's signers/);
    const active = await service.sign(created.id, "moussa", signAs("moussa"), NOW);
    expect(active).toMatchObject({ state: "active", signedBy: ["awa", "moussa"] });
  });

  it("un signataire sans clé ne peut pas être nommé ; sans coffre, pas de mandat, et c'est dit", async () => {
    const { service } = await acme();
    await expect(
      service.create({ agent: { id: "a", name: "A", publicKey: publicKeyOf(key()) }, grants: [{ actions: ["x"] }], notBefore: "2026-12-01T00:00:00Z", notAfter: "2027-01-01T00:00:00Z", required: 1, signers: [{ userId: "nokey" }] }, "u", "s", NOW),
    ).rejects.toThrow(/has no signing key yet/);
    resetVaultKeyring();
    await expect(acme({} as NodeJS.ProcessEnv)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/OATHRION_KEK/) });
  });

  it("une autre organisation ne voit rien", async () => {
    const { created } = await acme();
    await expect(new MandateService(sqliteExecutor(database), OTHER, WITH_KEK).get(created.id)).rejects.toBeInstanceOf(MandateError);
  });
});

describe("autoriser une action, puis la banque vérifie", () => {
  it("en attente : refusé ; actif : 3 200 € autorisé, et le mandat exporté passe chez la banque ; le cumul est tenu ; révoqué : refusé et publié", async () => {
    const { service, created, signAs, keys } = await acme();
    await expect(service.grant(created.id, "agt_ap", pay(100), NOW)).rejects.toThrow(/signed by 0 of the 2 people/);
    await service.sign(created.id, "awa", signAs("awa"), NOW);
    await service.sign(created.id, "moussa", signAs("moussa"), NOW);
    await expect(service.grant(created.id, "agt_other", pay(100), NOW)).rejects.toThrow(/not this agent's/);
    await expect(service.grant(created.id, "agt_ap", pay(7_000), NOW)).rejects.toThrow(/above the mandate's 5,000 EUR per action/);

    const issued = await service.grant(created.id, "agt_ap", pay(3_200), NOW);
    const exported = (await service.get(created.id, NOW)).signed;
    const status = verifyStatus(await service.statusList(NOW), exported.mandate.issuer.publicKey);
    const bank = { trustedIssuers: [fingerprintOfKey(exported.mandate.issuer.publicKey)], now: NOW, status, seenNonce: () => false };
    expect(verifyPresentation(exported, presentGrant(issued, keys.agent), pay(3_200), bank)).toEqual({ ok: true });

    await service.grant(created.id, "agt_ap", pay(4_000), NOW);
    await expect(service.grant(created.id, "agt_ap", pay(4_000), NOW)).rejects.toThrow(/above the mandate's 10,000 EUR per period \(7,200 EUR already used\)/);

    await service.revoke(created.id, "user:awa", NOW);
    await expect(service.grant(created.id, "agt_ap", pay(100), NOW)).rejects.toThrow(/has been revoked/);
    const revoked = verifyStatus(await service.statusList(NOW), exported.mandate.issuer.publicKey);
    expect(verifyPresentation(exported, presentGrant(issued, keys.agent), pay(3_200), { ...bank, status: revoked })).toEqual({ ok: false, reason: "the mandate has been revoked" });
  });
});

describe("les reçus contresignés, dans la chaîne de l'organisation", () => {
  it("rapportés par l'agent, vérifiés, enchaînés ; un doublon, un reçu d'une autre action refusés ; une modification en base se voit", async () => {
    const { service, created, signAs, keys } = await acme();
    await service.sign(created.id, "awa", signAs("awa"), NOW);
    await service.sign(created.id, "moussa", signAs("moussa"), NOW);
    const bankKey = key();
    const report = async (value: number, executed = true) => {
      const grant = presentGrant(await service.grant(created.id, "agt_ap", pay(value), NOW), keys.agent);
      const countersigned = countersign(grant, executed ? { executed: true } : { executed: false, reason: "insufficient funds" }, { name: "Example Bank", key: bankKey }, NOW);
      return { grant, countersigned, recorded: await service.recordReceipt(created.id, "agt_ap", { grant, countersigned }, NOW) };
    };
    const first = await report(3_200);
    expect(first.recorded.seq).toBe(1);
    expect((await report(1_000, false)).recorded.seq).toBe(2);

    await expect(service.recordReceipt(created.id, "agt_ap", { grant: first.grant, countersigned: first.countersigned }, NOW)).rejects.toThrow(/already recorded/);
    const other = await service.grant(created.id, "agt_ap", pay(50), NOW);
    await expect(service.recordReceipt(created.id, "agt_ap", { grant: presentGrant(other, keys.agent), countersigned: first.countersigned }, NOW)).rejects.toThrow(/receipt is for another action/);
    await expect(service.recordReceipt(created.id, "agt_other", { grant: first.grant, countersigned: first.countersigned }, NOW)).rejects.toThrow(/not this agent's/);

    const receipts = await service.receipts(created.id);
    expect(receipts.map((r) => [r.seq, r.countersigned.statement.outcome])).toEqual([[1, "executed"], [2, "refused"]]);
    const exported = (await service.get(created.id, NOW)).signed;
    expect(verifyDualReceipt({ mandate: exported, grant: receipts[0]!.grant, countersigned: receipts[0]!.countersigned }, { trustedIssuers: [fingerprintOfKey(exported.mandate.issuer.publicKey)] })).toEqual({ ok: true });
    expect(await service.verifyReceiptChain()).toEqual({ ok: true, entries: 2, brokenAt: null, reason: null });

    /* Quelqu'un réécrit l'issue d'un reçu directement en base : la chaîne le dit. */
    database.prepare("UPDATE mandate_receipts SET document = replace(document, '\"executed\"', '\"refused\"') WHERE entry_seq = 1").run();
    expect(await service.verifyReceiptChain()).toMatchObject({ ok: false, brokenAt: 1, reason: "a receipt was changed after it was recorded" });
  });
});

/*
 * TEST DE CHARGE DU 9 NOVEMBRE : le cumul du mois était lu, l'autorisation signée, puis écrite,
 * sans verrou entre les deux. Des paiements SIMULTANÉS lisaient tous le même cumul, et
 * dépassaient ensemble le plafond mensuel.
 */
describe("le plafond du mois sous des paiements simultanés", () => {
  it("cinq paiements de 4 000 € en même temps, plafond de 10 000 € : deux passent, trois sont refusés", async () => {
    const { service, created, signAs } = await acme();
    await service.sign(created.id, "awa", signAs("awa"), NOW);
    await service.sign(created.id, "moussa", signAs("moussa"), NOW);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.grant(created.id, "agt_ap", pay(4_000), NOW)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(String(r.reason)).toMatch(/above the mandate's 10,000 EUR per period/);
  });
});
