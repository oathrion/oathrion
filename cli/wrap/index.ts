/**
 * `oathrion wrap` — Oathrion en une commande, devant n'importe quel serveur MCP.
 *
 *     oathrion wrap [--name <nom>] [--port <port>] -- <commande du serveur> [arguments…]
 *
 * Dans la configuration MCP du client, on remplace la commande du serveur par celle-ci :
 *
 *     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
 *     { "command": "oathrion", "args": ["wrap", "--", "npx", "-y", "@modelcontextprotocol/server-github"] }
 *
 * Voir `notes/CONCEPTION-OATHRION-WRAP.md`. Ce fichier ne fait qu'assembler : lancer
 * l'Oathrion local (`launch.ts`), puis relayer la sortie et l'entrée standard (`relay.ts`).
 */

import { join } from "node:path";
import { createInterface } from "node:readline";

import { clientProgram, type ClientProgram } from "./client-identity";
import { loadDecoys } from "./decoys";
import { guardedTokenIn, loadGuardedTokens, recordServerTokens, serverTokens } from "./guarded-tokens";
import { loadSealedEnv } from "./server-secrets";
import { ensureHub, HubSession, type ServerSummary } from "./hub";
import { flagName } from "./install";
import { remoteUrlProblem } from "./bridge";
import { deriveRemoteName, deriveServerName, nameProblem } from "./name";
import { stateRoot } from "./launch";
import { DEFAULT_APPROVAL_WAIT_MS, McpRelay } from "./relay";

export const WRAP_USAGE = `
oathrion wrap — govern an MCP server, in one command

  oathrion wrap [--name <name>] [--port <port>] [--wait <seconds>] [--approval console]
                -- <server command> [arguments…]
  oathrion wrap [options…] --url <https://…> [--transport http|sse]
                a remote server; its headers (a token) in MCP_REMOTE_HEADERS (JSON)

  Reads go through, writes wait for your approval, destructive tools are blocked.
  Every executed action leaves a receipt in Oathrion's chain.
  Data: ~/.oathrion/<name>/.

  --wait       how many seconds a held write waits for your approval within the same
               call (50 by default, under the clients' timeout: Cursor gives up on a
               call after about 60 s; 0: return "held" at once).
  --approval   where you decide. By default, in your MCP client when it can ask
               (elicitation: Claude Code), with a "Yes, I approve" box to tick, and the
               console as a fallback; otherwise in the console. "console": only in the
               console. ("client" is accepted: it is the default.)
`;

interface WrapArgs {
  name: string;
  port?: number;
  approvalWaitMs: number;
  /** « auto » : dans le client s'il sait poser la question, sinon dans la console. */
  approval: "auto" | "console";
  command: string;
  args: string[];
  /** Un serveur distant : le pivot lance le pont (`oathrion pont`) à sa place. */
  remote?: { url: string; transport: "http" | "sse" };
}

