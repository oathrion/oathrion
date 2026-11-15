/**
 * LE REGISTRE D'AUTORITÉ DE LA PASSERELLE — chaque outil exécuté par la passerelle MCP laisse
 * un reçu dans la MÊME chaîne que le chemin `/api/actions/*`.
 *
 * ## Le défaut que ce module ferme (STRESS-TEST-LOG §5.41)
 *
 * Deux chemins mènent à un effet : la passerelle (`AgentGateway`, la voie MCP, donc
 * `oathrion wrap` et les connecteurs) et le point d'application (`EnforcementPoint`, la voie
 * `/api/actions/authorize` → `execute`). Seul le second écrivait dans la chaîne de reçus
 * d'autorité. La passerelle tenait un journal chaîné PAR exécution (`audit-chain.ts`), qui
 * rend une modification visible mais pas la suppression d'une exécution entière. Un test qui
 * disait « la chaîne de reçus se vérifie » passait sur une chaîne vide.
 *
 * ## Ce qu'il fait — le même contrat que le point d'application
 *
 *   1. `open`, APRÈS la décision et la réclamation de l'exécution, AVANT l'outil : une action
 *      et une autorisation sont inscrites dans le plan d'autorité, et l'autorisation est
 *      CONSOMMÉE. Si cela échoue, l'outil ne tourne pas — fermé par défaut.
 *   2. `close`, APRÈS l'outil, réussi ou non : le reçu, chaîné à la tête de la chaîne du
 *      locataire, sous le même verrou que tous les autres (`appendReceipt`). Une base
 *      seulement saturée est attendue (`OATHRION_RECEIPT_PATIENCE_MS`), comme pour le point
 *      d'application.
 *
 * Une autorisation consommée dont le reçu n'arrive jamais (processus tué entre les deux) est
 * exactement ce que l'alerte `receipt.gap` (`receipt-gaps.ts`) et `consumedWithoutReceipt`
 * détectent déjà : la passerelle hérite de cette surveillance sans une ligne de plus.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne DÉCIDE pas : la décision est celle du moteur, prise avant, par la passerelle. Il ne
 * touche pas au quota : `consumeGrant` est appelé SANS quota, la passerelle compte ses
 * exécutions de son côté (`quotas.ts`), et compter deux fois ferait refuser à tort.
 */

import { randomUUID } from "node:crypto";

import type { Execution } from "@shared/types";

import { ActionCanonicalizationError, canonicalizeAction, hashCanonicalAction, hashResult } from "../action/canonical";
import { authorityFor } from "../authority";
import { receiptPatienceMs } from "../authority/enforcement-point";
import { receiptEntryHash } from "../authority/receipt-chain";
import type { GrantRecord, ReceiptRecord } from "../authority/store";
import { isDatabaseUnavailable } from "../database-unavailable";
import type { OrganizationId } from "@shared/tenancy";

/** Le registre d'une organisation. Injecté dans `AgentGateway` par `routes.ts`. */
export interface GatewayLedger {
  open(input: { execution: Execution; toolId: string; attempt: number; at: string }): Promise<GrantRecord>;
  close(input: {
    grant: GrantRecord;
    execution: Execution;
    outcome: "succeeded" | "failed";
    data: Record<string, unknown>;
    summary: string;
    at: string;
  }): Promise<ReceiptRecord>;
}

/** Les arguments de l'action : la cible et ce que le service de décision a enregistré. */
function actionArguments(execution: Execution): Record<string, string | number> {
  const args: Record<string, string | number> = { target: execution.target };
  for (const [key, value] of Object.entries(execution.input ?? {})) {
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) args[key] = value;
    else args[key] = JSON.stringify(value) ?? "null";
  }
  return args;
}

