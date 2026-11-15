/**
 * PRODUCTION CONFIGURATION GATE — proved on the real process, not on a pure function.
 *
 * `database-config.test.ts` proves the resolver refuses. That does not prove the
 * shipped bundle REFUSES TO START. This script boots `dist/index.cjs` with
 * NODE_ENV=production and one dangerous setting at a time — every other setting valid,
 * so a refusal can only come from the setting under test — and asserts:
 *
 *   - the process exits non-zero, without ever answering HTTP;
 *   - its output names the reason (the expected variable / phrase);
 *   - no SQLite file appears in its working directory.
 *
 * Then a POSITIVE CONTROL: the complete production configuration boots, answers
 * /api/ready with 200, and still creates no SQLite file. A gate that refused
 * everything would prove nothing.
 *
 * Exit codes: 0 all cases behaved · 1 a case did not · 2 setup impossible.
 *
 *   npm run build
 *   DATABASE_URL=postgres://user:pass@host:5432/postgres npm run verify:prod-config
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { baseUrl, createThrowawayDatabase, productionPostgresEnv, redactUrl } from "./lib/throwaway-postgres";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5241;

/** Tenant whose ceiling is seeded in the database for the conflict case (chantier 1). */
const CONFLICT_ORG = "org_cfg_conflict";

const VALID_SECRETS = {
  OATHRION_SESSION_SECRET: `cfg-${Math.random().toString(36).slice(2)}-0123456789abcdef`,
  OATHRION_API_KEYS: `Gate Probe:admin:cfg-${Math.random().toString(36).slice(2)}-key-0123456789`,
  OATHRION_CONSOLE_USERS: "",
  OATHRION_SEED: "",
  PORT: String(PORT),
};

interface Case {
  name: string;
  env: Record<string, string | undefined>;
  /** Regex the process output must match: the refusal names its reason. */
  reason: RegExp;
}

/*
 * Every case runs from the install directory (the identity worker resolves `pg` from
 * there, exactly as in a real deployment). A SQLite file appearing in that directory
 * during the case is a failure; one already present before the run is refused up front
 * so it cannot mask a new one.
 */
function sqliteFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /\.(db|sqlite|sqlite3)(-wal|-shm)?$/.test(f));
}

