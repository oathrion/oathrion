/**
 * LE MANDAT VÉRIFIABLE — l'étoile polaire d'Oathrion (`notes/VISION-LONG-TERME.md`), version 0
 * (`notes/CONCEPTION-MANDAT.md`, étape M1 : le cœur, sans interface).
 *
 * Quatre pièces, chacune signée en Ed25519 sur sa forme canonique (`canonical`, comme les reçus) :
 *
 *   1. le MANDAT : ce qu'un agent peut faire au nom d'une organisation (actions, destinations,
 *      montants, bénéficiaires, finalité, durée), signé par l'Oathrion de l'organisation (qui
 *      atteste la liste des signataires) ET par assez de personnes habilitées (« 2 sur 2 ») ;
 *   2. l'AUTORISATION d'une action (le « grant ») : émise par l'Oathrion de l'organisation pour
 *      UNE action précise (son empreinte), quelques minutes, un nonce ; l'agent la signe à son tour
 *      avec la clé que le mandat lui donne — un mandat volé ne sert à rien sans elle. C'est aussi
 *      là que l'émetteur fait respecter les cumuls (« ≤ 50 000 € par mois ») qu'une contrepartie
 *      ne peut pas voir ;
 *   3. la LISTE DE RÉVOCATION, signée par l'émetteur ;
 *   4. le REÇU CONTRESIGNÉ : la contrepartie signe ce qu'elle a fait de l'action.
 *
 * La contrepartie (une banque, une API) vérifie tout en local, sans réseau et sans Oathrion
 * (`verifyPresentation`) : la seule chose qu'elle doit connaître d'avance, c'est l'empreinte de
 * l'émetteur, épinglée quand elle a accepté ce client. Ce n'est pas une procuration au sens
 * juridique : c'est une preuve (avis juridique avant d'en parler ainsi).
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

import { canonical, fingerprintOf } from "./receipt-share";

export const MANDATE_TYPE = "oathrion.mandate/v0";
export const GRANT_TYPE = "oathrion.grant/v0";
export const STATUS_TYPE = "oathrion.status/v0";
export const COUNTERSIGNED_TYPE = "oathrion.countersigned/v0";

export interface Money {
  value: number;
  currency: string;
}

/** Ce que l'agent demande à la contrepartie de faire. Son empreinte lie l'autorisation à elle seule. */
export interface MandateAction {
  type: string;
  destination?: string;
  amount?: Money;
  beneficiary?: string;
  purpose?: string;
  reference?: string;
}

export interface MandateGrant {
  /** Des types d'action exacts, ou un préfixe suivi de « .* » (`payment.*`). */
  actions: string[];
  destinations?: string[];
  constraints?: {
    maxAmount?: Money;
    /** Un cumul sur une période : vérifié par l'émetteur, qui voit toutes les actions. */
    periodCap?: Money & { period: "P1D" | "P7D" | "P1M" };
    beneficiaries?: string[];
    purpose?: string;
  };
}

/** Une personne habilitée à signer, et sa clé publique (Ed25519, 32 octets, base64). */
export interface Signer {
  id: string;
  role?: string;
  publicKey: string;
}

export interface Mandate {
  type: typeof MANDATE_TYPE;
  id: string;
  issuer: { organization: string; publicKey: string };
  agent: { id: string; name: string; publicKey: string };
  grants: MandateGrant[];
  validity: { notBefore: string; notAfter: string };
  approval: { required: number; of: Signer[] };
  /** Sa place dans la liste de révocation de l'émetteur. */
  status?: { url: string; index: number };
}

export interface SignedMandate {
  mandate: Mandate;
  /** L'émetteur atteste le mandat entier, donc la liste de ses signataires. */
  issuerSignature: string;
  signatures: { by: string; signature: string }[];
}

export interface Grant {
  type: typeof GRANT_TYPE;
  id: string;
  mandateId: string;
  action: MandateAction;
  actionHash: string;
  issuedAt: string;
  notAfter: string;
  nonce: string;
}

