/**
 * Le relais de `oathrion wrap` : la face « serveur MCP » que voit le client (Cursor, Claude
 * Code…), en stdio, devant l'Oathrion local en HTTP.
 *
 * ## Ce qu'il fait
 *
 * Il transporte chaque message JSON-RPC du client vers `POST /api/mcp`, avec la clé de
 * l'agent, et rend la réponse. Il traduit les noms d'outils dans les deux sens : le client
 * voit `create_issue`, comme quand il parlait au serveur directement ; Oathrion reçoit
 * `mcp.github.create_issue`, le verbe sur lequel portent ses règles.
 *
 * ## Ce qu'il ne fait jamais
 *
 *   · Décider. Il n'a ni règle, ni liste d'outils permis : ce que le client voit est ce que
 *     Oathrion annonce, et un appel part TOUJOURS par Oathrion.
 *   · Passer outre une panne. Si l'Oathrion local ne répond pas, l'appel est refusé avec
 *     une erreur qui dit qu'il n'a PAS atteint le serveur MCP. Il n'existe aucun chemin du
 *     relais vers l'enfant : c'est Oathrion qui l'a lancé, pas le relais.
 *   · Écrire autre chose que des messages JSON-RPC sur sa sortie : la sortie standard EST le
 *     canal du client. Le journal va sur la sortie d'erreur.
 */

import { carriesDecoy, type Decoys } from "./decoys";
import { serverTokenReason } from "./guarded-tokens";

export interface RelayOptions {
  /** `http://127.0.0.1:<port>/api/mcp` */
  endpoint: string;
  /** La clé de l'agent, liée à lui. */
  key: string;
  serverName: string;
  /** Écrit une ligne sur la sortie standard (le canal du client). */
  write: (line: string) => void;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  /**
   * Combien de temps un appel retenu attend l'approbation avant de rendre « retenu ».
   * 0 : ne pas attendre. Voir `awaitApproval`.
   */
  approvalWaitMs?: number;
  /** Intervalle de relecture de l'approbation (les tests le raccourcissent). */
  pollMs?: number;
  /** Intervalle de relecture de la liste des outils, pour prévenir le client d'un changement (5 s). */
  watchMs?: number;
  /**
   * La clé d'approbation de l'espace local. Avec elle, et un client qui sait poser une question
   * à la personne (`elicitation`), l'approbation se fait DANS le client ; sans elle, seulement
   * dans la console.
   */
  approverKey?: string;
  /**
   * Le pivot local : la clé de l'agent DU CLIENT, demandée à `initialize`, quand le client a dit
   * son nom (« Cursor ») et s'il sait poser une question (`canAsk`). Avec elle, `key` peut être
   * vide au départ.
   */
  credentialsFor?: (clientName: string, canAsk: boolean) => Promise<Credentials>;
  /**
   * « Décider une fois », pour toujours : le pivot sort ce verbe d'écriture de l'approbation
   * (une règle visible dans la console). Absent : le choix « toujours » n'est pas proposé.
   */
  grantAlways?: (verb: string, origin: string) => Promise<{ ok: true; policyId: string } | { ok: false; message: string }>;
  /** Intervalle de relecture de la décision sur un programme en quarantaine (3 s). */
  quarantinePollMs?: number;
  /**
   * Les outils du serveur, sans clé : montrés à un programme en quarantaine, pour que son appel
   * ATTENDE la décision de la personne (comme une approbation) au lieu d'échouer.
   */
  previewTools?: () => Promise<{ name: string; description?: string; inputSchema?: unknown }[]>;
  /** Les leurres posés (`oathrion decoys`), relus à chaque appel : un outil appelé avec l'un d'eux est refusé. */
  decoys?: () => Decoys | null;
  /** Le jeton d'un serveur protégé dans un texte (`guarded-tokens.ts`) : le serveur, ou `null`. */
  guardedToken?: (text: string) => { server: string; from: string } | null;
}

type Id = string | number | null;
interface RpcMessage {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

const META_KEY = "dev.placet/governance";
/** Les révisions que la passerelle accepte en mode compatibilité. */
const COMPAT_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);
/* La version proposée quand le relais répond lui-même à `initialize` (programme en quarantaine). */
const PROTOCOL_FALLBACK = "2025-06-18";

/*
 * Sous le délai des clients MCP. Le 28 octobre 2026, Cursor abandonnait un appel au bout
 * d'environ 60 s quand le relais attendait encore 120 s : l'agent ne recevait jamais la
 * réponse, et réessayait (STRESS-TEST-LOG §5.50).
 */
export const DEFAULT_APPROVAL_WAIT_MS = 50_000;

/**
 * L'outil d'information que le relais ajoute quand des outils sont RETENUS (une permission
 * manque). Il n'exécute rien : le relais y répond lui-même. Sa description nomme les outils
 * retenus et dit pourquoi — un modèle qui cherche `write_file` la trouve, au lieu d'inventer
 * une raison (essai réel, STRESS-TEST-LOG §5.57).
 */
export const WITHHELD_TOOL = "oathrion_withheld_tools";

/** Une clé, ou la quarantaine du programme qui a lancé ce relais (`server/local-programs.ts`). */
export type Credentials = { key: string; approverKey?: string } | { quarantined: "pending" | "blocked"; program: string };

/* L'outil d'information d'un programme en quarantaine : le seul que l'agent voit. */
export const UNKNOWN_PROGRAM_TOOL = "oathrion_unknown_program";

/** Ce que l'agent lit tant que le programme n'est pas confirmé. */
export function quarantineExplanation(status: "pending" | "blocked", program: string): string {
  return status === "blocked"
    ? `Oathrion blocks this program: ${program}. A person blocked it in Oathrion's console, so nothing it asks goes through. Do not work around this.`
    : `Oathrion has not met this program yet: ${program}. Until a person confirms it in Oathrion's console (« oathrion console », Approvals), nothing it asks goes through — not even a read. Do not work around this: tell the person what you were about to do, and ask them to confirm this program. It goes on by itself once they do.`;
}

interface Withheld {
  name: string;
  toolClass: string;
}

