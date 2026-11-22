#!/usr/bin/env node
/**
 * Mesurer la fluidité d'`oathrion wrap`, en chiffres reproductibles.
 *
 *   npm run build
 *   node script/mesure-fluidite.mjs [--lectures 50]
 *
 * La VRAIE commande compilée (`dist/oathrion.mjs`) devant le faux serveur MCP du dépôt
 * (`server/test/fixtures/fake-stdio-mcp-server.cjs`), dans des dossiers d'état jetables.
 * Ce qui est mesuré est ce que la machine fait ; le temps d'une personne (lire, cliquer) et
 * le comportement d'un vrai client (Cursor) ne le sont pas, et le rapport le dit.
 *
 *   0. installation : `oathrion` sans option (ce que `npx oathrion` lance) sur une fausse
 *      configuration de Cursor, puis le serveur lancé tel qu'écrit, jusqu'à sa liste d'outils ;
 *   1. démarrage à froid (base vide) et à chaud : du lancement à la liste des outils ;
 *   2. surcoût d'Oathrion sur une lecture : la même lecture, directe et à travers `wrap` ;
 *   3. retenue d'une écriture : du `tools/call` à la réponse « retenu » ;
 *   4. décision → réponse à l'agent : approuvée dans la console (API), puis dans le client
 *      (elicitation acceptée sur-le-champ) ;
 *   5. `oathrion console` : le lien de connexion, client ouvert et client fermé.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "oathrion.mjs");
const FAKE = join(ROOT, "server", "test", "fixtures", "fake-stdio-mcp-server.cjs");
const argv = process.argv.slice(2);
const READS = Number(argv[argv.indexOf("--lectures") + 1]) > 0 && argv.includes("--lectures") ? Number(argv[argv.indexOf("--lectures") + 1]) : 50;
const homes = [];
/*
 * Depuis le 9 novembre, Oathrion attend qu'une personne confirme un programme qu'il rencontre pour
 * la première fois : sans cela, chaque appel du banc attendait 30 s (constaté le 18 novembre). Ce
 * geste humain, fait une fois, n'est pas ce qu'on mesure : `OATHRION_UNSAFE_TRUST_ALL_PROGRAMS`
 * l'accorde d'office (et l'inscrit comme tel), dans des dossiers jetables. La veille des agents et
 * les changements de session restent coupés : `oathrion` les démarrerait sinon pour TOUTE la machine,
 * même depuis un dossier personnel jetable (quatre veilles de test restées actives, le 18 novembre).
 */

const now = () => performance.now();
const ms = (value) => `${value.toFixed(value < 10 ? 1 : 0)} ms`;
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "oathrion-mesure-"));
  homes.push(dir);
  return dir;
};

