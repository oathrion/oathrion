/**
 * `oathrion wrap`, étape E4 — l'approbation sur place, dans le même appel.
 *
 * Le vrai serveur (harnais), un vrai enfant, l'amorçage local, et le relais de
 * `cli/wrap/relay.ts` branché sur l'API du harnais. Une personne (une clé d'approbateur de
 * l'espace local) décide PENDANT que l'appel de l'agent attend :
 *
 *   · approuvée : l'agent reçoit la réponse de l'enfant, comme si l'appel venait d'aboutir,
 *     et l'enfant n'a été appelé qu'UNE fois, après la décision ;
 *   · refusée : l'agent reçoit un refus clair, l'enfant n'a rien reçu ;
 *   · délai écoulé, ou attente désactivée : l'agent reçoit « retenu » avec le lien ;
 *   · le client qui donne un `progressToken` reçoit des notifications de progression ;
 *   · le même appel, rejoué par un client qui a abandonné l'attente (Cursor, vers 60 s), ne
 *     crée pas de nouvelle demande : une approbation, une exécution (STRESS-TEST-LOG §5.50).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpRelay, WITHHELD_TOOL, approvalQuestion, callKey, governanceInstructions } from "../../cli/wrap/relay";
import { repositoriesFor } from "../repositories";
import { displayPrefixOf, hashKey } from "../api-keys";
import { launchWrappedServer, unregisterWrappedServer, type StdioMcpTool } from "../gateway/tools/stdio-mcp-tool";
import { bootstrapLocalWorkspace, type LocalWorkspace } from "../local-bootstrap";
import { apiKeyStore } from "../repositories/api-keys";
import { startTestServer, type TestClient } from "./harness";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-stdio-mcp-server.cjs");
const STATE = mkdtempSync(join(tmpdir(), "oathrion-approval-"));
const LOG = join(STATE, "appels.jsonl");
const AGENT_KEY = `oathrion_${randomBytes(32).toString("base64url")}`;
const APPROVER_KEY = `oathrion_${randomBytes(32).toString("base64url")}`;

let api: TestClient;
let tool: StdioMcpTool;
let workspace: LocalWorkspace;

const calls = (): string[] =>
  existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { name: string }).name) : [];

function relay(options: { approvalWaitMs: number; logs?: string[]; out?: string[]; approverKey?: string; watchMs?: number }) {
  const out = options.out ?? [];
  return {
    out,
    relay: new McpRelay({
      endpoint: `${api.baseUrl}/api/mcp`,
      key: AGENT_KEY,
      serverName: "atelier",
      write: (line) => out.push(line),
      log: (line) => options.logs?.push(line),
      approvalWaitMs: options.approvalWaitMs,
      pollMs: 50,
      approverKey: options.approverKey,
      /* Pas de relecture en arrière-plan pendant les autres tests. */
      watchMs: options.watchMs ?? 3_600_000,
    }),
  };
}

type Answer = { id: number; result?: { isError: boolean; content: { type: string; text?: string }[]; _meta?: Record<string, Record<string, unknown>> } };
const answerOf = (out: string[], id: number): Answer | undefined => out.map((l) => JSON.parse(l) as Answer).find((m) => m.id === id);

/** La première approbation en attente de l'espace local, lue par l'approbateur. */
async function pendingApproval(): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const list = await api.get<{ id: string; status: string }[]>("/api/approvals", { auth: APPROVER_KEY });
    const pending = list.body.find((a) => a.status === "pending");
    if (pending) return pending.id;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error("aucune approbation en attente");
}

beforeAll(async () => {
  tool = await launchWrappedServer({
    name: "atelier",
    command: process.execPath,
    args: [FAKE],
    env: { PATH: process.env.PATH ?? "", FAKE_MCP_LOG: LOG },
    timeoutMs: 5_000,
  });
  api = await startTestServer();
  workspace = await bootstrapLocalWorkspace({ server: "atelier", entries: tool.entries(), agentKey: AGENT_KEY, baseUrl: api.baseUrl, stateDir: STATE });
  /* La personne qui approuve : une clé d'approbateur DE L'ESPACE LOCAL. */
  apiKeyStore.create({
    id: "key_test_approbateur_local",
    organizationId: workspace.organizationId,
    name: "approbatrice",
    role: "approver",
    secretHash: hashKey(APPROVER_KEY),
    prefix: displayPrefixOf(APPROVER_KEY),
    source: "user",
    createdBy: "test",
  });
});