/** Ce que l'agent doit savoir d'outils retenus : lesquels, pourquoi, et quoi faire. */
export function withheldExplanation(server: string, withheld: readonly Withheld[]): string {
  const names = withheld.map((tool) => tool.name).join(", ");
  const destructive = withheld.some((tool) => tool.toolClass === "destructive");
  return (
    `Oathrion is withholding ${String(withheld.length)} tool(s) of the "${server}" server: ${names}. ` +
    (destructive
      ? "They are classed destructive (they can delete, overwrite, pay or run something), and the person has not allowed them yet. "
      : "The person has not allowed them yet. ") +
    "They cannot be called until the person allows them in Oathrion's console; once allowed, each call will still wait for their approval. " +
    "Do not work around this with another tool: tell the person which tool you need and why."
  );
}

/** Un appel retenu dont l'agent n'a pas encore reçu l'issue. */
interface HeldCall {
  approvalId: string;
  executionId: string;
  governance: Record<string, unknown>;
  answer: RpcMessage;
}

/**
 * La question posée à la personne dans son client : l'outil, le serveur, et les arguments
 * tels qu'ils partiront, en clair. Bornée : un argument très long est coupé, la fin est dite.
 */
/*
 * LA CONSIGNE EN DEUXIÈME LIGNE (essai réel du 9 novembre). Claude Code n'affiche que les
 * premières lignes de la question (« … (+3 more lines) ») : la consigne, en fin de texte, était
 * cachée, et la personne ne savait ni cocher la case ni refermer une question déjà décidée.
 * Claude Code refuse aussi un « Entrée » trop rapide sur Accept (contre l'accord par mégarde).
 */
export const QUESTION_HOW_TO = "To approve here: Space ticks the box, ↓ to Accept, wait a second, Enter. Already decided in Oathrion's console: Esc.";

export function approvalQuestion(server: string, tool: string, args: unknown): string {
  const lines = [`Your agent wants to use "${tool}" (server "${server}").`, QUESTION_HOW_TO, ""];
  const entries = args !== null && typeof args === "object" && !Array.isArray(args) ? Object.entries(args as Record<string, unknown>) : [];
  for (const [key, value] of entries.slice(0, 12)) {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    lines.push(`  ${key}: ${text.length > 300 ? `${text.slice(0, 300)}… (${String(text.length)} characters)` : text}`);
  }
  if (entries.length > 12) lines.push(`  … and ${String(entries.length - 12)} more argument(s)`);
  if (entries.length === 0) lines.push("  (no arguments)");
  lines.push("", "Allow this action? Tick the box, then accept: it only runs with your approval, and your decision is written to Oathrion's log.");
  return lines.join("\n");
}

/** Combien attendre une clé neuve après un 401 : au-delà de deux battements (10 s chacun). */
export const KEY_RENEWAL_WAIT_MS = 25_000;

/** « Et pour la suite ? » — les choix de « décider une fois », tels que la personne les lit. */
export const CHOICE_ONCE = "Only this time";
export const CHOICE_SESSION = "This tool, without asking again until the client closes";
export const CHOICE_ALWAYS = "This tool, always (a rule, in the console)";

/** Le client sait-il poser une question sous forme de formulaire ? (2025-06-18 : `{}` ; 2025-11-25 : `{ form: {} }`.) */
function canElicitForm(capabilities: unknown): boolean {
  const elicitation = (capabilities as { elicitation?: unknown } | undefined)?.elicitation;
  if (elicitation === null || typeof elicitation !== "object") return false;
  const modes = Object.keys(elicitation);
  return modes.length === 0 || modes.includes("form");
}

/** Les instructions MCP du relais : comment Oathrion gouverne ce serveur, et quoi faire. */
export function governanceInstructions(server: string): string {
  return (
    `Oathrion governs the "${server}" server. Reads go through. Writes wait for the person's approval: ` +
    "when a call is held, tell the person what you asked for and why, and do not work around it with other arguments or another tool. " +
    "Calling again with the same arguments waits for the same approval and returns its result once decided. " +
    "Only the person approves: never approve your own request, never open the Oathrion console, run `oathrion console`, " +
    "read ~/.oathrion or call Oathrion's API to decide, and never call the service directly with a token found on this machine. " +
    `Some tools may be withheld until the person allows them; ${WITHHELD_TOOL} lists them when it is present.`
  );
}

