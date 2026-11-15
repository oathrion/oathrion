/**
 * Persistence for the action authorization data plane (Phase 10).
 *
 * ONE IMPLEMENTATION, TWO ENGINES
 * -------------------------------
 * Written once against `SqlExecutor` in portable SQL. That is not tidiness: the
 * three statements in this file that decide whether an action executes — issue,
 * approve, consume — are conditional UPDATEs whose affected-row count IS the
 * security decision. Two hand-written copies of those statements would be two
 * chances to get the WHERE clause subtly different, and the difference would only
 * show up in production, on the engine nobody tested.
 *
 * THE THREE STATEMENTS THAT MATTER
 * --------------------------------
 * `approveGrant`   : pending_approval → issued, once. A second approval of the
 *                    same grant affects zero rows, which is what makes approval
 *                    replay (§15) impossible rather than merely detected.
 * `consumeGrant`   : issued → consumed, once, and only while unexpired. Two
 *                    concurrent consumers both issue this UPDATE; the engine
 *                    serialises them on the row lock, so exactly one sees
 *                    `changes === 1`. That is the whole of §13 and §31.
 * `createAction`   : refuses a reused idempotency key whose action hash differs,
 *                    via a UNIQUE index rather than a read-then-write.
 *
 * Every statement is scoped by `organization_id`. A grant id from another tenant
 * is not "rejected" — it is not found, because the query cannot see it.
 */

import type { ActionConstraint } from "@shared/policy/constraints";
import { parseConstraints } from "@shared/policy/constraints";
import type { OrganizationId } from "@shared/tenancy";
import {
  ACTIONS_TABLE,
  ACTION_GRANTS_TABLE,
  ACTION_POLICIES_TABLE,
  ACTION_RECEIPTS_TABLE,
  RECEIPT_CHAIN_CHECKPOINTS_TABLE,
} from "../migrations";
import type { SqlExecutor } from "../sql/executor";
import { executionQuotaLockKey, incrementPeriodUsage, periodUsage } from "../sql/execution-quota";

export type ActionDecision = "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
export type GrantState = "pending_approval" | "issued" | "consumed" | "revoked";

export interface ActionRecord {
  id: string;
  agentId: string;
  action: string;
  arguments: Record<string, unknown>;
  destinationId: string;
  canonical: string;
  actionHash: string;
  requestId: string | null;
  idempotencyKey: string | null;
  decision: ActionDecision;
  reason: string;
  policyId: string | null;
  createdAt: string;
}