afterAll(async () => {
  unregisterWrappedServer("atelier");
  await tool.shutdown();
});

const call = (id: number, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });

describe("l'agent attend la personne, dans le même appel", () => {
  it("APPROUVÉE : l'agent reçoit la réponse de l'enfant, appelé une seule fois après la décision", async () => {
    const logs: string[] = [];
    const { relay: r, out } = relay({ approvalWaitMs: 10_000, logs });
    const before = calls().length;
    const waiting = r.handle(call(1, "create_note", { text: "approuvée" }));

    const approvalId = await pendingApproval();
    expect(calls().length).toBe(before);
    expect(logs.join("\n")).toMatch(/"create_note" is waiting for your approval: http:\/\/.+\/console#\/approvals/);
    const approved = await api.post(`/api/approvals/${approvalId}/approve`, {}, { auth: APPROVER_KEY });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    await waiting;
    const answer = answerOf(out, 1);
    expect(answer?.result?.isError).toBe(false);
    expect(answer?.result?.content).toEqual([{ type: "text", text: expect.stringMatching(/note \d+ créée/) }]);
    expect(Object.values(answer?.result?._meta ?? {})[0]).toMatchObject({ decision: "ALLOW", approval: "approved", succeeded: true });
    expect(calls().slice(before)).toEqual(["create_note"]);
  });

  it("REFUSÉE : un refus clair, et l'enfant n'a rien reçu", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 10_000 });
    const before = calls().length;
    const waiting = r.handle(call(2, "create_note", { text: "refusée" }));
    const approvalId = await pendingApproval();
    expect((await api.post(`/api/approvals/${approvalId}/reject`, {}, { auth: APPROVER_KEY })).status).toBe(200);
    await waiting;
    const answer = answerOf(out, 2);
    expect(answer?.result?.isError).toBe(true);
    expect(answer?.result?.content[0]?.text).toMatch(/^Rejected by .+ — the tool was NOT called\.$/);
    expect(calls().length).toBe(before);
  });

  it("DÉLAI ÉCOULÉ : « retenu », avec le lien ; et une progression pour le client qui la demande", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 300 });
    await r.handle(call(3, "create_note", { text: "délai" }, { progressToken: "p-3" }));
    const answer = answerOf(out, 3);
    expect(answer?.result?.isError).toBe(true);
    expect(answer?.result?.content[0]?.text).toMatch(/Held for human approval[\s\S]*Approve it here: http:\/\/\S+\/console#\/approvals Calling this tool again with the same arguments creates no new request/);
    expect(out.some((l) => /"method":"notifications\/progress".*"progressToken":"p-3"/.test(l))).toBe(true);
    /* L'approbation reste en attente : rien n'est relâché par le délai. */
    await api.post(`/api/approvals/${await pendingApproval()}/reject`, {}, { auth: APPROVER_KEY });
  });

  it("ATTENTE DÉSACTIVÉE : « retenu » tout de suite, avec le lien", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 0 });
    await r.handle(call(4, "create_note", { text: "sans attente" }));
    expect(answerOf(out, 4)?.result?.content[0]?.text).toMatch(/Approve it here: /);
    await api.post(`/api/approvals/${await pendingApproval()}/reject`, {}, { auth: APPROVER_KEY });
  });

  it("une LECTURE n'attend rien", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 10_000 });
    await r.handle(call(5, "read_note", {}));
    expect(answerOf(out, 5)?.result?.isError).toBe(false);
  });
});

const pendingCount = async (): Promise<number> =>
  (await api.get<{ status: string }[]>("/api/approvals", { auth: APPROVER_KEY })).body.filter((a) => a.status === "pending").length;

