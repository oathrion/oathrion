/**
 * Un serveur MCP ENFANT, lancé par Oathrion et joint par son entrée et sa sortie standard.
 *
 * ## Pourquoi ce module existe
 *
 * C'est la première brique de `oathrion wrap` (`notes/CONCEPTION-OATHRION-WRAP.md`, étape
 * E1). La plupart des serveurs MCP ne s'exposent pas en HTTP : on les lance comme un
 * programme (`npx -y @modelcontextprotocol/server-github`) et on leur parle en JSON-RPC, un
 * message par ligne, sur stdin / stdout. `mcp-client.ts` ne sait joindre qu'un serveur HTTP ;
 * celui-ci joint un processus.
 *
 * ## Ce qu'il ne fait pas, et où il est le droit d'être
 *
 * Il ne décide rien. Il lance, il transporte, il dit ce qui s'est passé. Comme
 * `mcp-client.ts`, il ne doit être atteignable qu'APRÈS une décision : seul un outil
 * gouverné (un `CountingTool`, atteint par `AgentGateway.dispatch()` après un ALLOW) peut
 * l'importer pour appeler `callTool`. `mcp-single-path.test.ts` le vérifie sur le texte des
 * sources.
 *
 * ## Ce qu'il dit quand ça échoue
 *
 * La question qui compte pour un reçu honnête : **la requête a-t-elle pu atteindre l'enfant ?**
 * (`StdioCallError.mayHaveReached`). C'est la même distinction que `transportFailure` pour
 * les connecteurs HTTP :
 *
 *   · l'enfant ne tournait pas, la ligne n'a pas été écrite → rien n'est parti ;
 *   · la ligne a été écrite, puis délai dépassé ou enfant mort → l'effet est INCONNU ;
 *   · l'enfant a répondu par une erreur JSON-RPC → il a reçu, et refusé.
 *
 * Un doute tombe du côté « a pu atteindre » : un reçu qui dit « rien envoyé » à tort ouvre
 * une relance, donc un doublon.
 *
 * ## Les bornes
 *
 * Une ligne de sortie est bornée (`MAX_LINE_BYTES`) : un enfant qui écrit sans fin de ligne
 * ne fait pas grossir la mémoire d'Oathrion, il est arrêté. La sortie d'erreur de l'enfant
 * est gardée dans un tampon tournant (`STDERR_KEEP_BYTES`) pour le diagnostic, jamais
 * recopiée ailleurs : elle peut contenir ce que l'enfant juge bon d'y écrire, secrets
 * compris.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import crossSpawn from "cross-spawn";

/** Les révisions du protocole qu'un serveur stdio peut répondre à `initialize`. */
export const STDIO_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const REQUESTED_PROTOCOL = STDIO_PROTOCOL_VERSIONS[0];

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_KEEP_BYTES = 64 * 1024;
const STOP_GRACE_MS = 2_000;

/*
 * Chaque enfant a son propre groupe de processus (POSIX). Un serveur MCP est souvent lancé
 * par un enveloppeur — `npx` : npm, qui lance sh, qui lance le serveur — et un signal envoyé
 * au seul enfant direct laisse le petit-enfant vivant. Le signal va donc au groupe.
 *
 * Quand le processus qui les a lancés s'arrête, ses enfants encore vivants reçoivent
 * SIGTERM : un seul écouteur `exit` pour tous, pas un par enfant.
 */
const GROUPED = process.platform !== "win32";

/*
 * SOUS WINDOWS, `npx` EST UN SCRIPT `npx.cmd`, et la plupart des configurations MCP l'écrivent
 * tel quel (`"command": "npx"`). `child_process.spawn` sans shell ne le trouve pas, et Node
 * refuse de lancer un `.cmd` sans shell depuis le correctif CVE-2024-27980 : chaque serveur
 * protégé aurait échoué au démarrage. `cross-spawn` résout la commande par PATHEXT et passe
 * par `cmd.exe` en échappant chaque argument — ce que fait le client MCP officiel. Ailleurs,
 * le `spawn` de Node, inchangé.
 */
export const spawnChild = process.platform === "win32" ? crossSpawn : nodeSpawn;
const LIVE_GROUPS = new Set<number>();
let exitHookInstalled = false;

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function trackGroup(pid: number): void {
  LIVE_GROUPS.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const group of LIVE_GROUPS) signalGroup(group, "SIGTERM");
  });
}
/** Pagination de `tools/list` : au-delà, un serveur qui boucle sur son curseur. */
const MAX_LIST_PAGES = 20;

export interface StdioChildSpec {
  command: string;
  args: readonly string[];
  /** L'environnement de l'enfant. Ses propres jetons y vivent ; Oathrion ne les lit pas. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  clientName?: string;
  clientVersion?: string;
}

/** Un outil tel que l'enfant le déclare. Rien n'est interprété ici. */
export interface ChildTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
  /** La définition entière, telle que reçue : c'est elle que l'on empreinte (étape E5). */
  raw: Record<string, unknown>;
}

