/**
 * Un serveur MCP ENVELOPPÉ, devenu un outil gouverné — étape E2 de `oathrion wrap`
 * (`notes/CONCEPTION-OATHRION-WRAP.md`).
 *
 * ## Où il est le droit d'être
 *
 * C'est un `CountingTool` : la seule façon d'atteindre son `run()` est `execute()`, atteint
 * seulement par `AgentGateway.dispatch()`, après un ALLOW. Il est le seul module autorisé à
 * importer `stdio-mcp-child.ts` (`mcp-single-path.test.ts`). Il n'ajoute aucun chemin : il
 * ajoute une destination, un processus local lancé par l'utilisateur lui-même.
 *
 * ## Chaque outil de l'enfant devient un verbe, classé PRUDEMMENT
 *
 * `create_issue` chez le serveur `github` devient `mcp.github.create_issue`, enregistré dans
 * le catalogue (`registerMcpActions`) avec une portée qui dit sa classe :
 *
 *   · `mcp:read`        — lecture : l'annotation `readOnlyHint` ET un nom de lecture ;
 *   · `mcp:write`       — tout le reste, par défaut ;
 *   · `mcp:destructive` — `destructiveHint`, ou un nom qui annonce une destruction ou de
 *                         l'argent (`DANGEROUS_ACTION_PATTERN`, le même que le moteur).
 *
 * Les annotations viennent du serveur : un serveur peut se dire « lecture seule » et
 * écrire. D'où la double condition pour la lecture, et la destruction qui l'emporte sur
 * tout : une erreur de classement doit produire une approbation de trop, jamais une
 * écriture silencieuse. Un agent sans la portée `mcp:destructive` ne voit pas ces outils
 * et ne peut pas les appeler — la barrière de permission du moteur, pas une règle de plus.
 *
 * ## Ce qu'il rend
 *
 * Le résultat MCP de l'enfant, tel quel, sous `data.result` : l'agent doit recevoir ce
 * que le serveur a répondu. Et `dispatched`, la question du reçu honnête : `false` si
 * rien n'est parti, `true` si l'enfant a répondu, `"unknown"` si la requête est partie
 * sans réponse — ce dernier état interdit la relance (`retryability.ts`).
 */

import {
  DANGEROUS_ACTION_PATTERN,
  MCP_VERB_PREFIX,
  normalizeActionName,
  registerMcpActions,
  unregisterMcpActions,
  type ActionDescriptor,
  type McpScope,
} from "@shared/policy/actions";

import { STDIO_TOOL_ID_PREFIX, publishWrappedCards, withdrawWrappedCards } from "../wrapped-catalog";
import { downstreamTimeoutMs } from "./downstream-timeout";
import { StdioCallError, StdioMcpChild, type ChildTool } from "./stdio-mcp-child";
import { CountingTool, type Tool, type ToolContext, type ToolResult } from "./types";

export type McpToolClass = "read" | "write" | "destructive";

export { STDIO_TOOL_ID_PREFIX };
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Les premiers mots d'un nom d'outil qui annoncent une lecture. */
const READ_STEMS = new Set([
  "get", "list", "search", "read", "fetch", "query", "find", "describe", "show", "view", "lookup", "count", "check",
]);
/**
 * Destructions, argent et exécution que `DANGEROUS_ACTION_PATTERN` ne couvre pas. `pay` en
 * est la preuve : le motif du moteur connaît `payment` et `payout`, pas `pay_invoice` —
 * trouvé par le premier passage du test de classement.
 */
const DESTRUCTIVE_STEMS = new Set([
  "remove", "rm", "unlink", "rmdir", "kill", "terminate", "reset", "overwrite", "force",
  "pay", "pays", "paid", "command", "cmd", "eval",
]);

function segments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Les mots qui annoncent une ÉCRITURE. Un nom qui en contient un n'est jamais une lecture,
 * même annoncée comme telle : c'est la garde contre un serveur qui se dirait « lecture seule »
 * pour passer sans approbation.
 *
 * Deux listes, parce que beaucoup de mots sont tantôt verbe, tantôt nom. Le premier essai
 * réel l'a montré : `get_pull_request_status` contient `request`, et une liste unique l'aurait
 * classé écriture. Les verbes sans ambiguïté comptent où qu'ils soient ; les mots ambigus ne
 * comptent qu'en TÊTE du nom (`comment_on_issue` écrit, `get_comment` lit).
 */