describe("le même appel, rejoué par un client qui a abandonné l'attente", () => {
  it("« le même appel » : le verbe et les arguments, quel que soit l'ordre des clés", () => {
    expect(callKey("mcp.a.b", { x: 1, y: { p: 2, q: [3, { r: 4, s: 5 }] } })).toBe(callKey("mcp.a.b", { y: { q: [3, { s: 5, r: 4 }], p: 2 }, x: 1 }));
    expect(callKey("mcp.a.b", { x: 1 })).not.toBe(callKey("mcp.a.b", { x: 2 }));
    expect(callKey("mcp.a.b", { x: 1 })).not.toBe(callKey("mcp.a.c", { x: 1 }));
    expect(callKey("mcp.a.b", undefined)).toBe(callKey("mcp.a.b", {}));
  });

  it("aucune nouvelle demande pendant l'attente ; approuvée, le rejeu reçoit la réponse ; l'enfant est appelé une fois", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 200 });
    const before = calls().length;
    const pendingBefore = await pendingCount();

    await r.handle(call(10, "create_note", { text: "une seule fois" }));
    expect(answerOf(out, 10)?.result?.content[0]?.text).toMatch(/Held for human approval/);
    expect(await pendingCount()).toBe(pendingBefore + 1);

    /* Le client abandonne et réessaie, deux fois : toujours la même demande. */
    await r.handle(call(11, "create_note", { text: "une seule fois" }));
    await r.handle(call(12, "create_note", { text: "une seule fois" }));
    expect(answerOf(out, 12)?.result?.content[0]?.text).toMatch(/Held for human approval/);
    expect(await pendingCount()).toBe(pendingBefore + 1);

    const approvalId = await pendingApproval();
    expect((await api.post(`/api/approvals/${approvalId}/approve`, {}, { auth: APPROVER_KEY })).status).toBe(200);

    await r.handle(call(13, "create_note", { text: "une seule fois" }));
    const answer = answerOf(out, 13);
    expect(answer?.result?.isError).toBe(false);
    expect(answer?.result?.content).toEqual([{ type: "text", text: expect.stringMatching(/note \d+ créée/) }]);
    expect(calls().slice(before)).toEqual(["create_note"]);

    /* L'issue rendue, le même appel redevient un appel nouveau : une nouvelle demande. */
    await r.handle(call(14, "create_note", { text: "une seule fois" }));
    expect(await pendingCount()).toBe(pendingBefore + 1);
    await api.post(`/api/approvals/${await pendingApproval()}/reject`, {}, { auth: APPROVER_KEY });
  });

  it("des arguments différents font une demande à part", async () => {
    const { relay: r } = relay({ approvalWaitMs: 0 });
    const pendingBefore = await pendingCount();
    await r.handle(call(20, "create_note", { text: "première" }));
    await r.handle(call(21, "create_note", { text: "seconde" }));
    expect(await pendingCount()).toBe(pendingBefore + 2);
    await api.post(`/api/approvals/${await pendingApproval()}/reject`, {}, { auth: APPROVER_KEY });
    await api.post(`/api/approvals/${await pendingApproval()}/reject`, {}, { auth: APPROVER_KEY });
  });

  it("refusée pendant que le client ne regardait plus : le rejeu reçoit le refus, l'enfant n'a rien reçu", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 0 });
    const before = calls().length;
    await r.handle(call(30, "create_note", { text: "refusée plus tard" }));
    await api.post(`/api/approvals/${await pendingApproval()}/reject`, {}, { auth: APPROVER_KEY });
    const pendingBefore = await pendingCount();
    await r.handle(call(31, "create_note", { text: "refusée plus tard" }));
    expect(answerOf(out, 31)?.result?.content[0]?.text).toMatch(/^Rejected by .+ — the tool was NOT called\.$/);
    expect(await pendingCount()).toBe(pendingBefore);
    expect(calls().length).toBe(before);
  });
});

const initialize = (capabilities: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities, clientInfo: { name: "Cursor", version: "1.0.0" } } });

/** La question que le relais pose au client, quand elle arrive. */
async function questionIn(out: string[]): Promise<{ id: string; params: { message: string; requestedSchema: unknown } }> {
  for (let i = 0; i < 200; i += 1) {
    const line = out.find((l) => l.includes('"elicitation/create"'));
    if (line) return JSON.parse(line) as { id: string; params: { message: string; requestedSchema: unknown } };
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("aucune question posée au client");
}

const clientAnswers = (id: string, result: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id, result });

