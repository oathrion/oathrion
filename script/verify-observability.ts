/**
 * Preuve de la supervision : chaque signal se lève **pour de vrai**.
 *
 *   npm run build
 *   DATABASE_URL=postgres://… npm run verify:obs
 *
 * ## Pourquoi ce banc existe
 *
 * `docs/OPERATIONS.md` portait, à la ligne « Métriques Prometheus / alerting », la
 * mention **NON IMPLÉMENTÉ**. Le remplacer par du code n'est que la moitié du travail :
 * une supervision non éprouvée est pire que pas de supervision, parce qu'elle est
 * CRUE. Un compteur qu'on a oublié de câbler reste à zéro, et zéro se lit « rien ne
 * s'est passé » et non « personne ne compte ». C'est exactement la panne qui fait
 * dormir une équipe pendant un incident.
 *
 * Ce banc ne vérifie donc pas que la page répond. Il provoque chaque condition —
 * jeton absent, jeton faux, base arrêtée, limiteur saturé, magasin injoignable, chaîne
 * rompue, refus de grant — et exige que le chiffre BOUGE dans le bon sens.
 *
 * ## Codes de sortie
 *
 *   0 tout est passé · 1 un contrôle a échoué · 2 impossible à mettre en place
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

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
const PORT = 5261;
const BASE = `http://127.0.0.1:${PORT}`;

const SESSION_SECRET = `obs-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
/*
 * 48 caractères. Le premier jet en produisait 30 et le bundle a REFUSÉ de démarrer —
 * la règle des 32 caractères attrapant d'abord son auteur, ce qui est la meilleure
 * preuve qu'elle n'est pas décorative.
 */
const SCRAPE = `scrape-${randomBytes(20).toString("hex")}`;
const DEST = "local-fixture";
const EMAIL = "admin@obs.test";
const PASSWORD = `obs-${Math.random().toString(36).slice(2)}-pw-0123`;

type Child = ChildProcessByStdio<null, Readable, Readable>;
interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 66 - label.length))}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res { status: number; body: Record<string, unknown>; text: string }

/**
 * Le corps, débarrassé de `requestId`.
 *
 * Comparer deux réponses octet par octet échouait là où elles sont pourtant
 * identiques : le corps d'erreur du dépôt porte un identifiant de corrélation propre à
 * chaque requête. Le banc l'a signalé en affichant « 401 contre 401 » sur un contrôle
 * rouge, ce qui est précisément le genre d'écart qu'il faut lire au lieu de l'assouplir
 * — l'identifiant doit différer, et tout le reste doit coïncider.
 */
function shape(res: Res): string {
  const { requestId: _ignored, ...rest } = res.body;
  return JSON.stringify(rest);
}
async function call(p: string, init: { method?: string; token?: string; json?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${BASE}${p}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* texte */ }
    return { status: res.status, body, text };
  } catch (error) {
    return { status: 0, body: {}, text: error instanceof Error ? error.message : String(error) };
  }
}

/** Lit une série depuis la page, par son nom rendu exactement. */
function series(page: string, line: string): number | null {
  for (const row of page.split("\n")) {
    if (row.startsWith(`${line} `)) return Number(row.slice(line.length + 1));
  }
  return null;
}
async function scrape(token = SCRAPE): Promise<string> {
  return (await call("/api/metrics", { token })).text;
}

function boot(
  databaseUrl: string,
  mcpUrl: string,
  extra: Record<string, string | undefined> = {},
): { child: Child; log: () => string } {
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(databaseUrl),
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: "",
      OATHRION_CONSOLE_USERS: `Obs/${EMAIL}:admin:${PASSWORD}`,
      OATHRION_SEED: "",
      OATHRION_METRICS_TOKEN: SCRAPE,
      /*
       * Un vrai service aval, et non une absence : sans destination enregistrée, aucune
       * exécution n'aboutit, donc aucun reçu n'existe — et le banc ne pourrait vérifier
       * ni les compteurs d'exécution ni l'audit d'une chaîne rompue. On réutilise le
       * serveur indépendant de l'étape 6 plutôt que la fixture du dépôt.
       */
      OATHRION_LOCAL_MCP_URL: mcpUrl,
      OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as Child;
  let log = "";
  child.stdout.on("data", (c: Buffer) => (log += c.toString()));
  child.stderr.on("data", (c: Buffer) => (log += c.toString()));
  return { child, log: () => log };
}

