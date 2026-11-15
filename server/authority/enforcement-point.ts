/**
 * The enforcement point (Phase 10, §§16-18).
 *
 * THE INVARIANT THIS FILE OWNS
 * ----------------------------
 *   No consequent action reaches a real downstream tool unless Oathrion has
 *   authorized THAT EXACT action for THAT EXACT agent, tenant, destination and
 *   authority.
 *
 * Everything else in Phase 10 exists to make this file's job possible; this file
 * is where the promise is either kept or broken.
 *
 * WHY Oathrion DISPATCHES INSTEAD OF ANSWERING "ALLOW"
 * -----------------------------------------------
 * The tempting design is: the client asks, Oathrion answers ALLOW, the client calls
 * Stripe. That design cannot keep the invariant, and not because clients are
 * malicious — because the decision and the call are then two separate events
 * connected only by the client's good behaviour. Anything between them (a bug, a
 * retry loop, a mutated amount, a compromised agent, a prompt injection that
 * changes the payload after the check) is invisible to Oathrion, and Oathrion's audit
 * trail would record an authorization that may or may not describe what happened.
 *
 * So the client never holds the capability. It holds a grant id, and it presents
 * it here; Oathrion verifies, consumes it, and makes the downstream call itself. The
 * agent cannot dispatch, because the agent does not have anywhere to dispatch to.
 *
 * THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY
 * ------------------------------------------------
 *   1. Recompute the canonical form and hash from the request. Never accept a
 *      hash from the caller.
 *   2. Compare every bound field against the stored grant, and report the FIRST
 *      mismatch by name. This is for the operator; it is not the check that
 *      decides.
 *   3. Consume the grant with a conditional UPDATE that repeats every one of
 *      those predicates. This IS the check that decides, because it is the only
 *      one that cannot be raced by a second concurrent presenter.
 *   4. Only then dispatch downstream.
 *   5. Write a receipt whether the downstream succeeded or failed.
 *
 * Step 3 before step 4 is deliberate and has a cost worth naming: if the process
 * dies between them, the grant is consumed and the action did not happen. That
 * is the correct direction to fail for irreversible operations — a refund that
 * silently did not happen is a support ticket, a refund that silently happened
 * twice is money gone. The alternative order (dispatch, then consume) makes
 * double-execution reachable by a crash, and double-execution is the thing this
 * system exists to prevent.
 */

import { randomUUID } from "node:crypto";
import type { ActionEnvelope } from "@shared/action/envelope";
import type { OrganizationId } from "@shared/tenancy";
import { hashResult } from "../action/canonical";
import { callDownstreamTool } from "../gateway/tools/mcp-client";
import { resolveDestination, UnknownDestinationError } from "./destinations";
import type { ActionAuthorityStore, GrantRecord, ReceiptRecord } from "./store";
import { receiptEntryHash } from "./receipt-chain";
import { increment } from "../observability/metrics";
import { isDatabaseUnavailable } from "../database-unavailable";
import { periodResetFor, periodStartFor } from "@shared/quotas";
import { QuotaExceededError, quotaLimitsFor, quotaModeNow } from "../quotas";

/** Why an execution attempt was refused. Reported verbatim; safe to show a caller. */
export type RefusalCode =
  | "GRANT_NOT_FOUND"
  | "GRANT_NOT_ISSUED"
  | "GRANT_EXPIRED"
  | "GRANT_ALREADY_CONSUMED"
  | "AGENT_MISMATCH"
  | "ACTION_MISMATCH"
  | "DESTINATION_MISMATCH"
  | "DECISION_NOT_EXECUTABLE"
  | "DESTINATION_UNKNOWN"
  | "RACE_LOST";

export interface EnforcementRefusal {
  ok: false;
  code: RefusalCode;
  reason: string;
  grant: GrantRecord | null;
}

export interface EnforcementSuccess {
  ok: true;
  receipt: ReceiptRecord;
  grant: GrantRecord;
  downstream: { ok: boolean; text: string; data: Record<string, unknown> };
}

