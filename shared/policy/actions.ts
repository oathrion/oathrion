/**
 * Central action catalog — the single source of truth for "what does this verb
 * do, and what protects it".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before it, four independent hand-written lists decided whether an agent action
 * was dangerous, and nothing kept them in sync:
 *
 *   1. `requiredPermissionForAction()` in `engine.ts` — the permission barrier.
 *      Covered 5 verbs: purchase, send_email, access, query, write.
 *   2. `SPENDING_ACTIONS` in `mandate.ts` — the mandate spending ceiling.
 *      Covered 4 verbs: purchase, payment, transfer, subscribe.
 *   3. `OUTBOUND_ACTIONS` in `mandate.ts` — the mandate domain allowlist.
 *      Covered 10 verbs.
 *   4. `createDefaultRegistry()`'s action→tool table in
 *      `server/gateway/tool-registry.ts` — whether the verb can reach a side
 *      effect at all.
 *
 * The overlap between (1) and (2) was partial and undocumented: `payment`,
 * `transfer` and `subscribe` were subject to the spending ceiling but required
 * NO permission, so an agent without `execute:payments` could obtain an ALLOW
 * verdict for `transfer`. Verbs that plainly move money — refund, payout,
 * withdraw, charge, reimburse — appeared in none of (1), (2) or (3), so the
 * engine's permissive default returned ALLOW for a €999,999,999 `refund`.
 *
 * That was not exploitable *today* only because list (4) happens not to wire a
 * tool to any of those verbs, so the Gateway marks the run "skipped". The
 * protection was real but incidental — it depended entirely on nobody ever
 * wiring a tool to an ungated verb. `server/test/action-evasion.test.ts` said as
 * much in its own header and pinned the behaviour rather than fixing it.
 *
 * This catalog collapses (1), (2) and (3) into one table and makes (4) validate
 * itself against it: `ToolRegistry` refuses to map a tool onto an action that is
 * not declared here. Adding a `refund_tool` therefore *forces* the developer to
 * add a `refund` entry, and adding that entry forces them to state its required
 * scope and whether it is financial — at which point the permission barrier, the
 * spending ceiling and the domain allowlist all apply automatically.
 *
 * `shared/policy/dangerous-action-coverage.test.ts` asserts these invariants, so
 * the bypass cannot be reintroduced silently.
 *
 * Pure and synchronous, like the rest of `shared/policy`. No I/O, no framework.
 */

import type { EngineRiskLevel } from "./types";

/** One declared agent action and everything the control plane knows about it. */
export interface ActionDescriptor {
  /** The verb as it arrives on the wire, lowercase snake_case. */
  readonly action: string;
  /**
   * Permission scope the agent must hold. `null` means the verb is deliberately
   * un-gated; every such entry carries a `note` explaining why, and no financial
   * or tool-wired action is allowed to use `null` (enforced by tests).
   */
  readonly requiredScope: string | null;
  /** Moves money → subject to the mandate spending ceiling and daily budget. */
  readonly financial: boolean;
  /** Reaches a destination outside the org → subject to the domain allowlist. */
  readonly outbound: boolean;
  /** Inherent risk of the verb, before any policy or amount is considered. */
  readonly risk: EngineRiskLevel;
  /** Human-readable purpose, surfaced in docs and error messages. */
  readonly description: string;
  /** Required when `requiredScope` is null: why is this safe un-gated? */
  readonly note?: string;
}

/**
 * Every action the control plane recognises.
 *
 * Adding a verb here is the ONLY way to make it dispatchable, and doing so
 * forces an explicit decision about its scope, its financial nature and its
 * outbound nature. Keep it alphabetical within each group.
 */
