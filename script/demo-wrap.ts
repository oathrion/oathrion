/**
 * La démo de 30 secondes de `oathrion wrap`, à filmer.
 *
 *   npm run build
 *   npm run demo:wrap
 *
 * Un agent SCRIPTÉ parle à `oathrion wrap`, devant un petit serveur MCP de notes
 * (`server/test/fixtures/fake-stdio-mcp-server.cjs`), exactement comme le ferait Cursor :
 *
 *   1. il liste les outils — la suppression n'y est pas ;
 *   2. il lit les notes — ça passe ;
 *   3. il crée une note — l'appel ATTEND : la personne qui présente clique « Approuver »
 *      dans la console, et l'agent reçoit la réponse du serveur ;
 *   4. la chaîne de reçus est vérifiée.
 *
 * Avant de filmer : pendant que la démo attend l'approbation, dans un autre terminal,
 * `OATHRION_WRAP_HOME=~/.oathrion-demo node dist/oathrion.mjs console --name notes` ouvre
 * la console déjà connectée, sur « Approbations » : ni invitation ni mot de passe.
 *
 * `DEMO_WAIT=<secondes>` raccourcit l'attente de l'approbation (répétition sans console).
 * `DEMO_DANS_LE_CLIENT=1` : la démo joue un client qui sait poser la question
 * (`--approbation client`, elicitation) ; elle s'affiche dans le terminal, on répond au clavier.
 * Dans les deux cas, la démo chronomètre la décision : de la demande à la réponse reçue.
 *
 * Les données de la démo vivent dans `~/.oathrion-demo/` (`OATHRION_WRAP_HOME`), jamais
 * dans `~/.oathrion/`.
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.OATHRION_WRAP_HOME?.trim() || join(homedir(), ".oathrion-demo");
const TSX = [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", join(ROOT, "tsconfig.json"), join(ROOT, "cli", "bin.ts")];
const FAKE = join(ROOT, "server", "test", "fixtures", "fake-stdio-mcp-server.cjs");

const say = (line: string) => process.stdout.write(`\n\x1b[1m${line}\x1b[0m\n`);
const show = (line: string) => process.stdout.write(`  ${line}\n`);

const IN_CLIENT = process.env.DEMO_DANS_LE_CLIENT === "1";
const wrap = spawn(process.execPath, [...TSX, "wrap", "--name", "notes", "--attendre", process.env.DEMO_WAIT?.trim() || "120", ...(IN_CLIENT ? ["--approbation", "client"] : []), "--", process.execPath, FAKE], {
  env: { ...process.env, OATHRION_WRAP_HOME: HOME, FAKE_MCP_DEMO: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
wrap.stderr.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString().split("\n")) if (line.trim() !== "") show(`\x1b[2m${line}\x1b[0m`);
});

const answers = new Map<number, (message: Record<string, unknown>) => void>();
createInterface({ input: wrap.stdout }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: number | string; method?: string; params?: { message?: string } };
  /* La question qu'un client montrerait à la personne : ici, dans le terminal. */
  if (message.method === "elicitation/create") {
    say("   ↳ La question, telle que votre client la montrerait :");
    for (const questionLine of String(message.params?.message ?? "").split("\n")) show(`│ ${questionLine}`);
    const keyboard = createInterface({ input: process.stdin, output: process.stdout });
    keyboard.question("  Accepter ? [o/N] ", (reply) => {
      keyboard.close();
      const action = /^(o|oui|y|yes)$/i.test(reply.trim()) ? "accept" : "decline";
      wrap.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action, content: {} } })}\n`);
    });
    return;
  }
  if (typeof message.id === "number") answers.get(message.id)?.(message as Record<string, unknown>);
});
let nextId = 1;
function ask(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((done) => {
    answers.set(id, done);
    wrap.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
const text = (answer: Record<string, unknown>): string => {
  const result = answer.result as { content?: { text?: string }[] } | undefined;
  return result?.content?.map((c) => c.text ?? "").join(" ") ?? JSON.stringify(answer.error);
};

say("oathrion wrap -- node notes-server.cjs");
await ask("initialize", { protocolVersion: "2025-06-18", capabilities: IN_CLIENT ? { elicitation: {} } : {}, clientInfo: { name: "demo-agent", version: "1" } });

say("1. L'agent liste les outils du serveur");
const listed = (await ask("tools/list")).result as { tools: { name: string; description?: string }[] };
show(listed.tools.map((t) => t.name).sort().join(" · "));
const withheld = listed.tools.find((t) => t.name === "oathrion_withheld_tools");
show(withheld ? `(delete_note n'y est pas. Ce que l'agent en apprend : ${String(withheld.description)})` : "(delete_note n'y est pas : destruction bloquée par défaut)");

say("2. L'agent lit les notes");
show(text(await ask("tools/call", { name: "read_note", arguments: {} })));

say(`3. L'agent crée une note — l'appel attend votre approbation ${IN_CLIENT ? "(la question arrive ci-dessous)" : "dans la console"}`);
if (!IN_CLIENT) {
  show("Ouvrez la console dans un autre terminal, puis Approbations → Approuver :");
  show(`  OATHRION_WRAP_HOME=${HOME} node ${join(ROOT, "dist", "oathrion.mjs")} console --name notes`);
}
const asked = Date.now();
const answered = await ask("tools/call", { name: "create_note", arguments: { text: "Préparer la démo" } });
show(text(answered));
const isError = (answered.result as { isError?: boolean } | undefined)?.isError === true;
show(`⏱  ${((Date.now() - asked) / 1000).toFixed(1)} s entre la demande de l'agent et sa réponse${isError ? " (pas exécutée)" : " (exécutée)"}`);

say("4. La chaîne de reçus");
wrap.stdin.end();
await new Promise((done) => wrap.once("exit", done));
const verify = spawnSync(process.execPath, [...TSX, "receipts", "verify", "--name", "notes"], {
  env: { ...process.env, OATHRION_WRAP_HOME: HOME },
  encoding: "utf8",
});
show(verify.stdout.trim());
