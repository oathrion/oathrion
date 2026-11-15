#!/usr/bin/env node
/**
 * Endurance du PIVOT LOCAL (`oathrion wrap`), sur la durée : le serveur d'équipe a tenu 12 h
 * (STRESS-TEST-LOG §5.36) ; le pivot, qui sert `npx oathrion`, ne l'a pas encore fait.
 *
 *   npm run build
 *   node script/endurance-pivot.mjs --minutes 720 [--par-seconde 5] [--sortie <dossier>]
 *
 * La vraie commande compilée devant le faux serveur du dépôt, dans un dossier jetable, sans
 * notification de bureau. En boucle, à un rythme d'agent intense (5 appels par seconde par
 * défaut ; un agent réel attend son modèle entre deux appels) :
 *   · des lectures (elles passent) ;
 *   · une écriture sur dix, posée DANS le client et acceptée (case cochée) ;
 *   · une écriture sur cinquante, retenue puis approuvée dans la console (API) ;
 *   · toutes les 5 minutes, l'écran « Serveurs » et un relevé : mémoire du pivot (VmRSS),
 *     descripteurs, latences p50/p95/p99 de la période.
 * À la fin : `oathrion receipts verify`, et un verdict par contrôle. Les relevés vont dans
 * `<sortie>/releves.csv`, le verdict dans `<sortie>/verdict.txt`. Rien ne sort de la machine.
 *
 * Code de sortie : 0 si tous les contrôles passent.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "oathrion.mjs");
const FAKE = join(ROOT, "server", "test", "fixtures", "fake-stdio-mcp-server.cjs");
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const MINUTES = Number(arg("--minutes", "10"));
const OUT = arg("--sortie", mkdtempSync(join(tmpdir(), "oathrion-endurance-")));
const SAMPLE_MS = Number(arg("--releve-secondes", "300")) * 1_000;
const PACE_MS = 1_000 / Number(arg("--par-seconde", "5"));
mkdirSync(OUT, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "oathrion-endurance-home-"));
const env = { PATH: process.env.PATH ?? "", HOME: home, OATHRION_WRAP_HOME: home, OATHRION_LOCAL_NOTIFY_DESKTOP: "0", OATHRION_CONSOLE_LIEN: "1" };
const now = () => performance.now();
const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/* Le client : la vraie commande, à qui l'on parle en stdio ; il accepte les questions (case cochée). */
const client = spawn(process.execPath, [CLI, "wrap", "--name", "carnet", "--attendre", "30", "--", process.execPath, FAKE], { env, stdio: ["pipe", "pipe", "pipe"] });
let relayLog = "";
client.stderr.on("data", (c) => (relayLog = (relayLog + c).slice(-20_000)));
const waiting = new Map();
let next = 1;
let askInClient = true;
createInterface({ input: client.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "elicitation/create") {
    const content = askInClient ? { action: "accept", content: { confirmer: true } } : { action: "cancel" };
    client.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: content })}\n`);
    return;
  }
  if (message.method === undefined) waiting.get(message.id)?.(message);
});
const ask = (method, params = {}) =>
  new Promise((done) => {
    const id = next++;
    waiting.set(id, (m) => {
      waiting.delete(id);
      done(m);
    });
    client.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const hubPid = () =>
  readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .find((pid) => {
      try {
        return readlinkSync(`/proc/${String(pid)}/cwd`) === join(home, "_local") && readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").includes("oathrion-local.cjs");
      } catch {
        return false;
      }
    });
const rssMb = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${String(pid)}/status`, "utf8"))?.[1] ?? 0) / 1024;
const fds = (pid) => readdirSync(`/proc/${String(pid)}/fd`).length;