async function waitReady(child: Child, tries = 160): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (child.exitCode !== null) return false;
    if ((await call("/api/ready")).status === 200) return true;
    await sleep(250);
  }
  return false;
}
async function stop(child: Child | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000).then(() => child.kill("SIGKILL"))]);
}

async function main(): Promise<number> {
  console.log("Oathrion — PREUVE DE LA SUPERVISION (chaque signal, provoqué pour de vrai)");
  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE}. Ce banc éprouve le produit LIVRÉ :\n  npm run build`);
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante. Le bundle de production n'accepte que PostgreSQL.");
    return 2;
  }

  let db: ThrowawayDatabase | undefined;
  let tools: ExampleMcpServer | undefined;
  let child: Child | undefined;

  try {
    db = await createThrowawayDatabase("oathrion_obs");
    console.log(`Base jetable : ${db.name} sur ${redactUrl(baseUrl())}`);
    tools = await startExampleMcpServer();
    console.log(`Outils aval : ${tools.url} (examples/mcp-server/)`);

    /* ------------------------------------------------- LE PORTAIL */
    section("LE PORTAIL — une page de comptes n'est pas une sonde");

    const noToken = boot(db.url, tools.url, { OATHRION_METRICS_TOKEN: undefined });
    child = noToken.child;
    record("sans OATHRION_METRICS_TOKEN, le bundle démarre quand même", await waitReady(child),
      "ne pas superviser est une décision, pas une erreur");
    /*
     * INDISTINGUABILITÉ, et non un statut précis. J'avais écrit « 404 » ; la réalité est
     * 401, parce que le portail général d'API ferme tout chemin non public — y compris
     * ceux qui n'existent pas. La propriété qui compte n'est pas le chiffre, c'est que
     * la page absente réponde EXACTEMENT comme un chemin qui n'a jamais existé : sinon
     * son statut annoncerait à qui sonde qu'une page de supervision se trouve là.
     * Éprouvée sans credential ET avec, parce que les deux chemins diffèrent.
     */
    const absent = await call("/api/metrics");
    const ghost = await call("/api/ceci-nexiste-pas");
    record("… et la page absente est indistinguable d'une URL inexistante (sans credential)",
      absent.status === ghost.status && shape(absent) === shape(ghost), `${absent.status} contre ${ghost.status}`);
    const asAdmin = String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
    const absentAuth = await call("/api/metrics", { token: asAdmin });
    const ghostAuth = await call("/api/ceci-nexiste-pas", { token: asAdmin });
    record("… y compris pour un administrateur authentifié",
      absentAuth.status === ghostAuth.status && shape(absentAuth) === shape(ghostAuth),
      `${absentAuth.status} contre ${ghostAuth.status}`);
    record("la bannière le dit au démarrage", /metrics: page NOT MOUNTED/.test(noToken.log()),
      "sinon l'exploitant cherche un problème de proxy");
    await stop(child);

    const weak = boot(db.url, tools.url, { OATHRION_METRICS_TOKEN: "court" });
    child = weak.child;
    const booted = await waitReady(child, 24);
    record("un jeton trop court REFUSE le démarrage", !booted, booted ? "il a démarré" : `code ${String(child.exitCode)}`);
    record("… en nommant la variable responsable", /OATHRION_METRICS_TOKEN/.test(weak.log()));
    record("… et en expliquant pourquoi court ≠ faible", /protection in appearance only/.test(weak.log()));
    await stop(child);

    const example = boot(db.url, tools.url, { OATHRION_METRICS_TOKEN: "changeme-but-long-enough-to-pass-length" });
    child = example.child;
    const bootedExample = await waitReady(child, 24);
    record("une valeur d'exemple est refusée malgré sa longueur", !bootedExample,
      bootedExample ? "elle a démarré" : "refus");
    await stop(child);

    /* --------------------------------------------------- LA PAGE */
    section("LA PAGE — montée, fermée, et complète");
    const run = boot(db.url, tools.url);
    child = run.child;
    if (!await waitReady(child)) {
      console.log(run.log().slice(-2500));
      return 2;
    }
    record("avec un jeton conforme, l'instance démarre", true);
    record("un scrape sans jeton est refusé", (await call("/api/metrics")).status === 401);
    record("un scrape plus long que le jeton est refusé", (await call("/api/metrics", { token: `${SCRAPE}x` })).status === 401);
    /*
     * UN JETON FAUX DE LA MÊME LONGUEUR EXACTE, et c'est le seul des quatre qui éprouve
     * réellement la comparaison.
     *
     * Les trois autres diffèrent par la longueur, donc ils sortent au garde de longueur
     * de `scrapeTokenMatches` sans jamais atteindre `timingSafeEqual`. Un mutant qui
     * remplaçait cette comparaison par `return true` — c'est-à-dire un portail qui
     * accepte n'importe quel jeton de la bonne taille — passait 49/49. Constaté.
     */
    const sameLength = `scrape-${"0".repeat(SCRAPE.length - 7)}`;
    const wrong = await call("/api/metrics", { token: sameLength });
    record("un faux jeton de la MÊME longueur est refusé", wrong.status === 401,
      `${sameLength.length} caractères contre ${SCRAPE.length}`);
    record("… et le refus ne décrit pas la règle du jeton", wrong.status === 401 && wrong.text === "",
      `corps de ${wrong.text.length} octets`);

    const page = await scrape();
    record("avec le bon jeton, la page est servie", page.includes("oathrion_up 1"));
    record("elle émet TOUTES les séries, y compris à zéro",
      (page.match(/^placet_[a-z_]+\{/gm) ?? []).length >= 70,
      `${(page.match(/^placet_[a-z_]+\{/gm) ?? []).length} séries étiquetées`);
    record("aucun identifiant d'organisation n'y figure", !/org_[a-z0-9]{20}/.test(page),
      "la cardinalité ET la liste des clients");
    record("aucun secret n'y figure", !page.includes(SCRAPE) && !page.includes(SESSION_SECRET) && !page.includes(PASSWORD));
    record("les violations d'étiquette sont à zéro", series(page, 'oathrion_metric_label_violations_total{metric="other"}') === 0,
      String(series(page, 'oathrion_metric_label_violations_total{metric="other"}')));

    /* ------------------------------------------- LES QUATRE SIGNAUX */
    section("SIGNAL 1/4 — la base, et le contrat avec l'équilibreur");
    record("oathrion_ready vaut 1 quand tout va bien", series(page, "oathrion_ready") === 1);
    record("oathrion_database_reachable vaut 1", series(page, "oathrion_database_reachable") === 1);
    record("oathrion_draining vaut 0 hors déploiement", series(page, "oathrion_draining") === 0);
    record("oathrion_rate_limit_fail_closed vaut 1 par défaut", series(page, "oathrion_rate_limit_fail_closed") === 1,
      "0 = un incident d'infra retire la protection anti-force-brute");
    record("oathrion_uptime_seconds est cohérent", (series(page, "oathrion_uptime_seconds") ?? -1) >= 0);

    section("SIGNAL 2/4 — les refus de credential, distingués");
    const beforeMissing = series(page, 'oathrion_auth_failures_total{reason="missing_credential"}') ?? 0;
    const beforeInvalid = series(page, 'oathrion_auth_failures_total{reason="invalid_credential"}') ?? 0;
    await call("/api/agents");
    await call("/api/agents", { token: "ariak_inexistante_0000000000" });
    const afterAuth = await scrape();
    record("un appel sans credential compte comme `missing_credential`",
      (series(afterAuth, 'oathrion_auth_failures_total{reason="missing_credential"}') ?? 0) === beforeMissing + 1);
    record("un credential inconnu compte comme `invalid_credential`",
      (series(afterAuth, 'oathrion_auth_failures_total{reason="invalid_credential"}') ?? 0) === beforeInvalid + 1);
    const beforeLogin = series(afterAuth, 'oathrion_auth_failures_total{reason="login_invalid_credentials"}') ?? 0;
    await call("/api/auth/login", { json: { email: EMAIL, password: "mauvais-mot-de-passe" } });
    record("un mot de passe faux compte séparément",
      (series(await scrape(), 'oathrion_auth_failures_total{reason="login_invalid_credentials"}') ?? 0) === beforeLogin + 1,
      "login_invalid_credentials, pas invalid_credential");
    /*
     * Le CONTRÔLE POSITIF de l'honnêteté du registre : les motifs qu'Oathrion ne sait PAS
     * distinguer ne doivent pas exister en série. Une série `revoked` éternellement à
     * zéro ferait lire « aucune clé révoquée présentée » là où la vérité est « on ne
     * mesure pas ça » — et c'est exactement l'erreur que le premier jet contenait.
     */
    record("aucune série ne prétend distinguer ce que resolveBearer ne distingue pas",
      !/oathrion_auth_failures_total\{reason="(revoked|expired|unknown_key)"\}/.test(afterAuth));

    /* ------- le parcours d'action, pour alimenter décisions et refus ------- */
    section("SIGNAL 3/4 — les décisions et les refus d'exécution");
    const login = await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } });
    const admin = String(login.body.token ?? "");
    await call("/api/agents", {
      token: admin,
      json: {
        id: "agt_obs", name: "Agent obs", description: "banc", provider: "openai", model: "gpt-4o",
        status: "active", owner: "ops",
        mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
        permissions: [], policyIds: [], tags: [],
      },
    });
    for (const rule of [
      { id: "apol_obs_allow", name: "courant", action: "stripe.refund", destinationId: DEST, effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
      { id: "apol_obs_block", name: "jamais", action: "customer.delete", effect: "BLOCK", priority: 300 },
    ]) await call("/api/action-policies", { token: admin, method: "PUT", json: rule });
    const key = await call("/api/keys", { token: admin, json: { name: "obs", role: "operator", agentId: "agt_obs" } });
    const agent = String(key.body.secret ?? "");

    const beforeActions = await scrape();
    const allowBefore = series(beforeActions, 'oathrion_action_decisions_total{decision="allow"}') ?? 0;
    const blockBefore = series(beforeActions, 'oathrion_action_decisions_total{decision="block"}') ?? 0;
    const refusedBefore = series(beforeActions, 'oathrion_action_executions_total{outcome="refused"}') ?? 0;
    const notFoundBefore = series(beforeActions, 'oathrion_action_refusals_total{code="grant_not_found"}') ?? 0;

    const allowed = await call("/api/actions/authorize", {
      token: agent, json: { action: "stripe.refund", destinationId: DEST, arguments: { customer: "c", amount: 10, currency: "EUR" } },
    });
    await call("/api/actions/authorize", {
      token: agent, json: { action: "customer.delete", destinationId: DEST, arguments: { customer: "c" } },
    });
    await call("/api/actions/execute", {
      token: agent, json: { action: "stripe.refund", destinationId: DEST, arguments: { customer: "c", amount: 10, currency: "EUR" }, grantId: "grant_inexistant_0" },
    });

    const afterActions = await scrape();
    record("une décision ALLOW est comptée",
      (series(afterActions, 'oathrion_action_decisions_total{decision="allow"}') ?? 0) === allowBefore + 1,
      String(allowed.body.decision));
    record("une décision BLOCK est comptée séparément",
      (series(afterActions, 'oathrion_action_decisions_total{decision="block"}') ?? 0) === blockBefore + 1);
    record("un refus d'exécution est compté",
      (series(afterActions, 'oathrion_action_executions_total{outcome="refused"}') ?? 0) === refusedBefore + 1);
    record("… AVEC son code, qui est ce qu'on lit à 3 h du matin",
      (series(afterActions, 'oathrion_action_refusals_total{code="grant_not_found"}') ?? 0) === notFoundBefore + 1,
      "grant_not_found");

    /* ----- l'exécution réelle : c'est elle qui crée un reçu, donc une chaîne ----- */
    const downOkBefore = series(afterActions, 'oathrion_downstream_calls_total{outcome="ok"}') ?? 0;
    const downErrBefore = series(afterActions, 'oathrion_downstream_calls_total{outcome="business_error"}') ?? 0;
    const succeededBefore = series(afterActions, 'oathrion_action_executions_total{outcome="succeeded"}') ?? 0;
    const failedBefore = series(afterActions, 'oathrion_action_executions_total{outcome="failed"}') ?? 0;

    const intent = (amount: number) => ({
      action: "stripe.refund", destinationId: DEST,
      arguments: { customer: "c", amount, currency: "EUR" },
    });
    const good = await call("/api/actions/authorize", { token: agent, json: intent(25) });
    await call("/api/actions/execute", { token: agent, json: { ...intent(25), grantId: String(good.body.grantId ?? "") } });
    /*
     * Montant nul : la politique l'autorise (`lte 100`), le FOURNISSEUR le refuse. C'est
     * le seul cas qui sépare `business_error` de `transport_error`, et la distinction est
     * ce sur quoi `docs/ON-CALL.md` fait reposer « votre client refuse » contre « le
     * réseau est coupé ».
     */
    const zero = await call("/api/actions/authorize", { token: agent, json: intent(0) });
    await call("/api/actions/execute", { token: agent, json: { ...intent(0), grantId: String(zero.body.grantId ?? "") } });

    const afterExec = await scrape();
    record("une exécution réussie est comptée",
      (series(afterExec, 'oathrion_action_executions_total{outcome="succeeded"}') ?? 0) === succeededBefore + 1);
    record("un appel aval réussi est compté",
      (series(afterExec, 'oathrion_downstream_calls_total{outcome="ok"}') ?? 0) === downOkBefore + 1);
    record("un refus MÉTIER du fournisseur est compté `business_error`",
      (series(afterExec, 'oathrion_downstream_calls_total{outcome="business_error"}') ?? 0) === downErrBefore + 1,
      "distinct d'une panne réseau");
    record("… et l'exécution correspondante est comptée `failed`",
      (series(afterExec, 'oathrion_action_executions_total{outcome="failed"}') ?? 0) === failedBefore + 1);
    record("aucune erreur de transport n'est inventée",
      (series(afterExec, 'oathrion_downstream_calls_total{outcome="transport_error"}') ?? 0) === 0,
      "le fournisseur a répondu : ce n'est pas une panne");

    const chainBefore = series(afterExec, 'oathrion_receipt_chain_verifications_total{result="ok"}') ?? 0;
    const verdict = await call("/api/actions/receipts/verify", { token: admin });
    record("la chaîne du locataire se vérifie", verdict.body.ok === true, `${String(verdict.body.entries)} reçus`);
    record("une vérification de chaîne est comptée",
      (series(await scrape(), 'oathrion_receipt_chain_verifications_total{result="ok"}') ?? 0) === chainBefore + 1);

    section("SIGNAL 4/4 — le limiteur, saturé pour de vrai");
    const rlBefore = series(await scrape(), 'oathrion_rate_limit_outcomes_total{scope="write",outcome="rejected"}') ?? 0;
    let got429 = false;
    for (let i = 0; i < 45 && !got429; i += 1) {
      const r = await call("/api/action-policies", {
        token: admin, method: "PUT",
        json: { id: `apol_flood_${i}`, name: `flood ${i}`, action: "noop.flood", effect: "BLOCK", priority: 1 },
      });
      got429 = r.status === 429;
    }
    record("le limiteur rejette réellement (429 obtenu)", got429);
    record("et le rejet est compté",
      (series(await scrape(), 'oathrion_rate_limit_outcomes_total{scope="write",outcome="rejected"}') ?? 0) > rlBefore);

    section("LE MAGASIN DE QUOTAS INJOIGNABLE — le signal que personne ne pense à éprouver");
    /*
     * La table du limiteur est RENOMMÉE, pas supprimée : réversible à l'identique, sans
     * rejouer de DDL. PostgreSQL reste debout — on veut la panne du MAGASIN seule, et non
     * une base absente, qui est déjà couverte par `chaos:postgres`.
     *
     * C'est le quatrième signal, et c'était le seul que le banc ne provoquait pas : un
     * mutant retirant `noteRateLimitStore(false)` passait 50/50. Il est aussi le plus
     * conséquent des quatre — en posture `closed` il refuse du trafic client légitime,
     * et en posture `open` il a retiré la protection anti-force-brute de la page de
     * connexion sans que rien ne le dise.
     */
    const rlPool = new Pool({ connectionString: db.url, max: 1 });
    try {
      await rlPool.query(`ALTER TABLE rate_limit_buckets RENAME TO rate_limit_buckets_cachee`);
      const outageBefore = series(await scrape(), 'oathrion_rate_limit_outcomes_total{scope="write",outcome="store_unavailable"}') ?? 0;

      const refusedWrite = await call("/api/action-policies", {
        token: admin, method: "PUT",
        json: { id: "apol_pendant_panne", name: "pendant la panne", action: "noop.x", effect: "BLOCK", priority: 1 },
      });
      record("une écriture est refusée en 503, et non en 500", refusedWrite.status === 503,
        `statut ${refusedWrite.status}`);
      record("… avec un Retry-After honnête plutôt qu'un 429 mensonger", refusedWrite.status === 503,
        "le quota n'est pas épuisé : le compteur est injoignable");

      const duringOutage = await scrape();
      record("la panne du magasin est COMPTÉE",
        (series(duringOutage, 'oathrion_rate_limit_outcomes_total{scope="write",outcome="store_unavailable"}') ?? 0) > outageBefore,
        `${String(series(duringOutage, 'oathrion_rate_limit_outcomes_total{scope="write",outcome="store_unavailable"}'))} occurrences`);
      record("… et la jauge d'accessibilité tombe à 0",
        series(duringOutage, "oathrion_rate_limit_store_reachable") === 0,
        String(series(duringOutage, "oathrion_rate_limit_store_reachable")));
      record("la page de métriques reste servie pendant la panne",
        duringOutage.includes("oathrion_up 1"),
        "une supervision qui tombe avec ce qu'elle observe ne sert à rien");
      record("/api/ready reste 200 : la base, elle, répond", (await call("/api/ready")).status === 200,
        "distinguer le magasin de quotas de la base est tout l'intérêt de deux jauges");
    } finally {
      await rlPool.query(`ALTER TABLE rate_limit_buckets_cachee RENAME TO rate_limit_buckets`).catch(() => undefined);
      await rlPool.end().catch(() => undefined);
    }
    /*
     * Un scrape NE SUFFIT PAS à faire remonter la jauge, et c'est correct : elle
     * rapporte le dernier passage par le limiteur, et `/api/metrics` est une sonde qui
     * ne le traverse pas. Il faut donc une vraie requête limitée — ce que le premier
     * jet de ce contrôle avait oublié, en lisant 0 et en criant à la régression.
     */
    record("un scrape seul ne rafraîchit pas la jauge — elle rapporte, elle ne sonde pas",
      series(await scrape(), "oathrion_rate_limit_store_reachable") === 0);
    /*
     * Une ÉCRITURE, et non une lecture : seules les routes de décision, d'écriture et
     * d'approbation portent un limiteur. Le premier jet lisait `/api/agents`, qui n'en a
     * pas, et la jauge restait donc à 0 pour la bonne raison. Un 429 conviendrait aussi —
     * `noteRateLimitStore(true)` précède le test du plafond — mais un 200 est plus clair.
     */
    await call("/api/action-policies", {
      token: admin, method: "PUT",
      json: { id: "apol_apres_panne", name: "après la panne", action: "noop.y", effect: "BLOCK", priority: 1 },
    });
    record("la jauge remonte à 1 au premier passage par le limiteur, sans redémarrage",
      series(await scrape(), "oathrion_rate_limit_store_reachable") === 1,
      String(series(await scrape(), "oathrion_rate_limit_store_reachable")));

    /* ------------------------------------------- CHAÎNE ROMPUE */
    section("L'AUDIT DES CHAÎNES — une rupture est vue, et l'exploitant n'a besoin d'aucun jeton client");
    const clean = await auditChains(db.url);
    record("sur une base saine, audit:chains sort 0", clean.code === 0, `code ${clean.code}`);
    record("… et nomme le locataire audité", /org_[a-z0-9]{20}/.test(clean.out), "l'exploitant possède la base");

    const pool = new Pool({ connectionString: db.url, max: 1 });
    try {
      /*
       * `outcome`, et le premier jet falsifiait `result_summary` — ce qui PASSAIT, parce
       * que ce champ n'entre pas dans l'empreinte (`receiptEntryHash` énumère quinze
       * champs et pas celui-là). Le banc avait donc d'abord déclaré « rupture détectée »
       * sur une base que l'audit jugeait, à juste titre, intacte.
       *
       * C'est la découverte la plus intéressante de l'étape : `result_summary` figure
       * sur le reçu que lit un auditeur et n'est PAS couvert par la chaîne. Le contrôle
       * ci-dessous l'épingle explicitement, pour que personne ne le redécouvre en
       * croyant à un bug — et `docs/limitations.md` le dit désormais.
       *
       * La falsification retenue ici est en revanche la plus grave possible : réécrire
       * « cette action a échoué » en « elle a réussi ».
       */
      const touched = await pool.query(
        `UPDATE action_receipts SET outcome = 'succeeded'
          WHERE outcome = 'failed'`,
      );
      record("un reçu est falsifié en base : `failed` réécrit en `succeeded`",
        (touched.rowCount ?? 0) === 1, `${String(touched.rowCount)} ligne`);
    } finally {
      await pool.end().catch(() => undefined);
    }
    const broken = await auditChains(db.url);
    record("audit:chains sort 1 — pas 0, pas 2", broken.code === 1, `code ${broken.code}`);
    record("… et dit OÙ la chaîne casse, et sur quel reçu",
      /ROMPUE au n°\d+ : content: le contenu du reçu "rcpt_[0-9a-f]{32}" a changé/.test(broken.out),
      broken.out.split("\n").find((l) => l.includes("ROMPUE"))?.trim().slice(0, 100) ?? "");
    record("… et refuse de conseiller une restauration par-dessus", /ne restaurez pas par-dessus/.test(broken.out));
    const bad = await auditChains("postgres://placet:nobody@127.0.0.1:1/absente");
    record("une base injoignable sort 2, et non 0", bad.code === 2, `code ${bad.code}`);

    /* ----------------------------------- LA SONDE RESTE TERNE */
    /*
     * Placée AVANT la section suivante, et ce n'est pas un détail de mise en page :
     * celle-ci bascule l'instance sur une base neuve et détruit l'ancienne. Interroger
     * `/api/ready` après coup rendait 503 — correctement, la base ayant disparu sous le
     * processus — et le contrôle échouait pour une raison qui n'avait rien à voir avec ce
     * qu'il mesure. Un banc dont l'ordre des sections compte doit le dire.
     */
    section("CE QUI NE DOIT PAS AVOIR CHANGÉ");
    const ready = await call("/api/ready");
    record("/api/ready ne porte toujours aucun compte", ready.status === 200 && !/\d{2,}/.test(JSON.stringify(ready.body.checks ?? {})),
      "une sonde est sans credential : elle doit rester terne");
    record("/api/live non plus", !(await call("/api/live")).text.includes("total"));

    section("LE RÉSUMÉ DU RÉSULTAT — désormais couvert, et c'était l'inverse");
    /*
     * CE CONTRÔLE EST L'INVERSE DE CELUI QU'IL REMPLACE.
     *
     * Il affirmait que `result_summary` n'était PAS couvert par la chaîne, et son
     * commentaire annonçait qu'il échouerait le jour où le champ entrerait dans
     * l'empreinte. Ce jour est arrivé : le champ est haché, et falsifier le seul texte
     * lisible du reçu rompt désormais la chaîne comme n'importe quelle autre édition.
     *
     * La chaîne a été remise d'aplomb par les deux requêtes précédentes ? Non — elle est
     * rompue depuis la falsification de `outcome` ci-dessus. On repart donc d'une base
     * neuve pour que ce contrôle mesure le résumé et non le reste.
     */
    const summaryDb = await createThrowawayDatabase("oathrion_obs_summary");
    try {
      const child2 = boot(summaryDb.url, tools.url);
      await stop(child);
      child = child2.child;
      if (!await waitReady(child)) {
        record("une seconde instance démarre pour ce contrôle", false);
      } else {
        const admin2 = String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
        await call("/api/agents", {
          token: admin2,
          json: {
            id: "agt_obs", name: "Agent obs", description: "banc", provider: "openai", model: "gpt-4o",
            status: "active", owner: "ops",
            mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
            permissions: [], policyIds: [], tags: [],
          },
        });
        await call("/api/action-policies", {
          token: admin2, method: "PUT",
          json: { id: "apol_obs_allow", name: "courant", action: "stripe.refund", destinationId: DEST, effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
        });
        const key2 = await call("/api/keys", { token: admin2, json: { name: "obs2", role: "operator", agentId: "agt_obs" } });
        const agent2 = String(key2.body.secret ?? "");
        const g = await call("/api/actions/authorize", { token: agent2, json: intent(15) });
        await call("/api/actions/execute", { token: agent2, json: { ...intent(15), grantId: String(g.body.grantId ?? "") } });

        record("sur cette base neuve, la chaîne tient", (await auditChains(summaryDb.url)).code === 0);

        const pool3 = new Pool({ connectionString: summaryDb.url, max: 1 });
        try {
          const touched = await pool3.query(
            `UPDATE action_receipts SET result_summary = 'tout s''est bien passé'`,
          );
          record("le seul texte lisible du reçu est réécrit en base", (touched.rowCount ?? 0) === 1,
            `${String(touched.rowCount)} ligne`);
        } finally {
          await pool3.end().catch(() => undefined);
        }

        const broken2 = await auditChains(summaryDb.url);
        record("la chaîne le DÉTECTE — ce champ n'était pas couvert avant", broken2.code === 1,
          `code ${broken2.code}`);
        record("… et l'impute au contenu du reçu édité", /content: le contenu du reçu/.test(broken2.out),
          broken2.out.split("\n").find((l) => l.includes("ROMPUE"))?.trim().slice(0, 90) ?? "");
      }
    } finally {
      await summaryDb.dispose();
    }

    return 0;
  } finally {
    await stop(child);
    await tools?.close();
    await db?.dispose();
  }
}

/** Lance `audit:chains` dans un processus séparé et rend son code et sa sortie. */
async function auditChains(databaseUrl: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "script", "audit-chains.ts")], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.stderr.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("exit", (code) => resolve({ code: code ?? -1, out }));
  });
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