describe("ce que le relais dit à l'agent", () => {
  it("seule la personne approuve : ni console, ni ~/.oathrion, ni API, ni jeton trouvé sur la machine", () => {
    const text = governanceInstructions("atelier");
    expect(text).toMatch(/Only the person approves: never approve your own request/);
    expect(text).toMatch(/run `oathrion console`/);
    expect(text).toMatch(/never call the service directly with a token found on this machine/);
  });
});

describe("approuver DANS le client (--approbation client, elicitation)", () => {
  it("la question est claire : l'outil, le serveur, les arguments en clair, bornés", () => {
    const text = approvalQuestion("fichiers", "write_file", { path: "/tmp/essai.txt", content: "bonjour" });
    expect(text).toContain('Your agent wants to use "write_file" (server "fichiers").');
    /* La consigne en DEUXIÈME ligne : Claude Code n'affiche que le début de la question. */
    expect(text.split("\n")[1]).toMatch(/^To approve here: Space ticks the box, ↓ to Accept[\s\S]*Esc\.$/);
    expect(text).toContain("  path: /tmp/essai.txt");
    expect(text).toContain("  content: bonjour");
    expect(approvalQuestion("s", "t", { long: "x".repeat(1_000) })).toContain("… (1000 characters)");
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`a${String(i)}`, i]));
    expect(approvalQuestion("s", "t", many)).toContain("… and 3 more argument(s)");
    expect(approvalQuestion("s", "t", {})).toContain("(no arguments)");
  });

  it("ACCEPTÉE dans le client : l'action part, l'agent reçoit la réponse du serveur, l'enfant est appelé une fois", async () => {
    const logs: string[] = [];
    const { relay: r, out } = relay({ approvalWaitMs: 10_000, approverKey: APPROVER_KEY, logs });
    await r.handle(initialize({ elicitation: { form: {} } }));
    const before = calls().length;
    const waiting = r.handle(call(50, "create_note", { text: "dans le client" }));

    const question = await questionIn(out);
    expect(question.params.message).toContain('"create_note" (server "atelier")');
    expect(question.params.message).toContain("text: dans le client");
    expect(calls().length).toBe(before);
    expect(question.params.requestedSchema).toMatchObject({ required: ["confirmer"], properties: { confirmer: { type: "boolean" } } });
    await r.handle(clientAnswers(question.id, { action: "accept", content: { confirmer: true, note: "vu dans Cursor" } }));

    await waiting;
    const answer = answerOf(out, 50);
    expect(answer?.result?.isError).toBe(false);
    expect(answer?.result?.content).toEqual([{ type: "text", text: expect.stringMatching(/note \d+ créée/) }]);
    expect(Object.values(answer?.result?._meta ?? {})[0]).toMatchObject({ approval: "approved", approvedBy: "approbatrice" });
    expect(calls().slice(before)).toEqual(["create_note"]);
    expect(logs.join("\n")).toMatch(/approved in Cursor/);
  });

  /* Essai de bout en bout du 8 novembre : l'agent ne lisait que « the execution failed », jamais POURQUOI. */
  it("approuvée, mais le serveur répond par une erreur : l'agent lit la réponse du serveur", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 10_000, approverKey: APPROVER_KEY });
    await r.handle(initialize({ elicitation: { form: {} } }));
    const waiting = r.handle(call(56, "failing_tool", {}));
    const question = await questionIn(out);
    await r.handle(clientAnswers(question.id, { action: "accept", content: { confirmer: true } }));
    await waiting;
    const answer = answerOf(out, 56);
    expect(answer?.result?.isError).toBe(true);
    expect(answer?.result?.content[0]?.text).toMatch(/failed[\s\S]*The server answered: échec métier$/);
  });

  it("REFUSÉE dans le client : un refus clair, l'enfant n'a rien reçu", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 10_000, approverKey: APPROVER_KEY });
    await r.handle(initialize({ elicitation: {} }));
    const before = calls().length;
    const waiting = r.handle(call(51, "create_note", { text: "refusée dans le client" }));
    const question = await questionIn(out);
    await r.handle(clientAnswers(question.id, { action: "decline" }));
    await waiting;
    expect(answerOf(out, 51)?.result?.content[0]?.text).toMatch(/^Rejected by approbatrice in Oathrion — the tool was NOT called\.$/);
    expect(calls().length).toBe(before);
  });

  it("ACCEPTÉE SANS la case (un client qui accepterait seul) : pas une décision, la console reste seule à décider", async () => {
    const logs: string[] = [];
    const { relay: r, out } = relay({ approvalWaitMs: 10_000, approverKey: APPROVER_KEY, logs });
    await r.handle(initialize({ elicitation: { form: {} } }));
    const before = calls().length;
    const waiting = r.handle(call(54, "create_note", { text: "acceptée sans personne" }));
    const question = await questionIn(out);
    await r.handle(clientAnswers(question.id, { action: "accept", content: {} }));
    const approvalId = await pendingApproval();
    expect(calls().length).toBe(before);
    expect(logs.join("\n")).toMatch(/without the "Yes, I approve" box — that is not a decision/);
    expect((await api.post(`/api/approvals/${approvalId}/reject`, {}, { auth: APPROVER_KEY })).status).toBe(200);
    await waiting;
    expect(calls().length).toBe(before);
  });

  it("question FERMÉE sans décider : la console prend le relais, et sa décision est rendue à l'agent", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 10_000, approverKey: APPROVER_KEY });
    await r.handle(initialize({ elicitation: { form: {} } }));
    const waiting = r.handle(call(52, "create_note", { text: "décidée dans la console" }));
    const question = await questionIn(out);
    await r.handle(clientAnswers(question.id, { action: "cancel" }));
    const approvalId = await pendingApproval();
    expect((await api.post(`/api/approvals/${approvalId}/approve`, {}, { auth: APPROVER_KEY })).status).toBe(200);
    await waiting;
    expect(answerOf(out, 52)?.result?.isError).toBe(false);
  });

  /*
   * Essai réel du 8 novembre : la question était affichée dans Claude Code, la personne a
   * approuvé dans la console ; l'agent a attendu la fin du délai (56 s), et la question est
   * restée affichée, périmée.
   */
  it("approuvée dans la CONSOLE pendant que la question est affichée : l'agent l'apprend tout de suite, et la question est refermée", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 30_000, approverKey: APPROVER_KEY });
    await r.handle(initialize({ elicitation: { form: {} } }));
    const started = Date.now();
    const waiting = r.handle(call(57, "create_note", { text: "approuvée ailleurs" }));
    const question = await questionIn(out);
    const approvalId = await pendingApproval();
    expect((await api.post(`/api/approvals/${approvalId}/approve`, {}, { auth: APPROVER_KEY })).status).toBe(200);
    await waiting;
    expect(answerOf(out, 57)?.result?.isError).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
    const cancelled = out.map((l) => JSON.parse(l) as { method?: string; params?: { requestId?: string } }).find((m) => m.method === "notifications/cancelled");
    expect(cancelled?.params?.requestId).toBe(question.id);
    /* Une réponse tardive à la question refermée n'est plus attendue : elle ne fait rien. */
    await r.handle(clientAnswers(question.id, { action: "accept", content: { confirmer: true } }));
  });

  it("un client qui ne sait pas poser la question, ou le choix « console » : aucune question, la console décide", async () => {
    for (const [capabilities, approverKey] of [
      [{}, APPROVER_KEY],
      [{ elicitation: { url: {} } }, APPROVER_KEY],
      [{ elicitation: { form: {} } }, undefined],
    ] as const) {
      /* Une attente non nulle : sans elle, aucune question ne serait posée de toute façon. */
      const { relay: r, out } = relay({ approvalWaitMs: 300, approverKey });
      await r.handle(initialize(capabilities));
      await r.handle(call(53, "create_note", { text: `sans question ${JSON.stringify(capabilities)} ${String(approverKey !== undefined)}` }));
      expect(out.some((l) => l.includes("elicitation/create"))).toBe(false);
      expect(answerOf(out, 53)?.result?.content[0]?.text).toMatch(/Held for human approval/);
      await api.post(`/api/approvals/${await pendingApproval()}/reject`, {}, { auth: APPROVER_KEY });
    }
  });
});