export interface GrantRecord {
  id: string;
  actionId: string;
  agentId: string;
  action: string;
  actionHash: string;
  destinationId: string;
  decision: ActionDecision;
  state: GrantState;
  requestId: string | null;
  idempotencyKey: string | null;
  policyId: string | null;
  createdAt: string;
  issuedAt: string | null;
  expiresAt: string;
  consumedAt: string | null;
  consumedBy: string | null;
  approvalId: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface ReceiptRecord {
  receiptId: string;
  grantId: string;
  actionId: string;
  agentId: string;
  action: string;
  actionHash: string;
  destinationId: string;
  decision: ActionDecision;
  approvalId: string | null;
  executedAt: string;
  downstreamExecutionId: string | null;
  outcome: "succeeded" | "failed";
  resultHash: string;
  resultSummary: string;
  prevHash: string | null;
  entryHash: string;
  /**
   * Position of this receipt in its tenant's total order, 1-based and gap-free
   * (migration 013). NULL only for receipts written before that migration existed;
   * every receipt this build writes has one.
   */
  entrySeq: number | null;
}

export interface ActionPolicyRecord {
  id: string;
  name: string;
  action: string;
  destinationId: string | null;
  effect: ActionDecision;
  constraints: ActionConstraint[];
  priority: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

/** Le point de reprise de la vérification d'une chaîne : jusqu'où elle a été vérifiée, et quand. */
export interface ChainCheckpoint {
  entries: number;
  entrySeq: number;
  entryHash: string;
  verifiedAt: string;
  /** La dernière vérification COMPLÈTE réussie, la seule qui voit une modification ancienne. */
  fullVerifiedAt: string | null;
}

export class IdempotencyConflict extends Error {
  constructor(
    readonly key: string,
    readonly existing: ActionRecord,
  ) {
    super(
      `Idempotency key "${key}" was already used for a different action ` +
        `(${existing.action}, hash ${existing.actionHash.slice(0, 12)}…). ` +
        `A key identifies one exact action; reusing it for another is refused.`,
    );
    this.name = "IdempotencyConflict";
  }
}

/* ------------------------------- row mapping ------------------------------ */

type Row = Record<string, unknown>;

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const nullable = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

/*
 * Instants, read from either engine.
 *
 * SQLite has no timestamp type and hands back the ISO string that was written. Since
 * migration 14 PostgreSQL stores these columns as `timestamptz`, and the driver hands
 * back a JavaScript `Date`. `String(date)` would produce
 * "Sun Mar 01 2026 10:00:00 GMT+0000" — not an ISO instant, not comparable as text, and
 * not the value a receipt hash was computed over. So a Date is normalised back to the
 * millisecond-precision ISO form that was written, which makes the round trip exact for
 * every instant Oathrion writes: all of them come from `new Date().toISOString()`.
 */
const instant = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : str(value);
const instantOrNull = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : nullable(value);

function toAction(row: Row): ActionRecord {
  return {
    id: str(row.id),
    agentId: str(row.agent_id),
    action: str(row.action),
    arguments: JSON.parse(str(row.arguments) || "{}") as Record<string, unknown>,
    destinationId: str(row.destination_id),
    canonical: str(row.canonical),
    actionHash: str(row.action_hash),
    requestId: nullable(row.request_id),
    idempotencyKey: nullable(row.idempotency_key),
    decision: str(row.decision) as ActionDecision,
    reason: str(row.reason),
    policyId: nullable(row.policy_id),
    createdAt: instant(row.created_at),
  };
}

function toGrant(row: Row): GrantRecord {
  return {
    id: str(row.id),
    actionId: str(row.action_id),
    agentId: str(row.agent_id),
    action: str(row.action),
    actionHash: str(row.action_hash),
    destinationId: str(row.destination_id),
    decision: str(row.decision) as ActionDecision,
    state: str(row.state) as GrantState,
    requestId: nullable(row.request_id),
    idempotencyKey: nullable(row.idempotency_key),
    policyId: nullable(row.policy_id),
    createdAt: instant(row.created_at),
    issuedAt: instantOrNull(row.issued_at),
    expiresAt: instant(row.expires_at),
    consumedAt: instantOrNull(row.consumed_at),
    consumedBy: nullable(row.consumed_by),
    approvalId: nullable(row.approval_id),
    approvedAt: instantOrNull(row.approved_at),
    approvedBy: nullable(row.approved_by),
    revokedAt: instantOrNull(row.revoked_at),
    revokedReason: nullable(row.revoked_reason),
  };
}

/**
 * Is this the database refusing a duplicate key?
 *
 * Both engines are asked, by their own vocabulary: PostgreSQL reports SQLSTATE 23505
 * on `error.code`, better-sqlite3 puts `SQLITE_CONSTRAINT_UNIQUE` (or
 * `SQLITE_CONSTRAINT_PRIMARYKEY`) there. Matched on the code and, as a fallback, on the
 * message, because a driver wrapping the error can lose the code. Deliberately narrow:
 * a retry loop that treats every error as contention would retry a genuine bug five
 * times and then report the wrong cause.
 */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    if (code === "23505") return true;
    if (code.startsWith("SQLITE_CONSTRAINT")) return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /duplicate key value|UNIQUE constraint failed/i.test(message);
}

/**
 * Une ligne de `action_receipts` vers un reçu.
 *
 * **Exportée**, et il faut dire pourquoi : `script/audit-chains.ts` lit la table
 * directement — l'exploitant possède la base et aucune route ne parcourt tous les
 * locataires — et doit donc convertir des lignes en reçus pour les donner à
 * `verifyReceiptChain`. Son premier jet avait sa propre conversion, et elle était
 * FAUSSE d'une façon instructive : `new Date(String(row.executed_at))` perd les
 * millisecondes, parce que `String(Date)` ne les écrit pas. Le hachage portait donc sur
 * un instant différent de celui qui avait été écrit, et l'audit déclarait rompue toute
 * chaîne parfaitement saine — soit la pire panne imaginable pour un outil dont l'unique
 * rôle est de dire si une chaîne tient.
 *
 * Trouvée par `npm run verify:obs`, qui exige que l'audit sorte 0 sur une base intacte
 * AVANT de vérifier qu'il sort 1 sur une base falsifiée : sans ce contrôle positif,
 * « il a détecté la rupture » aurait été vrai pour la mauvaise raison.
 */
export function receiptFromRow(row: Row): ReceiptRecord {
  return toReceipt(row);
}

function toReceipt(row: Row): ReceiptRecord {
  return {
    receiptId: str(row.receipt_id),
    grantId: str(row.grant_id),
    actionId: str(row.action_id),
    agentId: str(row.agent_id),
    action: str(row.action),
    actionHash: str(row.action_hash),
    destinationId: str(row.destination_id),
    decision: str(row.decision) as ActionDecision,
    approvalId: nullable(row.approval_id),
    executedAt: instant(row.executed_at),
    downstreamExecutionId: nullable(row.downstream_execution_id),
    outcome: str(row.outcome) === "failed" ? "failed" : "succeeded",
    resultHash: str(row.result_hash),
    resultSummary: str(row.result_summary),
    prevHash: nullable(row.prev_hash),
    entryHash: str(row.entry_hash),
    entrySeq: row.entry_seq === null || row.entry_seq === undefined ? null : Number(row.entry_seq),
  };
}

function toPolicy(row: Row): ActionPolicyRecord {
  return {
    id: str(row.id),
    name: str(row.name),
    action: str(row.action),
    destinationId: nullable(row.destination_id),
    effect: str(row.effect) as ActionDecision,
    // Parsed through the same validator used on write. A row that was tampered
    // with directly in the database fails loudly here rather than evaluating as
    // an empty constraint list, which would silently widen the rule.
    constraints: parseConstraints(JSON.parse(str(row.constraints) || "[]")),
    priority: Number(row.priority ?? 0),
    status: str(row.status) === "disabled" ? "disabled" : "active",
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  };
}

/* --------------------------------- store --------------------------------- */

/* Le quota d'exécutions du mois : `server/sql/execution-quota.ts`, une seule définition. */
export { countExecutionsSince, executionQuotaLockKey } from "../sql/execution-quota";

export class ActionAuthorityStore {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
  ) {}

  /* ---- actions ---- */

