/**
 * LOCAL MCP server — the downstream tool provider.
 *
 * WHERE THIS SITS
 * ---------------
 *   MCP client  →  Oathrion MCP gateway  →  [ this server ]  →  mock HTTP downstream
 *
 * This is the piece Phase 4 was missing. Up to Phase 3 an Oathrion "tool" was an
 * in-process class, so "the tool was called" meant "a method ran in the same
 * Node process". Here the tool is a separate MCP server reached over a socket,
 * which in turn makes an HTTP request to a separate downstream server. The
 * chain is real; only the far end is a fixture.
 *
 * It is a genuine MCP `2026-07-28` server, not a stub with an HTTP endpoint. It
 * implements `server/discover`, `tools/list` and `tools/call`, requires the
 * mirrored `MCP-Protocol-Version` and `Mcp-Method` headers, and returns proper
 * JSON-RPC frames. That matters because Oathrion's tool implementation talks to it
 * as a real MCP client, so if either side drifted from the protocol the tests
 * would fail rather than quietly agree on a private dialect.
 *
 * IT HAS NO GOVERNANCE, ON PURPOSE
 * --------------------------------
 * There is no policy engine here, no approval queue, no mandate, no identity
 * check and no amount ceiling. `stripe.refund` will refund ten million euros.
 * `customer.delete` will delete anything it is asked to delete, immediately.
 *
 * This is the honest way to build the demonstration. A downstream that also
 * refused dangerous actions would make every BLOCK test ambiguous — you could
 * never tell whether Oathrion stopped the action or the tool did. By making the
 * downstream maximally willing, the only remaining explanation for a
 * `customer.delete` that never arrives is that Oathrion refused to forward it.
 *
 * It is exactly the MCP server an enterprise should be afraid of, which is why
 * it is the right thing to put an authorization layer in front of.
 *
 * LOCAL / SIMULATED: no external network call, no credential, no real money.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { closeServer } from "./mock-downstream";
import { readWireHeader, wireHeader } from "@shared/wire-headers";

/** Protocol revision this server speaks. Matches Oathrion's own gateway. */
const PROTOCOL_VERSION = "2026-07-28";
const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

export interface LocalMcpServer {
  readonly url: string;
  /** How many tool calls this server has actually executed. */
  toolCallCount(): number;
  reset(): void;
  close(): Promise<void>;
}

/**
 * The tools this server offers, and where each one sends its HTTP request.
 *
 * Named `stripe.refund` and `customer.delete` per the brief. Dots are legal in
 * an MCP tool name and they are used deliberately: it keeps the downstream's
 * vocabulary visibly distinct from Oathrion's internal action verbs (`refund`,
 * `delete_customer`), so the mapping between the two is explicit in
 * `mcp-client-tools.ts` rather than an accident of matching strings.
 */
