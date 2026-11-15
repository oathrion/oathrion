/**
 * `oathrion wrap`, étape E3c — la commande que lance le client MCP.
 *
 *   · le nom du serveur, déduit de sa commande ;
 *   · le relais : traduction des noms dans les deux sens, aucun outil d'un autre serveur,
 *     fermé quand Oathrion ne répond pas ;
 *   · de bout en bout : la VRAIE commande, lancée comme Cursor la lancera, à qui l'on parle
 *     en stdio. Ce dernier bloc demande `dist/oathrion-local.cjs` (`npm run build`) ; sans
 *     lui, il est sauté BRUYAMMENT, jamais réussi en silence.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { FAST, trustTestRunner } from "./hub-test-kit";
import { parseWrapArgs } from "./index";
import { localBundle } from "./launch";
import { deriveServerName } from "./name";
import { McpRelay } from "./relay";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAKE = join(ROOT, "server", "test", "fixtures", "fake-stdio-mcp-server.cjs");

describe("le nom du serveur", () => {
  it.each([
    [["npx", "-y", "@modelcontextprotocol/server-github"], "github"],
    [["npx", "@modelcontextprotocol/server-filesystem@2025.1.1", "/tmp"], "filesystem"],
    [["uvx", "mcp-server-fetch"], "fetch"],
    [["docker", "run", "-i", "--rm", "ghcr.io/github/github-mcp-server"], "github"],
    [["node", "./outils/mon-serveur.js"], "mon-serveur"],
    [["/usr/local/bin/linear-mcp"], "linear"],
    [["npx", "-y"], "npx"],
  ])("%j → %s", (command, expected) => {
    const [cmd, ...args] = command as [string, ...string[]];
    expect(deriveServerName(cmd, args)).toBe(expected);
  });
});

describe("les arguments", () => {
  it("--wait : 50 s par défaut (sous le délai de Cursor), 0 pour ne pas attendre, borné ; --attendre reste compris", () => {
    expect(parseWrapArgs(["--", "srv"]).approvalWaitMs).toBe(50_000);
    expect(parseWrapArgs(["--wait", "0", "--", "srv"]).approvalWaitMs).toBe(0);
    expect(parseWrapArgs(["--attendre", "7", "--", "srv"]).approvalWaitMs).toBe(7_000);
    expect(() => parseWrapArgs(["--wait", "-1", "--", "srv"])).toThrow(/--wait/);
    expect(() => parseWrapArgs(["--wait", "9999", "--", "srv"])).toThrow(/--wait/);
  });

  it("--approval : la console par défaut, le client sur demande, rien d'autre ; --approbation reste compris", () => {
    expect(parseWrapArgs(["--", "srv"]).approval).toBe("auto");
    expect(parseWrapArgs(["--approval", "client", "--", "srv"]).approval).toBe("auto");
    expect(parseWrapArgs(["--approval", "console", "--", "srv"]).approval).toBe("console");
    /* Les configurations écrites par la préversion 0 portent l'option française. */
    expect(parseWrapArgs(["--approbation", "console", "--", "srv"]).approval).toBe("console");
    expect(() => parseWrapArgs(["--approval", "partout", "--", "srv"])).toThrow(/--approval/);
  });

  it("la commande après --, le nom déduit ou donné", () => {
    expect(parseWrapArgs(["--", "npx", "-y", "@modelcontextprotocol/server-github"])).toMatchObject({ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    expect(parseWrapArgs(["--name", "gh", "--port", "5400", "--", "srv"])).toMatchObject({ name: "gh", port: 5400, command: "srv" });
  });

  it("refuse sans --, un nom inutilisable, une option inconnue", () => {
    expect(() => parseWrapArgs(["npx", "srv"])).toThrow(/goes after "--"/);
    expect(() => parseWrapArgs(["--name", "Mon Serveur", "--", "srv"])).toThrow(/--name refused/);
    expect(() => parseWrapArgs(["--vite", "--", "srv"])).toThrow(/Unknown option/);
  });
});