export type EnforcementResult = EnforcementRefusal | EnforcementSuccess;

/** What the caller presents at execution time. */
export interface PresentedExecution {
  grantId: string;
  /** Re-sent intent. Re-canonicalised and re-hashed here; not trusted as sent. */
  envelope: ActionEnvelope;
  /** Who is presenting, for the receipt. Taken from the credential by the caller. */
  presentedBy: string;
}

function refuse(code: RefusalCode, reason: string, grant: GrantRecord | null): EnforcementRefusal {
  /*
   * Le point unique par lequel passe TOUT refus d'exécution — c'est ce qui en fait le
   * bon endroit pour compter. Instrumenter les appelants un par un aurait garanti qu'un
   * code ajouté plus tard échappe à la mesure, et une métrique qui rate un cas est
   * pire qu'absente : elle fait lire « aucun refus de ce type » là où la vérité est
   * « personne ne compte ».
   */
  increment("oathrion_action_executions_total", { outcome: "refused" });
  increment("oathrion_action_refusals_total", { code: code.toLowerCase() });
  return { ok: false, code, reason, grant };
}

export class EnforcementPoint {
  constructor(
    private readonly store: ActionAuthorityStore,
    private readonly org: OrganizationId,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Verifies a presented grant against a recomputed action, without consuming it.
   *
   * Separate and exported so the golden tests can assert *which* field a
   * mismatched presentation trips on, and so a caller can pre-flight. It is NOT
   * the authorization: `execute` repeats every predicate inside the consuming
   * UPDATE. A verify-then-execute pair with a gap between them is a TOCTOU bug,
   * and this method is the half that would be raced.
   */
  async verify(presented: PresentedExecution, now: Date = new Date()): Promise<EnforcementResult | null> {
    const grant = await this.store.findGrant(presented.grantId);

    if (!grant) {
      /*
       * Covers the wrong-tenant case with no separate branch: the store is
       * scoped to this organization, so another tenant's grant id simply is not
       * here. The message does not distinguish "never existed" from "belongs to
       * someone else", because distinguishing them would turn this endpoint into
       * an oracle for enumerating another tenant's grant ids.
       */
      return refuse("GRANT_NOT_FOUND", `No grant "${presented.grantId}" exists for this tenant.`, null);
    }

    if (grant.decision === "BLOCK") {
      return refuse(
        "DECISION_NOT_EXECUTABLE",
        "The recorded decision for this grant is BLOCK. A blocked action is never executable.",
        grant,
      );
    }

    if (grant.state === "consumed") {
      return refuse(
        "GRANT_ALREADY_CONSUMED",
        `Grant "${grant.id}" was already consumed at ${grant.consumedAt}. A grant authorizes one ` +
          "execution; replaying it is refused.",
        grant,
      );
    }
    if (grant.state === "pending_approval") {
      return refuse(
        "GRANT_NOT_ISSUED",
        `Grant "${grant.id}" is still awaiting approval and confers no authority yet.`,
        grant,
      );
    }
    if (grant.state === "revoked") {
      return refuse("GRANT_NOT_ISSUED", `Grant "${grant.id}" was revoked: ${grant.revokedReason}.`, grant);
    }

    if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
      return refuse(
        "GRANT_EXPIRED",
        `Grant "${grant.id}" expired at ${grant.expiresAt}. Authority does not outlive its window.`,
        grant,
      );
    }

    if (grant.agentId !== presented.envelope.agentId) {
      return refuse(
        "AGENT_MISMATCH",
        `Grant "${grant.id}" was issued to agent "${grant.agentId}" and cannot be presented by ` +
          `"${presented.envelope.agentId}". Authority is not transferable between agents.`,
        grant,
      );
    }

    if (grant.actionHash !== presented.envelope.actionHash) {
      return refuse(
        "ACTION_MISMATCH",
        `Grant "${grant.id}" authorizes action ${grant.actionHash.slice(0, 12)}… but the presented ` +
          `action hashes to ${presented.envelope.actionHash.slice(0, 12)}…. Any change to the verb, ` +
          "the arguments, the destination or the agent produces a different action, and a grant " +
          "authorizes exactly one.",
        grant,
      );
    }

    if (grant.destinationId !== presented.envelope.destinationId) {
      /*
       * Unreachable in practice, because the destination is inside the hash and
       * the previous check would have fired. Kept anyway: it costs one string
       * comparison, it names the real problem instead of "hash mismatch", and it
       * survives a future change to what the hash covers.
       */
      return refuse(
        "DESTINATION_MISMATCH",
        `Grant "${grant.id}" is bound to destination "${grant.destinationId}", not ` +
          `"${presented.envelope.destinationId}".`,
        grant,
      );
    }

    return null;
  }

