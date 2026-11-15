/**
 * LES MANDATS D'UNE ORGANISATION — l'étape M2 du mandat vérifiable (`notes/CONCEPTION-MANDAT.md`).
 *
 * Le cœur (formats, signatures, vérification) est `shared/mandate.ts`. Ici, ce que l'Oathrion
 * d'une organisation en fait :
 *
 *   · LA CLÉ DE L'ORGANISATION, créée au premier mandat, scellée par le coffre (`OATHRION_KEK`) :
 *     sans coffre, pas de mandat, et la raison est dite ;
 *   · LES CLÉS DES SIGNATAIRES : seulement leur clé PUBLIQUE. La clé privée est créée et gardée
 *     dans le navigateur de chaque personne, non exportable : le serveur ne peut pas signer à la
 *     place d'Awa, même s'il est compromis. Il vérifie chaque signature qu'on lui apporte ;
 *   · LE CYCLE : créé (« en attente de signatures »), actif quand assez de personnes ont signé,
 *     révoqué — publié dans la liste de révocation de l'organisation ;
 *   · L'AUTORISATION D'UNE ACTION : seulement pour un mandat actif, valide, non révoqué, et dans
 *     ses cumuls, comptés sur les autorisations déjà émises (période glissante).
 *
 * Toute requête nomme l'organisation : aucun mandat ne se lit d'un locataire à l'autre.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";

import { canonical } from "@shared/receipt-share";
import {
  checkAction,
  fingerprintOfKey,
  issueGrant,
  issueMandate,
  MANDATE_TYPE,
  publicKeyOf,
  signStatus,
  verifyDualReceipt,
  type Countersigned,
  type Grant,
  type Mandate,
  type MandateAction,
  type MandateGrant,
  type SignedGrant,
  type SignedMandate,
  type SignedStatus,
  type Signer,
} from "@shared/mandate";
import type { OrganizationId } from "@shared/tenancy";

import { openOrganizationSigningKey, sealOrganizationSigningKey, vaultKeyring } from "./connectors/vault";
import { MANDATE_GRANTS_TABLE, MANDATE_KEYS_TABLE, MANDATE_RECEIPTS_TABLE, MANDATES_TABLE } from "./migrations";
import type { SqlExecutor } from "./sql/executor";

export type MandateState = "pending" | "active" | "revoked";

export interface MandateView {
  id: string;
  state: MandateState | "expired";
  signed: SignedMandate;
  /** Ceux qui ont déjà signé, sur ceux qui le doivent. */
  signedBy: string[];
  required: number;
  createdBy: string;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}

export interface CreateMandate {
  agent: { id: string; name: string; publicKey: string };
  grants: MandateGrant[];
  notBefore: string;
  notAfter: string;
  required: number;
  /** Les signataires : des personnes de l'organisation qui ont déjà une clé de signature. */
  signers: { userId: string; role?: string }[];
}

export class MandateError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

type Row = {
  id: string;
  state: MandateState;
  document: string;
  created_by: string;
  created_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
};

const ORGANIZATION = "organization";
const signerHolder = (userId: string) => `user:${userId}`;
const PERIOD_MS: Record<string, number> = { P1D: 86_400_000, P7D: 7 * 86_400_000, P1M: 30 * 86_400_000 };
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

export class MandateService {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /* ── Les clés ──────────────────────────────────────────────────────────────────────── */

  /** La clé de l'organisation : créée au premier besoin, scellée par le coffre. */
  private async organizationKey(now: Date): Promise<KeyObject> {
    try {
      await vaultKeyring(this.env);
    } catch {
      throw new MandateError("Mandates need the encryption key (OATHRION_KEK) to protect the organization's signing key.", 503);
    }
    const rows = await this.sql.all<{ sealed_private: string }>(`SELECT sealed_private FROM ${MANDATE_KEYS_TABLE} WHERE organization_id = ? AND holder = ?`, [this.org, ORGANIZATION]);
    if (rows[0]?.sealed_private) return createPrivateKey(await openOrganizationSigningKey(this.org, rows[0].sealed_private, this.env));
    const key = generateKeyPairSync("ed25519").privateKey;
    const sealed = await sealOrganizationSigningKey(this.org, key.export({ format: "pem", type: "pkcs8" }) as string, this.env);
    await this.sql.run(`INSERT INTO ${MANDATE_KEYS_TABLE} (organization_id, holder, public_key, sealed_private, created_at) VALUES (?, ?, ?, ?, ?)`, [this.org, ORGANIZATION, publicKeyOf(key), sealed, now.toISOString()]);
    return key;
  }