export interface SignedGrant {
  grant: Grant;
  issuerSignature: string;
  /** La preuve que l'agent qui présente l'autorisation détient la clé du mandat. */
  agentSignature: string;
}

export interface RevocationStatus {
  type: typeof STATUS_TYPE;
  issuer: string;
  updatedAt: string;
  revoked: number[];
}

export interface SignedStatus {
  status: RevocationStatus;
  signature: string;
}

export interface Countersigned {
  statement: {
    type: typeof COUNTERSIGNED_TYPE;
    counterparty: { name: string; publicKey: string; fingerprint: string };
    grantId: string;
    mandateId: string;
    actionHash: string;
    outcome: "executed" | "refused";
    reason: string | null;
    at: string;
  };
  signature: string;
}

export type Check = { ok: true } | { ok: false; reason: string };

/* ── Clés et signatures ────────────────────────────────────────────────────────────────── */

/** La clé publique d'une clé (privée ou publique), en 32 octets base64. */
export function publicKeyOf(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: string };
  return Buffer.from(jwk.x ?? "", "base64url").toString("base64");
}

function keyFrom(raw: string): KeyObject | null {
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw, "base64").toString("base64url") }, format: "jwk" });
  } catch {
    return null;
  }
}

const signValue = (value: unknown, key: KeyObject) => sign(null, Buffer.from(canonical(value), "utf8"), key).toString("base64");