export const ACTION_CATALOG: readonly ActionDescriptor[] = [
  /* ------------------------- Money movement ------------------------------ */
  {
    action: "charge",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "HIGH",
    description: "Charges a stored payment instrument.",
  },
  {
    action: "checkout",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "HIGH",
    description: "Completes a purchase flow at a vendor.",
  },
  {
    action: "payment",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "HIGH",
    description: "Settles an invoice or obligation.",
  },
  {
    action: "payout",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "CRITICAL",
    description: "Disburses funds to a third party.",
  },
  {
    action: "purchase",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "HIGH",
    description: "Places a purchase order with a supplier.",
  },
  {
    action: "refund",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "HIGH",
    description: "Returns funds to a customer.",
  },
  {
    action: "reimburse",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "HIGH",
    description: "Repays an expense claim.",
  },
  {
    action: "subscribe",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "MEDIUM",
    description: "Starts a recurring paid subscription.",
  },
  {
    action: "transfer",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "HIGH",
    description: "Moves funds between accounts.",
  },
  {
    action: "withdraw",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "CRITICAL",
    description: "Withdraws funds from an org account.",
  },

  /* --------------------------- Communication ----------------------------- */
  {
    action: "send_email",
    requiredScope: "send:email",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Sends outbound email on behalf of the org.",
  },
  {
    action: "send_message",
    requiredScope: "send:email",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Sends an outbound chat or SMS message.",
  },

  /* ---------------------------- Publication ------------------------------ */
  {
    action: "post",
    requiredScope: "publish:content",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Posts content to an external destination.",
  },
  {
    action: "publish",
    requiredScope: "publish:content",
    financial: false,
    outbound: true,
    risk: "HIGH",
    description: "Makes content publicly visible.",
  },
  {
    action: "upload",
    requiredScope: "write:files",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Uploads a file to an external destination.",
  },

  /* ------------------------------- Data ---------------------------------- */
  {
    action: "access",
    requiredScope: "read:database",
    financial: false,
    outbound: false,
    risk: "MEDIUM",
    description: "Opens a datastore for reading.",
  },
  {
    action: "delete",
    requiredScope: "write:database",
    financial: false,
    outbound: false,
    risk: "CRITICAL",
    description: "Removes rows or records irreversibly.",
  },
  {
    /*
     * Declared as its own verb rather than folded into `delete`.
     *
     * `delete_customer` was previously uncatalogued, so it fell to
     * `DANGEROUS_ACTION_PATTERN` and escalated to APPROVAL_REQUIRED. That is a
     * defensible fail-safe for a verb nobody has assessed, but it is the wrong
     * answer for this one: erasing a customer record is not work an agent should
     * ever be able to get a human to rubber-stamp in a queue, and an approval
     * queue is a weaker guarantee than a denial. Declaring it here moves the
     * decision out of a name heuristic and into `pol_customer_deletion`, a named
     * org policy an operator can read, audit and point at.
     *
     * Gated on `write:crm` rather than `write:database` because the record lives
     * in the CRM, and an agent granted analytics write access has no business
     * reaching it.
     */
    action: "delete_customer",
    requiredScope: "write:crm",
    financial: false,
    outbound: false,
    risk: "CRITICAL",
    description: "Erases a customer record and its history from the CRM.",
  },
  {
    action: "modify",
    requiredScope: "write:database",
    financial: false,
    outbound: false,
    risk: "HIGH",
    description: "Mutates existing rows or records.",
  },
  {
    action: "query",
    requiredScope: "read:database",
    financial: false,
    outbound: false,
    risk: "MEDIUM",
    description: "Runs a read query against a datastore.",
  },
  {
    action: "write",
    requiredScope: "write:database",
    financial: false,
    outbound: false,
    risk: "HIGH",
    description: "Writes rows to a datastore.",
  },

  /* ---------------------------- Operations ------------------------------- */
  {
    action: "deploy",
    requiredScope: "deploy:infrastructure",
    financial: false,
    outbound: true,
    risk: "CRITICAL",
    description: "Ships code or configuration to an environment.",
  },
  {
    action: "execute",
    requiredScope: "execute:code",
    financial: false,
    outbound: false,
    risk: "CRITICAL",
    description: "Runs arbitrary code or a shell command.",
  },

  /* ------------------------ Code hosting (GitHub) ------------------------ */
  /*
   * Les trois premiers verbes du dépôt servis par un CONNECTEUR RÉEL — un appel HTTPS
   * authentifié à api.github.com, et non un outil simulé. Ils sont nommés avec des
   * points (`github.issue.create`) là où les verbes historiques sont en snake_case :
   * c'est voulu. Un verbe de connecteur nomme un service ET une opération, et
   * `<service>.<objet>.<opération>` reste lisible quand le catalogue en comptera trente.
   * `normalizeActionName` ne fait que trim + lowercase, donc le point ne coûte rien.
   *
   * Pourquoi `write:repository` plutôt que `publish:content` : ouvrir une issue dans un
   * dépôt privé ne publie rien. Réutiliser une portée pour une opération qu'elle ne
   * décrit pas obligerait un exploitant à accorder « publier du contenu » pour
   * commenter une revue de code, et une portée que l'on accorde pour autre chose est une
   * portée qui ne protège plus.
   */
  {
    action: "github.repo.read",
    requiredScope: "read:repository",
    financial: false,
    outbound: true,
    risk: "LOW",
    description: "Reads repository metadata, issues or pull requests on GitHub.",
  },
  {
    action: "github.repos.list",
    requiredScope: "read:repository",
    financial: false,
    outbound: true,
    risk: "LOW",
    description: "Lists the GitHub repositories the connection can reach.",
  },
  {
    action: "github.issue.search",
    requiredScope: "read:repository",
    financial: false,
    outbound: true,
    risk: "LOW",
    description: "Lists or searches the issues and pull requests of one GitHub repository.",
  },
  {
    action: "github.issue.comment",
    requiredScope: "write:repository",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Posts a comment on a GitHub issue or pull request.",
  },
  {
    action: "github.issue.create",
    requiredScope: "write:repository",
    financial: false,
    outbound: true,
    /*
     * MEDIUM et non LOW. Ouvrir une issue est réversible, mais c'est visible par toute
     * personne ayant accès au dépôt et cela déclenche des notifications : un agent en
     * boucle ne détruit rien et fait pourtant du dégât.
     */
    risk: "MEDIUM",
    description: "Opens an issue on a GitHub repository.",
  },

  /*
   * Slack. La cible est `slack.com/<ID_DU_CANAL>` : l'hôte pour l'allowlist de domaine du
   * mandat, l'identifiant pour qu'une règle nomme un canal précis (un nom se renomme).
   */
  {
    action: "slack.channels.list",
    requiredScope: "read:chat",
    financial: false,
    outbound: true,
    risk: "LOW",
    description: "Lists the Slack channels the Oathrion bot has been invited to.",
  },
  {
    action: "slack.history.read",
    requiredScope: "read:chat",
    financial: false,
    outbound: true,
    /* MEDIUM : un canal contient des conversations entre personnes, pas des métadonnées. */
    risk: "MEDIUM",
    description: "Reads recent messages of one Slack channel.",
  },
  {
    action: "slack.message.post",
    requiredScope: "write:chat",
    financial: false,
    outbound: true,
    /* MEDIUM : visible par tout le canal et notifiant, mais supprimable. */
    risk: "MEDIUM",
    description: "Posts a message in one Slack channel.",
  },

  /*
   * Linear. La cible porte la clé d'équipe (`linear.app/ENG`, `linear.app/ENG/ENG-123`),
   * pour qu'une règle limite un agent à une équipe.
   */
  {
    action: "linear.teams.list",
    requiredScope: "read:tasks",
    financial: false,
    outbound: true,
    risk: "LOW",
    description: "Lists the Linear teams the connection can see.",
  },
  {
    action: "linear.issue.search",
    requiredScope: "read:tasks",
    financial: false,
    outbound: true,
    risk: "LOW",
    description: "Searches and reads the issues of one Linear team.",
  },
  {
    action: "linear.issue.create",
    requiredScope: "write:tasks",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Creates an issue in one Linear team.",
  },
  {
    action: "linear.comment.create",
    requiredScope: "write:tasks",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Comments on one Linear issue.",
  },

  /*
   * Stripe. La cible porte le compte (`stripe.com/acct_…`, et pour un remboursement
   * `stripe.com/acct_…/pi_…`), pour qu'une règle limite un agent à un compte.
   *
   * Le remboursement est le SEUL verbe de connecteur déclaré financier : le plafond de
   * dépense du mandat et les règles de montant s'y appliquent, sur le montant déclaré.
   * Les lectures exposent des données de clients (montants, adresses) : MEDIUM, pas LOW.
   */
  {
    action: "stripe.balance.read",
    requiredScope: "read:payments",
    financial: false,
    outbound: true,
    risk: "LOW",
    description: "Reads the balance of one Stripe account.",
  },
  {
    action: "stripe.customers.search",
    requiredScope: "read:payments",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Lists or searches the customers of one Stripe account.",
  },
  {
    action: "stripe.payments.list",
    requiredScope: "read:payments",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Lists the recent payments of one Stripe account.",
  },
  {
    action: "stripe.refund.create",
    requiredScope: "execute:payments",
    financial: true,
    outbound: true,
    risk: "HIGH",
    description: "Refunds one Stripe payment, in full or in part.",
  },

  /*
   * L'APPEL D'API GOUVERNÉ PAR LE PARE-FEU.
   *
   * Ajouté parce que le pare-feu n'avait aucun verbe utilisable pour ce qu'il fait le
   * plus naturellement : relayer un appel vers une API tierce — une API de modèle, en
   * particulier, qui est le cas d'usage le plus proche d'un produit qui gouverne des
   * agents IA.
   *
   * `call_api`, juste en dessous, ne pouvait pas servir : il est délibérément SANS
   * portée, et le registre d'outils refuse de câbler un verbe sans portée — « a
   * dispatchable action with no scope is reachable by every agent ». Une règle
   * d'interception qui le nommait faisait donc échouer la CONSTRUCTION de la portée du
   * locataire, c'est-à-dire un 500 sur toutes les routes, pas seulement sur le proxy.
   *
   * Et il ne devait pas être re-gaté : sa déclaration dit pourquoi — tous les agents
   * livrés l'emploient pour des lectures, et lui donner une portée la retirerait d'un
   * coup à tout le monde. Un verbe NOUVEAU ne retire rien à personne, puisque personne
   * ne l'utilise encore.
   *
   * `call:external-api` existait déjà dans `PermissionScope` sans qu'aucune action ne
   * l'exige : la portée était déclarable et inexigible.
   *
   * Risque MEDIUM, et c'est un plancher assumé : ce verbe ne dit pas ce que fait le
   * point d'entrée. Ce qui le borne est ailleurs — le chemin exact de la règle, la liste
   * de domaines du mandat, et les plafonds de la politique.
   */
  {
    action: "api.request",
    requiredScope: "call:external-api",
    financial: false,
    outbound: true,
    risk: "MEDIUM",
    description: "Relays an HTTP request to a third-party API through the governance proxy.",
  },

  /* ------------------------- Deliberately un-gated ----------------------- */
  {
    action: "call_api",
    requiredScope: null,
    financial: false,
    outbound: true,
    risk: "LOW",
    description: "Calls a third-party HTTP endpoint.",
    // Left un-gated to preserve existing behaviour: `call_api` is the generic
    // escape hatch agents use for read-only third-party lookups, it is wired to
    // no tool, and `pol_api_spend` already governs its cost. It IS declared
    // outbound, so a mandate domain allowlist still constrains where it may
    // reach. Gating it would require re-granting a scope to every seeded agent
    // for no gain in real enforcement.
    note: "No tool is wired to this verb; cost is governed by pol_api_spend and destination by the mandate domain allowlist.",
  },
];

