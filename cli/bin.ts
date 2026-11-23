#!/usr/bin/env node
/**
 * Process entry point. Kept separate from `main.ts` so `run()` stays testable
 * in-process: the exit codes ARE the security contract of this tool, and they
 * should not be reachable only by spawning a child.
 */

/*
 * Les anciennes variables `PLACET_*` (renommage d'octobre 2026) restent honorées, comme par
 * le serveur : `PLACET_URL` vaut `OATHRION_URL` si celle-ci est absente, avec un
 * avertissement sur la sortie d'erreur — jamais sur la sortie standard, qui porte le
 * résultat (ou, pour `wrap`, le canal MCP). Importé en premier : les autres modules lisent
 * l'environnement.
 */
import "../server/env-compat";
import "../server/net-patience";
import { run, VERSION } from "./main";
import { EXIT } from "./exit-codes";
import { runWrap } from "./wrap";
import { runConsole } from "./wrap/console";
import { runDecoys } from "./wrap/decoys";
import { runDemo } from "./wrap/demo";
import { jailReadiness, runJail } from "./wrap/jail";
import { jailAlwaysInstaller } from "./wrap/jail-always";
import { runJailInside } from "./wrap/jail-net";
import { launchingAgent } from "../server/local-agent-watch";
import { runWatch, watchInstaller, WATCH_USAGE } from "./wrap/watch";
import { runBridge } from "./wrap/bridge";
import { runClaudeHook } from "./wrap/claude-hook";
import { runInstall } from "./wrap/install";
import { runNotifications } from "./wrap/notifications";
import { runPhone } from "./wrap/phone";
import { runOnboarding } from "./wrap/onboarding";
import { hubDir } from "./wrap/hub";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paired, readTelegram } from "../server/local-telegram";
import { runRetour } from "./wrap/retour";
import { runBundle } from "./wrap/bundle";
import { runReceipt, runReceipts } from "./wrap/receipts";
import { runSetup, SETUP_FLAGS } from "./wrap/setup";
import { runTools } from "./wrap/tools";
import { BRIDGE_USAGE } from "./wrap/bridge";
import { BUNDLE_USAGE } from "./wrap/bundle";
import { PASSPORT_USAGE, runPassport } from "./wrap/passport";
import { REPORT_USAGE, runReport } from "./wrap/report";
import { HOOK_USAGE } from "./wrap/claude-hook";
import { CONSOLE_USAGE } from "./wrap/console";
import { DECOYS_USAGE } from "./wrap/decoys";
import { DEMO_USAGE } from "./wrap/demo";
import { WRAP_USAGE } from "./wrap/index";
import { INSTALL_USAGE } from "./wrap/install";
import { JAIL_USAGE } from "./wrap/jail";
import { NOTIFICATIONS_USAGE } from "./wrap/notifications";
import { PHONE_USAGE } from "./wrap/phone";
import { RECEIPT_USAGE, RECEIPTS_USAGE } from "./wrap/receipts";
import { RETOUR_USAGE } from "./wrap/retour";
import { TOOLS_USAGE } from "./wrap/tools";


/* eslint-disable no-console */
/*
 * `wrap` est à part : ce n'est pas une question posée au serveur mais un processus qui
 * dure, dont la sortie standard EST le canal MCP du client. Rien d'autre que ses messages
 * JSON-RPC ne doit y passer — d'où un aiguillage avant `run()`, qui imprime sur stdout.
 */
