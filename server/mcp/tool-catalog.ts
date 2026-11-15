/**
 * MCP tool catalog — what `tools/list` is allowed to tell a given agent.
 *
 * WHY TOOLS ARE NAMED AFTER THE ACTION VERB, NOT THE TOOL ID
 * ----------------------------------------------------------
 * `access`, `query` and `write` all resolve to `database_tool`. Advertising the
 * tool id would present one capability where Oathrion governs three: the catalog
 * assigns `write` a different risk and a different required scope from `query`,
 * and a policy can hold one and allow the other. Naming the MCP tool after the
 * verb keeps the unit the model calls identical to the unit Oathrion reasons about,
 * so there is no translation step in which a distinction can be lost.
 *
 * WHAT A LISTING DOES AND DOES NOT PROMISE
 * ----------------------------------------
 * Appearing in `tools/list` means only: this verb is wired to a tool, and this
 * agent clears the permission barrier for it. It is NOT a prediction that the
 * call will succeed. `refund` is listed for an agent holding `execute:payments`
 * even though a €750 refund will be held for approval and a €5,000 one refused
 * by the mandate — because the amount is not known at listing time.
 *
 * The alternative — trying to pre-compute outcomes and hide anything that would
 * be denied — was rejected. It would require evaluating policies against
 * arguments that do not exist yet, and would leave the model unable to discover
 * that a capability exists but is bounded. Hiding a bounded capability makes the
 * boundary undiscoverable; listing it and refusing at call time teaches it.
 */

import { argumentSchema, argumentsFor } from "./action-arguments";
import type { ToolRegistry } from "../gateway/tool-registry";
import { wrappedCard } from "../gateway/wrapped-catalog";
import { clearsPermissionBarrier } from "@shared/agent-scopes";
import { lookupAction } from "@shared/policy/actions";
import type { Agent } from "@shared/types";

/**
 * Vendor `_meta` prefix.
 *
 * The spec reserves any prefix whose second label is `modelcontextprotocol` or
 * `mcp`, and asks vendors to use reverse-DNS notation. `dev.placet/` satisfies
 * both: second label `placet`, so it is ours to define.
 */
export const OATHRION_META_KEY = "dev.placet/governance";