/* Un faux Oathrion : rend ce qu'on lui prépare, garde ce qu'il reçoit. */
function fakeOathrion(answer: (body: Record<string, unknown>) => { status: number; body?: unknown }) {
  const received: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    received.push(body);
    const { status, body: reply } = answer(body);
    return new Response(reply === undefined ? null : JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
  return { received, fetchImpl };
}

const LISTING = {
  tools: [
    { name: "mcp.carnet.create_note", inputSchema: { type: "object" }, _meta: { "dev.placet/governance": { originalName: "Create_Note" } } },
    { name: "mcp.autre.secret", inputSchema: { type: "object" } },
    { name: "refund", inputSchema: { type: "object" } },
  ],
};

describe("oathrion receipts", () => {
  it("refuse une sous-commande inconnue, et le dit", async () => {
    const { runReceipts } = await import("./receipts");
    const errors: string[] = [];
    expect(runReceipts(["supprimer"], {}, () => {}, (l) => errors.push(l))).toBe(3);
    expect(errors.join("\n")).toMatch(/oathrion receipts verify/);
  });

  /*
   * Relevé sur la machine de l'utilisateur : avec un ancien dossier `notes/` (préversion
   * d'avant le pivot) ET le pivot qui sert `notes`, `--name notes` ne relisait que l'ancien,
   * figé au 28 octobre. Les deux chaînes doivent être relues, la vieille nommée comme telle.
   * Les bases sont vides : seul compte ici CE QUI est vérifié, pas le verdict.
   */
  it("--name relit le pivot ET l'ancien dossier du serveur, et nomme l'ancien comme tel", async () => {
    const { runReceipts } = await import("./receipts");
    const root = mkdtempSync(join(tmpdir(), "oathrion-receipts-"));
    mkdirSync(join(root, "_local", "serveurs", "notes"), { recursive: true });
    writeFileSync(join(root, "_local", "oathrion.db"), "");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "oathrion.db"), "");
    const lines: string[] = [];
    runReceipts(["verify", "--name", "notes"], { OATHRION_WRAP_HOME: root }, (l) => lines.push(l), (l) => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^[✓✗] local hub \(all servers\) — /);
    expect(lines[1]).toMatch(/^[✓✗] notes \(older folder, from before the local hub\) — /);
  });

  it("sans pivot, un ancien dossier garde son nom simple", async () => {
    const { runReceipts } = await import("./receipts");
    const root = mkdtempSync(join(tmpdir(), "oathrion-receipts-"));
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "oathrion.db"), "");
    const lines: string[] = [];
    runReceipts(["verify", "--name", "notes"], { OATHRION_WRAP_HOME: root }, (l) => lines.push(l), (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^[✓✗] notes — /);
  });
});

describe("le relais", () => {
  it("présente les outils de CE serveur sous leur nom d'origine, et rien d'autre", async () => {
    const out: string[] = [];
    const { fetchImpl } = fakeOathrion(() => ({ status: 200, body: { jsonrpc: "2.0", id: 9, result: LISTING } }));
    const relay = new McpRelay({ endpoint: "http://x/api/mcp", key: "k", serverName: "carnet", write: (l) => out.push(l), log: () => {}, fetchImpl });
    await relay.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    const reply = JSON.parse(out[0]!) as { id: number; result: { tools: { name: string }[] } };
    expect(reply.id).toBe(1);
    expect(reply.result.tools.map((t) => t.name)).toEqual(["Create_Note"]);
  });

  it("traduit le nom à l'appel, même sans liste préalable, et envoie la clé", async () => {
    const out: string[] = [];
    const { received, fetchImpl } = fakeOathrion((body) =>
      body.method === "tools/list"
        ? { status: 200, body: { jsonrpc: "2.0", id: body.id, result: LISTING } }
        : { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { content: [], isError: false } } },
    );
    const relay = new McpRelay({ endpoint: "http://x/api/mcp", key: "k", serverName: "carnet", write: (l) => out.push(l), log: () => {}, fetchImpl });
    await relay.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "Create_Note", arguments: { a: 1 } } }));
    expect(received.at(-1)).toMatchObject({ method: "tools/call", params: { name: "mcp.carnet.create_note", arguments: { a: 1 } } });
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 2, result: { isError: false } });
  });

  it("un outil d'un autre serveur reste inconnu du client", async () => {
    const out: string[] = [];
    const { received, fetchImpl } = fakeOathrion((body) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, result: LISTING } }));
    const relay = new McpRelay({ endpoint: "http://x/api/mcp", key: "k", serverName: "carnet", write: (l) => out.push(l), log: () => {}, fetchImpl });
    await relay.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "secret" } }));
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 3, error: { code: -32602 } });
    expect(received.every((m) => m.method === "tools/list")).toBe(true);
  });

  it("FERMÉ : Oathrion injoignable, l'appel est refusé et le dit", async () => {
    const out: string[] = [];
    const relay = new McpRelay({
      endpoint: "http://x/api/mcp",
      key: "k",
      serverName: "carnet",
      write: (l) => out.push(l),
      log: () => {},
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    await relay.handle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 4, error: { code: -32603, message: expect.stringMatching(/NOT passed/) } });
  });

  it("une notification n'attend pas de réponse, un message illisible en reçoit une", async () => {
    const out: string[] = [];
    const { fetchImpl } = fakeOathrion(() => ({ status: 202 }));
    const relay = new McpRelay({ endpoint: "http://x/api/mcp", key: "k", serverName: "carnet", write: (l) => out.push(l), log: () => {}, fetchImpl });
    await relay.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(out).toEqual([]);
    await relay.handle("{pas du json");
    expect(JSON.parse(out[0]!)).toMatchObject({ id: null, error: { code: -32700 } });
  });
});