const WRITE_VERBS = new Set([
  "create", "write", "update", "edit", "put", "push", "merge", "move", "rename", "insert", "upload", "send",
  "patch", "fork", "submit", "apply", "replace", "append", "mutate", "modify", "upsert", "dispatch", "trigger",
  "transfer", "restore", "approve", "assign", "unassign", "invite", "reopen", "add",
]);
const WRITE_VERBS_IN_FIRST_PLACE = new Set([
  "set", "post", "comment", "label", "tag", "star", "unstar", "pin", "unpin", "lock", "unlock", "archive",
  "unarchive", "commit", "request", "follow", "unfollow", "react", "attach", "detach", "mark", "copy", "store",
  "change", "reply", "close", "enable", "start", "stop", "run", "save", "import", "sync", "schedule", "cancel",
  "subscribe", "unsubscribe",
]);

/** Pourquoi un outil est classé « lecture ». */
export type ReadBasis = "annotation" | "name";

export interface ToolClassification {
  toolClass: McpToolClass;
  /** Pour une lecture : sur l'annotation du serveur, ou sur son seul nom. */
  readBasis?: ReadBasis;
}

/**
 * La classe d'un outil — réglée le 28 octobre 2026 sur trois vrais serveurs
 * (`STRESS-TEST-LOG` §5.48), avec l'accord de l'utilisateur :
 *
 *   · DESTRUCTION : `destructiveHint`, ou un nom qui parle de supprimer, payer, exécuter ;
 *   · ÉCRITURE    : un nom qui contient un mot d'écriture, quoi que dise l'annotation ; ou
 *                   `readOnlyHint: false` explicite ;
 *   · LECTURE     : `readOnlyHint: true` (le nom n'a plus besoin de commencer par `get` :
 *                   `directory_tree`, `open_nodes` étaient refusés à tort) ; ou, SANS
 *                   annotation, un nom qui commence par un mot de lecture (`get_issue`,
 *                   `list_commits`) — le serveur GitHub n'annote aucun outil, et toutes ses
 *                   lectures demandaient une approbation. Une lecture « sur son seul nom » est
 *                   dite comme telle au démarrage.
 *   · sinon, ÉCRITURE.
 *
 * Ce qui ne bouge pas : un mot de destruction ou d'écriture dans le nom l'emporte toujours, et
 * un outil inconnu reste une écriture, sous approbation.
 */
export function classifyTool(tool: Pick<ChildTool, "name" | "annotations">): ToolClassification {
  const words = segments(tool.name);
  const annotations = tool.annotations ?? {};
  if (
    annotations.destructiveHint === true ||
    words.some((word) => DESTRUCTIVE_STEMS.has(word) || DANGEROUS_ACTION_PATTERN.test(word))
  ) {
    return { toolClass: "destructive" };
  }
  if (words.some((word) => WRITE_VERBS.has(word)) || WRITE_VERBS_IN_FIRST_PLACE.has(words[0] ?? "")) {
    return { toolClass: "write" };
  }
  if (annotations.readOnlyHint === true) return { toolClass: "read", readBasis: "annotation" };
  if (annotations.readOnlyHint === undefined && words.length > 0 && READ_STEMS.has(words[0]!)) {
    return { toolClass: "read", readBasis: "name" };
  }
  return { toolClass: "write" };
}

/** La classe seule. */
export function classifyChildTool(tool: Pick<ChildTool, "name" | "annotations">): McpToolClass {
  return classifyTool(tool).toolClass;
}

const SCOPE: Record<McpToolClass, McpScope> = { read: "mcp:read", write: "mcp:write", destructive: "mcp:destructive" };
const RISK: Record<McpToolClass, ActionDescriptor["risk"]> = { read: "LOW", write: "MEDIUM", destructive: "HIGH" };

/** `create-Issue` → `create-issue` ; tout caractère hors du motif devient `_`. */
function verbPart(toolName: string): string {
  const cleaned = toolName.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").replace(/^[^a-z0-9]+/, "");
  return cleaned.slice(0, 128);
}

export class WrappedServerError extends Error {}

/**
 * Les arguments, tels que la passerelle les présente.
 *
 * Deux formes, et c'est un piège trouvé par le test de bout en bout : à l'appel direct,
 * `metadata.arguments` est l'objet envoyé par l'agent ; après une APPROBATION, la passerelle
 * relit l'exécution enregistrée, où le service de décision a sérialisé toute valeur non
 * scalaire en texte JSON (`decision-service.ts`). Lire seulement l'objet faisait partir un
 * `create_note` approuvé avec `{}` — l'action approuvée n'était pas celle qui partait.
 * Illisible veut dire `null`, donc un refus, jamais un appel avec des arguments vides.
 */
function readArguments(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined) return {};
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Ce que l'enfant a déclaré, une fois classé et nommé. */
export interface WrappedToolEntry {
  verb: string;
  original: string;
  toolClass: McpToolClass;
  readBasis?: ReadBasis;
  description?: string;
  inputSchema?: unknown;
}