/** JSON Schema fragment, as narrow as the MCP `inputSchema` field needs. */
interface JsonSchema {
  $schema: string;
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** What Oathrion adds to a tool listing beyond the protocol's own fields. */
export interface OathrionToolGovernance {
  /** The tool that would actually run. Useful when reading an audit trail. */
  toolId: string;
  requiredScope: string | null;
  risk: string;
  financial: boolean;
  /**
   * Whether a run of this tool would stay inside Oathrion, stated per tool so it
   * cannot be missed.
   *
   * This field was typed `true` — a LITERAL type, not a boolean — so the type
   * system itself encoded the claim that every tool is always simulated. It stopped
   * being true the moment one of them could dispatch to a configured MCP downstream,
   * and the compiler then refused the honest value. Widened to `boolean`, and read
   * from `Tool.simulated`, which is the single source.
   */
  simulated: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  /** Le schéma d'Oathrion, ou — pour un serveur enveloppé — celui que l'enfant a déclaré. */
  inputSchema: JsonSchema | Record<string, unknown>;
  /**
   * Vendor metadata, which a client is free to ignore and still see a valid
   * tool. Present because a governed tool that cannot tell the model what
   * governs it forces the model to discover its limits by tripping them.
   */
  _meta: Record<string, OathrionToolGovernance>;
}

/**
 * The argument schema for one verb.
 *
 * `additionalProperties: false` is deliberate. An open schema invites a model to
 * invent fields, and an invented field that looks meaningful — `approved: true`,
 * `override: "admin"` — would be carried into `metadata` and land in the audit
 * trail as though the agent had asserted something. Everything Oathrion reads from
 * metadata is declared here explicitly.
 */
function schemaFor(action: string): JsonSchema {
  const descriptor = lookupAction(action);
  const properties: Record<string, unknown> = {
    target: {
      type: "string",
      minLength: 1,
      description:
        "What the action acts on: a customer reference, a hostname, a table. Policies match on this.",
    },
    reason: {
      type: "string",
      description: "Why the agent is taking this action. Recorded in the audit trail.",
    },
  };

  /* Les verbes de connecteur disent ce que `target` doit contenir, et ce qu'ils lisent. */
  const declared = argumentsFor(action);
  const required = ["target"];
  if (declared) {
    properties.target = { type: "string", minLength: 1, description: declared.target };
    for (const [name, spec] of Object.entries(declared.args)) {
      properties[name] = argumentSchema(spec);
      if (spec.required) required.push(name);
    }
  }

  if (descriptor?.financial) {
    properties.amount = {
      type: "number",
      description:
        "Amount to move, in `currency`. Compared against organisation policy thresholds and the agent's mandate ceiling.",
    };
    properties.currency = {
      type: "string",
      description: 'ISO 4217 code, e.g. "EUR". Must match the currency the mandate is denominated in.',
    };
    properties.category = {
      type: "string",
      description: "Spend category. Checked against the mandate's allowed and blocked category lists.",
    };
  }

  return {
    // The revision lifts `inputSchema` to full JSON Schema 2020-12 and defaults
    // to it when `$schema` is absent. Stated explicitly rather than relying on
    // the default, so the dialect is unambiguous to a strict validator.
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    // `target` only. `amount` is NOT required here even for a financial verb:
    // omitting it is a policy question, not a schema question, and the engine
    // must be the thing that decides what an unspecified amount means.
    required,
    additionalProperties: false,
  };
}

/** Le schéma déclaré par l'enfant s'il est un objet JSON Schema, sinon un objet ouvert. */
function wrappedSchema(schema: unknown): Record<string, unknown> {
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema) && (schema as { type?: unknown }).type === "object") {
    return schema as Record<string, unknown>;
  }
  return { type: "object" };
}

function describe(action: string, toolName: string, simulated: boolean): string {
  const descriptor = lookupAction(action);
  const parts = [descriptor?.description ?? action];
  /*
   * Lu sur l'outil, jamais écrit en dur. La phrase était littérale — « SIMULATED — no
   * real side effect » — pour TOUS les outils, y compris un connecteur réellement
   * branché : un modèle lisait qu'un message Slack ne partirait pas, puis il partait.
   */
  parts.push(
    simulated
      ? `Executed by "${toolName}" (SIMULATED — no real side effect).`
      : `Executed by "${toolName}" — a REAL call to the connected service.`,
  );
  parts.push(
    "Every call is authorised by Oathrion before it runs and may be allowed, held for human approval, or blocked.",
  );
  if (descriptor?.financial) {
    parts.push("Subject to organisation spending policy and to this agent's mandate ceiling.");
  }
  return parts.join(" ");
}

/**
 * The tools this agent may be told about.
 *
 * Two filters, both of which must pass:
 *
 *  1. the verb is wired to a tool in the registry — an unwired verb cannot
 *     reach a side effect, so advertising it would promise a capability that
 *     silently does nothing (`runState: "skipped"`);
 *  2. the agent clears the engine's permission barrier for the verb, evaluated
 *     with the same shared helper the engine uses, so a listing can never
 *     disagree with the decision that follows.
 *
 * The agent itself is loaded from the caller's tenant-scoped repository by the
 * router, which is what makes this listing tenant-safe: there is no tenant
 * parameter here to get wrong.
 */
/** Un outil d'un serveur enveloppé que l'agent ne voit pas : il lui manque une permission. */
export interface WithheldTool {
  /** Le nom chez le serveur enveloppé, tel que le client le connaît. */
  readonly name: string;
  readonly verb: string;
  readonly server: string;
  readonly toolClass: "read" | "write" | "destructive";
  /** La portée qui manque à l'agent. */
  readonly scope: string | null;
}

