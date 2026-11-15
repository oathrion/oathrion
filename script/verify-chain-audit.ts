/**
 * `audit:chains` DÉTECTE-T-IL VRAIMENT UNE CHAÎNE ROMPUE ?
 *
 *   DATABASE_URL=postgres://… npm run verify:chain-audit
 *
 * ## Le trou que ce banc comble
 *
 * `audit:chains` est l'outil qu'un exploitant lance quand il veut savoir si ses reçus ont
 * été touchés. C'est la dernière ligne de défense de l'auditabilité — et **rien dans ce
 * dépôt ne l'exerçait**.
 *
 * Ce n'était pas un oubli, c'était structurel : tous les bancs qui produisent des reçus
 * (`verify:soak`, `verify:mcp`, `e2e`) montent une base JETABLE et la détruisent en
 * partant. Lancé sur n'importe quelle base disponible, `audit:chains` répondait donc
 * « Aucun reçu dans ce déploiement : rien à vérifier. Une chaîne vide est valide. » —
 * honnêtement, mais sans rien prouver.
 *
 * ## Et vérifier qu'il dit « valide » ne suffit pas
 *
 * Un vérificateur qui rend toujours « valide » passe ce test-là. C'est exactement la
 * logique des mutants employée partout ailleurs dans ce dépôt : une propriété n'est tenue
 * que si sa rupture délibérée est DÉTECTÉE.
 *
 * Ce banc casse donc la chaîne de deux façons distinctes, parce qu'elles empruntent deux
 * branches différentes du vérificateur :
 *
 *   · **le contenu d'un reçu change** — un `UPDATE` sur une colonne couverte par
 *     l'empreinte. C'est la falsification de quelqu'un qui veut réécrire l'histoire.
 *   · **un reçu disparaît** — un `DELETE` au milieu. C'est la falsification de quelqu'un
 *     qui veut faire disparaître une action.
 *
 * Et après chaque rupture, le contenu est RESTAURÉ et la chaîne doit revérifier : sans
 * cela, un détecteur bloqué en position « rompue » passerait aussi.
 *
 * ## Ce que ce banc n'établit pas
 *
 * Que la chaîne résiste à un attaquant qui aurait les clés pour la réécrire ENTIÈREMENT
 * et de façon cohérente. Une chaîne d'empreintes stockée dans la base qu'elle protège
 * détecte une altération PARTIELLE ; elle ne remplace pas un stockage externe en écriture
 * seule. `docs/limitations.md` le dit déjà, et ce banc ne prétend pas le contredire.
 */

import { Pool } from "pg";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { createThrowawayDatabase, productionPostgresEnv } from "./lib/throwaway-postgres";
import { startMockDownstream } from "../server/mcp-local/mock-downstream";
import { startLocalMcpServer } from "../server/mcp-local/local-mcp-server";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5313;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const DEST = "local-fixture";
const EMAIL = "chaine@placet.test";
const PASSWORD = `chaine-${Math.random().toString(36).slice(2)}-0123456789`;
const RECEIPTS = 10;

type Child = ChildProcessByStdio<null, Readable, Readable>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function call(p: string, o: { token?: string; json?: unknown; method?: string } = {}) {
  try {
    const res = await fetch(`${BASE}${p}`, {
      method: o.method ?? (o.json === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      },
      body: o.json === undefined ? undefined : JSON.stringify(o.json),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text.slice(0, 200) }; }
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: { error: String(error) } };
  }
}

