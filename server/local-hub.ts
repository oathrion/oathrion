/**
 * LE PIVOT LOCAL : un seul Oathrion par machine, pour tous les serveurs MCP enveloppés et tous
 * les clients (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`).
 *
 *   · les SERVEURS s'inscrivent à la demande d'un relais : le pivot lance l'enfant (avec
 *     l'environnement de la personne, sans rien d'Oathrion), épingle ses outils, ajoute ses
 *     règles par défaut. Deux relais qui enveloppent le même serveur (même nom, même commande)
 *     partagent le même enfant ; un nom déjà pris par une autre commande est refusé ;
 *   · les CLIENTS reçoivent chacun leur agent (« Cursor », « claude-code ») et, par relais, une
 *     clé liée à cet agent, révoquée quand le relais part ;
 *   · les PORTEURS (relais, consoles) battent toutes les 10 s ; un porteur muet depuis 30 s est
 *     détaché ; un serveur que plus aucun porteur ne porte est arrêté (le client suivant le
 *     relance frais, avec SON environnement) ; sans porteur pendant `idleMs`, le pivot s'arrête.
 *
 * Ce module ne décide rien : tout appel d'outil passe par la passerelle, comme avant.
 */
import { DecisionDesk } from "./local-decisions";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OrganizationId } from "@shared/tenancy";

import { registerClaudeHandoff } from "./gateway/tools/claude-handoff-tool";
import { launchWrappedServer, unregisterWrappedServer, type StdioMcpTool } from "./gateway/tools/stdio-mcp-tool";
import { childEnvironment, ensureClientAgent, ensureLocalSpace, ensureServerPolicies, grantToolAlways, issueAgentKey, issueApproverKey, revokeLocalKey } from "./local-bootstrap";
import { selectAcceptedTools } from "./local-pins";
import { AgentWatch, OutsideAllowances, type RunningAgent } from "./local-agent-watch";
import { LocalPrograms, describeIdentity, type KnownProgram, type ProgramIdentity } from "./local-programs";
import { LocalEvents } from "./local-events";
import { MascotChoices } from "./local-mascot-choices";
import { Tripwire, type TripEvent } from "./local-tripwire";

export interface ServerSpec {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  /** L'environnement de la personne (ses jetons) ; ce qui est à Oathrion en est retiré. */
  env: Record<string, string>;
}

export interface ServerSummary {
  name: string;
  child: { name?: string; version?: string };
  classes: { read: number; write: number; destructive: number };
  readByName: string[];
  held: { name: string; status: string; changedFields: string[] }[];
  firstLaunch: boolean;
  createdPolicies: string[];
}

interface HubServer {
  spec: ServerSpec;
  tool: StdioMcpTool;
  summary: ServerSummary;
  /** Qui l'a lancé : un relais (son client), ou une console sans client (l'environnement de son terminal). */
  launchedBy: Holder["kind"];
}

interface Holder {
  kind: "relay" | "console";
  /** Les serveurs qu'il porte (un relais : le sien ; une console : ceux qu'elle a relancés). */
  servers: Set<string>;
  keyIds: string[];
  lastSeen: number;
  /** Un lancement de serveur en cours pour lui : il attend, il ne se tait pas (§5.60). */
  busy: number;
  /** L'agent de son client, et si ce client pose lui-même la question d'approbation. */
  agentId?: string;
  asksInClient?: boolean;
}

export class ServerConflictError extends Error {}
export class HubClosingError extends Error {}

let active: LocalHub | null = null;

/** Le pivot de ce processus, s'il en est un (mode local, sans serveur fixé au démarrage). */
export function activeHub(): LocalHub | null {
  return active;
}

export function activateHub(hub: LocalHub | null): void {
  active = hub;
}

const sameCommand = (a: ServerSpec, b: ServerSpec) => a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);