  /**
   * The only path from an authorized action to a downstream tool.
   *
   * Returns a refusal, or a receipt. It never returns "you may proceed".
   */
  async execute(presented: PresentedExecution, now: Date = new Date()): Promise<EnforcementResult> {
    const failure = await this.verify(presented, now);
    if (failure) return failure;

    /*
     * Resolved BEFORE the grant is consumed. An unregistered destination is a
     * configuration failure, not a spent authority: consuming the grant first
     * would burn a legitimate authorization on an operator's typo, and the agent
     * would have to be re-authorized to retry something it was already allowed
     * to do.
     */
    let destination;
    try {
      destination = resolveDestination(presented.envelope.destinationId, this.env, String(this.org));
    } catch (error) {
      if (error instanceof UnknownDestinationError) {
        return refuse("DESTINATION_UNKNOWN", error.message, await this.store.findGrant(presented.grantId) ?? null);
      }
      throw error;
    }

    /*
     * THE decision. Every predicate `verify` checked is repeated here inside a
     * single conditional UPDATE, so the state it checks cannot change between the
     * check and the consumption. Two concurrent presenters of the same grant both
     * arrive here; the engine serialises them on the row, and exactly one sees a
     * row count of 1.
     */
    /*
     * LE QUOTA MENSUEL D'EXÉCUTIONS, sur cette voie aussi, compté DANS la même
     * transaction que la consommation et sous un verrou par locataire (`consumeGrant`).
     * Un refus de quota ne consomme rien : l'autorisation reste `issued`, et l'agent peut
     * la présenter de nouveau une fois le plafond relevé ou remis à zéro.
     */
    const limit = quotaLimitsFor(this.org).executions;
    const enforce = quotaModeNow() !== "observe";
    const claim = await this.store.consumeGrant(
      {
        id: presented.grantId,
        agentId: presented.envelope.agentId,
        actionHash: presented.envelope.actionHash,
        destinationId: presented.envelope.destinationId,
        at: now.toISOString(),
        consumedBy: presented.presentedBy,
      },
      { limit, since: periodStartFor("executions", now), enforce },
    );
    if (claim.quota?.over) {
      if (enforce) {
        throw new QuotaExceededError({ counter: "executions", limit, used: claim.quota.used, resetAt: periodResetFor("executions", now) });
      }
      console.warn(
        `[quotas] ${String(this.org)} is over its executions quota (${String(claim.quota.used + 1)} > ${String(limit)}) on the ` +
          "direct path but OATHRION_QUOTA_MODE=observe, so the execution was allowed.",
      );
    }

    if (!claim.claimed) {
      /*
       * `verify` passed and the UPDATE still matched nothing, which means another
       * request consumed this grant in between. The loser dispatches nothing —
       * that is the exactly-once guarantee, and it is enforced by the database
       * rather than by a mutex that would only cover one process.
       */
      return refuse(
        "RACE_LOST",
        `Grant "${presented.grantId}" was consumed by a concurrent request. Exactly one execution ` +
          "is permitted per grant, so this attempt performed nothing.",
        claim.grant ?? null,
      );
    }

    const grant = claim.grant!;
    const executionId = `axn_${randomUUID().replace(/-/g, "")}`;

    // Past this line the authority is spent. Whatever happens downstream, a
    // receipt is written, because an unrecorded consumed grant is a gap in the
    // account of what Oathrion did.
    let downstream: { ok: boolean; text: string; data: Record<string, unknown> };
    let outcome: "succeeded" | "failed";
    try {
      downstream = await callDownstreamTool({
        tool: presented.envelope.action,
        arguments: presented.envelope.arguments,
        executionId,
        destination: destination.destination,
      });
      outcome = downstream.ok ? "succeeded" : "failed";
      increment("oathrion_downstream_calls_total", { outcome: downstream.ok ? "ok" : "business_error" });
    } catch (error) {
      downstream = {
        ok: false,
        // The downstream's own text is not echoed: it is attacker-influenced
        // content that would land in the audit trail and an operator's console.
        text: error instanceof Error ? error.name : "DownstreamError",
        data: {},
      };
      outcome = "failed";
      /*
       * Distinguée de `business_error` : un refus métier du fournisseur est un
       * fonctionnement normal du produit, une erreur de transport est une panne. Les
       * confondre sous une seule issue `failed` ferait ressembler une coupure réseau à
       * un client qui refuse des remboursements — et c'est la métrique sur laquelle
       * `docs/ON-CALL.md` fait reposer la distinction.
       */
      increment("oathrion_downstream_calls_total", { outcome: "transport_error" });
    }

    increment("oathrion_action_executions_total", { outcome });

    const receipt = await this.writeReceiptPatiently({
      grant,
      executionId,
      outcome,
      downstream,
      at: now,
    });

    return { ok: true, receipt, grant, downstream };
  }

