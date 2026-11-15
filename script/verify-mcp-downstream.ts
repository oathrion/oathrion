/**
 * Preuve du parcours client : Oathrion dépêche vers un serveur MCP **qui n'est pas la
 * fixture du dépôt**.
 *
 *   npm run build
 *   DATABASE_URL=postgres://user:pass@host:5432/postgres npm run verify:mcp
 *
 * ## Pourquoi ce script existe
 *
 * Tout ce que le dépôt prouvait sur le chemin aval passait par
 * `server/mcp-local/local-mcp-server.ts`, écrit par la même main que la passerelle :
 * une mélecture partagée du protocole aurait passé les deux côtés, et les deux tests
 * auraient été verts en même temps et faux ensemble. C'est l'argument que le dépôt
 * fait déjà lui-même en exposant `TestClient.baseUrl` pour qu'un client tiers puisse
 * viser la vraie passerelle ; il n'avait simplement jamais été fait dans l'autre sens.
 *
 * Ici le service aval est `examples/mcp-server/`, qui n'importe **rien** d'Oathrion — ni
 * `server/`, ni `shared/`, ni une constante. C'est la situation de votre client le jour
 * où il branche ses outils, et c'est la promesse commerciale elle-même : « Oathrion décide
 * et trace, vos outils restent les vôtres ».
 *
 * ## Ce qu'il prouve
 *
 * Un ALLOW atteint l'outil **exactement une fois** · un BLOCK ne l'atteint jamais · une
 * action retenue ne l'atteint qu'après l'approbation d'un humain · un grant rejoué ne
 * l'atteint pas une seconde fois · un refus métier du fournisseur donne un reçu
 * `failed` sans nouvel essai silencieux · les en-têtes qu'Oathrion annonce sont bien ceux
 * que le serveur indépendant observe · et la déduplication côté fournisseur, qui est le
 * travail du client et non celui d'Oathrion, fonctionne sur la clé qu'Oathrion transmet.
 *
 * ## Ce qu'il ne prouve pas
 *
 * Que n'importe quel serveur MCP du marché fonctionne. Un seul serveur indépendant
 * écrit depuis la spécification écarte la mélecture partagée ; il n'écarte pas un
 * désaccord avec une implémentation tierce particulière. Le premier pilote reste le
 * premier pilote.
 *
 * Codes de sortie : 0 tout est passé · 1 un contrôle a échoué · 2 impossible à mettre
 * en place (pas de bundle, pas de PostgreSQL) — jamais un succès silencieux.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

import {
  baseUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";
import { startExampleMcpServer, type ExampleMcpServer } from "../examples/mcp-server/server";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5251;
const BASE = `http://127.0.0.1:${PORT}`;
const DEST = "local-fixture";
const AGENT = "agt_client";

/* Identifiants jetables, propres à ce passage, écrits nulle part. */
const SESSION_SECRET = `mcp-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const EMAIL = "admin@pilote.test";
const PASSWORD = `pilote-${Math.random().toString(36).slice(2)}-pw-0123`;

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

/*
 * Pas de champ `agentId` : `assertNoAuthoritativeFields` le tolère, mais la liaison du
 * credential gagne de toute façon. L'agent qui agit est celui auquel la clé est liée,
 * et le dire dans le corps ne serait qu'une redondance qu'un lecteur prendrait pour un
 * choix.
 */
const refund = (amount: number) => ({
  action: "stripe.refund",
  destinationId: DEST,
  arguments: { customer: "cus_pilote", amount, currency: "EUR" },
});

const rules = [
  { id: "apol_cl_small", name: "Remboursement courant", action: "stripe.refund", destinationId: DEST, effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
  { id: "apol_cl_big", name: "Au-dessus du plafond, un humain", action: "stripe.refund", destinationId: DEST, effect: "APPROVAL_REQUIRED", constraints: [{ field: "amount", op: "gt", value: 100 }], priority: 200 },
  { id: "apol_cl_block", name: "La suppression client n'est jamais autorisée", action: "customer.delete", effect: "BLOCK", priority: 300 },
];

const agentBody = {
  id: AGENT,
  name: "Agent de paiement du pilote",
  description: "Agent du parcours client",
  provider: "openai",
  model: "gpt-4o",
  status: "active",
  owner: "finance",
  mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
  permissions: [],
  policyIds: [],
  tags: ["pilote"],
};

async function main(): Promise<number> {
  console.log("Oathrion — PREUVE DU PARCOURS CLIENT (serveur MCP indépendant du dépôt)");

  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE}. Ce script prouve le PRODUIT LIVRÉ, pas les sources :`);
    console.error("  npm run build");
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante. Depuis la phase 12.2 le bundle de production ne tourne");
    console.error("que sur PostgreSQL ; ce script refuse de passer sans serveur joignable.");
    return 2;
  }

  let db: ThrowawayDatabase | undefined;
  let tools: ExampleMcpServer | undefined;
  let child: Child | undefined;
  let log = "";

  try {
    db = await createThrowawayDatabase("oathrion_mcp_client");
    console.log(`Base jetable : ${db.name} sur ${redactUrl(baseUrl())}`);

    tools = await startExampleMcpServer();
    console.log(`Outils du client : ${tools.url} (examples/mcp-server/, zéro import d'Oathrion)`);

    child = spawn("node", [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...productionPostgresEnv(db.url),
        OATHRION_DB: undefined,
        PORT: String(PORT),
        OATHRION_SESSION_SECRET: SESSION_SECRET,
        OATHRION_API_KEYS: "",
        OATHRION_CONSOLE_USERS: `Pilote/${EMAIL}:admin:${PASSWORD}`,
        OATHRION_SEED: "",
        OATHRION_LOCAL_MCP_URL: tools.url,
        /*
         * `*` est un PARTAGE EXPLICITE, et c'est le seul locataire de ce passage. En
         * production la variable est obligatoire : sans elle, la fixture serait
         * enregistrée pour tous les locataires sans que personne ne l'ait déclaré.
         */
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    child.stdout.on("data", (c: Buffer) => (log += c.toString()));
    child.stderr.on("data", (c: Buffer) => (log += c.toString()));

    section("MISE EN PLACE");
    let ready = false;
    for (let i = 0; i < 160 && !ready; i += 1) {
      if (child.exitCode !== null) break;
      ready = (await call("/api/ready")).status === 200;
      if (!ready) await sleep(250);
    }
    record("le bundle de production démarre", ready, ready ? "" : `code ${String(child.exitCode)}`);
    if (!ready) {
      console.log(log.slice(-2500));
      return 2;
    }

    const login = await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } });
    const admin = String(login.body.token ?? "");
    record("l'administrateur du locataire se connecte", admin !== "", `statut ${login.status}`);

    const created = await call("/api/agents", { token: admin, json: agentBody });
    record("son agent est déclaré", created.status < 300, `statut ${created.status}`);
    for (const rule of rules) {
      await call("/api/action-policies", { token: admin, method: "PUT", json: rule });
    }
    const listed = await call("/api/action-policies", { token: admin });
    record("ses trois règles sont en vigueur", Array.isArray(listed.body.policies) && (listed.body.policies as unknown[]).length === 3,
      `${String((listed.body.policies as unknown[] | undefined)?.length)} règles`);

    const key = await call("/api/keys", { token: admin, json: { name: "Clé de l'agent", role: "operator", agentId: AGENT } });
    const agent = String(key.body.secret ?? "");
    record("une clé liée à cet agent est délivrée", agent !== "", `statut ${key.status}`);
    if (agent === "") return 1;

    /* ------------------------------------------------------------- ALLOW */
    section("ALLOW — l'outil du client est atteint, exactement une fois");
    const start = tools.executedCount();
    const startReceived = tools.receivedCount();
    const allowed = await call("/api/actions/authorize", { token: agent, json: refund(40) });
    record("la décision est ALLOW", allowed.body.decision === "ALLOW", String(allowed.body.decision ?? allowed.status));
    record("autoriser n'exécute rien", tools.executedCount() === start, `${tools.executedCount() - start} appel`);

    const grant = String(allowed.body.grantId ?? "");
    const run = await call("/api/actions/execute", { token: agent, json: { ...refund(40), grantId: grant } });
    record("l'exécution réussit", run.status === 200 && run.body.outcome === "succeeded", String(run.body.outcome ?? run.status));
    record("l'outil du client a été appelé EXACTEMENT une fois", tools.executedCount() === start + 1, `${tools.executedCount() - start} appel`);
    /*
     * DEUX compteurs, et la distinction n'est pas une précaution de style. L'exemple est
     * idempotent : si Oathrion dépêchait la même action DEUX fois, la seconde requête serait
     * dédupliquée et `executedCount()` resterait à 1. Le compteur d'effets ne peut donc
     * pas prouver l'« exactement une fois » tout seul — il faut compter les REQUÊTES.
     * Constaté en mutant la passerelle pour qu'elle dépêche deux fois : la vérification
     * restait verte avec le seul compteur d'effets.
     */
    record("et Oathrion n'a émis qu'UNE requête — pas deux que la dédup masquerait",
      tools.receivedCount() === startReceived + 1, `${tools.receivedCount() - startReceived} requête`);

    const headers = tools.lastHeaders();
    record("Oathrion annonce la révision du protocole", headers["mcp-protocol-version"] === "2026-07-28", headers["mcp-protocol-version"] ?? "absent");
    record("… la méthode et le nom de l'outil", headers["mcp-method"] === "tools/call" && headers["mcp-name"] === "stripe.refund",
      `${headers["mcp-method"] ?? "?"} / ${headers["mcp-name"] ?? "?"}`);
    record("… et une clé d'idempotence exploitable", /^axn_[0-9a-f]{32}$/.test(headers["x-oathrion-execution-id"] ?? ""), headers["x-oathrion-execution-id"] ?? "absent");
    record("aucun secret d'Oathrion ne fuit vers l'outil", !JSON.stringify(headers).includes(SESSION_SECRET) && !JSON.stringify(headers).includes(agent));

    /* ------------------------------------------------------------- REJEU */
    section("REJEU — l'effet n'a pas lieu deux fois");
    const replay = await call("/api/actions/execute", { token: agent, json: { ...refund(40), grantId: grant } });
    /*
     * Le CODE est vérifié, pas seulement le statut 403, et ce n'est pas du zèle. La
     * garde qui DÉCIDE est le prédicat `state = 'issued'` du `UPDATE` de consommation —
     * la comparaison applicative qui le précède ne sert qu'à nommer le défaut. En
     * mutant cette comparaison (`pending_approval` neutralisé), la porte restait bien
     * fermée mais le motif devenait « grant consommé par une requête concurrente » : un
     * exploitant lisant cet incident chercherait une course qui n'existe pas. Un
     * harnais qui ne regarde que le statut déclare 37/37 sur ce mutant — constaté.
     */
    record("Oathrion refuse un grant déjà consommé, et le dit", replay.status === 403 && replay.body.code === "grant_already_consumed",
      `statut ${replay.status}, code ${String(replay.body.code)}`);
    record("l'outil du client n'a toujours été appelé qu'une fois", tools.executedCount() === start + 1, `${tools.executedCount() - start} appel`);
    record("et aucune requête supplémentaire n'est partie", tools.receivedCount() === startReceived + 1, `${tools.receivedCount() - startReceived} requête`);

    /* ------------------------------------------------------------- BLOCK */
    section("BLOCK — l'outil n'est jamais atteint");
    const beforeBlock = tools.executedCount();
    const receivedBeforeBlock = tools.receivedCount();
    const blocked = await call("/api/actions/authorize", {
      token: agent,
      json: { action: "customer.delete", destinationId: DEST, arguments: { customer: "cus_pilote" } },
    });
    record("la décision est BLOCK", blocked.body.decision === "BLOCK", String(blocked.body.decision ?? blocked.status));
    record("aucun grant n'est délivré", blocked.body.grantId === null, String(blocked.body.grantId));
    record("zéro appel en aval — et zéro requête", tools.executedCount() === beforeBlock && tools.receivedCount() === receivedBeforeBlock);

    /* -------------------------------------------------------- APPROBATION */
    section("APPROVAL_REQUIRED — rien ne part avant l'humain");
    const held = await call("/api/actions/authorize", { token: agent, json: refund(500) });
    const heldId = String(held.body.grantId ?? "");
    const heldHash = String(held.body.actionHash ?? "");
    record("l'action est retenue", held.body.decision === "APPROVAL_REQUIRED", String(held.body.decision ?? held.status));
    const beforeApproval = tools.executedCount();
    const receivedBeforeApproval = tools.receivedCount();
    const early = await call("/api/actions/execute", { token: agent, json: { ...refund(500), grantId: heldId } });
    record("exécuter avant l'approbation est refusé, pour le bon motif", early.status === 403 && early.body.code === "grant_not_issued",
      `statut ${early.status}, code ${String(early.body.code)}`);
    record("et n'atteint pas l'outil", tools.executedCount() === beforeApproval && tools.receivedCount() === receivedBeforeApproval, `${tools.receivedCount() - receivedBeforeApproval} requête`);

    const approve = await call(`/api/actions/grants/${heldId}/approve`, { token: admin, json: { actionHash: heldHash } });
    record("un humain l'approuve, en nommant ce qu'il a vu", approve.status === 200, `statut ${approve.status}`);
    const after = await call("/api/actions/execute", { token: agent, json: { ...refund(500), grantId: heldId } });
    record("l'exécution passe alors", after.status === 200 && after.body.outcome === "succeeded", String(after.body.outcome ?? after.status));
    record("l'outil est atteint une fois de plus, pas deux", tools.executedCount() === beforeApproval + 1, `${tools.executedCount() - beforeApproval} appel`);
    record("une requête, une seule, pour cette exécution", tools.receivedCount() === receivedBeforeApproval + 1, `${tools.receivedCount() - receivedBeforeApproval} requête`);

    /* --------------------------------------------------- REFUS DU FOURNISSEUR */
    section("REFUS MÉTIER DU FOURNISSEUR — un reçu honnête, aucun nouvel essai");
    /*
     * Un montant nul passe la POLITIQUE (`amount lte 100`) et est refusé par le
     * FOURNISSEUR. C'est précisément le cas qui sépare « Oathrion a autorisé » de
     * « l'effet a eu lieu », et le seul endroit où l'on voit si Oathrion sait le dire.
     */
    const zero = await call("/api/actions/authorize", { token: agent, json: refund(0) });
    record("la politique autorise un montant nul", zero.body.decision === "ALLOW", String(zero.body.decision ?? zero.status));
    const zeroGrant = String(zero.body.grantId ?? "");
    const beforeFail = tools.executedCount();
    const receivedBeforeFail = tools.receivedCount();
    const failed = await call("/api/actions/execute", { token: agent, json: { ...refund(0), grantId: zeroGrant } });
    record("Oathrion rend un reçu `failed`, pas une panne", failed.status === 200 && failed.body.outcome === "failed", `${String(failed.body.outcome)} (statut ${failed.status})`);
    record("le fournisseur n'a rien exécuté", tools.executedCount() === beforeFail, `${tools.executedCount() - beforeFail} exécution`);
    record("il a reçu l'appel UNE fois — Oathrion ne réessaie pas en douce", tools.receivedCount() === receivedBeforeFail + 1, `${tools.receivedCount() - receivedBeforeFail} requête`);
    const retry = await call("/api/actions/execute", { token: agent, json: { ...refund(0), grantId: zeroGrant } });
    record("le grant reste consommé malgré l'échec — pas de nouvel essai gratuit", retry.status === 403 && retry.body.code === "grant_already_consumed",
      `statut ${retry.status}, code ${String(retry.body.code)}`);

    /* ------------------------------------------- IDEMPOTENCE DU FOURNISSEUR */
    section("IDEMPOTENCE CÔTÉ FOURNISSEUR — le travail du client, sur la clé d'Oathrion");
    /*
     * Ce contrôle porte sur l'EXEMPLE, pas sur Oathrion, et c'est dit.
     * `docs/COMMERCIAL_READINESS.md` marque « Déduplication côté fournisseur : NON FAIT
     * dans Oathrion » : Oathrion garantit qu'un grant n'est consommé qu'une fois, jamais qu'un
     * effet chez un tiers n'a lieu qu'une fois — si la réponse se perd, Oathrion voit un
     * échec là où le fournisseur a déjà débité. Ce que l'on vérifie ici, c'est que la
     * clé qu'Oathrion transmet SUFFIT au client pour fermer ce trou lui-même.
     */
    const reused = headers["x-oathrion-execution-id"] ?? "";
    const beforeDedup = tools.executedCount();
    const direct = await fetch(tools.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "X-Oathrion-Execution-Id": reused,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: `placet-${reused}`, method: "tools/call",
        params: { name: "stripe.refund", arguments: { customer: "cus_pilote", amount: 40, currency: "EUR" } },
      }),
    });
    const frame = (await direct.json()) as { result?: { structuredContent?: { deduplicated?: boolean } } };
    record("le rejeu de la même clé est reconnu", frame.result?.structuredContent?.deduplicated === true, JSON.stringify(frame.result?.structuredContent ?? {}));
    record("et ne refait pas l'effet", tools.executedCount() === beforeDedup, `${tools.executedCount() - beforeDedup} exécution`);

    /* -------------------------------------------------------------- TRACE */
    section("TRACE — le client vérifie la sienne, sans nous croire");
    const receipts = await call("/api/actions/receipts", { token: admin });
    const rows = (receipts.body.receipts as Array<Record<string, unknown>> | undefined) ?? [];
    record("un reçu par exécution, ni plus ni moins", rows.length === 3, `${rows.length} reçus`);
    record("deux réussis, un échoué", rows.filter((r) => r.outcome === "succeeded").length === 2 && rows.filter((r) => r.outcome === "failed").length === 1);
    const chain = await call("/api/actions/receipts/verify", { token: admin });
    record("la chaîne de reçus se vérifie", chain.body.ok === true, `${String(chain.body.entries)} entrées, rupture ${String(chain.body.brokenAt)}`);

    section("CE QUI RESTE NON PROUVÉ");
    console.log("  Qu'un serveur MCP tiers QUELCONQUE fonctionne. Un serveur indépendant écrit");
    console.log("  depuis la spécification écarte la mélecture partagée avec la fixture du dépôt ;");
    console.log("  il n'écarte pas un désaccord avec une implémentation particulière du marché.");

    return 0;
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child!.on("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000).then(() => child!.kill("SIGKILL"))]);
    }
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