/** Lance `audit:chains` sur cette base et rend son verdict. */
function audit(url: string): { code: number; out: string } {
  const run = spawnSync("npx", ["tsx", path.join(ROOT, "script", "audit-chains.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: url },
  });
  return { code: run.status ?? -1, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

async function main(): Promise<number> {
  console.log("\n" + "=".repeat(78));
  console.log("Oathrion — L'AUDIT DE CHAÎNE DÉTECTE-T-IL UNE FALSIFICATION ?");
  console.log("=".repeat(78) + "\n");

  const mock = await startMockDownstream();
  const tools = await startLocalMcpServer(mock.url);
  const db = await createThrowawayDatabase("oathrion_chaine");
  let child: Child | undefined;
  let pool: Pool | undefined;

  try {
    child = spawn("node", [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...productionPostgresEnv(db.url),
        OATHRION_DB: undefined,
        PORT: String(PORT),
        OATHRION_SESSION_SECRET: `chaine-${Math.random().toString(36).slice(2)}-0123456789012`,
        OATHRION_API_KEYS: "",
        OATHRION_CONSOLE_USERS: `${EMAIL}:admin:${PASSWORD}`,
        OATHRION_SEED: "",
        OATHRION_LOCAL_MCP_URL: tools.url,
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
        RATE_LIMIT_DECISION: "100000",
        RATE_LIMIT_WRITE: "100000",
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    let log = "";
    child.stdout.on("data", (c: Buffer) => (log += c.toString()));
    child.stderr.on("data", (c: Buffer) => (log += c.toString()));

    let ready = false;
    for (let i = 0; i < 160 && !ready; i += 1) {
      if (child.exitCode !== null) break;
      ready = (await call("/api/ready")).status === 200;
      if (!ready) await sleep(400);
    }
    record("le bundle démarre sur PostgreSQL", ready);
    if (!ready) { console.log(log.slice(-1500)); return 2; }

    /* --------------------------------------- 1. UNE VRAIE CHAÎNE, PAR L'API */
    const admin = String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
    await call("/api/agents", { token: admin, json: {
      id: "agt_chaine", name: "Agent de chaîne", description: "banc d'audit", provider: "openai",
      model: "gpt-4o", status: "active", owner: "ops",
      mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
      permissions: [{ scope: "execute:payments", label: "Rembourser", description: "Sous mandat.", granted: true, risk: "high" }],
      policyIds: [], tags: [] } });
    await call("/api/action-policies", { token: admin, method: "PUT", json: {
      id: "apol_chaine", name: "courant", action: "stripe.refund", destinationId: DEST,
      effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 } });
    const key = await call("/api/keys", { token: admin, json: { name: "clé chaîne", role: "operator", agentId: "agt_chaine" } });
    const agentKey = String(key.body.secret ?? "");
    record("agent, règle et credential en place", agentKey !== "");
    if (agentKey === "") return 2;

    /*
     * Les reçus sont produits par la VRAIE voie — autoriser puis exécuter — et non par un
     * `INSERT`. Une chaîne fabriquée à la main prouverait que le vérificateur sait lire
     * ce que le banc sait écrire, ce qui n'est pas la question.
     */
    let produced = 0;
    for (let i = 0; i < RECEIPTS; i += 1) {
      const intent = {
        action: "stripe.refund",
        destinationId: DEST,
        arguments: { customer: `cus_${String(i)}`, amount: 10 + i, currency: "EUR" },
      };
      const decision = await call("/api/actions/authorize", { token: agentKey, json: intent });
      if (decision.body.decision !== "ALLOW") continue;
      const run = await call("/api/actions/execute", {
        token: agentKey, json: { ...intent, grantId: String(decision.body.grantId ?? "") },
      });
      if (run.status === 200) produced += 1;
    }
    record(`${String(produced)} reçus écrits par la voie réelle`, produced >= RECEIPTS, `${String(produced)}/${String(RECEIPTS)}`);
    if (produced < RECEIPTS) return 2;

    /* --------------------------------------------- 2. LA CHAÎNE INTACTE */
    const intact = audit(db.url);
    record(
      "une chaîne intacte est déclarée vérifiée, et la sortie vaut 0",
      intact.code === 0 && /chaînes vérifiées/.test(intact.out) && !/ROMPUE/.test(intact.out),
      `code ${String(intact.code)}`,
    );

    pool = new Pool({ connectionString: db.url, max: 2 });

    /* ------------------------- 3. LE CONTENU D'UN REÇU CHANGE */
    const cible = await pool.query<{ receipt_id: string; result_summary: string }>(
      "SELECT receipt_id, result_summary FROM action_receipts ORDER BY entry_seq OFFSET 4 LIMIT 1",
    );
    const receiptId = cible.rows[0]?.receipt_id ?? "";
    const resumeOriginal = cible.rows[0]?.result_summary ?? "";
    record("un reçu du milieu est identifié", receiptId !== "", receiptId.slice(0, 18) + "…");

    await pool.query("UPDATE action_receipts SET result_summary = $1 WHERE receipt_id = $2", [
      "resume altere apres coup", receiptId,
    ]);
    const altere = audit(db.url);
    record(
      "un CONTENU modifié est DÉTECTÉ, et la sortie ne vaut plus 0",
      altere.code !== 0 && /ROMPUE/.test(altere.out),
      `code ${String(altere.code)}`,
    );
    record(
      "le message nomme le reçu fautif et ce qui lui est arrivé",
      altere.out.includes(receiptId) && /contenu/.test(altere.out),
      (/ROMPUE[^\n]*/.exec(altere.out)?.[0] ?? "").slice(0, 96),
    );

    /* --------------------- 4. RESTAURÉ : LA CHAÎNE DOIT REVÉRIFIER */
    await pool.query("UPDATE action_receipts SET result_summary = $1 WHERE receipt_id = $2", [
      resumeOriginal, receiptId,
    ]);
    const restaure = audit(db.url);
    /*
     * LE CONTRÔLE QUI EMPÊCHE LE DÉTECTEUR BLOQUÉ. Sans lui, un vérificateur qui rend
     * TOUJOURS « rompue » passerait les deux contrôles précédents.
     */
    record(
      "le contenu restauré fait revérifier la chaîne — le détecteur n'est pas bloqué",
      restaure.code === 0 && !/ROMPUE/.test(restaure.out),
      `code ${String(restaure.code)}`,
    );

    /* ------------------------------- 5. UN REÇU DISPARAÎT */
    const supprime = await pool.query<{ receipt_id: string }>(
      "SELECT receipt_id FROM action_receipts ORDER BY entry_seq OFFSET 6 LIMIT 1",
    );
    await pool.query("DELETE FROM action_receipts WHERE receipt_id = $1", [
      supprime.rows[0]?.receipt_id ?? "",
    ]);
    const retire = audit(db.url);
    record(
      "un reçu RETIRÉ est DÉTECTÉ — l'autre branche du vérificateur",
      retire.code !== 0 && /ROMPUE/.test(retire.out),
      `code ${String(retire.code)}`,
    );
    record(
      "le message distingue un retrait d'une altération de contenu",
      /position|retiré|inséré|déplacé/.test(retire.out),
      (/ROMPUE[^\n]*/.exec(retire.out)?.[0] ?? "").slice(0, 96),
    );

    /* ------------------------------------------------- LE VERDICT */
    const failed = checks.filter((c) => !c.ok).length;
    console.log("\n" + "=".repeat(78));
    console.log(`${String(checks.length - failed)}/${String(checks.length)} contrôles passés`);
    if (failed === 0) {
      console.log("");
      console.log("  L'audit de chaîne distingue une chaîne intacte d'une chaîne touchée,");
      console.log("  nomme le reçu fautif, et dit laquelle des deux falsifications a eu lieu.");
    }
    console.log("=".repeat(78) + "\n");
    return failed === 0 ? 0 : 1;
  } finally {
    child?.kill("SIGTERM");
    await sleep(800);
    await pool?.end().catch(() => undefined);
    await mock.close().catch(() => undefined);
    await tools.close().catch(() => undefined);
    await db.dispose().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