/**
 * Les outils enveloppés RETENUS pour cet agent : inscrits, mais derrière une portée qu'il n'a
 * pas (une destruction, tant que `mcp:destructive` n'est pas accordée). Ils ne sont pas
 * annoncés — c'est la barrière —, mais les taire tout à fait laissait l'agent inventer une
 * raison (« pas branché côté Oathrion ») et la personne chercher l'interrupteur
 * (STRESS-TEST-LOG §5.57). Leur NOM et leur RAISON se disent ; leur description et leur
 * schéma, non : un outil retenu n'est pas présenté au modèle.
 */
export function withheldWrappedTools(registry: ToolRegistry, agent: Agent): WithheldTool[] {
  return registry
    .actions()
    .filter((action) => !clearsPermissionBarrier(agent, action))
    .flatMap((action) => {
      const card = wrappedCard(action);
      if (!card) return [];
      return [{ name: card.original, verb: card.verb, server: card.server, toolClass: card.toolClass, scope: lookupAction(action)?.requiredScope ?? null }];
    });
}

export function toolsForAgent(registry: ToolRegistry, agent: Agent): McpTool[] {
  return registry
    .actions()
    .filter((action) => clearsPermissionBarrier(agent, action))
    /*
     * UN CONNECTEUR NON CONNECTÉ N'EST PAS ANNONCÉ.
     *
     * Ses actions étaient listées et décrites « SIMULATED » alors qu'un appel aurait
     * échoué (« non connecté ») : ni disponible, ni simulé. Un outil de connecteur n'est
     * listé que si son état est `connected` — la dernière vérification réelle a réussi.
     * Les outils intégrés simulés restent listés et se disent simulés. Ce filtre n'est
     * pas l'autorisation : `tools/call` repasse par la passerelle quoi qu'il arrive.
     */
    .filter((action) => {
      const tool = registry.resolve(action);
      return !(tool && tool.id.startsWith("connector_") && tool.simulated);
    })
    .map((action) => {
      const tool = registry.resolve(action);
      const descriptor = lookupAction(action);
      // Both are non-null for anything `registry.actions()` returns: the
      // registry constructor throws at boot otherwise. Asserted, not assumed.
      if (!tool || !descriptor) {
        throw new Error(`Action "${action}" is wired but has no tool or descriptor.`);
      }
      /*
       * Un outil d'un serveur ENVELOPPÉ s'annonce avec SA description et SON schéma : le
       * modèle doit savoir l'appeler comme il appelait le serveur directement. Le schéma est
       * un indice pour le modèle, pas une barrière (voir `readWrappedArguments`), et la
       * description dit en une phrase qu'Oathrion décide de chaque appel.
       */
      const wrapped = wrappedCard(action);
      return {
        name: action,
        description: wrapped
          ? `${wrapped.description ?? wrapped.original} — Every call is authorised by Oathrion ` +
            `before it reaches the "${wrapped.server}" server, and may be allowed, held for human approval, or blocked.`
          : describe(action, tool.name, tool.simulated),
        inputSchema: wrapped ? wrappedSchema(wrapped.inputSchema) : schemaFor(action),
        _meta: {
          [OATHRION_META_KEY]: {
            toolId: tool.id,
            requiredScope: descriptor.requiredScope,
            risk: descriptor.risk,
            financial: descriptor.financial,
            // Derive, never assert. See `Tool.simulated` for why a literal here was wrong.
            simulated: tool.simulated,
            /*
             * Pour un serveur enveloppé : le nom de l'outil tel que l'enfant l'a déclaré, casse
             * comprise. Le verbe est normalisé en minuscules ; `oathrion wrap` présente au
             * client le nom d'origine, celui que ses invites et ses réglages connaissent.
             */
            ...(wrapped ? { wrappedServer: wrapped.server, originalName: wrapped.original, toolClass: wrapped.toolClass, ...(wrapped.readBasis ? { readBasis: wrapped.readBasis } : {}) } : {}),
          },
        },
      };
    })
    // Stable order, so a client diffing two listings sees real changes only.
    .sort((a, b) => a.name.localeCompare(b.name));
}
