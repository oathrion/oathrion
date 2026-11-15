/**
 * La démonstration du mandat vérifiable (`notes/CONCEPTION-MANDAT.md`) : un agent d'Acme paie des
 * factures fournisseurs à une banque qui vérifie elle-même, avant d'exécuter, et contresigne.
 *
 *   npx tsx examples/mandate-bank/demo.ts           (--slow : au rythme d'un enregistrement vidéo)
 *
 * Cinq moments : 3 200 € passe ; 7 000 € est refusé par l'Oathrion d'Acme ; l'agent forge une
 * autorisation et la BANQUE refuse ; Awa révoque le mandat ; une autorisation obtenue avant la
 * révocation est refusée par la banque. Chaque réponse de la banque est un reçu contresigné.
 */
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";

import { encodeHeader, fingerprintOfKey, GRANT_HEADER, MANDATE_HEADER, publicKeyOf, verifyCountersigned, type MandateAction, type SignedGrant } from "../../sdk/verify/src";
import { startAcme } from "./acme";
import { startBank, type BankAnswer } from "./bank";

const invoice = (reference: string, value: number): MandateAction => ({
  type: "payment.transfer",
  destination: "bank:acme-main",
  amount: { value, currency: "EUR" },
  beneficiary: "FR7630006000011234567890189",
  purpose: "supplier invoices",
  reference,
});
const eur = (value: number) => `${value.toLocaleString("en-US")} EUR`;

/** `paceMs` : une pause entre les moments, pour filmer la démonstration (`--slow`). */
export async function runDemo(log: (line: string) => void = (line) => process.stdout.write(`${line}\n`), paceMs = 0) {
  const pause = () => new Promise((done) => setTimeout(done, paceMs));
  const acme = await startAcme();
  const bankKey = generateKeyPairSync("ed25519").privateKey;
  const bankFingerprint = fingerprintOfKey(publicKeyOf(bankKey));
  const bank = await startBank({ name: "Example Bank", key: bankKey, trustedIssuers: [acme.fingerprint], statusUrl: acme.statusUrl, statusCacheSeconds: 0, balance: 100_000 });
  const answers: BankAnswer[] = [];

  /* L'agent envoie le paiement, avec le mandat et l'autorisation dans les en-têtes. */
  const send = async (action: MandateAction, grant: SignedGrant): Promise<BankAnswer> => {
    const response = await fetch(`${bank.url}/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json", [MANDATE_HEADER]: encodeHeader(acme.mandate), [GRANT_HEADER]: encodeHeader(grant) },
      body: JSON.stringify(action),
    });
    const answer = (await response.json()) as BankAnswer;
    answers.push(answer);
    const signed = answer.receipt && verifyCountersigned(answer.receipt, [bankFingerprint]).ok ? " · countersigned receipt ✓" : "";
    log(`   Bank: ${answer.status === "executed" ? "EXECUTED" : `REFUSED — ${answer.reason ?? "?"}`}${signed}`);
    if (answer.receipt && acme.record(grant, answer.receipt)) log("   Acme keeps it: its authorization + the bank's receipt, signed by both sides ✓");
    return answer;
  };
  const authorize = (action: MandateAction) => {
    try {
      const grant = acme.authorize(action);
      log(`   Acme's Oathrion: authorized (${grant.grant.id.slice(0, 12)}…, valid 5 minutes, for this payment only)`);
      return grant;
    } catch (error) {
      log(`   Acme's Oathrion: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const { mandate } = acme.mandate;
  log(`Mandate ${mandate.id}: ${mandate.agent.name} may pay supplier invoices, ≤ ${eur(5_000)} each, ≤ ${eur(50_000)} a month, to one IBAN,`);
  log(`until ${mandate.validity.notAfter.slice(0, 10)}. Signed by ${mandate.approval.of.map((s) => `${s.id} (${s.role ?? "?"})`).join(" and ")}, issued by Acme.`);
  log(`The bank pinned Acme's fingerprint when it took Acme as a client: ${acme.fingerprint}`);

  await pause();
  log("");
  log(`1. The agent pays invoice F-2026-114: ${eur(3_200)}.`);
  const first = authorize(invoice("F-2026-114", 3_200));
  if (first) await send(invoice("F-2026-114", 3_200), first);

  await pause();
  log("");
  log(`2. The agent tries to pay ${eur(7_000)}.`);
  authorize(invoice("F-2026-115", 7_000));

  await pause();
  log("");
  log(`3. The agent forges it: it presents a valid ${eur(900)} authorization for a ${eur(7_000)} payment.`);
  const small = authorize(invoice("F-2026-116", 900));
  if (small) await send(invoice("F-2026-116", 7_000), small);

  await pause();
  log("");
  log(`4. The agent obtains an authorization for ${eur(1_000)}, keeps it, and then Awa revokes the mandate in Acme's console.`);
  const early = authorize(invoice("F-2026-117", 1_000));
  acme.revoke();
  log("   After the revocation, the agent asks again:");
  authorize(invoice("F-2026-118", 1_000));

  await pause();
  log("");
  log(`5. The agent presents an authorization it obtained just before the revocation: ${eur(1_000)}.`);
  if (early) await send(invoice("F-2026-117", 1_000), early);

  await pause();
  log("");
  log(`The bank's ledger: ${String(bank.ledger.length)} payment(s), ${eur(bank.ledger.reduce((sum, p) => sum + p.amount, 0))}. Balance: ${eur(bank.balance())}.`);
  log(`Every answer from the bank is a receipt it signed: ${String(answers.filter((a) => a.receipt).length)} of ${String(answers.length)}.`);
  log(`Acme's record: ${String(acme.receipts())} receipts signed by both sides — neither can deny what happened.`);

  await bank.close();
  await acme.close();
  return { answers, ledger: bank.ledger };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDemo(undefined, process.argv.includes("--slow") ? 2_500 : 0);
}
