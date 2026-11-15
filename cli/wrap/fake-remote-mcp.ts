/**
 * Un faux serveur MCP DISTANT, pour les tests du pont (`bridge.ts`) : sur la boucle locale, il
 * parle Streamable HTTP (`POST /mcp`, réponses en JSON ou en SSE, session `Mcp-Session-Id`)
 * et l'ancien transport SSE (`GET /sse` annonce `/messages`). Il exige `Authorization: Bearer
 * jeton-distant` et note ce qu'il reçoit, en-têtes compris, pour que les tests le vérifient.
 *
 * Trois outils : une lecture annotée, une écriture, une destruction.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const REMOTE_TOKEN = "jeton-distant";

const TOOLS = [
  { name: "read_doc", description: "Lit un document.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "create_doc", description: "Crée un document.", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
  { name: "delete_doc", description: "Supprime un document.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { destructiveHint: true } },
];

type Rpc = { jsonrpc: "2.0"; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };

export interface FakeRemote {
  url: string;
  sseUrl: string;
  received: { method: string; path: string; rpc?: string; session?: string; authorization?: string; protocolVersion?: string }[];
  close: () => Promise<void>;
}

function answer(rpc: Rpc): unknown {
  if (rpc.method === "initialize") {
    return { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "faux-distant", version: "2.0.0" } } };
  }
  if (rpc.method === "tools/list") return { jsonrpc: "2.0", id: rpc.id, result: { tools: TOOLS } };
  if (rpc.method === "tools/call") {
    const name = rpc.params?.name ?? "";
    return { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `${name} fait (distant)` }], isError: false } };
  }
  return { jsonrpc: "2.0", id: rpc.id, result: {} };
}

const body = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let text = "";
    req.on("data", (c: Buffer) => (text += c.toString()));
    req.on("end", () => done(text));
  });

export async function startFakeRemote(): Promise<FakeRemote> {
  const received: FakeRemote["received"] = [];
  const streams = new Map<string, ServerResponse>();
  let sessions = 0;
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const text = req.method === "POST" ? await body(req) : "";
    const rpc = text ? (JSON.parse(text) as Rpc) : undefined;
    received.push({
      method: req.method ?? "",
      path,
      rpc: rpc?.method,
      session: req.headers["mcp-session-id"] as string | undefined,
      authorization: req.headers.authorization,
      protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
    });
    if (req.headers.authorization !== `Bearer ${REMOTE_TOKEN}`) {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    /* Streamable HTTP. */
    if (path === "/mcp" && req.method === "POST" && rpc) {
      if (rpc.method !== "initialize" && req.headers["mcp-session-id"] !== "session-1") {
        res.writeHead(400).end("session manquante");
        return;
      }
      if (rpc.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = JSON.stringify(answer(rpc));
      /* La liste des outils en SSE, le reste en JSON : les deux formes de réponse sont éprouvées. */
      if (rpc.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${reply}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", ...(rpc.method === "initialize" ? { "mcp-session-id": "session-1" } : {}) });
      res.end(reply);
      return;
    }
    if (path === "/mcp" && req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    /* L'ancien transport SSE. */
    if (path === "/sse" && req.method === "GET") {
      const id = String((sessions += 1));
      streams.set(id, res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: endpoint\ndata: /messages?session=${id}\n\n`);
      req.on("close", () => streams.delete(id));
      return;
    }
    if (path === "/messages" && req.method === "POST" && rpc) {
      const stream = streams.get(new URL(req.url ?? "", "http://x").searchParams.get("session") ?? "");
      res.writeHead(202).end();
      if (stream && rpc.id !== undefined) stream.write(`event: message\ndata: ${JSON.stringify(answer(rpc))}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    sseUrl: `http://127.0.0.1:${String(port)}/sse`,
    received,
    close: () =>
      new Promise((done) => {
        for (const stream of streams.values()) stream.end();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