export function gatewayLedgerFor(organization: OrganizationId, env: NodeJS.ProcessEnv = process.env): GatewayLedger {
  const { store } = authorityFor(organization, env);

  return {
    async open({ execution, toolId, attempt, at }) {
      const args = actionArguments(execution);
      let canonical: string;
      try {
        canonical = canonicalizeAction({ tenantId: organization, agentId: execution.agentId, action: execution.action, arguments: args, destinationId: toolId });
      } catch (error) {
        /* Ne peut pas arriver avec des chaînes et des nombres finis ; si cela arrivait, refuser. */
        if (error instanceof ActionCanonicalizationError) throw new Error(`Action cannot be written to the ledger: ${error.message}`);
        throw error;
      }
      const actionHash = hashCanonicalAction(canonical);
      /*
       * Une action par exécution (clé d'idempotence `gw:<exécution>` : une relance retrouve
       * la même), une autorisation par TENTATIVE : une relance autorisée est une nouvelle
       * dépense d'autorité, et elle aura son propre reçu.
       */
      const { action } = await store.createAction({
        id: `act_gw_${randomUUID().replace(/-/g, "")}`,
        agentId: execution.agentId,
        action: execution.action,
        arguments: args,
        destinationId: toolId,
        canonical,
        actionHash,
        requestId: null,
        idempotencyKey: `gw:${execution.id}`,
        decision: "ALLOW",
        reason: execution.decisionReason ?? "",
        policyId: execution.policyId ?? null,
        createdAt: at,
      });
      const grantId = `grt_gw_${execution.id}_${String(attempt)}`;
      await store.createGrant({
        id: grantId,
        actionId: action.id,
        agentId: execution.agentId,
        action: execution.action,
        actionHash,
        destinationId: toolId,
        decision: "ALLOW",
        state: "issued",
        requestId: null,
        idempotencyKey: null,
        policyId: execution.policyId ?? null,
        createdAt: at,
        issuedAt: at,
        expiresAt: new Date(Date.parse(at) + 60_000).toISOString(),
        consumedAt: null,
        consumedBy: null,
        approvalId: execution.approvalId ?? null,
        approvedAt: null,
        approvedBy: null,
        revokedAt: null,
        revokedReason: null,
      });
      const claim = await store.consumeGrant({ id: grantId, agentId: execution.agentId, actionHash, destinationId: toolId, at, consumedBy: `gateway:${execution.id}` });
      if (!claim.claimed || !claim.grant) throw new Error(`Authorisation ${grantId} could not be consumed: nothing is sent.`);
      return claim.grant;
    },

    async close({ grant, execution, outcome, data, summary, at }) {
      const deadline = Date.now() + receiptPatienceMs(env);
      let attempt = 0;
      for (;;) {
        try {
          return await store.appendReceipt(({ prevHash, entrySeq }) => {
            const chained = {
              receiptId: `rcpt_${randomUUID().replace(/-/g, "")}`,
              grantId: grant.id,
              actionId: grant.actionId,
              agentId: grant.agentId,
              action: grant.action,
              actionHash: grant.actionHash,
              destinationId: grant.destinationId,
              decision: grant.decision,
              approvalId: grant.approvalId,
              executedAt: at,
              downstreamExecutionId: execution.id,
              outcome,
              resultHash: hashResult(data),
              resultSummary: summary.slice(0, 500),
              prevHash,
              entrySeq,
            };
            return { ...chained, entryHash: receiptEntryHash(organization, chained) };
          });
        } catch (error) {
          if (!isDatabaseUnavailable(error) || Date.now() >= deadline) {
            console.error(
              `[gateway] RECEIPT NOT WRITTEN after execution: organisation ${String(organization)}, execution ${execution.id}, ` +
                `authorisation ${grant.id}, action ${grant.action}, outcome ${outcome}. The receipt.gap alert will report it. ` +
                `Cause: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
          attempt += 1;
          await new Promise((r) => setTimeout(r, Math.min(2_000, 100 * 2 ** Math.min(attempt, 5))));
          const existing = await store.findReceiptByGrant(grant.id).catch(() => undefined);
          if (existing) return existing;
        }
      }
    },
  };
}
