/**
 * LE CLIENT MCP STDIO (`server/gateway/tools/stdio-mcp-child.ts`) — étape E1 de
 * `oathrion wrap` (`notes/CONCEPTION-OATHRION-WRAP.md`).
 *
 * Contre un vrai processus enfant (`fixtures/fake-stdio-mcp-server.cjs`), pas un double en
 * mémoire : le protocole est une ligne JSON par message sur des tubes, et c'est le tube qui
 * casse en vrai (enfant mort, ligne de journal parasite, silence).
 *
 * Ce qui compte le plus est la dernière partie : chaque échec dit si la requête a PU
 * atteindre l'enfant. Un « rien envoyé » faux ouvrirait une relance, donc un doublon.
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { StdioCallError, StdioMcpChild } from "../gateway/tools/stdio-mcp-child";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-stdio-mcp-server.cjs");
const children: StdioMcpChild[] = [];

function child(env: Record<string, string> = {}): { child: StdioMcpChild; log: string } {
  const log = join(mkdtempSync(join(tmpdir(), "oathrion-stdio-")), "appels.jsonl");
  const instance = new StdioMcpChild({
    command: process.execPath,
    args: [FAKE],
    env: { PATH: process.env.PATH ?? "", FAKE_MCP_LOG: log, ...env },
  });
  children.push(instance);
  return { child: instance, log };
}

function calls(log: string): { name: string }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name: string });
}

async function failure(promise: Promise<unknown>): Promise<StdioCallError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StdioCallError);
    return error as StdioCallError;
  }
  throw new Error("l'appel aurait dû échouer");
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((c) => c.stop()));
});

describe("la poignée de main et la liste des outils", () => {
  it("initialise, garde la révision acceptée et lit les outils avec leurs annotations", async () => {
    const { child: c } = child();
    await c.start(5_000);
    expect(c.running).toBe(true);
    expect(c.protocolVersion).toBe("2025-06-18");
    expect(c.serverInfo?.name).toBe("faux-serveur");
    const tools = await c.listTools(5_000);
    expect(tools.map((t) => t.name)).toContain("create_note");
    expect(tools.find((t) => t.name === "read_note")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "delete_note")?.annotations?.destructiveHint).toBe(true);
    /* La définition entière est gardée : c'est elle que l'étape E5 empreintera. */
    expect(tools.find((t) => t.name === "create_note")?.raw).toMatchObject({ inputSchema: { required: ["text"] } });
  });

  it("suit la pagination de `tools/list`", async () => {
    const { child: c } = child({ FAKE_MCP_PAGES: "1" });
    await c.start(5_000);
    expect((await c.listTools(5_000)).length).toBe(7);
  });

  it("refuse une révision du protocole qu'il ne parle pas, et arrête l'enfant", async () => {
    const { child: c } = child({ FAKE_MCP_PROTOCOL: "1999-01-01" });
    const error = await failure(c.start(5_000));
    expect(error.kind).toBe("protocol");
    expect(error.message).toMatch(/1999-01-01/);
    expect(c.running).toBe(false);
  });

  it("ignore une ligne de journal parasite sur stdout, et répond au `ping` de l'enfant", async () => {
    const { child: c } = child({ FAKE_MCP_NOISE: "1", FAKE_MCP_PING: "1" });
    await c.start(5_000);
    expect((await c.listTools(5_000)).length).toBe(7);
  });

  it("un programme introuvable : rien n'est parti", async () => {
    const c = new StdioMcpChild({ command: "/nexiste/pas/serveur-mcp", args: [] });
    children.push(c);
    const error = await failure(c.start(2_000));
    expect(error.kind).toBe("not_running");
    expect(error.mayHaveReached).toBe(false);
  });
});

describe("les appels", () => {
  it("transmet les arguments tels quels et rend le résultat", async () => {
    const { child: c, log } = child();
    await c.start(5_000);
    const created = await c.callTool("create_note", { text: "bonjour" }, 5_000);
    expect(created.isError).toBe(false);
    expect(JSON.stringify(created.result)).toContain("note 1 créée");
    expect(calls(log)).toEqual([{ name: "create_note", args: { text: "bonjour" } }]);
  });

  it("un résultat `isError` est rendu comme tel, sans exception", async () => {
    const { child: c } = child();
    await c.start(5_000);
    expect((await c.callTool("failing_tool", {}, 5_000)).isError).toBe(true);
  });
});

describe("chaque échec dit si la requête a pu atteindre l'enfant", () => {
  it("erreur JSON-RPC : l'enfant a reçu, et refusé", async () => {
    const { child: c } = child();
    await c.start(5_000);
    const error = await failure(c.callTool("refuse_tool", {}, 5_000));
    expect(error).toMatchObject({ kind: "rpc_error", mayHaveReached: true, rpcCode: -32602 });
  });

  it("silence : délai dépassé, effet INCONNU", async () => {
    const { child: c, log } = child();
    await c.start(5_000);
    const error = await failure(c.callTool("slow_tool", {}, 300));
    expect(error).toMatchObject({ kind: "timeout", mayHaveReached: true });
    expect(error.message).toMatch(/MAY/);
    expect(calls(log).map((x) => x.name)).toEqual(["slow_tool"]);
  });

  it("enfant mort en plein appel : effet INCONNU, et l'appel suivant dit que rien n'est parti", async () => {
    const { child: c } = child();
    await c.start(5_000);
    const exits: string[] = [];
    c.onExit((d) => exits.push(d));
    const error = await failure(c.callTool("crash_tool", {}, 5_000));
    expect(error).toMatchObject({ kind: "exited", mayHaveReached: true });
    expect(exits).toEqual(["exited with code 3"]);
    expect(c.running).toBe(false);

    const after = await failure(c.callTool("read_note", {}, 5_000));
    expect(after).toMatchObject({ kind: "not_running", mayHaveReached: false });
  });

  it("un arrêt propre ne laisse aucun appel en suspens", async () => {
    const { child: c } = child();
    await c.start(5_000);
    const hanging = c.callTool("slow_tool", {}, 10_000);
    await c.stop();
    const error = await failure(hanging);
    expect(error).toMatchObject({ kind: "exited", mayHaveReached: true });
  });
});
