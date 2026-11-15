/**
 * `oathrion wrap`, ÉTAPE E2 — un serveur MCP enveloppé, gouverné de bout en bout.
 *
 * Un vrai processus enfant (`fixtures/fake-stdio-mcp-server.cjs`), la vraie passerelle, la
 * vraie approbation, la vraie chaîne de reçus. La preuve décisive est du côté de l'enfant :
 * il note chaque `tools/call` reçu, donc une action retenue ou bloquée qui l'aurait atteint
 * se verrait dans son journal.
 *
 *   · le classement : lecture, écriture, destruction — un doute tombe vers « écriture » ;
 *   · le catalogue n'accepte que des verbes `mcp.` portant une portée `mcp:*` ;
 *   · une lecture passe et l'agent reçoit la réponse de l'enfant, telle quelle ;
 *   · une écriture retenue n'atteint pas l'enfant avant l'approbation, puis une seule fois ;
 *   · une destruction n'est ni annoncée ni appelable sans la portée `mcp:destructive` ;
 *   · un enfant muet donne un effet INCONNU, et la relance est refusée ;
 *   · la chaîne de reçus se vérifie à la fin.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpActionError, registerMcpActions } from "@shared/policy/actions";

import { StdioMcpChild } from "../gateway/tools/stdio-mcp-child";
import {
  StdioMcpTool,
  WrappedServerError,
  classifyChildTool,
  registerWrappedServer,
  unregisterWrappedServer,
} from "../gateway/tools/stdio-mcp-tool";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { seedIfEmpty } from "../repositories";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-stdio-mcp-server.cjs");
const AGENT = "agt_wrap_notes";
const LOG = join(mkdtempSync(join(tmpdir(), "oathrion-wrap-")), "appels.jsonl");

let api: TestClient;
let child: StdioMcpChild;

function calls(): { name: string; args: Record<string, unknown> }[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> });
}

async function mcp<T>(method: string, params: Record<string, unknown>): Promise<{ status: number; body: { result?: T; error?: { message: string } } }> {
  return api.post(
    "/api/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} } },
    },
    {
      auth: ROLE_KEYS.operator,
      headers: {
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": method,
        ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
        "X-Oathrion-Agent-Id": AGENT,
      },
    },
  );
}

interface Governance {
  decision: string;
  executionId: string;
  approvalId: string | null;
  attempted: boolean;
  succeeded: boolean;
  effect: string;
  mode: string;
}

interface CallResult {
  content: { type: string; text?: string }[];
  isError: boolean;
  _meta: Record<string, Governance>;
}

const governanceOf = (result: CallResult | undefined): Governance => Object.values(result?._meta ?? {}).find((v) => typeof v === "object" && v !== null && "decision" in v) as Governance;

beforeAll(async () => {
  process.env.OATHRION_MCP_TIMEOUT_MS = "800";
  child = new StdioMcpChild({ command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH ?? "", FAKE_MCP_LOG: LOG } });
  await child.start(5_000);
  registerWrappedServer(new StdioMcpTool("notes", child, await child.listTools(5_000)));

  api = await startTestServer();
  await seedIfEmpty();
  const created = await api.post(
    "/api/agents",
    {
      id: AGENT,
      name: "Agent des notes",
      description: "oathrion wrap, étape E2.",
      provider: "custom",
      model: "agent-mcp",
      status: "active",
      owner: "test",
      mandate: { maxTransactionAmount: null, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
      permissions: ["mcp:read", "mcp:write"].map((scope) => ({ scope, label: scope, description: "", granted: true, risk: "medium" })),
      policyIds: [],
      tags: [],
    },
    { auth: ROLE_KEYS.admin },
  );
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

  /* La règle que le mode local écrira par défaut (étape E3) : les écritures attendent une personne. */
  const policy = await api.post(
    "/api/policies",
    {
      id: "pol_wrap_notes_writes",
      name: "notes : les écritures attendent une approbation",
      description: "Règle par défaut d'un serveur enveloppé.",
      type: "REQUIRE_HUMAN_APPROVAL",
      condition: { kind: "targetMatches", targets: ["mcp://notes/create_note"] },
      scope: "organization",
      appliesTo: "all agents",
      effect: "require_approval",
      status: "enabled",
      action: "APPROVAL_REQUIRED",
      risk: "medium",
      priority: 5,
    },
    { auth: ROLE_KEYS.admin },
  );
  expect(policy.status, JSON.stringify(policy.body)).toBeLessThan(300);
});

afterAll(async () => {
  delete process.env.OATHRION_MCP_TIMEOUT_MS;
  unregisterWrappedServer("notes");
  await child.stop();
});