/** Le même environnement, tel que l'enfant le verrait (ce qui est à Oathrion en est retiré). */
const sameEnvironment = (a: ServerSpec, b: ServerSpec) => {
  const seen = (spec: ServerSpec) => JSON.stringify(Object.entries(childEnvironment(spec.env)).sort(([x], [y]) => x.localeCompare(y)));
  return seen(a) === seen(b);
};


/** Une carte à partager : la phrase (rien de privé), la mascotte, le moment. */
export interface ShareCard {
  sentence: string;
  mascot: { id: string; name: string };
  at: string;
  tone: "good" | "warn" | "bad" | "info";
}

export class LocalHub {
  private readonly servers = new Map<string, HubServer>();
  private readonly launching = new Map<string, Promise<HubServer>>();
  private readonly holders = new Map<string, Holder>();
  private readonly organizationId: OrganizationId;
  private emptySince: number | null = Date.now();
  /** Le pivot a décidé de s'arrêter : plus aucun rattachement (le client en lancera un neuf). */
  private closing = false;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly stateDir: string,
    private readonly options: { holderTimeoutMs?: number; idleMs?: number; childTimeoutMs?: number; now?: () => number } = {},
  ) {
    this.organizationId = ensureLocalSpace().organizationId;
    /*
     * Le passage de relais du hook Claude Code, inscrit DÈS le démarrage : une demande créée par
     * un pivot précédent, approuvée dans la console d'un pivot relancé, doit trouver son outil.
     */
    registerClaudeHandoff();
  }

  /** Le dossier d'état du pivot (`~/.oathrion/_local`). */
  /** Les programmes que ce pivot connaît : seul un programme confirmé reçoit une clé. */
  get programs(): LocalPrograms {
    this.knownPrograms ??= new LocalPrograms(this.stateDir);
    return this.knownPrograms;
  }

  private knownPrograms: LocalPrograms | null = null;
  /** Prévenir la personne d'un programme jamais vu (la notification de bureau, `local-entry.ts`). */
  onUnknownProgram: ((program: { id: string; name: string; description: string; title?: string }) => void) | null = null;
  /** `oathrion demo` : montrer la notification, sur rien de réel (`local-entry.ts`). Rend ce qui a été montré, ou pourquoi rien. */
  onDemo: ((kind: "pause" | "decoy") => { shown: boolean; detail: string }) | null = null;
  private readonly announced = new Map<string, number>();

  get dir(): string {
    return this.stateDir;
  }

  get organization(): OrganizationId {
    return this.organizationId;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get isClosing(): boolean {
    return this.closing;
  }

  /**
   * Décide l'arrêt, s'il n'y a toujours personne. Synchrone : un rattachement qui arrive après
   * est refusé (503), jamais accepté par un pivot qui va mourir.
   */
  beginClosing(): boolean {
    if (this.holders.size > 0) return false;
    this.closing = true;
    return true;
  }

  /** Un porteur de plus : un relais (pour un serveur) ou une console. */
  attachHolder(kind: Holder["kind"]): string {
    if (this.closing) throw new HubClosingError("The local hub is stopping: start again, and a new hub will start.");
    const id = `porteur_${randomBytes(9).toString("base64url")}`;
    this.holders.set(id, { kind, servers: new Set(), keyIds: [], lastSeen: this.now(), busy: 0 });
    this.emptySince = null;
    return id;
  }

  /** Inscrit le serveur d'un relais (le lance s'il ne tourne pas), et l'y rattache. */
  async attachServer(holderId: string, spec: ServerSpec): Promise<ServerSummary> {
    const holder = this.requireHolder(holderId);
    const running = this.servers.get(spec.name);
    if (running && !sameCommand(running.spec, spec)) {
      throw new ServerConflictError(
        `The name "${spec.name}" is already taken by another command (${[running.spec.command, ...running.spec.args].join(" ")}). Choose another --name.`,
      );
    }
    /* Le porter AVANT d'attendre le lancement : un départ d'autrui pendant ce temps ne l'arrête pas. */
    holder.servers.add(spec.name);
    holder.busy += 1;
    try {
      let server = running ?? (await this.launch(spec, holder.kind));
      /*
       * UN SERVEUR LANCÉ PAR LA CONSOLE CÈDE LA PLACE AU CLIENT, et c'est une correction.
       *
       * Client fermé, `oathrion console` relance les serveurs connus avec l'environnement de SON
       * terminal : `commande.json` ne garde jamais celui du client, il porte les jetons. Le client
       * qui arrivait ensuite réutilisait ce processus, la commande étant la même : ses variables
       * n'arrivaient jamais. Relevé en essayant Claude Code de bout en bout le 5 novembre :
       * `MEMORY_FILE_PATH` perdu, et un `GITHUB_PERSONAL_ACCESS_TOKEN` l'aurait été de même.
       *
       * Le relais relance donc le serveur avec SON environnement, s'il diffère — sauf pendant un
       * appel en cours, que l'arrêt ferait échouer : on garde alors celui qui tourne.
       */
      if (server.launchedBy === "console" && holder.kind === "relay" && !sameEnvironment(server.spec, spec) && !server.tool.busy) {
        await this.stopServer(spec.name);
        server = await this.launch(spec, holder.kind);
      }
      return server.summary;
    } catch (error) {
      holder.servers.delete(spec.name);
      throw error;
    } finally {
      holder.busy -= 1;
      holder.lastSeen = this.now();
    }
  }

  private launch(spec: ServerSpec, launchedBy: Holder["kind"]): Promise<HubServer> {
    const pending = this.launching.get(spec.name);
    if (pending) return pending;
    const started = (async () => {
      const serverDir = join(this.stateDir, "serveurs", spec.name);
      mkdirSync(serverDir, { recursive: true, mode: 0o700 });
      /* La commande, pour qu'`oathrion console` puisse relancer ce serveur client fermé. Jamais son environnement : il porte les jetons. */
      writeFileSync(join(serverDir, "commande.json"), `${JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd })}\n`, { mode: 0o600 });
      let held: ServerSummary["held"] = [];
      let firstLaunch = false;
      const tool = await launchWrappedServer({
        name: spec.name,
        command: spec.command,
        args: spec.args,
        env: childEnvironment(spec.env),
        cwd: spec.cwd,
        timeoutMs: this.options.childTimeoutMs ?? 60_000,
        select: (declared) => {
          const selection = selectAcceptedTools(spec.name, serverDir, declared);
          held = selection.held;
          firstLaunch = selection.firstLaunch;
          return selection.accepted;
        },
      });
      const entries = tool.entries();
      const classes = { read: 0, write: 0, destructive: 0 };
      for (const entry of entries) classes[entry.toolClass] += 1;
      const createdPolicies = await ensureServerPolicies(this.organizationId, spec.name, entries);
      const info = tool.childInfo;
      const server: HubServer = {
        spec,
        launchedBy,
        tool,
        summary: {
          name: spec.name,
          child: { name: info.name, version: info.version },
          classes,
          readByName: entries.filter((entry) => entry.readBasis === "name").map((entry) => entry.original),
          held,
          firstLaunch,
          createdPolicies,
        },
      };
      this.servers.set(spec.name, server);
      return server;
    })();
    this.launching.set(spec.name, started);
    return started.finally(() => this.launching.delete(spec.name));
  }

  /**
   * La clé d'un relais pour SON client : l'agent du client, créé au besoin — mais seulement si
   * le PROGRAMME qui l'a lancé est connu et confirmé. Sinon, aucune clé : le relais le dit à
   * l'agent, et réessaie quand la personne a décidé dans la console.
   */
  async issueClientKey(
    holderId: string,
    client: string,
    identity: ProgramIdentity | null = null,
  ): Promise<{ key: string; agentId: string; agentName: string } | { quarantined: "pending" | "blocked"; program: KnownProgram; description: string }> {
    const holder = this.requireHolder(holderId);
    const admitted = this.admitProgram(client, identity);
    if ("quarantined" in admitted) return admitted;
    const { agentId, name } = await ensureClientAgent(this.organizationId, client);
    const { keyId, key } = issueAgentKey(this.organizationId, agentId, [...holder.servers][0] ?? name);
    holder.keyIds.push(keyId);
    holder.agentId = agentId;
    holder.asksInClient = false;
    return { key, agentId, agentName: name };
  }

  /**
   * Ce programme est-il confirmé ? Un programme jamais vu est inscrit en attente, et la personne
   * prévenue (une fois par dix minutes au plus). Pour un client MCP (`issueClientKey`), et pour
   * l'agent qu'`oathrion jail` va lancer, AVANT de le lancer (`jail-open`) : un agent sans
   * serveur MCP n'échappe plus à la quarantaine (10 novembre, `agy`).
   */
  admitProgram(name: string, identity: ProgramIdentity | null, title?: string): { trusted: KnownProgram } | { quarantined: "pending" | "blocked"; program: KnownProgram; description: string } {
    const program = this.programs.observe(name, identity);
    if (program.status === "trusted") return { trusted: program };
    const description = describeIdentity(program);
    const last = this.announced.get(program.id) ?? 0;
    if (program.status === "pending" && this.now() - last > 600_000) {
      this.announced.set(program.id, this.now());
      this.onUnknownProgram?.({ id: program.id, name: program.name, description, ...(title ? { title } : {}) });
    }
    return { quarantined: program.status, program, description };
  }

  /**
   * Les outils du serveur de ce relais, tels qu'un agent admis les verrait (les destructeurs et
   * les définitions retenues mis à part) : montrés à un programme en quarantaine, pour que son
   * appel puisse ATTENDRE la décision de la personne au lieu d'échouer (9 novembre).
   */
  previewTools(holderId: string): { name: string; description?: string; inputSchema?: unknown }[] {
    const holder = this.requireHolder(holderId);
    const server = this.servers.get([...holder.servers][0] ?? "");
    if (!server) return [];
    const held = new Set(server.summary.held.map((h) => h.name));
    return server.tool
      .entries()
      .filter((entry) => entry.toolClass !== "destructive" && !held.has(entry.original))
      .map((entry) => ({ name: entry.original, ...(entry.description ? { description: entry.description } : {}), inputSchema: entry.inputSchema ?? { type: "object", properties: {} } }));
  }

  /*
   * LES SERVEURS QU'UN AGENT ENFERMÉ PEUT DEMANDER (pièce J2 de `notes/CONCEPTION-JAIL.md`). Le
   * pivot tourne hors de la prison, près du coffre : s'il lançait n'importe quelle commande
   * demandée par un relais enfermé, l'agent s'évaderait par lui. Un relais enfermé ne peut donc
   * faire lancer QUE la commande exacte d'un serveur déjà connu : déclaré par un relais du dehors,
   * ou par `oathrion jail` en lisant la configuration des clients (`servers.json`).
   */
  private registryFile(): string {
    return join(this.stateDir, "servers.json");
  }

  knownServers(): Record<string, { command: string; args: string[] }> {
    try {
      return JSON.parse(readFileSync(this.registryFile(), "utf8")) as Record<string, { command: string; args: string[] }>;
    } catch {
      return {};
    }
  }

  rememberServer(name: string, command: string, args: readonly string[]): void {
    const known = this.knownServers();
    known[name] = { command, args: [...args] };
    writeFileSync(this.registryFile(), `${JSON.stringify(known, null, 2)}\n`, { mode: 0o600 });
  }

  /*
   * LES PRISONS OUVERTES (`oathrion jail`). Chacune a son secret relais, créé ici à la demande
   * d'`oathrion jail` (dehors, avec le secret de session), lié à l'identité du programme qu'il
   * lance, relevée DEHORS : un relais enfermé ne choisit pas qui il est. Ses porteurs sont à elle
   * seule : un relais enfermé ne touche pas à ceux des autres. Rien n'est écrit sur le disque :
   * un pivot relancé ne connaît plus aucune prison, et leurs relais sont refusés.
   */
  private readonly jails = new Map<string, { identity: ProgramIdentity | null; holders: Set<string>; pids: Set<number> }>();

  openJail(identity: ProgramIdentity | null): string {
    const secret = randomBytes(32).toString("base64url");
    this.jails.set(secret, { identity, holders: new Set(), pids: new Set() });
    return secret;
  }

  /** Le processus d'une prison (le `bwrap` lancé par `oathrion jail`) : ce qui en descend est enfermé. */
  jailStarted(secret: string, pid: number): boolean {
    const jail = this.jails.get(secret);
    if (!jail || !Number.isInteger(pid) || pid <= 1) return false;
    jail.pids.add(pid);
    return true;
  }

  jailPids(): Set<number> {
    return new Set([...this.jails.values()].flatMap((jail) => [...jail.pids]));
  }

  /*
   * LA VEILLE DES AGENTS (`server/local-agent-watch.ts`) : les agents qui tournent hors d'une
   * prison sont signalés, sauf ceux que la personne a autorisés là.
   */
  private watch: AgentWatch | null = null;

  /** Le journal des événements du pivot, pour le fil d'actualité (`local-events.ts`). */
  get events(): LocalEvents {
    this.eventsStore ??= new LocalEvents(this.stateDir);
    return this.eventsStore;
  }

  private eventsStore: LocalEvents | null = null;

  /** La mascotte et le nom que la personne a donnés à chaque agent (`local-mascot-choices.ts`). */
  get mascots(): MascotChoices {
    this.mascotStore ??= new MascotChoices(this.stateDir);
    return this.mascotStore;
  }

  private mascotStore: MascotChoices | null = null;

  /*
   * LES CARTES À PARTAGER depuis la notification (11 novembre, essai réel : l'image copiée par la
   * fenêtre, sous X11, n'arrivait pas dans Chrome, sous Wayland). La notification ouvre la carte
   * dans la console ; Chrome la copie lui-même, puis ouvre le réseau. Un jeton par carte, en
   * mémoire ; les 50 dernières seulement. Rien de privé : la phrase du fil, la mascotte.
   */
  private readonly shareCards = new Map<string, ShareCard>();

  keepShareCard(card: ShareCard): string {
    const token = randomBytes(12).toString("hex");
    this.shareCards.set(token, card);
    while (this.shareCards.size > 50) this.shareCards.delete(this.shareCards.keys().next().value!);
    return token;
  }

  shareCard(token: string): ShareCard | null {
    return this.shareCards.get(token) ?? null;
  }

  /** Les décisions que « Decide » ouvre dans la console (macOS, Windows : `local-decisions.ts`). */
  readonly decisions = new DecisionDesk();

  get outsideAllowances(): OutsideAllowances {
    this.allowancesStore ??= new OutsideAllowances(this.stateDir);
    return this.allowancesStore;
  }

  private allowancesStore: OutsideAllowances | null = null;

  startAgentWatch(onOutside: (agent: RunningAgent) => void, intervalMs?: number): void {
    if (this.watch) return;
    this.watch = new AgentWatch({ jailPids: () => this.jailPids(), allowances: this.outsideAllowances, onOutside, intervalMs });
    this.watch.start();
  }

  /*
   * LE FIL-PIÈGE DES LEURRES (`server/local-tripwire.ts`) : un leurre lu, par qui que ce soit,
   * la personne est prévenue. Les leurres sont ceux du registre d'`oathrion decoys plant`.
   */
  private tripwire: Tripwire | null = null;

  decoyFiles(): string[] {
    try {
      const registry = JSON.parse(readFileSync(join(this.stateDir, "decoys.json"), "utf8")) as { files?: { path?: unknown }[] };
      return (registry.files ?? []).map((f) => f.path).filter((p): p is string => typeof p === "string");
    } catch {
      return [];
    }
  }

  startTripwire(onTrip: (event: TripEvent) => void, intervalMs?: number): void {
    if (this.tripwire) return;
    this.tripwire = new Tripwire({ files: () => this.decoyFiles(), onTrip, intervalMs });
    this.tripwire.start();
  }

  /** Les dernières lectures d'un leurre, la plus récente d'abord. */
  tripEvents(): TripEvent[] {
    return this.tripwire?.events() ?? [];
  }

  /** Repris pour cette fois seulement (depuis la notification) : ce lancement-là, pas les suivants. */
  allowLaunchOnce(launch: string): void {
    this.watch?.allowOnce(launch);
  }

  isAllowedOnce(launch: string): boolean {
    return this.watch?.isAllowedOnce(launch) ?? false;
  }

  /** Une autorisation retirée : l'agent qui tourne encore dehors sera signalé de nouveau. */
  forgetSignalled(exe: string): void {
    this.watch?.forget(exe);
  }

  /** Les agents du dernier balayage (vide si la veille ne tourne pas). */
  runningAgents(): RunningAgent[] {
    return this.watch?.running() ?? [];
  }

  /** Un nouveau balayage, tout de suite (avant d'arrêter un agent : il doit être là, et hors prison). */
  rescanAgents(): RunningAgent[] {
    return this.watch?.scan() ?? [];
  }

  closeJail(secret: string): void {
    const jail = this.jails.get(secret);
    if (!jail) return;
    for (const holder of jail.holders) this.detach(holder, "prison refermée");
    this.jails.delete(secret);
  }

  jailSecrets(): string[] {
    return [...this.jails.keys()];
  }

  jail(secret: string): { identity: ProgramIdentity | null; holders: Set<string> } | null {
    return this.jails.get(secret) ?? null;
  }

  /** La commande exacte d'un serveur connu ? Sinon, un relais enfermé ne peut pas la faire lancer. */
  knownServer(name: string, command: string, args: readonly string[]): boolean {
    const known = this.knownServers()[name];
    return known !== undefined && known.command === command && known.args.length === args.length && known.args.every((arg, i) => arg === args[i]);
  }

  /** L'environnement d'un serveur lancé pour un relais enfermé : le strict nécessaire, et ses jetons gardés au coffre. */
  confinedServerEnv(name: string): Record<string, string> {
    let sealed: Record<string, string> = {};
    try {
      sealed = (JSON.parse(readFileSync(join(this.stateDir, "server-secrets", `${name.replace(/[^a-z0-9_-]/gi, "_")}.json`), "utf8")) as { env?: Record<string, string> }).env ?? {};
    } catch {
      /* un serveur sans jeton */
    }
    return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...sealed };
  }

  /** La clé d'approbation d'un relais dont le client pose la question, révoquée avec lui. */
  issueApproverKey(holderId: string): string {
    const holder = this.requireHolder(holderId);
    const { keyId, key } = issueApproverKey(this.organizationId);
    holder.keyIds.push(keyId);
    holder.asksInClient = true;
    return key;
  }

  /** Un relais de cet agent pose-t-il la question dans son client ? (La notification attend alors.) */
  asksInClient(agentId: string | null | undefined): boolean {
    if (!agentId) return false;
    for (const holder of this.holders.values()) if (holder.agentId === agentId && holder.asksInClient === true) return true;
    return false;
  }

  /** La classe d'un outil d'un serveur de ce pivot (`mcp.<serveur>.<outil>`) : read, write, destructive ; `null` inconnu. */
  toolClassOf(action: string): string | null {
    const server = /^mcp\.([a-z0-9][a-z0-9_-]*)\./.exec(action)?.[1];
    if (!server) return null;
    return this.servers.get(server)?.tool.entries().find((candidate) => candidate.verb === action)?.toolClass ?? null;
  }

  /**
   * « Décider une fois », pour toujours : seulement pour une ÉCRITURE d'un serveur de ce pivot.
   * Une lecture n'en a pas besoin ; une destruction demande une personne à chaque fois.
   */
  async grantAlways(server: string, verb: string, origin: string): Promise<string> {
    const running = this.servers.get(server);
    const entry = running?.tool.entries().find((candidate) => candidate.verb === verb);
    if (!entry) throw new Error(`"${verb}" is not a tool of the "${server}" server.`);
    if (entry.toolClass !== "write") throw new Error(`"${entry.original}" is classed "${entry.toolClass}": only a write can be allowed once and for all.`);
    return grantToolAlways(this.organizationId, server, verb, origin);
  }

  /** Un battement. `false` : ce porteur n'est plus connu (expiré) — il doit se rattacher. */
  heartbeat(holderId: string): boolean {
    const holder = this.holders.get(holderId);
    if (!holder) return false;
    holder.lastSeen = this.now();
    return true;
  }

  /** Le porteur part : ses clés sont révoquées, et les serveurs que plus personne ne porte sont arrêtés. */
  detach(holderId: string, reason = "relais parti"): void {
    const holder = this.holders.get(holderId);
    if (!holder) return;
    for (const keyId of holder.keyIds) revokeLocalKey(this.organizationId, keyId, reason);
    this.holders.delete(holderId);
    if (this.holders.size === 0) this.emptySince = this.now();
    for (const name of holder.servers) if (!this.isCarried(name)) void this.stopServer(name);
  }

  private isCarried(name: string): boolean {
    for (const holder of this.holders.values()) if (holder.servers.has(name)) return true;
    return this.launching.has(name);
  }

  private async stopServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    this.servers.delete(name);
    unregisterWrappedServer(name);
    await server.tool.shutdown();
  }

  /** Détache les porteurs muets ; dit si le pivot est sans porteur depuis assez longtemps. */
  sweep(): { expired: string[]; idle: boolean } {
    const timeout = this.options.holderTimeoutMs ?? 30_000;
    const expired: string[] = [];
    for (const [id, holder] of this.holders) {
      /* Un porteur qui attend le lancement de son serveur (un `npx` lent) n'est pas muet. */
      if (holder.busy === 0 && this.now() - holder.lastSeen > timeout) {
        this.detach(id, "relais muet");
        expired.push(id);
      }
    }
    const idle = this.holders.size === 0 && this.emptySince !== null && this.now() - this.emptySince >= (this.options.idleMs ?? 30_000);
    return { expired, idle };
  }

  /** Balaye toutes les `everyMs` ; `onIdle` quand plus personne n'est là. */
  startSweeping(onIdle: () => void, everyMs = 5_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      if (this.sweep().idle && this.beginClosing()) onIdle();
    }, everyMs);
    this.sweeper.unref?.();
  }

  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  /** Pour l'écran « Serveurs » : chaque serveur, ce qu'il expose, et les agents (clients) qui le portent. */
  serverStates(): { name: string; child: ServerSummary["child"]; classes: ServerSummary["classes"]; agentIds: string[] }[] {
    return [...this.servers.values()].map(({ spec, summary }) => {
      const agentIds = new Set<string>();
      for (const holder of this.holders.values()) if (holder.kind === "relay" && holder.agentId && holder.servers.has(spec.name)) agentIds.add(holder.agentId);
      return { name: spec.name, child: summary.child, classes: summary.classes, agentIds: [...agentIds] };
    });
  }

  holderCount(): number {
    return this.holders.size;
  }

  /**
   * Ce pivot peut-il laisser la place à un neuf, tout de suite (après une mise à jour) ? Oui s'il
   * ne sert aucun relais ni aucune prison : les consoles et la veille se rattachent seules.
   */
  canRetire(): boolean {
    return this.jails.size === 0 && [...this.holders.values()].every((holder) => holder.kind === "console");
  }

  /** Arrête tous les enfants, révoque toutes les clés. */
  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.watch?.stop();
    this.tripwire?.stop();
    for (const id of [...this.holders.keys()]) this.detach(id, "hub stopping");
    for (const name of [...this.servers.keys()]) await this.stopServer(name);
  }

  private requireHolder(holderId: string): Holder {
    const holder = this.holders.get(holderId);
    if (!holder) throw new Error("This relay is no longer attached to the hub: it must attach again.");
    holder.lastSeen = this.now();
    return holder;
  }
}
