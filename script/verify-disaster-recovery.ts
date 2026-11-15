/**
 * Exercice de reprise après sinistre : **restaurer sur une autre machine**.
 *
 *   npm run build
 *   DATABASE_URL=postgres://… npm run verify:dr
 *
 * ## Pourquoi ce banc existe
 *
 * `docs/OPERATIONS.md` portait, à la ligne « Perte de la machine » : « procédure PASS sur
 * la même machine ; **NON TESTÉ** sur une autre machine ». C'est le chemin de reprise
 * après sinistre, et personne ne l'avait jamais parcouru. C'est aussi le seul dont
 * l'échec est **irréversible** : un client dont l'hôte meurt découvre à ce moment-là si
 * la procédure fonctionne.
 *
 * ## Ce que « une autre machine » veut dire ici, exactement
 *
 * Un **second serveur PostgreSQL**, dans son propre conteneur, avec son propre volume,
 * son propre mot de passe et son propre port. Rien n'est partagé avec l'original : ni
 * fichier, ni credential, ni processus. Le seul objet qui traverse est **le dump**, comme
 * dans un vrai sinistre.
 *
 * Ce qui n'est PAS prouvé par cette forme : le processus applicatif tourne toujours sur
 * cet hôte, donc le même noyau et la même architecture. Une reprise sur un autre système
 * d'exploitation, ou une autre architecture de processeur, reste non éprouvée. C'est dit
 * plutôt que laissé entendre.
 *
 * ## Les deux découvertes que cet exercice encode
 *
 * **1. Le dump ne contient pas le registre des destinations.** Il vit dans
 * l'environnement (`OATHRION_DESTINATIONS`, `OATHRION_LOCAL_MCP_URL`) et nulle part en base.
 * Une restauration rend donc les locataires, les agents, les règles, les grants et les
 * reçus — mais **pas où les actions partent**. Un exploitant qui ne sauvegarde que la
 * base obtient un système qui décide correctement et n'exécute plus rien.
 *
 * **2. Aucune donnée n'est chiffrée en base aujourd'hui.** `server/secrets/envelope.ts`
 * existe, est testé, et n'est **appelé par aucune route** : `encryptEnvelope` n'apparaît
 * nulle part hors de son propre module et de ses tests. La `OATHRION_KEK` n'est donc pas
 * encore une dépendance de reprise — mais elle le deviendra le jour où une intégration
 * stockera un credential, et ce jour-là un dump sans la clé sera illisible. Ce banc
 * vérifie l'état d'aujourd'hui et le dit.
 *
 * Codes de sortie : 0 tout est passé · 1 un contrôle a échoué · 2 impossible à monter.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { Pool } from "pg";

import {
  baseUrl,
  containerUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5271;
const BASE = `http://127.0.0.1:${PORT}`;
const DEST = "local-fixture";

/* La « machine de remplacement » : un serveur PostgreSQL à elle. */
/**
 * L'IMAGE DE LA MACHINE DE REMPLACEMENT, LUE DANS LE COMPOSE LIVRÉ.
 *
 * ## Le défaut que cette lecture corrige
 *
 * Ce banc écrivait `postgres:16-alpine` en dur, alors que `deploy/docker-compose.yml`
 * épingle `postgres:17`. La répétition a dérivé, et la conséquence n'est pas cosmétique :
 *
 *   `pg_restore: error: unsupported version (1.16) in file header`
 *
 * `pg_dump` et `pg_restore` sont compatibles VERS L'AVANT, jamais vers l'arrière. Une
 * archive écrite par le PostgreSQL 17 du déploiement ne se restaure pas sur un
 * PostgreSQL 16. L'exercice de reprise après sinistre échouait donc exactement là où il
 * compte — à la restauration — et l'échec était réel, pas un artefact de banc : un
 * exploitant qui restaure sur une version majeure plus ANCIENNE que celle qui a produit
 * la sauvegarde se heurte au même mur, le jour où il n'a plus que la sauvegarde.
 *
 * ## Pourquoi la version est DÉRIVÉE et non corrigée
 *
 * Mettre `17` ici aurait rétabli l'exercice jusqu'à la prochaine montée de version, et
 * l'aurait cassé de la même façon. La valeur est donc lue dans le compose : il n'y a plus
 * qu'un endroit où la version de PostgreSQL est déclarée, et l'exercice suit le
 * déploiement sans qu'on y pense.
 *
 * Si la lecture échoue, le banc REFUSE de continuer plutôt que de retomber sur une
 * valeur par défaut — un repli silencieux reproduirait précisément la dérive.
 */