export interface ChildCallResult {
  /** Le résultat MCP brut : `content`, `structuredContent`, `isError`. */
  result: Record<string, unknown>;
  isError: boolean;
}

export type StdioFailureKind =
  /** L'enfant ne tournait pas, ou n'a pas pu être lancé. */
  | "not_running"
  /** Aucune réponse dans le délai. */
  | "timeout"
  /** L'enfant s'est arrêté avant de répondre. */
  | "exited"
  /** L'enfant a répondu par une erreur JSON-RPC. */
  | "rpc_error"
  /** L'enfant a répondu quelque chose qui n'est pas du protocole. */
  | "protocol";

export class StdioCallError extends Error {
  constructor(
    message: string,
    readonly kind: StdioFailureKind,
    /** Vrai dès que la requête a pu être lue par l'enfant. */
    readonly mayHaveReached: boolean,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "StdioCallError";
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: StdioCallError) => void;
  timer: NodeJS.Timeout;
}

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

export class StdioMcpChild {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited = true;
  /* L'arrêt n'est annoncé qu'une fois : `error` puis `exit` peuvent arriver tous les deux. */
  private exitAnnounced = true;
  private exitDescription = "not started yet";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private stderrTail = "";
  private toolsChangedListeners: (() => void)[] = [];
  private exitListeners: ((description: string) => void)[] = [];
  /** La révision du protocole que l'enfant a acceptée. */
  protocolVersion: string | null = null;
  serverInfo: { name?: string; version?: string } | null = null;

  constructor(private readonly spec: StdioChildSpec) {}

  /** Vrai tant que le processus tourne. */
  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Les derniers octets de la sortie d'erreur de l'enfant, pour un diagnostic local. */
  get stderr(): string {
    return this.stderrTail;
  }

  onToolsChanged(listener: () => void): void {
    this.toolsChangedListeners.push(listener);
  }

  onExit(listener: (description: string) => void): void {
    this.exitListeners.push(listener);
  }

