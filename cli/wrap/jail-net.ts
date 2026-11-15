/**
 * LE RÉSEAU DE LA PRISON (pièce J4 de `notes/CONCEPTION-JAIL.md`).
 *
 * Dans `oathrion jail`, l'agent n'a plus de réseau (`--unshare-net` : sa seule interface est la
 * sienne, `127.0.0.1`, vide). Deux passages, ouverts DEHORS par `oathrion jail`, sur des prises
 * Unix du dossier de la prison :
 *
 *   · le PIVOT : ce que dedans on envoie à `127.0.0.1:<port du pivot>` arrive au vrai pivot ;
 *   · un MANDATAIRE HTTPS (`HTTPS_PROXY`) qui n'ouvre que les hôtes permis : le fournisseur d'IA
 *     de l'agent (`DEFAULT_HOSTS`), et ceux que la personne ajoute (`--allow-host`). Les autres
 *     sont refusés, avec une réponse que l'agent lit, et la liste est dite à la fin.
 *
 * Dedans, un petit relais (`oathrion __jail-inside`) écoute sur `127.0.0.1` et passe aux prises,
 * puis lance l'agent. Un programme qui ignore `HTTPS_PROXY` n'a tout simplement pas de réseau.
 * Les serveurs MCP, eux, tournent dehors, lancés par le pivot : ils gardent le leur.
 */
import { spawn } from "node:child_process";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { ADDRESS_ATTEMPT_MS } from "../../server/net-patience";

/** Le port du mandataire, dedans (l'espace réseau de la prison est vide : il est libre). */
export const PROXY_PORT = 3128;
export const HUB_SOCKET = "hub.sock";
export const PROXY_SOCKET = "proxy.sock";

const GOOGLE_AGENT_HOSTS = ["googleapis.com", "accounts.google.com", "antigravity.google", "antigravity.google.com", "antigravity-unleash.goog", "gstatic.com", "lh3.googleusercontent.com"];

/** Les hôtes dont chaque agent a besoin pour parler à son fournisseur d'IA (et à son compte). */
export const DEFAULT_HOSTS: Record<string, string[]> = {
  "cursor-agent": ["cursor.sh", "cursor.com", "cursorapi.com"],
  cursor: ["cursor.sh", "cursor.com", "cursorapi.com"],
  claude: ["anthropic.com", "claude.ai", "claude.com"],
  codex: ["openai.com", "chatgpt.com"],
  gemini: GOOGLE_AGENT_HOSTS,
  /* Antigravity CLI : les API Google, la connexion au compte, et son propre site ; pas tout google.com (Docs, Forms…). */
  agy: GOOGLE_AGENT_HOSTS,
  antigravity: GOOGLE_AGENT_HOSTS,
};

/** `api2.cursor.sh` est permis par `cursor.sh` ; `evilcursor.sh` ne l'est pas. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const rule = entry.toLowerCase().replace(/^\*\./, "");
    return name === rule || name.endsWith(`.${rule}`);
  });
}

/** Ce que l'agent lit quand un hôte est refusé. */
export const refusalText = (host: string) =>
  `Oathrion jail: ${host} is not allowed from inside the jail. Tell the person; they can start it again with --allow-host ${host}.`;

/**
 * DEHORS : les deux prises de la prison. `onRefused` est appelé une fois par hôte refusé.
 */
