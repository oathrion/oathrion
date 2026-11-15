/**
 * Preuve du cycle sauvegarde → restauration, avec le bundle de production.
 *
 *   DATABASE_URL=postgres://… OATHRION_PG_CONTAINER=<conteneur> npm run verify:backup
 *
 * ## Pourquoi ce script existe
 *
 * `docs/OPERATIONS.md` portait, pour `deploy/scripts/backup.sh`, la mention « NON TESTÉ
 * tel quel ». C'était exact, et c'est la pire ligne possible dans un document
 * d'exploitation : une sauvegarde dont personne n'a jamais joué la restauration n'est
 * pas une sauvegarde, c'est une intention.
 *
 * Exécuter les scripts a d'ailleurs montré qu'ils **ne pouvaient pas fonctionner** sur
 * l'hôte d'un déploiement compose : ils appellent `pg_dump`, `pg_restore` et `psql`,
 * qu'aucune image du kit n'installe. Le mode `COMPOSE=1` de `backup.sh` n'était
 * qu'à moitié fait — il dumpait dans le conteneur puis vérifiait sur l'hôte.
 *
 * ## Ce que ce script prouve, et ce qu'il ne prouve pas
 *
 * **Prouve** : un dump pris par le script se restaure dans une base neuve, Oathrion démarre
 * dessus, la chaîne de reçus s'y vérifie avec la MÊME tête qu'avant, un grant consommé
 * avant la sauvegarde reste consommé après, et un autre locataire ne lit toujours rien.
 *
 * **Ne prouve pas** que votre cron tourne. La planification appartient à l'exploitant ;
 * ce que ce script garantit, c'est que la commande qu'il planifiera fait ce qu'elle
 * annonce. Les durées affichées viennent d'une base de test, et ne sont pas un RTO.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  baseUrl,
  containerUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";
import { startMockDownstream, type MockDownstream } from "../server/mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../server/mcp-local/local-mcp-server";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const SCRIPTS = path.join(ROOT, "deploy", "scripts");
const PORT = 5249;
const BASE = `http://127.0.0.1:${PORT}`;

const SESSION_SECRET = `bk-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const ADMIN_EMAIL = "admin@backup.test";
const ADMIN_PASSWORD = "verify-backup-secret-alpha-01";
const RIVAL_EMAIL = "admin@rival.test";
const RIVAL_PASSWORD = "verify-backup-secret-bravo-02";

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

async function call(
  p: string,
  options: { token?: string; json?: unknown; method?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const res = await fetch(`${BASE}${p}`, {
      method: options.method ?? (options.json === undefined ? "GET" : "POST"),
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { status: res.status, body: {} };
    }
  } catch (error) {
    return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

function boot(databaseUrl: string, mcpUrl: string, org: string): { child: Child; output: () => string } {
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(databaseUrl),
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: "",
      OATHRION_CONSOLE_USERS: [
        `Backup Co/${ADMIN_EMAIL}:admin:${ADMIN_PASSWORD}`,
        `Rival Co/${RIVAL_EMAIL}:admin:${RIVAL_PASSWORD}`,
      ].join(","),
      OATHRION_SEED: "",
      OATHRION_LOCAL_MCP_URL: mcpUrl,
      OATHRION_LOCAL_MCP_ORGANIZATIONS: org || "*",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as Child;
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  return { child, output: () => output };
}

async function waitReady(child: Child, timeoutMs = 40_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return `sorti avec le code ${child.exitCode}`;
    if ((await call("/api/ready")).status === 200) return "prêt";
    await sleep(250);
  }
  return "délai dépassé";
}

async function stop(child: Child): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000).then(() => child.kill("SIGKILL"))]);
}

/** Lance un des scripts de `deploy/scripts/`, en lui passant le conteneur s'il y en a un. */
function runScript(name: string, env: Record<string, string>, args: string[] = []) {
  const result = spawnSync("bash", [path.join(SCRIPTS, name), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

async function login(email: string, password: string): Promise<string> {
  const res = await call("/api/auth/login", { json: { email, password } });
  return typeof res.body.token === "string" ? res.body.token : "";
}

const refund = (amount: number) => ({
  action: "stripe.refund",
  destinationId: "local-fixture",
  agentId: "agt_backup",
  arguments: { customer: "cus_backup", amount, currency: "EUR" },
});

async function main(): Promise<number> {
  console.log("Oathrion — PREUVE SAUVEGARDE / RESTAURATION (bundle de production, PostgreSQL)");
  if (baseUrl() === "") {
    console.error("DATABASE_URL manquante. Ce script exige un PostgreSQL joignable.");
    return 2;
  }

  const container = process.env.OATHRION_PG_CONTAINER ?? "";
  const backupDir = mkdtempSync(path.join(tmpdir(), "placet-backup-"));
  let source: ThrowawayDatabase | undefined;
  let restored: ThrowawayDatabase | undefined;
  let mock: MockDownstream | undefined;
  let mcp: LocalMcpServer | undefined;
  let live: { child: Child; output: () => string } | undefined;

  try {
    source = await createThrowawayDatabase("oathrion_bk_src");
    console.log(`Base source : ${source.name} sur ${redactUrl(baseUrl())}`);
    mock = await startMockDownstream();
    mcp = await startLocalMcpServer(mock.url);

    /* ---------------------------------------------------------- 1. données */
    section("DONNÉES — un locataire réel, une action exécutée, un grant consommé");
    live = boot(source.url, mcp.url, "");
    const ready = await waitReady(live.child);
    record("le bundle démarre sur la base source", ready === "prêt", ready);
    if (ready !== "prêt") {
      console.log(live.output().slice(-2000));
      return 1;
    }

    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const rival = await login(RIVAL_EMAIL, RIVAL_PASSWORD);
    record("les deux administrateurs se connectent", admin !== "" && rival !== "");

    await call("/api/agents", {
      token: admin,
      json: {
        id: "agt_backup", name: "Agent sauvegarde", description: "Fixture",
        provider: "openai", model: "gpt-4o", status: "active", owner: "ops",
        mandate: { maxTransactionAmount: 1000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
        permissions: [], policyIds: [], tags: [],
      },
    });
    await call("/api/action-policies", {
      token: admin, method: "PUT",
      json: {
        id: "apol_backup", name: "Courant", action: "stripe.refund", destinationId: "local-fixture",
        effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100,
      },
    });
    const key = await call("/api/keys", {
      token: admin, json: { name: "Clé sauvegarde", role: "operator", agentId: "agt_backup" },
    });
    const secret = String(key.body.secret ?? "");

    const authorized = await call("/api/actions/authorize", { token: secret, json: refund(40) });
    const grantId = String(authorized.body.grantId ?? "");
    const executed = await call("/api/actions/execute", { token: secret, json: { ...refund(40), grantId } });
    const receiptId = String(executed.body.receiptId ?? "");
    record("une action est autorisée puis exécutée", executed.status === 200 && receiptId !== "", `reçu ${receiptId.slice(0, 16)}…`);

    const before = await call("/api/actions/receipts/verify", { token: admin });
    const headBefore = String(before.body.headHash ?? "");
    record("la chaîne de reçus se vérifie avant la sauvegarde", before.body.ok === true && headBefore !== "", `tête ${headBefore.slice(0, 12)}…`);

    const replay = await call("/api/actions/execute", { token: secret, json: { ...refund(40), grantId } });
    record("le grant est bien consommé avant la sauvegarde", replay.status >= 400, `rejeu ${replay.status}`);

    await stop(live.child);
    live = undefined;

    /* -------------------------------------------------------- 2. sauvegarde */
    section("SAUVEGARDE — deploy/scripts/backup.sh, tel quel");
    const scriptEnv = {
      BACKUP_DIR: backupDir,
      DATABASE_URL: container ? containerUrl(source.url) : source.url,
      ...(container ? { OATHRION_PG_CONTAINER: container } : {}),
    };

    const t0 = Date.now();
    const backup = runScript("backup.sh", scriptEnv);
    const backupMs = Date.now() - t0;
    record("le script s'exécute sans erreur", backup.status === 0, backup.out.split("\n").pop() ?? "");
    if (backup.status !== 0) {
      console.log(backup.out);
      return 1;
    }

    const dumps = readdirSync(backupDir).filter((f) => f.endsWith(".dump"));
    record("un dump et son empreinte sont écrits", dumps.length === 1 && readdirSync(backupDir).some((f) => f.endsWith(".sha256")), `${dumps.length} dump`);
    const dump = path.join(backupDir, dumps[0]!);
    record("le dump n'est lisible que par son propriétaire", (statSync(dump).mode & 0o777) === 0o600, `mode ${(statSync(dump).mode & 0o777).toString(8)}`);
    record("aucun fichier .partial ne subsiste", !readdirSync(backupDir).some((f) => f.endsWith(".partial")));

    /* --------------------------------------------------------- 3. rétention */
    section("RÉTENTION — un dump trop vieux est supprimé, les autres non");
    const stale = path.join(backupDir, "placet-19700101T000000Z.dump");
    writeFileSync(stale, "périmé");
    writeFileSync(`${stale}.sha256`, "périmé");
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(stale, old, old);
    utimesSync(`${stale}.sha256`, old, old);
    const second = runScript("backup.sh", { ...scriptEnv, RETENTION_DAYS: "14" });
    record("une seconde sauvegarde réussit", second.status === 0);
    const after = readdirSync(backupDir);
    record("le dump de 30 jours est supprimé", !after.includes(path.basename(stale)));
    record("son empreinte aussi", !after.includes(`${path.basename(stale)}.sha256`));
    record("les dumps récents survivent", after.filter((f) => f.endsWith(".dump")).length === 2, `${after.filter((f) => f.endsWith(".dump")).length} dumps`);

    /*
     * LE NOM D'AVANT LE RENOMMAGE. Les sauvegardes écrites quand le produit s'appelait
     * ARIA s'appellent `aria-*.dump`, et une rétention qui ne connaîtrait que le nom
     * courant ne les supprimerait JAMAIS : le répertoire grossirait indéfiniment, sans
     * que rien ne le signale, jusqu'au disque plein — c'est-à-dire jusqu'à une
     * sauvegarde qui échoue pour une raison sans rapport apparent.
     *
     * Trouvé en relançant ce banc après le renommage. Le même oubli dans
     * `check-backup-freshness.sh` aurait annoncé « AUCUNE SAUVEGARDE » devant un
     * répertoire plein de dumps valides.
     */
    const legacyStale = path.join(backupDir, "aria-19700101T000000Z-legacy.dump");
    writeFileSync(legacyStale, "périmé, nommé à l'ancienne");
    writeFileSync(`${legacyStale}.sha256`, "périmé");
    utimesSync(legacyStale, old, old);
    utimesSync(`${legacyStale}.sha256`, old, old);
    const third = runScript("backup.sh", { ...scriptEnv, RETENTION_DAYS: "14" });
    record("une troisième sauvegarde réussit", third.status === 0);
    const afterLegacy = readdirSync(backupDir);
    record("un dump périmé portant l'ANCIEN nom est supprimé lui aussi",
      !afterLegacy.includes(path.basename(legacyStale)),
      "sinon il s'accumule pour toujours");

    const fresh = runScript("check-backup-freshness.sh", { ...scriptEnv, MAX_AGE_HOURS: "26" });
    record("le contrôle de fraîcheur voit les dumps", fresh.status === 0, `code ${fresh.status}`);

    /* ------------------------------------------------------- 4. restauration */
    section("RESTAURATION — deploy/scripts/restore.sh dans une base neuve");
    restored = await createThrowawayDatabase("oathrion_bk_dst", process.env, { migrate: false });

    const refusal = runScript("restore.sh", {
      ...scriptEnv,
      TARGET_URL: container ? containerUrl(source.url) : source.url,
    }, [dump]);
    /*
     * La preuve montrée est la LIGNE DE REFUS, pas la première ligne de la sortie —
     * qui est la vérification d'empreinte et n'a rien à voir avec ce qui est contrôlé.
     */
    record(
      "restaurer dans une base NON vide est refusé",
      refusal.status !== 0 && /refus/i.test(refusal.out),
      refusal.out.split("\n").find((l) => /refus/i.test(l)) ?? refusal.out.split("\n")[0] ?? "",
    );

    const t1 = Date.now();
    const restore = runScript("restore.sh", {
      ...scriptEnv,
      TARGET_URL: container ? containerUrl(restored.url) : restored.url,
    }, [dump]);
    const restoreMs = Date.now() - t1;
    record("la restauration réussit", restore.status === 0, restore.out.split("\n").pop() ?? "");
    if (restore.status !== 0) {
      console.log(restore.out);
      return 1;
    }

    /* ----------------------------------------------- 5. Oathrion sur la restaurée */
    section("Oathrion SUR LA BASE RESTAURÉE — l'état d'avant, pas une base neuve");
    const t2 = Date.now();
    live = boot(restored.url, mcp.url, "");
    const readyAgain = await waitReady(live.child);
    const bootMs = Date.now() - t2;
    record("le bundle démarre sur la base restaurée", readyAgain === "prêt", readyAgain);
    if (readyAgain !== "prêt") {
      console.log(live.output().slice(-2000));
      return 1;
    }

    const adminAgain = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    record("l'administrateur se reconnecte", adminAgain !== "");

    const chain = await call("/api/actions/receipts/verify", { token: adminAgain });
    record(
      "la chaîne de reçus se vérifie, avec la MÊME tête qu'avant",
      chain.body.ok === true && chain.body.headHash === headBefore,
      `tête ${String(chain.body.headHash ?? "").slice(0, 12)}… (avant ${headBefore.slice(0, 12)}…)`,
    );

    const receipt = await call(`/api/actions/receipts/${receiptId}`, { token: adminAgain });
    record("le reçu d'avant la sauvegarde est lisible", receipt.status === 200);

    const replayAfter = await call("/api/actions/execute", { token: secret, json: { ...refund(40), grantId } });
    record(
      "un grant consommé AVANT la sauvegarde reste consommé après",
      replayAfter.status >= 400,
      `rejeu ${replayAfter.status} — une restauration ne rouvre pas le rejeu`,
    );

    const rivalAgain = await login(RIVAL_EMAIL, RIVAL_PASSWORD);
    const stolen = await call(`/api/actions/receipts/${receiptId}`, { token: rivalAgain });
    record("l'autre locataire ne lit toujours pas ce reçu", stolen.status === 404, `statut ${stolen.status}`);

    section("DURÉES — mesurées sur une base de test, ce n'est PAS un RTO");
    console.log(`  sauvegarde ${backupMs} ms · restauration ${restoreMs} ms · démarrage ${bootMs} ms`);
    console.log("  Elles croissent avec le volume. Mesurez sur une copie de votre base.");

    return 0;
  } finally {
    if (live) await stop(live.child);
    await mcp?.close();
    await mock?.close();
    await restored?.dispose();
    await source?.dispose();
    rmSync(backupDir, { recursive: true, force: true });
  }
}

/**
 * L'URL vue DEPUIS le conteneur PostgreSQL : le port publié sur l'hôte n'y existe pas,
 * le serveur écoute sur 5432 en local. C'est la seule subtilité de `pg-run.sh`, et
 * l'oublier donne un « connection refused » qui ressemble à une base éteinte.
 */
main()
  .then((code) => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${"=".repeat(74)}`);
    console.log(`${checks.length - failed.length}/${checks.length} contrôles passés`);
    console.log("=".repeat(74));
    process.exit(code === 0 && failed.length === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
