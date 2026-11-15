/**
 * The destination registry (Phase 10, §17).
 *
 * WHY A DESTINATION IS AN ID AND NOT A URL
 * ----------------------------------------
 * A grant binds a destination. If the caller supplied the destination as a URL,
 * then the thing bound would be a caller-controlled string, and "authorized for
 * this destination" would mean "authorized for whatever the caller typed" — the
 * agent would choose where its own authorized refund is delivered. That is the
 * SSRF sink `mcp-destination.ts` was written to close, reopened one layer up.
 *
 * So callers name a destination by id. The id resolves, server-side, through an
 * operator-controlled registry, to an origin that has already passed the Phase 9
 * address rules. An unknown id does not fall back to a default destination; it
 * fails, because a default here means an action authorized for the sandbox gets
 * delivered to production the day someone mistypes the id.
 *
 * CONFIGURATION
 * -------------
 *   OATHRION_DESTINATIONS='[{"id":"stripe-sandbox","url":"https://mcp.example.com","label":"..."}]'
 *
 * Plus one convenience the test suite and the quickstart depend on: when
 * `OATHRION_LOCAL_MCP_URL` is set, the id `local-fixture` resolves to it. That is the
 * loopback fixture, it is validated by exactly the same function as everything
 * else, and it is the only destination whose kind is `LOCAL_FIXTURE`.
 *
 * TENANT SCOPE (multi-tenant production)
 * --------------------------------------
 * A destination is where a tenant's authorized action is delivered — typically an
 * MCP server that holds THAT tenant's downstream credentials (its Stripe key, its
 * CRM token). A registry shared by every tenant would let organization B obtain a
 * grant for, and dispatch to, organization A's destination: B spending A's
 * credentials. So every entry declares who may use it:
 *
 *   "organizations": ["org_acme"]     only these tenants (the normal case)
 *   "organizations": "*"              deliberately shared by every tenant
 *
 * A destination a tenant is not scoped to is, for that tenant, indistinguishable
 * from an unregistered one: BLOCK at authorization, DESTINATION_UNKNOWN at
 * execution, absent from the listing. Not 403 — that would confirm it exists.
 *
 * An entry WITHOUT `organizations` is the pre-multi-tenant format. Outside
 * production it keeps its old meaning (shared). In production it is refused at boot
 * (`destinationRegistryProblems`) and, defensively, registers nothing at runtime:
 * a production operator must say who owns a destination, never inherit "everyone".
 * The loopback `local-fixture` is a development fixture and is shared.
 *
 * Parsed on every call rather than cached, matching `resolveDownstreamDestination`:
 * a test can register a destination on an ephemeral port after import, and an
 * operator changing the environment does not have to reason about module load
 * order.
 */

import {
  McpDestinationError,
  resolveDownstreamDestination,
  type McpDestination,
} from "../gateway/tools/mcp-destination";
import { DESTINATION_ID_PATTERN } from "@shared/action/envelope";

/** The id the loopback development fixture is always registered under. */
export const LOCAL_FIXTURE_DESTINATION_ID = "local-fixture";

export interface RegisteredDestination {
  id: string;
  label: string;
  destination: McpDestination;
  /** Tenants allowed to use this destination, or "*" for an explicitly shared one. */
  organizations: readonly string[] | "*";
}

/** Organization id shape, kept local to avoid widening this module's imports. */
const ORGANIZATION_ID_SHAPE = /^org_[a-z0-9][a-z0-9_-]{2,47}$/;

/**
 * `subject` nomme la SOURCE de la portée, pas seulement l'entrée : cette fonction sert
 * désormais aux deux façons de déclarer une destination — une entrée de
 * `OATHRION_DESTINATIONS` et la fixture loopback de `OATHRION_LOCAL_MCP_URL`. Une seule
 * définition de « portée valide », donc pas de risque qu'une des deux devienne la plus
 * faible et que ce soit celle qu'un exploitant atteigne.
 */
function parseOrganizations(subject: string, raw: unknown, production: boolean): readonly string[] | "*" {
  if (raw === undefined) {
    if (production) {
      throw new McpDestinationError(
        `${subject} does not declare "organizations". In production every ` +
          `destination must name the tenants allowed to use it (["org_..."]) or be explicitly ` +
          `shared ("*"). An undeclared owner would make it usable by every organization.`,
      );
    }
    return "*";
  }
  if (raw === "*") return "*";
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new McpDestinationError(
      `${subject} has an invalid "organizations": expected a non-empty ` +
        `array of organization ids or the string "*".`,
    );
  }
  const orgs: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !ORGANIZATION_ID_SHAPE.test(value)) {
      throw new McpDestinationError(
        `${subject} names "${String(value)}", which is not an organization id.`,
      );
    }
    orgs.push(value);
  }
  return orgs;
}

