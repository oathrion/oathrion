/**
 * Le délai d'un appel de connecteur.
 *
 * 15 secondes par défaut. `OATHRION_CONNECTOR_TIMEOUT_MS` est une variable de DÉPLOIEMENT,
 * bornée entre 1 et 60 secondes : en dessous, un fournisseur lent passerait pour une
 * panne ; au-dessus, un agent attendrait une réponse qui ne viendra pas. Elle existe aussi
 * pour que le cas « le fournisseur ne répond jamais » soit éprouvé en une seconde.
 */
export function connectorTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.OATHRION_CONNECTOR_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 15_000;
  return Math.min(Math.max(Math.trunc(raw), 1_000), 60_000);
}

/**
 * L'âge maximal de l'état d'un connecteur tel que la passerelle MCP le lit.
 *
 * L'état vient du coffre — la dernière vérification RÉELLE auprès du service — et non
 * d'un appel au service à chaque `tools/list`. Le coffre est relu au plus toutes les
 * 15 s par défaut : une connexion, une révocation ou une perte d'accès faite par une autre
 * instance se voit dans ce délai. `OATHRION_CONNECTOR_STATUS_TTL_MS`, de 0 (toujours relire)
 * à 300 000.
 */
export function connectorStatusTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.OATHRION_CONNECTOR_STATUS_TTL_MS);
  if (env.OATHRION_CONNECTOR_STATUS_TTL_MS === undefined || !Number.isFinite(raw) || raw < 0) return 15_000;
  return Math.min(Math.trunc(raw), 300_000);
}