function spareImage(): string {
  const compose = readFileSync(path.join(ROOT, "deploy", "docker-compose.yml"), "utf8");
  const match = /^\s*image:\s*(postgres:[A-Za-z0-9._-]+)\s*$/m.exec(compose);
  if (!match) {
    throw new Error(
      "impossible de lire l'image PostgreSQL dans deploy/docker-compose.yml. " +
        "Ce banc ne choisit pas de version : il suit celle du déploiement.",
    );
  }
  return match[1]!;
}

const SPARE_IMAGE = spareImage();
const SPARE_CONTAINER = `placet-dr-spare-${process.pid}`;
const SPARE_PORT = 55499;
const SPARE_PASSWORD = `dr-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const SPARE_URL = `postgres://postgres:${SPARE_PASSWORD}@127.0.0.1:${SPARE_PORT}/postgres`;

const SECRET_A = `dr-a-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const SECRET_B = `dr-b-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const EMAIL = "admin@sinistre.test";
const PASSWORD = `dr-${Math.random().toString(36).slice(2)}-pw-0123`;

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

function run(cmd: string, args: string[], timeout = 180_000, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout, env });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

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
  arguments: { customer: "cus_dr", amount, currency: "EUR" },
});

function boot(databaseUrl: string, sessionSecret: string, extra: Record<string, string | undefined> = {}) {
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(databaseUrl),
      OATHRION_DB: undefined,
      ARIA_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: sessionSecret,
      OATHRION_API_KEYS: "",
      OATHRION_CONSOLE_USERS: `Sinistre/${EMAIL}:admin:${PASSWORD}`,
      OATHRION_SEED: "",
      OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
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
  console.log("OATHRION — EXERCICE DE REPRISE APRÈS SINISTRE (restauration sur une autre machine)");

  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE} :\n  npm run build`);
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante : il faut un PostgreSQL d'origine pour avoir quoi perdre.");
    return 2;
  }
  if (run("docker", ["version"], 30_000).status !== 0) {
    console.log("\nSKIPPÉ BRUYAMMENT : `docker` est introuvable.");
    console.log("La « machine de remplacement » est un conteneur PostgreSQL à elle ; sans");
    console.log("docker, ce banc ne peut rien prouver et ne prétend donc rien.");
    return 0;
  }

  let origin: ThrowawayDatabase | undefined;
  let child: Child | undefined;
  let backupDir: string | undefined;
  let spareStarted = false;

  try {
    /* ------------------------------------------- 1. LA MACHINE D'ORIGINE */
    section("MACHINE D'ORIGINE — un locataire réel, et une action exécutée");
    origin = await createThrowawayDatabase("oathrion_dr_origin");
    console.log(`Origine : ${origin.name} sur ${redactUrl(baseUrl())}`);

    const first = boot(origin.url, SECRET_A);
    child = first.child;
    if (!await waitReady(child)) {
      console.log(first.log().slice(-2000));
      return 2;
    }
    record("l'instance d'origine démarre", true);

    const loginA = await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } });
    const adminA = String(loginA.body.token ?? "");
    const org = String(
      ((await call("/api/auth/session", { token: adminA })).body.identity as { organizationId?: string } | undefined)
        ?.organizationId ?? "",
    );
    record("l'administrateur se connecte, et son locataire a un identifiant", /^org_[a-z0-9]{20}$/.test(org), org);

    await call("/api/agents", {
      token: adminA,
      json: {
        id: "agt_dr", name: "Agent du sinistre", description: "exercice", provider: "openai", model: "gpt-4o",
        status: "active", owner: "ops",
        mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
        permissions: [], policyIds: [], tags: [],
      },
    });
    await call("/api/action-policies", {
      token: adminA, method: "PUT",
      json: { id: "apol_dr", name: "courant", action: "stripe.refund", destinationId: DEST, effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
    });
    const keyA = await call("/api/keys", { token: adminA, json: { name: "clé du sinistre", role: "operator", agentId: "agt_dr" } });
    const agentKey = String(keyA.body.secret ?? "");
    record("agent, règle et credential créés", agentKey !== "");

    /*
     * Une action réellement exécutée AVANT la sauvegarde : c'est elle qui produit le
     * reçu, donc la chaîne, donc l'objet dont la survie prouve quelque chose. La
     * destination pointe sur un port fermé, donc l'exécution échouera côté aval — et
     * c'est sans importance ici : le grant est consommé et le reçu écrit, ce qui est
     * exactement ce qui doit traverser le sinistre.
     */
    const authorized = await call("/api/actions/authorize", { token: agentKey, json: intent(30) });
    const grantId = String(authorized.body.grantId ?? "");
    const executed = await call("/api/actions/execute", { token: agentKey, json: { ...intent(30), grantId } });
    record("une action est autorisée et exécutée", authorized.body.decision === "ALLOW" && executed.status === 200,
      `décision ${String(authorized.body.decision)}, exécution ${executed.status}`);

    const chainBefore = await call("/api/actions/receipts/verify", { token: adminA });
    const headBefore = String(chainBefore.body.headHash ?? "");
    record("la chaîne de reçus vérifie, et on note sa tête", chainBefore.body.ok === true && headBefore !== "",
      `${String(chainBefore.body.entries)} reçus, tête ${headBefore.slice(0, 12)}…`);

    /* --------------------------------------------- 2. LA SAUVEGARDE */
    section("SAUVEGARDE — le seul objet qui traversera le sinistre");
    backupDir = mkdtempSync(path.join(tmpdir(), "placet-dr-"));
    /*
     * `OATHRION_PG_CONTAINER` est transmis, et l'URL est réécrite pour être joignable
     * DEPUIS ce conteneur — `containerUrl`. Le premier jet passait l'URL de l'hôte et
     * `backup.sh` échouait sur « Connection refused » depuis l'intérieur, avec un
     * message qui ne dit rien de la cause.
     */
    const pgContainer = process.env.OATHRION_PG_CONTAINER?.trim() ?? "";
    const dumped = run("bash", [path.join(ROOT, "deploy", "scripts", "backup.sh")], 180_000, {
      ...process.env,
      BACKUP_DIR: backupDir,
      DATABASE_URL: pgContainer ? containerUrl(origin.url) : origin.url,
      RETENTION_DAYS: "30",
    });
    record("backup.sh réussit", dumped.status === 0, dumped.out.trim().split("\n").pop()?.slice(0, 70) ?? "");
    if (dumped.status !== 0) {
      console.log(dumped.out.slice(-1200));
      return 2;
    }
    const dump = readdirSync(backupDir).find((f) => f.endsWith(".dump"));
    record("un fichier de dump existe", dump !== undefined, dump ?? "aucun");
    if (!dump) return 1;
    const dumpPath = path.join(backupDir, dump);

    /* -------------------------------------- 3. LE SINISTRE, ET LA MACHINE NEUVE */
    section("LE SINISTRE — l'instance et la base d'origine disparaissent");
    await stop(child);
    child = undefined;
    record("l'instance d'origine est arrêtée", true);

    /*
     * Une machine de remplacement : un serveur PostgreSQL à elle, propre volume, propre
     * mot de passe, propre port. Rien de partagé avec l'original. Le `--rm` et le
     * `finally` plus bas garantissent qu'elle ne survit pas à ce banc.
     */
    const started = run("docker", [
      "run", "-d", "--rm", "--name", SPARE_CONTAINER,
      "-e", `POSTGRES_PASSWORD=${SPARE_PASSWORD}`,
      "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_DB=postgres",
      "-p", `${SPARE_PORT}:5432`, SPARE_IMAGE,
    ], 180_000);
    spareStarted = started.status === 0;
    record(
      `une machine de remplacement est allumée (${SPARE_IMAGE}, comme le déploiement)`,
      spareStarted,
      spareStarted ? SPARE_CONTAINER : started.out.slice(-200),
    );
    if (!spareStarted) return 2;

    let spareReady = false;
    for (let i = 0; i < 60 && !spareReady; i += 1) {
      spareReady = run("docker", ["exec", SPARE_CONTAINER, "pg_isready", "-U", "postgres"], 20_000).status === 0;
      if (!spareReady) await sleep(1000);
    }
    record("son PostgreSQL répond", spareReady);
    if (!spareReady) return 2;

    const spare = new Pool({ connectionString: SPARE_URL, max: 1, connectionTimeoutMillis: 10_000 });
    try {
      await spare.query(`CREATE DATABASE oathrion_restored`);
    } finally {
      await spare.end().catch(() => undefined);
    }
    const restoredUrl = `postgres://postgres:${SPARE_PASSWORD}@127.0.0.1:${SPARE_PORT}/oathrion_restored`;
    record("une base vide y est créée", true);

    /* ------------------------------------------------ 4. LA RESTAURATION */
    section("RESTAURATION — restore.sh, tel quel, sur la machine neuve");
    /*
     * ATTENTION — la restauration vise la machine NEUVE, donc son conteneur à elle, et
     * non celui d'origine. C'est le piège de cet exercice : réutiliser
     * `OATHRION_PG_CONTAINER` de l'environnement ferait tourner `pg_restore` dans le
     * serveur d'origine, qui n'a aucune route vers le remplaçant — et le sinistre
     * simulé n'en serait plus un.
     */
    const spareEnv = {
      ...process.env,
      OATHRION_PG_CONTAINER: SPARE_CONTAINER,
      ARIA_PG_CONTAINER: undefined,
      TARGET_URL: containerUrl(restoredUrl),
    };
    const restored = run("bash", [path.join(ROOT, "deploy", "scripts", "restore.sh"), dumpPath], 240_000, spareEnv);
    record("restore.sh réussit", restored.status === 0, restored.out.trim().split("\n").pop()?.slice(0, 70) ?? "");
    if (restored.status !== 0) console.log(restored.out.slice(-1500));

    const refused = run("bash", [path.join(ROOT, "deploy", "scripts", "restore.sh"), dumpPath], 120_000, spareEnv);
    record("restaurer une seconde fois est REFUSÉ, pas écrasé", refused.status !== 0, `code ${refused.status}`);

    /* ------------------------------- 5. LA REPRISE, AVEC UN SECRET DIFFÉRENT */
    section("REPRISE — un secret de session DIFFÉRENT, comme sur une machine neuve");
    /*
     * `SECRET_B` et non `SECRET_A` : un exploitant qui reconstruit un hôte génère un
     * nouveau secret, ou le relit de son coffre. Les deux cas doivent marcher, et le
     * premier est le plus probable — donc le seul qui mérite d'être éprouvé.
     */
    const second = boot(restoredUrl, SECRET_B);
    child = second.child;
    const back = await waitReady(child);
    record("le bundle démarre sur la base restaurée", back, back ? "" : `code ${String(child.exitCode)}`);
    if (!back) {
      console.log(second.log().slice(-2000));
      return 1;
    }

    const stale = await call("/api/agents", { token: adminA });
    record("l'ancien jeton de session est refusé — le secret a changé", stale.status === 401, `statut ${stale.status}`);

    const loginB = await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } });
    const adminB = String(loginB.body.token ?? "");
    record("le MÊME mot de passe ouvre une nouvelle session", adminB !== "", `statut ${loginB.status}`);

    const session = await call("/api/auth/session", { token: adminB });
    record("l'identifiant du locataire est IDENTIQUE à celui d'avant",
      JSON.stringify(session.body).includes(org), org);

    const agents = await call("/api/agents", { token: adminB });
    record("l'agent a survécu", JSON.stringify(agents.body).includes("agt_dr"));
    const policies = await call("/api/action-policies", { token: adminB });
    record("la règle a survécu", JSON.stringify(policies.body).includes("apol_dr"));

    const chainAfter = await call("/api/actions/receipts/verify", { token: adminB });
    record("la chaîne de reçus vérifie, avec LA MÊME TÊTE qu'avant le sinistre",
      chainAfter.body.ok === true && String(chainAfter.body.headHash ?? "") === headBefore,
      `tête ${String(chainAfter.body.headHash ?? "").slice(0, 12)}…`);

    const replay = await call("/api/actions/execute", { token: agentKey, json: { ...intent(30), grantId } });
    record("le credential de l'agent fonctionne encore", replay.status !== 401, `statut ${replay.status}`);
    record("et le grant consommé AVANT la sauvegarde reste consommé",
      replay.status === 403 && replay.body.code === "grant_already_consumed",
      `code ${String(replay.body.code)}`);

    /* ------------------------ 6. CE QUE LE DUMP NE CONTIENT PAS */
    section("CE QUE LE DUMP NE CONTIENT PAS — la découverte de cet exercice");
    /*
     * Le registre des destinations vit dans l'ENVIRONNEMENT et nulle part en base. Un
     * exploitant qui ne sauvegarde que PostgreSQL obtient donc un système qui décide
     * correctement et n'exécute plus rien — et le refus doit être lisible, pas un 500.
     */
    await stop(child);
    const third = boot(restoredUrl, SECRET_B, {
      OATHRION_LOCAL_MCP_URL: undefined,
      OATHRION_LOCAL_MCP_ORGANIZATIONS: undefined,
    });
    child = third.child;
    const naked = await waitReady(child);
    record("le bundle démarre SANS aucune destination configurée", naked,
      "ne pas pouvoir exécuter n'est pas une raison de ne pas démarrer");
    if (naked) {
      const adminC = String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
      const dests = await call("/api/actions/destinations", { token: adminC });
      record("… et le registre est VIDE : il n'était pas dans le dump",
        JSON.stringify(dests.body.destinations ?? []) === "[]", JSON.stringify(dests.body.destinations ?? []));
      /*
       * UN BLOCK EST UN 200, et mon premier jet l'avait oublié.
       *
       * J'avais écrit `orphan.status >= 400` et conclu à un défaut du produit : il
       * rendait 200 pour une destination inexistante. C'était mon assertion qui était
       * fausse. « Toute décision est une réponse réussie » est la propriété C2 du kit de
       * conformité : la requête a réussi, et c'est son RÉSULTAT qui refuse. Un 4xx
       * ferait croire à un appel mal formé.
       *
       * Ce qui doit être vrai est donc : décision BLOCK, aucun grant, et un motif qui
       * nomme la destination — ce que `authorization-service.ts` fait bien, via
       * `isRegisteredDestination`. La documentation de `destinations.ts` l'annonçait
       * — « BLOCK at authorization, DESTINATION_UNKNOWN at execution » — et elle avait
       * raison.
       */
      const orphan = await call("/api/actions/authorize", { token: agentKey, json: intent(20) });
      record("l'action est BLOQUÉE, et c'est un 200 — une décision est une réponse réussie",
        orphan.status === 200 && orphan.body.decision === "BLOCK",
        `statut ${orphan.status}, décision ${String(orphan.body.decision)}`);
      record("… aucun grant n'est délivré", orphan.body.grantId === null, String(orphan.body.grantId));
      record("… et le motif nomme la destination non enregistrée",
        /destination/i.test(String(orphan.body.reason ?? "")),
        String(orphan.body.reason ?? "").slice(0, 80));
    }

    /*
     * Et la clé de chiffrement : aujourd'hui, aucune donnée chiffrée n'existe en base,
     * parce que `encryptEnvelope` n'est appelé par aucune route. Ce contrôle épingle cet
     * état — il échouera le jour où une intégration stockera un credential, et ce
     * jour-là la `OATHRION_KEK` devra entrer dans la procédure de reprise.
     */
    const envelopeWired = run("git", ["grep", "-l", "encryptEnvelope", "--", "server/"], 30_000).out
      .split("\n").filter((l) => l.trim() !== "" && !l.includes("secrets/"));
    record("aucune donnée chiffrée à restaurer — l'enveloppe n'est encore câblée nulle part",
      envelopeWired.length === 0,
      envelopeWired.length === 0 ? "la OATHRION_KEK n'est pas encore une dépendance de reprise" : envelopeWired.join(", "));

    section("CE QUI RESTE NON PROUVÉ");
    console.log("  La machine de remplacement est un SECOND SERVEUR PostgreSQL — propre");
    console.log("  conteneur, propre volume, propre mot de passe, propre port, rien de partagé.");
    console.log("  Mais le processus applicatif tourne toujours sur cet hôte : même noyau,");
    console.log("  même architecture. Une reprise sur un autre système d'exploitation ou une");
    console.log("  autre architecture de processeur reste NON ÉPROUVÉE.");

    return 0;
  } finally {
    await stop(child);
    if (spareStarted) run("docker", ["rm", "-f", SPARE_CONTAINER], 60_000);
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
    await origin?.dispose();
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