describe("le classement tombe toujours du côté prudent", () => {
  it.each([
    ["read_note", { readOnlyHint: true }, "read"],
    ["list_files", { readOnlyHint: true }, "read"],
    ["getUser", { readOnlyHint: true }, "read"],
    ["create_note", undefined, "write"],
    /* Une annotation seule ne suffit pas : le nom doit aussi dire « lecture ». */
    ["update_note", { readOnlyHint: true }, "write"],
    /*
     * Sans annotation, un nom de lecture suffit (§5.48 : le serveur GitHub n'annote rien) ;
     * avec `readOnlyHint: false` explicite, jamais.
     */
    ["get_note", undefined, "read"],
    ["get_note", { readOnlyHint: false }, "write"],
    /* Une lecture annotée n'a plus besoin d'un nom en get/list (filesystem, memory). */
    ["directory_tree", { readOnlyHint: true }, "read"],
    ["open_nodes", { readOnlyHint: true }, "read"],
    /* Les vrais noms du serveur GitHub. */
    ["get_pull_request_status", undefined, "read"],
    ["list_commits", undefined, "read"],
    ["search_code", undefined, "read"],
    ["merge_pull_request", undefined, "write"],
    ["add_issue_comment", undefined, "write"],
    ["create_or_update_file", undefined, "write"],
    /* Un mot d'écriture l'emporte sur une annotation de lecture. */
    ["sync_repository", { readOnlyHint: true }, "write"],
    ["get_and_update", undefined, "write"],
    ["delete_note", undefined, "destructive"],
    ["create_note", { destructiveHint: true }, "destructive"],
    /* La destruction l'emporte sur tout, même une lecture annoncée. */
    ["get_and_delete", { readOnlyHint: true }, "destructive"],
    ["pay_invoice", undefined, "destructive"],
    ["refundCharge", undefined, "destructive"],
    ["remove_file", undefined, "destructive"],
    ["run_shell", undefined, "destructive"],
    ["run_command", undefined, "destructive"],
  ] as const)("%s %j → %s", (name, annotations, expected) => {
    expect(classifyChildTool({ name, annotations })).toBe(expected);
  });
});

describe("le catalogue n'accepte que des verbes mcp. tenus aux mêmes exigences", () => {
  const base = { financial: false, outbound: false, risk: "LOW" as const, description: "x" };
  it.each([
    ["un nom hors de la famille", { ...base, action: "delete_everything", requiredScope: "mcp:write" }],
    ["un nom mal formé", { ...base, action: "mcp.notes", requiredScope: "mcp:write" }],
    ["une portée absente", { ...base, action: "mcp.autre.x", requiredScope: null }],
    ["une portée étrangère", { ...base, action: "mcp.autre.x", requiredScope: "execute:payments" }],
    ["un verbe financier", { ...base, action: "mcp.autre.x", requiredScope: "mcp:write", financial: true }],
    ["un verbe déjà enregistré", { ...base, action: "mcp.notes.read_note", requiredScope: "mcp:read" }],
  ])("refuse %s", (_label, descriptor) => {
    expect(() => registerMcpActions([descriptor])).toThrow(McpActionError);
  });

  it("refuse un second serveur du même nom", () => {
    expect(() => registerWrappedServer(new StdioMcpTool("notes", child, []))).toThrow(WrappedServerError);
  });

  it("refuse deux outils qui donneraient le même verbe", () => {
    expect(() => new StdioMcpTool("double", child, [{ name: "Create_Note", raw: {} }, { name: "create_note", raw: {} }])).toThrow(/same verb/);
  });
});