/** Un processus qui parle JSON-RPC en stdio, avec qui l'on dialogue. */
function rpcProcess(command, args, env) {
  /* Pas de notification de bureau pendant la mesure. */
  const proc = spawn(command, args, { env: { PATH: process.env.PATH ?? "", OATHRION_LOCAL_NOTIFY_DESKTOP: "0", OATHRION_CONSOLE_LIEN: "1", OATHRION_UNSAFE_TRUST_ALL_PROGRAMS: "1", OATHRION_LOCAL_AGENT_WATCH: "0", OATHRION_NO_SESSION_CHANGES: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c));
  const waiting = new Map();
  const listeners = [];
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    for (const listener of listeners) listener(message);
    if (message.method === undefined) waiting.get(message.id)?.(message);
  });
  let next = 1;
  return {
    proc,
    stderr: () => stderr,
    onMessage: (fn) => listeners.push(fn),
    send: (message) => proc.stdin.write(`${JSON.stringify(message)}\n`),
    ask(method, params = {}) {
      const id = next++;
      return new Promise((done) => {
        waiting.set(id, done);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async close() {
      proc.stdin.end();
      await new Promise((done) => (proc.exitCode !== null ? done() : proc.once("exit", done)));
    },
  };
}

const INIT = (capabilities = {}) => ({ protocolVersion: "2025-06-18", capabilities, clientInfo: { name: "mesure", version: "1" } });

function wrap(dir, extra = []) {
  return rpcProcess(process.execPath, [CLI, "wrap", "--name", "mesure", ...extra, "--", process.execPath, FAKE], { HOME: dir, OATHRION_WRAP_HOME: dir });
}

async function run(command, args, env) {
  const proc = spawn(command, args, { env: { PATH: process.env.PATH ?? "", OATHRION_LOCAL_NOTIFY_DESKTOP: "0", OATHRION_CONSOLE_LIEN: "1", OATHRION_UNSAFE_TRUST_ALL_PROGRAMS: "1", OATHRION_LOCAL_AGENT_WATCH: "0", OATHRION_NO_SESSION_CHANGES: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  const code = await new Promise((done) => proc.once("exit", done));
  return { code, out };
}

/** Une session de console : un ticket d'`oathrion console`, échangé contre un jeton. */
async function sessionToken(dir) {
  const { out } = await run(process.execPath, [CLI, "console", "--name", "mesure", "--sans-navigateur"], { HOME: dir, OATHRION_WRAP_HOME: dir });
  const link = /(?:Connexion directe|Direct sign-in)[^:]*: (\S+)/.exec(out)?.[1];
  const port = readFileSync(join(dir, "_local", "port"), "utf8").trim();
  const ticket = new URLSearchParams(link.split("?")[1]).get("ticket");
  const response = await fetch(`http://127.0.0.1:${port}/api/local/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
  return { base: `http://127.0.0.1:${port}`, token: (await response.json()).token };
}

async function pendingApproval(base, token, seen = new Set()) {
  for (;;) {
    const list = await (await fetch(`${base}/api/approvals`, { headers: { authorization: `Bearer ${token}` } })).json();
    /* La plus récente : l'étape 3 en laisse une autre en attente. */
    const pending = list.filter((a) => a.status === "pending" && !seen.has(a.id)).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
    if (pending) return pending.id;
    await new Promise((done) => setTimeout(done, 20));
  }
}

const results = [];
const record = (section, label, value, note = "") => {
  results.push({ section, label, value, note });
  /* Au fur et à mesure : un banc qui s'arrête dit à quelle étape. */
  process.stderr.write(`  · ${section} : ${label} — ${value}\n`);
};

try {
  /* 0. Installation : une commande, une réponse (ici --oui), puis le client démarre le serveur. */
  {
    const dir = home();
    mkdirSync(join(dir, ".cursor"));
    const config = join(dir, ".cursor", "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { mesure: { command: process.execPath, args: [FAKE] } } }));
    const t = now();
    const { code } = await run(process.execPath, [CLI, "--oui"], { HOME: dir, OATHRION_WRAP_HOME: dir });
    const tSetup = now() - t;
    const written = JSON.parse(readFileSync(config, "utf8")).mcpServers.mesure;
    const first = rpcProcess(written.command, written.args, { HOME: dir, OATHRION_WRAP_HOME: dir });
    await first.ask("initialize", INIT());
    await first.ask("tools/list");
    record("Installation", "oathrion → configuration de Cursor écrite", ms(tSetup), code === 0 ? "1 commande, 1 réponse, aucune option" : `ÉCHEC (code ${String(code)})`);
    record("Installation", "… → le serveur sous Oathrion liste ses outils", ms(now() - t), "hors relance du client et npx");
    await first.close();
  }

  /* 1. Démarrages. */
  const dir = home();
  let t0 = now();
  let w = wrap(dir);
  await w.ask("initialize", INIT());
  const tInit = now() - t0;
  await w.ask("tools/list");
  record("Démarrage", "à froid (base vide) → liste des outils", ms(now() - t0), `initialize à ${ms(tInit)}`);
  /* Le programme du banc, confirmé une fois dans la console, comme le ferait une personne (le pivot ne reçoit pas les variables du banc). */
  {
    const first = w.ask("tools/call", { name: "read_note", arguments: {} });
    const { base, token } = await sessionToken(dir);
    let pending;
    for (let i = 0; i < 200 && !pending; i += 1) {
      pending = (await (await fetch(`${base}/api/local/programs`, { headers: { authorization: `Bearer ${token}` } })).json()).find((p) => p.status === "pending");
      if (!pending) await new Promise((done) => setTimeout(done, 25));
    }
    if (pending) await fetch(`${base}/api/local/programs/${encodeURIComponent(pending.id)}/trust`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    await first;
  }
  await w.close();
  t0 = now();
  w = wrap(dir);
  await w.ask("initialize", INIT());
  await w.ask("tools/list");
  record("Démarrage", "à chaud (relance) → liste des outils", ms(now() - t0), "hors téléchargement npx du serveur enveloppé");

  /* 2. Surcoût d'une lecture. */
  const direct = rpcProcess(process.execPath, [FAKE], {});
  await direct.ask("initialize", INIT());
  const directTimes = [];
  for (let i = 0; i < READS; i += 1) {
    const t = now();
    await direct.ask("tools/call", { name: "read_note", arguments: {} });
    directTimes.push(now() - t);
  }
  await direct.close();
  const wrapped = [];
  for (let i = 0; i < READS; i += 1) {
    const t = now();
    await w.ask("tools/call", { name: "read_note", arguments: {} });
    wrapped.push(now() - t);
  }
  record("Lecture", `directe, médiane sur ${String(READS)}`, ms(percentile(directTimes, 50)), `p95 ${ms(percentile(directTimes, 95))}`);
  record("Lecture", `à travers Oathrion, médiane sur ${String(READS)}`, ms(percentile(wrapped, 50)), `p95 ${ms(percentile(wrapped, 95))}`);
  record("Lecture", "surcoût d'Oathrion (médiane)", ms(percentile(wrapped, 50) - percentile(directTimes, 50)), "décision, journal, reçu chaîné compris");
  await w.close();

  /* 3. Retenue d'une écriture. */
  w = wrap(dir, ["--attendre", "0"]);
  await w.ask("initialize", INIT());
  t0 = now();
  await w.ask("tools/call", { name: "create_note", arguments: { text: "retenue" } });
  record("Écriture", "appel → réponse « retenu »", ms(now() - t0), "aucune attente (--attendre 0)");
  await w.close();

  /* 4a. Décision dans la console → réponse à l'agent. */
  w = wrap(dir, ["--attendre", "30"]);
  await w.ask("initialize", INIT());
  const { base, token } = await sessionToken(dir);
  /* Les demandes déjà là avant cet appel (l'écriture retenue de l'étape 3) ne comptent pas. */
  const before = new Set((await (await fetch(`${base}/api/approvals`, { headers: { authorization: `Bearer ${token}` } })).json()).map((a) => a.id));
  const answered = w.ask("tools/call", { name: "create_note", arguments: { text: "console" } });
  const approvalId = await pendingApproval(base, token, before);
  t0 = now();
  await fetch(`${base}/api/approvals/${approvalId}/approve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  const tApi = now() - t0;
  await answered;
  record("Décision", "approuvée dans la console → l'agent a la réponse du serveur", ms(now() - t0), `dont l'approbation elle-même ${ms(tApi)} ; attente côté serveur`);
  await w.close();

  /* 4b. Décision dans le client (le défaut quand il sait poser la question : case cochée, acceptée aussitôt). */
  w = wrap(dir, ["--attendre", "30"]);
  w.onMessage((message) => {
    if (message.method === "elicitation/create") {
      w.send({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { confirmer: true } } });
    }
  });
  await w.ask("initialize", INIT({ elicitation: { form: {} } }));
  t0 = now();
  const inClient = await w.ask("tools/call", { name: "create_note", arguments: { text: "client" } });
  record("Décision", "dans le client : appel → question → accepté → réponse du serveur", ms(now() - t0), inClient.result?.isError ? "ÉCHEC" : "réponse de l'enfant reçue");
  await w.close();

  /* 5. oathrion console. */
  w = wrap(dir);
  await w.ask("initialize", INIT());
  t0 = now();
  await run(process.execPath, [CLI, "console", "--name", "mesure", "--sans-navigateur"], { HOME: dir, OATHRION_WRAP_HOME: dir });
  record("Console", "client ouvert → lien de connexion", ms(now() - t0), "");
  await w.close();
  t0 = now();
  const consoleProc = spawn(process.execPath, [CLI, "console", "--name", "mesure", "--sans-navigateur"], { env: { PATH: process.env.PATH ?? "", HOME: dir, OATHRION_WRAP_HOME: dir, OATHRION_LOCAL_NOTIFY_DESKTOP: "0", OATHRION_CONSOLE_LIEN: "1", OATHRION_UNSAFE_TRUST_ALL_PROGRAMS: "1", OATHRION_LOCAL_AGENT_WATCH: "0", OATHRION_NO_SESSION_CHANGES: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let consoleOut = "";
  consoleProc.stdout.on("data", (c) => (consoleOut += c));
  while (!/Connexion directe|Direct sign-in/.test(consoleOut)) await new Promise((done) => setTimeout(done, 20));
  record("Console", "client fermé → serveur relancé et lien de connexion", ms(now() - t0), "");
  consoleProc.kill("SIGINT");
  await new Promise((done) => consoleProc.once("exit", done));
} finally {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
}

let section = "";
for (const { section: s, label, value, note } of results) {
  if (s !== section) {
    console.log(`\n${s}`);
    section = s;
  }
  console.log(`  ${label.padEnd(64)} ${value.padStart(9)}${note ? `   (${note})` : ""}`);
}
console.log("\nNon mesuré ici : le temps d'une personne (lire, décider, cliquer), le téléchargement npx, le comportement réel de Cursor.");
