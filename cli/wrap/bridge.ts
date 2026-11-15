/**
 * `oathrion pont --url <url> [--transport http|sse]` — un serveur MCP DISTANT, présenté comme un
 * serveur local (stdio). C'est ce que le pivot lance pour un serveur déclaré par une URL : il
 * le traite alors comme les autres (classement des outils, approbations, empreinte, reçus),
 * sans un second chemin dans le pivot.
 *
 * Ce que fait le pont, ligne par ligne sur stdin → le serveur distant → stdout :
 *
 *   · `http` (Streamable HTTP, MCP 2025-03-26 et suivantes) : chaque message part en `POST` ;
 *     la réponse revient en JSON ou en flux SSE. Il garde l'en-tête `Mcp-Session-Id` donné à
 *     `initialize`, et `MCP-Protocol-Version` ensuite ; il ferme la session (`DELETE`) au départ ;
 *   · `sse` (l'ancien transport) : un flux `GET` annonce l'adresse où poster (`endpoint`), et
 *     porte les réponses.
 *
 * Les en-têtes de la configuration du client (un jeton, le plus souvent) arrivent par
 * `MCP_REMOTE_HEADERS` (JSON) : pas dans les arguments, visibles de tous dans la liste des
 * processus. Ils ne sont jamais journalisés, ni l'adresse au-delà de son origine (une clé peut
 * être dans la requête). Ils ne partent jamais en clair hors de la machine : `https`, ou `http`
 * vers la boucle locale seulement ; et l'adresse annoncée par un serveur `sse` doit être de la
 * même origine.
 *
 * Pas d'OAuth : un serveur dont le client gère la connexion lui-même (Claude Code, `/mcp`) n'a
 * pas ses jetons dans la configuration ; `npx oathrion` le laisse tel quel.
 */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export const BRIDGE_USAGE = `
oathrion bridge --url <url> [--transport http|sse]

  Presents a remote MCP server as a local (stdio) server. Headers come from
  MCP_REMOTE_HEADERS (a JSON object). Launched by oathrion wrap --url; rarely by hand.
`;

export const REMOTE_HEADERS_VARIABLE = "MCP_REMOTE_HEADERS";

export interface BridgeIo {
  input: Readable;
  write: (line: string) => void;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
}

