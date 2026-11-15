/**
 * Le driver de l'implémentation de référence.
 *
 * C'est le SEUL fichier du kit qui a le droit de connaître Oathrion. `conformance/src/`
 * n'importe rien de ce dépôt — un tiers remplace ce fichier et garde tout le reste.
 *
 * Ce qu'il fait : il démarre le vrai serveur Express sur un port éphémère, fabrique
 * l'état préparé de SPEC.md § 4 **par l'API publique**, et fournit l'unique opération
 * d'observation O1.
 *
 * ## O1, et sa limite, écrite plutôt que tue
 *
 * `deliveries()` rend le compteur d'appels du serveur MCP local placé DERRIÈRE Oathrion.
 * C'est la seule mesure honnête : le chemin d'autorité dépêche l'action en MCP vers une
 * destination, il ne passe pas par le registre d'outils en mémoire. Une première version
 * de ce driver additionnait `toolExecutionCount` de `GET /api/tools`, et toutes les
 * propriétés qui mesurent Δ ont échoué sur un contrôle positif — le compteur ne bougeait
 * pas, parce qu'il comptait autre chose. Le kit a donc attrapé une erreur de SON PROPRE
 * driver avant d'en attraper une du produit, ce qui est le bon ordre.
 *
 * Limite assumée : le compteur est à l'échelle du serveur MCP, donc commun aux deux
 * organisations qui partagent la destination `local-fixture`. Les propriétés ne lisent
 * jamais sa valeur absolue — seulement un Δ autour d'une étape pendant laquelle un seul
 * locataire agit. Un driver disposant d'un compteur par destination serait meilleur.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Driver, PreparedState } from "../src/types";

const ALLOW_VERB = "stripe.refund";
const BLOCK_VERB = "customer.delete";
const BELOW = 50;
const ABOVE = 500;
/*
 * `local-fixture` est l'identifiant que `OATHRION_LOCAL_MCP_URL` enregistre. C'est le SEUL
 * chemin qui accepte une destination en loopback — les entrées d'`OATHRION_DESTINATIONS`
 * passent par les règles d'adresse anti-SSRF, qui refusent le loopback.
 */
const DESTINATION = "local-fixture";
/** Le MÊME identifiant d'agent dans les deux organisations — c'est ce que C26 attaque. */
const SHARED_AGENT = "agt_conformance";
const SECOND_AGENT = "agt_conformance_two";

/*
 * Les administrateurs sont des HUMAINS, pas des clés de service : l'émission d'un
 * credential exige une session de console, et c'est la bonne règle — une clé d'API qui
 * pourrait en fabriquer d'autres serait une clé d'escalade. Le driver se connecte donc
 * comme le ferait un exploitant.
 */
const ADMIN_A_EMAIL = "admin-a@conformance.test";
const ADMIN_B_EMAIL = "admin-b@conformance.test";
/*
 * Un secret par compte, jamais partagé : un porteur est reconnu à sa seule valeur, donc
 * un secret commun ferait de deux rôles un seul. Le serveur le refuse au démarrage, et
 * il a raison.
 */
const ADMIN_PASSWORD_A = "conformance-admin-secret-alpha-01";
const ADMIN_PASSWORD_B = "conformance-admin-secret-bravo-02";

