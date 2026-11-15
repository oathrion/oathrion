/**
 * LE PASSAGE DU JETON AU NAVIGATEUR, et pourquoi il faut un intermédiaire.
 *
 * ## Le problème, qui est imposé par le protocole
 *
 * Le fournisseur d'identité ramène le navigateur chez Oathrion par une NAVIGATION, donc par
 * un GET. À la fin de ce GET, Oathrion sait qui est la personne — mais la console est une
 * application à page unique qui garde son jeton EN MÉMOIRE, et une navigation détruit
 * cette mémoire. Il faut donc remettre le jeton à du JavaScript qui n'existe pas encore
 * au moment où le jeton est prêt.
 *
 * Les trois réponses naturelles sont toutes mauvaises :
 *
 *   · **Rendre le jeton en JSON** — ce que faisait la première version. Le navigateur
 *     affiche alors une page de JSON brut portant un jeton de session. L'utilisateur le
 *     voit, peut le copier, et l'URL visitée reste dans son historique.
 *   · **Le mettre dans le fragment** (`/#token=…`) — le fragment ne part pas au serveur,
 *     mais il reste dans l'historique du navigateur, et c'est précisément « un jeton de
 *     session dans une URL ».
 *   · **Un cookie de session** — un second mécanisme de transport à côté du porteur en
 *     mémoire, donc un second endroit où se tromper.
 *
 * ## La réponse retenue : un TICKET à usage unique
 *
 * Le rappel ne crée pas de session. Il crée un ticket — une valeur opaque de 32 octets,
 * valable 60 secondes, consommable UNE fois — et renvoie le navigateur sur la console
 * avec ce ticket. La console l'échange par un POST contre un vrai jeton, puis l'efface de
 * l'URL.
 *
 * C'est exactement ce qu'est un code d'autorisation OAuth, et pour les mêmes raisons :
 * ce qui voyage dans une URL doit être inutilisable une seconde fois et périmer vite. Un
 * ticket resté dans l'historique est un ticket déjà dépensé.
 *
 * **La session est créée à l'ÉCHANGE, pas au rappel.** Un ticket non échangé ne laisse
 * donc aucune session ouverte derrière lui — un onglet fermé entre les deux étapes ne
 * coûte rien. Et les contrôles d'ouverture de session (compte suspendu, organisation
 * inactive) s'appliquent à l'instant de l'échange plutôt qu'une minute plus tôt.
 *
 * ## Ce que ce fichier ne garde pas
 *
 * Pas de jeton, pas de revendication, pas d'adresse. Un identifiant d'utilisateur et un
 * chemin de retour relatif : le minimum pour reprendre le parcours.
 */

import { randomBytes } from "node:crypto";

/** Soixante secondes : le temps d'une redirection, pas celui d'une pause café. */
export const HANDOFF_TTL_MS = 60_000;

/*
 * Une borne au nombre de tickets en vol. Sans elle, un rappel appelable en boucle ferait
 * grandir cette carte sans fin — et le `state` qui le protège est, lui, consommé.
 */
const HANDOFF_MAX = 200;

interface Handoff {
  userId: string;
  returnTo: string;
  createdAt: number;
}

const tickets = new Map<string, Handoff>();

/** Émet un ticket pour cet utilisateur. La valeur est opaque et imprévisible. */
export function issueHandoff(userId: string, returnTo: string, now = Date.now()): string {
  for (const [key, value] of tickets) {
    if (now - value.createdAt > HANDOFF_TTL_MS) tickets.delete(key);
  }
  if (tickets.size >= HANDOFF_MAX) {
    /* Le plus ancien part : un ticket abandonné ne vaut pas de refuser le suivant. */
    const oldest = tickets.keys().next();
    if (!oldest.done) tickets.delete(oldest.value);
  }
  const ref = randomBytes(32).toString("base64url");
  tickets.set(ref, { userId, returnTo, createdAt: now });
  return ref;
}

/**
 * Consomme un ticket. `null` s'il est inconnu, périmé, ou déjà échangé.
 *
 * La suppression a lieu AVANT le contrôle d'expiration, comme pour le `state` : un
 * ticket présenté une seconde fois est perdu dans tous les cas, y compris quand il
 * venait d'expirer. Sans cet ordre, un ticket périmé resterait indéfiniment en carte et
 * un attaquant pourrait le présenter en boucle pour savoir s'il a existé.
 */
export function takeHandoff(ref: string, now = Date.now()): Handoff | null {
  if (typeof ref !== "string" || ref === "") return null;
  const entry = tickets.get(ref);
  if (!entry) return null;
  tickets.delete(ref);
  if (now - entry.createdAt > HANDOFF_TTL_MS) return null;
  return entry;
}

/** Test-only : combien de tickets attendent. */
export function handoffCount(): number {
  return tickets.size;
}

/** Test-only : vider la carte entre deux cas. */
export function resetHandoffs(): void {
  tickets.clear();
}
