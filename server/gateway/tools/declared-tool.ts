/**
 * Un outil DÉCLARÉ par l'exploitant, au lieu d'être écrit en dur dans ce dépôt.
 *
 * ## Le blocage que ceci lève
 *
 * `docs/limitations.md` disait : « The tool registry is five hardcoded simulated tools »,
 * et c'était le vrai obstacle d'un pilote. Le chemin réel existait pourtant déjà et il
 * est éprouvé — `OATHRION_DESTINATIONS` déclare des serveurs MCP vérifiés contre le SSRF,
 * et `npm run verify:mcp` fait la démonstration de bout en bout contre un serveur qui ne
 * partage aucune ligne de code avec Oathrion.
 *
 * Ce qui manquait n'était donc pas la capacité de joindre un outil réel : c'était la
 * capacité de DÉCLARER le sien. Un client ne pouvait pas dire « mon verbe `refund`
 * appelle `refunds.create` chez moi » sans modifier du TypeScript et reconstruire.
 *
 * ## Les arguments sont PROJETÉS, jamais devinés
 *
 * Un connecteur générique ne peut pas connaître la forme des arguments de chaque
 * fournisseur. Deux réponses étaient possibles, et une seule est honnête.
 *
 * Deviner — envoyer un enveloppe fixe en espérant que le serveur d'en face s'adapte —
 * reviendrait à ce qu'Oathrion invente le contenu d'une instruction qu'il signe. Ce
 * module fait l'inverse : chaque argument est une **projection déclarée** d'un champ que
 * Oathrion détient déjà (`target`, `currency`, `agentId`, `metadata.<clé>`). Une source
 * inconnue est refusée **au démarrage**, pas au moment de l'appel : une faute de frappe
 * dans un nom de champ doit être un refus de boot, pas un virement avec un champ vide.
 *
 * ## Ce que ce module ne relâche pas
 *
 * **La destination passe par le registre existant.** Aucun nouveau chemin de sortie,
 * aucune nouvelle surface SSRF : `resolveDestination` applique l'allowlist et les règles
 * d'adresse de `webhook-url.ts`, exactement comme avant.
 *
 * **Le verbe doit être au catalogue.** `ToolRegistry` refuse de câbler un verbe absent de
 * `shared/policy/actions.ts`. Un outil déclaré ne contourne pas cette barrière — il la
 * rencontre au même endroit que les outils intégrés, à la construction du registre.
 *
 * **`simulated` reste vrai.** Un outil déclaré rend `false` quand sa destination se
 * résout, et `true` sinon. La même fonction répond à l'inventaire et au branchement :
 * deux lecteurs d'une condition, jamais deux conditions.
 */

import { lookupAction, normalizeActionName } from "@shared/policy/actions";

import { listDestinations, resolveDestination } from "../../authority/destinations";
import { callDownstreamTool } from "./mcp-client";
import { verifyAgainstUpstream } from "./upstream-schema";
import { CountingTool, type ToolContext, type ToolResult } from "./types";

/** Les champs du contexte qu'une déclaration peut projeter, et rien d'autre. */
const PROJECTABLE = ["target", "currency", "agentId", "agentName", "action", "executionId"] as const;
const METADATA_PREFIX = "metadata.";

export interface DeclaredToolSpec {
  id: string;
  label: string;
  /** L'identifiant d'une entrée de `OATHRION_DESTINATIONS`. */
  destination: string;
  /** Le nom de l'outil chez le fournisseur, par exemple `refunds.create`. */
  tool: string;
  /** Les verbes que cet outil revendique. Chacun doit être au catalogue d'actions. */
  actions: string[];
  /** `{ nomChezLeFournisseur: sourceDansLeContexte }`. */
  arguments: Record<string, string>;
  /**
   * Refuser la dépêche quand le schéma du serveur n'a pas pu être lu.
   *
   * `false` par défaut : `tools/list` est optionnel en pratique, et refuser tout appel
   * parce qu'un serveur ne l'implémente pas rendrait Oathrion inutilisable contre des
   * serveurs qui fonctionnent. Le reçu porte alors `schemaChecked: false` avec la raison,
   * donc le choix reste visible plutôt que silencieux.
   *
   * `true` est le réglage d'un exploitant qui veut que « non vérifiable » vaille « non ».
   */
  requireSchema: boolean;
}

export class DeclaredToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclaredToolError";
  }
}

/** Projette une source déclarée sur le contexte réel. */
function project(source: string, context: ToolContext): unknown {
  if (source.startsWith(METADATA_PREFIX)) {
    return context.metadata[source.slice(METADATA_PREFIX.length)];
  }
  return (context as unknown as Record<string, unknown>)[source];
}

