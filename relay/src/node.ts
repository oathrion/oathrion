/**
 * LE RELAIS SUR UNE MACHINE (plan B de l'hébergement, et l'outil des essais réels en local) : un
 * seul processus Node, les connexions en mémoire. Le robot se lit par webhook (`POST
 * /v1/telegram`, derrière Caddy) ou, sans adresse publique, par `getUpdates` (`mode: "poll"`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer, type WebSocket } from "ws";

import { type Conn, type RelayCore, ROUTE_LENGTH, type Revocations, type TelegramClient, type TelegramUpdate, type WebReply, WindowLimiter } from "./core.ts";

/** La page du téléphone, son service worker, son icône (`relay/public/`, servis tels quels sur Cloudflare). */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
/* Les mêmes en-têtes que `public/_headers` sur Cloudflare. */
const PAGE_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function serveStatic(pathname: string, response: ServerResponse): boolean {
  const name = pathname === "/pair" ? "pair.html" : pathname === "/decide" ? "decide.html" : pathname.slice(1);
  /* Les fichiers de la page, et les mascottes (`mascots/nova.png`) : rien d'autre. */
  if (!/^(mascots\/)?[a-z]+\.(html|js|css|png)$/.test(name) || !existsSync(join(PUBLIC_DIR, name))) return false;
  response.writeHead(200, { "content-type": TYPES[extname(name)]!, "cache-control": "no-cache", ...PAGE_HEADERS }).end(readFileSync(join(PUBLIC_DIR, name)));
  return true;
}

/** Les révocations dans un petit fichier JSON : l'empreinte d'un compte, et une date. */
export class FileRevocations implements Revocations {
  private readonly file: string;
  private readonly entries: Map<string, number>;

