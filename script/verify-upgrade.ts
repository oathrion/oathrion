/**
 * Répétition d'une mise à jour **sur des données vivantes**, dans les deux sens.
 *
 *   npm run build
 *   DATABASE_URL=postgres://… npm run verify:upgrade
 *
 * ## Pourquoi ce banc existe
 *
 * `server/test/migrations.test.ts` prouve que les migrations s'appliquent sur une base
 * NEUVE, et que l'histoire ne peut pas être réécrite. C'est nécessaire et ce n'est pas la
 * question qu'un exploitant se pose. La sienne est : **« je livre un correctif pendant un
 * pilote — qu'est-ce qui arrive aux données du client ? »** Personne ne l'avait jouée.
 *
 * Et la question symétrique, qui est la vraie urgence : **« le correctif a cassé quelque
 * chose, je remets la version d'avant »**. Il n'existe aucune migration descendante, par
 * conception. Revenir en arrière signifie donc redéployer l'image précédente **si** elle
 * accepte le schéma courant — et cette condition n'avait jamais été vérifiée.
 *
 * ## Comment une version « précédente » est simulée
 *
 * Pas en cherchant un ancien commit : ce banc doit tourner sur l'archive livrée, qui n'a
 * qu'une version. Un serveur plus ancien est donc représenté par **la même liste de
 * migrations, tronquée** — `MIGRATIONS.slice(0, n)`. C'est exactement ce que voit un
 * build antérieur : un registre qui ne connaît pas les dernières versions. Le garde
 * éprouvé, `assertHistoryMatches`, est le vrai, pas une imitation.
 *
 * Ce que cette forme ne prouve pas : qu'un binaire réellement ancien se comporte comme
 * sa liste tronquée. Elle prouve le CONTRAT du registre, qui est l'endroit où la décision
 * se prend. C'est dit plutôt que laissé entendre.
 *
 * Codes de sortie : 0 tout est passé · 1 un contrôle a échoué · 2 impossible à monter.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { Pool } from "pg";

import {
  baseUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";
import { MIGRATIONS, migratePostgres } from "../server/migrations";
import { assertHistoryMatches } from "../server/migrations/runner";
import type { AppliedMigration } from "../server/migrations";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5281;
const BASE = `http://127.0.0.1:${PORT}`;
const DEST = "local-fixture";

const SESSION_SECRET = `up-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const EMAIL = "admin@maj.test";
const PASSWORD = `maj-${Math.random().toString(36).slice(2)}-pw-0123`;

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

const intent = (amount: number) => ({
  action: "stripe.refund",
  destinationId: DEST,
  arguments: { customer: "cus_maj", amount, currency: "EUR" },
});

function boot(databaseUrl: string) {
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(databaseUrl),
      OATHRION_DB: undefined,
      ARIA_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: "",
      OATHRION_CONSOLE_USERS: `MaJ/${EMAIL}:admin:${PASSWORD}`,
      OATHRION_SEED: "",
      OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
      OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
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

async function schemaVersion(url: string): Promise<number> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const r = await pool.query<{ v: string }>(`SELECT max(version) AS v FROM schema_migrations`);
    return Number(r.rows[0]?.v ?? 0);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
/**
 * Le registre de migrations tel qu'il est en base.
 *
 * Lu directement plutôt que par le pilote PostgreSQL : ce banc doit pouvoir le lire
 * SANS instancier le runner, puisque c'est précisément le runner qu'il met à l'épreuve.
 * `appliedAt` et `statementCount` sont lus aussi — `assertHistoryMatches` ne les regarde
 * pas, mais les inventer ici ferait de ce banc un juge de sa propre fabrication.
 */