  /**
   * Lance l'enfant et fait la poignée de main. Rejette si l'enfant ne démarre pas, ne
   * répond pas, ou répond une révision du protocole que ce client ne parle pas.
   */
  async start(timeoutMs: number): Promise<void> {
    if (this.running) throw new Error("The child is already running.");
    const child = spawnChild(this.spec.command, [...this.spec.args], {
      cwd: this.spec.cwd,
      env: this.spec.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: GROUPED,
    });
    this.child = child;
    if (GROUPED && child.pid) trackGroup(child.pid);
    this.exited = false;
    this.exitAnnounced = false;
    this.stdoutBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_KEEP_BYTES);
    });
    /* Une écriture vers un enfant mort lève EPIPE sur le flux : c'est `exit` qui le dit. */
    child.stdin.on("error", () => undefined);

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        this.markExited(`lancement impossible : ${error.message}`);
        reject(new StdioCallError(`The MCP server could not be started: ${error.message}`, "not_running", false));
      });
    });
    child.once("exit", (code, signal) => {
      if (GROUPED && child.pid) {
        /* L'enveloppeur est parti ; ce qu'il a lancé et laissé derrière lui suit. */
        LIVE_GROUPS.delete(child.pid);
        signalGroup(child.pid, "SIGTERM");
      }
      this.markExited(signal ? `stopped by signal ${signal}` : `exited with code ${String(code)}`);
    });

    await spawned;

    const init = (await this.request(
      "initialize",
      {
        protocolVersion: REQUESTED_PROTOCOL,
        capabilities: {},
        clientInfo: { name: this.spec.clientName ?? "oathrion", version: this.spec.clientVersion ?? "0" },
      },
      timeoutMs,
    )) as { protocolVersion?: unknown; serverInfo?: { name?: string; version?: string } } | null;

    const version = typeof init?.protocolVersion === "string" ? init.protocolVersion : "";
    if (!(STDIO_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      await this.stop();
      throw new StdioCallError(
        `The MCP server answered revision "${version || "none"}", which this client does not speak ` +
          `(accepted: ${STDIO_PROTOCOL_VERSIONS.join(", ")}).`,
        "protocol",
        true,
      );
    }
    this.protocolVersion = version;
    this.serverInfo = init?.serverInfo ?? null;
    this.notify("notifications/initialized");
  }

  /** `tools/list`, toutes pages comprises. */
  async listTools(timeoutMs: number): Promise<ChildTool[]> {
    const tools: ChildTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const reply = (await this.request("tools/list", cursor ? { cursor } : {}, timeoutMs)) as {
        tools?: unknown;
        nextCursor?: unknown;
      } | null;
      const list = Array.isArray(reply?.tools) ? reply.tools : null;
      if (list === null) throw new StdioCallError("`tools/list` did not return a tool list.", "protocol", true);
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue;
        const raw = entry as Record<string, unknown>;
        if (typeof raw.name !== "string" || raw.name === "") continue;
        tools.push({
          name: raw.name,
          description: typeof raw.description === "string" ? raw.description : undefined,
          inputSchema: raw.inputSchema,
          annotations:
            raw.annotations !== null && typeof raw.annotations === "object"
              ? (raw.annotations as ChildTool["annotations"])
              : undefined,
          raw,
        });
      }
      if (typeof reply?.nextCursor !== "string" || reply.nextCursor === "") return tools;
      cursor = reply.nextCursor;
    }
    throw new StdioCallError(`\`tools/list\` returned more than ${String(MAX_LIST_PAGES)} pages: stopped.`, "protocol", true);
  }

  /**
   * `tools/call`. Les arguments partent TELS QUELS : la validation et la décision ont eu
   * lieu avant, dans la passerelle.
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ChildCallResult> {
    const reply = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
      throw new StdioCallError("`tools/call` did not return a result object.", "protocol", true);
    }
    const result = reply as Record<string, unknown>;
    return { result, isError: result.isError === true };
  }

  /** Une requête attend-elle encore sa réponse ? L'arrêter maintenant la ferait échouer. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /** Ferme l'entrée de l'enfant, puis le termine s'il ne s'arrête pas de lui-même. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    const term = setTimeout(() => this.signal("SIGTERM"), STOP_GRACE_MS);
    const kill = setTimeout(() => this.signal("SIGKILL"), STOP_GRACE_MS * 2);
    await gone;
    clearTimeout(term);
    clearTimeout(kill);
  }

  /* ------------------------------------------------------------------ transport */

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || this.exited) {
      return Promise.reject(
        new StdioCallError(`The MCP server is not running (${this.exitDescription}): nothing was sent.`, "not_running", false),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new StdioCallError(
            `The MCP server did not answer "${method}" within ${String(timeoutMs)} ms. ` +
              /* Seul un appel d'outil agit ; dire « l'action a peut-être eu lieu » d'une initialisation égarait (§5.56). */
              (method === "tools/call"
                ? `The request went out: the action MAY have happened.`
                : `No action happened: "${method}" only queries the server.`),
            "timeout",
            true,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      /*
       * À partir d'ici, la ligne est confiée au tube : l'enfant peut la lire même si
       * l'écriture signale une erreur ensuite. Tout échec ultérieur vaut « a pu atteindre ».
       */
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child || this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  /** Un signal à l'enfant et à tout son groupe ; à l'enfant seul si le groupe n'existe pas. */
  private signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child) return;
    if (GROUPED && child.pid && signalGroup(child.pid, signal)) return;
    child.kill(signal);
  }

  private respond(id: unknown, payload: { result: unknown } | { error: { code: number; message: string } }): void {
    if (!this.child || this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_LINE_BYTES && !this.stdoutBuffer.includes("\n")) {
      this.stdoutBuffer = "";
      this.failAll(new StdioCallError("The MCP server wrote a line longer than 16 MiB: stopped.", "protocol", true));
      this.signal("SIGKILL");
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line !== "") this.onLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      /*
       * Une ligne qui n'est pas du JSON : beaucoup de serveurs écrivent leurs journaux sur
       * stdout par erreur. On l'ignore plutôt que de tout arrêter — elle ne peut répondre à
       * aucune requête, donc elle ne peut rien faire passer pour un résultat.
       */
      return;
    }
    if (message === null || typeof message !== "object") return;

    /* Une requête de l'enfant vers nous : `ping` est la seule que l'on sert. */
    if (typeof message.method === "string" && message.id !== undefined && message.id !== null) {
      if (message.method === "ping") this.respond(message.id, { result: {} });
      else this.respond(message.id, { error: { code: -32601, message: `Method not served by Oathrion: ${message.method}` } });
      return;
    }
    /* Une notification de l'enfant. */
    if (typeof message.method === "string") {
      if (message.method === "notifications/tools/list_changed") for (const listener of this.toolsChangedListeners) listener();
      return;
    }
    /* Une réponse. */
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : undefined;
      const text = typeof message.error.message === "string" ? message.error.message : "error without a message";
      pending.reject(new StdioCallError(`The MCP server refused "${pending.method}": ${text}`, "rpc_error", true, code));
      return;
    }
    pending.resolve(message.result ?? null);
  }

  private markExited(description: string): void {
    if (this.exitAnnounced) return;
    this.exitAnnounced = true;
    this.exited = true;
    this.exitDescription = description;
    this.failAll(
      new StdioCallError(
        `The MCP server stopped (${description}) before answering. The request went out: if it was a tool call, the action MAY have happened.`,
        "exited",
        true,
      ),
    );
    for (const listener of this.exitListeners) listener(description);
  }

  private failAll(error: StdioCallError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