export function parseWrapArgs(argv: readonly string[]): WrapArgs {
  const separator = argv.indexOf("--");
  const remoteAsked = (separator === -1 ? argv : argv.slice(0, separator)).includes("--url");
  if (!remoteAsked && (separator === -1 || separator === argv.length - 1)) {
    throw new Error(`The MCP server's command goes after "--" (or a remote server with --url).${WRAP_USAGE}`);
  }
  if (remoteAsked && separator !== -1) throw new Error('Either a remote server (--url) or a command after "--": not both.');
  const flags = separator === -1 ? [...argv] : argv.slice(0, separator);
  const [command, ...args] = (separator === -1 ? [""] : argv.slice(separator + 1)) as [string, ...string[]];
  let url: string | undefined;
  let transport = "http";
  let name: string | undefined;
  let port: number | undefined;
  let waitSeconds = DEFAULT_APPROVAL_WAIT_MS / 1_000;
  let approval = "auto";
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flagName(flags[i]);
    if (flag === "--name") name = flags[++i];
    else if (flag === "--port") port = Number(flags[++i]);
    else if (flag === "--wait") waitSeconds = Number(flags[++i]);
    else if (flag === "--approval") approval = String(flags[++i]);
    else if (flag === "--url") url = String(flags[++i] ?? "");
    else if (flag === "--transport") transport = String(flags[++i] ?? "");
    else throw new Error(`Unknown option: ${String(flags[i])}.${WRAP_USAGE}`);
  }
  if (name !== undefined) {
    const problem = nameProblem(name);
    if (problem) throw new Error(`--name refused: ${problem}`);
  }
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65_535)) throw new Error("--port must be a port between 1 and 65535.");
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3_600) throw new Error("--wait must be a number of seconds between 0 and 3600.");
  if (approval !== "auto" && approval !== "client" && approval !== "console") throw new Error('--approval is "console" (or "client", the default).');
  if (url !== undefined) {
    const problem = remoteUrlProblem(url);
    if (problem) throw new Error(`--url refused: ${problem}`);
    if (transport !== "http" && transport !== "sse") throw new Error('--transport is "http" or "sse".');
  }
  return {
    name: name ?? (url !== undefined ? deriveRemoteName(url) : deriveServerName(command, args)),
    ...(url !== undefined ? { remote: { url, transport: transport as "http" | "sse" } } : {}),
    port,
    approvalWaitMs: waitSeconds * 1_000,
    approval: approval === "console" ? "console" : "auto",
    command,
    args,
  };
}

