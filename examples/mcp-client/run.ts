/*
 * eslint-disable no-console
 *
 * This file is a runnable demonstration whose entire output is its printed
 * table of decisions. `console.log` is the deliverable here, not a stray
 * debug statement, so the rule is switched off for this file with a reason
 * rather than left to emit warnings that train the reader to ignore lint.
 */
/* eslint-disable no-console */
/**
 * MCP client → Oathrion gateway, using the OFFICIAL @modelcontextprotocol/client v2.
 *
 * Runnable against a live Oathrion. Nothing here is simulated: every decision is the
 * server's, and every "the tool did not run" claim is checked by reading the
 * tool's own invocation counter back over the REST API — evidence from the far
 * side of the boundary, rather than from the same payload whose truthfulness is
 * in question.
 *
 *     npx tsx examples/mcp-client/run.ts
 *
 * See ./README.md for the protocol-version pin and for why an unlisted tool is a
 * protocol error here but a BLOCK decision over HTTP.
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const OATHRION_URL = process.env.OATHRION_URL ?? "http://127.0.0.1:5000";
const OATHRION_API_KEY = process.env.OATHRION_API_KEY;
const OATHRION_AGENT_ID = process.env.OATHRION_AGENT_ID ?? "agt_billing";

/*
 * Oathrion implements this revision and nothing older. The SDK defaults to 'legacy'
 * negotiation, which tops out at 2025-11-25, so a current client must pin.
 */
const PROTOCOL_VERSION = "2026-07-28";

if (!OATHRION_API_KEY) {
  console.error("Set OATHRION_API_KEY to an Oathrion API key with the `operator` role.");
  process.exit(1);
}

/** Reads a tool's live invocation count over the REST API. */
async function toolRuns(toolId: string): Promise<number> {
  const res = await fetch(new URL("/api/tools", OATHRION_URL), {
    headers: { authorization: `Bearer ${OATHRION_API_KEY}` },
  });
  if (!res.ok) throw new Error(`GET /api/tools returned ${res.status}`);
  const rows = (await res.json()) as Array<{ id: string; toolExecutionCount: number }>;
  const row = rows.find((r) => r.id === toolId);
  if (!row) throw new Error(`tool "${toolId}" is not registered`);
  return row.toolExecutionCount;
}

function report(label: string, decision: string, ran: boolean, note = "") {
  const verdict = decision.padEnd(18);
  console.log(`  ${label.padEnd(34)} ${verdict} tool ran: ${ran ? "YES" : "no"}  ${note}`);
}

async function main() {
  const client = new Client(
    { name: "placet-mcp-example", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );

  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/mcp", OATHRION_URL), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${OATHRION_API_KEY}`,
          // Oathrion authorises per agent. The credential may also be BOUND to one,
          // in which case naming a different agent here is refused outright.
          "X-Oathrion-Agent-Id": OATHRION_AGENT_ID,
        },
      },
    }),
  );

  console.log(`\nConnected to Oathrion at ${OATHRION_URL} as agent ${OATHRION_AGENT_ID}.\n`);

  const listed = await client.listTools();
  console.log(`Tools this agent may see: ${listed.tools.map((t) => t.name).join(", ")}\n`);

  /* ---------------- A · within the limit → ALLOW, tool runs -------------- */

  let before = await toolRuns("refund_tool");
  const allowed = await client.callTool({
    name: "refund",
    arguments: { target: "customer:cus_example_1", amount: 75, currency: "EUR" },
  });
  const a = allowed.structuredContent as Record<string, unknown>;
  report("A · refund 75 EUR", String(a.decision), (await toolRuns("refund_tool")) > before);

  /* ------------- B · over the limit → APPROVAL_REQUIRED, no run ---------- */

  before = await toolRuns("refund_tool");
  const held = await client.callTool({
    name: "refund",
    arguments: { target: "customer:cus_example_2", amount: 750, currency: "EUR" },
  });
  const b = held.structuredContent as Record<string, unknown>;
  report(
    "B · refund 750 EUR",
    String(b.decision),
    (await toolRuns("refund_tool")) > before,
    `approval ${b.approvalId ?? "?"} is waiting for a human`,
  );

  /* -------------------- C · governed refusal → BLOCK --------------------- */

  before = await toolRuns("customer_tool");
  const blocked = await client.callTool({
    name: "delete_customer",
    arguments: { target: "customer:cus_example_3" },
  });
  const c = blocked.structuredContent as Record<string, unknown>;
  report("C · delete_customer", String(c.decision), (await toolRuns("customer_tool")) > before);

  /* ------------- D · a tool the gateway does not list → refused ---------- */

  before = await toolRuns("refund_tool");
  try {
    await client.callTool({
      name: "custom.company.operation",
      arguments: { target: "customer:cus_example_4" },
    });
    // Reaching here would mean an undeclared action was accepted, which is the
    // one outcome this example exists to rule out.
    console.error("  D · FAILED: an undeclared tool was accepted.");
    process.exitCode = 1;
  } catch (error) {
    /*
     * Expected, and note the SHAPE: over MCP an unlisted tool is refused at the
     * protocol layer, so the SDK throws instead of returning a BLOCK payload.
     * Over HTTP the same verb comes back as a normal BLOCK decision. Both are
     * fail-closed; only the handling differs. See README.md.
     */
    report(
      "D · custom.company.operation",
      "PROTOCOL ERROR",
      (await toolRuns("refund_tool")) > before,
      `refused: ${(error as Error).message.slice(0, 60)}`,
    );
  }

  console.log("\nOathrion decided every one of these. The client chose nothing.\n");
  await client.close();
}

main().catch((error) => {
  console.error("\nExample failed:", error);
  process.exit(1);
});
