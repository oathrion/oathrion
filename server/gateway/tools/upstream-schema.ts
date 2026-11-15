/**
 * La correspondance entre une déclaration et ce que le serveur d'en face déclare.
 *
 * ## Le défaut que ce module ferme
 *
 * `OATHRION_TOOLS` laisse un exploitant écrire « mon verbe `refund` appelle
 * `refunds.create` chez moi, avec `customer` ← `target` ». Rien ne comparait cela au
 * schéma réel du serveur. Trois fautes passaient donc le démarrage et ne se révélaient
 * qu'au premier appel d'un client :
 *
 *   1. un nom d'outil qui n'existe pas (`refunds.creat`) ;
 *   2. un argument que le serveur EXIGE et que la déclaration oublie ;
 *   3. un argument projeté que le schéma ne connaît pas — celui-là est le plus
 *      sournois, parce que le serveur l'IGNORE en silence : l'exploitant croit avoir
 *      transmis un montant, le fournisseur n'en a jamais vu.
 *
 * ## Pourquoi la vérification est à l'exécution et pas au démarrage
 *
 * Elle demande un appel réseau. Au démarrage, elle ferait dépendre le boot de la
 * disponibilité d'un service tiers : un serveur en maintenance empêcherait Oathrion de
 * démarrer, et la réaction naturelle d'un exploitant serait de désactiver la
 * vérification. Un garde qu'il faut contourner pour travailler ne protège personne.
 *
 * Elle est donc faite au premier appel, mise en cache par destination, et le résultat est
 * porté par le reçu.
 *
 * ## Le choix fail-closed, et sa limite assumée
 *
 * Quand la découverte RÉUSSIT, un désaccord refuse la dépêche. C'est le cas qui compte.
 *
 * Quand la découverte ÉCHOUE, la dépêche a lieu et le reçu porte `schemaChecked: false`
 * avec la raison. Ce n'est pas un repli permissif par paresse : `tools/list` est optionnel
 * dans la pratique, et refuser tout appel parce qu'un serveur ne l'implémente pas
 * rendrait Oathrion inutilisable contre des serveurs qui fonctionnent. L'exploitant qui
 * veut un refus strict l'écrit : `"requireSchema": true` dans sa déclaration. L'arbitrage
 * est donc explicite, et visible dans le reçu dans les deux cas.
 */

import {
  discoverDownstreamTools,
  DownstreamDiscoveryError,
  type DownstreamToolSchema,
} from "./mcp-client";
import type { McpDestination } from "./mcp-destination";

/** Ce que la vérification a conclu. `null` quand elle n'a pas pu avoir lieu. */
export interface SchemaVerdict {
  /** `true` quand le schéma a été lu ET que la déclaration lui correspond. */
  ok: boolean;
  /** `false` quand la découverte elle-même n'a pas abouti. */
  checked: boolean;
  /** Un code machine : l'appelant branche sur lui, jamais sur la prose. */
  reason:
    | "ok"
    | "tool_not_found_upstream"
    | "missing_required_argument"
    | "unknown_argument_upstream"
    | "discovery_unavailable";
  /** Ce qu'un humain doit lire pour corriger. Nomme toujours la correction. */
  detail: string;
}

interface CacheEntry {
  at: number;
  tools: DownstreamToolSchema[] | null;
  /** L'erreur de découverte, conservée pour que le motif reste nommé. */
  problem: string | null;
}

/*
 * Un cache par destination, et une durée courte.
 *
 * Court parce qu'un serveur peut ajouter un outil sans qu'Oathrion redémarre, et qu'un
 * cache d'une journée ferait refuser une correspondance devenue correcte. Pas de cache du
 * tout ferait un `tools/list` avant chaque dépêche, c'est-à-dire doubler la latence et le
 * trafic de chaque action pour revérifier ce qui change une fois par trimestre.
 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/** Test-only : oublie ce qui a été découvert. */
export function resetUpstreamSchemaCache(): void {
  cache.clear();
}