/** Index for O(1) lookup, built once at module load. */
const BY_ACTION = new Map<string, ActionDescriptor>(
  ACTION_CATALOG.map((entry) => [entry.action, entry]),
);

/** The descriptor for a verb, or `undefined` when it is not catalogued. */
export function lookupAction(action: string): ActionDescriptor | undefined {
  const normalized = normalizeActionName(action);
  return BY_ACTION.get(normalized) ?? MCP_ACTIONS.get(normalized);
}

/* -------------------------------------------------------------------------- */
/* Les verbes des serveurs MCP enveloppés (`oathrion wrap`)                    */
/* -------------------------------------------------------------------------- */

/**
 * Le préfixe réservé aux verbes déclarés au démarrage par `oathrion wrap`.
 *
 * ## Pourquoi une exception au catalogue figé
 *
 * Le catalogue ci-dessus est écrit à la main, et c'est sa force : chaque verbe y dit sa
 * portée, son caractère financier et son risque. Mais un serveur MCP enveloppé
 * (`notes/CONCEPTION-OATHRION-WRAP.md`) annonce ses propres outils, inconnus à la
 * compilation. Les refuser rendrait `oathrion wrap` inutile ; les laisser hors catalogue
 * les ferait passer par la posture des verbes non déclarés, sans portée, donc sans
 * barrière de permission.
 *
 * La réponse est une famille étroite, enregistrée au démarrage et tenue aux MÊMES
 * exigences qu'une entrée écrite à la main :
 *
 *   · un nom en `mcp.<serveur>.<outil>`, qui ne peut donc jamais masquer un verbe statique ;
 *   · une portée parmi trois (`MCP_SCOPES`), jamais `null` : un verbe câblé sans portée
 *     serait atteignable par tout agent, ce que `ToolRegistry` refuse aussi ;
 *   · jamais financier : un outil dont le nom parle d'argent est classé destructeur par
 *     `stdio-mcp-tool.ts`, donc bloqué par la portée, plutôt que de prétendre qu'un
 *     plafond de mandat saurait lire ses arguments ;
 *   · jamais deux fois : un second enregistrement du même verbe est refusé, pas fusionné.
 *
 * Ce registre vit dans le processus, pas par locataire : `oathrion wrap` est un mode local
 * à un seul espace. Le dire ici évite qu'on le croie cloisonné.
 */
