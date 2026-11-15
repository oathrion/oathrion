/**
 * Les en-têtes HTTP du contrat — **la seule définition**, et la règle de compatibilité.
 *
 * ## Pourquoi ce fichier existe, et pourquoi le plan de renommage l'avait manqué
 *
 * `notes/RENOMMAGE-PLACET.md` classait le renommage en trois catégories : le texte
 * libre, les variables d'environnement, et les valeurs déjà écrites en base. Les
 * en-têtes HTTP n'y figuraient pas, et ils sont la catégorie la plus coûteuse à se
 * tromper : **ce sont des lignes de code chez le client.**
 *
 *   - `X-ARIA-Agent-Id` est envoyé PAR le client à chaque appel de la passerelle ;
 *   - `X-ARIA-Execution-Id` est envoyé par nous VERS le serveur d'outils du client, et
 *     `examples/mcp-server/` s'en sert comme clé d'idempotence — c'est-à-dire que le
 *     renommer sans alias ferait silencieusement perdre la déduplication chez tous ceux
 *     qui ont suivi notre exemple ;
 *   - `X-ARIA-Event`, `X-ARIA-Delivery` et `X-ARIA-Signature` sont ce sur quoi un
 *     receveur de webhook filtre et vérifie une signature.
 *
 * Une variable d'environnement se change en éditant un fichier d'unité. Un en-tête se
 * change en déployant un logiciel qu'on ne contrôle pas.
 *
 * ## La règle, identique à celle de `env-compat.ts`
 *
 * **En entrée** : le nom courant gagne ; le nom hérité n'est lu que seul.
 * **En sortie** : les DEUX sont envoyés, pendant une version majeure.
 *
 * ## Placet → Oathrion (27 octobre 2026) : `X-ARIA-*` EST RETIRÉ à son tour
 *
 * Le nom courant devient `X-Oathrion-*`, et `X-Placet-*` l'hérité, encore accepté en
 * entrée et encore émis en sortie. Deux générations au plus : `X-ARIA-*` sort.
 *
 * Ce module porte aussi, depuis ce renommage, les en-têtes que le PARE-FEU pose sur ses
 * réponses (`Decision`, `Rule`, `Credential-Injected`) : ils étaient écrits en dur dans
 * `routes-intercept.ts`, et un client qui teste `x-placet-decision` doit continuer à le
 * trouver.
 *
 * ## `X-AgentOS-*` EST RETIRÉ (renommage précédent)
 *
 * Les webhooks portaient trois générations d'en-têtes dès qu'on ajoutait celle-ci :
 * `X-AgentOS-*`, `X-ARIA-*`, `X-Placet-*`. Trois signatures du même corps dans la même
 * requête n'est pas de la compatibilité, c'est un contrat qu'on ne peut plus énoncer —
 * et un receveur qui vérifie la mauvaise des trois se croit protégé. La génération la
 * plus ancienne sort donc quand la nouvelle entre, et le nombre d'en-têtes reste
 * constant.
 */

/** Le préfixe courant. Un seul endroit où il s'écrit. */
const CURRENT = "X-Oathrion-";

/** Le préfixe hérité encore honoré en entrée et encore émis en sortie. */
const LEGACY = "X-Placet-";

/** Le suffixe de chaque en-tête du contrat. */
export const WIRE_HEADER_SUFFIXES = {
  /** L'agent que l'appelant déclare agir. Toujours une *demande* : la liaison du credential gagne. */
  agentId: "Agent-Id",
  /** La clé d'idempotence transmise au serveur d'outils du client. */
  executionId: "Execution-Id",
  /** Le type d'événement, pour qu'un receveur de webhook filtre sans lire le corps. */
  event: "Event",
  /** L'identifiant de livraison, pour que le receveur déduplique. */
  delivery: "Delivery",
  /** La signature HMAC du corps. */
  signature: "Signature",
  /** La décision du pare-feu sur une requête relayée. */
  decision: "Decision",
  /** La règle d'interception qui a été appliquée. */
  rule: "Rule",
  /** Si le pare-feu a injecté le credential du fournisseur. */
  credentialInjected: "Credential-Injected",
} as const;

export type WireHeader = keyof typeof WIRE_HEADER_SUFFIXES;

/** Le nom courant d'un en-tête du contrat. */
export function wireHeader(name: WireHeader): string {
  return `${CURRENT}${WIRE_HEADER_SUFFIXES[name]}`;
}

/** Son nom hérité, encore accepté en entrée et encore émis en sortie. */
export function legacyWireHeader(name: WireHeader): string {
  return `${LEGACY}${WIRE_HEADER_SUFFIXES[name]}`;
}

/**
 * Les deux noms, dans l'ordre de précédence : courant d'abord.
 *
 * Rendu comme une paire plutôt que lu deux fois par l'appelant, parce qu'un appelant
 * qui lit dans le mauvais ordre fait gagner le nom hérité — exactement la régression
 * que `env-compat.ts` interdit côté variables.
 */
export function wireHeaderNames(name: WireHeader): readonly [string, string] {
  return [wireHeader(name), legacyWireHeader(name)];
}

/**
 * Lit un en-tête du contrat depuis une collection d'en-têtes reçus, nom courant
 * d'abord.
 *
 * `get` est fourni par l'appelant parce que les deux surfaces qui en ont besoin ne
 * présentent pas la même interface — Express expose `req.get`, et le transport MCP un
 * objet brut en minuscules. Une seule règle de précédence, deux façons de lire.
 */
export function readWireHeader(
  name: WireHeader,
  get: (header: string) => string | undefined,
): string | undefined {
  for (const candidate of wireHeaderNames(name)) {
    const value = get(candidate);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}
