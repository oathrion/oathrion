/**
 * Le côté client du PIVOT LOCAL (`server/local-hub.ts`) : le trouver ou le lancer, s'y attacher.
 *
 * Un seul Oathrion par machine (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`), dans
 * `~/.oathrion/_local/`. Le premier relais (ou la première console) le lance DÉTACHÉ : il ne
 * meurt pas avec ce relais, il vit tant qu'un relais ou une console y bat, puis s'arrête seul.
 * Plusieurs relais qui démarrent ensemble n'en lancent qu'un (un verrou de démarrage).
 *
 * Chaque requête d'administration porte un ticket signé avec le secret de session du pivot,
 * lu dans `_local/session.secret` (0600) — le même que lit `oathrion console`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { mintLocalLoginTicket } from "@shared/local-login-ticket";

import type { ClientProgram } from "./client-identity";

import { localBundle, stateRoot } from "./launch";

/** Le dossier du pivot. Un nom de serveur ne peut pas commencer par « _ » : aucune collision. */
export const HUB_DIRNAME = "_local";

export function hubDir(env: NodeJS.ProcessEnv): string {
  return join(stateRoot(env), HUB_DIRNAME);
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

export interface HubConnection {
  base: string;
  dir: string;
  secret: string;
  /** Le pivot tournait déjà (il n'a pas été lancé par cet appel). */
  wasRunning: boolean;
  op<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<{ status: number; body: T | null }>;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

/** Le pivot répond-il, et est-ce bien LUI (et pas un autre serveur sur ce port) ? */
async function hubAnswers(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/local/login`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = (await response.json()) as { local?: unknown; hub?: unknown };
    return body.local === true && body.hub === true;
  } catch {
    return false;
  }
}

function readPort(dir: string): number {
  try {
    const port = Number(readFileSync(join(dir, "port"), "utf8").trim());
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
  } catch {
    return 0;
  }
}

function launcherAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function connection(dir: string, port: number, secret: string, wasRunning: boolean, confined = false): HubConnection {
  const base = `http://127.0.0.1:${String(port)}`;
  return {
    base,
    dir,
    secret,
    wasRunning,
    async op<T>(body: Record<string, unknown>) {
      const response = await fetch(`${base}/api/local/hub`, {
        method: "POST",
        /* Un relais enfermé (`oathrion jail`) signe avec le secret relais : le pivot ne lui permet que les gestes d'un relais. */
        headers: { "content-type": "application/json", accept: "application/json", [confined ? "x-oathrion-relay" : "x-oathrion-local"]: mintLocalLoginTicket(secret) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      let parsed: T | null = null;
      try {
        parsed = text ? (JSON.parse(text) as T) : null;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
  };
}

/**
 * DANS LA PRISON (`oathrion jail`, pièce J2 de `notes/CONCEPTION-JAIL.md`) : le dossier du pivot
 * n'y montre que son port, le secret RELAIS de cette prison (créé par le pivot pour elle seule)
 * et ce marqueur, en lecture seule. Le secret de la console n'y est pas : un agent enfermé ne
 * peut ni ouvrir la console, ni décider.
 */
export const JAIL_MARKER = "jailed";
export const RELAY_SECRET_FILE = "relay.secret";

/** Trouve le pivot, ou le lance. Plusieurs appelants à la fois n'en lancent qu'un. */
export async function ensureHub(env: NodeJS.ProcessEnv, options: { port?: number; log?: (line: string) => void } = {}): Promise<HubConnection> {
  const dir = hubDir(env);
  if (existsSync(join(dir, JAIL_MARKER))) {
    /* Enfermé : on ne lance jamais de pivot (il doit tourner dehors, près du coffre), on s'y rattache. */
    const running = readPort(dir);
    const relaySecret = existsSync(join(dir, RELAY_SECRET_FILE)) ? readFileSync(join(dir, RELAY_SECRET_FILE), "utf8").trim() : "";
    if (running && relaySecret && (await hubAnswers(`http://127.0.0.1:${String(running)}`))) return connection(dir, running, relaySecret, true, true);
    throw new Error("Oathrion is not running outside this jail. Quit the agent, and start it again with « oathrion jail -- <agent> ».");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secretFile = join(dir, "session.secret");
  if (!existsSync(secretFile)) {
    try {
      writeFileSync(secretFile, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
    } catch {
      /* un autre appelant l'a créé à l'instant */
    }
  }
  const secret = readFileSync(secretFile, "utf8").trim();

  const running = readPort(dir);
  if (running && (await hubAnswers(`http://127.0.0.1:${String(running)}`))) {
    if (hubIsStale(env, dir)) options.log?.(STALE_HUB_TEXT);
    return connection(dir, running, secret, true);
  }

  /* Le verrou de démarrage : un seul lanceur ; les autres attendent qu'il ait fini. */
  const lockFile = join(dir, "demarrage.pid");
  const deadline = Date.now() + 90_000;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lockFile, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(readFileSync(lockFile, "utf8").trim());
      if (!launcherAlive(holder)) {
        try {
          unlinkSync(lockFile);
        } catch {
          /* déjà retiré */
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`The local hub does not start (lock held by process ${String(holder)}). Log: ${join(dir, "oathrion.log")}`);
      await wait(200);
      const port = readPort(dir);
      if (port && (await hubAnswers(`http://127.0.0.1:${String(port)}`))) return connection(dir, port, secret, true);
      continue;
    }
    try {
      /* Peut-être lancé entre-temps par celui qui tenait le verrou avant nous. */
      const again = readPort(dir);
      if (again && (await hubAnswers(`http://127.0.0.1:${String(again)}`))) return connection(dir, again, secret, true);
      return await spawnHub(env, dir, secret, options);
    } finally {
      try {
        unlinkSync(lockFile);
      } catch {
        /* déjà retiré */
      }
    }
  }
}

/*
 * UN PIVOT PLUS ANCIEN QUE LE PAQUET INSTALLÉ (10 novembre : la quarantaine des agents de la
 * prison manquait, parce que le pivot tournait depuis avant la mise à jour). Le pivot reste
 * allumé tant qu'un agent ou la console y est rattaché : mettre Oathrion à jour ne le relance
 * pas. Au lancement, on note l'empreinte du paquet (taille, date) ; un appelant qui trouve une
 * autre empreinte, ou aucune (un pivot d'avant ce repère), le dit.
 */
const BUILD_FILE = "hub-build";
const bundlePrint = (env: NodeJS.ProcessEnv): string => {
  try {
    const stat = statSync(localBundle(env));
    return `${String(stat.size)}:${String(Math.round(stat.mtimeMs))}`;
  } catch {
    return "";
  }
};

export function hubIsStale(env: NodeJS.ProcessEnv, dir: string): boolean {
  const current = bundlePrint(env);
  if (current === "") return false;
  try {
    return readFileSync(join(dir, BUILD_FILE), "utf8").trim() !== current;
  } catch {
    return true;
  }
}

export const STALE_HUB_TEXT =
  "The local Oathrion running was started before Oathrion was updated: the new protections are not on yet. Quit your agents and close the console; it stops by itself, and the next start uses the new version.";

async function spawnHub(env: NodeJS.ProcessEnv, dir: string, secret: string, options: { port?: number; log?: (line: string) => void }): Promise<HubConnection> {
  const bundle = localBundle(env);
  if (!existsSync(bundle)) throw new Error(`The local server was not found (${bundle}). Build it first: npm run build.`);
  writeFileSync(join(dir, BUILD_FILE), bundlePrint(env), { mode: 0o600 });
  let port = options.port ?? readPort(dir);
  if (!port || !(await portIsFree(port))) port = options.port && !(await portIsFree(options.port)) ? 0 : await freePort();
  if (!port) throw new Error(`Port ${String(options.port)} is already taken.`);
  writeFileSync(join(dir, "port"), String(port), { mode: 0o600 });

  /* L'environnement du pivot : le strict nécessaire. Les jetons de la personne vont à chaque serveur, par son relais. */
  const knobs = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("OATHRION_LOCAL_HUB_") || key.startsWith("OATHRION_LOCAL_NOTIFY_") || key.startsWith("OATHRION_LOCAL_AGENT_")));
  /* La session graphique : sans elle, la notification de bureau ne peut rien afficher. */
  const desktopSession = Object.fromEntries(
    /* XAUTHORITY : sous Wayland, la clé d'XWayland, où s'ouvre la fenêtre de notification d'Oathrion (essai réel du 11 novembre). */
    ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP", "LANG"]
      .filter((key) => typeof env[key] === "string")
      .map((key) => [key, env[key] as string]),
  );
  const logFd = openSync(join(dir, "oathrion.log"), "a", 0o600);
  const child = spawn(process.execPath, [bundle], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      PATH: env.PATH ?? "",
      HOME: env.HOME ?? "",
      ...desktopSession,
      ...knobs,
      PORT: String(port),
      OATHRION_HOST: "127.0.0.1",
      OATHRION_DB: join(dir, "oathrion.db"),
      OATHRION_ACCOUNTS: "database",
      OATHRION_SESSION_SECRET: secret,
      OATHRION_LOCAL_STATE_DIR: dir,
      OATHRION_LOCAL_HUB: "1",
      /*
       * Le plafond de décisions du serveur d'équipe (120 par minute et par identité) protège
       * une capacité partagée ; ici, une seule personne. Un agent qui lit vite (des fichiers en
       * parallèle) l'atteignait et recevait « Too many requests » en plein travail (banc
       * d'endurance du pivot, 1er novembre). 20 par seconde arrête encore une boucle emballée.
       */
      RATE_LIMIT_DECISION: "1200",
    },
  });
  closeSync(logFd);
  let exited = false;
  child.once("exit", () => (exited = true));
  child.unref();
  options.log?.(`[oathrion wrap] local hub started (127.0.0.1:${String(port)}).`);

  const base = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  while (!(await hubAnswers(base))) {
    if (exited) throw new Error(`The local hub stopped while starting. Log: ${join(dir, "oathrion.log")}`);
    if (Date.now() > deadline) throw new Error(`The local hub is not ready after 60 s. Log: ${join(dir, "oathrion.log")}`);
    await wait(150);
  }
  /* La base (approbations, règles) : lisible par la seule personne, comme le reste du dossier. */
  for (const file of ["oathrion.db", "oathrion.db-wal", "oathrion.db-shm"]) {
    try {
      chmodSync(join(dir, file), 0o600);
    } catch {
      /* pas encore créé */
    }
  }
  return connection(dir, port, secret, false);
}

/** La session d'un porteur : un relais pour son serveur, ou une console. */
export class HubSession {
  private holder = "";
  private server: Record<string, unknown> | null = null;
  private client: { name: string; approver: boolean; program: ClientProgram | null } | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private conn: HubConnection,
    private readonly kind: "relay" | "console",
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  get connection(): HubConnection {
    return this.conn;
  }

  /**
   * Se rattache. Un pivot qui s'arrête à cet instant (503, ou plus de réponse) : on en retrouve
   * un — ou on en lance un neuf — et on réessaie, quelques secondes.
   */
  async attach(): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const answer = await this.conn.op<{ holder: string }>({ op: "attach", kind: this.kind }).catch(() => null);
      if (answer?.status === 200 && answer.body?.holder) {
        this.holder = answer.body.holder;
        return;
      }
      if (Date.now() > deadline) throw new Error(`The local hub refuses to attach you (${String(answer?.status ?? "no answer")}).`);
      await wait(250);
      this.conn = await ensureHub(this.env);
    }
  }

  /** Inscrit le serveur (le pivot le lance s'il ne tourne pas). */
  async attachServer(spec: { name: string; command: string; args: readonly string[]; cwd?: string; env: NodeJS.ProcessEnv }): Promise<ServerSummary> {
    const env = Object.fromEntries(Object.entries(spec.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    this.server = { name: spec.name, command: spec.command, args: [...spec.args], cwd: spec.cwd, env };
    const answer = await this.conn.op<{ summary?: ServerSummary; error?: string }>({ op: "server", holder: this.holder, server: this.server });
    if (answer.status !== 200 || !answer.body?.summary) throw new Error(answer.body?.error ?? `The local hub could not start "${spec.name}" (${String(answer.status)}).`);
    return answer.body.summary;
  }

  /** « Décider une fois », pour toujours : le pivot sort ce verbe d'écriture de l'approbation. */
  async grantAlways(server: string, verb: string, origin: string): Promise<{ ok: true; policyId: string } | { ok: false; message: string }> {
    const answer = await this.conn.op<{ policyId?: string; error?: string }>({ op: "accord", holder: this.holder, server, verb, origin });
    return answer.status === 200 && answer.body?.policyId ? { ok: true, policyId: answer.body.policyId } : { ok: false, message: answer.body?.error ?? `the hub answered ${String(answer.status)}` };
  }

  /** La clé de l'agent du client (et la clé d'approbation, si demandée). */
  /**
   * La clé de l'agent du client — ou, si le programme qui a lancé ce relais n'est pas encore
   * confirmé, sa mise en quarantaine (`server/local-programs.ts`) : pas de clé.
   */
  async clientKey(
    name: string,
    approver: boolean,
    program: ClientProgram | null = null,
  ): Promise<{ agentToken: string; approverToken: string | null; agentName: string } | { quarantined: "pending" | "blocked"; program: string }> {
    this.client = { name, approver, program };
    const answer = await this.conn.op<{ agentToken?: string; approverToken?: string | null; agentName?: string; quarantined?: "pending" | "blocked"; program?: string; error?: string }>({
      op: "client",
      holder: this.holder,
      client: name,
      approver,
      ...(program ? { program } : {}),
    });
    if (answer.status === 200 && answer.body?.quarantined) return { quarantined: answer.body.quarantined, program: answer.body.program ?? name };
    if (answer.status !== 200 || !answer.body?.agentToken) throw new Error(answer.body?.error ?? `The local hub gave no key (${String(answer.status)}).`);
    return { agentToken: answer.body.agentToken, approverToken: answer.body.approverToken ?? null, agentName: answer.body.agentName ?? name };
  }

  /** Les outils du serveur de ce relais, sans clé (pour un programme en quarantaine). */
  async previewTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    const answer = await this.conn.op<{ tools?: { name: string; description?: string; inputSchema?: unknown }[] }>({ op: "preview-tools", holder: this.holder });
    return answer.status === 200 && Array.isArray(answer.body?.tools) ? answer.body.tools : [];
  }

  async status(): Promise<{ servers: string[]; holders: number }> {
    const answer = await this.conn.op<{ servers?: string[]; holders?: number }>({ op: "status" });
    return { servers: answer.body?.servers ?? [], holders: answer.body?.holders ?? 0 };
  }

  /**
   * Bat toutes les `everyMs`. Un pivot qui ne connaît plus ce porteur (expiré pendant une
   * veille de la machine) ou qui ne répond plus (arrêté) : on le retrouve, ou on le relance,
   * on se rattache, et `onRenewed` reçoit les nouvelles clés.
   *
   * La reprise va JUSQU'AU BOUT : rattaché, serveur réinscrit, clés neuves. Vu le 5 novembre
   * après deux heures de veille : rattaché, mais le serveur (`npx -y`, réseau pas encore revenu)
   * a mis 74 s à démarrer, le pivot a abandonné à 60 s ; le battement suivant répondait 204, le
   * relais se croyait rétabli et gardait sa clé révoquée — un 401 à chaque appel, pour toujours.
   * Tant qu'une étape manque, chaque battement la refait.
   */
  startHeartbeat(onRenewed: (keys: { agentToken: string; approverToken: string | null } | null) => void, everyMs = Number(this.env.OATHRION_LOCAL_HUB_BEAT_MS) || 10_000): void {
    if (this.beat) return;
    let busy = false;
    let unfinished = false;
    this.beat = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          const answer = await this.conn.op({ op: "heartbeat", holder: this.holder }).catch(() => null);
          const known = answer !== null && answer.status === 204;
          if (known && !unfinished) return;
          unfinished = true;
          if (!known) {
            /* Le pivot répond mais a oublié ce porteur : on s'y rattache ; sinon, on le retrouve ou le relance. */
            if (answer === null || answer.status >= 500) this.conn = await ensureHub(this.env);
            await this.attach();
          }
          if (this.server) {
            const answerServer = await this.conn.op({ op: "server", holder: this.holder, server: this.server });
            if (answerServer.status !== 200) throw new Error(`re-registration refused (${String(answerServer.status)})`);
          }
          const renewed = this.client ? await this.clientKey(this.client.name, this.client.approver, this.client.program) : null;
          /* Un programme mis en quarantaine entre-temps (bloqué dans la console) : plus de clé. */
          onRenewed(renewed === null || "quarantined" in renewed ? null : renewed);
          unfinished = false;
        } catch {
          /* on réessaiera au battement suivant */
        } finally {
          busy = false;
        }
      })();
    }, everyMs);
    this.beat.unref?.();
  }

  /** Part : ses clés sont révoquées. Sans attendre plus de 3 s. */
  async detach(): Promise<void> {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    if (!this.holder) return;
    await Promise.race([this.conn.op({ op: "detach", holder: this.holder }).catch(() => null), wait(3_000)]);
    this.holder = "";
  }
}
