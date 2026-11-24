/**
 * LE RELAIS SUR CLOUDFLARE (l'hébergement recommandé, `notes/CONCEPTION-RELAIS-TELEPHONE.md`) :
 *
 * - le Worker reçoit le webhook du robot et les connexions des pivots ;
 * - un Durable Object par machine (`MachineRoom`, nommé par les 11 premiers caractères de son
 *   identifiant) porte sa connexion WebSocket « en sommeil » : une machine connectée qui ne fait
 *   rien ne coûte rien ; l'état de la connexion vit dans son attachement (`serializeAttachment`),
 *   rien n'est écrit sur disque ;
 * - un seul Durable Object (`RevocationList`) garde les révocations par compte (`/stop`).
 *
 * - la page du téléphone (`public/`) est servie telle quelle (`[assets]`) ; son manifeste et les
 *   requêtes de la page (`/v1/web/*`) passent par le Worker.
 *
 * Les secrets (`script/deploy.sh`) : RELAY_SIGNING_KEY, RELAY_REVOKE_SALT, VAPID_PRIVATE_KEY ;
 * Telegram, facultatif : TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET. Les variables BOT_USERNAME
 * et PUBLIC_URL sont dans `wrangler.toml`.
 */
import { type Conn, RelayCore, RelayKeys, type Revocations, ROUTE_LENGTH, type Session, TelegramClient, type TelegramUpdate } from "./core.ts";
import { VapidKeys } from "./webpush.ts";

/* Les types de Cloudflare, réduits à ce que ce fichier utilise (sans dépendre de @cloudflare/workers-types). */
interface CfWebSocket extends WebSocket {
  accept(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
interface DurableObjectStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
interface DurableObjectState {
  acceptWebSocket(ws: CfWebSocket): void;
  getWebSockets(): CfWebSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
}
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
declare const WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket };
declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown;

export interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  VAPID_PRIVATE_KEY?: string;
  PUBLIC_URL: string;
  RELAY_SIGNING_KEY: string;
  RELAY_REVOKE_SALT: string;
  BOT_USERNAME: string;
  /** Pour les essais (`wrangler dev`) : un faux Telegram. */
  TELEGRAM_API_BASE?: string;
  ROOMS: DurableObjectNamespace;
  REVOCATIONS: DurableObjectNamespace;
  /** Facultatif : la limite de connexions par adresse IP (`[[ratelimits]]` de `wrangler.toml`). */
  CONNECT_LIMIT?: RateLimit;
}

/** Les révocations, gardées par le Durable Object unique `RevocationList`. */
class RemoteRevocations implements Revocations {
  private readonly env: Env;
  constructor(env: Env) {
    this.env = env;
  }
  /*
   * Un accès neuf à chaque appel : le cœur vit d'une requête à l'autre, et Cloudflare refuse
   * qu'une requête se serve d'un accès ouvert par une autre (essai `wrangler dev`, 23 novembre).
   */
  private stub(): DurableObjectStub {
    return this.env.REVOCATIONS.get(this.env.REVOCATIONS.idFromName("all"));
  }
  async before(user: string): Promise<number | null> {
    const response = await this.stub().fetch("https://revocations/before", { method: "POST", body: JSON.stringify({ user }) });
    return ((await response.json()) as { at: number | null }).at;
  }
  async revoke(user: string, at: number): Promise<void> {
    await this.stub().fetch("https://revocations/revoke", { method: "POST", body: JSON.stringify({ user, at }) });
  }
}

/* Un cœur par isolat : la clé se charge une fois. */
let cached: Promise<RelayCore> | null = null;
function coreOf(env: Env): Promise<RelayCore> {
  cached ??= Promise.all([RelayKeys.load(env.RELAY_SIGNING_KEY), env.VAPID_PRIVATE_KEY ? VapidKeys.load(env.VAPID_PRIVATE_KEY) : null]).then(
    ([keys, vapid]) =>
      new RelayCore({
        bot: env.BOT_USERNAME.replace(/^@/, ""),
        telegram: env.TELEGRAM_BOT_TOKEN ? new TelegramClient(env.TELEGRAM_BOT_TOKEN, undefined, env.TELEGRAM_API_BASE || undefined) : null,
        vapid,
        publicUrl: env.PUBLIC_URL,
        keys,
        revocations: new RemoteRevocations(env),
        salt: env.RELAY_REVOKE_SALT,
        log: (event, detail) => console.error(`[relay] ${event}${detail ? ` ${JSON.stringify(detail)}` : ""}`),
      }),
  );
  return cached;
}