export class StdioMcpTool extends CountingTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  private readonly byVerb = new Map<string, WrappedToolEntry>();

  constructor(
    readonly server: string,
    private readonly child: StdioMcpChild,
    tools: readonly ChildTool[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    super();
    if (!SERVER_NAME.test(server)) {
      throw new WrappedServerError(`Server name refused: "${server}" (lowercase letters, digits, - and _).`);
    }
    this.id = `${STDIO_TOOL_ID_PREFIX}${server}`;
    this.name = `MCP ${server}`;
    this.description = `The MCP server "${server}", started locally by oathrion wrap.`;

    for (const tool of tools) {
      const part = verbPart(tool.name);
      if (part === "") throw new WrappedServerError(`Tool with an unusable name: "${tool.name}".`);
      const verb = `${MCP_VERB_PREFIX}${server}.${part}`;
      if (this.byVerb.has(verb)) {
        throw new WrappedServerError(
          `Two tools of "${server}" give the same verb ${verb} ("${this.byVerb.get(verb)!.original}" and ` +
            `"${tool.name}"): they cannot be told apart in a rule.`,
        );
      }
      const classification = classifyTool(tool);
      this.byVerb.set(verb, {
        verb,
        original: tool.name,
        toolClass: classification.toolClass,
        ...(classification.readBasis ? { readBasis: classification.readBasis } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  /** Un outil réel : une exécution sort d'Oathrion vers le processus enfant. */
  override get simulated(): boolean {
    return false;
  }

  /** Le serveur MCP enfant tourne-t-il encore ? */
  get reachable(): boolean {
    return this.child.running;
  }

  /** Un appel est-il en cours chez l'enfant ? */
  get busy(): boolean {
    return this.child.busy;
  }

  /** Arrête le processus enfant. */
  async shutdown(): Promise<void> {
    await this.child.stop();
  }

  /** Le serveur que l'enfant dit être, et la révision du protocole acceptée. */
  get childInfo(): { name?: string; version?: string; protocolVersion: string | null } {
    return { ...(this.child.serverInfo ?? {}), protocolVersion: this.child.protocolVersion };
  }

  entries(): WrappedToolEntry[] {
    return [...this.byVerb.values()];
  }

  entryFor(action: string): WrappedToolEntry | undefined {
    return this.byVerb.get(normalizeActionName(action));
  }

  /** Les descripteurs du catalogue, un par outil de l'enfant. */
  descriptors(): ActionDescriptor[] {
    return this.entries().map((entry) => ({
      action: entry.verb,
      requiredScope: SCOPE[entry.toolClass],
      financial: false,
      outbound: false,
      risk: RISK[entry.toolClass],
      description: `${entry.original} (MCP server "${this.server}", classed ${entry.toolClass})` +
        (entry.description ? ` — ${entry.description.slice(0, 200)}` : ""),
    }));
  }

  /** `{ verbe: identifiant d'outil }`, pour la table de routage du registre. */
  actionMap(): Record<string, string> {
    return Object.fromEntries(this.entries().map((entry) => [entry.verb, this.id]));
  }

  protected async run(context: ToolContext): Promise<ToolResult> {
    const entry = this.entryFor(context.action);
    if (!entry) {
      return {
        ok: false,
        summary: `The "${this.server}" server does not declare the tool for ${context.action}: nothing was sent.`,
        data: { mode: "STDIO_MCP", server: this.server, dispatched: false, reason: "unknown_tool" },
      };
    }
    const args = readArguments(context.metadata.arguments);
    if (args === null) {
      return {
        ok: false,
        summary: `The arguments of "${entry.original}" are unreadable: nothing was sent to the ${this.server} server.`,
        data: { mode: "STDIO_MCP", server: this.server, tool: entry.original, dispatched: false, reason: "unreadable_arguments" },
      };
    }
    try {
      const { result, isError } = await this.child.callTool(entry.original, args, downstreamTimeoutMs(this.env));
      return {
        ok: !isError,
        summary: isError
          ? `"${entry.original}" answered with an error (server ${this.server}).`
          : `"${entry.original}" executed by the ${this.server} server.`,
        data: { mode: "STDIO_MCP", server: this.server, tool: entry.original, dispatched: true, result },
      };
    } catch (error) {
      if (!(error instanceof StdioCallError)) throw error;
      const dispatched = !error.mayHaveReached ? false : error.kind === "rpc_error" ? true : "unknown";
      return {
        ok: false,
        summary: error.message,
        data: { mode: "STDIO_MCP", server: this.server, tool: entry.original, dispatched, reason: error.kind },
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Les serveurs enveloppés de ce processus                                    */
/* -------------------------------------------------------------------------- */

const WRAPPED = new Map<string, StdioMcpTool>();

/*
 * Le numéro de version de l'ensemble des serveurs enveloppés. Le pivot local inscrit et
 * retire des serveurs en cours de route (`server/local-hub.ts`) ; une portée de locataire
 * construite avant garderait l'ancienne liste. Elle compare ce numéro et se reconstruit.
 */
let generation = 0;

export function wrappedGeneration(): number {
  return generation;
}

/**
 * Inscrit un serveur enveloppé : ses verbes au catalogue, son outil au registre de chaque
 * espace construit ENSUITE. `oathrion wrap` l'appelle avant que le serveur n'accepte une
 * requête ; un espace déjà construit ne le verrait pas, et c'est voulu — un outil qui
 * apparaîtrait en cours de route changerait ce qu'une règle déjà écrite couvre.
 */
export function registerWrappedServer(tool: StdioMcpTool): void {
  if (WRAPPED.has(tool.server)) throw new WrappedServerError(`The "${tool.server}" server is already wrapped.`);
  registerMcpActions(tool.descriptors());
  publishWrappedCards(tool.entries().map((entry) => ({ ...entry, server: tool.server })));
  WRAPPED.set(tool.server, tool);
  generation += 1;
}

/** Retire un serveur enveloppé et ses verbes. */
export function unregisterWrappedServer(server: string): void {
  if (WRAPPED.delete(server)) generation += 1;
  withdrawWrappedCards(server);
  unregisterMcpActions(`${MCP_VERB_PREFIX}${server}.`);
}

/*
 * LES OUTILS LOCAUX qui ne sont pas des serveurs : le passage de relais du hook Claude Code
 * (`claude-handoff-tool.ts`). Mêmes verbes `mcp.<nom>.<outil>`, même portée obligatoire, même
 * numéro de génération : la passerelle les voit comme un serveur de plus.
 */
const LOCAL_TOOLS = new Map<string, { tool: Tool; actionMap: Record<string, string> }>();

/** Inscrit un outil local et ses verbes ; une seule fois par nom. */
export function registerLocalTool(name: string, tool: Tool, descriptors: Parameters<typeof registerMcpActions>[0]): void {
  if (LOCAL_TOOLS.has(name) || WRAPPED.has(name)) return;
  registerMcpActions(descriptors);
  LOCAL_TOOLS.set(name, { tool, actionMap: Object.fromEntries(descriptors.map((d) => [d.action, tool.id])) });
  generation += 1;
}

/** Les outils enveloppés (et locaux) et leur table de routage, à fusionner dans un registre. */
export function wrappedTools(): { tools: Tool[]; actionMap: Record<string, string> } {
  const tools = [...WRAPPED.values()];
  const locals = [...LOCAL_TOOLS.values()];
  return {
    tools: [...tools, ...locals.map((local) => local.tool)],
    actionMap: Object.assign({}, ...tools.map((tool) => tool.actionMap()), ...locals.map((local) => local.actionMap)) as Record<string, string>,
  };
}

/**
 * Lance un serveur MCP, lit ses outils, l'inscrit. C'est la seule façon d'obtenir un outil
 * enveloppé hors des tests : `stdio-mcp-child.ts` n'est importable que d'ici
 * (`mcp-single-path.test.ts`), donc le lancement vit à côté de l'outil qui l'enveloppe.
 *
 * L'environnement de l'enfant est celui que l'APPELANT donne, et rien d'autre : le mode
 * local le filtre (`local-bootstrap.ts`) pour que l'enfant ne voie ni la clé de l'agent, ni
 * le secret de session, ni aucune variable d'Oathrion.
 */
export async function launchWrappedServer(spec: {
  name: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Le dossier où lancer le serveur ; absent, celui du processus. */
  cwd?: string;
  timeoutMs: number;
  /**
   * Les outils à inscrire parmi ceux que l'enfant déclare. Le mode local y retire ceux dont
   * la définition n'a pas été acceptée (`server/local-pins.ts`) : un outil retiré n'a pas de
   * verbe, n'est pas annoncé, ne peut pas être appelé.
   */
  select?: (tools: ChildTool[]) => ChildTool[];
}): Promise<StdioMcpTool> {
  const child = new StdioMcpChild({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd, clientName: "oathrion-wrap" });
  await child.start(spec.timeoutMs);
  try {
    const declared = await child.listTools(spec.timeoutMs);
    const tool = new StdioMcpTool(spec.name, child, spec.select ? spec.select(declared) : declared);
    registerWrappedServer(tool);
    return tool;
  } catch (error) {
    await child.stop();
    throw error;
  }
}