export class DeclaredTool extends CountingTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  constructor(
    private readonly spec: DeclaredToolSpec,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    super();
    this.id = spec.id;
    this.name = spec.label;
    this.description = `Declared connector: calls "${spec.tool}" on destination "${spec.destination}".`;
  }

  /**
   * Résolue à chaque lecture, jamais mise en cache : c'est une propriété du
   * DÉPLOIEMENT. Une destination retirée de `OATHRION_DESTINATIONS` doit faire repasser
   * l'inventaire à « simulé » au lieu de continuer à annoncer un branchement mort.
   */
  override get simulated(): boolean {
    /*
     * La question posée ici est « un appel resterait-il à l'intérieur d'Oathrion ? »,
     * et elle est INDÉPENDANTE du locataire : l'inventaire (`GET /api/tools`) décrit le
     * déploiement, pas les droits de celui qui regarde. Si l'exploitant n'a déclaré
     * aucune destination de ce nom, rien ne peut partir et « simulé » est la vérité.
     * Savoir si CE locataire-là y a droit est une question d'autorisation, tranchée à
     * l'appel par `resolveDestination` — et un refus y devient un échec nommé, pas un
     * succès silencieux.
     */
    try {
      return !listDestinations(this.env).some((entry) => entry.id === this.spec.destination);
    } catch {
      // Un registre cassé ne déclare rien : on échoue du côté fermé.
      return true;
    }
  }

  protected async run(context: ToolContext): Promise<ToolResult> {
    let destination;
    try {
      destination = resolveDestination(this.spec.destination, this.env, context.organizationId);
    } catch (error) {
      /*
       * Un échec ici n'est PAS un succès silencieux. L'action a été autorisée, donc
       * l'appelant doit apprendre que rien n'est parti — et apprendre pourquoi.
       */
      return {
        ok: false,
        summary: `Destination "${this.spec.destination}" is not available to this organisation; nothing was dispatched.`,
        /*
         * `reason` est un CODE, et `detail` la prose. L'autre refus de cette méthode
         * rend `unprojectable_arguments` : deux refus du même outil doivent se lire de
         * la même façon, sinon un exploitant qui branche sur le code en manque un.
         * Le détail vient de `UnknownDestinationError`, qui ne nomme que les
         * destinations visibles à CE locataire — jamais celles d'un autre.
         */
        data: {
          dispatched: false,
          reason: "destination_unavailable",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }

    /*
     * UNE SOURCE QUI NE PROJETTE RIEN ARRÊTE L'APPEL.
     *
     * Le refus au démarrage couvre la source INCONNUE (`metadta.amount`). Il ne peut
     * rien dire de la source connue mais ABSENTE à l'exécution : `metadata.amount`
     * est une projection légitime, et pourtant `undefined` quand l'agent n'a pas
     * envoyé le champ.
     *
     * `JSON.stringify` efface une valeur `undefined`. Dépêcher malgré tout ferait
     * donc partir `{"customer":"cus_7"}` là où Oathrion croit avoir transmis un
     * montant — et un fournisseur qui complète le champ manquant par un défaut
     * rembourserait une somme que personne n'a autorisée. L'appel est refusé, nommé,
     * et le reçu est `failed` : le grant reste consommé, aucun nouvel essai.
     *
     * Ce que cela coûte : une déclaration ne sait pas encore dire « cet argument est
     * optionnel ». C'est écrit dans `docs/limitations.md` plutôt que contourné ici.
     */
    const args: Record<string, unknown> = {};
    const unprojectable: string[] = [];
    for (const [name, source] of Object.entries(this.spec.arguments)) {
      const value = project(source, context);
      if (value === undefined) {
        unprojectable.push(`${name} ← ${source}`);
        continue;
      }
      args[name] = value;
    }
    if (unprojectable.length > 0) {
      return {
        ok: false,
        summary:
          `Nothing was dispatched: ${unprojectable.length} declared argument(s) of ` +
          `"${this.spec.tool}" had no value in this call (${unprojectable.join(", ")}).`,
        data: { dispatched: false, reason: "unprojectable_arguments", arguments: unprojectable },
      };
    }

    /*
     * LA CORRESPONDANCE EST VÉRIFIÉE CONTRE LE SCHÉMA DU SERVEUR, AVANT LA DÉPÊCHE.
     *
     * Jusqu'ici, une faute d'une lettre dans le nom de l'outil distant, ou un argument
     * que le serveur exige et que la déclaration oublie, ne se révélait qu'au premier
     * appel réel d'un client — et sous la forme d'une erreur du fournisseur, pas d'un
     * défaut de configuration. La vérification porte sur les NOMS des arguments, donc
     * elle a lieu avant que leurs valeurs comptent.
     */
    const verdict = await verifyAgainstUpstream({
      destinationId: destination.id,
      destination: destination.destination,
      tool: this.spec.tool,
      projected: Object.keys(this.spec.arguments),
    });

    if (verdict.checked && !verdict.ok) {
      /*
       * Le schéma a été LU et il contredit la déclaration. Dépêcher malgré cela enverrait
       * une instruction dont on sait qu'elle est fausse. Le motif nomme la correction.
       */
      return {
        ok: false,
        summary: `Nothing was dispatched: ${verdict.detail}`,
        data: {
          dispatched: false,
          reason: verdict.reason,
          schemaChecked: true,
          tool: this.spec.tool,
          destination: destination.id,
        },
      };
    }

    if (!verdict.checked && this.spec.requireSchema) {
      return {
        ok: false,
        summary: `Nothing was dispatched: ${verdict.detail}`,
        data: {
          dispatched: false,
          reason: "schema_unverifiable",
          schemaChecked: false,
          tool: this.spec.tool,
          destination: destination.id,
        },
      };
    }

    const downstream = await callDownstreamTool({
      tool: this.spec.tool,
      arguments: args,
      executionId: context.executionId,
      destination: destination.destination,
    });

    return {
      ok: downstream.ok,
      summary: `${context.action} dispatched to "${this.spec.tool}" on ${destination.label}.`,
      data: {
        ...downstream.data,
        dispatched: true,
        destination: destination.id,
        tool: this.spec.tool,
        /*
         * Porté par le reçu, dans les deux cas. Un exploitant doit pouvoir distinguer
         * « la correspondance a été vérifiée » de « on n'a pas pu la vérifier » sans
         * relire la configuration.
         */
        schemaChecked: verdict.checked,
        ...(verdict.checked ? {} : { schemaUnverifiedReason: verdict.detail }),
      },
    };
  }
}

/* -------------------------------- parsing -------------------------------- */

const ID_SHAPE = /^[a-z][a-z0-9_]{2,47}$/;

function fail(message: string): never {
  throw new DeclaredToolError(
    `OATHRION_TOOLS: ${message}\n` +
      `  Expected a JSON array, for example:\n` +
      `  [{"id":"acme_refund","label":"Acme refunds","destination":"acme-erp",` +
      `"tool":"refunds.create","actions":["refund"],` +
      `"arguments":{"customer":"target","amount":"metadata.amount","currency":"currency"}}]`,
  );
}

/**
 * Lit la déclaration, ou rend une liste vide quand il n'y en a pas.
 *
 * Toute erreur est une exception, jamais une entrée ignorée. Sauter en silence une
 * déclaration mal formée produirait un déploiement où un verbe est autorisé par la
 * politique et n'atteint aucun outil — c'est-à-dire un refus déguisé en succès.
 */
export function parseDeclaredTools(env: NodeJS.ProcessEnv = process.env): DeclaredToolSpec[] {
  const raw = env.OATHRION_TOOLS?.trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("the value is not valid JSON.");
  }
  if (!Array.isArray(parsed)) fail("the value must be a JSON array.");

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const at = `entry ${index}`;
    if (typeof entry !== "object" || entry === null) fail(`${at} is not an object.`);
    const e = entry as Record<string, unknown>;

    const id = typeof e.id === "string" ? e.id : "";
    if (!ID_SHAPE.test(id)) {
      fail(`${at} has an invalid id ${JSON.stringify(e.id)}; expected lowercase letters, digits and underscores.`);
    }
    if (seen.has(id)) fail(`${at} repeats the id "${id}"; a tool id must be unique.`);
    seen.add(id);

    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : id;
    const destination = typeof e.destination === "string" ? e.destination.trim() : "";
    if (!destination) fail(`tool "${id}" declares no destination.`);
    const tool = typeof e.tool === "string" ? e.tool.trim() : "";
    if (!tool) fail(`tool "${id}" declares no downstream tool name.`);

    const actions = Array.isArray(e.actions) ? e.actions.filter((a): a is string => typeof a === "string") : [];
    if (actions.length === 0) fail(`tool "${id}" claims no action; a tool nothing routes to is dead configuration.`);

    const argsRaw = e.arguments;
    if (typeof argsRaw !== "object" || argsRaw === null || Array.isArray(argsRaw)) {
      fail(`tool "${id}" declares no argument mapping.`);
    }
    const args: Record<string, string> = {};
    for (const [name, source] of Object.entries(argsRaw as Record<string, unknown>)) {
      if (typeof source !== "string") fail(`tool "${id}": argument "${name}" must name a context field.`);
      const known =
        (PROJECTABLE as readonly string[]).includes(source) ||
        (source.startsWith(METADATA_PREFIX) && source.length > METADATA_PREFIX.length);
      if (!known) {
        /*
         * Refusé au DÉMARRAGE. Une source inconnue projetterait `undefined` dans une
         * instruction autorisée : le fournisseur recevrait un champ vide là où Oathrion
         * croit avoir transmis un montant.
         */
        fail(
          `tool "${id}": argument "${name}" names "${source}", which is not a context field. ` +
            `Use one of ${PROJECTABLE.join(", ")}, or "metadata.<key>".`,
        );
      }
      args[name] = source;
    }

    const requireSchema = e.requireSchema;
    if (requireSchema !== undefined && typeof requireSchema !== "boolean") {
      fail(`tool "${id}": "requireSchema" must be true or false.`);
    }

    return { id, label, destination, tool, actions, arguments: args, requireSchema: requireSchema === true };
  });
}

