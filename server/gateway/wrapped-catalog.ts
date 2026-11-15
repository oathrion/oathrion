/**
 * Ce que la couche MCP a le droit de savoir des serveurs enveloppés — et rien de plus.
 *
 * `server/mcp/` ne doit jamais tenir un outil (`mcp-single-path.test.ts`, « does not import
 * any tool implementation ») : un module qui tient une instance peut l'exécuter, et la
 * passerelle cesserait d'être le seul chemin. Or le routeur et le catalogue ont besoin de
 * savoir, pour un verbe `mcp.<serveur>.<outil>`, le nom d'origine de l'outil, son schéma et
 * sa description — pour lire ses arguments et l'annoncer au modèle.
 *
 * Ce module est cette frontière : des FICHES, des données inertes, écrites par
 * `gateway/tools/stdio-mcp-tool.ts` à l'inscription d'un serveur, lues par `server/mcp/`.
 * Aucune référence à un outil, aucune fonction qui agirait.
 */

/** Le préfixe des identifiants d'outil des serveurs enveloppés. */
export const STDIO_TOOL_ID_PREFIX = "mcp_stdio_";

export interface WrappedEntryCard {
  /** Le verbe, `mcp.<serveur>.<outil>`, normalisé. */
  readonly verb: string;
  readonly server: string;
  /** Le nom de l'outil chez l'enfant, tel qu'il l'a déclaré. */
  readonly original: string;
  readonly toolClass: "read" | "write" | "destructive";
  /** Pour une lecture : sur l'annotation du serveur, ou sur son seul nom. */
  readonly readBasis?: "annotation" | "name";
  readonly description?: string;
  readonly inputSchema?: unknown;
}

const CARDS = new Map<string, WrappedEntryCard>();

/** Écrit les fiches d'un serveur. Réservé à `stdio-mcp-tool.ts`. */
export function publishWrappedCards(cards: readonly WrappedEntryCard[]): void {
  for (const card of cards) CARDS.set(card.verb, Object.freeze({ ...card }));
}

/** Retire les fiches d'un serveur. */
export function withdrawWrappedCards(server: string): void {
  for (const [verb, card] of CARDS) if (card.server === server) CARDS.delete(verb);
}

/** La fiche d'un verbe enveloppé, ou `undefined`. */
export function wrappedCard(action: string): WrappedEntryCard | undefined {
  return CARDS.get(action.trim().toLowerCase());
}
