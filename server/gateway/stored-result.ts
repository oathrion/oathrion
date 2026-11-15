/**
 * Ce que la base GARDE de la réponse d'un outil — pas la réponse elle-même, quand elle est grosse.
 *
 * ## Le défaut qu'il ferme
 *
 * La passerelle enregistrait la réponse COMPLÈTE de chaque outil sur l'exécution. Une lecture
 * de gros fichier, relue souvent, faisait enfler la base : 1,5 Go en 2 h 30 sous le banc
 * d'endurance du pivot local (journal §5.74). Puis la base ralentissait le pivot jusqu'à lui
 * faire manquer les signaux de présence de ses relais. Et chaque réponse restait en clair sur
 * le disque.
 *
 * ## La règle
 *
 * Seulement au-delà de `STORED_RESULT_LIMIT` octets (en JSON) : les champs de premier niveau
 * restent tels quels quand ils sont petits (`mode`, `summary`, `url`, `dispatched`… : ce que la
 * console et les routes lisent). Un gros champ est remplacé par sa taille et son empreinte
 * SHA-256, sur la même forme canonique que le reçu : on peut toujours prouver qu'une réponse
 * présentée plus tard est bien celle-là.
 *
 * ## Ce qui n'est PAS borné
 *
 * Une exécution approuvée, ou rejouée : sa réponse est remise à l'agent plus tard, depuis
 * la base (`cli/wrap/relay.ts`, `awaitApproval`). Ces exécutions vont au rythme d'une personne,
 * sans effet sur la taille. `agent-gateway.ts` ne borne que l'exécution immédiate. Le reçu hache
 * toujours la réponse complète.
 */
import { hashResult } from "../action/canonical";

/** Au-delà, la réponse enregistrée est bornée. Une réponse ordinaire (« note créée », une issue) tient en dessous. */
export const STORED_RESULT_LIMIT = 16 * 1024;
/** Un champ de premier niveau plus gros que ceci est remplacé par sa taille et son empreinte. */
const FIELD_LIMIT = 1024;

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");

export function boundStoredResult(data: Record<string, unknown>): Record<string, unknown> {
  const total = sizeOf(data);
  if (total <= STORED_RESULT_LIMIT) return data;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const size = sizeOf(value);
    kept[key] = size <= FIELD_LIMIT ? value : { tronque: true, taille: size, empreinte: hashResult(value) };
  }
  kept.reponseBornee = { taille: total, empreinte: hashResult(data), raison: `response of ${String(total)} bytes: the database only keeps its size and fingerprint` };
  return kept;
}
