/**
 * Ce qu'un connecteur rend quand l'appel a échoué SANS réponse du service.
 *
 * ## Le défaut corrigé
 *
 * Les trois connecteurs écrivaient `dispatched: false` sur toute erreur de transport :
 * « rien n'est parti ». C'est faux pour un délai dépassé APRÈS l'envoi — Slack a pu
 * publier, GitHub a pu ouvrir l'issue, et le reçu disait le contraire. Pire, l'exécution
 * restait « échouée » donc rejouable : un nouvel essai pouvait doubler l'effet.
 *
 * Ici, la nature de l'échec vient du transport (`requestMayHaveReached`) :
 *
 *   · `dispatched: false`     — le transport a établi que rien n'a été remis ;
 *   · `dispatched: "unknown"` — la requête est partie, la réponse n'est pas venue.
 *
 * Le second état est lu par `retryabilityOf` : on ne rejoue pas une action dont l'effet
 * est inconnu, sauf s'il s'agit d'une lecture (aucun effet à doubler).
 */

import { requestMayHaveReached } from "../notifications/webhook-transport";
import type { ConnectorExecuteResult } from "./types";

export function transportFailure(service: string, error: unknown): ConnectorExecuteResult {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = requestMayHaveReached(error);
  return {
    ok: false,
    code: "unreachable",
    summary: unknown
      ? `${service} did not answer in time (${message}). The request was sent: the action MAY ` +
        `have been done. Check in ${service} before trying again.`
      : `${service} is unreachable (${message}). Nothing was sent.`,
    data: { dispatched: unknown ? "unknown" : false, reason: "transport_error" },
  };
}
