/**
 * LOCAL mock HTTP downstream.
 *
 * WHAT THIS IS
 * ------------
 * A real HTTP server, bound to loopback on an ephemeral port, that stands in
 * for the third-party service at the far end of a tool call — a payment
 * processor, a CRM. It is LOCAL: it talks to nothing, charges nothing, and
 * deletes nothing. There is no Stripe key anywhere in this repository.
 *
 * WHY IT EXISTS RATHER THAN A MOCK OBJECT
 * ---------------------------------------
 * Everything Oathrion claims reduces to one question — *did the action reach the
 * outside world?* Up to Phase 3 the only available answer was an in-process
 * counter on a simulated tool. That counter is good evidence, but it lives in
 * the same process, and the same module graph, as the code it is testing.
 *
 * This server moves the evidence out of the process. It records every request
 * it receives, and a test reads that record back over HTTP. For a BLOCK to look
 * like a success, the failure would now have to cross a socket. "No HTTP
 * request arrived at a separate server" is a categorically stronger statement
 * than "a variable did not increment".
 *
 * WHY IT IS DELIBERATELY DEFENCELESS
 * ----------------------------------
 * It performs no authentication, no authorization and no validation. It will
 * refund any amount to anyone and delete any customer, immediately, on request.
 *
 * That is the entire point and it is not laziness. If the downstream refused
 * dangerous requests on its own, a passing BLOCK test would prove nothing about
 * Oathrion — the action might have been stopped at the far end. Keeping the
 * downstream willing to do anything means that when a `customer.delete` never
 * arrives, the *only* possible explanation is that Oathrion stopped it.
 *
 * It is a test and demo fixture. It is never started by `server/index.ts`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One request as the downstream saw it. */
export interface ReceivedCall {
  method: string;
  path: string;
  body: unknown;
  /** Milliseconds since the process started, for ordering assertions. */
  at: number;
  /**
   * Correlation id forwarded by the local MCP server, which is Oathrion's
   * `executionId`. Lets a test tie a physical HTTP request to the governed
   * execution that caused it — the link that makes the audit trail checkable
   * against reality rather than against itself.
   */
  executionId: string | null;
}

export interface MockDownstream {
  readonly url: string;
  /** Every call received, oldest first. */
  received(): ReceivedCall[];
  /** Calls received on one path. */
  receivedOn(path: string): ReceivedCall[];
  reset(): void;
  close(): Promise<void>;
}

/** Endpoints the mock answers. Anything else is a 404. */
const ROUTES = new Set(["/mock/refund", "/mock/customer/delete"]);

export async function startMockDownstream(): Promise<MockDownstream> {
  const calls: ReceivedCall[] = [];

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;

    const finish = (status: number, payload: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    /*
     * Diagnostics. Deliberately NOT recorded in `calls`: a test reading the
     * record must not change it, or the act of asserting "nothing arrived"
     * would itself add an entry.
     */
    if (req.method === "GET" && path === "/mock/received") {
      return finish(200, { calls });
    }
    if (req.method === "POST" && path === "/mock/reset") {
      calls.length = 0;
      return finish(200, { ok: true });
    }

    if (!ROUTES.has(path)) return finish(404, { error: `No mock route ${req.method} ${path}` });

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // A fixture still should not be a way to exhaust memory.
      if (raw.length > 64_000) req.destroy();
    });
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        return finish(400, { error: "Body was not valid JSON." });
      }

      const executionId = req.headers["x-oathrion-execution-id"];
      calls.push({
        method: req.method ?? "GET",
        path,
        body,
        at: Date.now(),
        executionId: typeof executionId === "string" ? executionId : null,
      });

      /*
       * The response a real provider would give. No checks: see the note above
       * about being defenceless on purpose.
       */
      if (path === "/mock/refund") {
        const amount =
          typeof body === "object" && body !== null && "amount" in body
            ? (body as { amount: unknown }).amount
            : null;
        return finish(200, {
          ok: true,
          // `mock_` prefixed so a reference can never be mistaken for a real
          // provider identifier if it ends up in a log or a screenshot.
          refundId: `mock_rfnd_${calls.length}`,
          amount,
          local: true,
        });
      }

      return finish(200, {
        ok: true,
        deletedRecords: 1,
        irreversible: true,
        local: true,
      });
    });
    return undefined;
  });

  // Loopback only. A fixture that will delete any customer on request must not
  // be reachable from another machine.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    received: () => [...calls],
    receivedOn: (path) => calls.filter((call) => call.path === path),
    reset: () => {
      calls.length = 0;
    },
    close: () => closeServer(server),
  };
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
