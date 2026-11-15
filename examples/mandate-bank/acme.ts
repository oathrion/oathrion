/**
 * L'Oathrion d'Acme, côté émetteur, réduit à l'essentiel pour la démonstration : les clés (celle
 * de l'organisation, celles d'Awa et de Moussa, celle de l'agent), le mandat qu'ils signent, la
 * liste de révocation servie en HTTP, et l'autorisation de chaque paiement — c'est ici que le
 * cumul du mois est tenu, puisque seul l'émetteur voit tous les paiements de l'agent.
 *
 * Dans le produit, c'est la version équipe d'Oathrion qui joue ce rôle (étape M2 de
 * `notes/CONCEPTION-MANDAT.md`) ; les clés des personnes y sont gardées hors de portée des agents.
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  fingerprintOfKey,
  issueGrant,
  issueMandate,
  MANDATE_TYPE,
  presentGrant,
  publicKeyOf,
  signMandate,
  signStatus,
  type Mandate,
  type MandateAction,
  verifyDualReceipt,
  type Countersigned,
  type SignedGrant,
  type SignedMandate,
} from "../../shared/mandate";

const key = (): KeyObject => generateKeyPairSync("ed25519").privateKey;

export interface Acme {
  mandate: SignedMandate;
  fingerprint: string;
  statusUrl: string;
  /** L'Oathrion d'Acme autorise ce paiement (ou refuse, et dit pourquoi) ; l'agent le présente avec sa clé. */
  authorize: (action: MandateAction) => SignedGrant;
  revoke: () => void;
  /** Acme garde le reçu de la banque avec son autorisation : signé des deux côtés, vérifié. */
  record: (grant: SignedGrant, countersigned: Countersigned) => boolean;
  receipts: () => number;
  close: () => Promise<void>;
}

export async function startAcme(now = new Date()): Promise<Acme> {
  const keys = { organization: key(), awa: key(), moussa: key(), agent: key() };
  const index = 4127;
  const revoked = new Set<number>();
  let spent = 0;
  const record: { grant: SignedGrant; countersigned: Countersigned }[] = [];

  const server: Server = createServer((req, res) => {
    if (req.url !== "/mandates/status") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(signStatus([...revoked], keys.organization, new Date())));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const statusUrl = `http://127.0.0.1:${String(address.port)}/mandates/status`;

  const mandate: Mandate = {
    type: MANDATE_TYPE,
    id: "mdt_acme_supplier_invoices",
    issuer: { organization: "Acme", publicKey: publicKeyOf(keys.organization) },
    agent: { id: "agt_accounts_payable", name: "Accounts payable", publicKey: publicKeyOf(keys.agent) },
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
    validity: { notBefore: new Date(now.getTime() - 86_400_000).toISOString(), notAfter: new Date(now.getTime() + 90 * 86_400_000).toISOString() },
    approval: {
      required: 2,
      of: [
        { id: "awa@acme", role: "CFO", publicKey: publicKeyOf(keys.awa) },
        { id: "moussa@acme", role: "Controller", publicKey: publicKeyOf(keys.moussa) },
      ],
    },
    status: { url: statusUrl, index },
  };
  const signed = signMandate(signMandate(issueMandate(mandate, keys.organization), "awa@acme", keys.awa), "moussa@acme", keys.moussa);

  return {
    mandate: signed,
    fingerprint: fingerprintOfKey(mandate.issuer.publicKey),
    statusUrl,
    authorize: (action) => {
      if (revoked.has(index)) throw new Error("Not granted: the mandate has been revoked.");
      const nonce = randomBytes(12).toString("base64url");
      const grant = issueGrant(signed, action, keys.organization, { now: new Date(), id: `grt_${nonce}`, nonce, spent: { value: spent, currency: "EUR" } });
      spent += action.amount?.value ?? 0;
      return presentGrant(grant, keys.agent);
    },
    revoke: () => revoked.add(index),
    record: (grant, countersigned) => {
      const kept = verifyDualReceipt({ mandate: signed, grant, countersigned }, { trustedIssuers: [fingerprintOfKey(mandate.issuer.publicKey)] }).ok;
      if (kept) record.push({ grant, countersigned });
      return kept;
    },
    receipts: () => record.length,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