const roomOf = (env: Env, route: string) => env.ROOMS.get(env.ROOMS.idFromName(route));

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/health") return Response.json({ ok: true, bot: env.BOT_USERNAME, web: Boolean(env.VAPID_PRIVATE_KEY) });
    const ip = request.headers.get("cf-connecting-ip") ?? "?";
    /* La page du téléphone : sa clé VAPID, son manifeste, ses requêtes (appairer, appuyer, se désappairer). */
    if (url.pathname === "/v1/web/key" || url.pathname === "/manifest.webmanifest") {
      const core = await coreOf(env);
      if (url.pathname === "/manifest.webmanifest") return new Response(JSON.stringify(core.webManifest(url.searchParams.get("c"))), { headers: { "content-type": "application/manifest+json", "cache-control": "no-store" } });
      return core.webKey() ? Response.json({ key: core.webKey() }) : new Response(null, { status: 404 });
    }
    if (/^\/v1\/web\/(pair|press|unpair|seen)$/.test(url.pathname) && request.method === "POST") {
      if (env.CONNECT_LIMIT && !(await env.CONNECT_LIMIT.limit({ key: `web:${ip}` })).success) return Response.json({ error: "Too many requests: wait a minute." }, { status: 429 });
      const text = await request.text();
      if (text.length > 8 * 1024) return Response.json({ error: "too big" }, { status: 413 });
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return Response.json({ error: "not json" }, { status: 400 });
      }
      const core = await coreOf(env);
      if (url.pathname.endsWith("/unpair")) {
        const reply = await core.webUnpair(body);
        return Response.json(reply.json, { status: reply.status });
      }
      const route = core.webRouteOf(body);
      if (!route) return Response.json({ error: "bad request" }, { status: 400 });
      return roomOf(env, route).fetch(`https://room/web/${url.pathname.split("/").pop()!}`, { method: "POST", body: text });
    }
    if (url.pathname === "/v1/connect") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("WebSocket only", { status: 426 });
      const machine = url.searchParams.get("m") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(machine)) return new Response("machine?", { status: 400 });
      if (env.CONNECT_LIMIT && !(await env.CONNECT_LIMIT.limit({ key: ip })).success) return new Response("Too many connections", { status: 429 });
      return roomOf(env, machine.slice(0, ROUTE_LENGTH)).fetch(request.url, request);
    }
    if (url.pathname === "/v1/telegram" && request.method === "POST" && env.TELEGRAM_BOT_TOKEN) {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response(null, { status: 401 });
      const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
      if (!update) return new Response(null, { status: 200 });
      const core = await coreOf(env);
      const route = core.routeOf(update);
      /* Telegram renvoie ce qui n'a pas reçu 200 : on répond tout de suite, le travail continue. */
      ctx.waitUntil(route ? roomOf(env, route).fetch("https://room/update", { method: "POST", body: JSON.stringify(update) }) : core.onUpdate(update, async () => []));
      return new Response(null, { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  },
};

/** La connexion d'une machine, et ce qui lui arrive de Telegram. */
export class MachineRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    /* Le battement du pivot ne réveille pas l'objet. */
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  /*
   * Une seule session par connexion tant que l'objet est éveillé : un appui et un message du
   * pivot qui se croisent (l'un attend Telegram) voient le même état. Elle est réécrite dans
   * l'attachement à chaque envoi, pour survivre au sommeil (essai `wrangler dev` du 23 novembre :
   * relue de l'attachement à chaque message, la session venait d'être appairée et ne le savait pas).
   */
  private readonly sessions = new WeakMap<CfWebSocket, Session>();

  private conn(ws: CfWebSocket): Conn & { ws: CfWebSocket } {
    let session = this.sessions.get(ws);
    if (!session) {
      session = ws.deserializeAttachment() as Session;
      this.sessions.set(ws, session);
    }
    const kept = session;
    return {
      ws,
      session: kept,
      send: (message) => {
        ws.serializeAttachment(kept);
        ws.send(JSON.stringify(message));
      },
      close: (code, reason) => ws.close(code, reason),
    };
  }

  private conns(): (Conn & { ws: CfWebSocket })[] {
    return this.state.getWebSockets().map((ws) => this.conn(ws));
  }

  private save(conns: (Conn & { ws: CfWebSocket })[]): void {
    for (const conn of conns) {
      try {
        conn.ws.serializeAttachment(conn.session);
      } catch {
        /* Fermée entre-temps. */
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const core = await coreOf(this.env);
    const url = new URL(request.url);
    if (url.pathname === "/web/pair" || url.pathname === "/web/press" || url.pathname === "/web/seen") {
      const conns = this.conns();
      const body = (await request.json()) as Record<string, unknown>;
      const room = async () => conns;
      const reply = url.pathname === "/web/pair" ? await core.webPair(body, room) : url.pathname === "/web/seen" ? await core.webSeen(body, room) : await core.webPress(body, room);
      this.save(conns);
      return Response.json(reply.json, { status: reply.status });
    }
    if (url.pathname === "/update") {
      const conns = this.conns();
      await core.onUpdate((await request.json()) as TelegramUpdate, async () => conns);
      this.save(conns);
      return new Response(null, { status: 200 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server);
    const { session, hello } = core.open(url.searchParams.get("m"));
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    server.send(JSON.stringify(hello));
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const core = await coreOf(this.env);
    const conns = this.conns();
    const conn = conns.find((c) => c.ws === ws) ?? this.conn(ws);
    await core.onMessage(conn, typeof message === "string" ? message : new TextDecoder().decode(message), async () => conns);
    this.save(conns.includes(conn) ? conns : [...conns, conn]);
  }

  async webSocketClose(ws: CfWebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}

/** Le seul état durable du relais : par empreinte de compte, la date de son dernier `/stop`. */
export class RevocationList {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const { user, at } = (await request.json()) as { user: string; at?: number };
    if (typeof user !== "string" || user.length > 64) return new Response(null, { status: 400 });
    const key = `u:${user}`;
    if (new URL(request.url).pathname === "/revoke" && typeof at === "number") {
      await this.state.storage.put(key, Math.max(at, (await this.state.storage.get<number>(key)) ?? 0));
      return Response.json({ at });
    }
    return Response.json({ at: (await this.state.storage.get<number>(key)) ?? null });
  }
}