async function runRefusal(c: Case, base: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  const cwd = ROOT;
  {
    const env: Record<string, string | undefined> = { ...process.env, ...base, ...VALID_SECRETS, OATHRION_DB: undefined, ...c.env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const child = spawn("node", [BUNDLE], { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    let answered = false;
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(async () => {
        answered = await fetch(`http://127.0.0.1:${PORT}/api/live`).then(() => true, () => false);
        child.kill("SIGKILL");
        resolve(null);
      }, 20_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const files = sqliteFiles(cwd);
    const named = c.reason.test(out);
    const ok = exit !== null && exit !== 0 && !answered && named && files.length === 0;
    const detail =
      `exit=${exit}${answered ? " ANSWERED-HTTP" : ""}${named ? "" : " REASON-NOT-NAMED"}` +
      `${files.length ? ` SQLITE:${files.join(",")}` : ""}`;
    if (!ok) console.log(out.split("\n").slice(-12).join("\n"));
    return { ok, detail };
  }
}

async function runPositive(
  base: Record<string, string>,
  cwd: string = ROOT,
): Promise<{ ok: boolean; detail: string }> {
  const env: Record<string, string | undefined> = { ...process.env, ...base, ...VALID_SECRETS, OATHRION_DB: undefined };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const child = spawn("node", [BUNDLE], { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  try {
    const deadline = Date.now() + 40_000;
    let status = 0;
    while (Date.now() < deadline && child.exitCode === null) {
      status = await fetch(`http://127.0.0.1:${PORT}/api/ready`).then((r) => r.status, () => 0);
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const files = sqliteFiles(cwd);
    const ok = status === 200 && files.length === 0;
    if (!ok) console.log(out.split("\n").slice(-20).join("\n"));
    return { ok, detail: `ready=${status}${files.length ? ` SQLITE:${files.join(",")}` : " no sqlite file"}` };
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.on("exit", r));
      child.kill("SIGTERM");
      await exited;
    }
  }
}

async function main(): Promise<number> {
  console.log("=".repeat(78));
  console.log("Oathrion — PRODUCTION CONFIGURATION GATE (real bundle, one dangerous setting at a time)");
  console.log("=".repeat(78));
  if (!existsSync(BUNDLE)) {
    console.error("No bundle at dist/index.cjs. Run `npm run build` first.");
    return 2;
  }
  if (sqliteFiles(ROOT).length > 0) {
    console.error(`SQLite files already present in ${ROOT}: ${sqliteFiles(ROOT).join(", ")}. Move them aside first.`);
    return 2;
  }
  let db;
  try {
    db = await createThrowawayDatabase("oathrion_cfg");
    console.log(`Database: ${db.name} on ${redactUrl(baseUrl())}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const base = productionPostgresEnv(db.url);

  /*
   * Seeded directly, as `setOrganizationQuota` would have stored it after an API call:
   * this gate tests the BOOT's reaction to the state, not the write path (that is
   * tenant-quota-config.test.ts).
   */
  {
    const seed = new Pool({ connectionString: db.url, max: 1 });
    try {
      await seed.query(
        `INSERT INTO organization_quotas (organization_id, counter, ceiling, source, updated_at)
         VALUES ($1, 'agents', 99, 'api', now())`,
        [CONFLICT_ORG],
      );
    } finally {
      await seed.end();
    }
  }

  const cases: Case[] = [
    { name: "production without DATABASE_DRIVER", env: { DATABASE_DRIVER: undefined }, reason: /SQLite|DATABASE_DRIVER/ },
    { name: "DATABASE_DRIVER=sqlite", env: { DATABASE_DRIVER: "sqlite" }, reason: /SQLite|sqlite/ },
    ...["true", "1", "TRUE", "yes"].map((v) => ({
      name: `OATHRION_ALLOW_SQLITE_IN_PRODUCTION=${v} (inert opt-in)`,
      env: { DATABASE_DRIVER: "sqlite", OATHRION_ALLOW_SQLITE_IN_PRODUCTION: v },
      reason: /SQLite|sqlite/,
    })),
    { name: "postgres without DATABASE_URL", env: { DATABASE_URL: undefined }, reason: /DATABASE_URL/ },
    { name: "DATABASE_URL that is not PostgreSQL", env: { DATABASE_URL: "mysql://u:p@h/db" }, reason: /DATABASE_URL/ },
    { name: "DATABASE_DRIVER=mysql (unknown)", env: { DATABASE_DRIVER: "mysql" }, reason: /mysql|not a database Oathrion supports/ },
    { name: "OATHRION_IDENTITY_PLANE=sqlite", env: { OATHRION_IDENTITY_PLANE: "sqlite" }, reason: /IDENTITY_PLANE/ },
    { name: "OATHRION_IDENTITY_PLANE absent", env: { OATHRION_IDENTITY_PLANE: undefined }, reason: /IDENTITY PLANE|IDENTITY_PLANE/ },
    { name: "OATHRION_ACTION_AUTHORITY_DRIVER absent", env: { OATHRION_ACTION_AUTHORITY_DRIVER: undefined }, reason: /ACTION_AUTHORITY_DRIVER/ },
    { name: "OATHRION_ACTION_AUTHORITY_DRIVER=sqlite", env: { OATHRION_ACTION_AUTHORITY_DRIVER: "sqlite" }, reason: /ACTION_AUTHORITY_DRIVER/ },
    { name: "RATE_LIMIT_STORE=memory", env: { RATE_LIMIT_STORE: "memory" }, reason: /RATE_LIMIT_STORE/ },
    { name: "RATE_LIMIT_STORE absent", env: { RATE_LIMIT_STORE: undefined }, reason: /RATE_LIMIT_STORE/ },
    { name: "OATHRION_SESSION_SECRET absent", env: { OATHRION_SESSION_SECRET: undefined }, reason: /OATHRION_SESSION_SECRET/ },
    { name: "OATHRION_SESSION_SECRET is a demo value", env: { OATHRION_SESSION_SECRET: "changeme" }, reason: /OATHRION_SESSION_SECRET/ },
    { name: "OATHRION_API_KEYS with a weak secret", env: { OATHRION_API_KEYS: "Bot:admin:password" }, reason: /OATHRION_API_KEYS|secret|password/i },
    { name: "RATE_LIMIT_FAIL_MODE typo", env: { RATE_LIMIT_FAIL_MODE: "opn" }, reason: /RATE_LIMIT_FAIL_MODE/ },
    { name: "OATHRION_UNDECLARED_ACTION typo", env: { OATHRION_UNDECLARED_ACTION: "alow" }, reason: /OATHRION_UNDECLARED_ACTION/ },
    {
      name: "OATHRION_DESTINATIONS entry without tenant scope (multi-tenant)",
      env: {
        OATHRION_DESTINATIONS: JSON.stringify([{ id: "shared-erp", url: "https://mcp.erp.example.com" }]),
        OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.erp.example.com",
      },
      reason: /does not declare "organizations"/,
    },
    /*
     * Chantier 1 — per-tenant quota ceilings. The first case was already refused by
     * `config-check` but never proved on the bundle; the second is new: a database
     * ceiling seeded below (as the application would write it) that OATHRION_QUOTAS
     * contradicts. Both are refusals with the tenant, the counter and both values named.
     */
    { name: "OATHRION_QUOTAS with an invalid ceiling", env: { OATHRION_QUOTAS: "org_cfg_quota:agents=-1" }, reason: /OATHRION_QUOTAS/ },
    {
      name: "OATHRION_QUOTAS contradicts the tenant ceiling stored in the database",
      env: { OATHRION_QUOTAS: `${CONFLICT_ORG}:agents=12` },
      reason: new RegExp(`OATHRION_QUOTAS sets ${CONFLICT_ORG}:agents=12, but the database holds 99`),
    },
    /*
     * Chantier 1, point 5 — les deux chemins à l'échelle du DÉPLOIEMENT, refusés en
     * production. Ni l'un ni l'autre ne peut porter une portée par locataire : sur une
     * instance partagée, l'action autorisée d'un tenant partirait vers un service aval
     * qui détient les credentials d'un autre. Le rapport de la Phase 13 les signalait
     * déjà (§9) sans que le code les empêche.
     */
    {
      name: "OATHRION_MCP_DOWNSTREAM_URL — destination de repli du déploiement entier",
      env: {
        OATHRION_MCP_DOWNSTREAM_URL: "https://mcp.shared.example.com",
        OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.shared.example.com",
      },
      reason: /OATHRION_MCP_DOWNSTREAM_URL is set, and in production it is refused/,
    },
    {
      name: "OATHRION_LOCAL_MCP_URL sans portée déclarée (local-fixture partagée implicitement)",
      env: { OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/" },
      reason: /OATHRION_LOCAL_MCP_ORGANIZATIONS[\s\S]*does not declare "organizations"/,
    },
    {
      name: "OATHRION_LOCAL_MCP_ORGANIZATIONS nommant autre chose qu'un identifiant",
      env: {
        OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "acme",
      },
      reason: /which is not an organization id/,
    },
    /*
     * LE REGISTRE D'OUTILS DÉCLARÉ. Une faute dans `OATHRION_TOOLS` doit arrêter le
     * BUNDLE LIVRÉ, pas seulement échouer dans un test unitaire : c'est le seul endroit
     * où la différence se voit, et c'est la leçon de `RATE_LIMIT_FAIL_MODE=opn`, qui
     * démarrait et ne se révélait qu'à la première requête d'un client.
     */
    {
      name: "OATHRION_TOOLS visant une destination qui n'existe pas (faute de frappe)",
      env: {
        OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
        OATHRION_LOCAL_MCP_ORGANIZATIONS: CONFLICT_ORG,
        OATHRION_TOOLS: JSON.stringify([
          {
            id: "acme_refund",
            destination: "local-fixtur",
            tool: "refunds.create",
            actions: ["refund"],
            arguments: { customer: "target" },
          },
        ]),
      },
      reason: /destination "local-fixtur", which is not registered/,
    },
    {
      /*
       * Un verbe qu'une déclaration inventerait contournerait la portée de permission,
       * le plafond de mandat et l'allowlist de domaine — tout ce que l'entrée du
       * catalogue fait appliquer. Refusé au démarrage, comme pour un outil intégré.
       */
      name: "OATHRION_TOOLS revendiquant un verbe absent du catalogue d'actions",
      env: {
        OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
        OATHRION_LOCAL_MCP_ORGANIZATIONS: CONFLICT_ORG,
        OATHRION_TOOLS: JSON.stringify([
          {
            id: "acme_wire",
            destination: "local-fixture",
            tool: "wires.send",
            actions: ["wire_transfer_anywhere"],
            arguments: { customer: "target" },
          },
        ]),
      },
      reason: /not declared in shared\/policy\/actions\.ts/,
    },
    {
      name: "OATHRION_TOOLS projetant un champ de contexte qui n'existe pas",
      env: {
        OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
        OATHRION_LOCAL_MCP_ORGANIZATIONS: CONFLICT_ORG,
        OATHRION_TOOLS: JSON.stringify([
          {
            id: "acme_refund",
            destination: "local-fixture",
            tool: "refunds.create",
            actions: ["refund"],
            arguments: { amount: "metadta.amount" },
          },
        ]),
      },
      reason: /which is not a context field/,
    },
    /*
     * Étape 2 du pilote — les plafonds du limiteur sont configurables, donc leur
     * validation doit refuser au DÉMARRAGE. C'est le défaut D3 de la Phase 13
     * (`RATE_LIMIT_FAIL_MODE=opn`) appliqué aux nouvelles variables : une valeur mal
     * écrite qui retomberait sur le défaut ferait croire à un réglage inexistant.
     */
    { name: "RATE_LIMIT_DECISION non numérique", env: { RATE_LIMIT_DECISION: "beaucoup" }, reason: /RATE_LIMIT_DECISION/ },
    { name: "RATE_LIMIT_WRITE à zéro", env: { RATE_LIMIT_WRITE: "0" }, reason: /RATE_LIMIT_WRITE[\s\S]*bornes/ },
    { name: "RATE_LIMIT_WINDOW_MS sous la seconde (unité confondue)", env: { RATE_LIMIT_WINDOW_MS: "60" }, reason: /RATE_LIMIT_WINDOW_MS[\s\S]*bornes/ },
    /*
     * ÉTAPE 7 — le jeton de la page de métriques. Refusé seulement s'il est POSÉ : ne pas
     * superviser est une décision d'exploitant, et le contrôle positif ci-dessous vérifie
     * qu'une variable ABSENTE démarre bien.
     *
     * Un jeton court n'est pas une protection faible mais une protection qui en a l'air :
     * l'exploitant qui l'a posé croit sa page fermée, et c'est cette croyance qui est
     * dangereuse — plus que la page ouverte, qu'il sait ouverte.
     */
    { name: "OATHRION_METRICS_TOKEN trop court (protection qui en a l'air)", env: { OATHRION_METRICS_TOKEN: "court" }, reason: /OATHRION_METRICS_TOKEN[\s\S]*32/ },
    { name: "OATHRION_METRICS_TOKEN à la limite basse (31 caractères)", env: { OATHRION_METRICS_TOKEN: "a".repeat(31) }, reason: /OATHRION_METRICS_TOKEN/ },
    { name: "OATHRION_METRICS_TOKEN recopié de la documentation", env: { OATHRION_METRICS_TOKEN: "changeme-et-assez-long-pour-passer-la-longueur" }, reason: /OATHRION_METRICS_TOKEN[\s\S]*exemple/ },
    {
      name: "PostgreSQL unreachable at boot",
      env: { DATABASE_URL: "postgres://placet:wrong@127.0.0.1:1/placet" },
      reason: /ECONNREFUSED|could not connect|unreachable|password authentication failed/i,
    },
  ];

  let failures = 0;
  for (const c of cases) {
    const r = await runRefusal(c, base);
    if (!r.ok) failures++;
    console.log(`  ${r.ok ? "✓" : "✗"} REFUSED: ${c.name} — ${r.detail}`);
  }
  const positive = await runPositive(base);
  if (!positive.ok) failures++;
  console.log(`  ${positive.ok ? "✓" : "✗"} STARTS: complete production configuration — ${positive.detail}`);

  /*
   * Second positive control: the same configuration started from an unrelated working
   * directory (systemd without WorkingDirectory, an orchestrator entrypoint). Before
   * Phase 13 this refused to start, because the identity worker and `pg` were resolved
   * from the working directory only.
   */
  const foreign = mkdtempSync(path.join(tmpdir(), "placet-cfg-cwd-"));
  const elsewhere = await runPositive(base, foreign);
  rmSync(foreign, { recursive: true, force: true });
  if (!elsewhere.ok) failures++;
  console.log(`  ${elsewhere.ok ? "✓" : "✗"} STARTS: same configuration from a foreign working directory — ${elsewhere.detail}`);

  /*
   * Third positive control (chantier 1): OATHRION_QUOTAS that AGREES with the database —
   * the state of every deployment after its first boot under this version — starts.
   * Without it, the conflict refusal above could be a refusal of any OATHRION_QUOTAS at all.
   */
  const agreeing = await runPositive({ ...base, OATHRION_QUOTAS: `${CONFLICT_ORG}:agents=99` });
  if (!agreeing.ok) failures++;
  console.log(`  ${agreeing.ok ? "✓" : "✗"} STARTS: OATHRION_QUOTAS that agrees with the database — ${agreeing.detail}`);

  /*
   * Quatrième contrôle positif (point 5) : la fixture loopback EXPLICITEMENT cadrée
   * démarre. Sans lui, les deux refus ci-dessus pourraient être un refus de
   * `OATHRION_LOCAL_MCP_URL` tout court — ce qui supprimerait la seule façon de faire tourner
   * le bundle de production contre un service MCP local, et casserait `e2e:multitenant`
   * sans que ce banc le dise.
   */
  const scopedFixture = await runPositive({
    ...base,
    OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
    OATHRION_LOCAL_MCP_ORGANIZATIONS: CONFLICT_ORG,
  });
  if (!scopedFixture.ok) failures++;
  console.log(`  ${scopedFixture.ok ? "✓" : "✗"} STARTS: OATHRION_LOCAL_MCP_URL scoped to a named tenant — ${scopedFixture.detail}`);

  /*
   * Contrôle positif du registre déclaré. Sans lui, les trois refus ci-dessus
   * pourraient être un refus de TOUTE déclaration — ce qui rendrait `OATHRION_TOOLS`
   * inutilisable sans que ce banc le dise.
   */
  const declaredTool = await runPositive({
    ...base,
    OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
    OATHRION_LOCAL_MCP_ORGANIZATIONS: CONFLICT_ORG,
    OATHRION_TOOLS: JSON.stringify([
      {
        id: "acme_refund",
        label: "Acme refunds",
        destination: "local-fixture",
        tool: "refunds.create",
        actions: ["refund"],
        arguments: { customer: "target", amount: "metadata.amount", currency: "currency" },
      },
    ]),
  });
  if (!declaredTool.ok) failures++;
  console.log(`  ${declaredTool.ok ? "✓" : "✗"} STARTS: OATHRION_TOOLS déclarant un outil cohérent — ${declaredTool.detail}`);

  /*
   * Cinquième contrôle positif (étape 2) : des plafonds VALIDES démarrent. Sans lui, les
   * trois refus ci-dessus pourraient être un refus de toute configuration de limiteur,
   * ce qui rendrait la fonctionnalité inutilisable sans que ce banc le dise.
   */
  const tunedLimits = await runPositive({
    ...base,
    RATE_LIMIT_DECISION: "600",
    RATE_LIMIT_WRITE: "120",
    RATE_LIMIT_WINDOW_MS: "30000",
  });
  if (!tunedLimits.ok) failures++;
  console.log(`  ${tunedLimits.ok ? "✓" : "✗"} STARTS: plafonds de limiteur ajustés — ${tunedLimits.detail}`);

  /*
   * Sixième et septième contrôles positifs (étape 7). Les trois refus de
   * `OATHRION_METRICS_TOKEN` ci-dessus pourraient aussi bien être un refus de la variable
   * elle-même, ou — à l'inverse — un refus de son absence. Les deux seraient graves et
   * de sens opposé : le premier rendrait la supervision impossible, le second ferait de
   * la page de métriques un prérequis de fonctionnement. Il faut donc les deux bornes.
   */
  /*
   * Le cas « variable ABSENTE démarre » n'a pas de contrôle à lui : `base` ne porte pas
   * `OATHRION_METRICS_TOKEN`, donc le tout premier contrôle positif de ce banc — « complete
   * production configuration » — est déjà exactement ce cas. En ajouter un second,
   * identique, aurait allongé le compte sans rien éprouver de plus, et un banc dont les
   * lignes ne mesurent pas toutes quelque chose est un banc qu'on cesse de lire.
   */
  const withMetrics = await runPositive({ ...base, OATHRION_METRICS_TOKEN: `scrape-${"b".repeat(40)}` });
  if (!withMetrics.ok) failures++;
  console.log(`  ${withMetrics.ok ? "✓" : "✗"} STARTS: OATHRION_METRICS_TOKEN conforme — ${withMetrics.detail}`);

  await db.dispose();
  const total = cases.length + 5;
  console.log("\n" + "=".repeat(78));
  console.log(`${total - failures}/${total} configurations behaved as required`);
  console.log("=".repeat(78));
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
