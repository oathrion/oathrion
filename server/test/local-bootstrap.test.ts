/**
 * L'AMORÇAGE DU MODE LOCAL (`server/local-bootstrap.ts`) — `oathrion wrap`, étape E3b.
 *
 * Un vrai serveur MCP enfant, lancé par `launchWrappedServer`, puis l'amorçage : espace,
 * agent, clé liée, règles par défaut. Ce qui est vérifié est ce qu'un développeur vivrait :
 *
 *   · la clé de l'agent, présentée seule comme Cursor la présentera, agit pour cet agent ;
 *   · une lecture passe, une écriture attend une approbation SANS atteindre l'enfant ;
 *   · la personne est administratrice d'emblée, sans invitation ni mot de passe à choisir ;
 *   · relancé : la personne n'est pas recréée, l'ancienne clé ne sert plus, aucune
 *     règle n'est réécrite — même une règle qu'une personne a désactivée ;
 *   · un outil nouveau reçoit sa règle, sans toucher aux anciennes ;
 *   · l'enfant ne voit aucune variable d'Oathrion.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashKey } from "../api-keys";
import { launchWrappedServer, unregisterWrappedServer, type StdioMcpTool } from "../gateway/tools/stdio-mcp-tool";
import {
  APPROVER_NAME,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ORGANIZATION,
  bootstrapLocalWorkspace,
  childEnvironment,
  readWrapConfig,
  type LocalWorkspace,
} from "../local-bootstrap";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { repositoriesFor } from "../repositories";
import { apiKeyStore } from "../repositories/api-keys";
import { userStore } from "../repositories/users";
import { login } from "../auth";
import { startTestServer, type TestClient } from "./harness";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-stdio-mcp-server.cjs");
const STATE = mkdtempSync(join(tmpdir(), "oathrion-local-"));
const LOG = join(STATE, "appels.jsonl");

let api: TestClient;
let tool: StdioMcpTool;
let first: LocalWorkspace;
const firstKey = `oathrion_${randomBytes(32).toString("base64url")}`;

const calls = (): string[] =>
  existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { name: string }).name) : [];

async function callAs(key: string, name: string, args: Record<string, unknown> = {}) {
  return api.post<{ result?: { isError: boolean; _meta: Record<string, { decision?: string; attempted?: boolean }> }; error?: unknown }>(
    "/api/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} } },
    },
    { auth: key, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": name } },
  );
}

const decisionOf = (reply: Awaited<ReturnType<typeof callAs>>) =>
  Object.values(reply.body.result?._meta ?? {}).find((v) => typeof v === "object" && v !== null && "decision" in v);

beforeAll(async () => {
  tool = await launchWrappedServer({
    name: "carnet",
    command: process.execPath,
    args: [FAKE],
    env: { PATH: process.env.PATH ?? "", FAKE_MCP_LOG: LOG },
    timeoutMs: 5_000,
  });
  api = await startTestServer();
  first = await bootstrapLocalWorkspace({ server: "carnet", entries: tool.entries(), agentKey: firstKey, baseUrl: "http://127.0.0.1:5999", stateDir: STATE });
});

afterAll(async () => {
  unregisterWrappedServer("carnet");
  await tool.shutdown();
});

describe("le premier lancement prépare tout", () => {
  it("l'espace, et la personne administratrice d'emblée : ni invitation, ni mot de passe connu", () => {
    expect(first.personCreated).toBe(true);
    const person = userStore.findByEmail(LOCAL_ADMIN_EMAIL);
    expect(person).toMatchObject({ status: "active" });
    expect(userStore.membership(first.organizationId, person!.id)).toMatchObject({ role: "admin" });
    expect(existsSync(join(STATE, "invitation.url"))).toBe(false);
    /* Aucun mot de passe deviné ne l'ouvre : on entre par le lien d'`oathrion console`. */
    expect(login(LOCAL_ADMIN_EMAIL, "").session).toBeNull();
  });

  it("l'agent, sans la portée destructive", async () => {
    const agent = await repositoriesFor(first.organizationId).agents.findById("agt_wrap_carnet");
    const granted = agent?.permissions.filter((p) => p.granted).map((p) => p.scope).sort();
    expect(granted).toEqual(["mcp:read", "mcp:write"]);
  });

  it("une clé liée à cet agent", () => {
    expect(apiKeyStore.resolve(hashKey(firstKey))).toMatchObject({ agentId: "agt_wrap_carnet", revokedAt: null });
  });

  it("une règle « sur approbation » pour les écritures, et elles seules", async () => {
    expect(first.createdPolicies).toEqual(["pol_wrap_carnet_1"]);
    const policy = await repositoriesFor(first.organizationId).policies.findById("pol_wrap_carnet_1");
    const actions = (policy?.condition as { actions?: string[] }).actions ?? [];
    expect(actions).toContain("mcp.carnet.create_note");
    expect(actions).not.toContain("mcp.carnet.read_note");
    /* Les destructions aussi (§5.48) : la permission accordée, elles demanderaient une approbation. */
    expect(actions).toContain("mcp.carnet.delete_note");
  });
});

describe("la clé, présentée seule comme un client MCP le fera", () => {
  it("une lecture passe", async () => {
    const reply = await callAs(firstKey, "mcp.carnet.read_note");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(decisionOf(reply)).toMatchObject({ decision: "ALLOW" });
    expect(calls()).toContain("read_note");
  });

  it("une écriture attend une approbation, sans atteindre l'enfant", async () => {
    const before = calls().length;
    const reply = await callAs(firstKey, "mcp.carnet.create_note", { text: "x" });
    expect(decisionOf(reply)).toMatchObject({ decision: "APPROVAL_REQUIRED", attempted: false });
    expect(calls().length).toBe(before);
  });
});