/* ------------------------------ boot refusal ------------------------------ */

/**
 * Les problèmes de déclaration, nommés AU DÉMARRAGE.
 *
 * `parseDeclaredTools` valide la FORME. Ceci valide les deux choses qu'une forme
 * valide peut encore avoir fausses, et qui ne se verraient autrement qu'au premier
 * appel d'un client :
 *
 *   1. **Une destination qui n'existe pas.** `"destination":"acme-rep"` au lieu de
 *      `"acme-erp"` passe toutes les vérifications de forme. Sans ce contrôle, le
 *      déploiement démarre, l'inventaire annonce l'outil comme « simulé », et le verbe
 *      `refund` du client est autorisé par la politique pour n'atteindre personne. C'est
 *      le défaut `RATE_LIMIT_FAIL_MODE=opn` de la phase 13 par un autre chemin : une
 *      faute de frappe qui boote et ne se révèle qu'à la première requête réelle.
 *      Refusé en développement comme en production, parce qu'une destination absente
 *      n'est pas une politique de déploiement : rien ne peut fonctionner.
 *
 *   2. **Un verbe absent du catalogue.** Le constructeur de `ToolRegistry` est la
 *      barrière qui COMPTE — elle est infranchissable et elle lève à la construction du
 *      registre, donc avant que ce module-ci ne soit consulté. Le contrôle est répété
 *      ici pour que `npm run verify:prod-config`, qui lit la configuration sans monter
 *      les routes, nomme le problème au lieu de le laisser passer.
 *
 * Rend une liste, jamais une exception : `runtimeConfigProblems` rapporte TOUTES les
 * fautes d'un coup, pour qu'un exploitant ne les découvre pas une par une.
 */