  /**
   * Inserts the action, or resolves an idempotent retry to the original.
   *
   * `replayed` is returned rather than inferred by the caller: whether this is a
   * first decision or a retry of one changes whether a second grant may be
   * issued, and a caller that had to guess would guess wrong.
   */
  async createAction(record: ActionRecord): Promise<{ action: ActionRecord; replayed: boolean }> {
    if (record.idempotencyKey) {
      const existing = await this.findActionByIdempotencyKey(record.idempotencyKey);
      if (existing) {
        /*
         * Same key, same action: this is a retry, and the exactly-once contract
         * says it must resolve to the first action rather than create a second.
         * Same key, different action: refused. The key is a claim of identity and
         * the claim is false.
         */
        if (existing.actionHash === record.actionHash) return { action: existing, replayed: true };
        throw new IdempotencyConflict(record.idempotencyKey, existing);
      }
    }

    try {
      await this.sql.run(
        `INSERT INTO ${ACTIONS_TABLE}
           (organization_id, id, agent_id, action, arguments, destination_id, canonical,
            action_hash, request_id, idempotency_key, decision, reason, policy_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.org,
          record.id,
          record.agentId,
          record.action,
          JSON.stringify(record.arguments),
          record.destinationId,
          record.canonical,
          record.actionHash,
          record.requestId,
          record.idempotencyKey,
          record.decision,
          record.reason,
          record.policyId,
          record.createdAt,
        ],
      );
    } catch (error) {
      /*
       * The UNIQUE index fired, which means a concurrent request used the same
       * key between the read above and this insert. Re-read and apply the same
       * rule: identical action → that action; different action → refusal. The
       * read-then-write above is a fast path, not the guarantee; the index is.
       */
      if (record.idempotencyKey) {
        const existing = await this.findActionByIdempotencyKey(record.idempotencyKey);
        if (existing) {
          if (existing.actionHash === record.actionHash) return { action: existing, replayed: true };
          throw new IdempotencyConflict(record.idempotencyKey, existing);
        }
      }
      throw error;
    }
    return { action: record, replayed: false };
  }

  async findAction(id: string): Promise<ActionRecord | undefined> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTIONS_TABLE} WHERE organization_id = ? AND id = ?`,
      [this.org, id],
    );
    return rows[0] ? toAction(rows[0]) : undefined;
  }

  async findActionByIdempotencyKey(key: string): Promise<ActionRecord | undefined> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTIONS_TABLE} WHERE organization_id = ? AND idempotency_key = ?`,
      [this.org, key],
    );
    return rows[0] ? toAction(rows[0]) : undefined;
  }

  /* ---- action policies ---- */

  async listPolicies(): Promise<ActionPolicyRecord[]> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_POLICIES_TABLE}
        WHERE organization_id = ?
        ORDER BY priority DESC, id ASC`,
      [this.org],
    );
    return rows.map(toPolicy);
  }

  async savePolicy(policy: ActionPolicyRecord): Promise<ActionPolicyRecord> {
    // Validated on the way in as well as on the way out: a rule that cannot be
    // evaluated must never be storable.
    const constraints = parseConstraints(policy.constraints);
    /*
     * One transaction: a replace that fails half-way must not leave the tenant
     * with its rule deleted and nothing inserted (a silently vanished BLOCK rule).
     */
    await this.sql.transaction(async (tx) => {
      const deleted = await tx.run(
        `DELETE FROM ${ACTION_POLICIES_TABLE} WHERE organization_id = ? AND id = ?`,
        [this.org, policy.id],
      );
      await tx.run(
        `INSERT INTO ${ACTION_POLICIES_TABLE}
           (organization_id, id, name, action, destination_id, effect, constraints, priority,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.org,
          policy.id,
          policy.name,
          policy.action,
          policy.destinationId,
          policy.effect,
          JSON.stringify(constraints),
          policy.priority,
          policy.status,
          deleted > 0 ? policy.createdAt : policy.createdAt,
          policy.updatedAt,
        ],
      );
    });
    return { ...policy, constraints };
  }

  /* ---- grants ---- */

  /**
   * UN GRANT DONT LA DÉCISION EST `BLOCK` N'EXISTE PAS, et c'est désormais refusé ICI.
   *
   * ## L'anomalie que ce garde rend impossible
   *
   * Un passage de la suite complète a produit, deux fois, une ligne de grant portant
   * `decision: "BLOCK"`, `state: "issued"`, `idempotencyKey: null`. L'isolation entre
   * locataires avait tenu — le refus était correct — mais une ligne existait là où
   * `authorize()` rend `grant: null`.
   *
   * ## Ce que la lecture du code établit, et ce qu'elle n'établit pas
   *
   * Les deux seules voies connues sont fermées, et je l'ai vérifié ligne par ligne :
   *
   *   · `authorize()` retourne AVANT tout appel à `createGrant` quand le verdict est
   *     BLOCK ;
   *   · le rejeu idempotent exige une `idempotencyKey`, que `buildActionEnvelope` laisse
   *     à `null` quand l'appelant n'en passe pas — et le test en cause n'en passe pas.
   *     `createAction` ne déclare donc jamais `replayed`, et cette branche est
   *     inatteignable.
   *
   * Le mécanisme reste INCONNU. Je ne l'ai pas reproduit, et je ne prétends pas l'avoir
   * corrigé.
   *
   * ## Pourquoi un garde ici plutôt qu'un raisonnement de plus
   *
   * `consumeGrant` porte déjà `AND decision <> 'BLOCK'`, donc rien ne pouvait s'exécuter.
   * Mais une consommation bloquée laisse la BASE dans un état incohérent : un auditeur
   * qui lit la table y voit une autorisation là où il n'y en a jamais eu. La contrainte
   * n'était posée qu'à la LECTURE, et nulle part à l'écriture.
   *
   * Elle l'est maintenant au seul point d'écriture. Deux conséquences :
   *
   *   · l'état incohérent devient impossible à écrire, quelle que soit la voie ;
   *   · si le mécanisme inconnu se déclenche à nouveau, il LÈVE avec son propre nom au
   *     lieu d'écrire une ligne en silence. Une anomalie qui se signale est une anomalie
   *     qu'on finit par trouver ; celle-ci avait coûté deux passages de suite à
   *     simplement être remarquée.
   *
   * Le garde est redondant avec `authorize()` par construction. C'est voulu : une
   * invariante de données appartient à la couche qui écrit les données, pas à l'appelant
   * qui a eu raison aujourd'hui.
   */
  async createGrant(grant: GrantRecord): Promise<GrantRecord> {
    if (grant.decision === "BLOCK") {
      throw new Error(
        `Refusing to write a grant whose decision is BLOCK (action ${grant.actionId}, ` +
          `agent ${grant.agentId}, destination ${grant.destinationId}). A BLOCK authorizes ` +
          `nothing: it has no grant. If this error appears, the path that called ` +
          `createGrant is the defect — not this guard.`,
      );
    }
    await this.sql.run(
      `INSERT INTO ${ACTION_GRANTS_TABLE}
         (organization_id, id, action_id, agent_id, action, action_hash, destination_id, decision,
          state, request_id, idempotency_key, policy_id, created_at, issued_at, expires_at,
          consumed_at, consumed_by, approval_id, approved_at, approved_by, revoked_at, revoked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.org,
        grant.id,
        grant.actionId,
        grant.agentId,
        grant.action,
        grant.actionHash,
        grant.destinationId,
        grant.decision,
        grant.state,
        grant.requestId,
        grant.idempotencyKey,
        grant.policyId,
        grant.createdAt,
        grant.issuedAt,
        grant.expiresAt,
        grant.consumedAt,
        grant.consumedBy,
        grant.approvalId,
        grant.approvedAt,
        grant.approvedBy,
        grant.revokedAt,
        grant.revokedReason,
      ],
    );
    return grant;
  }

  async findGrant(id: string): Promise<GrantRecord | undefined> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_GRANTS_TABLE} WHERE organization_id = ? AND id = ?`,
      [this.org, id],
    );
    return rows[0] ? toGrant(rows[0]) : undefined;
  }

  async findGrantByApprovalId(approvalId: string): Promise<GrantRecord | undefined> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_GRANTS_TABLE} WHERE organization_id = ? AND approval_id = ?`,
      [this.org, approvalId],
    );
    return rows[0] ? toGrant(rows[0]) : undefined;
  }

  /**
   * pending_approval → issued, exactly once.
   *
   * `expected` pins the action this approval is for. The caller passes the hash it
   * showed the human, so an approval cannot be applied to a grant whose action
   * changed underneath it. Combined with the state predicate, this is §14 and §15.
   */
  async approveGrant(input: {
    id: string;
    expectedActionHash: string;
    approvedBy: string;
    at: string;
    expiresAt: string;
    notBefore: string;
  }): Promise<{ claimed: boolean; grant?: GrantRecord }> {
    const changes = await this.sql.run(
      `UPDATE ${ACTION_GRANTS_TABLE}
          SET state = 'issued',
              issued_at = ?,
              expires_at = ?,
              approved_at = ?,
              approved_by = ?
        WHERE organization_id = ?
          AND id = ?
          AND state = 'pending_approval'
          AND action_hash = ?
          AND expires_at > ?`,
      [
        input.at,
        input.expiresAt,
        input.at,
        input.approvedBy,
        this.org,
        input.id,
        input.expectedActionHash,
        input.notBefore,
      ],
    );
    const grant = await this.findGrant(input.id);
    return { claimed: changes === 1, grant };
  }

  /** pending_approval → revoked (a rejection). Never reaches a downstream. */
  async rejectGrant(input: {
    id: string;
    rejectedBy: string;
    at: string;
    reason: string;
  }): Promise<{ claimed: boolean; grant?: GrantRecord }> {
    const changes = await this.sql.run(
      `UPDATE ${ACTION_GRANTS_TABLE}
          SET state = 'revoked', revoked_at = ?, revoked_reason = ?, approved_by = ?
        WHERE organization_id = ? AND id = ? AND state = 'pending_approval'`,
      [input.at, input.reason, input.rejectedBy, this.org, input.id],
    );
    const grant = await this.findGrant(input.id);
    return { claimed: changes === 1, grant };
  }

  /**
   * issued → consumed, exactly once, and only for the exact bound context.
   *
   * Every protected field is in the WHERE clause rather than compared in
   * application code beforehand. Both are done — the enforcement point compares
   * first so it can report *which* field differed — but the comparison that
   * decides is this one, because it is the one that cannot be raced.
   */
  async consumeGrant(
    input: {
      id: string;
      agentId: string;
      actionHash: string;
      destinationId: string;
      at: string;
      consumedBy: string;
    },
    /**
     * Le quota mensuel d'exécutions, vérifié DANS la transaction qui consomme.
     *
     * Le premier essai (journal §5.26) comptait les reçus AVANT de consommer, hors de
     * toute transaction : à 1 024 clients, 1 279 exécutions sont passées pour un plafond
     * de 600 (§5.27) — le reçu n'est écrit qu'après l'appel au fournisseur, donc toutes
     * les exécutions en vol étaient invisibles. Ici le comptage porte sur les
     * autorisations CONSOMMÉES (l'instant de la décision d'exécuter) plus les exécutions
     * du relais, sous un verrou par locataire (`pg_advisory_xact_lock` ; sur SQLite la
     * transaction IMMEDIATE suffit) que la voie du relais prend aussi
     * (`assertWithinQuotaPg`). Compter puis consommer ne peut plus se chevaucher.
     */
    quota?: { limit: number; since: string; enforce: boolean },
  ): Promise<{ claimed: boolean; grant?: GrantRecord; quota?: { used: number; over: boolean } }> {
    const consume = (executor: SqlExecutor) =>
      executor.run(
        `UPDATE ${ACTION_GRANTS_TABLE}
            SET state = 'consumed', consumed_at = ?, consumed_by = ?
          WHERE organization_id = ?
            AND id = ?
            AND state = 'issued'
            AND agent_id = ?
            AND action_hash = ?
            AND destination_id = ?
            AND decision <> 'BLOCK'
            AND expires_at > ?`,
        [
          input.at,
          input.consumedBy,
          this.org,
          input.id,
          input.agentId,
          input.actionHash,
          input.destinationId,
          input.at,
        ],
      );
    /*
     * LA CONSOMMATION ET LA RELECTURE DE L'AUTORISATION, DANS UNE SEULE TRANSACTION.
     *
     * La relecture se faisait APRÈS, sur une autre connexion du pool. Sous une pression
     * extrême (1 024 clients, pool saturé, journal §5.28), elle a échoué 18 fois sur un
     * délai d'attente de connexion : l'autorisation était consommée, l'appelant recevait
     * une erreur, et rien — ni appel en aval, ni reçu — ne disait que cette autorité
     * avait été dépensée. Lue dans la transaction, elle ne peut plus manquer : soit la
     * transaction échoue et RIEN n'est consommé, soit elle réussit avec l'autorisation en
     * main.
     */
    const outcome = await this.sql.transaction(async (tx) => {
      let used = 0;
      let over = false;
      if (quota) {
        if (tx.dialect === "postgres") {
          await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, [executionQuotaLockKey(this.org)]);
        }
        used = await periodUsage(tx, this.org, quota.since);
        over = used + 1 > quota.limit;
        if (over && quota.enforce) return { refused: true as const, used };
      }
      const changes = await consume(tx);
      /* Comptée seulement si ELLE a été consommée : une autorisation perdue à la course ne compte pas. */
      if (quota && changes === 1) await incrementPeriodUsage(tx, this.org, quota.since);
      const rows = await tx.all<Row>(`SELECT * FROM ${ACTION_GRANTS_TABLE} WHERE organization_id = ? AND id = ?`, [this.org, input.id]);
      return { refused: false as const, changes, used, over, grant: rows[0] ? toGrant(rows[0]) : undefined };
    });
    if (outcome.refused) return { claimed: false, quota: { used: outcome.used, over: true } };
    return {
      claimed: outcome.changes === 1,
      grant: outcome.grant,
      ...(quota ? { quota: { used: outcome.used, over: outcome.over } } : {}),
    };
  }

  /**
   * LES AUTORISATIONS CONSOMMÉES SANS REÇU — le seul trou que la chaîne ne voit pas.
   *
   * La chaîne prouve que les reçus écrits n'ont été ni modifiés ni retirés. Elle ne dit
   * rien d'une autorisation consommée dont le reçu n'a JAMAIS été écrit : processus tué
   * entre l'appel au fournisseur et le reçu (`verify:faults`, journal §5.29), ou patience
   * du reçu épuisée. L'action a peut-être eu lieu chez le fournisseur. Les rendre
   * VISIBLES est ce qui permet à un exploitant de les rapprocher de chez le fournisseur.
   *
   * Une autorisation consommée à l'instant peut y figurer brièvement : son reçu est en
   * cours d'écriture. `consumedAt` permet de le voir.
   */
  async consumedWithoutReceipt(
    limit = 20,
    /** Seulement celles consommées AVANT cet instant : un reçu en cours d'écriture n'est pas un trou. */
    consumedBefore?: string,
  ): Promise<{ count: number; grants: { id: string; action: string; agentId: string; consumedAt: string | null }[] }> {
    const where = `FROM ${ACTION_GRANTS_TABLE} g
        WHERE g.organization_id = ? AND g.consumed_at IS NOT NULL${consumedBefore ? " AND g.consumed_at < ?" : ""}
          AND NOT EXISTS (SELECT 1 FROM ${ACTION_RECEIPTS_TABLE} r WHERE r.organization_id = g.organization_id AND r.grant_id = g.id)`;
    const params = consumedBefore ? [this.org, consumedBefore] : [this.org];
    const counted = await this.sql.all<{ n: unknown }>(`SELECT count(*) AS n ${where}`, params);
    const rows = await this.sql.all<Row>(`SELECT g.id, g.action, g.agent_id, g.consumed_at ${where} ORDER BY g.consumed_at DESC LIMIT ${String(Math.max(1, Math.floor(limit)))}`, params);
    return {
      count: Number(counted[0]?.n ?? 0),
      grants: rows.map((row) => ({
        id: String(row.id),
        action: String(row.action),
        agentId: String(row.agent_id),
        consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : instant(row.consumed_at),
      })),
    };
  }

  /** Any state → revoked. Used by the sweep and by an operator kill switch. */
  async revokeGrant(id: string, at: string, reason: string): Promise<boolean> {
    const changes = await this.sql.run(
      `UPDATE ${ACTION_GRANTS_TABLE}
          SET state = 'revoked', revoked_at = ?, revoked_reason = ?
        WHERE organization_id = ? AND id = ? AND state IN ('issued', 'pending_approval')`,
      [at, reason, this.org, id],
    );
    return changes === 1;
  }

  /** Grants issued for one action. Used to resolve an idempotent retry. */
  async findGrantsForAction(actionId: string): Promise<GrantRecord[]> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_GRANTS_TABLE}
        WHERE organization_id = ? AND action_id = ?
        ORDER BY created_at ASC, id ASC`,
      [this.org, actionId],
    );
    return rows.map(toGrant);
  }

  async listGrants(limit = 100): Promise<GrantRecord[]> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_GRANTS_TABLE}
        WHERE organization_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [this.org, limit],
    );
    return rows.map(toGrant);
  }

  /* ---- receipts ---- */

  async recordReceipt(receipt: ReceiptRecord): Promise<ReceiptRecord> {
    await this.sql.run(
      `INSERT INTO ${ACTION_RECEIPTS_TABLE}
         (organization_id, receipt_id, grant_id, action_id, agent_id, action, action_hash,
          destination_id, decision, approval_id, executed_at, downstream_execution_id, outcome,
          result_hash, result_summary, prev_hash, entry_hash, entry_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.org,
        receipt.receiptId,
        receipt.grantId,
        receipt.actionId,
        receipt.agentId,
        receipt.action,
        receipt.actionHash,
        receipt.destinationId,
        receipt.decision,
        receipt.approvalId,
        receipt.executedAt,
        receipt.downstreamExecutionId,
        receipt.outcome,
        receipt.resultHash,
        receipt.resultSummary,
        receipt.prevHash,
        receipt.entryHash,
        receipt.entrySeq,
      ],
    );
    return receipt;
  }

  /**
   * Appends a receipt at the tenant's next position, atomically (Phase 11).
   *
   * WHY THE CALLER HANDS OVER A BUILDER INSTEAD OF A RECEIPT
   * -------------------------------------------------------
   * `prev_hash` and `entry_seq` are properties of the tenant's CURRENT head, so a
   * receipt built before the head is read is built against a head that may already
   * have moved. Phase 10 did exactly that — read the head, then insert — and
   * PHASE-10-REPORT.md recorded the consequence: two concurrent receipts could name
   * the same predecessor, turning the chain into a fork. Here the head is read and the
   * successor inserted inside ONE transaction, and the caller's `build` runs in the
   * middle of it, so the hash it computes is over the head that is still the head when
   * the insert lands.
   *
   * THREE MECHANISMS, NOT ONE
   * -------------------------
   *  1. The transaction. On SQLite this is enough by itself: one writer at a time.
   *  2. `pg_advisory_xact_lock`, per tenant, on PostgreSQL. Concurrent appenders for the
   *     same tenant serialise on it; different tenants never wait on each other. Held
   *     until commit or rollback by the engine, so a failing append cannot strand it.
   *  3. `UNIQUE (organization_id, entry_seq)` from migration 013. This is the backstop
   *     that makes the guarantee independent of the lock being taken correctly: two
   *     writers who somehow both computed sequence N cannot both commit. The loser sees
   *     a unique violation and retries, taking N+1.
   *
   * Bounded retries, because an unbounded retry loop under contention is a hang. Five
   * attempts with the lock in place is generous; exhausting them means something other
   * than contention is wrong, and the error is raised rather than swallowed.
   */
  async appendReceipt(
    build: (head: { prevHash: string | null; entrySeq: number }) => ReceiptRecord,
  ): Promise<ReceiptRecord> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await this.sql.transaction(async (tx) => {
          if (tx.dialect === "postgres") {
            await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`placet:receipts:${this.org}`]);
          }
          const head = await this.headWithin(tx);
          const receipt = build({ prevHash: head.entryHash, entrySeq: head.entrySeq + 1 });
          await tx.run(
            `INSERT INTO ${ACTION_RECEIPTS_TABLE}
               (organization_id, receipt_id, grant_id, action_id, agent_id, action, action_hash,
                destination_id, decision, approval_id, executed_at, downstream_execution_id,
                outcome, result_hash, result_summary, prev_hash, entry_hash, entry_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              this.org,
              receipt.receiptId,
              receipt.grantId,
              receipt.actionId,
              receipt.agentId,
              receipt.action,
              receipt.actionHash,
              receipt.destinationId,
              receipt.decision,
              receipt.approvalId,
              receipt.executedAt,
              receipt.downstreamExecutionId,
              receipt.outcome,
              receipt.resultHash,
              receipt.resultSummary,
              receipt.prevHash,
              receipt.entryHash,
              receipt.entrySeq,
            ],
          );
          return receipt;
        });
      } catch (error) {
        lastError = error;
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error(
      `could not append a receipt for ${this.org} after 5 attempts: the per-tenant sequence ` +
        `stayed contended. Underlying error: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /**
   * The tenant's head, read on the executor it is given so it can be the transaction's.
   *
   * Ordered by `entry_seq` — the total order — with `executed_at, receipt_id` only as
   * the tiebreak for pre-013 rows whose sequence is NULL. `coalesce(max(entry_seq), 0)`
   * gives the sequence, so a tenant whose only receipts predate the migration still
   * gets a correct next number after the backfill.
   */
  private async headWithin(
    tx: SqlExecutor,
  ): Promise<{ entryHash: string | null; entrySeq: number }> {
    const rows = await this.newestReceipts(tx, "entry_hash, entry_seq", 1);
    const seqRows = await tx.all<{ max_seq: unknown }>(
      `SELECT coalesce(max(entry_seq), 0) AS max_seq FROM ${ACTION_RECEIPTS_TABLE}
        WHERE organization_id = ?`,
      [this.org],
    );
    return {
      entryHash: rows[0] ? str(rows[0].entry_hash) : null,
      entrySeq: Number(seqRows[0]?.max_seq ?? 0),
    };
  }

  async findReceipt(receiptId: string): Promise<ReceiptRecord | undefined> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? AND receipt_id = ?`,
      [this.org, receiptId],
    );
    return rows[0] ? toReceipt(rows[0]) : undefined;
  }

  async findReceiptByGrant(grantId: string): Promise<ReceiptRecord | undefined> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? AND grant_id = ?`,
      [this.org, grantId],
    );
    return rows[0] ? toReceipt(rows[0]) : undefined;
  }

  async listReceipts(limit = 100): Promise<ReceiptRecord[]> {
    const rows = await this.newestReceipts(this.sql, "*", limit);
    return rows.map(toReceipt);
  }

  /**
   * Toute la chaîne d'un locataire, dans l'ordre CROISSANT de `entry_seq`.
   *
   * Distinct de `listReceipts`, qui pagine en ordre décroissant pour un affichage : une
   * vérification doit partir du premier reçu et suivre les liens, et une page de cent
   * lignes décroissantes ne permet ni l'un ni l'autre. Les reçus antérieurs à la
   * migration 13 n'ont pas de position ; ils sont placés en tête, où le vérificateur les
   * signalera comme une rupture de séquence plutôt que de les ignorer en silence.
   */
  async listReceiptChain(): Promise<ReceiptRecord[]> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_RECEIPTS_TABLE}
        WHERE organization_id = ?
        ORDER BY entry_seq ASC NULLS FIRST, executed_at ASC, receipt_id ASC`,
      [this.org],
    );
    return rows.map(toReceipt);
  }

  /**
   * La même chaîne, dans le même ordre, par lots de `size` reçus : ce que lit la route de
   * vérification.
   *
   * `listReceiptChain` rend un tableau de TOUTE la chaîne : la mémoire de la route qui
   * l'appelait suivait la longueur de la chaîne (`docs/STRESS-TEST-LOG.md` § 5.13). Ici,
   * un lot à la fois, par clé de parcours sur
   * l'ordre exact de `listReceiptChain` :
   *
   *   1. les reçus sans position (antérieurs à la migration 13 — `NULLS FIRST`), par
   *      `(executed_at, receipt_id)` ;
   *   2. puis les reçus positionnés, par `entry_seq` — unique par locataire (index de la
   *      migration 13), donc une clé de parcours exacte, servie par cet index. Le premier
   *      lot n'a pas de borne basse : une position nulle ou négative falsifiée est lue, et
   *      le vérificateur la signale.
   *
   * Un reçu ajouté pendant le parcours arrive en fin de chaîne (position suivante) : il
   * est lu par un lot ultérieur, et la chaîne lue reste un préfixe cohérent.
   */
  async *receiptChainBatches(size = 1000): AsyncGenerator<ReceiptRecord[]> {
    let cursor: { executedAt: unknown; receiptId: unknown } | null = null;
    for (;;) {
      const rows: Row[] = await this.sql.all<Row>(
        `SELECT * FROM ${ACTION_RECEIPTS_TABLE}
          WHERE organization_id = ? AND entry_seq IS NULL
            ${cursor ? "AND (executed_at > ? OR (executed_at = ? AND receipt_id > ?))" : ""}
          ORDER BY executed_at ASC, receipt_id ASC
          LIMIT ?`,
        cursor ? [this.org, cursor.executedAt, cursor.executedAt, cursor.receiptId, size] : [this.org, size],
      );
      if (rows.length > 0) yield rows.map(toReceipt);
      if (rows.length < size) break;
      const last = rows[rows.length - 1]!;
      cursor = { executedAt: last.executed_at, receiptId: last.receipt_id };
    }

    let afterSeq: number | null = null;
    for (;;) {
      const rows: Row[] = await this.sql.all<Row>(
        `SELECT * FROM ${ACTION_RECEIPTS_TABLE}
          WHERE organization_id = ? AND entry_seq IS NOT NULL
            ${afterSeq === null ? "" : "AND entry_seq > ?"}
          ORDER BY entry_seq ASC
          LIMIT ?`,
        afterSeq === null ? [this.org, size] : [this.org, afterSeq, size],
      );
      if (rows.length > 0) yield rows.map(toReceipt);
      if (rows.length < size) break;
      afterSeq = Number(rows[rows.length - 1]!.entry_seq);
    }
  }

  /**
   * Les reçus APRÈS la position `afterSeq`, par lots, dans l'ordre de la chaîne : la
   * vérification par étapes ne relit que ce qui a été écrit depuis son point de reprise.
   */
  async *receiptChainBatchesAfter(afterSeq: number, size = 1000): AsyncGenerator<ReceiptRecord[]> {
    let cursor = afterSeq;
    for (;;) {
      const rows: Row[] = await this.sql.all<Row>(
        `SELECT * FROM ${ACTION_RECEIPTS_TABLE}
          WHERE organization_id = ? AND entry_seq > ?
          ORDER BY entry_seq ASC
          LIMIT ?`,
        [this.org, cursor, size],
      );
      if (rows.length > 0) yield rows.map(toReceipt);
      if (rows.length < size) break;
      cursor = Number(rows[rows.length - 1]!.entry_seq);
    }
  }

  /** Le reçu à une position de la chaîne : l'ancre d'un point de reprise. */
  async findReceiptBySeq(entrySeq: number): Promise<ReceiptRecord | undefined> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? AND entry_seq = ?`,
      [this.org, entrySeq],
    );
    return rows[0] ? toReceipt(rows[0]) : undefined;
  }

  /** Le point de reprise de la vérification de la chaîne (migration 29), s'il existe. */
  async chainCheckpoint(): Promise<ChainCheckpoint | null> {
    const rows = await this.sql.all<Row>(
      `SELECT entries, entry_seq, entry_hash, verified_at, full_verified_at FROM ${RECEIPT_CHAIN_CHECKPOINTS_TABLE} WHERE organization_id = ?`,
      [this.org],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      entries: Number(row.entries),
      entrySeq: Number(row.entry_seq),
      entryHash: String(row.entry_hash),
      verifiedAt: String(row.verified_at),
      fullVerifiedAt: row.full_verified_at === null || row.full_verified_at === undefined ? null : String(row.full_verified_at),
    };
  }

  /**
   * Avance le point de reprise après une vérification RÉUSSIE. Jamais en arrière : deux
   * vérifications simultanées ne peuvent pas ramener le point vers une tête plus ancienne.
   * Une vérification complète date aussi `full_verified_at`.
   */
  async advanceChainCheckpoint(input: { entries: number; entrySeq: number; entryHash: string; at: string; full: boolean }): Promise<void> {
    await this.sql.run(
      `INSERT INTO ${RECEIPT_CHAIN_CHECKPOINTS_TABLE} (organization_id, entries, entry_seq, entry_hash, verified_at, full_verified_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id) DO UPDATE SET
         entries = excluded.entries,
         entry_seq = excluded.entry_seq,
         entry_hash = excluded.entry_hash,
         verified_at = excluded.verified_at,
         full_verified_at = COALESCE(excluded.full_verified_at, ${RECEIPT_CHAIN_CHECKPOINTS_TABLE}.full_verified_at)
       WHERE ${RECEIPT_CHAIN_CHECKPOINTS_TABLE}.entries <= excluded.entries`,
      [this.org, input.entries, input.entrySeq, input.entryHash, input.at, input.full ? input.at : null],
    );
  }

  /**
   * The newest receipt's `entry_hash`.
   *
   * Kept for read-only callers (probes, the API surface). NOT the write path any more:
   * chaining through this method and then inserting is the two-statement race that
   * `appendReceipt` exists to close, so nothing that writes should call it.
   */
  async latestReceiptHash(): Promise<string | null> {
    const rows = await this.newestReceipts(this.sql, "entry_hash", 1);
    return rows[0] ? str(rows[0].entry_hash) : null;
  }

  /**
   * Les reçus les plus récents du locataire, dans l'ordre
   * `entry_seq DESC NULLS LAST, executed_at DESC, receipt_id DESC` — en deux lectures
   * indexées au lieu d'une.
   *
   * Écrit d'un seul ORDER BY, cet ordre ne correspond à aucun index : l'index unique de
   * la migration 13 est `(organization_id, entry_seq)`, et « DESC NULLS LAST » n'en est
   * pas le parcours arrière. PostgreSQL lisait donc TOUS les reçus du locataire et les
   * triait à chaque appel — dans `appendReceipt`, sous le verrou consultatif, c'est-à-dire
   * une écriture en O(n) qui sérialise le locataire. Relevé pendant la campagne
   * d'endurance (docs/STRESS-TEST-LOG.md) : parcours séquentiel puis tri top-N ; scindée
   * ainsi, la lecture devient un parcours d'index arrière qui s'arrête à la première ligne.
   *
   * Même ensemble, même ordre : les reçus numérotés d'abord, par numéro décroissant ;
   * puis, seulement s'il manque des lignes, les reçus sans numéro (antérieurs à la
   * migration 13) dans l'ancien ordre de départage.
   */
  private async newestReceipts(executor: SqlExecutor, columns: string, limit: number): Promise<Row[]> {
    const numbered = await executor.all<Row>(
      `SELECT ${columns} FROM ${ACTION_RECEIPTS_TABLE}
        WHERE organization_id = ? AND entry_seq IS NOT NULL
        ORDER BY entry_seq DESC
        LIMIT ?`,
      [this.org, limit],
    );
    if (numbered.length >= limit) return numbered;
    const unnumbered = await executor.all<Row>(
      `SELECT ${columns} FROM ${ACTION_RECEIPTS_TABLE}
        WHERE organization_id = ? AND entry_seq IS NULL
        ORDER BY executed_at DESC, receipt_id DESC
        LIMIT ?`,
      [this.org, limit - numbered.length],
    );
    return [...numbered, ...unnumbered];
  }
}