/** « Le même appel » : le verbe et ses arguments, clés triées. */
export function callKey(verb: string, args: unknown): string {
  return `${verb}\u0000${stableJson(args ?? {})}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class McpRelay {
  private readonly prefix: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private protocolVersion: string | null = null;
  /**
   * Les appels retenus dont l'agent n'a pas reçu l'issue, par « même appel ». Un client qui
   * abandonne pendant l'attente réessaie : sans cette mémoire, chaque essai créait une
   * nouvelle demande, et la personne qui les approuvait toutes faisait exécuter l'action
   * autant de fois (le 28 octobre 2026, une écriture exécutée deux fois — §5.50).
   */
  private readonly heldCalls = new Map<string, HeldCall>();
  /** Les clés en cours : celle de l'agent, celle d'approbation. Le pivot peut les renouveler. */
  private key: string;
  private approverKey: string | undefined;
  /** Ce que le client a déclaré à `initialize`. */
  private clientCanElicit = false;
  private clientName = "your client";
  /** Les questions posées au client, en attente de sa réponse. */
  private readonly clientRequests = new Map<string, (message: RpcMessage) => void>();
  private nextClientRequest = 0;
  /** Le programme de ce client n'est pas confirmé (ou est bloqué) : aucune clé, rien ne passe. */
  private quarantine: { status: "pending" | "blocked"; program: string } | null = null;
  private quarantinePoll: ReturnType<typeof setInterval> | null = null;
  /** Les questions encore affichées dans le client, par demande d'approbation. */
  private readonly openQuestions = new Map<string, string>();
  /** Les outils de ce serveur retenus pour l'agent, selon la dernière liste. */
  private withheld: Withheld[] = [];
  /** La liste que le client connaît : noms visibles et retenus. */
  private listedSignature: string | null = null;
  private watcher: ReturnType<typeof setInterval> | null = null;
  /** Nom présenté au client → verbe d'Oathrion. */
  private readonly toVerb = new Map<string, string>();
  /** Nom présenté au client → sa classe (`read`, `write`, `destructive`), d'après le pivot. */
  private readonly toolClasses = new Map<string, string>();
  /**
   * « Décider une fois », pour la session : les écritures que la personne a autorisées jusqu'à
   * ce que le client se ferme. Chaque appel est quand même approuvé — par ce relais, avec la
   * clé d'approbation — et inscrit au journal comme tel.
   */
  private readonly sessionGrants = new Set<string>();
  private internalId = 0;

  constructor(private readonly options: RelayOptions) {
    this.key = options.key;
    this.approverKey = options.approverKey;
    this.prefix = `mcp.${options.serverName}.`;
    this.baseUrl = options.endpoint.replace(/\/api\/mcp$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Traite une ligne reçue du client. */
  async handle(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let message: RpcMessage;
    try {
      message = JSON.parse(trimmed) as RpcMessage;
    } catch {
      this.reply(null, { error: { code: -32700, message: "Message JSON illisible." } });
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.reply(null, { error: { code: -32600, message: "JSON-RPC batches are not supported." } });
      return;
    }
    if (typeof message.method !== "string") {
      /* Une réponse du client : à une question que le relais lui a posée, ou à rien. */
      const waiting = typeof message.id === "string" ? this.clientRequests.get(message.id) : undefined;
      if (waiting) {
        this.clientRequests.delete(message.id as string);
        waiting(message);
      }
      return;
    }
    const isRequest = message.id !== undefined && message.id !== null;
    const id = isRequest ? (message.id as Id) : null;

    /*
     * `server/discover` (MCP 2026-07-28, sans poignée de main) : le relais parle la version à
     * poignée de main, car c'est à `initialize` qu'il apprend qui est le client et s'il sait
     * poser une question. « Méthode inconnue » : le client se rabat sur `initialize` (Claude
     * Code 2.1.312 l'envoie juste avant, et le fait). Rien n'est transmis, aucune clé n'est
     * créée : sans cela, un agent « Client MCP » de trop apparaissait dans la console.
     */
    if (message.method === "server/discover") {
      if (isRequest) this.reply(id, { error: { code: -32601, message: "server/discover is not supported by this relay: use initialize." } });
      return;
    }

    if (message.method === "initialize") {
      const requested = message.params?.protocolVersion;
      if (typeof requested === "string" && COMPAT_VERSIONS.has(requested)) this.protocolVersion = requested;
      this.clientCanElicit = canElicitForm(message.params?.capabilities);
      /* Le titre lisible (« Claude Code ») plutôt que l'identifiant (`claude-code`), s'il est donné. */
      const info = message.params?.clientInfo as { name?: unknown; title?: unknown } | undefined;
      const clientName = [info?.title, info?.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
      if (clientName) this.clientName = clientName.trim().slice(0, 60);
      /* Le pivot : l'agent porte le nom que le client vient de donner. */
      if (this.options.credentialsFor) {
        try {
          this.admit(await this.options.credentialsFor(this.clientName === "your client" ? "MCP client" : this.clientName, this.clientCanElicit));
        } catch (error) {
          this.options.log(`[oathrion wrap] the local hub gave no key: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else if (this.key === "" && !this.quarantine && this.options.credentialsFor && message.method !== "notifications/initialized") {
      /* Un client qui parle sans s'être présenté : une clé tout de même, sous un nom générique. */
      try {
        this.admit(await this.options.credentialsFor("Client MCP", false));
      } catch {
        /* l'appel sera refusé, et le dira */
      }
    }

    /*
     * QUARANTAINE : le programme qui a lancé ce relais n'est pas confirmé. Avant de répondre, on
     * redemande au pivot (la personne a peut-être décidé à l'instant) ; sinon, le relais répond
     * lui-même, et rien n'atteint le pivot ni le serveur.
     */
    if (this.quarantine && message.method !== "initialize" && isRequest && this.options.credentialsFor) {
      try {
        this.admit(await this.options.credentialsFor(this.clientName === "your client" ? "MCP client" : this.clientName, this.clientCanElicit));
      } catch {
        /* le pivot ne répond pas : la quarantaine tient */
      }
    }
    if (this.quarantine) {
      if (!isRequest) return;
      const text = quarantineExplanation(this.quarantine.status, this.quarantine.program);
      switch (message.method) {
        case "initialize":
          this.reply(id, {
            result: {
              protocolVersion: this.protocolVersion ?? PROTOCOL_FALLBACK,
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "oathrion", version: "quarantine" },
              instructions: text,
            },
          });
          return;
        case "ping":
          this.reply(id, { result: {} });
          return;
        case "tools/list": {
          const tools = this.options.previewTools ? await this.options.previewTools().catch(() => []) : [];
          this.reply(id, { result: { tools: [...tools, { name: UNKNOWN_PROGRAM_TOOL, description: text, inputSchema: { type: "object", properties: {} } }] } });
          return;
        }
        case "tools/call": {
          if ((message.params?.name as unknown) === UNKNOWN_PROGRAM_TOOL) {
            this.reply(id, { result: { content: [{ type: "text", text }], isError: false } });
            return;
          }
          /*
           * L'APPEL ATTEND LA PERSONNE (essai réel du 9 novembre : l'agent s'arrêtait, et ne
           * reprenait pas après la confirmation). Comme pour une approbation : la notification
           * part, le relais relit la décision chaque seconde ; confirmé à temps, l'appel suit son
           * cours normal, et l'agent ne voit que sa réponse.
           */
          const deadline = Date.now() + (this.options.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS);
          while (this.quarantine?.status === "pending" && Date.now() < deadline && this.options.credentialsFor) {
            await new Promise((done) => setTimeout(done, this.options.pollMs ?? 1_000));
            try {
              this.admit(await this.options.credentialsFor(this.clientName === "your client" ? "MCP client" : this.clientName, this.clientCanElicit));
            } catch {
              /* le pivot ne répond pas : on réessaie jusqu'au délai */
            }
          }
          if (this.quarantine) {
            this.reply(id, { result: { content: [{ type: "text", text: quarantineExplanation(this.quarantine.status, this.quarantine.program) }], isError: true } });
            return;
          }
          break;
        }
        case "resources/list":
          this.reply(id, { result: { resources: [] } });
          return;
        case "prompts/list":
          this.reply(id, { result: { prompts: [] } });
          return;
        default:
          this.reply(id, { error: { code: -32001, message: text } });
          return;
      }
    }

    let params = message.params;
    if (message.method === "tools/call") {
      const name = typeof params?.name === "string" ? params.name : "";
      /* L'outil d'information, et les outils retenus : le relais répond, rien ne s'exécute. */
      if (name === WITHHELD_TOOL || (!this.toVerb.has(name) && this.withheld.some((tool) => tool.name === name))) {
        if (isRequest) {
          const text = withheldExplanation(this.options.serverName, this.withheld);
          this.reply(id, { result: { content: [{ type: "text", text }], isError: name !== WITHHELD_TOOL } });
        }
        return;
      }
      const verb = this.toVerb.get(name) ?? (await this.refreshAndFind(name));
      if (!verb) {
        if (!isRequest) return;
        if (this.withheld.some((tool) => tool.name === name)) {
          this.reply(id, { result: { content: [{ type: "text", text: withheldExplanation(this.options.serverName, this.withheld) }], isError: true } });
        } else {
          this.reply(id, { error: { code: -32602, message: `Unknown tool: "${name}".` } });
        }
        return;
      }
      /*
       * Un leurre dans les arguments (`decoys.ts`) : aucune tâche honnête ne l'envoie. Refusé ici,
       * avant le pivot, quel que soit l'outil et sa règle ; le motif le dit à l'agent et à la personne.
       */
      const decoy = carriesDecoy(JSON.stringify(params?.arguments ?? {}), this.options.decoys?.(), true);
      if (decoy) {
        this.options.log(`[oathrion wrap] refused ${name}: its arguments carry ${decoy}, one of the decoys planted by « oathrion decoys ».`);
        if (isRequest) {
          const text = `Oathrion refuses: this call carries ${decoy}, one of the decoys planted by « oathrion decoys ». No honest task uses it: the agent was most likely tricked by something it read. Look at what it read before going on.`;
          this.reply(id, { result: { content: [{ type: "text", text }], isError: true } });
        }
        return;
      }
      /* Le jeton d'un serveur protégé, passé à un outil : il sortirait d'Oathrion par ce chemin. */
      const stolen = this.options.guardedToken?.(JSON.stringify(params?.arguments ?? {})) ?? null;
      if (stolen) {
        this.options.log(`[oathrion wrap] refused ${name}: its arguments carry the token of the "${stolen.server}" server (${stolen.from}).`);
        if (isRequest) this.reply(id, { result: { content: [{ type: "text", text: serverTokenReason(stolen) }], isError: true } });
        return;
      }
      params = { ...params, name: verb };
    }

    /* Le même appel qu'un appel encore retenu : pas de nouvelle demande, on attend la sienne. */
    const key = message.method === "tools/call" ? callKey(String(params?.name), params?.arguments) : null;
    if (key !== null && isRequest) {
      const replay = await this.replayHeld(key, String(message.params?.name ?? ""), message.params?._meta, message.params?.arguments);
      if (replay) {
        this.options.write(JSON.stringify({ ...replay, jsonrpc: "2.0", id }));
        return;
      }
    }

    let answer = await this.post({ ...message, params }, isRequest);
    if (!isRequest || answer === null) return;

    if (key !== null) answer = await this.settleHeld(answer, String(message.params?.name ?? ""), message.params?._meta, key, message.params?.arguments);

    if (message.method === "initialize" && answer.result) {
      const accepted = answer.result.protocolVersion;
      if (typeof accepted === "string" && COMPAT_VERSIONS.has(accepted)) this.protocolVersion = accepted;
      /*
       * Le relais sait prévenir d'une liste d'outils modifiée (une permission accordée dans la
       * console) : le client n'a plus à être relancé, s'il tient compte de l'annonce.
       */
      const capabilities = (answer.result.capabilities ?? {}) as Record<string, unknown>;
      const before = typeof answer.result.instructions === "string" ? `${answer.result.instructions}\n\n` : "";
      answer.result = {
        ...answer.result,
        /* Ce que le modèle doit savoir pour bien se comporter devant Oathrion ; lu par les clients qui transmettent les instructions. */
        instructions: `${before}${governanceInstructions(this.options.serverName)}`,
        capabilities: { ...capabilities, tools: { ...((capabilities.tools as Record<string, unknown> | undefined) ?? {}), listChanged: true } },
      };
    }
    if (message.method === "tools/list" && answer.result) {
      const tools = this.presentTools(answer.result.tools);
      this.readWithheld(answer.result._meta);
      if (this.withheld.length > 0) {
        tools.push({
          name: WITHHELD_TOOL,
          title: "Tools withheld by Oathrion",
          description: withheldExplanation(this.options.serverName, this.withheld),
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        });
      }
      answer.result = { ...answer.result, tools };
      this.listedSignature = this.signature();
      this.watchTools();
    }
    this.options.write(JSON.stringify({ ...answer, jsonrpc: "2.0", id }));
  }

  /**
   * Une écriture retenue : attendre la personne, dans le même appel.
   *
   * Sans cela, l'agent reçoit « retenu, ne réessayez pas », la personne approuve dans la
   * console, l'action part — et l'agent n'en saura jamais le résultat. Ici le relais relit
   * l'approbation et, une fois l'action exécutée par Oathrion, rend à l'agent la réponse du
   * serveur comme si l'appel venait d'aboutir. C'est Oathrion qui a exécuté, après la
   * décision humaine : le relais ne fait que LIRE l'issue (`GET`), il ne relâche rien.
   *
   * Au-delà du délai, l'agent reçoit le message « retenu » avec le lien : l'action partira
   * quand même à l'approbation, son résultat sera dans le reçu.
   */
  private async settleHeld(answer: RpcMessage, name: string, meta: unknown, key: string, args: unknown): Promise<RpcMessage> {
    const governance = (answer.result?._meta as Record<string, unknown> | undefined)?.[META_KEY] as
      | { decision?: unknown; approvalId?: unknown; executionId?: unknown }
      | undefined;
    if (governance?.decision !== "APPROVAL_REQUIRED" || typeof governance.approvalId !== "string") return answer;
    const link = `${this.baseUrl}/console#/approvals`;
    this.options.log(`[oathrion wrap] "${name}" is waiting for your approval: ${link}`);

    const waitMs = this.options.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS;
    const progressToken = (meta as { progressToken?: unknown } | undefined)?.progressToken;
    const settled =
      waitMs > 0 && typeof governance.executionId === "string"
        ? await this.settleApproval(name, args, governance.approvalId, governance.executionId, waitMs, progressToken, governance)
        : null;
    if (settled) return { ...answer, result: settled };

    if (typeof governance.executionId === "string") {
      this.heldCalls.set(key, { approvalId: governance.approvalId, executionId: governance.executionId, governance, answer });
    }
    return { ...answer, result: this.heldResult(answer.result ?? {}, link) };
  }

  /**
   * Un appel identique à un appel encore retenu. On relit SA demande : décidée, l'agent en
   * reçoit l'issue (la réponse du serveur, ou le refus) ; encore en attente, on l'attend,
   * puis on rend « retenu » de nouveau. Aucune nouvelle demande n'est créée.
   */
  private async replayHeld(key: string, name: string, meta: unknown, args: unknown): Promise<RpcMessage | null> {
    const held = this.heldCalls.get(key);
    if (!held) return null;
    this.options.log(`[oathrion wrap] "${name}": the same call is already waiting for approval ${held.approvalId} — no new request.`);
    const progressToken = (meta as { progressToken?: unknown } | undefined)?.progressToken;
    const settled = await this.settleApproval(
      name,
      args,
      held.approvalId,
      held.executionId,
      this.options.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS,
      progressToken,
      held.governance,
    );
    if (settled) {
      this.heldCalls.delete(key);
      return { ...held.answer, result: settled };
    }
    return { ...held.answer, result: this.heldResult(held.answer.result ?? {}, `${this.baseUrl}/console#/approvals`) };
  }

  /**
   * Obtenir la décision : d'abord en posant la question DANS le client, s'il le sait et si la
   * personne l'a choisi ; sinon, ou si elle ferme la question sans décider, en attendant la
   * console pour le temps qui reste.
   */
  private async settleApproval(
    name: string,
    args: unknown,
    approvalId: string,
    executionId: string,
    waitMs: number,
    progressToken: unknown,
    governance: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + waitMs;
    /* Déjà autorisée pour la session : approuvée sans question, et inscrite comme telle. */
    if (this.approverKey && this.sessionGrants.has(name) && this.toolClasses.get(name) === "write") {
      const recorded = await this.decide(approvalId, "approve", `Granted for the session (${this.clientName}): "${name}" without asking until the client closes.`);
      if (recorded.ok) {
        this.options.log(`[oathrion wrap] "${name}": granted for the session, without asking.`);
        return this.awaitApproval(approvalId, executionId, Math.max(30_000, deadline - Date.now()), progressToken, governance);
      }
    }
    if (this.approverKey && this.clientCanElicit) {
      const decided = await this.askInClient(name, args, approvalId, executionId, waitMs, governance);
      if (decided) return decided;
    }
    const settled = await this.awaitApproval(approvalId, executionId, Math.max(0, deadline - Date.now()), progressToken, governance);
    /* Une question restée affichée après le délai, et décidée depuis ailleurs : elle est refermée. */
    if (settled !== null) this.closeQuestion(approvalId, "Decided in Oathrion's console");
    return settled;
  }

  /**
   * Referme une question encore affichée dans le client (`notifications/cancelled`, MCP) : la
   * décision a été prise ailleurs, une réponse n'y servirait plus à rien.
   */
  private closeQuestion(approvalId: string, reason: string): void {
    const id = this.openQuestions.get(approvalId);
    if (id === undefined) return;
    this.openQuestions.delete(approvalId);
    this.clientRequests.delete(id);
    this.options.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }));
  }

  /**
   * La question, posée à la personne par l'interface du client (`elicitation/create`). C'est
   * l'interface du client qui la montre et qui répond, pas le modèle : c'est une confiance
   * faite au client. Par défaut dès que le client sait la poser (`--approbation console` pour
   * s'en passer) : d'où la case OBLIGATOIRE « Oui, j'autorise ». Un client qui accepterait
   * seul, sans personne devant (un mode sans interface), renverrait un accord sans la case :
   * ce n'est pas une décision, la console reste seule à décider.
   *
   * Rend l'issue quand la personne a décidé ; `null` quand elle n'a pas répondu (question
   * fermée, délai, client qui refuse la question) : la console prend le relais.
   */
  private async askInClient(
    name: string,
    args: unknown,
    approvalId: string,
    executionId: string,
    waitMs: number,
    governance: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const id = `oathrion-question-${String((this.nextClientRequest += 1))}`;
    const reply = new Promise<RpcMessage>((done) => this.clientRequests.set(id, done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), waitMs);
    });
    this.options.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "elicitation/create",
        params: {
          message: approvalQuestion(this.options.serverName, name, args),
          requestedSchema: {
            type: "object",
            properties: {
              confirmer: { type: "boolean", title: "Yes, I approve this action" },
              /* « Décider une fois » : pour une écriture seulement ; une destruction demande une personne à chaque fois. */
              ...(this.toolClasses.get(name) === "write"
                ? {
                    suite: {
                      type: "string",
                      title: "And next time?",
                      enum: [CHOICE_ONCE, CHOICE_SESSION, ...(this.options.grantAlways ? [CHOICE_ALWAYS] : [])],
                      default: CHOICE_ONCE,
                    },
                  }
                : {}),
              /* Plus de champ « note » (9 novembre) : un champ texte entre la case et Accept, une étape de plus ; la console garde les notes. */
            },
            required: ["confirmer"],
          },
        },
      }),
    );
    this.openQuestions.set(approvalId, id);
    /*
     * DÉCIDÉE AILLEURS (essai réel du 8 novembre) : la personne approuvait dans la console ou par
     * la notification pendant que la question était affichée. Le relais n'attendait QUE le
     * client : l'agent patientait jusqu'à la fin du délai (56 s vus), et la question restait
     * affichée, périmée. Le relais regarde donc aussi la décision, et referme la question.
     */
    let watching = true;
    const elsewhere = (async (): Promise<"decided"> => {
      while (watching) {
        const issue = (await this.read(`/api/approvals/${encodeURIComponent(approvalId)}/issue?attendre=10000`)) as { approval?: { status?: string } | null } | null;
        const status = issue?.approval?.status;
        if (watching && (status === "approved" || status === "rejected" || status === "expired")) return "decided";
        if (issue === null) await new Promise((done) => setTimeout(done, this.options.pollMs ?? 1_000));
      }
      return new Promise<"decided">(() => undefined);
    })();
    const response = await Promise.race([reply, timeout, elsewhere]);
    watching = false;
    clearTimeout(timer);
    if (response === "decided") {
      this.closeQuestion(approvalId, "Decided in Oathrion's console");
      this.options.log(`[oathrion wrap] "${name}": decided in Oathrion's console; the question in ${this.clientName} is closed.`);
      return null;
    }
    if (response !== null) this.openQuestions.delete(approvalId);
    if (response === null) {
      /*
       * Pas de réponse dans le délai : l'agent apprend que la demande attend, mais la question
       * RESTE affichée dans le client. Une réponse tardive y vaut une décision prise dans la
       * console (vu le 5 novembre : la personne répondait après coup, et rien ne se passait).
       */
      this.clientRequests.set(id, (late) => {
        void this.recordAnswer(name, approvalId, late).then((outcome) => {
          if (outcome.status === "failed") this.options.log(`[oathrion wrap] "${name}": the late answer in ${this.clientName} was not recorded (${outcome.message}).`);
        });
      });
      this.options.log(`[oathrion wrap] "${name}": no decision in ${this.clientName} yet — the console stays open, and an answer to the question still counts.`);
      return null;
    }
    this.clientRequests.delete(id);
    const outcome = await this.recordAnswer(name, approvalId, response);
    if (outcome.status === "none") return null;
    if (outcome.status === "failed") {
      return this.textResult(
        `Your decision could not be recorded by Oathrion: ${outcome.message} The tool was NOT called by this decision; the request is still in the console.`,
        true,
        governance,
      );
    }
    /* La décision est prise ; l'exécution, elle, est celle d'Oathrion : on en lit l'issue. */
    return (
      (await this.awaitApproval(approvalId, executionId, 30_000, undefined, governance)) ??
      this.textResult("Approved. The result is not back yet; it will be in Oathrion's receipt. Do not call the tool again.", false, governance)
    );
  }

  /**
   * La réponse de la personne à la question : une décision (« Oui » coché, ou refus), inscrite
   * dans Oathrion avec son choix pour la suite ; `none` quand ce n'en est pas une (question
   * fermée, ou acceptée sans la case).
   */
  private async recordAnswer(name: string, approvalId: string, response: RpcMessage): Promise<{ status: "none" } | { status: "failed"; message: string } | { status: "recorded" }> {
    const action = response.result?.action;
    if (action !== "accept" && action !== "decline") {
      this.options.log(`[oathrion wrap] "${name}": no decision in ${this.clientName} — the console stays open for approval.`);
      return { status: "none" };
    }
    const content = response.result?.content as { note?: unknown; confirmer?: unknown; suite?: unknown } | undefined;
    if (action === "accept" && content?.confirmer !== true) {
      this.options.log(`[oathrion wrap] "${name}": accepted in ${this.clientName} without the "Yes, I approve" box — that is not a decision; the console stays open for approval.`);
      return { status: "none" };
    }
    const rawNote = content?.note;
    const note = typeof rawNote === "string" && rawNote.trim() !== "" ? rawNote.trim().slice(0, 500) : undefined;
    const recorded = await this.decide(approvalId, action === "accept" ? "approve" : "reject", note);
    if (!recorded.ok) {
      this.options.log(`[oathrion wrap] "${name}": the decision made in ${this.clientName} was not recorded (${recorded.message}).`);
      return { status: "failed", message: recorded.message };
    }
    this.options.log(`[oathrion wrap] "${name}": ${action === "accept" ? "approved" : "rejected"} in ${this.clientName}.`);
    if (action === "accept" && this.toolClasses.get(name) === "write") await this.rememberChoice(name, content?.suite);
    return { status: "recorded" };
  }

  /** « Décider une fois » : retenir le choix de la personne pour les prochains appels de cet outil. */
  private async rememberChoice(name: string, choice: unknown): Promise<void> {
    if (choice === CHOICE_SESSION) {
      this.sessionGrants.add(name);
      this.options.log(`[oathrion wrap] "${name}": granted for the session, no more questions until ${this.clientName} closes.`);
      return;
    }
    if (choice !== CHOICE_ALWAYS || !this.options.grantAlways) return;
    const verb = this.toVerb.get(name);
    if (!verb) return;
    const granted = await this.options.grantAlways(verb, `from ${this.clientName}`);
    if (granted.ok) {
      this.sessionGrants.add(name);
      this.options.log(`[oathrion wrap] "${name}": allowed without approval, always (rule ${granted.policyId}, in the console: Policies).`);
    } else {
      this.options.log(`[oathrion wrap] "${name}": the permanent grant was not recorded (${granted.message}); the question will come back.`);
    }
  }

  /** Enregistrer la décision de la personne, avec la clé d'approbation de l'espace local. */
  private async decide(approvalId: string, verb: "approve" | "reject", note: string | undefined): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/approvals/${encodeURIComponent(approvalId)}/${verb}`, {
        method: "POST",
        headers: { authorization: `Bearer ${String(this.approverKey)}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(note ? { note } : {}),
      });
      if (response.ok) return { ok: true };
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      return { ok: false, message: typeof body?.error === "string" ? body.error : `HTTP ${String(response.status)}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** La réponse « retenu », avec le lien et ce qu'un nouvel essai fera. */
  private heldResult(result: Record<string, unknown>, link: string): Record<string, unknown> {
    const content = Array.isArray(result.content) ? [...(result.content as { type?: string; text?: string }[])] : [];
    const first = content[0];
    if (first && first.type === "text" && typeof first.text === "string") {
      content[0] = {
        ...first,
        text:
          `${first.text} Approve it here: ${link} ` +
          `Calling this tool again with the same arguments creates no new request: it waits for this one, and returns its result once a person has decided.`,
      };
    }
    return { ...result, content };
  }

  private async awaitApproval(
    approvalId: string,
    executionId: string,
    waitMs: number,
    progressToken: unknown,
    governance: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const pollMs = this.options.pollMs ?? 1_000;
    const deadline = Date.now() + waitMs;
    let lastProgress = 0;
    let tick = 0;
    /* Au moins une lecture, même sans attente : un appel rejoué doit voir une décision déjà prise. */
    for (;;) {
      /*
       * L'issue, ATTENDUE côté serveur au plus 10 s (`GET /api/approvals/:id/issue`) : la
       * réponse part dès l'approbation, au lieu d'attendre la relecture suivante (1,03 s
       * mesurés avant, par `script/mesure-fluidite.mjs`).
       */
      const remaining = Math.max(0, deadline - Date.now());
      /* La progression part AVANT chaque attente : un client qui la demande la voit tout de suite. */
      if (progressToken !== undefined && remaining > 0 && Date.now() - lastProgress >= 10_000) {
        lastProgress = Date.now();
        tick += 1;
        this.options.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken, progress: tick, message: "Waiting for a person to approve in Oathrion…" },
          }),
        );
      }
      const issue = (await this.read(`/api/approvals/${encodeURIComponent(approvalId)}/issue?attendre=${String(Math.min(remaining, 10_000))}`)) as {
        approval?: { status?: string; resolvedBy?: string } | null;
        execution?: { runState?: string; toolResult?: Record<string, unknown> | null; result?: string } | null;
      } | null;
      const approval = issue?.approval ?? null;
      const status = approval?.status;
      if (status === "rejected" || status === "expired") {
        const who = approval?.resolvedBy ? ` by ${approval.resolvedBy}` : "";
        return this.textResult(
          status === "rejected"
            ? `Rejected${who} in Oathrion — the tool was NOT called.`
            : "The approval expired — the tool was NOT called.",
          true,
          { ...governance, approval: status },
        );
      }
      if (status === "approved") {
        const execution = issue?.execution ?? null;
        const runState = execution?.runState;
        if (runState === "succeeded" || runState === "failed") {
          const meta = { ...governance, decision: "ALLOW", approval: "approved", approvedBy: approval?.resolvedBy ?? null, succeeded: runState === "succeeded" };
          if (runState === "succeeded") {
            const child = (execution?.toolResult?.result ?? null) as Record<string, unknown> | null;
            return {
              content: Array.isArray(child?.content) ? child.content : [],
              ...(child && "structuredContent" in child ? { structuredContent: child.structuredContent } : {}),
              isError: false,
              _meta: { [META_KEY]: meta },
            };
          }
          const unknown = execution?.toolResult?.dispatched === "unknown";
          /* Ce que le serveur a répondu (essai du 8 novembre) : sans cela, l'agent ne savait pas pourquoi. */
          const parts = (execution?.toolResult?.result as { content?: unknown } | undefined)?.content;
          const said = Array.isArray(parts)
            ? parts.map((part) => (typeof (part as { text?: unknown } | null)?.text === "string" ? (part as { text: string }).text : "")).filter((t) => t.trim() !== "").join("\n").trim().slice(0, 2_000)
            : "";
          return this.textResult(
            unknown
              ? "Approved, but the outcome is UNKNOWN: the request reached the server and no answer came back. Do not retry; a person must check."
              : `Approved, but the call failed: ${String(execution?.toolResult?.summary ?? execution?.result ?? "see the receipt")}${said ? ` The server answered: ${said}` : ""}`,
            true,
            meta,
          );
        }
      }
      if (Date.now() >= deadline) return null;
      /* Oathrion injoignable, ou une erreur : on ne boucle pas à vide. */
      if (issue === null) await new Promise((done) => setTimeout(done, pollMs));
    }
  }

  private textResult(text: string, isError: boolean, governance: Record<string, unknown>): Record<string, unknown> {
    return { content: [{ type: "text", text }], isError, _meta: { [META_KEY]: governance } };
  }

  /** Une lecture authentifiée de l'API locale ; `null` si elle n'aboutit pas. */
  private async read(path: string): Promise<unknown> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { authorization: `Bearer ${this.key}`, accept: "application/json" } });
      return response.ok ? ((await response.json()) as unknown) : null;
    } catch {
      return null;
    }
  }

  /** Les outils de CE serveur, sous leur nom d'origine ; tout le reste est retiré. */
  private presentTools(raw: unknown): unknown[] {
    if (!Array.isArray(raw)) return [];
    const presented: unknown[] = [];
    for (const tool of raw) {
      if (tool === null || typeof tool !== "object") continue;
      const record = tool as { name?: unknown; _meta?: Record<string, unknown> };
      if (typeof record.name !== "string" || !record.name.startsWith(this.prefix)) continue;
      const governance = record._meta?.[META_KEY] as { originalName?: unknown; toolClass?: unknown } | undefined;
      const original = typeof governance?.originalName === "string" ? governance.originalName : record.name.slice(this.prefix.length);
      this.toVerb.set(original, record.name);
      if (typeof governance?.toolClass === "string") this.toolClasses.set(original, governance.toolClass);
      presented.push({ ...record, name: original });
    }
    return presented;
  }

  /** Ce que le client voit : les noms visibles et les noms retenus. */
  private signature(): string {
    return JSON.stringify([[...this.toVerb.keys()].sort(), this.withheld.map((tool) => tool.name).sort()]);
  }

  /*
   * Relit la liste en arrière-plan ; si elle a changé depuis ce que le client a vu, le prévient
   * (`notifications/tools/list_changed`) — il relira lui-même. Ne retient pas le processus.
   */
  private watchTools(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => void this.checkTools(), this.options.watchMs ?? 5_000);
    this.watcher.unref?.();
  }

  private async checkTools(): Promise<void> {
    this.internalId += 1;
    const answer = await this.post({ jsonrpc: "2.0", id: `oathrion-wrap-${String(this.internalId)}`, method: "tools/list", params: {} }, true);
    if (!answer?.result) return;
    this.toVerb.clear();
    this.presentTools(answer.result.tools);
    this.readWithheld(answer.result._meta);
    const now = this.signature();
    if (this.listedSignature !== null && now !== this.listedSignature) {
      this.listedSignature = now;
      this.options.log(`[oathrion wrap] the tool list changed: your client has been told.`);
      this.options.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
    }
  }

  /** De nouvelles clés (le pivot les a renouvelées, ou le client vient de se présenter). */
  /**
   * Une réponse du pivot : une clé (le programme est confirmé), ou la quarantaine. Sortie de
   * quarantaine : le client est prévenu que la liste des outils a changé, et la relit.
   */
  private admit(credentials: Credentials): void {
    if ("quarantined" in credentials) {
      this.quarantine = { status: credentials.quarantined, program: credentials.program };
      this.quarantinePoll ??= setInterval(() => {
        if (!this.options.credentialsFor) return;
        void this.options
          .credentialsFor(this.clientName === "your client" ? "MCP client" : this.clientName, this.clientCanElicit)
          .then((next) => this.admit(next))
          .catch(() => undefined);
      }, this.options.quarantinePollMs ?? 3_000);
      this.quarantinePoll.unref?.();
      return;
    }
    const wasQuarantined = this.quarantine !== null;
    this.quarantine = null;
    if (this.quarantinePoll) clearInterval(this.quarantinePoll);
    this.quarantinePoll = null;
    this.setCredentials(credentials);
    if (wasQuarantined) {
      this.options.log("[oathrion wrap] this program is now confirmed: its calls go through Oathrion again.");
      this.options.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
    }
  }

  setCredentials(credentials: { key: string; approverKey?: string | null }): void {
    this.key = credentials.key;
    this.approverKey = credentials.approverKey ?? undefined;
    for (const wake of this.keyWaiters.splice(0)) wake();
  }

  /** Ceux qui attendent une clé neuve (un appel refusé 401 pendant un renouvellement). */
  private readonly keyWaiters: (() => void)[] = [];

  private waitForNewKey(ms: number): Promise<boolean> {
    return new Promise((done) => {
      const timer = setTimeout(() => {
        const index = this.keyWaiters.indexOf(wake);
        if (index !== -1) this.keyWaiters.splice(index, 1);
        done(false);
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        done(true);
      };
      this.keyWaiters.push(wake);
    });
  }

  /** Arrête la relecture en arrière-plan. */
  close(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  /** Les outils retenus de CE serveur, lus dans la liste que rend Oathrion. */
  private readWithheld(meta: unknown): void {
    const listed = ((meta as Record<string, unknown> | undefined)?.[META_KEY] as { withheld?: unknown } | undefined)?.withheld;
    this.withheld = Array.isArray(listed)
      ? listed.flatMap((entry) => {
          const tool = entry as { name?: unknown; verb?: unknown; toolClass?: unknown };
          return typeof tool.name === "string" && typeof tool.verb === "string" && tool.verb.startsWith(this.prefix)
            ? [{ name: tool.name, toolClass: typeof tool.toolClass === "string" ? tool.toolClass : "write" }]
            : [];
        })
      : [];
  }

  /** Un nom inconnu : relire la liste une fois (le client a pu appeler sans lister). */
  private async refreshAndFind(name: string): Promise<string | undefined> {
    this.internalId += 1;
    const answer = await this.post({ jsonrpc: "2.0", id: `oathrion-wrap-${String(this.internalId)}`, method: "tools/list", params: {} }, true);
    if (answer?.result) {
      this.presentTools(answer.result.tools);
      this.readWithheld(answer.result._meta);
    }
    return this.toVerb.get(name);
  }

  private async post(message: RpcMessage, expectAnswer: boolean, retried = false): Promise<RpcMessage | null> {
    const usedKey = this.key;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${usedKey}`,
    };
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.endpoint, { method: "POST", headers, body: JSON.stringify(message) });
    } catch (error) {
      this.options.log(`[oathrion wrap] local Oathrion unreachable: ${error instanceof Error ? error.message : String(error)}`);
      return expectAnswer ? this.failure("Local Oathrion is not answering: the call was NOT passed to the MCP server.") : null;
    }
    /*
     * 401 pendant un renouvellement de clé : le pivot, ralenti, a cru le relais parti et a
     * révoqué sa clé ; le battement en obtient une neuve dans les secondes qui suivent
     * (`cli/wrap/hub.ts`). Un 401 arrive AVANT toute décision : rien n'a été exécuté, et
     * rejouer UNE fois avec la clé neuve ne peut pas exécuter deux fois. Sans cela, l'agent
     * voyait « Invalid credentials » (banc d'endurance, journal §5.74).
     */
    if (response.status === 401 && this.options.credentialsFor) {
      await response.body?.cancel().catch(() => undefined);
      const renewed = !retried && (this.key !== usedKey || (await this.waitForNewKey(KEY_RENEWAL_WAIT_MS)));
      if (renewed) {
        this.options.log("[oathrion wrap] key renewed by the hub: the call is replayed once.");
        return this.post(message, expectAnswer, true);
      }
      return expectAnswer ? this.failure("Local Oathrion is reconnecting this client (for example after the machine slept) and its key is not renewed yet: the call was NOT passed to the MCP server. Try again in a minute; nothing needs to be changed.") : null;
    }
    if (response.status === 202 || !expectAnswer) return null;
    const text = await response.text();
    try {
      const body = JSON.parse(text) as RpcMessage;
      if (body && typeof body === "object" && ("result" in body || "error" in body)) return body;
    } catch {
      /* rendu plus bas */
    }
    return this.failure(`Local Oathrion answered ${String(response.status)} without a JSON-RPC message: the call did not go through.`);
  }

  private failure(message: string): RpcMessage {
    return { error: { code: -32603, message } };
  }

  private reply(id: Id, payload: { error: unknown } | { result: unknown }): void {
    this.options.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
  }
}
