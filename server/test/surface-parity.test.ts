/**
 * The transport does not change the decision.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Phase 8 added four new ways to reach Oathrion — the TypeScript SDK, the Python
 * SDK, the CLI and the framework adapter — alongside the two that already
 * existed, raw HTTP and the MCP gateway. Every one of them is a client, and the
 * whole architecture rests on one claim:
 *
 *     Oathrion remains the authority. Everything Phase 8 added is a client.
 *
 * That claim is falsifiable, and until this file it was not tested. Each
 * surface was tested against ITS OWN expectations: `client.test.ts` asserts the
 * SDK returns what a stubbed server said, `cli/main.test.ts` asserts the CLI
 * maps a decision to an exit code. Both would still pass if the SDK quietly
 * sent a different request than the CLI did, or if one surface defaulted
 * `persist` differently, or if a future refactor gave one of them its own
 * opinion about an unknown action.
 *
 * The bug this guards against is not "a surface is broken" — that is caught
 * elsewhere. It is "two surfaces disagree", which is far worse, because the
 * safe answer on one path and the permissive answer on another means the
 * permissive one is the product's real security posture, and nobody finds out
 * from a green suite.
 *
 * WHAT IS ASSERTED
 * ----------------
 * The same scenario, expressed natively on each surface, must produce the same
 * `decision` string. Not "compatible" answers, not "both non-ALLOW" — the same
 * string. Anything weaker would permit a BLOCK on one path and an
 * APPROVAL_REQUIRED on another, which is a real difference in behaviour: one
 * refuses, the other queues an irreversible action for a human who may click
 * approve.
 *
 * The expected decisions are written as literals rather than derived from the
 * HTTP response, so that a change in the engine breaks this file loudly instead
 * of being mirrored into every surface at once and asserted as agreement.
 *
 * The Python SDK is deliberately NOT in this file — it cannot be imported into
 * vitest, and a re-implementation of it here would prove that the copy agrees
 * with the copy. It is covered by its own integration tests against a real
 * server, and by the mutation harness which runs both suites.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OathrionClient } from "../../sdk/typescript/src";
import { run as runCli } from "../../cli/main";
import { EXIT } from "../../cli/exit-codes";
import { withOathrion } from "../../examples/framework-adapter/with-placet";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const AGENT = "agt_billing";

/**
 * Two of the five reference scenarios, chosen because they are the ones every
 * surface can express: a refund under the ceiling, and one over it. Scenario C
 * (`delete_customer`) is included because a BLOCK is the answer most likely to
 * be softened by a client that mishandles a non-200 or an error shape.
 *
 * `amount` values match `pol_refund_approval` in the seed.
 */
const SCENARIOS = [
  { label: "refund under the ceiling", action: "refund", target: "cus_parity", amount: 75, expected: "ALLOW" },
  { label: "refund over the ceiling", action: "refund", target: "cus_parity", amount: 5_000, expected: "APPROVAL_REQUIRED" },
  { label: "customer deletion", action: "delete_customer", target: "cus_parity", amount: undefined, expected: "BLOCK" },
] as const;

interface EvaluateBody {
  decision: string;
  reason: string;
}