export function declaredToolProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  let specs: DeclaredToolSpec[];
  try {
    specs = parseDeclaredTools(env);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (specs.length === 0) return [];

  let known: string[];
  try {
    known = listDestinations(env).map((entry) => entry.id);
  } catch {
    /*
     * Le registre de destinations est lui-même cassé. `destinationRegistryProblems`
     * le dit déjà, avec le détail ; ajouter « destination introuvable » pour chaque
     * outil déclaré noierait la cause sous ses conséquences.
     */
    return [];
  }

  const problems: string[] = [];
  for (const spec of specs) {
    if (!known.includes(spec.destination)) {
      problems.push(
        `OATHRION_TOOLS: tool "${spec.id}" names destination "${spec.destination}", which is not ` +
          `registered. Known destinations: ${known.length ? known.join(", ") : "(none)"}. ` +
          `Declare it in OATHRION_DESTINATIONS (or OATHRION_LOCAL_MCP_URL for a loopback fixture). ` +
          `Left as is, the verb would be authorized by policy and reach nothing.`,
      );
    }
    for (const action of spec.actions) {
      const descriptor = lookupAction(normalizeActionName(action));
      if (!descriptor) {
        problems.push(
          `OATHRION_TOOLS: tool "${spec.id}" claims action "${action}", which is not declared in ` +
            `shared/policy/actions.ts. Declare it there — with its required permission scope and ` +
            `whether it is financial or outbound — so the policy, mandate and permission layers ` +
            `apply to it. A connector may not introduce a verb that bypasses them.`,
        );
      } else if (!descriptor.requiredScope) {
        problems.push(
          `OATHRION_TOOLS: tool "${spec.id}" claims action "${action}", which declares no required ` +
            `permission scope in shared/policy/actions.ts. A dispatchable action with no scope is ` +
            `reachable by every agent.`,
        );
      }
    }
  }
  return problems;
}