describe("les outils RETENUS : l'agent sait lesquels et pourquoi (§5.57)", () => {
  const list = async (r: McpRelay, out: string[], id: number) => {
    await r.handle(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }));
    return (out.map((l) => JSON.parse(l) as { id: number; result?: { tools: { name: string; description: string; annotations?: unknown }[] } }).find((m) => m.id === id)?.result?.tools ?? []);
  };

  it("sans la permission : delete_note n'est pas listé, un outil d'information le nomme et dit pourquoi", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 0 });
    const tools = await list(r, out, 60);
    expect(tools.map((t) => t.name)).not.toContain("delete_note");
    const info = tools.find((t) => t.name === WITHHELD_TOOL);
    expect(info?.description).toMatch(/withholding 1 tool\(s\) of the "atelier" server: delete_note\. They are classed destructive/);
    expect(info?.annotations).toEqual({ readOnlyHint: true });
  });

  it("appeler l'outil retenu, ou l'outil d'information : l'explication, et rien n'atteint l'enfant", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 0 });
    await list(r, out, 61);
    const before = calls().length;
    await r.handle(call(62, "delete_note", { index: 0 }));
    expect(answerOf(out, 62)?.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/delete_note[\s\S]*Do not work around this/) }] });
    await r.handle(call(63, WITHHELD_TOOL, {}));
    expect(answerOf(out, 63)?.result).toMatchObject({ isError: false });
    /* Sans liste préalable aussi : le relais relit, et explique au lieu de « outil inconnu ». */
    const fresh = relay({ approvalWaitMs: 0 });
    await fresh.relay.handle(call(64, "delete_note", { index: 0 }));
    expect(answerOf(fresh.out, 64)?.result?.isError).toBe(true);
    expect(calls().length).toBe(before);
  });

  it("la console les voit aussi : GET /api/withheld-tools nomme l'agent, l'outil, sa classe et la portée qui manque", async () => {
    const listed = await api.get<{ agentId: string; tools: { name: string; server: string; toolClass: string; scope: string }[] }[]>("/api/withheld-tools", { auth: APPROVER_KEY });
    expect(listed.status).toBe(200);
    expect(listed.body.find((entry) => entry.agentId === "agt_wrap_atelier")?.tools).toEqual([
      { name: "delete_note", server: "atelier", toolClass: "destructive", scope: "mcp:destructive" },
    ]);
  });

  it("la permission accordée : l'outil est listé, l'outil d'information disparaît", async () => {
    const repos = repositoriesFor(workspace.organizationId);
    const agent = (await repos.agents.findById("agt_wrap_atelier"))!;
    await repos.agents.update(agent.id, { permissions: agent.permissions.map((p) => (p.scope === "mcp:destructive" ? { ...p, granted: true } : p)) });
    try {
      const { relay: r, out } = relay({ approvalWaitMs: 0 });
      const names = (await list(r, out, 65)).map((t) => t.name);
      expect(names).toContain("delete_note");
      expect(names).not.toContain(WITHHELD_TOOL);
    } finally {
      await repos.agents.update(agent.id, { permissions: agent.permissions });
    }
  });
});