/** Lance et relaie jusqu'à ce que le client ferme l'entrée. Rend le code de sortie. */
export async function runWrap(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const log = (line: string) => process.stderr.write(`${line}\n`);
  let parsed: WrapArgs;
  try {
    parsed = parseWrapArgs(argv);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 3;
  }

  /*
   * Un client arrête souvent le relais par un signal plutôt qu'en fermant son entrée (Cursor
   * le fait), ou disparaît (sortie standard cassée). Avant d'être rattaché au pivot, on sort
   * tout de suite ; après, on s'en détache (ses clés sont révoquées) avant de sortir.
   */
  let session: HubSession | undefined;
  const interrupted = new Promise<"interrupted">((done) => {
    const stop = () => {
      if (!session) process.exit(0);
      done("interrupted");
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);
    process.stdout.on("error", stop);
  });

  /*
   * LE PIVOT : un seul Oathrion pour toute la machine (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`).
   * On le trouve, ou on le lance ; on y inscrit ce serveur ; la clé viendra à `initialize`,
   * pour l'agent du client (« Cursor »).
   */
  let summary: ServerSummary;
  /* Le battement peut revenir avant que le relais existe : affecté plus bas, lu par le rappel. */
  // eslint-disable-next-line prefer-const
  let relayRef: McpRelay | undefined;
  try {
    const conn = await ensureHub(env, { port: parsed.port, log });
    const opened = new HubSession(conn, "relay", env);
    await opened.attach();
    session = opened;
    /* Battre dès maintenant : le lancement d'un serveur (un `npx` lent) peut durer. */
    opened.startHeartbeat((keys) => {
      if (keys) relayRef?.setCredentials({ key: keys.agentToken, approverKey: keys.approverToken });
      log("[oathrion wrap] attached to the local hub again.");
    });
    /* Un serveur distant : le pivot lance le pont, la même commande que celle-ci (`oathrion pont`). */
    const launched = parsed.remote
      ? { command: process.execPath, args: [process.argv[1] ?? "oathrion", "bridge", "--url", parsed.remote.url, "--transport", parsed.remote.transport] }
      : { command: parsed.command, args: parsed.args };
    /*
     * Les jetons gardés dans le coffre d'Oathrion (`server-secrets.ts`) : rendus au serveur ici, à
     * son lancement — ils ne sont plus dans la configuration du client.
     */
    const serverEnv: NodeJS.ProcessEnv = { ...env, ...loadSealedEnv(join(stateRoot(env), "_local"), parsed.name) };
    /* Les jetons de ce serveur deviennent des pièges : leur empreinte seule (`guarded-tokens.ts`). */
    try {
      recordServerTokens(env, parsed.name, serverTokens(serverEnv, launched.args));
    } catch {
      /* un piège de moins ne doit pas empêcher le serveur de démarrer */
    }
    summary = await opened.attachServer({ name: parsed.name, ...launched, cwd: process.cwd(), env: serverEnv });
  } catch (error) {
    log(`[oathrion wrap] ${error instanceof Error ? error.message : String(error)}`);
    await session?.detach();
    return 4;
  }
  const hub = session.connection;
  for (const line of summaryLines(summary, parsed.name)) log(line);

  let program: ClientProgram | null | undefined;
  const relay = new McpRelay({
    endpoint: `${hub.base}/api/mcp`,
    key: "",
    serverName: parsed.name,
    write: (line) => process.stdout.write(`${line}\n`),
    log,
    approvalWaitMs: parsed.approvalWaitMs,
    grantAlways: (verb, origin) => session!.grantAlways(parsed.name, verb, origin),
    decoys: () => loadDecoys(process.env),
    guardedToken: (text) => guardedTokenIn(text, loadGuardedTokens(process.env)),
    previewTools: () => session!.previewTools(),
    credentialsFor: async (client, canAsk) => {
      /* Le programme qui a lancé ce relais : son identité, que la personne confirme (une fois). */
      program ??= clientProgram(process.ppid, process.platform, join(stateRoot(process.env), "_local", "program-hashes.json"));
      const keys = await session!.clientKey(client, parsed.approval === "auto" && canAsk, program);
      if ("quarantined" in keys) {
        log(`[oathrion wrap] ${keys.quarantined === "blocked" ? "blocked" : "not confirmed yet"}: ${keys.program}. Nothing goes through until a person confirms it in Oathrion's console.`);
        return { quarantined: keys.quarantined, program: keys.program };
      }
      log(`[oathrion wrap] "${keys.agentName}": this client's agent, in Oathrion's console.`);
      return { key: keys.agentToken, approverKey: keys.approverToken ?? undefined };
    },
  });
  relayRef = relay;

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();
  input.on("line", (line) => {
    const task: Promise<void> = relay.handle(line).catch((error: unknown) => {
      log(`[oathrion wrap] ${String(error)}`);
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  });

  const closed = new Promise<"client">((done) => input.once("close", () => done("client")));
  const ended = await Promise.race([closed, interrupted]);
  relay.close();
  if (ended === "client") await Promise.all(inFlight);
  await session.detach();
  return 0;
}

/** Ce que la personne lit au démarrage (le journal MCP de son client). */
export function summaryLines(summary: ServerSummary, name: string): string[] {
  const { classes, child } = summary;
  return [
    `[oathrion wrap] server "${name}"${child.name ? ` (${child.name}${child.version ? ` ${child.version}` : ""})` : ""}: ` +
      `${String(classes.read)} read(s) allowed, ${String(classes.write)} write(s) on approval, ` +
      `${String(classes.destructive)} destructive tool(s) blocked.`,
    ...(summary.readByName.length > 0
      ? [
          `[oathrion wrap] ${String(summary.readByName.length)} tool(s) classified as reads from their name alone, as the server does not annotate them: ` +
            `${summary.readByName.slice(0, 8).join(", ")}${summary.readByName.length > 8 ? ", …" : ""}. A rule in the console can put them under approval.`,
        ]
      : []),
    ...(summary.firstLaunch
      ? [`[oathrion wrap] first launch: the definitions of ${String(classes.read + classes.write + classes.destructive)} tool(s) are pinned. A definition that changes later will be withdrawn until you approve it.`]
      : []),
    ...(summary.held.length > 0
      ? [
          `[oathrion wrap] ${String(summary.held.length)} tool(s) WITHDRAWN until you approve: ` +
            summary.held.map((review) => (review.status === "new" ? `${review.name} (new)` : `${review.name} (changed: ${review.changedFields.join(", ")})`)).join(", ") +
            ".",
          `[oathrion wrap] see: oathrion tools list --name ${name} · accept: oathrion tools accept --name ${name} <tool>`,
        ]
      : []),
    `[oathrion wrap] console: "oathrion console" opens it, signed in.`,
  ];
}
