/**
 * Les routes du mandat vérifiable, par HTTP, sur le vrai serveur : deux personnes enregistrent la
 * clé publique de leur navigateur, un administrateur crée le mandat, chacune le signe, l'agent —
 * avec SA clé liée — obtient une autorisation dans les limites, la liste de révocation est
 * publique, une autre organisation ne voit rien, et une révocation est aussitôt publiée.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countersign, fingerprintOfKey, presentGrant, publicKeyOf, verifyDualReceipt, verifyPresentation, verifyStatus, type Grant, type MandateAction, type SignedMandate, type SignedStatus } from "@shared/mandate";
import { canonical } from "@shared/receipt-share";
import { organizationId } from "@shared/tenancy";

import { resetVaultKeyring } from "../connectors/vault";
import { hashPassword } from "../passwords";
import { userStore } from "../repositories/users";
import { OTHER_ORG_KEYS, startTestServer, TEST_API_KEY, TEST_CONSOLE_EMAIL, TEST_CONSOLE_PASSWORD, type TestClient } from "./harness";

const ORG = organizationId("org_default");
const CONTROLLER = { email: "controller-mandates@placet.test", password: "controller-password-long" };
type View = { id: string; state: string; signed: SignedMandate; signedBy: string[] };

let api: TestClient;
const tokens: Record<"admin" | "controller", string> = { admin: "", controller: "" };
const keys = { admin: generateKeyPairSync("ed25519").privateKey, controller: generateKeyPairSync("ed25519").privateKey, agent: generateKeyPairSync("ed25519").privateKey };
const pay = (value: number): MandateAction => ({ type: "payment.transfer", amount: { value, currency: "EUR" } });

beforeAll(async () => {
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  resetVaultKeyring();
  api = await startTestServer();
  (await import("../repositories")).seedIfEmpty?.();
  const controller = userStore.ensure({ email: CONTROLLER.email, name: "Controller", passwordHash: hashPassword(CONTROLLER.password), passwordSource: "user" });
  userStore.grant(ORG, controller.id, "approver");
  for (const [who, email, password] of [["admin", TEST_CONSOLE_EMAIL, TEST_CONSOLE_PASSWORD], ["controller", CONTROLLER.email, CONTROLLER.password]] as const) {
    const login = await api.post<{ token: string }>("/api/auth/login", { email, password, organization: ORG }, { auth: null });
    expect(login.status).toBe(200);
    tokens[who] = login.body.token;
  }
}, 60_000);

afterAll(async () => {
  await api.close();
  delete process.env.OATHRION_KEK;
  resetVaultKeyring();
});

describe("le mandat, par HTTP", () => {
  it("de la clé du navigateur au paiement autorisé, à la révocation publiée", async () => {
    const me: Record<"admin" | "controller", string> = { admin: "", controller: "" };
    for (const who of ["admin", "controller"] as const) {
      const put = await api.put<{ signingKey: string }>("/api/mandates/signing-key", { publicKey: publicKeyOf(keys[who]) }, { auth: tokens[who] });
      expect(put.status).toBe(200);
      me[who] = (await api.get<{ me: string; signingKey: string }>("/api/mandates", { auth: tokens[who] })).body.me;
    }
    /* Une clé d'API n'est pas une personne : elle ne signe pas. */
    expect((await api.put("/api/mandates/signing-key", { publicKey: publicKeyOf(keys.admin) }, { auth: TEST_API_KEY })).status).toBe(403);

    const created = await api.post<View>(
      "/api/mandates",
      {
        agent: { id: "agt_billing", name: "Billing", publicKey: publicKeyOf(keys.agent) },
        grants: [{ actions: ["payment.transfer"], constraints: { maxAmount: { value: 5_000, currency: "EUR" } } }],
        notBefore: new Date(Date.now() - 60_000).toISOString(),
        notAfter: new Date(Date.now() + 86_400_000).toISOString(),
        required: 2,
        signers: [{ userId: me.admin, role: "CFO" }, { userId: me.controller, role: "Controller" }],
      },
      { auth: tokens.admin },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.state).toBe("pending");
    const id = created.body.id;
    const statusUrl = new URL(created.body.signed.mandate.status!.url);

    /* Une autre organisation ne le voit pas. */
    expect((await api.get(`/api/mandates/${id}`, { auth: OTHER_ORG_KEYS.admin })).status).toBe(404);

    /* L'agent, avec une clé LIÉE à lui ; une session de la console n'obtient rien. */
    const issued = await api.post<{ secret: string }>("/api/keys", { name: "billing agent", role: "operator", agentId: "agt_billing" }, { auth: tokens.admin });
    expect(issued.status).toBe(201);
    const agent = { auth: issued.body.secret };
    expect((await api.post(`/api/mandates/${id}/grants`, { action: pay(100) }, { auth: tokens.admin })).status).toBe(403);
    expect((await api.post<{ error: string }>(`/api/mandates/${id}/grants`, { action: pay(100) }, agent)).body).toMatchObject({ error: expect.stringMatching(/signed by 0 of the 2 people/) });

    /* Chacun signe dans son navigateur la forme canonique du mandat. */
    for (const who of ["admin", "controller"] as const) {
      const signature = sign(null, Buffer.from(canonical(created.body.signed.mandate), "utf8"), keys[who]).toString("base64");
      const signed = await api.post<View>(`/api/mandates/${id}/sign`, { signature }, { auth: tokens[who] });
      expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    }
    const active = (await api.get<View>(`/api/mandates/${id}`, { auth: tokens.admin })).body;
    expect(active.state).toBe("active");

    expect((await api.post<{ error: string }>(`/api/mandates/${id}/grants`, { action: pay(7_000) }, agent)).body).toMatchObject({ error: expect.stringMatching(/above the mandate's 5,000 EUR per action/) });
    const grant = await api.post<{ grant: Grant; issuerSignature: string }>(`/api/mandates/${id}/grants`, { action: pay(3_200) }, agent);
    expect(grant.status).toBe(201);

    /* La liste de révocation : publique, signée par l'organisation. */
    const readStatus = async () => (await api.get<SignedStatus>(statusUrl.pathname, { auth: null })).body;
    const status = verifyStatus(await readStatus(), active.signed.mandate.issuer.publicKey);
    expect(status).not.toBeNull();
    expect((await api.get("/.well-known/oathrion/mandates/org_unknown_xyz/status", { auth: null })).status).toBe(404);

    const bank = { trustedIssuers: [fingerprintOfKey(active.signed.mandate.issuer.publicKey)], now: new Date(), status, seenNonce: () => false };
    const presented = presentGrant(grant.body, keys.agent);
    expect(verifyPresentation(active.signed, presented, pay(3_200), bank)).toEqual({ ok: true });

    /* La banque contresigne ; l'agent rapporte le reçu ; il entre dans la chaîne de l'organisation. */
    const countersigned = countersign(presented, { executed: true }, { name: "Example Bank", key: generateKeyPairSync("ed25519").privateKey }, new Date());
    expect((await api.post<{ seq: number }>(`/api/mandates/${id}/receipts`, { grant: presented, countersigned }, agent)).body).toMatchObject({ seq: 1 });
    expect((await api.post(`/api/mandates/${id}/receipts`, { grant: presented, countersigned }, { auth: tokens.admin })).status).toBe(403);
    const listed = await api.get<{ receipts: unknown[]; chain: { ok: boolean; entries: number } }>(`/api/mandates/${id}/receipts`, { auth: tokens.admin });
    expect(listed.body.chain).toMatchObject({ ok: true, entries: 1 });
    const dual = await api.get<Parameters<typeof verifyDualReceipt>[0]>(`/api/mandates/${id}/receipts/${presented.grant.id}`, { auth: tokens.admin });
    expect(verifyDualReceipt(dual.body, { trustedIssuers: [fingerprintOfKey(dual.body.mandate.mandate.issuer.publicKey)] })).toEqual({ ok: true });
    expect(verifyDualReceipt(dual.body, { trustedIssuers: ["0000 0000 0000 0000 0000 0000 0000 0000"] })).toEqual({ ok: false, reason: "the issuer is not one we trust" });

    expect((await api.post(`/api/mandates/${id}/revoke`, {}, { auth: tokens.controller })).status).toBe(200);
    const revoked = verifyStatus(await readStatus(), active.signed.mandate.issuer.publicKey);
    expect(verifyPresentation(active.signed, presented, pay(3_200), { ...bank, status: revoked })).toEqual({ ok: false, reason: "the mandate has been revoked" });
  });
});