describe("l'issue ATTENDUE côté serveur (GET /api/approvals/:id/issue)", () => {
  it("approuvée pendant l'attente : l'issue revient aussitôt, pas à la relecture suivante", async () => {
    const { relay: r } = relay({ approvalWaitMs: 0 });
    await r.handle(call(70, "create_note", { text: "issue attendue" }));
    const approvalId = await pendingApproval();

    const started = Date.now();
    const waiting = api.get<{ settled: boolean; approval: { status: string }; execution: { runState: string } }>(
      `/api/approvals/${approvalId}/issue?attendre=5000`,
      { auth: AGENT_KEY },
    );
    await new Promise((done) => setTimeout(done, 150));
    const approvedAt = Date.now();
    expect((await api.post(`/api/approvals/${approvalId}/approve`, {}, { auth: APPROVER_KEY })).status).toBe(200);
    const issue = await waiting;
    expect(issue.status).toBe(200);
    expect(issue.body).toMatchObject({ settled: true, approval: { status: "approved" }, execution: { runState: "succeeded" } });
    expect(Date.now() - approvedAt).toBeLessThan(500);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("sans décision : rend la main à l'échéance, « pas tranchée »", async () => {
    const { relay: r } = relay({ approvalWaitMs: 0 });
    await r.handle(call(71, "create_note", { text: "issue à l'échéance" }));
    const approvalId = await pendingApproval();
    const started = Date.now();
    const issue = await api.get<{ settled: boolean }>(`/api/approvals/${approvalId}/issue?attendre=300`, { auth: AGENT_KEY });
    expect(issue.body.settled).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await api.post(`/api/approvals/${approvalId}/reject`, {}, { auth: APPROVER_KEY });
  });
});

describe("une permission accordée pendant que le client est connecté (§5.59)", () => {
  it("le relais annonce listChanged, puis prévient le client ; la liste suivante montre l'outil", async () => {
    const { relay: r, out } = relay({ approvalWaitMs: 0, watchMs: 100 });
    try {
      await r.handle(JSON.stringify({ jsonrpc: "2.0", id: 80, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
      expect((answerOf(out, 80) as unknown as { result: { capabilities: { tools: { listChanged: boolean } } } }).result.capabilities.tools.listChanged).toBe(true);
      expect((answerOf(out, 80) as unknown as { result: { instructions: string } }).result.instructions).toMatch(/Oathrion authorizes each tool call[\s\S]*\n\nOathrion governs the "atelier" server\.[\s\S]*do not work around it/);
      await r.handle(JSON.stringify({ jsonrpc: "2.0", id: 81, method: "tools/list", params: {} }));

      const repos = repositoriesFor(workspace.organizationId);
      const agent = (await repos.agents.findById("agt_wrap_atelier"))!;
      await repos.agents.update(agent.id, { permissions: agent.permissions.map((p) => (p.scope === "mcp:destructive" ? { ...p, granted: true } : p)) });
      try {
        const deadline = Date.now() + 5_000;
        while (!out.some((l) => l.includes('"notifications/tools/list_changed"')) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
        expect(out.some((l) => l.includes('"notifications/tools/list_changed"'))).toBe(true);
        await r.handle(JSON.stringify({ jsonrpc: "2.0", id: 82, method: "tools/list", params: {} }));
        const names = (out.map((l) => JSON.parse(l) as { id?: number; result?: { tools: { name: string }[] } }).find((m) => m.id === 82)?.result?.tools ?? []).map((t) => t.name);
        expect(names).toContain("delete_note");
        expect(names).not.toContain(WITHHELD_TOOL);
      } finally {
        await repos.agents.update(agent.id, { permissions: agent.permissions });
      }
    } finally {
      r.close();
    }
  });
});

/* En dernier : arrête le serveur enveloppé, comme s'il était tombé. */
describe("approuver quand le serveur enveloppé ne tourne pas", () => {
  it("409, l'approbation n'est pas enregistrée, la demande reste en attente ; rien n'est « sauté »", async () => {
    const { relay: r } = relay({ approvalWaitMs: 0 });
    await r.handle(call(40, "create_note", { text: "serveur arrêté" }));
    const approvalId = await pendingApproval();
    await tool.shutdown();

    const refused = await api.post<{ error: string }>(`/api/approvals/${approvalId}/approve`, {}, { auth: APPROVER_KEY });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/No tool can run "mcp\.atelier\.create_note" right now[\s\S]*still pending/);
    const approval = await api.get<{ status: string; executionId: string }>(`/api/approvals/${approvalId}`, { auth: APPROVER_KEY });
    expect(approval.body.status).toBe("pending");
    const execution = await api.get<{ runState: string }>(`/api/executions/${approval.body.executionId}`, { auth: APPROVER_KEY });
    expect(execution.body.runState).not.toBe("skipped");

    /* Refuser, lui, ne demande aucun outil. */
    expect((await api.post(`/api/approvals/${approvalId}/reject`, {}, { auth: APPROVER_KEY })).status).toBe(200);
  });
});