/**
 * Le nom de la variable qui donne sa portée à la fixture loopback.
 *
 * ## Pourquoi elle existe
 *
 * `OATHRION_LOCAL_MCP_URL` enregistrait `local-fixture` avec `organizations: "*"` — partagée
 * par TOUS les locataires — y compris en production, et sans que personne ne l'ait
 * déclaré. C'est exactement la faille D1 de la Phase 13 (registre de destinations global),
 * rouverte par un chemin que la correction de D1 n'avait pas couvert : la règle « en
 * production, une destination doit nommer ses locataires » s'appliquait aux entrées de
 * `OATHRION_DESTINATIONS` et pas à la fixture.
 *
 * ## Pourquoi une variable plutôt qu'un refus sec
 *
 * Une URL loopback ne peut être atteinte QUE par ce chemin : les entrées de
 * `OATHRION_DESTINATIONS` passent par `assertGenerallySafe(..., allowLoopback = false)` et une
 * adresse loopback y est refusée. Interdire `OATHRION_LOCAL_MCP_URL` en production supprimerait
 * donc la seule façon de faire tourner le bundle de production contre un service MCP local
 * — ce que `e2e:multitenant` fait, légitimement, pour prouver le chemin réel.
 *
 * La valeur suit la même grammaire que le champ `organizations` : une liste
 * d'identifiants séparés par des virgules, ou `*` pour un partage EXPLICITE. En
 * production, absente, elle refuse le démarrage ; hors production, la fixture reste
 * partagée comme avant.
 */
export const LOCAL_FIXTURE_ORGANIZATIONS_VAR = "OATHRION_LOCAL_MCP_ORGANIZATIONS";

/** Traduit la variable d'environnement vers la grammaire de `organizations`. */
function localFixtureScope(env: NodeJS.ProcessEnv, production: boolean): readonly string[] | "*" {
  const raw = env[LOCAL_FIXTURE_ORGANIZATIONS_VAR]?.trim();
  if (raw === undefined || raw === "") {
    return parseOrganizations(`${LOCAL_FIXTURE_ORGANIZATIONS_VAR} (the "${LOCAL_FIXTURE_DESTINATION_ID}" destination)`, undefined, production);
  }
  if (raw === "*") return "*";
  const list = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  return parseOrganizations(`${LOCAL_FIXTURE_ORGANIZATIONS_VAR} (the "${LOCAL_FIXTURE_DESTINATION_ID}" destination)`, list, production);
}

/** Whether `organizationId` may use this destination. */
export function destinationVisibleTo(entry: RegisteredDestination, organizationId: string): boolean {
  return entry.organizations === "*" || entry.organizations.includes(organizationId);
}

export class UnknownDestinationError extends Error {
  constructor(
    readonly destinationId: string,
    known: readonly string[],
  ) {
    super(
      `Destination "${destinationId}" is not registered. Oathrion dispatches only to destinations an ` +
        `operator has registered server-side; there is no default. ` +
        (known.length > 0 ? `Registered: ${known.join(", ")}.` : "No destinations are registered."),
    );
    this.name = "UnknownDestinationError";
  }
}

interface RawEntry {
  id?: unknown;
  url?: unknown;
  label?: unknown;
  organizations?: unknown;
}

/**
 * Every destination the operator has registered.
 *
 * Throws on a malformed registry rather than skipping the bad entry. A registry
 * that silently drops an entry is a registry where an operator believes a
 * destination is configured and actions to it are refused at runtime — or worse,
 * where a typo in the id of a *restrictive* entry leaves a permissive one behind.
 */
export function listDestinations(env: NodeJS.ProcessEnv = process.env): RegisteredDestination[] {
  const production = env.NODE_ENV?.trim() === "production";
  const registered: RegisteredDestination[] = [];
  const seen = new Set<string>();

  const local = env.OATHRION_LOCAL_MCP_URL?.trim();
  if (local) {
    // Validated by the Phase 9 resolver, which is loopback-only for this variable
    // and refuses it being set alongside a remote downstream.
    const destination = resolveDownstreamDestination(env);
    if (destination) {
      registered.push({
        id: LOCAL_FIXTURE_DESTINATION_ID,
        label: "Local MCP fixture",
        destination,
        organizations: localFixtureScope(env, production),
      });
      seen.add(LOCAL_FIXTURE_DESTINATION_ID);
    }
  }

  const raw = env.OATHRION_DESTINATIONS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new McpDestinationError(
        "OATHRION_DESTINATIONS is not valid JSON. Expected an array of " +
          '{ "id", "url", "label" } objects.',
      );
    }
    if (!Array.isArray(parsed)) {
      throw new McpDestinationError("OATHRION_DESTINATIONS must be a JSON array.");
    }

    for (const entry of parsed as RawEntry[]) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!DESTINATION_ID_PATTERN.test(id)) {
        throw new McpDestinationError(
          `OATHRION_DESTINATIONS entry has an invalid id "${String(entry?.id)}". ` +
            "Ids are lowercase, 3-64 characters, letters, digits and hyphens.",
        );
      }
      if (seen.has(id)) {
        // Refused rather than last-wins. Two entries for one id means one of them
        // is not in effect and nobody knows which.
        throw new McpDestinationError(`OATHRION_DESTINATIONS contains duplicate id "${id}".`);
      }
      const url = typeof entry?.url === "string" ? entry.url.trim() : "";
      if (url === "") {
        throw new McpDestinationError(`OATHRION_DESTINATIONS entry "${id}" has no url.`);
      }

      /*
       * Validated through the same code path a real downstream goes through:
       * the allowlist AND the address rules. Reusing the resolver rather than
       * re-implementing its checks is the point — a second copy of an SSRF
       * blocklist is a second copy that falls behind.
       */
      const destination = resolveDownstreamDestination({
        OATHRION_MCP_DOWNSTREAM_URL: url,
        OATHRION_MCP_ALLOWED_DESTINATIONS: env.OATHRION_MCP_ALLOWED_DESTINATIONS,
      } as NodeJS.ProcessEnv);
      if (!destination) {
        throw new McpDestinationError(`OATHRION_DESTINATIONS entry "${id}" did not resolve to a destination.`);
      }

      registered.push({
        id,
        label: typeof entry?.label === "string" && entry.label !== "" ? entry.label : id,
        destination,
        organizations: parseOrganizations(`OATHRION_DESTINATIONS entry "${id}"`, entry?.organizations, production),
      });
      seen.add(id);
    }
  }

  return registered;
}