export const MCP_VERB_PREFIX = "mcp.";
export const MCP_SCOPES = ["mcp:read", "mcp:write", "mcp:destructive"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

const MCP_VERB_PATTERN = /^mcp\.[a-z0-9][a-z0-9_-]{0,62}\.[a-z0-9][a-z0-9_.-]{0,127}$/;
const MCP_ACTIONS = new Map<string, ActionDescriptor>();

export class McpActionError extends Error {}

/** Enregistre les verbes d'un serveur enveloppé. Tout ou rien : un refus n'en garde aucun. */
export function registerMcpActions(descriptors: readonly ActionDescriptor[]): void {
  const batch = new Map<string, ActionDescriptor>();
  for (const descriptor of descriptors) {
    const action = normalizeActionName(descriptor.action);
    if (!MCP_VERB_PATTERN.test(action)) {
      throw new McpActionError(`MCP verb refused: "${descriptor.action}" must be written mcp.<server>.<tool>.`);
    }
    if (BY_ACTION.has(action)) {
      throw new McpActionError(`MCP verb refused: "${action}" would shadow a catalogue verb.`);
    }
    if (MCP_ACTIONS.has(action) || batch.has(action)) {
      throw new McpActionError(`MCP verb refused: "${action}" is already registered.`);
    }
    if (!(MCP_SCOPES as readonly string[]).includes(descriptor.requiredScope ?? "")) {
      throw new McpActionError(`MCP verb refused: "${action}" must carry a scope ${MCP_SCOPES.join(", ")}.`);
    }
    if (descriptor.financial) {
      throw new McpActionError(`MCP verb refused: "${action}" cannot be financial.`);
    }
    batch.set(action, { ...descriptor, action });
  }
  for (const [action, descriptor] of batch) MCP_ACTIONS.set(action, descriptor);
}

/** Retire les verbes d'un serveur enveloppé (arrêt, ou nouvelle liste d'outils). */
export function unregisterMcpActions(prefix: string): void {
  const normalized = normalizeActionName(prefix);
  if (!normalized.startsWith(MCP_VERB_PREFIX)) return;
  for (const action of [...MCP_ACTIONS.keys()]) if (action.startsWith(normalized)) MCP_ACTIONS.delete(action);
}

/** Vrai pour un verbe de la famille `mcp.`, enregistré ou non. */
export function isMcpVerb(action: string): boolean {
  return normalizeActionName(action).startsWith(MCP_VERB_PREFIX);
}

/** Lowercases and trims a verb so `" Purchase "` resolves like `purchase`. */
export function normalizeActionName(action: string): string {
  return action.trim().toLowerCase();
}

/**
 * Actions that move money, derived from the catalog.
 * Replaces the hand-written `SPENDING_ACTIONS` array in `mandate.ts`.
 */
export const SPENDING_ACTIONS: readonly string[] = ACTION_CATALOG.filter(
  (entry) => entry.financial,
).map((entry) => entry.action);

/**
 * Actions that reach a destination, derived from the catalog.
 * Replaces the hand-written `OUTBOUND_ACTIONS` array in `mandate.ts`.
 */
export const OUTBOUND_ACTIONS: readonly string[] = ACTION_CATALOG.filter(
  (entry) => entry.outbound,
).map((entry) => entry.action);

/**
 * Stems that mark an UNCATALOGUED verb as dangerous.
 *
 * The engine's documented default posture is permissive: a verb no policy
 * mentions is ALLOWed, which is what lets a team onboard agents incrementally.
 * That default is appropriate for `summarise`; it is indefensible for
 * `bulk_payout_v2`. A verb that is not in the catalog is by definition one
 * nobody has risk-assessed, so when its own name advertises a destructive or
 * monetary effect the engine escalates to a human instead of waving it through.
 *
 * Matched per name-segment and anchored, so `permit` does not match `remit` and
 * `display` does not match `pay`. Case-insensitive, and camelCase is split, so
 * `bulkPayout` and `BULK_PAYOUT` are both caught.
 */
export const DANGEROUS_ACTION_PATTERN =
  /^(refunds?|payouts?|withdraw\w*|charges?|transfers?|reimburse\w*|payments?|purchase\w*|buy|buys|spend\w*|wire|wires|remit\w*|settle\w*|disburse\w*|delete\w*|destroy\w*|drops?|truncate\w*|purge\w*|erase\w*|wipe\w*|revoke\w*|grant\w*|escalate\w*|impersonate\w*|publish\w*|deploy\w*|release\w*|execs?|execute\w*|shell|sudo|bypass\w*|override\w*|disable\w*)$/i;

/** Splits a verb into lowercase alphanumeric segments, expanding camelCase. */
function actionSegments(action: string): string[] {
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when a verb's own name advertises a dangerous effect.
 *
 * Only consulted for verbs absent from the catalog — a catalogued verb's
 * descriptor is authoritative and this heuristic is never applied to it.
 */
export function isDangerousActionName(action: string): boolean {
  return actionSegments(action).some((segment) => DANGEROUS_ACTION_PATTERN.test(segment));
}

/** True when the catalog says this verb moves money. */
export function isFinancialAction(action: string): boolean {
  return lookupAction(action)?.financial ?? false;
}

/** True when the catalog says this verb reaches an external destination. */
export function isOutboundAction(action: string): boolean {
  return lookupAction(action)?.outbound ?? false;
}