export async function startGate(options: {
  dir: string;
  hubPort: number;
  allowed: readonly string[];
  onRefused: (host: string) => void;
  /** Pour les essais : où mène un hôte permis (par défaut, `host:443`). */
  connect?: (host: string, onConnect: () => void) => Socket;
}): Promise<{ close: () => Promise<void> }> {
  const { dir, hubPort, allowed, onRefused, connect = (host, onConnect) => createConnection({ host, port: 443, autoSelectFamilyAttemptTimeout: ADDRESS_ATTEMPT_MS }, onConnect) } = options;
  const refused = new Set<string>();
  const hub = createServer((inside) => {
    const outside = createConnection({ host: "127.0.0.1", port: hubPort });
    pipe(inside, outside);
  });
  const proxy = createServer((inside) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 16_384) inside.destroy();
        return;
      }
      inside.off("data", onData);
      const [method, target] = head.subarray(0, head.indexOf("\r\n")).toString("latin1").split(" ");
      /* Seulement CONNECT vers le port 443 : du HTTPS, que le mandataire ne lit pas. */
      const match = method === "CONNECT" ? /^\[?([^\]]+?)\]?:(\d+)$/.exec(target ?? "") : null;
      let host = match?.[1] ?? "";
      if (!match) {
        /* `GET http://hôte/…` : on nomme l'hôte, pour que la réponse dise quoi permettre. */
        try {
          host = new URL(String(target)).hostname;
        } catch {
          host = "";
        }
      }
      const https = match !== null && match[2] === "443";
      if (!https || !hostAllowed(host, allowed)) {
        const shown = host || String(target ?? "?");
        if (!hostAllowed(host, allowed) && !refused.has(shown)) {
          refused.add(shown);
          onRefused(shown);
        }
        const text = hostAllowed(host, allowed) ? `Oathrion jail: only HTTPS (port 443) leaves the jail, not ${String(method)} ${String(target)}.` : refusalText(shown);
        inside.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${String(Buffer.byteLength(text))}\r\nconnection: close\r\n\r\n${text}`);
        return;
      }
      let tunnel = false;
      const outside = connect(host, () => {
        tunnel = true;
        inside.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length > 0) outside.write(rest);
        pipe(inside, outside);
      });
      /* Avant le tunnel : l'hôte n'a pas répondu (502). Après : on ferme, sans rien écrire dans le flux chiffré. */
      outside.on("error", () => {
        if (tunnel || inside.destroyed) return;
        inside.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      });
    };
    inside.on("data", onData);
    inside.on("error", () => undefined);
  });
  await Promise.all([listen(hub, join(dir, HUB_SOCKET)), listen(proxy, join(dir, PROXY_SOCKET))]);
  return {
    close: async () => {
      await Promise.all([new Promise((done) => hub.close(done)), new Promise((done) => proxy.close(done))]);
    },
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(path, () => done());
  });
}

function pipe(a: Socket, b: Socket): void {
  a.pipe(b);
  b.pipe(a);
  const end = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", end);
  b.on("error", end);
  a.on("close", end);
  b.on("close", end);
}

/**
 * DEDANS (`oathrion __jail-inside <dossier> <port du pivot> -- <agent>…`) : écoute sur
 * `127.0.0.1`, passe aux prises du dehors, puis lance l'agent et rend son code de sortie.
 */
export async function runJailInside(argv: readonly string[]): Promise<number> {
  const separator = argv.indexOf("--");
  const [dir, portText] = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  const hubPort = Number(portText);
  if (separator === -1 || !dir || !Number.isInteger(hubPort) || command.length === 0) return 3;
  const forward = (port: number, socket: string) => {
    const server = createServer((inside) => pipe(inside, createConnection(join(dir, socket))));
    return new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(port, "127.0.0.1", () => done());
    });
  };
  await Promise.all([forward(hubPort, HUB_SOCKET), forward(PROXY_PORT, PROXY_SOCKET)]);
  return new Promise<number>((done) => {
    /* L'agent seul suit le mandataire jusque dans Node ; le petit relais, lui, n'en a pas besoin. */
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
    child.on("exit", (status, signal) => done(status ?? (signal ? 128 : 1)));
    child.on("error", () => done(127));
  });
}

/**
 * Les variables qui envoient au mandataire tout ce qui sort ; le pivot, lui, est en direct. Node
 * (22.21, 24.5 et suivants) ne les suit qu'avec `NODE_USE_ENV_PROXY=1`, donné à l'agent seul
 * (`runJailInside`).
 */
export function proxyEnvironment(): Record<string, string> {
  const proxy = `http://127.0.0.1:${String(PROXY_PORT)}`;
  return {
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}