function validSignature(value: unknown, signature: string, publicKey: string): boolean {
  const key = keyFrom(publicKey);
  if (!key) return false;
  try {
    return verify(null, Buffer.from(canonical(value), "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/*
 * AUDIT DU 8 NOVEMBRE : la vérification échoue FERMÉE. Une date illisible n'est pas « sans
 * limite » (`Date.parse` rend NaN, et toute comparaison avec NaN est fausse : un mandat aux dates
 * illisibles était valide pour toujours) ; un document mal formé n'est pas une exception qui
 * remonte chez la contrepartie, c'est un refus, avec sa raison.
 */
const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

function safely(run: () => Check): Check {
  try {
    return run();
  } catch {
    return { ok: false, reason: "the document is malformed" };
  }
}

export const fingerprintOfKey = (publicKey: string) => fingerprintOf(Buffer.from(publicKey, "base64"));
const normalize = (fingerprint: string) => fingerprint.replace(/\s+/g, "").toLowerCase();

/** L'empreinte d'une action : sa forme canonique, hachée. Une virgule changée, une autre empreinte. */
export function actionHash(action: MandateAction): string {
  return `sha256:${createHash("sha256").update(canonical(action), "utf8").digest("hex")}`;
}

/* ── 1. Le mandat ──────────────────────────────────────────────────────────────────────── */

/** L'émetteur atteste le mandat ; les personnes le signent ensuite, une par une. */
export function issueMandate(mandate: Mandate, issuerKey: KeyObject): SignedMandate {
  if (publicKeyOf(issuerKey) !== mandate.issuer.publicKey) throw new Error("This key is not the issuer's.");
  return { mandate, issuerSignature: signValue(mandate, issuerKey), signatures: [] };
}

export function signMandate(signed: SignedMandate, signerId: string, signerKey: KeyObject): SignedMandate {
  const signer = signed.mandate.approval.of.find((candidate) => candidate.id === signerId);
  if (!signer || signer.publicKey !== publicKeyOf(signerKey)) throw new Error(`${signerId} is not a signer of this mandate, with this key.`);
  return { ...signed, signatures: [...signed.signatures.filter((s) => s.by !== signerId), { by: signerId, signature: signValue(signed.mandate, signerKey) }] };
}

export interface MandateCheckOptions {
  /** Les empreintes des émetteurs que la contrepartie connaît : l'ancre de toute la confiance. */
  trustedIssuers: readonly string[];
  now: Date;
  /** La liste de révocation de l'émetteur, déjà vérifiée (`verifyStatus`). */
  status?: RevocationStatus | null;
  /** Au-delà, la liste est trop vieille pour qu'on s'y fie (une heure par défaut). */
  maxStatusAgeSeconds?: number;
}

export function verifyMandate(signed: SignedMandate, options: MandateCheckOptions): Check {
  return safely(() => checkMandate(signed, options));
}

function checkMandate(signed: SignedMandate, options: MandateCheckOptions): Check {
  const { mandate } = signed;
  if (mandate?.type !== MANDATE_TYPE) return { ok: false, reason: "this is not an Oathrion mandate" };
  const issuerFingerprint = fingerprintOfKey(mandate.issuer.publicKey);
  if (!options.trustedIssuers.map(normalize).includes(normalize(issuerFingerprint))) {
    return { ok: false, reason: `the mandate's issuer (${issuerFingerprint}) is not one this counterparty trusts` };
  }
  if (!validSignature(mandate, signed.issuerSignature, mandate.issuer.publicKey)) return { ok: false, reason: "the mandate was changed after its issuer signed it" };
  const now = options.now.getTime();
  const [notBefore, notAfter] = [time(mandate.validity.notBefore), time(mandate.validity.notAfter)];
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return { ok: false, reason: "the mandate's validity dates are not readable" };
  if (now < notBefore) return { ok: false, reason: "the mandate is not valid yet" };
  if (now > notAfter) return { ok: false, reason: "the mandate has expired" };
  const { required, of } = mandate.approval;
  if (!Number.isInteger(required) || required < 1 || required > of.length) return { ok: false, reason: "the mandate's approval rule is not valid" };
  /* Des PERSONNES distinctes : deux noms qui portent la même clé comptent pour une signature. */
  const valid = new Set(
    signed.signatures
      .map((s) => of.find((candidate) => candidate.id === s.by && validSignature(mandate, s.signature, candidate.publicKey)))
      .filter((signer) => signer !== undefined)
      .map((signer) => signer.publicKey),
  );
  if (valid.size < required) return { ok: false, reason: `the mandate is signed by ${String(valid.size)} of the ${String(required)} people it needs` };
  /* Un mandat qui annonce sa liste de révocation n'est accepté que si on l'a lue, et récemment. */
  if (mandate.status) {
    if (!options.status) return { ok: false, reason: "the mandate's revocation list was not checked" };
    if (options.status.issuer !== issuerFingerprint) return { ok: false, reason: "the revocation list is not this issuer's" };
    const updatedAt = time(options.status.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt > (options.maxStatusAgeSeconds ?? 3_600) * 1_000) return { ok: false, reason: "the revocation list is too old to rely on" };
    if (options.status.revoked.includes(mandate.status.index)) return { ok: false, reason: "the mandate has been revoked" };
  }
  return { ok: true };
}

const covers = (pattern: string, type: string) => pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
const money = (m: Money) => `${m.value.toLocaleString("en-US")} ${m.currency}`;

/**
 * L'action est-elle dans le mandat ? Une seule permission doit la couvrir entièrement. `spent` :
 * ce que l'agent a déjà dépensé sur la période (l'émetteur seul le sait ; la contrepartie l'omet).
 */
export function checkAction(mandate: Mandate, action: MandateAction, spent?: Money): Check {
  /* Un montant qui n'est pas un nombre positif (« abc », -5 000) ne passe sous aucun plafond. */
  if (action.amount !== undefined && !(typeof action.amount.value === "number" && Number.isFinite(action.amount.value) && action.amount.value >= 0)) {
    return { ok: false, reason: "the amount is not a valid positive number" };
  }
  const candidates = mandate.grants.filter((grant) => grant.actions.some((pattern) => covers(pattern, action.type)));
  if (candidates.length === 0) return { ok: false, reason: `the mandate does not allow « ${action.type} »` };
  let last: Check = { ok: false, reason: "the mandate does not allow this action" };
  for (const grant of candidates) {
    const c = grant.constraints ?? {};
    if (grant.destinations && (!action.destination || !grant.destinations.includes(action.destination))) last = { ok: false, reason: `the mandate does not allow « ${action.destination ?? "?"} » as a destination` };
    else if (c.maxAmount && (!action.amount || action.amount.currency !== c.maxAmount.currency)) last = { ok: false, reason: `the mandate needs an amount in ${c.maxAmount.currency}` };
    else if (c.maxAmount && action.amount!.value > c.maxAmount.value) last = { ok: false, reason: `above the mandate's ${money(c.maxAmount)} per action` };
    else if (c.periodCap && spent && action.amount && spent.currency === c.periodCap.currency && spent.value + action.amount.value > c.periodCap.value) last = { ok: false, reason: `above the mandate's ${money(c.periodCap)} per period (${money(spent)} already used)` };
    else if (c.beneficiaries && (!action.beneficiary || !c.beneficiaries.includes(action.beneficiary))) last = { ok: false, reason: "the beneficiary is not one the mandate allows" };
    else if (c.purpose && action.purpose !== c.purpose) last = { ok: false, reason: `the mandate is for « ${c.purpose} » only` };
    else return { ok: true };
  }
  return last;
}

/* ── 2. L'autorisation d'une action ────────────────────────────────────────────────────── */

/**
 * Émise par l'Oathrion de l'organisation, après avoir vérifié le mandat ET les cumuls. Elle ne
 * vaut que pour CETTE action, quelques minutes, une fois.
 */
export function issueGrant(signed: SignedMandate, action: MandateAction, issuerKey: KeyObject, options: { now: Date; ttlSeconds?: number; id: string; nonce: string; spent?: Money }): Omit<SignedGrant, "agentSignature"> {
  const allowed = checkAction(signed.mandate, action, options.spent);
  if (!allowed.ok) throw new Error(`Not granted: ${allowed.reason}.`);
  const grant: Grant = {
    type: GRANT_TYPE,
    id: options.id,
    mandateId: signed.mandate.id,
    action,
    actionHash: actionHash(action),
    issuedAt: options.now.toISOString(),
    notAfter: new Date(options.now.getTime() + (options.ttlSeconds ?? 300) * 1_000).toISOString(),
    nonce: options.nonce,
  };
  return { grant, issuerSignature: signValue(grant, issuerKey) };
}

/** L'agent contresigne l'autorisation avec SA clé : il prouve qu'il est bien l'agent du mandat. */
export function presentGrant(issued: Omit<SignedGrant, "agentSignature">, agentKey: KeyObject): SignedGrant {
  return { ...issued, agentSignature: signValue(issued.grant, agentKey) };
}

/* ── 3. La révocation ──────────────────────────────────────────────────────────────────── */

export function signStatus(revoked: readonly number[], issuerKey: KeyObject, now: Date): SignedStatus {
  const status: RevocationStatus = { type: STATUS_TYPE, issuer: fingerprintOfKey(publicKeyOf(issuerKey)), updatedAt: now.toISOString(), revoked: [...new Set(revoked)].sort((a, b) => a - b) };
  return { status, signature: signValue(status, issuerKey) };
}

/** Une liste de révocation est-elle bien de cet émetteur, et intacte ? */
export function verifyStatus(signed: SignedStatus, issuerPublicKey: string): RevocationStatus | null {
  try {
    if (signed?.status?.type !== STATUS_TYPE || signed.status.issuer !== fingerprintOfKey(issuerPublicKey) || !Array.isArray(signed.status.revoked)) return null;
    return validSignature(signed.status, signed.signature, issuerPublicKey) ? signed.status : null;
  } catch {
    return null;
  }
}

/* ── Ce que fait la contrepartie, avant d'exécuter ─────────────────────────────────────── */

export interface PresentationOptions extends MandateCheckOptions {
  /** Le nonce a-t-il déjà servi ? La contrepartie garde ceux de la durée d'une autorisation. */
  seenNonce: (nonce: string) => boolean;
  /** La dérive d'horloge tolérée, en secondes. */
  skewSeconds?: number;
}

/**
 * Tout ce qu'une contrepartie vérifie, en local, avant d'exécuter l'action demandée : le mandat
 * (émetteur épinglé, signatures, validité, révocation), l'autorisation (de cet émetteur, pour ce
 * mandat, pour CETTE action, encore valide, jamais vue), la preuve de l'agent, et l'action dans
 * le mandat. Le premier échec est la raison, lisible, du refus.
 */
export function verifyPresentation(signed: SignedMandate, presented: SignedGrant, action: MandateAction, options: PresentationOptions): Check {
  return safely(() => checkPresentation(signed, presented, action, options));
}

function checkPresentation(signed: SignedMandate, presented: SignedGrant, action: MandateAction, options: PresentationOptions): Check {
  const mandateCheck = verifyMandate(signed, options);
  if (!mandateCheck.ok) return mandateCheck;
  const { mandate } = signed;
  const { grant } = presented;
  if (grant?.type !== GRANT_TYPE || grant.mandateId !== mandate.id) return { ok: false, reason: "the authorization is not for this mandate" };
  if (!validSignature(grant, presented.issuerSignature, mandate.issuer.publicKey)) return { ok: false, reason: "the authorization was not issued by the mandate's issuer, or was changed" };
  if (!validSignature(grant, presented.agentSignature, mandate.agent.publicKey)) return { ok: false, reason: "the agent presenting it does not hold the mandate's key" };
  if (grant.actionHash !== actionHash(action) || canonical(grant.action) !== canonical(action)) return { ok: false, reason: "the authorization is for another action" };
  const skew = (options.skewSeconds ?? 30) * 1_000;
  const now = options.now.getTime();
  const [issuedAt, notAfter] = [time(grant.issuedAt), time(grant.notAfter)];
  if (!Number.isFinite(issuedAt) || !Number.isFinite(notAfter)) return { ok: false, reason: "the authorization's dates are not readable" };
  if (now + skew < issuedAt) return { ok: false, reason: "the authorization is not valid yet" };
  if (now - skew > notAfter) return { ok: false, reason: "the authorization has expired" };
  if (options.seenNonce(grant.nonce)) return { ok: false, reason: "the authorization was already used" };
  return checkAction(mandate, action);
}

/* ── 4. Le reçu contresigné ────────────────────────────────────────────────────────────── */

/** La contrepartie dit, et signe, ce qu'elle a fait de l'action : exécutée, ou refusée et pourquoi. */
export function countersign(presented: SignedGrant, outcome: { executed: true } | { executed: false; reason: string }, counterparty: { name: string; key: KeyObject }, now: Date): Countersigned {
  const publicKey = publicKeyOf(counterparty.key);
  const statement: Countersigned["statement"] = {
    type: COUNTERSIGNED_TYPE,
    counterparty: { name: counterparty.name, publicKey, fingerprint: fingerprintOfKey(publicKey) },
    grantId: presented.grant.id,
    mandateId: presented.grant.mandateId,
    actionHash: presented.grant.actionHash,
    outcome: outcome.executed ? "executed" : "refused",
    reason: outcome.executed ? null : outcome.reason,
    at: now.toISOString(),
  };
  return { statement, signature: signValue(statement, counterparty.key) };
}

/** Le reçu contresigné est-il intact, et bien de la contrepartie attendue (si on l'épingle) ? */
export function verifyCountersigned(receipt: Countersigned, trustedCounterparties?: readonly string[]): Check {
  return safely(() => checkCountersigned(receipt, trustedCounterparties));
}

function checkCountersigned(receipt: Countersigned, trustedCounterparties?: readonly string[]): Check {
  const { statement } = receipt ?? {};
  if (statement?.type !== COUNTERSIGNED_TYPE) return { ok: false, reason: "this is not a countersigned Oathrion receipt" };
  if (fingerprintOfKey(statement.counterparty.publicKey) !== statement.counterparty.fingerprint) return { ok: false, reason: "the fingerprint shown does not match the counterparty's key" };
  if (trustedCounterparties && !trustedCounterparties.map(normalize).includes(normalize(statement.counterparty.fingerprint))) return { ok: false, reason: "the counterparty is not one we trust" };
  return validSignature(statement, receipt.signature, statement.counterparty.publicKey) ? { ok: true } : { ok: false, reason: "the receipt was changed after the counterparty signed it" };
}

/* ── Le reçu à double signature ────────────────────────────────────────────────────────── */

/**
 * Ce que l'organisation garde de chaque action : son mandat, l'autorisation qu'ELLE a émise, et
 * le reçu que la CONTREPARTIE a signé. Ni l'une ni l'autre ne peut plus nier l'action.
 */
export interface DualReceipt {
  mandate: SignedMandate;
  grant: SignedGrant;
  countersigned: Countersigned;
}

/**
 * Vérifie un reçu à double signature, sans Oathrion : l'émetteur a bien signé le mandat et
 * l'autorisation, l'agent l'a présentée, la contrepartie a signé son reçu, et les trois parlent de
 * la MÊME action. Ce n'est pas la vérification d'avant exécution (`verifyPresentation`) : un mandat
 * révoqué ou expiré depuis n'invalide pas une action qui a eu lieu quand il était en vigueur.
 */
/*
 * L'émetteur attendu est OBLIGATOIRE (audit du 8 novembre) : sans lui, n'importe qui fabriquait
 * un mandat, une autorisation et un reçu avec ses propres clés, et tout se vérifiait. Celui qui
 * vérifie dit de QUI il attend le mandat ; la contrepartie, elle, reste facultative à épingler.
 */
export interface DualReceiptOptions {
  trustedIssuers: readonly string[];
  trustedCounterparties?: readonly string[];
}

export function verifyDualReceipt(receipt: DualReceipt, options: DualReceiptOptions): Check {
  return safely(() => checkDualReceipt(receipt, options));
}

function checkDualReceipt(receipt: DualReceipt, options: DualReceiptOptions): Check {
  const { mandate, grant, countersigned } = receipt ?? ({} as DualReceipt);
  if (mandate?.mandate?.type !== MANDATE_TYPE || grant?.grant?.type !== GRANT_TYPE) return { ok: false, reason: "this is not an Oathrion receipt with a mandate" };
  const issuer = mandate.mandate.issuer.publicKey;
  if (!Array.isArray(options?.trustedIssuers) || !options.trustedIssuers.map(normalize).includes(normalize(fingerprintOfKey(issuer)))) return { ok: false, reason: "the issuer is not one we trust" };
  if (!validSignature(mandate.mandate, mandate.issuerSignature, issuer)) return { ok: false, reason: "the mandate was changed after its issuer signed it" };
  if (grant.grant.mandateId !== mandate.mandate.id) return { ok: false, reason: "the authorization is not for this mandate" };
  if (!validSignature(grant.grant, grant.issuerSignature, issuer)) return { ok: false, reason: "the authorization was changed after its issuer signed it" };
  if (!validSignature(grant.grant, grant.agentSignature, mandate.mandate.agent.publicKey)) return { ok: false, reason: "the agent did not present this authorization with the mandate's key" };
  const counter = verifyCountersigned(countersigned, options.trustedCounterparties);
  if (!counter.ok) return counter;
  const s = countersigned.statement;
  if (s.grantId !== grant.grant.id || s.mandateId !== mandate.mandate.id || s.actionHash !== grant.grant.actionHash) return { ok: false, reason: "the counterparty's receipt is for another action" };
  return { ok: true };
}