  async organizationPublicKey(now = new Date()): Promise<string> {
    return publicKeyOf(await this.organizationKey(now));
  }

  /** Enregistre la clé PUBLIQUE de signature d'une personne (sa clé privée reste dans son navigateur). */
  async registerSignerKey(userId: string, publicKey: string, now = new Date()): Promise<void> {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) throw new MandateError("A signing key is 32 bytes, in base64.");
    await this.sql.run(`DELETE FROM ${MANDATE_KEYS_TABLE} WHERE organization_id = ? AND holder = ?`, [this.org, signerHolder(userId)]);
    await this.sql.run(`INSERT INTO ${MANDATE_KEYS_TABLE} (organization_id, holder, public_key, sealed_private, created_at) VALUES (?, ?, ?, NULL, ?)`, [this.org, signerHolder(userId), publicKey, now.toISOString()]);
  }

  async signerKey(userId: string): Promise<string | null> {
    const rows = await this.sql.all<{ public_key: string }>(`SELECT public_key FROM ${MANDATE_KEYS_TABLE} WHERE organization_id = ? AND holder = ?`, [this.org, signerHolder(userId)]);
    return rows[0]?.public_key ?? null;
  }

  /* ── Le cycle d'un mandat ──────────────────────────────────────────────────────────── */

  async create(input: CreateMandate, by: string, statusUrl: string, now = new Date()): Promise<MandateView> {
    if (!input.agent?.id || !input.agent.name || !/^[A-Za-z0-9+/]{43}=$/.test(input.agent.publicKey ?? "")) throw new MandateError("The agent, its name and its public key (32 bytes, base64) are required.");
    if (!Array.isArray(input.grants) || input.grants.length === 0 || input.grants.some((g) => !Array.isArray(g.actions) || g.actions.length === 0)) throw new MandateError("A mandate allows at least one action.");
    if (Number.isNaN(Date.parse(input.notBefore)) || Number.isNaN(Date.parse(input.notAfter)) || Date.parse(input.notAfter) <= Date.parse(input.notBefore)) throw new MandateError("A mandate has a start and a later end.");
    const signers = [...new Map(input.signers.map((s) => [s.userId, s])).values()];
    if (!Number.isInteger(input.required) || input.required < 1 || input.required > signers.length) throw new MandateError("The number of signatures needed must be between 1 and the number of signers.");
    const of: Signer[] = [];
    for (const signer of signers) {
      const publicKey = await this.signerKey(signer.userId);
      if (!publicKey) throw new MandateError(`${signer.userId} has no signing key yet: they set it up once, in their browser.`);
      of.push({ id: signer.userId, ...(signer.role ? { role: signer.role } : {}), publicKey });
    }
    const key = await this.organizationKey(now);
    const id = `mdt_${randomBytes(9).toString("base64url")}`;
    return this.sql.transaction(async (tx) => {
      const next = await tx.all<{ n: number | null }>(`SELECT MAX(status_index) AS n FROM ${MANDATES_TABLE} WHERE organization_id = ?`, [this.org]);
      const max = next[0]?.n;
      const index = max === null || max === undefined ? 0 : Number(max) + 1;
      const mandate: Mandate = {
        type: MANDATE_TYPE,
        id,
        issuer: { organization: String(this.org), publicKey: publicKeyOf(key) },
        agent: input.agent,
        grants: input.grants,
        validity: { notBefore: new Date(input.notBefore).toISOString(), notAfter: new Date(input.notAfter).toISOString() },
        approval: { required: input.required, of },
        status: { url: statusUrl, index },
      };
      const signed = issueMandate(mandate, key);
      await tx.run(`INSERT INTO ${MANDATES_TABLE} (id, organization_id, status_index, state, document, created_by, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`, [id, this.org, index, JSON.stringify(signed), by, now.toISOString()]);
      return this.view({ id, state: "pending", document: JSON.stringify(signed), created_by: by, created_at: now.toISOString(), revoked_by: null, revoked_at: null }, now);
    });
  }

  /**
   * Une personne apporte SA signature, faite dans son navigateur sur la forme canonique du
   * mandat. Elle est vérifiée avec la clé publique que le mandat lui donne ; à la dernière
   * signature requise, le mandat devient actif.
   */
  async sign(id: string, userId: string, signature: string, now = new Date()): Promise<MandateView> {
    const row = await this.row(id);
    if (row.state === "revoked") throw new MandateError("This mandate has been revoked.", 409);
    const signed = JSON.parse(row.document) as SignedMandate;
    const signer = signed.mandate.approval.of.find((candidate) => candidate.id === userId);
    if (!signer) throw new MandateError("You are not one of this mandate's signers.", 403);
    if (!this.validSignature(signed.mandate, signature, signer.publicKey)) throw new MandateError("This signature is not yours, or not on this mandate.", 400);
    const next: SignedMandate = { ...signed, signatures: [...signed.signatures.filter((s) => s.by !== userId), { by: userId, signature }] };
    const state: MandateState = next.signatures.length >= signed.mandate.approval.required ? "active" : "pending";
    await this.sql.run(`UPDATE ${MANDATES_TABLE} SET document = ?, state = ? WHERE organization_id = ? AND id = ? AND state <> 'revoked'`, [JSON.stringify(next), state, this.org, id]);
    return this.view({ ...row, document: JSON.stringify(next), state }, now);
  }

  async revoke(id: string, by: string, now = new Date()): Promise<MandateView> {
    const row = await this.row(id);
    if (row.state !== "revoked") {
      await this.sql.run(`UPDATE ${MANDATES_TABLE} SET state = 'revoked', revoked_by = ?, revoked_at = ? WHERE organization_id = ? AND id = ?`, [by, now.toISOString(), this.org, id]);
    }
    return this.view({ ...row, state: "revoked", revoked_by: row.revoked_by ?? by, revoked_at: row.revoked_at ?? now.toISOString() }, now);
  }

  async list(now = new Date()): Promise<MandateView[]> {
    const rows = await this.sql.all<Row>(`SELECT id, state, document, created_by, created_at, revoked_by, revoked_at FROM ${MANDATES_TABLE} WHERE organization_id = ? ORDER BY created_at DESC`, [this.org]);
    return rows.map((row) => this.view(row, now));
  }

  async get(id: string, now = new Date()): Promise<MandateView> {
    return this.view(await this.row(id), now);
  }

  /** L'organisation a-t-elle des mandats ? (La liste publique n'existe que pour elle.) */
  async hasMandates(): Promise<boolean> {
    const rows = await this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${MANDATES_TABLE} WHERE organization_id = ?`, [this.org]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** La liste de révocation de l'organisation, signée : ce que les contreparties relisent. */
  async statusList(now = new Date()): Promise<SignedStatus> {
    const rows = await this.sql.all<{ status_index: number }>(`SELECT status_index FROM ${MANDATES_TABLE} WHERE organization_id = ? AND state = 'revoked'`, [this.org]);
    return signStatus(rows.map((r) => Number(r.status_index)), await this.organizationKey(now), now);
  }

  /**
   * L'autorisation d'UNE action, pour l'agent du mandat : le mandat doit être actif, en cours de
   * validité, et l'action dans ses limites ET dans ses cumuls. L'agent la contresigne ensuite
   * avec sa propre clé (`presentGrant`), qui ne quitte jamais l'agent.
   */
  async grant(id: string, agentId: string, action: MandateAction, now = new Date()): Promise<{ grant: Grant; issuerSignature: string }> {
    const view = await this.get(id, now);
    const { mandate } = view.signed;
    if (mandate.agent.id !== agentId) throw new MandateError("This mandate is not this agent's.", 403);
    if (view.state === "revoked") throw new MandateError("Not granted: the mandate has been revoked.", 403);
    if (view.state === "pending") throw new MandateError(`Not granted: the mandate is signed by ${String(view.signedBy.length)} of the ${String(view.required)} people it needs.`, 403);
    if (view.state === "expired" || now.getTime() < Date.parse(mandate.validity.notBefore)) throw new MandateError("Not granted: the mandate is not in force.", 403);
    const issuerKey = await this.organizationKey(now);
    /*
     * LE CUMUL, LU ET ÉCRIT SOUS VERROU (test de charge du 9 novembre). Lu, puis l'autorisation
     * écrite plus tard, il laissait des paiements simultanés lire tous le même cumul : cinq
     * paiements de 4 000 € passaient sous un plafond de 10 000 €. La ligne du mandat est
     * verrouillée en tête de transaction (en PostgreSQL, jusqu'à la validation ; en SQLite, la
     * transaction est IMMEDIATE) : les autorisations d'un même mandat passent une par une, sur
     * une instance comme sur plusieurs.
     */
    return this.sql.transaction(async (tx) => {
      await tx.run(`UPDATE ${MANDATES_TABLE} SET state = state WHERE organization_id = ? AND id = ?`, [this.org, id]);
      const spent = await this.spent(mandate, action, now, tx);
      const allowed = checkAction(mandate, action, spent ?? undefined);
      if (!allowed.ok) throw new MandateError(`Not granted: ${allowed.reason}.`, 403);
      const nonce = randomBytes(12).toString("base64url");
      const issued = issueGrant(view.signed, action, issuerKey, { now, id: `grt_${nonce}`, nonce, ...(spent ? { spent } : {}) });
      await tx.run(`INSERT INTO ${MANDATE_GRANTS_TABLE} (id, organization_id, mandate_id, action_hash, amount, currency, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        issued.grant.id,
        this.org,
        id,
        issued.grant.actionHash,
        action.amount?.value ?? null,
        action.amount?.currency ?? null,
        now.toISOString(),
      ]);
      return issued;
    });
  }

  /* ── Les reçus contresignés (étape M4) ─────────────────────────────────────────────── */

  /**
   * L'agent rapporte le reçu que la contrepartie a signé pour une autorisation que CETTE
   * organisation a émise. Vérifié en entier (`verifyDualReceipt`), puis ajouté à la chaîne de
   * l'organisation : une fois, et dans l'ordre.
   */
  async recordReceipt(id: string, agentId: string, payload: { grant?: SignedGrant; countersigned?: Countersigned }, now = new Date()): Promise<{ seq: number; entryHash: string }> {
    const view = await this.get(id, now);
    if (view.signed.mandate.agent.id !== agentId) throw new MandateError("This mandate is not this agent's.", 403);
    const { grant, countersigned } = payload ?? {};
    if (!grant?.grant?.id || !countersigned?.statement) throw new MandateError("The authorization and the counterparty's receipt are required.");
    const issued = await this.sql.all<{ id: string }>(`SELECT id FROM ${MANDATE_GRANTS_TABLE} WHERE organization_id = ? AND mandate_id = ? AND id = ?`, [this.org, id, grant.grant.id]);
    if (!issued[0]) throw new MandateError("This organization never issued this authorization.", 404);
    /* L'émetteur attendu : la clé de CETTE organisation, tenue par le coffre, pas celle qu'annonce le mandat en base. */
    const check = verifyDualReceipt({ mandate: view.signed, grant, countersigned }, { trustedIssuers: [fingerprintOfKey(await this.organizationPublicKey(now))] });
    if (!check.ok) throw new MandateError(`Not recorded: ${check.reason}.`, 422);
    return this.sql.transaction(async (tx) => {
      const already = await tx.all<{ entry_seq: number }>(`SELECT entry_seq FROM ${MANDATE_RECEIPTS_TABLE} WHERE organization_id = ? AND grant_id = ?`, [this.org, grant.grant.id]);
      if (already[0]) throw new MandateError("This receipt is already recorded.", 409);
      const last = await tx.all<{ entry_seq: number; entry_hash: string }>(`SELECT entry_seq, entry_hash FROM ${MANDATE_RECEIPTS_TABLE} WHERE organization_id = ? ORDER BY entry_seq DESC LIMIT 1`, [this.org]);
      const seq = last[0] ? Number(last[0].entry_seq) + 1 : 1;
      const prev = last[0]?.entry_hash ?? null;
      const document = JSON.stringify({ grant, countersigned });
      const recordedAt = now.toISOString();
      const entryHash = this.receiptHash(prev, { seq, mandateId: id, grantId: grant.grant.id, document, recordedAt });
      await tx.run(
        `INSERT INTO ${MANDATE_RECEIPTS_TABLE} (organization_id, grant_id, mandate_id, outcome, counterparty, document, recorded_at, entry_seq, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.org, grant.grant.id, id, countersigned.statement.outcome, countersigned.statement.counterparty.fingerprint, document, recordedAt, seq, prev, entryHash],
      );
      return { seq, entryHash };
    });
  }

  /** Les reçus contresignés d'un mandat, du plus ancien au plus récent. */
  async receipts(id: string): Promise<{ grant: SignedGrant; countersigned: Countersigned; seq: number; recordedAt: string }[]> {
    await this.row(id);
    const rows = await this.sql.all<{ document: string; entry_seq: number; recorded_at: unknown }>(
      `SELECT document, entry_seq, recorded_at FROM ${MANDATE_RECEIPTS_TABLE} WHERE organization_id = ? AND mandate_id = ? ORDER BY entry_seq ASC`,
      [this.org, id],
    );
    return rows.map((row) => ({ ...(JSON.parse(row.document) as { grant: SignedGrant; countersigned: Countersigned }), seq: Number(row.entry_seq), recordedAt: iso(row.recorded_at) }));
  }

  /** La chaîne des reçus contresignés de l'organisation, relue en entier. */
  async verifyReceiptChain(): Promise<{ ok: boolean; entries: number; brokenAt: number | null; reason: string | null }> {
    const rows = await this.sql.all<{ grant_id: string; mandate_id: string; document: string; recorded_at: unknown; entry_seq: number; prev_hash: string | null; entry_hash: string }>(
      `SELECT grant_id, mandate_id, document, recorded_at, entry_seq, prev_hash, entry_hash FROM ${MANDATE_RECEIPTS_TABLE} WHERE organization_id = ? ORDER BY entry_seq ASC`,
      [this.org],
    );
    let prev: string | null = null;
    for (const [index, row] of rows.entries()) {
      const seq = Number(row.entry_seq);
      if (seq !== index + 1) return { ok: false, entries: rows.length, brokenAt: index + 1, reason: "a receipt is missing from the chain" };
      if ((row.prev_hash ?? null) !== prev) return { ok: false, entries: rows.length, brokenAt: seq, reason: "the chain was reordered or a receipt removed" };
      if (this.receiptHash(prev, { seq, mandateId: row.mandate_id, grantId: row.grant_id, document: row.document, recordedAt: iso(row.recorded_at) }) !== row.entry_hash) {
        return { ok: false, entries: rows.length, brokenAt: seq, reason: "a receipt was changed after it was recorded" };
      }
      prev = row.entry_hash;
    }
    return { ok: true, entries: rows.length, brokenAt: null, reason: null };
  }

  private receiptHash(prev: string | null, entry: { seq: number; mandateId: string; grantId: string; document: string; recordedAt: string }): string {
    return createHash("sha256").update(`${prev ?? `genesis:mandate-receipts:${String(this.org)}`}\u0000${canonical(entry)}`, "utf8").digest("hex");
  }

  /* ── Interne ───────────────────────────────────────────────────────────────────────── */

  /** Ce que l'agent a déjà obtenu sur la période du cumul qui couvre cette action. */
  private async spent(mandate: Mandate, action: MandateAction, now: Date, sql: SqlExecutor = this.sql): Promise<{ value: number; currency: string } | null> {
    const cap = mandate.grants.find((g) => g.constraints?.periodCap && g.actions.some((a) => a === action.type || (a.endsWith(".*") && action.type.startsWith(a.slice(0, -1)))))?.constraints?.periodCap;
    if (!cap) return null;
    const since = new Date(now.getTime() - (PERIOD_MS[cap.period] ?? PERIOD_MS.P1M!)).toISOString();
    const rows = await sql.all<{ total: number | null }>(
      `SELECT SUM(amount) AS total FROM ${MANDATE_GRANTS_TABLE} WHERE organization_id = ? AND mandate_id = ? AND currency = ? AND issued_at >= ?`,
      [this.org, mandate.id, cap.currency, since],
    );
    return { value: Number(rows[0]?.total ?? 0), currency: cap.currency };
  }

  private validSignature(mandate: Mandate, signature: string, publicKey: string): boolean {
    try {
      const key = { key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "base64").toString("base64url") }, format: "jwk" as const };
      return verify(null, Buffer.from(canonical(mandate), "utf8"), key, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }

  private async row(id: string): Promise<Row> {
    const rows = await this.sql.all<Row>(`SELECT id, state, document, created_by, created_at, revoked_by, revoked_at FROM ${MANDATES_TABLE} WHERE organization_id = ? AND id = ?`, [this.org, id]);
    if (!rows[0]) throw new MandateError("No mandate with this id.", 404);
    return rows[0];
  }

  private view(row: Row, now: Date): MandateView {
    const signed = JSON.parse(row.document) as SignedMandate;
    const expired = row.state !== "revoked" && now.getTime() > Date.parse(signed.mandate.validity.notAfter);
    return {
      id: row.id,
      state: expired ? "expired" : row.state,
      signed,
      signedBy: signed.signatures.map((s) => s.by),
      required: signed.mandate.approval.required,
      createdBy: row.created_by,
      createdAt: iso(row.created_at),
      revokedBy: row.revoked_by,
      revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    };
  }
}