  constructor(file: string) {
    this.file = file;
    let raw: Record<string, number> = {};
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    } catch {
      /* Pas encore de fichier : aucune révocation. */
    }
    this.entries = new Map(Object.entries(raw).filter(([, at]) => typeof at === "number"));
  }

  async before(user: string): Promise<number | null> {
    return this.entries.get(user) ?? null;
  }

  async revoke(user: string, at: number): Promise<void> {
    this.entries.set(user, Math.max(at, this.entries.get(user) ?? 0));
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export interface NodeRelayOptions {
  core: RelayCore;
  telegram: TelegramClient | null;
  port?: number;
  host?: string;
  /** `webhook` (par défaut) : Telegram appelle `/v1/telegram` ; `poll` : le relais lit `getUpdates`. */
  mode?: "webhook" | "poll";
  webhookSecret?: string;
  /** Derrière Caddy : l'adresse du client est dans `X-Forwarded-For`. */
  trustProxy?: boolean;
}

export interface NodeRelay {
  port: number;
  close(): Promise<void>;
}

const ipOf = (request: IncomingMessage, trustProxy: boolean) => (trustProxy ? String(request.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || request.socket.remoteAddress || "?";

export async function startNodeRelay(options: NodeRelayOptions): Promise<NodeRelay> {
  const { core, telegram } = options;
  const rooms = new Map<string, Set<Conn>>();
  const room = async (route: string) => [...(rooms.get(route) ?? [])];
  const connectsPerIp = new WindowLimiter(10, 60_000);
  const webPerIp = new WindowLimiter(30, 60_000);
  const openPerIp = new Map<string, number>();
  const trustProxy = options.trustProxy === true;
  /* Les messages d'une connexion se traitent un par un, dans l'ordre. */
  const queues = new WeakMap<Conn, Promise<void>>();
  const queued = (conn: Conn, work: () => Promise<void>) => {
    const next = (queues.get(conn) ?? Promise.resolve()).then(work, work).catch(() => undefined);
    queues.set(conn, next);
    return next;
  };

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const json = (response: ServerResponse, reply: WebReply) => response.writeHead(reply.status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(reply.json));
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relay");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, bot: core.bot, web: core.webKey() !== null }));
      return;
    }
    /* La page du téléphone (Web Push). */
    if (request.method === "GET" && url.pathname === "/v1/web/key") return json(response, core.webKey() ? { status: 200, json: { key: core.webKey() } } : { status: 404, json: {} });
    if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
      response.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-store" }).end(JSON.stringify(core.webManifest(url.searchParams.get("c"))));
      return;
    }
    if (request.method === "GET" && serveStatic(url.pathname, response)) return;
    if (request.method === "POST" && /^\/v1\/web\/(pair|press|unpair|seen)$/.test(url.pathname)) {
      if (!webPerIp.allow(ipOf(request, trustProxy))) return json(response, { status: 429, json: { error: "Too many requests: wait a minute." } });
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 8 * 1024) chunks.push(chunk);
      });
      request.on("end", () => {
        void (async () => {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            return json(response, { status: 400, json: { error: "not json" } });
          }
          const action = url.pathname.split("/").pop();
          const reply = action === "pair" ? await core.webPair(body, room) : action === "seen" ? await core.webSeen(body, room) : action === "press" ? await core.webPress(body, room) : await core.webUnpair(body);
          json(response, reply);
        })().catch(() => json(response, { status: 500, json: { error: "The relay failed: try again." } }));
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/telegram" && options.mode !== "poll" && telegram) {
      if (!options.webhookSecret || request.headers["x-telegram-bot-api-secret-token"] !== options.webhookSecret) {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 256 * 1024) chunks.push(chunk);
      });
      request.on("end", () => {
        /* Telegram renvoie tout ce qui n'a pas reçu 200 : on répond d'abord, on traite ensuite. */
        response.writeHead(200).end();
        try {
          void onUpdate(JSON.parse(Buffer.concat(chunks).toString("utf8")) as TelegramUpdate);
        } catch {
          /* Pas du JSON : ignoré. */
        }
      });
      return;
    }
    response.writeHead(404).end();
  });

  const onUpdate = async (update: TelegramUpdate) => {
    try {
      await core.onUpdate(update, room);
    } catch {
      /* Telegram injoignable pour répondre : rien à faire de plus. */
    }
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://relay");
    const ip = ipOf(request, trustProxy);
    if (url.pathname !== "/v1/connect" || !connectsPerIp.allow(ip) || (openPerIp.get(ip) ?? 0) >= 20) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      openPerIp.set(ip, (openPerIp.get(ip) ?? 0) + 1);
      const { session, hello } = core.open(url.searchParams.get("m"));
      const conn: Conn = {
        session,
        send: (message) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        },
        close: (code, reason) => ws.close(code, reason),
      };
      let joined: string | null = null;
      ws.on("message", (data) => {
        void queued(conn, async () => {
          await core.onMessage(conn, data.toString(), room);
          /* Authentifiée : la connexion rejoint la salle de sa machine. */
          if (joined === null && session.machine) {
            joined = session.machine.slice(0, ROUTE_LENGTH);
            if (!rooms.has(joined)) rooms.set(joined, new Set());
            rooms.get(joined)!.add(conn);
          }
        });
      });
      ws.on("close", () => {
        openPerIp.set(ip, Math.max(0, (openPerIp.get(ip) ?? 1) - 1));
        if (openPerIp.get(ip) === 0) openPerIp.delete(ip);
        if (joined) {
          rooms.get(joined)?.delete(conn);
          if (rooms.get(joined)?.size === 0) rooms.delete(joined);
        }
      });
      /* Une connexion qui ne s'authentifie pas en 20 secondes est fermée. */
      setTimeout(() => {
        if (!session.machine) ws.close(4001, "auth timeout");
      }, 20_000).unref();
      conn.send(hello);
    });
  });

  let polling = options.mode === "poll" && telegram !== null;
  if (polling && telegram) {
    await telegram.call("deleteWebhook", { drop_pending_updates: false });
    void (async () => {
      let offset = 0;
      while (polling) {
        try {
          const updates = await telegram.call<TelegramUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 40_000);
          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1);
            await onUpdate(update);
          }
        } catch {
          if (polling) await new Promise((done) => setTimeout(done, 3_000));
        }
      }
    })();
  }

  await new Promise<void>((done) => server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", done));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : (options.port ?? 8787),
    close: async () => {
      polling = false;
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