/** Resolves one id, or throws. Never returns a fallback. */
/**
 * The destinations `organizationId` may use. The only listing a request handler
 * should call: `listDestinations` is the operator's whole registry.
 */
export function listDestinationsFor(
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): RegisteredDestination[] {
  return listDestinations(env).filter((entry) => destinationVisibleTo(entry, organizationId));
}

/**
 * Resolves a destination id FOR A TENANT. A destination registered for another
 * organization is reported exactly like an unregistered one.
 */
export function resolveDestination(
  destinationId: string,
  env: NodeJS.ProcessEnv,
  organizationId: string,
): RegisteredDestination {
  const visible = listDestinationsFor(organizationId, env);
  const match = visible.find((entry) => entry.id === destinationId);
  if (!match) throw new UnknownDestinationError(destinationId, visible.map((entry) => entry.id));
  return match;
}

export function isRegisteredDestination(
  destinationId: string,
  env: NodeJS.ProcessEnv,
  organizationId: string,
): boolean {
  try {
    return listDestinationsFor(organizationId, env).some((entry) => entry.id === destinationId);
  } catch {
    // A broken registry registers nothing. Fail closed.
    return false;
  }
}

/**
 * Boot-time validation of the registry. Returns problems instead of throwing so
 * `runtimeConfigProblems` can report every misconfiguration at once. In
 * production this is what refuses an entry with no declared tenant scope.
 */
export function destinationRegistryProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  /*
   * LE REPLI À L'ÉCHELLE DU DÉPLOIEMENT, REFUSÉ EN PRODUCTION.
   *
   * `OATHRION_MCP_DOWNSTREAM_URL` n'est pas une entrée du registre : c'est la destination que
   * la passerelle utilise quand un appel n'en nomme AUCUNE
   * (`call.destination ?? resolveDownstreamDestination()` dans
   * `gateway/tools/mcp-client.ts`). Elle n'a donc pas de portée par locataire, et il n'y a
   * aucun endroit où lui en donner une : sur une instance partagée, l'action autorisée de
   * l'organisation B part vers l'unique service aval du déploiement, qui détient
   * typiquement les credentials de A. C'est la faille D1 de la Phase 13 par un autre
   * chemin, et le rapport de cette phase la signalait déjà comme « à l'échelle du
   * déploiement, pas par tenant » sans que le code l'empêche.
   *
   * Refusée, et non cadrée : le chemin cadré existe déjà et c'est `OATHRION_DESTINATIONS`,
   * dont chaque entrée nomme ses locataires. Ajouter une portée à une variable dont la
   * raison d'être est « destination par défaut quand on n'en nomme pas » reviendrait à
   * garder deux façons de faire la même chose, dont une sans identifiant à citer dans un
   * grant.
   */
  if (env.NODE_ENV?.trim() === "production" && env.OATHRION_MCP_DOWNSTREAM_URL?.trim()) {
    problems.push(
      `OATHRION_MCP_DOWNSTREAM_URL is set, and in production it is refused. It is the ` +
        `destination the gateway falls back to when a call names none, so it belongs to the ` +
        `whole deployment and cannot be scoped to a tenant: on a shared instance one ` +
        `organization's authorized action would be dispatched to the single downstream ` +
        `service, which usually holds another organization's credentials. Declare the ` +
        `destination in OATHRION_DESTINATIONS instead, with its "organizations", and have ` +
        `callers name it by id.`,
    );
  }

  if (!env.OATHRION_DESTINATIONS?.trim() && !env.OATHRION_LOCAL_MCP_URL?.trim()) return problems;
  try {
    listDestinations(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}