function agentBody(id: string, name: string) {
  return {
    id,
    name,
    description: "Conformance kit fixture",
    provider: "openai",
    model: "gpt-4",
    status: "active",
    owner: "conformance",
    mandate: {
      maxTransactionAmount: 100000,
      currency: "EUR",
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
    permissions: [],
    policyIds: [],
    tags: ["conformance"],
  };
}

const rules = [
  { id: "apol_conformance_block", name: "Blocked verb", action: BLOCK_VERB, effect: "BLOCK", priority: 300 },
  {
    id: "apol_conformance_hold",
    name: "Above the ceiling needs a human",
    action: ALLOW_VERB,
    destinationId: DESTINATION,
    effect: "APPROVAL_REQUIRED",
    constraints: [{ field: "amount", op: "gt", value: 100 }],
    priority: 200,
  },
  {
    id: "apol_conformance_allow",
    name: "Below the ceiling is routine",
    action: ALLOW_VERB,
    destinationId: DESTINATION,
    effect: "ALLOW",
    constraints: [{ field: "amount", op: "lte", value: 100 }],
    priority: 100,
  },
];

export async function createOathrionDriver(): Promise<Driver> {
  const dir = mkdtempSync(path.join(tmpdir(), "placet-conformance-"));

  /*
   * L'environnement est posé AVANT le premier import du serveur : `server/auth.ts` lit
   * sa configuration à l'import, et une variable posée après serait sans effet.
   */
  process.env.OATHRION_DB = path.join(dir, "conformance.db");
  process.env.OATHRION_SESSION_SECRET = "conformance-session-secret-0123456789";
  process.env.OATHRION_SEED = "config";
  process.env.OATHRION_API_KEYS = "";
  process.env.OATHRION_CONSOLE_USERS = [
    `${ADMIN_A_EMAIL}:admin:${ADMIN_PASSWORD_A}`,
    `Conformance B/${ADMIN_B_EMAIL}:admin:${ADMIN_PASSWORD_B}`,
  ].join(",");
  delete process.env.OATHRION_DESTINATIONS;
  delete process.env.OATHRION_MCP_DOWNSTREAM_URL;

  /*
   * Le service aval et le serveur MCP qui le dessert, démarrés AVANT Oathrion : c'est leur
   * URL qui donne sa destination au plan de contrôle.
   */
  const { startMockDownstream } = await import("../../server/mcp-local/mock-downstream");
  const { startLocalMcpServer } = await import("../../server/mcp-local/local-mcp-server");
  const downstream = await startMockDownstream();
  const mcp = await startLocalMcpServer(downstream.url);
  process.env.OATHRION_LOCAL_MCP_URL = mcp.url;

  const { startTestServer } = await import("../../server/test/harness");
  const server = await startTestServer();
  const baseUrl = server.baseUrl;

  const call = async (
    method: "GET" | "POST" | "PUT",
    p: string,
    token: string,
    json?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      body = Array.isArray(parsed) ? { items: parsed } : (parsed as Record<string, unknown>);
    } catch {
      /* corps non-JSON : laissé vide, l'appelant verra le statut */
    }
    return { status: res.status, body };
  };

  /** Échange un mot de passe contre un jeton de session, comme la console le fait. */
  const login = async (email: string, password: string): Promise<string> => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const text = await res.text();
    let body: { token?: string } = {};
    try {
      body = JSON.parse(text) as { token?: string };
    } catch {
      /* corps non-JSON : le message ci-dessous le montrera */
    }
    if (res.status !== 200 || typeof body.token !== "string") {
      throw new Error(
        `préparation de l'état : connexion de ${email} → ${res.status} ${text.slice(0, 200).replace(/\s+/g, " ")}`,
      );
    }
    return body.token;
  };

  const must = (label: string, result: { status: number; body: Record<string, unknown> }) => {
    if (result.status >= 400) {
      throw new Error(`préparation de l'état : ${label} → ${result.status} ${JSON.stringify(result.body).slice(0, 180)}`);
    }
    return result;
  };

  /** Monte une organisation complète et rend ses credentials d'agent. */
  async function prepare(admin: string, label: string) {
    must(`${label} agent principal`, await call("POST", "/api/agents", admin, agentBody(SHARED_AGENT, `${label} agent`)));
    must(`${label} second agent`, await call("POST", "/api/agents", admin, agentBody(SECOND_AGENT, `${label} agent 2`)));
    for (const rule of rules) {
      must(`${label} règle ${rule.id}`, await call("PUT", "/api/action-policies", admin, rule));
    }
    const key1 = must(
      `${label} clé agent`,
      await call("POST", "/api/keys", admin, { name: `${label} agent key`, role: "operator", agentId: SHARED_AGENT }),
    );
    const key2 = must(
      `${label} clé second agent`,
      await call("POST", "/api/keys", admin, { name: `${label} agent2 key`, role: "operator", agentId: SECOND_AGENT }),
    );
    return {
      agent: { token: String(key1.body.secret), agentId: SHARED_AGENT },
      agent2: { token: String(key2.body.secret), agentId: SECOND_AGENT },
      admin: { token: admin, agentId: null },
      destination: DESTINATION,
    };
  }

  const adminA = await login(ADMIN_A_EMAIL, ADMIN_PASSWORD_A);
  const adminB = await login(ADMIN_B_EMAIL, ADMIN_PASSWORD_B);

  const state: PreparedState = {
    a: await prepare(adminA, "A"),
    b: await prepare(adminB, "B"),
    allowVerb: ALLOW_VERB,
    blockVerb: BLOCK_VERB,
    belowCeiling: BELOW,
    aboveCeiling: ABOVE,
    currency: "EUR",
  };

  return {
    name: "placet (référence)",
    baseUrl,
    state,
    deliveries() {
      return Promise.resolve(mcp.toolCallCount());
    },
    async close() {
      await server.close();
      await mcp.close();
      await downstream.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
