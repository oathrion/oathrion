/**
 * LE PARCOURS D'UN VISITEUR, SUR UN COMPTE NEUF — sous Linux, macOS et Windows (12 novembre
 * 2026 : personne n'avait encore essayé Oathrion sur un Mac ni sous Windows ; l'intégration
 * continue le fait à chaque modification, `.github/workflows/ci.yml`, tâche `visitor`).
 *
 *   node script/visitor-smoke.mjs [dist-npm/oathrion-<version>.tgz]
 *
 * Avec le paquet tel qu'il serait publié, dans un dossier personnel vide (HOME, USERPROFILE,
 * APPDATA redirigés : jamais la configuration de la machine) :
 *   1. `oathrion --yes` protège un serveur MCP de Cursor ;
 *   2. `oathrion phone` répond (aucun téléphone appairé) ;
 *   3. `oathrion console` démarre le pivot, et la console répond sur 127.0.0.1 ;
 *   4. `oathrion --undo --yes` rend la configuration exactement comme avant.
 *
 * Ce qu'il ne voit pas : ce qui s'affiche à l'écran (la notification, le son, la page de
 * décision) — les machines de l'intégration continue n'ont pas d'écran.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const windows = process.platform === "win32";
/* Sans argument : le paquet le plus récent de `dist-npm/` (un ancien peut y traîner). */
const newest = () =>
  readdirSync("dist-npm")
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => ({ f, at: statSync(join("dist-npm", f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]?.f ?? "missing.tgz";
const tgz = resolve(process.argv[2] ?? join("dist-npm", newest()));
const home = mkdtempSync(join(tmpdir(), "oathrion-visitor-"));
const project = join(home, "project");
mkdirSync(project);
mkdirSync(join(home, ".cursor"));
mkdirSync(join(home, "AppData", "Roaming"), { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  XDG_CONFIG_HOME: join(home, ".config"),
  npm_config_cache: join(home, ".npm-cache"),
  npm_config_update_notifier: "false",
  /* Rien dans la vraie session, rien à l'écran, rien vers un téléphone. */
  OATHRION_NO_SESSION_CHANGES: "1",
  OATHRION_LOCAL_AGENT_WATCH: "0",
  OATHRION_LOCAL_NOTIFY_DESKTOP: "0",
  OATHRION_LOCAL_NOTIFY_PHONE: "0",
  OATHRION_LOCAL_NOTIFY_SOUND: "0",
  OATHRION_CONSOLE_LIEN: "1",
  /* Le pivot d'essai s'arrête vite une fois seul : rien ne reste derrière l'essai. */
  OATHRION_LOCAL_HUB_IDLE_MS: "2000",
};

const cursorFile = join(home, ".cursor", "mcp.json");
const before = { mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } } };
writeFileSync(cursorFile, `${JSON.stringify(before, null, 2)}\n`);

const quote = (s) => (windows ? `"${s}"` : s);
const npmArgs = (args) => ["exec", "--yes", `--package=${quote(tgz)}`, "--", "oathrion", ...args];

function run(args) {
  const done = spawnSync("npm", npmArgs(args), { cwd: project, env, encoding: "utf8", shell: windows, timeout: 10 * 60_000 });
  return { code: done.status, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
}

function fail(step, detail) {
  console.error(`✗ ${step}`);
  console.error(detail);
  process.exit(1);
}

console.log(`Oathrion, a visitor's journey on ${process.platform} (${process.arch}), Node ${process.versions.node}`);
console.log(`  package: ${tgz}`);

/* 1. Protéger. */
const setup = run(["--yes"]);
const wrapped = JSON.parse(readFileSync(cursorFile, "utf8"));
const args = wrapped.mcpServers?.memory?.args ?? [];
if (setup.code !== 0 || !args.includes("wrap")) fail("npx oathrion --yes: Cursor's server is not behind Oathrion", setup.out);
console.log("✓ npx oathrion --yes: Cursor's server is behind Oathrion");

/* 2. Le téléphone : la commande répond, sans rien d'appairé. */
const phone = run(["phone"]);
if (phone.code !== 0 || !/not paired/.test(phone.out)) fail("oathrion phone", phone.out);
console.log("✓ oathrion phone: answers (no phone paired)");

/* 3. La console : le pivot démarre, la console et la connexion locale répondent. */
const consoleProcess = spawn("npm", npmArgs(["console", "--no-browser"]), { cwd: project, env, shell: windows, detached: !windows, stdio: ["ignore", "pipe", "pipe"] });
let printed = "";
const link = await new Promise((done) => {
  const timer = setTimeout(() => done(null), 5 * 60_000);
  const read = (chunk) => {
    printed += chunk.toString();
    const found = /(http:\/\/127\.0\.0\.1:\d+)\/console#\/connexion-locale\?ticket=/.exec(printed);
    if (found) {
      clearTimeout(timer);
      done(found[1]);
    }
  };
  consoleProcess.stdout.on("data", read);
  consoleProcess.stderr.on("data", read);
  consoleProcess.on("exit", () => done(null));
});
const stopConsole = () => {
  if (windows) spawnSync("taskkill", ["/pid", String(consoleProcess.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-consoleProcess.pid, "SIGTERM");
    } catch {
      /* déjà parti */
    }
  }
};
if (!link) {
  stopConsole();
  fail("oathrion console: no sign-in link", printed);
}
try {
  const page = await fetch(`${link}/console`);
  if (page.status !== 200) throw new Error(`/console answered ${String(page.status)}`);
  const login = await fetch(`${link}/api/local/login`, { headers: { accept: "application/json" } });
  const body = await login.json().catch(() => ({}));
  if (login.status !== 200 || body.local !== true) throw new Error(`/api/local/login answered ${String(login.status)} ${JSON.stringify(body)}`);
} catch (error) {
  stopConsole();
  fail("the console does not answer", `${String(error)}\n${printed}`);
}
stopConsole();
console.log(`✓ oathrion console: the local hub runs, the console answers (${link})`);

/* 4. Tout rendre comme avant. */
const undo = run(["--undo", "--yes"]);
const after = JSON.parse(readFileSync(cursorFile, "utf8"));
if (undo.code !== 0 || JSON.stringify(after) !== JSON.stringify(before)) fail("npx oathrion --undo: Cursor's configuration is not back as before", `${undo.out}\n${JSON.stringify(after)}`);
console.log("✓ npx oathrion --undo --yes: Cursor's configuration is exactly as before");

console.log("Done: the visitor's journey holds on this system.");
process.exit(0);