const TOOLS = [
  {
    name: "stripe.refund",
    description: "Refunds a charge. LOCAL MOCK: performs no real payment operation.",
    path: "/mock/refund",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object" as const,
      properties: {
        customer: { type: "string", description: "Customer reference." },
        amount: { type: "number", description: "Amount to refund." },
        currency: { type: "string", description: "ISO currency code." },
      },
      required: ["customer"],
      additionalProperties: false,
    },
  },
  {
    name: "customer.delete",
    description:
      "Permanently deletes a customer record. LOCAL MOCK: performs no real deletion. " +
      "This server applies NO safety check of its own.",
    path: "/mock/customer/delete",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object" as const,
      properties: {
        customer: { type: "string", description: "Customer reference." },
      },
      required: ["customer"],
      additionalProperties: false,
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Public tool descriptors, without the internal routing detail. */
function catalogue() {
  return TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

/**
 * Starts the server.
 *
 * `downstreamUrl` is the mock HTTP server this one forwards to, so the caller
 * controls the whole chain and nothing is read from ambient configuration.
 */
export async function startLocalMcpServer(downstreamUrl: string): Promise<LocalMcpServer> {
  let calls = 0;

  const server = createServer((req, res) => {
    const reply = (status: number, payload: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    const fail = (
      status: number,
      id: string | number | null,
      code: number,
      message: string,
    ): void => reply(status, { jsonrpc: "2.0", id, error: { code, message } });

    if (req.method !== "POST") return fail(405, null, -32600, "Only POST is supported.");

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 256_000) req.destroy();
    });

    req.on("end", () => {
      void (async () => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return fail(400, null, -32700, "Parse error.");
        }

        const id = (frame.id ?? null) as string | number | null;
        if (frame.jsonrpc !== "2.0" || typeof frame.method !== "string") {
          return fail(400, id, -32600, "Invalid request.");
        }

        const params = (
          typeof frame.params === "object" && frame.params !== null ? frame.params : {}
        ) as Record<string, unknown>;
        const meta = (
          typeof params._meta === "object" && params._meta !== null ? params._meta : {}
        ) as Record<string, unknown>;

        /*
         * The same mirrored-header rule Oathrion's gateway enforces. Kept here so
         * that Oathrion's MCP *client* is exercised against a server that actually
         * demands correctness — a permissive downstream would let a malformed
         * client pass and the bug would surface only against a real provider.
         */
        const headerVersion = req.headers["mcp-protocol-version"];
        if (headerVersion !== PROTOCOL_VERSION) {
          return fail(
            400,
            id,
            -32020,
            `MCP-Protocol-Version header must be "${PROTOCOL_VERSION}", got "${String(headerVersion)}".`,
          );
        }
        if (req.headers["mcp-method"] !== frame.method) {
          return fail(400, id, -32020, "Mcp-Method header does not match the body method.");
        }
        if (meta[META_PROTOCOL] !== PROTOCOL_VERSION) {
          return fail(400, id, -32020, `params._meta must declare "${PROTOCOL_VERSION}".`);
        }
        if (typeof meta[META_CAPABILITIES] !== "object" || meta[META_CAPABILITIES] === null) {
          return fail(400, id, -32021, `params._meta must declare "${META_CAPABILITIES}".`);
        }

        if (frame.method === "server/discover") {
          return reply(200, {
            jsonrpc: "2.0",
            id,
            result: {
              supportedVersions: [PROTOCOL_VERSION],
              capabilities: { tools: {} },
              instructions:
                "LOCAL MOCK tool provider. Applies no authorization of its own: every call " +
                "received is executed. Put an authorization layer in front of it.",
              ttlMs: 60_000,
              cacheScope: "public",
            },
          });
        }

        if (frame.method === "tools/list") {
          return reply(200, {
            jsonrpc: "2.0",
            id,
            result: { tools: catalogue(), ttlMs: 60_000, cacheScope: "public" },
          });
        }

        if (frame.method === "tools/call") {
          const name = params.name;
          if (typeof name !== "string") {
            return fail(400, id, -32602, '"params.name" is required.');
          }
          if (req.headers["mcp-name"] !== name) {
            return fail(400, id, -32020, "Mcp-Name header does not match params.name.");
          }
          const tool = BY_NAME.get(name);
          if (!tool) return fail(404, id, -32602, `Unknown tool "${name}".`);

          const args = (
            typeof params.arguments === "object" && params.arguments !== null
              ? params.arguments
              : {}
          ) as Record<string, unknown>;

          /*
           * Counted BEFORE the downstream request, so a downstream failure
           * still records that this server was willing to act. A counter that
           * only increments on success would under-report exactly the case
           * worth knowing about.
           */
          calls += 1;

          const correlation = readWireHeader("executionId", (name) => {
            const value = req.headers[name.toLowerCase()];
            return typeof value === "string" ? value : undefined;
          });

          try {
            const downstream = await fetch(`${downstreamUrl}${tool.path}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                // Forwarded so a test can tie the physical HTTP request to the
                // governed execution that caused it.
                ...(typeof correlation === "string"
                  ? { [wireHeader("executionId")]: correlation }
                  : {}),
              },
              body: JSON.stringify(args),
            });

            const payload = (await downstream.json()) as Record<string, unknown>;

            return reply(200, {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `LOCAL MOCK: ${name} executed against ${downstreamUrl}${tool.path}.`,
                  },
                ],
                structuredContent: { ...payload, tool: name, local: true },
                isError: !downstream.ok,
              },
            });
          } catch (error) {
            // A transport failure is a tool error, reported in the result with
            // isError so the caller can see and react, per the MCP spec.
            return reply(200, {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `LOCAL MOCK: ${name} could not reach the downstream: ${String(error)}`,
                  },
                ],
                isError: true,
              },
            });
          }
        }

        return fail(404, id, -32601, `Method "${String(frame.method)}" is not implemented.`);
      })();
    });

    return undefined;
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    toolCallCount: () => calls,
    reset: () => {
      calls = 0;
    },
    close: () => closeServer(server),
  };
}
