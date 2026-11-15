/**
 * Boots the Phase 4 local chain and prints ready-to-paste commands.
 *
 *   npm run mcp:local
 *
 * Starts the mock HTTP downstream and the local MCP server on ephemeral
 * loopback ports, then prints the `OATHRION_LOCAL_MCP_URL` to export and the exact
 * `curl` calls that exercise the three reference scenarios. It does not start
 * Oathrion itself: the point is that Oathrion is the piece you put in front, so it is
 * launched separately and pointed at this chain.
 *
 * Everything here is LOCAL. No credential is read, no external host is
 * contacted, and no real money moves. The downstream applies no authorization
 * of its own by design — see its module comment.
 */

import { startMockDownstream } from "../server/mcp-local/mock-downstream";
import { startLocalMcpServer } from "../server/mcp-local/local-mcp-server";

async function main(): Promise<void> {
  const mock = await startMockDownstream();
  const mcp = await startLocalMcpServer(mock.url);

  const lines = [
    "",
    "Oathrion — Phase 4 local chain is up.",
    "",
    `  mock HTTP downstream   ${mock.url}`,
    `  local MCP server       ${mcp.url}`,
    "",
    "  Chain: MCP client -> Oathrion -> local MCP server -> mock downstream",
    "  The downstream refuses nothing. Oathrion is the only thing that decides.",
    "",
    "1. In another terminal, start Oathrion pointed at this chain:",
    "",
    `     export OATHRION_LOCAL_MCP_URL=${mcp.url}`,
    "     npm run dev",
    "",
    "   Without that variable Oathrion runs SIMULATED and reaches nothing here.",
    "",
    "2. Inspect what the downstream has received (empty for now):",
    "",
    `     curl -s ${mock.url}/mock/received`,
    "",
    "3. Call Oathrion's MCP gateway. Replace <KEY> with an operator API key and",
    "   <AGENT> with an active agent id (the seed uses agt_billing):",
    "",
    "     curl -s http://localhost:5000/api/mcp \\",
    '       -H "Content-Type: application/json" \\',
    '       -H "Authorization: Bearer <KEY>" \\',
    '       -H "Accept: application/json, text/event-stream" \\',
    '       -H "MCP-Protocol-Version: 2026-07-28" \\',
    '       -H "Mcp-Method: tools/call" \\',
    '       -H "Mcp-Name: refund" \\',
    '       -H "X-Oathrion-Agent-Id: <AGENT>" \\',
    "       -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{",
    '            "name":"refund","arguments":{"target":"cus_demo","amount":75,"currency":"EUR"},',
    '            "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",',
    '                     "io.modelcontextprotocol/clientCapabilities":{}}}}\'',
    "",
    "   Expect: ALLOW, and one entry now visible at /mock/received.",
    "",
    "4. Repeat with amount 750 -> APPROVAL_REQUIRED, and /mock/received stays",
    "   unchanged until a human approves via POST /api/approvals/:id/approve.",
    "",
    "5. Repeat with Mcp-Name: delete_customer and name \"delete_customer\"",
    "   -> BLOCK, and /mock/received never records it.",
    "",
    "Ctrl-C to stop.",
    "",
  ];
  console.log(lines.join("\n"));

  const shutdown = async (): Promise<void> => {
    await mcp.close();
    await mock.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
