/**
 * Preuve du REGISTRE D'OUTILS DÉCLARÉ : un exploitant branche son propre outil par
 * configuration, et l'action autorisée atteint SON serveur — exactement une fois.
 *
 *   npm run build
 *   DATABASE_URL=postgres://user:pass@host:5432/postgres npm run verify:tools
 *
 * ## Pourquoi ce script existe
 *
 * `docs/limitations.md` disait : « The tool registry is five hardcoded simulated tools ».
 * La phrase était vraie et elle décrivait mal le manque. Le chemin aval RÉEL existait
 * déjà — `npm run verify:mcp` le prouve contre un serveur qui ne partage aucune ligne de
 * code avec Oathrion. Ce qui manquait, c'était la capacité de DÉCLARER le sien : un pilote
 * devait modifier du TypeScript et reconstruire pour dire « mon verbe `refund` appelle
 * `stripe.refund` chez moi ».
 *
 * `verify:mcp` prouve le TRANSPORT. Ce script-ci prouve la DÉCLARATION : rien dans
 * `OATHRION_TOOLS` n'est connu du dépôt, et le serveur d'en face est
 * `examples/mcp-server/`, qui n'importe ni `server/`, ni `shared/`, ni une constante.
 *
 * ## Ce qu'il prouve
 *
 * Un outil déclaré apparaît dans l'inventaire et s'y annonce NON simulé · il remplace
 * l'outil intégré de son verbe · l'appel arrive chez le fournisseur sous le nom de
 * l'outil DU FOURNISSEUR, pas sous le verbe d'Oathrion · les arguments reçus sont
 * EXACTEMENT la projection déclarée, pas un champ de plus · la devise transmise est
 * celle du locataire et non une littérale · un BLOCK n'atteint jamais le fournisseur ·
 * une action retenue ne l'atteint qu'après l'approbation d'un humain · et un argument
 * déclaré qui n'a aucune valeur dans l'appel arrête la dépêche au lieu d'envoyer une
 * instruction à moitié remplie.
 *
 * ## Ce qu'il ne prouve pas
 *
 * Qu'une destination hors de la portée du locataire est refusée : cela demanderait un
 * troisième démarrage avec une autre portée, et c'est déjà prouvé à l'unité contre
 * `resolveDestination`, qui est l'autorité, dans
 * `server/test/declared-tool-registry.test.ts`.
 *
 * Qu'un serveur MCP du marché QUELCONQUE fonctionne. Un seul serveur indépendant écarte
 * la mélecture partagée avec la fixture du dépôt ; il n'écarte pas un désaccord avec une
 * implémentation tierce particulière.
 *
 * Codes de sortie : 0 tout est passé · 1 un contrôle a échoué · 2 impossible à mettre en
 * place (pas de bundle, pas de PostgreSQL) — jamais un succès silencieux.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

import { Client } from "pg";

import {
  baseUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";
import { startExampleMcpServer, type ExampleMcpServer } from "../examples/mcp-server/server";

/*
 * `fileURLToPath` plutôt que `import.meta.dirname`, que ses voisins utilisent :
 * ce dernier exige Node 20.11, et le refus se présente comme un
 * `ERR_INVALID_ARG_TYPE` sur `paths[0]` qui ne nomme ni la variable ni la version.
 * La forme ci-dessous marche partout.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5253;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = "agt_declared";

/** La devise du locataire. Délibérément PAS le défaut du dépôt, qui est EUR. */
const TENANT_CURRENCY = "USD";