const argv = process.argv.slice(2);
/* La question n'est posée que dans un terminal : sinon personne ne peut répondre. */
/*
 * Node.js 22 ou plus récent (12 novembre) : avec un Node plus ancien, `npx oathrion` échouait plus
 * loin, sur une erreur incompréhensible. On le dit d'emblée, avec quoi faire.
 */
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Oathrion needs Node.js 22 or later; this computer has Node.js ${process.versions.node}.`);
  console.error("Install the current LTS from https://nodejs.org (or: nvm install 22), then run the same command again.");
  process.exit(1);
}

/**
 * Attendre qu'une chose arrive, ou qu'on appuie sur Entrée (3 minutes au plus) : « seen »,
 * « skip » ou « timeout ».
 */
const waitOrEnter = async (question: string, ready: () => boolean, timeoutMs = 180_000): Promise<"seen" | "skip" | "timeout"> => {
  if (!process.stdin.isTTY) return "skip";
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stop = new AbortController();
  const pressed = rl.question(question, { signal: stop.signal }).then(
    () => "skip" as const,
    () => null,
  );
  const started = Date.now();
  let result: "seen" | "skip" | "timeout" = "timeout";
  for (;;) {
    const tick = await Promise.race([pressed, new Promise<null>((done) => setTimeout(() => done(null), 1_000))]);
    if (tick === "skip") {
      result = "skip";
      break;
    }
    if (ready()) {
      result = "seen";
      break;
    }
    if (Date.now() - started > timeoutMs) break;
  }
  stop.abort();
  rl.close();
  if (result !== "skip") process.stdout.write("\n");
  return result;
};

/** Ouvrir une adresse dans le navigateur de l'ordinateur (BotFather, pour l'appairage). */
const openUrl = (url: string): void => {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  void import("node:child_process").then(({ spawn }) => {
    try {
      spawn(command, args as string[], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
    } catch {
      /* sans navigateur, l'adresse reste dite à l'écran */
    }
  });
};

/** Un secret tapé sans écho (le jeton du robot) ; `null` sans terminal. */
const askSecret = async (question: string): Promise<string | null> => {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(question);
  /* Rien de ce qui est tapé (ou collé) ne s'affiche. */
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => undefined;
  const answer = await rl.question("");
  rl.close();
  process.stdout.write("\n");
  return answer;
};
/** Une réponse tapée ; `null` sans terminal. */
const ask = async (question: string): Promise<string | null> => {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
};
const confirm = async (question: string, defaultYes = false): Promise<boolean | null> => {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  if (answer === "") return defaultYes;
  return answer === "o" || answer === "oui" || answer === "y" || answer === "yes";
};
/*
 * `oathrion <commande> --help` (recette du 16 novembre) : `jail --help` lançait « --help » comme
 * un agent, `feedback --help` en faisait le titre d'un retour, `console --help` répondait
 * « Unknown option ». L'aide de la commande, rien d'autre — seulement quand `--help` est son seul
 * argument : `oathrion wrap -- serveur --help` reste aux arguments du serveur.
 */
const SUBCOMMAND_USAGE: Record<string, string> = {
  wrap: WRAP_USAGE,
  bridge: BRIDGE_USAGE,
  pont: BRIDGE_USAGE,
  install: INSTALL_USAGE,
  feedback: RETOUR_USAGE,
  retour: RETOUR_USAGE,
  notifications: NOTIFICATIONS_USAGE,
  phone: PHONE_USAGE,
  telephone: PHONE_USAGE,
  console: CONSOLE_USAGE,
  tools: TOOLS_USAGE,
  hook: HOOK_USAGE,
  receipt: RECEIPT_USAGE,
  receipts: RECEIPTS_USAGE,
  jail: JAIL_USAGE,
  demo: DEMO_USAGE,
  decoys: DECOYS_USAGE,
  watch: WATCH_USAGE,
};
const asksHelp = (arg: string | undefined) => arg === "--help" || arg === "-h";
const RECEIPT_SUBCOMMAND_USAGE: Record<string, string> = { bundle: BUNDLE_USAGE, report: REPORT_USAGE, passport: PASSPORT_USAGE };
const helpFor =
  argv.length === 2 && asksHelp(argv[1]) ? SUBCOMMAND_USAGE[argv[0]!] : argv.length === 3 && argv[0] === "receipt" && asksHelp(argv[2]) ? RECEIPT_SUBCOMMAND_USAGE[argv[1]!] : undefined;
if (helpFor !== undefined) {
  console.log(helpFor.trim());
  process.exit(0);
} else if (argv[0] === "wrap") {
  void runWrap(argv.slice(1), process.env).then((code) => process.exit(code));
} else if (argv[0] === undefined || SETUP_FLAGS.has(argv[0]) || (argv[0] === "install" && argv.length === 1)) {
  /* `npx oathrion` : tout trouver, tout montrer, une réponse. */
  const flags = argv[0] === "install" ? [] : argv;
  /* `OATHRION_NO_SESSION_CHANGES=1` : ni veille ni prison par défaut dans la session (les essais de bout en bout). */
  const session = process.env.OATHRION_NO_SESSION_CHANGES === "1" ? null : { home: process.env.HOME ?? "", script: process.argv[1] ?? "", env: process.env };
  const watch = session ? watchInstaller(session) : undefined;
  const jail = session ? { installer: jailAlwaysInstaller(session), readiness: jailReadiness } : undefined;
  /*
   * LE PARCOURS GUIDÉ (12 novembre, `wrap/onboarding.ts`) : dans un vrai terminal, après une
   * installation réussie, la démo puis le téléphone, d'une touche chacun. Jamais avec `--yes`,
   * pour `--undo`, ni sans terminal (les scripts, les essais).
   */
  const guided = process.stdin.isTTY === true && process.stdout.isTTY === true && !flags.some((f) => ["--yes", "--oui", "--undo", "--annuler"].includes(f));
  let restart: string[] = [];
  const startedAt = Date.now();
  void runSetup(flags, { out: (l) => console.log(l), err: (l) => console.error(l), confirm, cwd: process.cwd(), script: process.argv[1], version: VERSION, watch, jail, guided, onRestart: (clients) => (restart = clients), launchingAgent: session && process.platform === "linux" ? () => launchingAgent() : undefined })
    .then(async (code) => {
      /*
       * Un succès partiel (2 : un serveur n'a pas pu être protégé, les autres oui) continue aussi
       * le parcours ; le code reste celui de l'installation. Une seule fois par machine : relancer
       * `npx oathrion` pour une mise à jour ne rejoue pas la démo.
       */
      const onboarded = join(hubDir(process.env), "onboarded");
      if ((code !== 0 && code !== 2) || !guided || existsSync(onboarded)) return code;
      const indent = (l: string) => console.log(`      ${l}`);
      await runOnboarding({
        out: (l) => console.log(l),
        ask,
        askSecret,
        /* « For real: npx oathrion… » n'a pas de sens ici : la personne vient de le faire. */
        demo: (quiet) => runDemo([], { out: quiet ? () => undefined : (l) => (l.startsWith("For real:") ? undefined : indent(l)), err: indent, env: process.env }),
        pairPhone: (token) => runPhone(["telegram", token], { out: indent, err: indent, env: process.env, script: process.argv[1] }),
        phonePaired: () => paired(readTelegram(hubDir(process.env))),
        restart,
        /* Un client relancé lance ses serveurs par Oathrion : le pivot en réécrit la commande (`serveurs/<nom>/commande.json`). */
        waitForAgent: (question) =>
          waitOrEnter(question, () => {
            const root = join(hubDir(process.env), "serveurs");
            try {
              return readdirSync(root).some((name) => (statSync(join(root, name, "commande.json"), { throwIfNoEntry: false })?.mtimeMs ?? 0) > startedAt);
            } catch {
              return false;
            }
          }),
        open: openUrl,
      });
      try {
        mkdirSync(hubDir(process.env), { recursive: true, mode: 0o700 });
        writeFileSync(onboarded, `${new Date().toISOString()}\n`, { mode: 0o600 });
      } catch {
        /* sans ce repère, le parcours sera simplement reproposé */
      }
      return code;
    })
    .then((code) => process.exit(code));
} else if (argv[0] === "bridge" || argv[0] === "pont") {
  /* Comme `wrap` : la sortie standard EST le canal MCP. */
  void runBridge(argv.slice(1), process.env, { input: process.stdin, write: (l) => process.stdout.write(`${l}\n`), log: (l) => process.stderr.write(`${l}\n`) }).then((code) => process.exit(code));
} else if (argv[0] === "install") {
  void runInstall(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l), confirm, cwd: process.cwd(), script: process.argv[1], version: VERSION }).then((code) => process.exit(code));
} else if (argv[0] === "feedback" || argv[0] === "retour") {
  process.exit(runRetour(argv.slice(1), VERSION, (l) => console.log(l)));
} else if (argv[0] === "notifications") {
  void runNotifications(argv.slice(1), process.env, (l) => console.log(l), (l) => console.error(l)).then((code) => process.exit(code));
} else if (argv[0] === "phone" || argv[0] === "telephone") {
  void runPhone(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env, script: process.argv[1], askSecret }).then((code) => process.exit(code));
} else if (argv[0] === "console") {
  void runConsole(argv.slice(1), process.env, (l) => console.log(l), (l) => console.error(l)).then((code) => process.exit(code));
} else if (argv[0] === "tools") {
  process.exit(runTools(argv.slice(1), process.env, (l) => console.log(l), (l) => console.error(l)));
} else if (argv[0] === "hook") {
  /* Appelé par les hooks de Claude Code : l'appel d'outil arrive sur l'entrée standard. */
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finish = (stdin: string) => void runClaudeHook(argv.slice(1), process.env, stdin, (l) => console.log(l)).then((code) => process.exit(code));
  process.stdin.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
  if (process.stdin.isTTY) finish("");
} else if (argv[0] === "receipt" && argv[1] === "bundle") {
  void runBundle(argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), cwd: process.cwd(), env: process.env }).then((code) => process.exit(code));
} else if (argv[0] === "receipt" && argv[1] === "passport") {
  void runPassport(argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), cwd: process.cwd(), env: process.env }).then((code) => process.exit(code));
} else if (argv[0] === "receipt" && argv[1] === "report") {
  void runReport(argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), cwd: process.cwd(), env: process.env }).then((code) => process.exit(code));
} else if (argv[0] === "receipt") {
  process.exit(runReceipt(argv.slice(1), (l) => console.log(l), (l) => console.error(l)));
} else if (argv[0] === "jail") {
  void runJail(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env, cwd: process.cwd(), script: process.argv[1] }).then((code) => process.exit(code));
} else if (argv[0] === "__jail-inside") {
  /* Dans la prison, avant l'agent : relie 127.0.0.1 aux passages ouverts dehors (`jail-net.ts`). */
  void runJailInside(argv.slice(1)).then((code) => process.exit(code));
} else if (argv[0] === "watch") {
  void runWatch(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env, home: process.env.HOME ?? "", script: process.argv[1] ?? "" }).then((code) => process.exit(code));
} else if (argv[0] === "demo") {
  void runDemo(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env }).then((code) => process.exit(code));
} else if (argv[0] === "decoys") {
  void runDecoys(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l), confirm, env: process.env }).then((code) => process.exit(code));
} else if (argv[0] === "receipts") {
  process.exit(runReceipts(argv.slice(1), process.env, (l) => console.log(l), (l) => console.error(l)));
} else run(argv, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
})
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    /*
     * The last line of defence. An unexpected throw must never leave the
     * process exiting 0, because `oathrion evaluate && rm -rf …` would then run on
     * a crash. Node's default for an unhandled rejection is already non-zero,
     * but relying on a default for this is not good enough.
     */
    console.error(`oathrion: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(EXIT.PROTOCOL);
  });
