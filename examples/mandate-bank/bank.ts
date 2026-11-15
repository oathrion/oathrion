/**
 * Une banque fictive qui accepte les paiements d'agents porteurs d'un mandat Oathrion.
 *
 * C'est ce qu'une vraie contrepartie intègre : `@oathrion/verify` (`sdk/verify`), une empreinte
 * d'émetteur épinglée quand elle a accepté ce client, la liste de révocation de l'émetteur, et
 * un registre de nonces. Avant d'exécuter, elle vérifie tout ; après, elle contresigne ce qu'elle
 * a fait — exécuté, ou refusé et pourquoi. Aucun appel à Oathrion.
 */
import { createServer, type Server } from "node:http";
import type { KeyObject } from "node:crypto";

import {
  countersign,
  decodeHeader,
  MANDATE_HEADER,
  verifyRequest,
  verifyStatus,
  type Countersigned,
  type MandateAction,
  type RevocationStatus,
  type SignedMandate,
} from "../../sdk/verify/src";

export interface BankOptions {
  name: string;
  key: KeyObject;
  /** L'empreinte de l'émetteur de ce client, épinglée à l'enrôlement : l'ancre de la confiance. */
  trustedIssuers: string[];
  /** Où lire la liste de révocation de l'émetteur, et combien de temps la garder en cache. */
  statusUrl: string;
  statusCacheSeconds: number;
  balance: number;
}

export interface Bank {
  url: string;
  ledger: { reference: string | undefined; amount: number; beneficiary: string | undefined }[];
  balance: () => number;
  close: () => Promise<void>;
}

export interface BankAnswer {
  status: "executed" | "refused";
  reason?: string;
  receipt: Countersigned | null;
}

export async function startBank(options: BankOptions): Promise<Bank> {
  let balance = options.balance;
  const ledger: Bank["ledger"] = [];
  const nonces = new Map<string, number>();
  let cached: { status: RevocationStatus | null; at: number } | null = null;

  /* La liste de révocation, relue au plus toutes les `statusCacheSeconds`, et vérifiée. */
  const statusFor = async (issuerPublicKey: string): Promise<RevocationStatus | null> => {
    if (cached && Date.now() - cached.at < options.statusCacheSeconds * 1_000) return cached.status;
    try {
      const fetched = verifyStatus(await (await fetch(options.statusUrl)).json(), issuerPublicKey);
      cached = { status: fetched, at: Date.now() };
      return fetched;
    } catch {
      return null;
    }
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      void (async () => {
        const reply = (code: number, answer: BankAnswer) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(answer));
        };
        if (req.method !== "POST" || req.url !== "/transfers") return reply(404, { status: "refused", reason: "not found", receipt: null });
        let action: MandateAction;
        try {
          action = JSON.parse(body) as MandateAction;
        } catch {
          return reply(400, { status: "refused", reason: "the transfer is not readable", receipt: null });
        }
        const now = new Date();
        for (const [nonce, until] of nonces) if (until < now.getTime()) nonces.delete(nonce);
        const presented = decodeHeader<SignedMandate>(typeof req.headers[MANDATE_HEADER] === "string" ? req.headers[MANDATE_HEADER] : undefined);
        const status = presented?.mandate?.issuer?.publicKey ? await statusFor(presented.mandate.issuer.publicKey) : null;
        const check = verifyRequest(req.headers, action, { trustedIssuers: options.trustedIssuers, now, status, seenNonce: (nonce) => nonces.has(nonce) });
        if (!check.grant) return reply(401, { status: "refused", reason: check.ok ? "no authorization" : check.reason, receipt: null });
        nonces.set(check.grant.grant.nonce, Date.parse(check.grant.grant.notAfter) + 60_000);

        if (!check.ok) return reply(403, { status: "refused", reason: check.reason, receipt: countersign(check.grant, { executed: false, reason: check.reason }, options, now) });
        const amount = action.amount?.value ?? 0;
        if (amount > balance) {
          const reason = "insufficient funds";
          return reply(402, { status: "refused", reason, receipt: countersign(check.grant, { executed: false, reason }, options, now) });
        }
        balance -= amount;
        ledger.push({ reference: action.reference, amount, beneficiary: action.beneficiary });
        return reply(200, { status: "executed", receipt: countersign(check.grant, { executed: true }, options, now) });
      })();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    ledger,
    balance: () => balance,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