/* Identifiants jetables, propres à ce passage, écrits nulle part. */
const SESSION_SECRET = `tools-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const ADMIN_EMAIL = "admin@connecteur.test";
const ADMIN_PASSWORD = `admin-${Math.random().toString(36).slice(2)}-pw-0123`;
const APPROVER_EMAIL = "approbateur@connecteur.test";
const APPROVER_PASSWORD = `appro-${Math.random().toString(36).slice(2)}-pw-0123`;

/**
 * LA DÉCLARATION. Rien ici n'est connu du dépôt.
 *
 * `stripe.refund` est le nom que le FOURNISSEUR donne à son outil ; `refund` est le verbe
 * qu'Oathrion gouverne. Les deux diffèrent exprès : si Oathrion dépêchait sous son propre
 * verbe, le serveur indépendant répondrait « Outil inconnu » et le contrôle échouerait.
 *
 * Chaque argument est une PROJECTION d'un champ qu'Oathrion détient déjà. Aucun n'est
 * deviné : `customer` vient de la cible de l'action, `amount` d'une métadonnée, et
 * `currency` de l'unité de compte du locataire.
 */
const DECLARED_TOOL = {
  id: "fournisseur_remboursement",
  label: "Remboursements du fournisseur",
  destination: "local-fixture",
  tool: "stripe.refund",
  actions: ["refund"],
  /*
   * `reference` est là pour une raison précise. Le refus de projection doit pouvoir
   * être atteint par un appel que la POLITIQUE autorise, et un remboursement sans
   * montant est refusé bien avant d'atteindre un outil — Oathrion ne laisse pas une
   * action financière sans montant arriver jusque-là. Il faut donc un argument déclaré
   * dont l'absence ne change rien à la décision : c'est celui-ci.
   */
  arguments: {
    customer: "target",
    amount: "metadata.amount",
    currency: "currency",
    reference: "metadata.reference",
  },
};

type Child = ChildProcessByStdio<null, Readable, Readable>;
interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 68 - label.length))}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res { status: number; body: Record<string, unknown> }
async function call(
  pathname: string,
  init: { method?: string; token?: string; json?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { status: res.status, body: { raw: text } };
    }
  } catch (error) {
    return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

const refund = (
  target = "cus_pilote",
  metadata: Record<string, unknown> = { amount: 40, currency: TENANT_CURRENCY, reference: "inv_8841" },
) => ({ agentId: AGENT, action: "refund", target, metadata });

const agentBody = {
  id: AGENT,
  name: "Agent de remboursement",
  description: "Agent du pilote qui branche son propre outil",
  provider: "openai",
  model: "gpt-4o",
  status: "active",
  owner: "finance",
  mandate: {
    maxTransactionAmount: 10_000,
    currency: TENANT_CURRENCY,
    allowedCategories: [],
    blockedCategories: [],
    allowedDomains: [],
  },
  permissions: [
    {
      scope: "execute:payments" as const,
      label: "Rembourser un client",
      description: "Émet un remboursement sous mandat",
      granted: true,
      risk: "high" as const,
    },
  ],
  policyIds: [],
  tags: ["pilote"],
};

const policies = [
  {
    id: "pol_decl_ceiling",
    name: "Au-dessus du plafond, un humain",
    description: `Tout remboursement supérieur à 100 ${TENANT_CURRENCY} est retenu.`,
    type: "MAX_TRANSACTION_AMOUNT",
    condition: { kind: "amountAtMost", max: 100, currency: TENANT_CURRENCY },
    scope: "organization",
    appliesTo: "all agents",
    effect: "require_approval",
    status: "enabled",
    action: "APPROVAL_REQUIRED",
    risk: "high",
    priority: 10,
  },
  {
    id: "pol_decl_block",
    name: "Jamais vers la liste de sanctions",
    description: "Un remboursement vers une cible sanctionnée est refusé.",
    type: "BLOCK_TOOL",
    condition: { kind: "targetMatches", targets: ["cus_sanctionne"] },
    scope: "organization",
    appliesTo: "all agents",
    effect: "block",
    status: "enabled",
    action: "BLOCK",
    risk: "critical",
    priority: 5,
  },
];

function childEnv(db: ThrowawayDatabase, toolsUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...productionPostgresEnv(db.url),
    OATHRION_DB: undefined,
    PORT: String(PORT),
    OATHRION_SESSION_SECRET: SESSION_SECRET,
    OATHRION_API_KEYS: "",
    /*
     * Pas de préfixe `Organisation/` : les deux comptes appartiennent à l'organisation
     * par défaut, la seule que le premier démarrage écrit avec certitude. Une
     * organisation NOMMÉE est créée par le bootstrap des identifiants, dont l'écriture
     * vers le plan d'identité PostgreSQL n'est pas garantie flushée au moment où ce
     * script coupe le processus — et la devise serait alors posée sur la mauvaise ligne.
     * L'isolation multi-locataire n'est pas le sujet ici ; elle est prouvée ailleurs.
     */
    OATHRION_CONSOLE_USERS: [
      `${ADMIN_EMAIL}:admin:${ADMIN_PASSWORD}`,
      `${APPROVER_EMAIL}:approver:${APPROVER_PASSWORD}`,
    ].join(","),
    OATHRION_SEED: "",
    /*
     * La destination. Le serveur d'exemple écoute sur loopback, et la seule variable
     * qui accepte une adresse loopback est celle-ci : une entrée loopback dans
     * `OATHRION_DESTINATIONS` est refusée par les règles d'adresse de `webhook-url.ts`.
     * Le registre déclaré ne crée donc AUCUNE nouvelle surface SSRF — il réutilise la
     * porte existante et en subit les règles.
     */
    OATHRION_LOCAL_MCP_URL: toolsUrl,
    OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
    /* LA DÉCLARATION, et c'est la seule chose qui branche cet outil. */
    OATHRION_TOOLS: JSON.stringify([DECLARED_TOOL]),
  } as NodeJS.ProcessEnv;
}

async function boot(env: NodeJS.ProcessEnv): Promise<{ child: Child; ready: boolean; log: () => string }> {
  let log = "";
  const child = spawn("node", [BUNDLE], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] }) as Child;
  child.stdout.on("data", (c: Buffer) => (log += c.toString()));
  child.stderr.on("data", (c: Buffer) => (log += c.toString()));

  let ready = false;
  for (let i = 0; i < 160 && !ready; i += 1) {
    if (child.exitCode !== null) break;
    ready = (await call("/api/ready")).status === 200;
    if (!ready) await sleep(250);
  }
  return { child, ready, log: () => log };
}

async function stop(child: Child | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000).then(() => child.kill("SIGKILL"))]);
}

async function main(): Promise<number> {
  console.log("Oathrion — PREUVE DU REGISTRE D'OUTILS DÉCLARÉ (outil branché par configuration)");

  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE}. Ce script prouve le PRODUIT LIVRÉ, pas les sources :`);
    console.error("  npm run build");
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante. Le bundle de production ne tourne que sur PostgreSQL ;");
    console.error("ce script refuse de passer sans serveur joignable.");
    return 2;
  }

  let db: ThrowawayDatabase | undefined;
  let tools: ExampleMcpServer | undefined;
  let child: Child | undefined;
  let probe: Client | undefined;

  try {
    db = await createThrowawayDatabase("oathrion_declared_tools");
    console.log(`Base jetable : ${db.name} sur ${redactUrl(baseUrl())}`);

    tools = await startExampleMcpServer();
    console.log(`Outils du client : ${tools.url} (examples/mcp-server/, zéro import d'Oathrion)`);

    section("MISE EN PLACE");
    const env = childEnv(db, tools.url);

    /*
     * DEUX DÉMARRAGES, et c'est délibéré. La devise du locataire est lue une fois par
     * portée de tenant, à la construction, et il n'existe pas encore d'API pour la
     * déclarer — c'est consigné comme un manque dans `docs/limitations.md` plutôt que
     * contourné ici. Le premier démarrage crée l'organisation ; on la passe en USD ;
     * le second passage est celui que l'on mesure.
     */
    const first = await boot(env);
    child = first.child;
    record("le bundle de production démarre avec OATHRION_TOOLS déclaré", first.ready,
      first.ready ? "" : `code ${String(first.child.exitCode)}`);
    if (!first.ready) {
      console.log(first.log().slice(-3000));
      return 2;
    }
    await stop(child);
    child = undefined;

    probe = new Client({ connectionString: db.url });
    await probe.connect();
    const updated = await probe.query("UPDATE organizations SET currency = $1 WHERE id = $2", [
      TENANT_CURRENCY,
      "org_default",
    ]);
    record(`l'organisation est déclarée en ${TENANT_CURRENCY}`, updated.rowCount === 1,
      `${String(updated.rowCount)} ligne(s)`);
    if (updated.rowCount !== 1) return 1;

    const second = await boot(env);
    child = second.child;
    record("il redémarre sur la devise du locataire", second.ready,
      second.ready ? "" : `code ${String(second.child.exitCode)}`);
    if (!second.ready) {
      console.log(second.log().slice(-3000));
      return 2;
    }

    const login = await call("/api/auth/login", { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const admin = String(login.body.token ?? "");
    record("l'administrateur du locataire se connecte", admin !== "", `statut ${login.status}`);
    const approverLogin = await call("/api/auth/login", { json: { email: APPROVER_EMAIL, password: APPROVER_PASSWORD } });
    const approver = String(approverLogin.body.token ?? "");
    record("son approbateur aussi", approver !== "", `statut ${approverLogin.status}`);
    if (admin === "" || approver === "") return 1;

    const created = await call("/api/agents", { token: admin, json: agentBody });
    record("son agent est déclaré, avec la permission de rembourser", created.status < 300, `statut ${created.status}`);
    for (const policy of policies) {
      const res = await call("/api/policies", { token: admin, json: policy });
      if (res.status >= 400) record(`la règle "${policy.id}" est écrite`, false, `statut ${res.status} — ${JSON.stringify(res.body).slice(0, 160)}`);
    }
    const listed = await call("/api/policies", { token: admin });
    const policyRows = listed.body as unknown as unknown[];
    record("ses deux règles sont en vigueur", Array.isArray(policyRows) && policyRows.length === 2,
      `${String(Array.isArray(policyRows) ? policyRows.length : "non-liste")} règles`);

    const key = await call("/api/keys", { token: admin, json: { name: "Clé de l'agent", role: "operator", agentId: AGENT } });
    const agent = String(key.body.secret ?? "");
    record("une clé liée à cet agent est délivrée", agent !== "", `statut ${key.status}`);
    if (agent === "") return 1;

    /* ---------------------------------------------------------- INVENTAIRE */
    section("INVENTAIRE — ce que l'exploitant lit sur GET /api/tools");
    const inventory = await call("/api/tools", { token: admin });
    const rows = (inventory.body as unknown as Array<Record<string, unknown>>) ?? [];
    const mine = rows.find((row) => row.id === DECLARED_TOOL.id);
    record("l'outil déclaré est dans l'inventaire, sous son étiquette", mine?.name === DECLARED_TOOL.label,
      String(mine?.name ?? "absent"));
    /*
     * LE CONTRÔLE QUI DIT LA VÉRITÉ SUR LA SIMULATION. `simulated` est lu à chaque accès
     * depuis la MÊME fonction que le branchement consulte : un inventaire qui annoncerait
     * « réel » pendant que l'appel reste à l'intérieur d'Oathrion serait exactement le
     * genre d'affirmation que ce dépôt refuse de faire.
     */
    record("il s'y annonce NON simulé, parce que sa destination se résout", mine?.simulated === false,
      `simulated=${String(mine?.simulated)}`);
    /*
     * LE CONTRÔLE QUI A CORRIGÉ L'INVENTAIRE.
     *
     * Attendu d'abord `simulated === true` pour l'outil intégré, et c'était faux :
     * `RefundTool.simulated` répond « réel » dès qu'un serveur aval est configuré, ce
     * qui est exact — il DÉPÊCHERAIT, si un verbe lui était encore câblé. Deux outils
     * annonçaient donc « non simulé » et rien ne disait lequel une action atteindrait.
     * Le champ `actions`, dérivé de la table de routage, est né de ce passage.
     */
    const builtIn = rows.find((row) => row.id === "refund_tool");
    record("l'outil intégré reste dans l'inventaire", builtIn !== undefined,
      builtIn ? "refund_tool présent" : "absent");
    record("plus aucun verbe ne lui est câblé — la déclaration l'a remplacé",
      Array.isArray(builtIn?.actions) && (builtIn.actions as unknown[]).length === 0,
      JSON.stringify(builtIn?.actions));
    record("et c'est l'outil déclaré qui porte le verbe `refund` dans l'inventaire",
      JSON.stringify(mine?.actions) === JSON.stringify(["refund"]), JSON.stringify(mine?.actions));

    /* --------------------------------------------------------------- ALLOW */
    section("ALLOW — l'outil DÉCLARÉ du client est atteint, exactement une fois");
    const beforeAllow = tools.receivedCount();
    const executedBefore = tools.executedCount();
    const allowed = await call("/api/execute", { token: agent, json: refund() });
    record("la décision est ALLOW", allowed.body.decision === "ALLOW",
      `${String(allowed.body.decision ?? allowed.status)} — ${String(allowed.body.reason)} (${String(allowed.body.policyId)})`);
    record("l'effet a eu lieu", allowed.body.succeeded === true, `succeeded=${String(allowed.body.succeeded)}, runState=${String(allowed.body.runState)}`);
    /*
     * LE CONTRÔLE QUI PROUVE LE REMPLACEMENT. Sans la déclaration, ce verbe serait allé
     * dans `refund_tool`, l'outil intégré. Lire l'identifiant de l'outil qui a répondu
     * est la seule façon de distinguer « la déclaration a été appliquée » de « l'intégré
     * a fonctionné comme avant ».
     */
    record("c'est l'outil DÉCLARÉ qui a servi le verbe, pas l'intégré", allowed.body.toolId === DECLARED_TOOL.id,
      String(allowed.body.toolId));
    record("le fournisseur a reçu EXACTEMENT une requête", tools.receivedCount() === beforeAllow + 1,
      `${tools.receivedCount() - beforeAllow} requête(s)`);
    record("et l'a exécutée une fois", tools.executedCount() === executedBefore + 1,
      `${tools.executedCount() - executedBefore} exécution(s)`);

    const seen = tools.lastCall();
    /*
     * Le nom de l'outil DU FOURNISSEUR, pas le verbe d'Oathrion. Si la dépêche partait
     * sous `refund`, le serveur indépendant répondrait « Outil inconnu » : ce contrôle
     * ne peut pas passer par accident.
     */
    record('le fournisseur a été appelé sous SON nom d\'outil ("stripe.refund")', seen.name === DECLARED_TOOL.tool,
      seen.name || "absent");
    record("… et Oathrion n'a pas dépêché sous son propre verbe", seen.name !== "refund", seen.name);

    /*
     * LES ARGUMENTS, COMPARÉS À L'IDENTIQUE — pas « contient », mais « est exactement ».
     * Un `toMatch` laisserait passer un champ en trop, et un champ en trop est
     * précisément ce qu'un connecteur générique ne doit jamais ajouter : un vidage de
     * métadonnées, un identifiant de locataire, un nom d'agent. Ce qui part chez le
     * fournisseur est ce que l'exploitant a déclaré, et rien d'autre.
     */
    const expected = { customer: "cus_pilote", amount: 40, currency: TENANT_CURRENCY, reference: "inv_8841" };
    record("les arguments reçus sont EXACTEMENT la projection déclarée",
      JSON.stringify(Object.keys(seen.arguments).sort()) === JSON.stringify(Object.keys(expected).sort()) &&
        seen.arguments.customer === expected.customer &&
        seen.arguments.amount === expected.amount &&
        seen.arguments.currency === expected.currency &&
        seen.arguments.reference === expected.reference,
      JSON.stringify(seen.arguments));
    record("`customer` vient de la CIBLE de l'action, pas d'un champ deviné", seen.arguments.customer === "cus_pilote",
      String(seen.arguments.customer));
    /*
     * La devise du LOCATAIRE. Le défaut du dépôt est EUR : une littérale passerait tous
     * les autres contrôles de ce fichier et se verrait seulement ici. C'est le défaut à
     * 655× que `simulated-tools.ts` portait avant la phase devise, et la projection
     * déclarée ne doit pas le réintroduire.
     */
    record(`la devise transmise est celle du locataire (${TENANT_CURRENCY}), pas une littérale`,
      seen.arguments.currency === TENANT_CURRENCY, String(seen.arguments.currency));

    /*
     * LE REÇU DIT SI LA CORRESPONDANCE A ÉTÉ VÉRIFIÉE. Un exploitant doit pouvoir
     * distinguer « vérifié contre le schéma du serveur » de « on n'a pas pu vérifier »
     * sans relire la configuration — sinon les deux se lisent comme un succès.
     */
    const allowedResult = (allowed.body.toolResult as Record<string, unknown> | null) ?? {};
    record("le reçu porte que la correspondance a été vérifiée contre le schéma du serveur",
      allowedResult.schemaChecked === true, `schemaChecked=${String(allowedResult.schemaChecked)}`);

    const headers = tools.lastHeaders();
    /*
     * Pas une forme, une ÉGALITÉ. Ce qui compte pour le fournisseur n'est pas que la clé
     * ressemble à quelque chose : c'est qu'elle soit la MÊME que l'identifiant
     * d'exécution qu'Oathrion rend à l'appelant, sans quoi un client ne pourrait pas
     * rapprocher sa propre déduplication de la trace d'Oathrion.
     */
    record("la clé d'idempotence reçue est l'identifiant d'exécution qu'Oathrion annonce",
      headers["x-oathrion-execution-id"] === String(allowed.body.executionId ?? ""),
      `${headers["x-oathrion-execution-id"] ?? "absent"} vs ${String(allowed.body.executionId)}`);
    record("aucun secret d'Oathrion ne fuit vers l'outil déclaré",
      !JSON.stringify({ headers, args: seen.arguments }).includes(SESSION_SECRET) &&
        !JSON.stringify({ headers, args: seen.arguments }).includes(agent));

    /* --------------------------------------------------------------- BLOCK */
    section("BLOCK — un outil déclaré n'ouvre pas un second chemin");
    const beforeBlock = tools.receivedCount();
    const blocked = await call("/api/execute", { token: agent, json: refund("cus_sanctionne") });
    record("la décision est BLOCK", blocked.body.decision === "BLOCK", String(blocked.body.decision ?? blocked.status));
    record("aucun outil n'a été invoqué", blocked.body.attempted === false, `attempted=${String(blocked.body.attempted)}`);
    record("zéro requête chez le fournisseur", tools.receivedCount() === beforeBlock,
      `${tools.receivedCount() - beforeBlock} requête(s)`);

    /* ---------------------------------------------------------- APPROBATION */
    section("APPROVAL_REQUIRED — rien ne part chez le fournisseur avant l'humain");
    const beforeHold = tools.receivedCount();
    const held = await call("/api/execute", {
      token: agent,
      json: refund("cus_pilote", { amount: 500, currency: TENANT_CURRENCY, reference: "inv_9002" }),
    });
    record("l'action est retenue", held.body.decision === "APPROVAL_REQUIRED", String(held.body.decision ?? held.status));
    const approvalId = String(held.body.approvalId ?? "");
    record("une demande d'approbation existe", approvalId !== "", approvalId || "aucune");
    record("et rien n'est encore parti", tools.receivedCount() === beforeHold,
      `${tools.receivedCount() - beforeHold} requête(s)`);
    if (approvalId === "") return 1;

    const resolved = await call(`/api/approvals/${approvalId}/approve`, { token: approver, json: {} });
    record("un humain approuve, et l'action est relâchée",
      (resolved.body.approval as Record<string, unknown> | undefined)?.status === "approved" && resolved.body.executed === true,
      `statut ${resolved.status}`);
    record("le fournisseur reçoit une requête de plus, pas deux", tools.receivedCount() === beforeHold + 1,
      `${tools.receivedCount() - beforeHold} requête(s)`);
    const again = await call(`/api/approvals/${approvalId}/approve`, { token: approver, json: {} });
    record("approuver deux fois ne dépêche pas deux fois",
      again.body.executed !== true && tools.receivedCount() === beforeHold + 1,
      `${tools.receivedCount() - beforeHold} requête(s) au total`);

    /* ------------------------------------------- ARGUMENT SANS VALEUR */
    section("UN ARGUMENT DÉCLARÉ SANS VALEUR — l'instruction ne part pas à moitié");
    /*
     * `metadata.amount` est une source LÉGITIME, et pourtant absente quand l'agent
     * n'envoie pas le champ. `JSON.stringify` efface une valeur `undefined` : dépêcher
     * malgré tout ferait partir `{"customer":"cus_pilote"}` là où Oathrion croit avoir
     * transmis un montant, et un fournisseur qui complète par un défaut rembourserait
     * une somme que personne n'a autorisée. Aucun contrôle de démarrage ne peut voir
     * cette faute — seul l'appel la révèle.
     */
    const beforeBlank = tools.receivedCount();
    const runsBefore = ((await call("/api/executions", { token: admin })).body as unknown as unknown[]).length;
    const blank = await call("/api/execute", {
      token: agent,
      /* Le montant est là — c'est `reference` qui manque, et elle ne pèse sur aucune règle. */
      json: refund("cus_pilote", { amount: 40, currency: TENANT_CURRENCY }),
    });
    record("la politique autorise l'appel", blank.body.decision === "ALLOW", String(blank.body.decision ?? blank.status));
    record("l'outil est invoqué et ÉCHOUE, au lieu de dépêcher un champ vide",
      blank.body.attempted === true && blank.body.succeeded === false,
      `attempted=${String(blank.body.attempted)}, succeeded=${String(blank.body.succeeded)}`);
    const toolResult = (blank.body.toolResult as Record<string, unknown> | null) ?? {};
    record("le motif est nommé, pas deviné", toolResult.reason === "unprojectable_arguments",
      String(toolResult.reason ?? JSON.stringify(toolResult).slice(0, 120)));
    record("ZÉRO requête chez le fournisseur", tools.receivedCount() === beforeBlank,
      `${tools.receivedCount() - beforeBlank} requête(s)`);

    /* --------------------------------------------------------------- TRACE */
    section("TRACE — le refus est un événement, pas un silence");
    const runs = await call("/api/executions", { token: admin });
    const list = (runs.body as unknown as Array<Record<string, unknown>>) ?? [];
    record("l'échec de projection a laissé une ligne, comme toute tentative",
      list.length === runsBefore + 1, `${runsBefore} → ${list.length} exécution(s)`);
    record("et l'une d'elles porte l'échec, pas un succès silencieux",
      list.some((row) => row.status === "failed" || row.runState === "failed"),
      JSON.stringify(list.map((row) => row.status ?? row.runState)));
    const audit = await call("/api/audit", { token: admin });
    record("la piste d'audit est non vide", Number(audit.body.total ?? 0) > 0, `${String(audit.body.total)} événements`);

    /* ------------------------------------- SCHÉMA DU SERVEUR */
    section("LA DÉCLARATION EST CONFRONTÉE AU SCHÉMA QUE LE SERVEUR ANNONCE");
    /*
     * TROISIÈME DÉMARRAGE, avec une déclaration FAUSSE. C'est la seule façon de le
     * prouver dans le bundle livré : la déclaration est lue dans l'environnement au
     * démarrage, donc une déclaration erronée est un autre processus.
     *
     * Ce qui est mesuré : le nom d'outil comporte une faute d'une lettre, la politique
     * autorise l'action, et pourtant RIEN n'atteint le fournisseur — le refus vient de
     * la comparaison avec le `tools/list` du serveur, et il nomme la correction.
     */
    await stop(child);
    child = undefined;

    const wrong = {
      ...DECLARED_TOOL,
      /* `stripe.refunds` au lieu de `stripe.refund`. Une lettre. */
      tool: "stripe.refunds",
    };
    const third = await boot({ ...env, OATHRION_TOOLS: JSON.stringify([wrong]) } as NodeJS.ProcessEnv);
    child = third.child;
    record("le bundle démarre avec une déclaration dont le nom d'outil est faux", third.ready,
      third.ready ? "une faute de frappe n'empêche pas le DÉMARRAGE — elle arrête la DÉPÊCHE" : `code ${String(third.child.exitCode)}`);
    if (!third.ready) {
      console.log(third.log().slice(-3000));
      return 1;
    }

    const relogin = await call("/api/auth/login", { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const admin3 = String(relogin.body.token ?? "");
    const key3 = await call("/api/keys", { token: admin3, json: { name: "Clé 3", role: "operator", agentId: AGENT } });
    const agent3 = String(key3.body.secret ?? "");
    record("une clé est délivrée pour ce troisième passage", agent3 !== "", `statut ${key3.status}`);
    if (agent3 === "") return 1;

    const beforeWrong = tools.receivedCount();
    const refusedBySchema = await call("/api/execute", { token: agent3, json: refund() });
    record("la politique autorise l'appel", refusedBySchema.body.decision === "ALLOW",
      String(refusedBySchema.body.decision ?? refusedBySchema.status));
    record("l'outil ÉCHOUE au lieu de dépêcher un nom que le serveur ne connaît pas",
      refusedBySchema.body.attempted === true && refusedBySchema.body.succeeded === false,
      `attempted=${String(refusedBySchema.body.attempted)}, succeeded=${String(refusedBySchema.body.succeeded)}`);

    const schemaResult = (refusedBySchema.body.toolResult as Record<string, unknown> | null) ?? {};
    record("le motif est nommé : l'outil n'existe pas en amont",
      schemaResult.reason === "tool_not_found_upstream", String(schemaResult.reason));
    record("… et le résumé LISTE les outils qui existent, pour que la correction soit évidente",
      String(refusedBySchema.body.reason ?? "").includes("stripe.refund") ||
        String((schemaResult as { detail?: unknown }).detail ?? "").includes("stripe.refund") ||
        JSON.stringify(refusedBySchema.body).includes("stripe.refund"),
      JSON.stringify(schemaResult).slice(0, 140));
    record("ZÉRO requête chez le fournisseur", tools.receivedCount() === beforeWrong,
      `${tools.receivedCount() - beforeWrong} requête(s)`);

    section("CE QUI RESTE NON PROUVÉ ICI");
    console.log("  Qu'une destination hors de la portée du locataire est refusée : prouvé à l'unité");
    console.log("  contre `resolveDestination` dans server/test/declared-tool-registry.test.ts.");
    console.log("  Qu'un serveur MCP tiers QUELCONQUE fonctionne : un serveur indépendant écarte la");
    console.log("  mélecture partagée, pas un désaccord avec une implémentation particulière.");

    return 0;
  } finally {
    await stop(child);
    await probe?.end().catch(() => undefined);
    await tools?.close();
    await db?.dispose();
  }
}

main()
  .then((code) => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${"=".repeat(72)}`);
    console.log(`${checks.length - failed.length}/${checks.length} contrôles passés`);
    console.log("=".repeat(72));
    return code === 2 ? 2 : code === 0 && failed.length === 0 ? 0 : 1;
  })
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