async function schemasFor(
  destinationId: string,
  destination: McpDestination,
  now: number,
): Promise<CacheEntry> {
  const cached = cache.get(destinationId);
  if (cached && now - cached.at < TTL_MS) return cached;

  let entry: CacheEntry;
  try {
    entry = { at: now, tools: await discoverDownstreamTools(destination), problem: null };
  } catch (error) {
    /*
     * L'échec est mis en cache LUI AUSSI, et c'est volontaire. Sans cela, un serveur qui
     * n'implémente pas `tools/list` recevrait une tentative de découverte avant chaque
     * action — un appel inutile par dépêche, sur un chemin dont la latence compte.
     */
    entry = {
      at: now,
      tools: null,
      problem:
        error instanceof DownstreamDiscoveryError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
  cache.set(destinationId, entry);
  return entry;
}

/**
 * Compare une déclaration au schéma du serveur.
 *
 * `projected` est l'ensemble des noms d'arguments que la déclaration enverra — les clés
 * de la projection, pas les valeurs : la vérification porte sur la forme de
 * l'instruction, et elle a donc lieu avant que les valeurs existent.
 */
export async function verifyAgainstUpstream(params: {
  destinationId: string;
  destination: McpDestination;
  tool: string;
  projected: string[];
  now?: number;
}): Promise<SchemaVerdict> {
  const entry = await schemasFor(params.destinationId, params.destination, params.now ?? Date.now());

  if (entry.tools === null) {
    return {
      ok: false,
      checked: false,
      reason: "discovery_unavailable",
      detail:
        `The schema of "${params.destinationId}" could not be read, so the mapping ` +
        `is not checked: ${entry.problem ?? "unknown reason"}. ` +
        `If this server does not implement tools/list, that is expected — check the ` +
        `mapping by hand. To refuse dispatch in that case, add ` +
        `"requireSchema": true to this tool's declaration.`,
    };
  }

  const schema = entry.tools.find((tool) => tool.name === params.tool);
  if (!schema) {
    const known = entry.tools.map((tool) => tool.name);
    return {
      ok: false,
      checked: true,
      reason: "tool_not_found_upstream",
      detail:
        `The server "${params.destinationId}" declares no tool named ` +
        `"${params.tool}". It declares: ${known.length > 0 ? known.join(", ") : "no tool"}. ` +
        `Fix the declaration's "tool" field.`,
    };
  }

  const missing = schema.required.filter((name) => !params.projected.includes(name));
  if (missing.length > 0) {
    return {
      ok: false,
      checked: true,
      reason: "missing_required_argument",
      detail:
        `"${params.tool}" requires ${missing.map((n) => `"${n}"`).join(", ")}, which the ` +
        `declaration does not map. Add them to "arguments" — for example ` +
        `"${missing[0]!}": "metadata.${missing[0]!}". Without this the server would receive an ` +
        `incomplete instruction.`,
    };
  }

  /*
   * Un argument que le schéma ne connaît pas. Vérifié SEULEMENT quand le serveur a
   * déclaré des propriétés : un `inputSchema` sans `properties` est un schéma ouvert, et
   * y voir « aucun argument permis » refuserait tous les appels à un serveur légitime.
   */
  if (schema.properties.length > 0) {
    const unknown = params.projected.filter((name) => !schema.properties.includes(name));
    if (unknown.length > 0) {
      return {
        ok: false,
        checked: true,
        reason: "unknown_argument_upstream",
        detail:
          `The declaration maps ${unknown.map((n) => `"${n}"`).join(", ")}, which the schema ` +
          `of "${params.tool}" does not declare. The server would ignore them SILENTLY: ` +
          `you would believe you passed this field. It declares: ` +
          `${schema.properties.join(", ")}.`,
      };
    }
  }

  return {
    ok: true,
    checked: true,
    reason: "ok",
    detail: `The declaration matches the schema that "${params.destinationId}" announces.`,
  };
}