  /**
   * LE REÇU D'UNE ACTION DÉJÀ EXÉCUTÉE NE SE PERD PAS SUR UNE BASE SATURÉE.
   *
   * À ce stade, l'autorité est dépensée et le fournisseur a peut-être agi. Sous une
   * pression extrême (1 024 clients, pool de connexions saturé, journal §5.28),
   * l'écriture du reçu a échoué 14 fois sur un délai d'attente de connexion : 14 actions
   * exécutées chez le fournisseur sans aucune trace dans la chaîne. Une saturation est
   * passagère ; un trou dans la chaîne est définitif. On attend donc, en réessayant,
   * aussi longtemps que la base est seulement INJOIGNABLE (`isDatabaseUnavailable`),
   * jusqu'à `OATHRION_RECEIPT_PATIENCE_MS` (60 s par défaut). Une autre erreur remonte
   * aussitôt.
   *
   * Avant chaque nouvel essai, le reçu est recherché : une écriture validée dont la
   * réponse s'est perdue ne doit pas en produire une seconde (l'index unique
   * `(organization_id, grant_id)` la refuserait de toute façon).
   *
   * Si la patience s'épuise, l'erreur remonte, et la ligne de journal dit ce qui
   * manque, pour qu'un exploitant puisse le reconstituer : exécution, autorisation,
   * action, issue.
   */
  private async writeReceiptPatiently(input: Parameters<EnforcementPoint["writeReceipt"]>[0]): Promise<ReceiptRecord> {
    const patience = receiptPatienceMs(this.env);
    const deadline = Date.now() + patience;
    let attempt = 0;
    for (;;) {
      try {
        return await this.writeReceipt(input);
      } catch (error) {
        if (!isDatabaseUnavailable(error) || Date.now() >= deadline) {
          console.error(
            `[authority] RECEIPT NOT WRITTEN after execution: organization ${String(this.org)}, execution ` +
              `${input.executionId}, grant ${input.grant.id}, action ${input.grant.action}, outcome ` +
              `${input.outcome}. Cause: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
        attempt += 1;
        if (attempt === 1) {
          console.warn(`[authority] database busy: the receipt for ${input.executionId} will be retried for up to ${String(patience)} ms`);
        }
        await new Promise((r) => setTimeout(r, Math.min(2_000, 100 * 2 ** Math.min(attempt, 5))));
        const existing = await this.store.findReceiptByGrant(input.grant.id).catch(() => undefined);
        if (existing) return existing;
      }
    }
  }

  /**
   * The Action Receipt: proof that this exact action was authorized and executed.
   *
   * Chained onto the tenant's previous receipt with `prev_hash`, following the
   * pattern `server/audit-chain.ts` already established, so an edited or deleted
   * receipt breaks the link.
   *
   * PHASE 11 CLOSED THE FORK Phase 10 documented here. The head is now read and the
   * successor inserted inside one transaction, serialised per tenant, with a UNIQUE
   * (organization_id, entry_seq) index as the backstop, so two concurrent receipts can
   * no longer name the same predecessor. What this still is NOT: proof against someone
   * with write access to the database, who can recompute the whole chain. It makes
   * deletion and reordering detectable, and nothing more.
   */
  private async writeReceipt(input: {
    grant: GrantRecord;
    executionId: string;
    outcome: "succeeded" | "failed";
    downstream: { ok: boolean; text: string; data: Record<string, unknown> };
    at: Date;
  }): Promise<ReceiptRecord> {
    const receiptId = `rcpt_${randomUUID().replace(/-/g, "")}`;
    const executedAt = input.at.toISOString();
    const resultHash = hashResult(input.downstream.data);

    /*
     * PHASE 11 — the head is read and this receipt inserted inside one transaction, and
     * this builder runs inside it. The predecessor hash and the sequence number are
     * therefore the ones that are still current at insert time. Phase 10 read the head
     * first and inserted afterwards, which let two concurrent receipts name the same
     * predecessor; see server/authority/store.ts#appendReceipt and migration 013.
     */
    return this.store.appendReceipt(({ prevHash, entrySeq }) => {
      /*
       * L'empreinte vient de `receipt-chain.ts`, qui est désormais sa SEULE définition.
       * Elle était calculée ici, en ligne ; le vérificateur ajouté par l'étape 1 du
       * pilote avait besoin du même calcul, et deux copies auraient fini par diverger —
       * avec, pour résultat, un vérificateur qui laisse passer une chaîne falsifiée ou
       * condamne une chaîne saine.
       */
      const chained = {
        receiptId,
        grantId: input.grant.id,
        actionId: input.grant.actionId,
        agentId: input.grant.agentId,
        action: input.grant.action,
        actionHash: input.grant.actionHash,
        destinationId: input.grant.destinationId,
        decision: input.grant.decision,
        approvalId: input.grant.approvalId,
        executedAt,
        downstreamExecutionId: input.executionId,
        outcome: input.outcome,
        resultHash,
        /*
         * DANS l'objet haché, et il était dehors.
         *
         * Le commentaire ci-dessous disait déjà la règle — « les champs du reçu sont
         * REPRIS de `chained`, jamais réécrits » — et `resultSummary` en était la seule
         * exception : ajouté après le calcul de l'empreinte, donc stocké sans être
         * couvert. La règle annonçait le défaut ; il suffisait de la suivre.
         *
         * Borné à 500 caractères, et jamais le corps brut du service aval : c'est du
         * texte influencé par un tiers, et il finit dans le journal d'audit.
         */
        resultSummary: input.downstream.text.slice(0, 500),
        prevHash,
        entrySeq,
      };
      const entryHash = receiptEntryHash(this.org, chained);

      /*
       * Les champs du reçu sont REPRIS de `chained`, jamais réécrits : ce qui est
       * stocké est exactement ce qui a été haché. Les réénumérer ici rouvrirait la
       * possibilité qu'un champ change d'un côté et pas de l'autre — et c'est
       * précisément ce qui était arrivé à `resultSummary`.
       */
      return {
        ...chained,
        prevHash,
        entryHash,
        entrySeq,
      };
    });
  }
}

/** La patience du reçu, en millisecondes. Illisible ou négative : 60 s. */
export function receiptPatienceMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OATHRION_RECEIPT_PATIENCE_MS?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}
