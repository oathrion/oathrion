/**
 * La ligne d'exécution telle qu'elle doit être APRÈS la clôture d'un run d'outil.
 *
 * ## Pourquoi un fichier pour une fonction
 *
 * Les deux implémentations de `settleToolRun` — SQLite et PostgreSQL — doivent produire
 * exactement la même ligne. Si chacune calculait son propre `next`, les deux moteurs
 * finiraient par différer sur un champ, et la différence se verrait dans une trace
 * d'audit, c'est-à-dire à l'endroit le plus coûteux possible.
 *
 * Les tests de parité des dépôts comparent déjà les deux moteurs sur les mêmes
 * scénarios ; cette fonction leur retire un moyen d'échouer.
 *
 * ## L'ORDRE DES CHAMPS EST LA SÉMANTIQUE
 *
 * `patch` est appliqué AVANT les champs issus de `outcome`. Ce n'est pas un détail de
 * style : l'état terminal du run et son erreur sont décidés par le résultat de l'outil,
 * jamais par l'appelant. Un `patch` qui prétendrait `runState: "succeeded"` sur un outil
 * qui a échoué serait silencieusement écrasé ici — et c'est la seule issue acceptable,
 * parce que `run_state` est ce qui rend une action rejouable ou définitive.
 */

import { linkAuditEntries } from "../audit-chain";
import type { AuditEntry, Execution } from "@shared/types";
import type { OrganizationId } from "@shared/tenancy";

export type ToolOutcome =
  | { ok: true; at: string; result: Record<string, unknown> | null }
  | { ok: false; at: string; error: string };

export function settledExecution(
  organizationId: OrganizationId,
  current: Execution,
  outcome: ToolOutcome,
  entries: AuditEntry[],
  patch: Partial<Execution>,
): Execution {
  /*
   * La chaîne part de la trace STOCKÉE (`current.audit`), que l'appelant de
   * `settleToolRun` vient de lire sous verrou. Repartir d'un instantané plus ancien
   * forkerait la chaîne sous des clôtures concurrentes.
   */
  const linked = linkAuditEntries(organizationId, current.id, current.audit, entries);
  return {
    ...current,
    ...patch,
    id: current.id,
    audit: [...current.audit, ...linked],
    runState: outcome.ok ? "succeeded" : "failed",
    ...(outcome.ok
      ? { toolExecutedAt: outcome.at, lastError: null }
      : { lastError: outcome.error }),
  };
}