describe("surface parity — the transport does not change the decision", () => {
  let api: TestClient;
  let baseUrl: string;

  beforeAll(async () => {
    api = await startTestServer();
    baseUrl = api.baseUrl;
  });

  afterAll(async () => {
    await api.close();
  });

  function inputFor(s: (typeof SCENARIOS)[number]): Record<string, unknown> {
    return s.amount === undefined ? {} : { amount: s.amount, currency: "EUR" };
  }

  for (const scenario of SCENARIOS) {
    describe(scenario.label, () => {
      /*
       * Dry runs throughout. This file is about which answer each surface
       * receives, and persisting would make the scenarios order-dependent:
       * an APPROVAL_REQUIRED would file a real approval on every surface and
       * the BLOCK would accumulate audit rows. Execution semantics are proved
       * in reference-scenarios.test.ts, against a tool counter.
       */

      it(`HTTP → ${scenario.expected}`, async () => {
        const res = await api.post<EvaluateBody>(
          "/api/evaluate",
          {
            agentId: AGENT,
            action: scenario.action,
            target: scenario.target,
            input: inputFor(scenario),
          },
          { auth: ROLE_KEYS.operator },
        );
        expect(res.status).toBe(200);
        expect(res.body.decision).toBe(scenario.expected);
      });

      it(`TypeScript SDK → ${scenario.expected}`, async () => {
        const client = new OathrionClient({
          baseUrl,
          apiKey: ROLE_KEYS.operator,
          agentId: AGENT,
        });
        const decision = await client.evaluate({
          action: scenario.action,
          target: scenario.target,
          input: inputFor(scenario),
        });
        expect(decision.decision).toBe(scenario.expected);

        /*
         * The three booleans are derived, so they are checked against the
         * decision rather than assumed. `pendingApproval` in particular must
         * never coincide with `allowed` — that is the mistake the whole SDK is
         * shaped to prevent.
         */
        expect(decision.allowed).toBe(scenario.expected === "ALLOW");
        expect(decision.blocked).toBe(scenario.expected === "BLOCK");
        expect(decision.pendingApproval).toBe(scenario.expected === "APPROVAL_REQUIRED");
      });

      it(`CLI → exit ${scenario.expected}`, async () => {
        const lines: string[] = [];
        const argv = [
          "evaluate",
          "--action",
          scenario.action,
          "--target",
          scenario.target,
          ...(scenario.amount === undefined
            ? []
            : ["--amount", String(scenario.amount), "--currency", "EUR"]),
        ];

        const code = await runCli(argv, {
          out: (l) => lines.push(l),
          err: (l) => lines.push(l),
          env: {
            OATHRION_URL: baseUrl,
            OATHRION_API_KEY: ROLE_KEYS.operator,
            OATHRION_AGENT_ID: AGENT,
          },
        });

        const expectedCode = {
          ALLOW: EXIT.ALLOW,
          BLOCK: EXIT.BLOCK,
          APPROVAL_REQUIRED: EXIT.APPROVAL_REQUIRED,
        }[scenario.expected];

        expect(code, lines.join("\n")).toBe(expectedCode);
        // The decision must also be legible to a human reading the output, not
        // only encoded in a number nobody prints.
        expect(lines.join("\n")).toContain(scenario.expected);
      });

      it(`framework adapter → ${scenario.expected === "ALLOW" ? "runs" : "does not run"}`, async () => {
        let ran = 0;
        const client = new OathrionClient({ baseUrl, apiKey: ROLE_KEYS.operator, agentId: AGENT });

        const tool = withOathrion(
          {
            name: scenario.action,
            /*
             * L'argument est DÉCLARÉ même s'il est ignoré. `withOathrion` rend désormais
             * exactement le type qu'on lui passe : un outil déclaré sans paramètre ne
             * peut plus être appelé avec un argument, et le typecheck l'a signalé. C'est
             * le bon comportement — et ici l'outil reçoit bien un argument, il n'en fait
             * simplement rien.
             */
            execute: async (_args: Record<string, unknown>) => {
              ran += 1;
              return "done";
            },
          },
          {
            client,
            agentId: AGENT,
            action: scenario.action,
            target: () => scenario.target,
            input: () => inputFor(scenario),
            persist: false,
          },
        );

        if (scenario.expected === "ALLOW") {
          await expect(tool.execute({})).resolves.toBe("done");
          expect(ran).toBe(1);
        } else {
          await expect(tool.execute({})).rejects.toThrow();
          /*
           * The assertion that matters. "It threw" would also be satisfied by a
           * wrapper that called the tool and then threw on the way out, which is
           * the exact failure this is meant to exclude: the side effect having
           * already happened.
           */
          expect(ran, "the underlying tool must NOT have been called").toBe(0);
        }
      });
    });
  }

  /*
   * MCP is asserted separately rather than inside the loop: it invokes the tool
   * for real (there is no dry run over `tools/call`), so it cannot share the
   * non-persisting setup above. The decision must still match.
   */
  describe("MCP gateway", () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.label} → ${scenario.expected}`, async () => {
        const res = await api.post<{
          result?: { structuredContent?: { decision?: string }; isError?: boolean };
          error?: unknown;
        }>(
          "/api/mcp",
          {
            jsonrpc: "2.0",
            id: `parity-${scenario.action}-${Date.now()}`,
            method: "tools/call",
            params: {
              name: scenario.action,
              arguments: { target: scenario.target, ...inputFor(scenario) },
              _meta: {
                [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
                [META_KEYS.clientCapabilities]: {},
              },
            },
          },
          {
            auth: ROLE_KEYS.operator,
            headers: {
              "MCP-Protocol-Version": PROTOCOL_VERSION,
              "Mcp-Method": "tools/call",
              "Mcp-Name": scenario.action,
              "X-Oathrion-Agent-Id": AGENT,
            },
          },
        );

        // A BLOCK is a decision, so it is a 200 with a body — never a transport
        // error. If this ever becomes non-200, a client that treats non-200 as
        // "failed" would report a policy refusal as an outage.
        expect(res.status).toBe(200);
        expect(res.body.result?.structuredContent?.decision).toBe(scenario.expected);

        /*
         * `isError` is what an MCP client actually branches on, so parity of
         * the decision string is not enough on its own — a gateway that
         * reported a held or blocked call as a success would tell the model the
         * refund went through. It must be false ONLY for a completed ALLOW.
         */
        expect(res.body.result?.isError).toBe(scenario.expected !== "ALLOW");
      });
    }
  });
});
