/**
 * LE BILAN NE RELIT QUE LE NOUVEAU (endurance du 16 novembre, `server/local-verify.ts`) : la
 * console redemande le bilan toutes les 15 s, et la chaîne entière coûtait 250 ms à 3 000
 * reçus. Entre deux relectures complètes, seuls les reçus écrits depuis sont relus, et
 * l'ancre doit être restée la même. Ce qui est vérifié :
 *
 *   · le compte suit les reçus ajoutés, sans relecture complète ;
 *   · l'ancre modifiée : la relecture complète a lieu sur-le-champ, et la voit ;
 *   · un reçu plus ancien modifié : vu à la relecture complète suivante (10 min au plus) ;
 *   · sans `sinceLastCheck` (`oathrion receipts verify`) : toujours tout.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchWrappedServer, unregisterWrappedServer, type StdioMcpTool } from "../gateway/tools/stdio-mcp-tool";
import { bootstrapLocalWorkspace } from "../local-bootstrap";
import { verifyLocalReceipts } from "../local-verify";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { startTestServer, type TestClient } from "./harness";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-stdio-mcp-server.cjs");
const STATE = mkdtempSync(join(tmpdir(), "oathrion-verify-since-"));
const KEY = `oathrion_${randomBytes(32).toString("base64url")}`;

let api: TestClient;
let tool: StdioMcpTool;

async function read(times: number) {
  for (let i = 0; i < times; i += 1) {
    const reply = await api.post<{ result?: { isError: boolean } }>(
      "/api/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mcp.veille.read_note", arguments: {}, _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} } } },
      { auth: KEY, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "mcp.veille.read_note" } },
    );
    expect(reply.body.result?.isError).toBe(false);
  }
}

/* Falsifier un reçu comme le ferait quelqu'un qui a accès au fichier de la base ; rend de quoi le remettre. */
function tamper(position: "last" | "first"): () => void {
  const db = new Database(process.env.OATHRION_DB!);
  const where = `WHERE entry_seq = (SELECT ${position === "last" ? "max" : "min"}(r.entry_seq) FROM action_receipts r JOIN organizations o ON o.id = r.organization_id WHERE o.name = 'Oathrion local')`;
  const { receipt_id: id, result_summary: original } = db.prepare(`SELECT receipt_id, result_summary FROM action_receipts ${where}`).get() as { receipt_id: string; result_summary: string | null };
  db.prepare("UPDATE action_receipts SET result_summary = 'falsifié après coup' WHERE receipt_id = ?").run(id);
  db.close();
  return () => {
    const again = new Database(process.env.OATHRION_DB!);
    again.prepare("UPDATE action_receipts SET result_summary = ? WHERE receipt_id = ?").run(original, id);
    again.close();
  };
}

beforeAll(async () => {
  tool = await launchWrappedServer({ name: "veille", command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 5_000 });
  api = await startTestServer();
  await bootstrapLocalWorkspace({ server: "veille", entries: tool.entries(), agentKey: KEY, baseUrl: "http://127.0.0.1:5999", stateDir: STATE });
});

afterAll(async () => {
  unregisterWrappedServer("veille");
  await tool.shutdown();
});

describe("le bilan ne relit que les reçus écrits depuis", () => {
  let now = Date.parse("2026-11-16T22:00:00Z");
  const since = () => verifyLocalReceipts({ sinceLastCheck: true, now: () => now });

  it("le compte suit les reçus ajoutés", async () => {
    await read(3);
    const start = await since();
    expect(start).toMatchObject({ ok: true });
    await read(2);
    expect(await since()).toMatchObject({ ok: true, entries: start.entries + 2 });
    /* Rien de nouveau : la tête reste la même. */
    expect(await since()).toMatchObject({ ok: true, entries: start.entries + 2 });
  });

  it("l'ancre falsifiée : la relecture complète a lieu tout de suite, et la voit", async () => {
    expect(await since()).toMatchObject({ ok: true });
    const restore = tamper("last");
    expect((await since()).reason).toMatch(/content/);
    restore();
    expect(await since()).toMatchObject({ ok: true });
  });

  it("un reçu ancien falsifié : vu par le bilan à la relecture complète suivante, et par la commande", async () => {
    await read(1);
    expect(await since()).toMatchObject({ ok: true });
    const restore = tamper("first");
    now += 60_000;
    expect(await since()).toMatchObject({ ok: true });
    now += 10 * 60_000;
    expect((await since()).reason).toMatch(/content/);
    expect((await verifyLocalReceipts()).reason).toMatch(/content/);
    restore();
  });
});