describe("ce que l'agent voit et ce qui atteint l'enfant", () => {
  it("tools/list annonce lectures et écritures avec le schéma de l'enfant, jamais les destructions", async () => {
    const reply = await mcp<{ tools: { name: string; inputSchema: unknown; description: string }[] }>("tools/list", {});
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const tools = reply.body.result?.tools ?? [];
    const names = tools.map((t) => t.name).filter((n) => n.startsWith("mcp.notes."));
    expect(names).toContain("mcp.notes.read_note");
    expect(names).toContain("mcp.notes.create_note");
    expect(names).not.toContain("mcp.notes.delete_note");
    const create = tools.find((t) => t.name === "mcp.notes.create_note");
    expect(create?.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    expect(create?.description).toMatch(/authorised by Oathrion/);
  });

  it("une LECTURE passe, et l'agent reçoit la réponse de l'enfant telle quelle", async () => {
    const reply = await mcp<CallResult>("tools/call", { name: "mcp.notes.read_note", arguments: {} });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.result?.isError).toBe(false);
    expect(reply.body.result?.content).toEqual([{ type: "text", text: "[]" }]);
    expect(governanceOf(reply.body.result)).toMatchObject({ decision: "ALLOW", succeeded: true, mode: "STDIO_MCP" });
    expect(calls().map((c) => c.name)).toEqual(["read_note"]);
  });

  it("une ÉCRITURE est retenue SANS atteindre l'enfant, puis part UNE fois après l'approbation", async () => {
    const before = calls().length;
    const held = await mcp<CallResult>("tools/call", { name: "mcp.notes.create_note", arguments: { text: "bonjour" } });
    const governance = governanceOf(held.body.result);
    expect(governance).toMatchObject({ decision: "APPROVAL_REQUIRED", attempted: false });
    expect(calls().length).toBe(before);

    /* La personne qui approuve LIT ce qu'elle approuve : le texte de la note, pas « [object Object] ». */
    const pending = await api.get<{ id: string; context: { label: string; value: string }[] }>(
      `/api/approvals/${String(governance.approvalId)}`,
      { auth: ROLE_KEYS.approver },
    );
    expect(pending.body.context).toContainEqual({ label: "arguments.text", value: "bonjour" });
    expect(JSON.stringify(pending.body.context)).not.toContain("[object Object]");

    const approved = await api.post<{ succeeded: boolean }>(`/api/approvals/${String(governance.approvalId)}/approve`, {}, { auth: ROLE_KEYS.approver });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.succeeded).toBe(true);
    expect(calls().slice(before)).toEqual([{ name: "create_note", args: { text: "bonjour" } }]);

    /* La seconde approbation ne relâche rien. */
    await api.post(`/api/approvals/${String(governance.approvalId)}/approve`, {}, { auth: ROLE_KEYS.approver });
    expect(calls().length).toBe(before + 1);
  });

  it("une DESTRUCTION n'est pas appelable sans la portée mcp:destructive, et n'atteint pas l'enfant", async () => {
    const before = calls().length;
    const reply = await mcp<CallResult>("tools/call", { name: "mcp.notes.delete_note", arguments: { index: 0 } });
    expect(reply.status).toBe(404);
    expect(reply.body.error?.message).toMatch(/Unknown tool/);
    expect(calls().length).toBe(before);
  });

  it("des arguments qui ne sont pas un objet sont refusés avant toute décision", async () => {
    const reply = await mcp<CallResult>("tools/call", { name: "mcp.notes.read_note", arguments: ["x"] });
    expect(reply.status).toBe(400);
  });

  it("un enfant MUET : effet INCONNU, et la relance est refusée", async () => {
    const before = calls().length;
    const reply = await mcp<CallResult>("tools/call", { name: "mcp.notes.slow_tool", arguments: {} });
    const governance = governanceOf(reply.body.result);
    expect(governance).toMatchObject({ decision: "ALLOW", succeeded: false, effect: "unknown" });
    expect(calls().slice(before).map((c) => c.name)).toEqual(["slow_tool"]);

    const retried = await api.post(`/api/executions/${governance.executionId}/retry`, {}, { auth: ROLE_KEYS.admin });
    expect(retried.status).toBe(409);
    expect(calls().length).toBe(before + 1);
  });

  /*
   * UNE SEULE CHAÎNE (STRESS-TEST-LOG §5.41, §5.42). Ce test épinglait d'abord la limite :
   * la passerelle n'écrivait pas dans la chaîne de reçus d'autorité, et un test antérieur
   * passait sur une chaîne vide. Depuis `gateway-ledger.ts`, chaque outil EXÉCUTÉ par la
   * passerelle laisse un reçu dans la même chaîne que `/api/actions/*`. Ce qui n'a pas
   * tourné — bloqué, retenu sans approbation, invisible — n'en laisse aucun.
   */
  it("chaque outil exécuté laisse un reçu dans la chaîne du locataire, et la chaîne se vérifie", async () => {
    const verified = await api.get<{ ok: boolean; entries: number; consumedWithoutReceipt: number }>("/api/actions/receipts/verify", { auth: ROLE_KEYS.admin });
    expect(verified.status).toBe(200);
    expect(verified.body.ok).toBe(true);
    /* read_note, create_note (après approbation), slow_tool (effet inconnu) : trois exécutions. */
    expect(verified.body.entries).toBe(3);
    expect(verified.body.consumedWithoutReceipt).toBe(0);

    const receipts = await api.get<{ receipts?: { action: string; outcome: string; downstreamExecutionId: string }[] } | { action: string; outcome: string; downstreamExecutionId: string }[]>(
      "/api/actions/receipts",
      { auth: ROLE_KEYS.admin },
    );
    const list = Array.isArray(receipts.body) ? receipts.body : (receipts.body.receipts ?? []);
    const byAction = Object.fromEntries(list.map((r) => [r.action, r.outcome]));
    expect(byAction).toEqual({ "mcp.notes.read_note": "succeeded", "mcp.notes.create_note": "succeeded", "mcp.notes.slow_tool": "failed" });
    for (const receipt of list) expect(receipt.downstreamExecutionId).toMatch(/^exe_/);
  });
});