describe("une destruction, même permise, attend une personne", () => {
  it("la permission mcp:destructive accordée, delete_note est retenu pour approbation, pas exécuté", async () => {
    const repos = repositoriesFor(first.organizationId);
    const agent = (await repos.agents.findById("agt_wrap_carnet"))!;
    await repos.agents.update(agent.id, {
      permissions: agent.permissions.map((p) => (p.scope === "mcp:destructive" ? { ...p, granted: true } : p)),
    });
    const before = calls().length;
    const reply = await callAs(firstKey, "mcp.carnet.delete_note", { index: 0 });
    expect(decisionOf(reply)).toMatchObject({ decision: "APPROVAL_REQUIRED", attempted: false });
    expect(calls().length).toBe(before);
    await repos.agents.update(agent.id, { permissions: agent.permissions });
  });
});

describe("relancé, rien de ce qu'une personne a décidé n'est défait", () => {
  it("même lien, l'ancienne clé ne sert plus, aucune règle réécrite — même désactivée", async () => {
    const repos = repositoriesFor(first.organizationId);
    await repos.policies.update("pol_wrap_carnet_1", { status: "disabled" });
    const secondKey = `oathrion_${randomBytes(32).toString("base64url")}`;
    const second = await bootstrapLocalWorkspace({ server: "carnet", entries: tool.entries(), agentKey: secondKey, baseUrl: "http://127.0.0.1:5999", stateDir: STATE });

    expect(second.organizationId).toBe(first.organizationId);
    expect(second.personCreated).toBe(false);
    expect(second.createdPolicies).toEqual([]);
    expect((await repos.policies.findById("pol_wrap_carnet_1"))?.status).toBe("disabled");

    expect(apiKeyStore.resolve(hashKey(firstKey))?.revokedAt).not.toBeNull();
    expect((await callAs(firstKey, "mcp.carnet.read_note")).status).toBe(401);
    expect((await callAs(secondKey, "mcp.carnet.read_note")).status).toBe(200);

    await repos.policies.update("pol_wrap_carnet_1", { status: "enabled" });
  });

  it("un outil nouveau reçoit sa propre règle, sans toucher aux anciennes", async () => {
    const entries = [
      ...tool.entries(),
      { verb: "mcp.carnet.archive_note", original: "archive_note", toolClass: "write" as const },
    ];
    const third = await bootstrapLocalWorkspace({
      server: "carnet",
      entries,
      agentKey: `oathrion_${randomBytes(32).toString("base64url")}`,
      baseUrl: "http://127.0.0.1:5999",
      stateDir: STATE,
    });
    expect(third.createdPolicies).toEqual(["pol_wrap_carnet_2"]);
    const added = await repositoriesFor(first.organizationId).policies.findById("pol_wrap_carnet_2");
    expect((added?.condition as { actions?: string[] }).actions).toEqual(["mcp.carnet.archive_note"]);
  });

  it("la clé d'approbation du relais : seulement si elle est demandée, rôle approbateur, révoquée au lancement suivant", async () => {
    const approverKey = `oathrion_${randomBytes(32).toString("base64url")}`;
    await bootstrapLocalWorkspace({ server: "carnet", entries: tool.entries(), agentKey: `oathrion_${randomBytes(32).toString("base64url")}`, approverKey, baseUrl: "http://127.0.0.1:5999", stateDir: STATE });
    expect(apiKeyStore.resolve(hashKey(approverKey))).toMatchObject({ role: "approver", name: APPROVER_NAME, revokedAt: null, agentId: null });

    await bootstrapLocalWorkspace({ server: "carnet", entries: tool.entries(), agentKey: `oathrion_${randomBytes(32).toString("base64url")}`, baseUrl: "http://127.0.0.1:5999", stateDir: STATE });
    expect(apiKeyStore.resolve(hashKey(approverKey))?.revokedAt).not.toBeNull();
    const live = apiKeyStore.list(first.organizationId).filter((k) => k.role === "approver" && k.revokedAt === null && k.id.startsWith("key_wrap_carnet_"));
    expect(live).toEqual([]);
  });

  it("l'espace porte le nom attendu", () => {
    expect(LOCAL_ORGANIZATION).toBe("Oathrion local");
  });
});

describe("la configuration et l'environnement de l'enfant", () => {
  it("l'enfant ne voit aucune variable d'Oathrion, mais garde celles de la personne", () => {
    const env = childEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/x",
      GITHUB_TOKEN: "le-jeton-de-la-personne",
      OATHRION_SESSION_SECRET: "s",
      OATHRION_LOCAL_AGENT_KEY: "k",
      PLACET_API_KEYS: "a",
      ARIA_X: "b",
      DATABASE_URL: "postgres://x",
      PORT: "5000",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", GITHUB_TOKEN: "le-jeton-de-la-personne" });
  });

  it("la commande est un tableau JSON non vide, et le nom va avec", () => {
    expect(readWrapConfig({})).toBeNull();
    expect(readWrapConfig({ OATHRION_WRAP_NAME: "gh", OATHRION_WRAP_COMMAND: '["npx","-y","srv"]' })).toEqual({ name: "gh", command: "npx", args: ["-y", "srv"] });
    expect(() => readWrapConfig({ OATHRION_WRAP_NAME: "gh" })).toThrow(/go together/);
    expect(() => readWrapConfig({ OATHRION_WRAP_NAME: "gh", OATHRION_WRAP_COMMAND: "npx srv" })).toThrow(/JSON array/);
    expect(() => readWrapConfig({ OATHRION_WRAP_NAME: "gh", OATHRION_WRAP_COMMAND: "[]" })).toThrow(/non-empty/);
  });
});