const bundleReady = existsSync(localBundle({}));
if (!bundleReady) {
  console.warn(`[wrap.test] SAUTÉ — ${localBundle({})} absent : lancez « npm run build » pour éprouver oathrion wrap de bout en bout.`);
}

describe.skipIf(!bundleReady)("de bout en bout : la vraie commande, en stdio, comme un client MCP", () => {
  it("lecture rendue, écriture retenue, destruction absente, sortie standard propre, état sur disque", async () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-wrap-home-"));
    trustTestRunner(home, join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"));
    const log = join(home, "appels.jsonl");
    const child = spawn(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "cli", "bin.ts"), "wrap", "--name", "carnet", "--attendre", "0", "--", process.execPath, FAKE],
      { env: { PATH: process.env.PATH ?? "", HOME: home, OATHRION_WRAP_HOME: home, FAKE_MCP_LOG: log, ...FAST }, stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines: string[] = [];
    const waiters = new Map<number, (value: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      lines.push(line);
      const message = JSON.parse(line) as { id: number };
      waiters.get(message.id)?.(message as unknown as Record<string, unknown>);
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const ask = (id: number, method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((done) => {
        waiters.set(id, done);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    const init = await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init, stderr).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = (await ask(2, "tools/list")) as { result: { tools: { name: string; description?: string }[] } };
    const names = listed.result.tools.map((t) => t.name).sort();
    /* La destruction n'est pas listée ; l'outil d'information la nomme, pour que l'agent sache pourquoi (§5.57). */
    expect(names).toEqual(["crash_tool", "create_note", "failing_tool", "oathrion_withheld_tools", "read_note", "refuse_tool", "slow_tool"]);
    expect(listed.result.tools.find((t) => t.name === "oathrion_withheld_tools")?.description).toMatch(/: delete_note\./);

    const read = (await ask(3, "tools/call", { name: "read_note", arguments: {} })) as { result: { isError: boolean; content: unknown[] } };
    expect(read.result).toMatchObject({ isError: false, content: [{ type: "text", text: "[]" }] });

    const write = (await ask(4, "tools/call", { name: "create_note", arguments: { text: "x" } })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(write.result.isError).toBe(true);
    expect(write.result.content[0]!.text).toMatch(/Held for human approval[\s\S]*Approve it here: http:\/\/127\.0\.0\.1:\d+\/console#\/approvals Calling this tool again with the same arguments creates no new request/);
    expect(stderr).toMatch(/"create_note" is waiting for your approval/);
    expect(readFileSync(log, "utf8")).not.toMatch(/create_note/);

    child.stdin.end();
    const code = await new Promise<number | null>((done) => child.once("exit", (c) => done(c)));
    expect(code).toBe(0);

    /* La sortie standard ne porte que des messages JSON-RPC. */
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(stderr).toMatch(/1 read\(s\) allowed, 5 write\(s\) on approval, 1 destructive tool\(s\) blocked/);

    /* L'état du PIVOT : la base, le port, le secret en 0600 ; la commande du serveur ; jamais la clé de l'agent. */
    const state = join(home, "_local");
    expect(readdirSync(state).sort()).toEqual(expect.arrayContaining(["oathrion.db", "oathrion.log", "port", "serveurs", "session.secret"]));
    expect(readdirSync(join(state, "serveurs", "carnet"))).toEqual(expect.arrayContaining(["commande.json", "outils-acceptes.json"]));
    /* Plus d'invitation en local : la personne est administratrice d'emblée (§5.53). */
    expect(readdirSync(state)).not.toContain("invitation.url");
    expect(stderr).toMatch(/console: "oathrion console" opens it, signed in/);
    expect(stderr).toMatch(/"test": this client's agent/);
    expect(statSync(join(state, "session.secret")).mode & 0o777).toBe(0o600);
    /* Les fichiers seulement (les dossiers, comme celui des mascottes, n'en sont pas). */
    for (const file of [...readdirSync(state).filter((f) => !f.startsWith("oathrion.db") && !statSync(join(state, f)).isDirectory()), ...readdirSync(join(state, "serveurs", "carnet")).map((f) => join("serveurs", "carnet", f))]) {
      expect(readFileSync(join(state, file), "utf8")).not.toMatch(/oathrion_[A-Za-z0-9_-]{40,}/);
    }

    /*
     * `oathrion receipts verify` : la lecture exécutée laisse UN reçu (l'écriture retenue
     * n'a rien exécuté), et la chaîne est intacte. Puis un reçu est falsifié dans la base,
     * comme le ferait quelqu'un qui a accès au fichier : la commande doit le voir.
     */
    const verify = (extra: string[]) =>
      spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "cli", "bin.ts"), "receipts", "verify", ...extra], {
        env: { PATH: process.env.PATH ?? "", HOME: home, OATHRION_WRAP_HOME: home, ...FAST },
        encoding: "utf8",
      });
    const intact = verify(["--name", "carnet"]);
    expect(intact.status, intact.stderr).toBe(0);
    expect(intact.stdout).toMatch(/✓ local hub \(all servers\) — chain intact: 1 receipt\(s\)/);

    const db = new Database(join(state, "oathrion.db"));
    db.prepare("UPDATE action_receipts SET result_summary = 'falsifié après coup'").run();
    db.close();
    const broken = verify([]);
    expect(broken.status).toBe(1);
    expect(broken.stdout).toMatch(/✗ local hub \(all servers\) — BROKEN/);

    expect(verify(["--name", "inconnu"]).status).toBe(3);
  }, 120_000);
});

/** Une session `wrap` courte : initialiser, lister, fermer. Rend les noms vus et la sortie d'erreur. */
async function listedBySession(home: string, extraEnv: Record<string, string>): Promise<{ names: string[]; stderr: string; descriptions: string }> {
  const child = spawn(
    process.execPath,
    [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "cli", "bin.ts"), "wrap", "--name", "carnet", "--attendre", "0", "--", process.execPath, FAKE],
    { env: { PATH: process.env.PATH ?? "", HOME: home, OATHRION_WRAP_HOME: home, ...FAST, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const answers = new Map<number, (m: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id: number };
    answers.get(message.id)?.(message as unknown as Record<string, unknown>);
  });
  const ask = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((done) => {
      answers.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const listed = (await ask(2, "tools/list")) as { result: { tools: { name: string; description: string }[] } };
  child.stdin.end();
  await new Promise((done) => child.once("exit", done));
  return {
    names: listed.result.tools.map((t) => t.name).sort(),
    stderr,
    descriptions: listed.result.tools.map((t) => t.description).join("\n"),
  };
}

describe.skipIf(!bundleReady)("de bout en bout : une « mise à jour » hostile du serveur (étape E5)", () => {
  it("la définition empoisonnée et l'outil nouveau sont RETIRÉS jusqu'à l'accord, puis rendus un par un", async () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-pins-home-"));
    trustTestRunner(home, join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"));
    const cli = (args: string[]) =>
      spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "cli", "bin.ts"), ...args], {
        env: { PATH: process.env.PATH ?? "", HOME: home, OATHRION_WRAP_HOME: home },
        encoding: "utf8",
      });

    /* 1. Premier lancement : tout est épinglé. */
    const first = await listedBySession(home, {});
    expect(first.names).toContain("create_note");
    expect(first.stderr).toMatch(/first launch: the definitions of 7 tool\(s\) are pinned/);

    /* 2. Le serveur « se met à jour » : description empoisonnée, outil nouveau. */
    const hostile = await listedBySession(home, { FAKE_MCP_VARIANT: "2" });
    expect(hostile.names).not.toContain("create_note");
    expect(hostile.names).not.toContain("export_notes");
    expect(hostile.names).toContain("read_note");
    /* Le modèle ne lit JAMAIS la description empoisonnée. */
    expect(hostile.descriptions).not.toMatch(/exfiltration/);
    expect(hostile.stderr).toMatch(/2 tool\(s\) WITHDRAWN until you approve: create_note \(changed: description\), export_notes \(new\)/);

    const listing = cli(["tools", "list", "--name", "carnet"]);
    expect(listing.status).toBe(1);
    expect(listing.stdout).toMatch(/! create_note\s+CHANGED — withdrawn \(description\)/);
    expect(listing.stdout).toMatch(/! export_notes\s+NEW — withdrawn/);

    /* 3. Une personne accepte UN outil : il revient au lancement suivant, l'autre reste retiré. */
    expect(cli(["tools", "accept", "--name", "carnet", "export_notes"]).status).toBe(0);
    const after = await listedBySession(home, { FAKE_MCP_VARIANT: "2" });
    expect(after.names).toContain("export_notes");
    expect(after.names).not.toContain("create_note");
    expect(cli(["tools", "accept", "--name", "inconnu"]).status).toBe(3);
  }, 180_000);
});