async function appliedRows(url: string): Promise<AppliedMigration[]> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const r = await pool.query<{ version: string; name: string; applied_at: unknown; statement_count: string }>(
      `SELECT version, name, applied_at, statement_count FROM schema_migrations ORDER BY version`,
    );
    return r.rows.map((row) => ({
      version: Number(row.version),
      name: row.name,
      appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
      statementCount: Number(row.statement_count),
    }));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  console.log("OATHRION — RÉPÉTITION D'UNE MISE À JOUR SUR DES DONNÉES VIVANTES");

  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE} :\n  npm run build`);
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante.");
    return 2;
  }

  const LATEST = MIGRATIONS.length;
  const PREVIOUS = LATEST - 1;
  if (PREVIOUS < 1) {
    console.error("Il faut au moins deux migrations pour répéter une mise à jour.");
    return 2;
  }
  console.log(`Registre : ${LATEST} migrations. « Version précédente » simulée à ${PREVIOUS}.`);

  let db: ThrowawayDatabase | undefined;
  let child: Child | undefined;

  try {
    /* ------------------------------------- 1. LA VERSION « PRÉCÉDENTE » */
    section(`N−1 — une base au schéma ${PREVIOUS}, remplie comme chez un client`);
    /*
     * `migrate: false` donne une base VIDE ; on y applique ensuite la liste TRONQUÉE,
     * ce qui est l'état d'un client qui tourne sur la version d'avant.
     */
    db = await createThrowawayDatabase("oathrion_upgrade", process.env, { migrate: false });
    console.log(`Base : ${db.name} sur ${redactUrl(baseUrl())}`);
    await migratePostgres(db.url, MIGRATIONS.slice(0, PREVIOUS));
    record(`la base est au schéma ${PREVIOUS}`, (await schemaVersion(db.url)) === PREVIOUS,
      `version ${await schemaVersion(db.url)}`);

    /*
     * LA DÉCOUVERTE DE CE BANC, trouvée au premier passage.
     *
     * Le bundle livré **n'applique pas** les migrations en attente à son démarrage : il
     * REFUSE de démarrer et dit quoi lancer. C'est la bonne conception — une migration
     * est une opération qu'un exploitant ordonnance, pas un effet de bord du démarrage
     * d'un conteneur, et c'est pour cela que `deploy/docker-compose.yml` a un service
     * `migrate` ponctuel qui garde le démarrage de l'application.
     *
     * Mais `docs/OPERATIONS.md` §8 et l'en-tête de `deploy/scripts/restore.sh`
     * affirmaient l'inverse — « Oathrion applique les migrations en attente au
     * démarrage ». Un exploitant qui suit ce runbook déploie, voit le processus refuser
     * de démarrer, et ne trouve dans la procédure aucune mention de l'étape qui manque.
     * Les deux documents sont corrigés dans le même commit que ce banc.
     *
     * Le refus est donc éprouvé ICI comme un comportement voulu, avant d'exécuter
     * l'étape réelle.
     */
    const premature = boot(db.url);
    const booted = await waitReady(premature.child, 24);
    record("le bundle REFUSE de démarrer sur un schéma en attente", !booted,
      booted ? "il a démarré" : `code ${String(premature.child.exitCode)}`);
    record("… en nommant les deux versions et la commande à lancer",
      new RegExp(`version ${PREVIOUS}`).test(premature.log()) &&
        new RegExp(`needs ${LATEST}`).test(premature.log()) &&
        /migrate:postgres|dist\/migrate\.cjs/.test(premature.log()),
      premature.log().split("\n").find((l) => /needs/.test(l))?.trim().slice(0, 80) ?? "");
    await stop(premature.child);

    /*
     * L'étape que l'exploitant doit lancer, par le MÊME binaire que le compose : le
     * `migrate` ponctuel. Pas `migratePostgres()` importé depuis les sources — ce banc
     * éprouve ce qui est livré.
     */
    const migrated = spawnSync("node", [path.join(ROOT, "dist", "migrate.cjs")], {
      cwd: ROOT, encoding: "utf8", timeout: 180_000,
      env: { ...process.env, DATABASE_URL: db.url, DATABASE_DRIVER: "postgres" },
    });
    const migrateOut = `${migrated.stdout ?? ""}${migrated.stderr ?? ""}`;
    record("le migrateur ponctuel réussit", migrated.status === 0, migrateOut.trim().split("\n").pop()?.slice(0, 70) ?? "");
    record(`… et la base passe au schéma ${LATEST}`,
      (await schemaVersion(db.url)) === LATEST, `version ${await schemaVersion(db.url)}`);

    const before = boot(db.url);
    child = before.child;
    const up = await waitReady(child);
    record("le bundle démarre ALORS, sur la base migrée", up, up ? "" : `code ${String(child.exitCode)}`);
    if (!up) {
      console.log(before.log().slice(-2000));
      return 1;
    }

    /* ------------------------------------------- 2. DES DONNÉES VIVANTES */
    section("DONNÉES VIVANTES — un locataire, une action exécutée, une chaîne");
    const admin = String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
    const org = String(
      ((await call("/api/auth/session", { token: admin })).body.identity as { organizationId?: string } | undefined)
        ?.organizationId ?? "",
    );
    record("l'administrateur se connecte", admin !== "" && /^org_[a-z0-9]{20}$/.test(org), org);

    await call("/api/agents", {
      token: admin,
      json: {
        id: "agt_maj", name: "Agent de la mise à jour", description: "répétition", provider: "openai",
        model: "gpt-4o", status: "active", owner: "ops",
        mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
        permissions: [], policyIds: [], tags: [],
      },
    });
    await call("/api/action-policies", {
      token: admin, method: "PUT",
      json: { id: "apol_maj", name: "courant", action: "stripe.refund", destinationId: DEST, effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
    });
    const key = await call("/api/keys", { token: admin, json: { name: "clé maj", role: "operator", agentId: "agt_maj" } });
    const agentKey = String(key.body.secret ?? "");
    const g = await call("/api/actions/authorize", { token: agentKey, json: intent(40) });
    const grantId = String(g.body.grantId ?? "");
    await call("/api/actions/execute", { token: agentKey, json: { ...intent(40), grantId } });
    const chain = await call("/api/actions/receipts/verify", { token: admin });
    const head = String(chain.body.headHash ?? "");
    record("une action est exécutée et la chaîne vérifie", chain.body.ok === true && head !== "",
      `${String(chain.body.entries)} reçus, tête ${head.slice(0, 12)}…`);

    /* ------------------------------- 3. REDÉMARRAGE À LA MÊME VERSION */
    section("REDÉMARRAGE — la même version, deux fois : rien ne doit bouger");
    await stop(child);
    const again = boot(db.url);
    child = again.child;
    record("le bundle redémarre sur la base qu'il vient de migrer", await waitReady(child));
    record("aucune migration n'est appliquée une seconde fois",
      (await schemaVersion(db.url)) === LATEST && (await appliedRows(db.url)).length === LATEST,
      `${(await appliedRows(db.url)).length} lignes de registre`);
    const adminAgain = String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
    const chainAgain = await call("/api/actions/receipts/verify", { token: adminAgain });
    record("la chaîne vérifie avec LA MÊME TÊTE", chainAgain.body.ok === true && String(chainAgain.body.headHash ?? "") === head,
      `tête ${String(chainAgain.body.headHash ?? "").slice(0, 12)}…`);
    const replay = await call("/api/actions/execute", { token: agentKey, json: { ...intent(40), grantId } });
    record("le grant consommé avant la mise à jour reste consommé",
      replay.status === 403 && replay.body.code === "grant_already_consumed", String(replay.body.code));

    /* -------------------------------------- 4. LE RETOUR ARRIÈRE, REFUSÉ */
    section("RETOUR ARRIÈRE — un serveur plus ancien doit REFUSER, pas écrire");
    /*
     * Le vrai garde, `assertHistoryMatches`, appelé avec la liste tronquée — c'est-à-dire
     * exactement ce qu'un build antérieur connaît. C'est le contrôle le plus important de
     * ce banc : sans lui, un retour arrière ferait tourner du code ancien sur un schéma
     * récent, qui écrirait des lignes que les contraintes du nouveau schéma interdisent,
     * et la corruption ne se verrait qu'à la mise à jour suivante.
     */
    const applied = await appliedRows(db.url);
    let refusal: Error | null = null;
    try {
      assertHistoryMatches(applied, MIGRATIONS.slice(0, PREVIOUS));
    } catch (error) {
      refusal = error instanceof Error ? error : new Error(String(error));
    }
    record("un serveur N−1 REFUSE la base en N", refusal !== null, refusal ? "refus" : "il aurait démarré");
    record("… en nommant la version qu'il ne connaît pas",
      refusal !== null && new RegExp(`version ${LATEST}\\b`).test(refusal.message),
      refusal?.message.slice(0, 90) ?? "");
    record("… et en disant quoi faire", refusal !== null && /Deploy a build that includes|restore the database/.test(refusal.message));

    record("le serveur COURANT accepte la même base", (() => {
      try { assertHistoryMatches(applied, MIGRATIONS); return true; } catch { return false; }
    })(), "contrôle positif : le refus ci-dessus n'est pas un refus de tout");

    /*
     * Et le second défaut que ce garde attrape : une histoire RÉÉCRITE. Un correctif qui
     * modifierait une migration déjà appliquée au lieu d'en ajouter une est la façon la
     * plus discrète de diverger entre deux déploiements du même numéro de version.
     */
    let rewritten: Error | null = null;
    try {
      assertHistoryMatches(
        applied.map((row, i) => (i === 1 ? { ...row, name: "renommée-apres-coup" } : row)),
        MIGRATIONS,
      );
    } catch (error) {
      rewritten = error instanceof Error ? error : new Error(String(error));
    }
    record("une histoire réécrite est refusée aussi", rewritten !== null,
      rewritten?.message.slice(0, 80) ?? "elle serait passée");

    section("CE QUI RESTE NON PROUVÉ");
    console.log("  Un binaire RÉELLEMENT ancien. « N−1 » est ici la même liste de migrations");
    console.log("  tronquée — ce qu'un build antérieur connaît du registre, et l'endroit où la");
    console.log("  décision se prend. Mais le code applicatif, lui, est celui d'aujourd'hui :");
    console.log("  qu'une version antérieure du serveur se comporte comme sa liste tronquée");
    console.log("  reste à vérifier le jour où deux versions existent réellement.");
    console.log("");
    console.log("  Et il n'existe AUCUNE migration descendante, par conception. Un retour");
    console.log("  arrière est un redéploiement de l'image précédente, qui refusera si le");
    console.log("  schéma a avancé — c'est précisément ce que le §4 ci-dessus démontre. La");
    console.log("  seule issue est alors une restauration : voir `npm run verify:dr`.");

    return 0;
  } finally {
    await stop(child);
    await db?.dispose();
  }
}

main()
  .then((code) => {
    const failed = checks.filter((c) => !c.ok);
    if (checks.length > 0) {
      console.log(`\n${"=".repeat(72)}`);
      console.log(`${checks.length - failed.length}/${checks.length} contrôles passés`);
      console.log("=".repeat(72));
    }
    return code === 2 ? 2 : code === 0 && failed.length === 0 ? 0 : 1;
  })
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