type Message = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown; result?: { protocolVersion?: unknown } };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** L'adresse est-elle sûre pour y envoyer des jetons ? `null` si oui, sinon pourquoi. */
export function remoteUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not an address.`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  if (url.protocol === "http:") return `${url.origin}: plain http outside this machine, tokens would travel in clear. Use https.`;
  return `${url.protocol} is not supported: http or https.`;
}

export function readRemoteHeaders(env: NodeJS.ProcessEnv): Record<string, string> | string {
  const raw = env[REMOTE_HEADERS_VARIABLE];
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return `${REMOTE_HEADERS_VARIABLE} is not a JSON object.`;
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return `${REMOTE_HEADERS_VARIABLE} is not readable JSON.`;
  }
}

/** Les événements d'un flux SSE, au fil de l'eau. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) yield { event, data: data.join("\n") };
    }
  }
}

export async function runBridge(argv: readonly string[], env: NodeJS.ProcessEnv, io: BridgeIo): Promise<number> {
  let url = "";
  let transport = "http";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") url = String(argv[++i] ?? "");
    else if (argv[i] === "--transport") transport = String(argv[++i] ?? "");
    else {
      io.log(`[oathrion bridge] unknown option: ${String(argv[i])}.${BRIDGE_USAGE}`);
      return 3;
    }
  }
  const problem = url === "" ? "--url manque." : remoteUrlProblem(url);
  if (problem) {
    io.log(`[oathrion bridge] ${problem}`);
    return 3;
  }
  if (transport !== "http" && transport !== "sse") {
    io.log(`[oathrion bridge] --transport is "http" or "sse".`);
    return 3;
  }
  const headers = readRemoteHeaders(env);
  if (typeof headers === "string") {
    io.log(`[oathrion bridge] ${headers}`);
    return 3;
  }
  const fetchImpl = io.fetchImpl ?? fetch;
  const origin = new URL(url).origin;
  const emit = (message: unknown) => io.write(JSON.stringify(message));
  const failRequest = (message: Message, text: string) => {
    if (message.id !== undefined && message.method !== undefined) emit({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
  };
  const statusText = (status: number) =>
    status === 401 || status === 403
      ? `The remote server ${origin} refuses access (${String(status)}): check the token in your client's configuration.`
      : `The remote server ${origin} answered ${String(status)}.`;

  /*
   * L'itérateur est pris TOUT DE SUITE : une ligne arrivée pendant qu'on attend le flux `sse`
   * (l'`initialize` du client) serait perdue, `readline` ne gardant que pour un itérateur déjà là.
   */
  const lineIterator = createInterface({ input: io.input })[Symbol.asyncIterator]();
  const lines = { [Symbol.asyncIterator]: () => lineIterator };
  const inFlight = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  if (transport === "http") {
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    const send = async (message: Message) => {
      const request: Record<string, string> = { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (sessionId) request["mcp-session-id"] = sessionId;
      if (protocolVersion) request["mcp-protocol-version"] = protocolVersion;
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "POST", headers: request, body: JSON.stringify(message) });
      } catch (error) {
        io.log(`[oathrion bridge] ${origin} injoignable : ${error instanceof Error ? error.message : String(error)}`);
        failRequest(message, `The remote server ${origin} is unreachable.`);
        return;
      }
      if (message.method === "initialize") sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      if (response.status === 202 || response.status === 204) return;
      if (!response.ok) {
        io.log(`[oathrion bridge] ${message.method ?? "response"}: ${String(response.status)} from ${origin}.`);
        failRequest(message, statusText(response.status));
        return;
      }
      const deliver = (reply: Message) => {
        if (message.method === "initialize" && typeof reply.result?.protocolVersion === "string") protocolVersion = reply.result.protocolVersion;
        emit(reply);
      };
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body) {
        for await (const { data } of sseEvents(response.body)) {
          try {
            deliver(JSON.parse(data) as Message);
          } catch {
            /* un événement illisible n'est pas un message */
          }
        }
        return;
      }
      const text = await response.text();
      if (text.trim() === "") return;
      const body = JSON.parse(text) as Message | Message[];
      for (const reply of Array.isArray(body) ? body : [body]) deliver(reply);
    };
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        continue;
      }
      /* `initialize` d'abord, seul : la session qu'il ouvre sert à tous les messages suivants. */
      if (message.method === "initialize") await send(message);
      else track(send(message));
    }
    await Promise.all(inFlight);
    if (sessionId) {
      await fetchImpl(url, { method: "DELETE", headers: { ...headers, "mcp-session-id": sessionId } }).catch(() => undefined);
    }
    return 0;
  }

  /* L'ancien transport : un flux GET, une adresse où poster, les réponses dans le flux. */
  let endpoint: string | null = null;
  const queued: Message[] = [];
  let streamDone = false;
  const post = async (message: Message) => {
    let response: Response;
    try {
      response = await fetchImpl(endpoint!, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(message) });
    } catch (error) {
      io.log(`[oathrion bridge] ${origin} injoignable : ${error instanceof Error ? error.message : String(error)}`);
      failRequest(message, `The remote server ${origin} is unreachable.`);
      return;
    }
    if (!response.ok) {
      io.log(`[oathrion bridge] ${message.method ?? "response"}: ${String(response.status)} from ${origin}.`);
      failRequest(message, statusText(response.status));
    }
    await response.body?.cancel().catch(() => undefined);
  };
  let stream: Response;
  const closing = new AbortController();
  try {
    stream = await fetchImpl(url, { method: "GET", headers: { ...headers, accept: "text/event-stream" }, signal: closing.signal });
  } catch (error) {
    io.log(`[oathrion bridge] ${origin} injoignable : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!stream.ok || !stream.body) {
    io.log(`[oathrion bridge] the SSE stream of ${origin}: ${String(stream.status)}.`);
    return 1;
  }
  const reading = (async () => {
    for await (const { event, data } of sseEvents(stream.body!)) {
      if (event === "endpoint") {
        const target = new URL(data.trim(), url);
        if (target.origin !== origin) {
          io.log(`[oathrion bridge] the server announces an address from another origin (${target.origin}): refused, tokens will not go there.`);
          return;
        }
        endpoint = target.toString();
        for (const message of queued.splice(0)) track(post(message));
        continue;
      }
      try {
        emit(JSON.parse(data));
      } catch {
        /* un événement illisible n'est pas un message */
      }
    }
  })().finally(() => {
    streamDone = true;
  });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      continue;
    }
    if (streamDone) {
      failRequest(message, `The remote server ${origin} closed its stream.`);
      continue;
    }
    if (endpoint) track(post(message));
    else queued.push(message);
  }
  await Promise.all(inFlight);
  closing.abort();
  await reading.catch(() => undefined);
  return 0;
}
