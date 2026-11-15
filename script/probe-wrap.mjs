#!/usr/bin/env node
/**
 * Essayer `oathrion wrap` devant un VRAI serveur MCP, et voir comment ses outils sont classés.
 *
 *   npm run build
 *   node script/probe-wrap.mjs <nom> -- <commande du serveur MCP…>
 *
 *   node script/probe-wrap.mjs filesystem -- npx -y @modelcontextprotocol/server-filesystem /tmp/essai
 *   node script/probe-wrap.mjs memory     -- npx -y @modelcontextprotocol/server-memory
 *
 * Le script lance la commande compilée (`dist/oathrion.mjs wrap`) dans un dossier d'état
 * JETABLE (jamais `~/.oathrion`), fait la poignée de main, lit la liste des outils, puis
 * affiche, pour chaque outil, la classe qu'Oathrion lui donne et les annotations que le
 * serveur déclare lui-même. Il n'appelle AUCUN outil : il ne lit, n'écrit et ne supprime rien.
 *
 * Pourquoi : le classement exige l'annotation `readOnlyHint` ET un nom de lecture pour
 * autoriser un outil sans approbation. Un serveur qui n'annote pas ses outils verrait toutes
 * ses lectures soumises à approbation — ce script le montre avant qu'un utilisateur le vive.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator !== 1 || argv.length < 3) {
  console.error("usage : node script/probe-wrap.mjs <nom> -- <commande du serveur MCP…>");
  process.exit(3);
}
const name = argv[0];
const command = argv.slice(2);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "oathrion-probe-"));

const wrap = spawn(process.execPath, [join(ROOT, "dist", "oathrion.mjs"), "wrap", "--name", name, "--attendre", "0", "--", ...command], {
  env: { ...process.env, OATHRION_WRAP_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
wrap.stderr.on("data", (chunk) => (stderr += chunk));
const answers = new Map();
createInterface({ input: wrap.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  answers.get(message.id)?.(message);
});
const ask = (id, method, params = {}) =>
  new Promise((done) => {
    answers.set(id, done);
    wrap.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const quiet = (text) => text.replace(/invitation=\S+/g, "invitation=***");
const timer = setTimeout(() => {
  console.log(`DÉLAI DÉPASSÉ (3 min). Fin du journal :\n${quiet(stderr).slice(-1500)}`);
  process.exit(1);
}, 180_000);

const init = await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe-wrap", version: "1" } });
if (init.error) {
  console.log(`initialize refusé : ${JSON.stringify(init.error)}\n${quiet(stderr).slice(-1500)}`);
  process.exit(1);
}
const listed = await ask(2, "tools/list");
/* Le pivot local range les définitions vues par serveur (`_local/serveurs/<nom>`). */
const seen = JSON.parse(readFileSync(join(home, "_local", "serveurs", name, "outils-vus.json"), "utf8"));
const visible = new Map((listed.result?.tools ?? []).map((tool) => [tool.name, tool]));

for (const line of stderr.split("\n")) if (/serveur «/.test(line)) console.log(line.trim());
console.log("");
const counts = { read: 0, write: 0, destructive: 0 };
for (const tool of [...seen].sort((a, b) => a.name.localeCompare(b.name))) {
  const governance = visible.get(tool.name)?._meta?.["dev.placet/governance"];
  const cls = governance?.toolClass ?? "destructive";
  counts[cls] = (counts[cls] ?? 0) + 1;
  const a = tool.definition.annotations ?? {};
  const hints = [
    a.readOnlyHint === true ? "readOnly" : a.readOnlyHint === false ? "readOnly=false" : "",
    a.destructiveHint === true ? "destructive" : a.destructiveHint === false ? "destructive=false" : "",
  ].filter(Boolean).join(", ");
  const label =
    cls === "read" && governance?.readBasis === "name"
      ? "lecture (nom seul) — autorisée"
      : ({ read: "lecture — autorisée", write: "écriture — approbation", destructive: "destruction — bloquée" }[cls] ?? cls);
  console.log(`  ${tool.name.padEnd(30)} ${label.padEnd(32)} annotations du serveur : ${hints || "aucune"}`);
}
console.log(`\n${seen.length} outil(s) : ${counts.read} lecture(s), ${counts.write} écriture(s), ${counts.destructive} destruction(s).`);
clearTimeout(timer);
wrap.stdin.end();
await new Promise((done) => wrap.once("exit", done));