/* Une session de console, renouvelée au besoin (elle dure 12 h). */
let session = null;
async function console_() {
  if (session && Date.now() - session.at < 6 * 3_600_000) return session;
  const run = spawnSync(process.execPath, [CLI, "console", "--sans-navigateur"], { env, encoding: "utf8", timeout: 60_000 });
  const link = /http:\S+ticket=\S+/.exec(run.stdout)?.[0];
  const base = link.split("/console")[0];
  const { token } = await (await fetch(`${base}/api/local/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: new URLSearchParams(link.split("?")[1]).get("ticket") }) })).json();
  session = { base, token, at: Date.now() };
  return session;
}

const counts = { reads: 0, inClient: 0, inConsole: 0, errors: 0 };
const errors = [];
let period = [];
const csv = join(OUT, "releves.csv");
writeFileSync(csv, "minutes,rss_mo,fds,appels,erreurs,p50_ms,p95_ms,p99_ms,actions_ecran\n");
const samples = [];

const fail = (what) => {
  counts.errors += 1;
  if (errors.length < 20) errors.push(`${new Date().toISOString()} ${what}`);
};

await ask("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "claude-code", title: "Claude Code", version: "endurance" } });
const pid = hubPid();
if (!pid) throw new Error("pivot introuvable");
const start = Date.now();
const end = start + MINUTES * 60_000;
let lastSample = start;
let i = 0;
console.log(`endurance du pivot : ${String(MINUTES)} min, pivot ${String(pid)}, relevés dans ${OUT}`);

while (Date.now() < end) {
  i += 1;
  const t = now();
  try {
    if (i % 50 === 0) {
      /* Retenue, puis approuvée dans la console. */
      askInClient = false;
      const { base, token } = await console_();
      const before = new Set((await (await fetch(`${base}/api/approvals`, { headers: { authorization: `Bearer ${token}` } })).json()).map((a) => a.id));
      const answered = ask("tools/call", { name: "create_note", arguments: { text: `console ${String(i)}` } });
      let id;
      for (let tries = 0; tries < 200 && !id; tries += 1) {
        const list = await (await fetch(`${base}/api/approvals`, { headers: { authorization: `Bearer ${token}` } })).json();
        id = list.find((a) => a.status === "pending" && !before.has(a.id))?.id;
        if (!id) await new Promise((done) => setTimeout(done, 25));
      }
      if (!id) fail("console : la demande n'est pas apparue");
      else await fetch(`${base}/api/approvals/${id}/approve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
      const answer = await answered;
      askInClient = true;
      if (!/note \d+ créée/.test(answer.result?.content?.[0]?.text ?? "")) fail(`console : ${JSON.stringify(answer).slice(0, 200)}`);
      else counts.inConsole += 1;
    } else if (i % 10 === 0) {
      const answer = await ask("tools/call", { name: "create_note", arguments: { text: `client ${String(i)}` } });
      if (!/note \d+ créée/.test(answer.result?.content?.[0]?.text ?? "")) fail(`client : ${JSON.stringify(answer).slice(0, 200)}`);
      else counts.inClient += 1;
    } else {
      const answer = await ask("tools/call", { name: "read_note", arguments: {} });
      if (answer.error || answer.result?.isError) fail(`lecture : ${JSON.stringify(answer).slice(0, 200)}`);
      else counts.reads += 1;
    }
  } catch (error) {
    fail(String(error));
  }
  const took = now() - t;
  period.push(took);
  if (took < PACE_MS) await new Promise((done) => setTimeout(done, PACE_MS - took));

  if (Date.now() - lastSample >= SAMPLE_MS || Date.now() >= end) {
    lastSample = Date.now();
    let shown = -1;
    try {
      const { base, token } = await console_();
      shown = (await (await fetch(`${base}/api/local/servers`, { headers: { authorization: `Bearer ${token}` } })).json()).servers?.[0]?.actions ?? -1;
    } catch (error) {
      fail(`écran Serveurs : ${String(error)}`);
    }
    const sample = {
      minutes: (Date.now() - start) / 60_000,
      rss: rssMb(pid),
      fds: fds(pid),
      calls: counts.reads + counts.inClient + counts.inConsole,
      errors: counts.errors,
      p50: percentile(period, 50),
      p95: percentile(period, 95),
      p99: percentile(period, 99),
      shown,
    };
    samples.push(sample);
    appendFileSync(csv, `${sample.minutes.toFixed(1)},${sample.rss.toFixed(1)},${String(sample.fds)},${String(sample.calls)},${String(sample.errors)},${sample.p50.toFixed(1)},${sample.p95.toFixed(1)},${sample.p99.toFixed(1)},${String(shown)}\n`);
    console.log(`  ${sample.minutes.toFixed(0)} min · ${String(sample.calls)} appels · ${String(sample.errors)} erreur(s) · RSS ${sample.rss.toFixed(0)} Mo · p95 ${sample.p95.toFixed(1)} ms`);
    period = [];
  }
}

const verify = spawnSync(process.execPath, [CLI, "receipts", "verify"], { env, encoding: "utf8", timeout: 600_000 });
client.stdin.end();
await new Promise((done) => client.once("exit", done));

/* Le verdict. Régime établi : après le premier quart du passage. */
const settled = samples.filter((s) => s.minutes >= MINUTES / 4);
/* Médianes de trois relevés, au début du régime établi et à la fin : un relevé isolé tombe parfois juste après le ramasse-miettes. */
const median = (list, key) => percentile(list.map((s) => s[key]), 50);
const head = (settled.length >= 3 ? settled : samples).slice(0, 3);
const tail = samples.slice(-3);
const first = { rss: median(head, "rss"), fds: median(head, "fds"), p95: median(head, "p95") };
const last = { ...samples.at(-1), rss: median(tail, "rss"), fds: median(tail, "fds"), p95: median(tail, "p95") };
const checks = [
  ["aucune erreur", counts.errors === 0, `${String(counts.errors)} erreur(s)`],
  ["le pivot vit jusqu'au bout", Boolean(hubPid()) || verify.status === 0, `pivot ${String(pid)}`],
  ["mémoire stable (médianes, régime établi, +25 % au plus)", last.rss <= first.rss * 1.25, `${first.rss.toFixed(0)} → ${last.rss.toFixed(0)} Mo`],
  ["descripteurs stables (+10 au plus)", last.fds <= first.fds + 10, `${String(first.fds)} → ${String(last.fds)}`],
  ["p95 sans dérive (le double ou +25 ms au plus)", last.p95 <= Math.max(first.p95 * 2, first.p95 + 25), `${first.p95.toFixed(1)} → ${last.p95.toFixed(1)} ms`],
  ["l'écran « Serveurs » suit", last.shown >= last.calls - counts.inConsole, `${String(last.shown)} actions affichées pour ${String(last.calls)} appels`],
  ["la chaîne de reçus vérifie", verify.status === 0, verify.stdout.trim().split("\n").at(-1) ?? ""],
];
const verdict = [
  `endurance du pivot : ${String(MINUTES)} min, ${String(i)} appels (${String(counts.reads)} lectures, ${String(counts.inClient)} dans le client, ${String(counts.inConsole)} dans la console)`,
  ...checks.map(([label, ok, detail]) => `${ok ? "✓" : "✗"} ${label} — ${detail}`),
  `${String(checks.filter(([, ok]) => ok).length)}/${String(checks.length)}`,
  ...(errors.length ? ["", "premières erreurs :", ...errors] : []),
].join("\n");
writeFileSync(join(OUT, "verdict.txt"), `${verdict}\n`);
console.log(`\n${verdict}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
