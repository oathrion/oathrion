/**
 * `oathrion hook claude-code pre|post` — ce que les hooks de Claude Code appellent.
 *
 *   · `pre` (hook `PreToolUse`) : juge l'outil intégré (`claude-hook-rules.ts`) et rend, sur la
 *     sortie standard, `deny` ou `ask` avec le motif — ou rien. Puis une ligne au journal ;
 *   · `post` (hook `PostToolUse`) : une ligne au journal avec l'issue, sans la sortie.
 *
 * NE JAMAIS GÊNER CLAUDE CODE PAR ACCIDENT : une entrée illisible, un journal impossible à
 * écrire, une règle mal formée → la commande se tait et rend 0. Seul un verdict déjà calculé est
 * toujours rendu, avant toute écriture. Elle ne dépend pas du pivot : il peut ne pas tourner.
 *
 * Les réglages de la personne, facultatifs : `~/.oathrion/claude-code-rules.json`
 *
 *   { "disable": ["git-push"],
 *     "deny": [{ "id": "prod", "pattern": "psql .*prod", "reason": "no direct access to production." }],
 *     "ask":  [{ "id": "deploy", "pattern": "^kubectl apply", "reason": "a deployment." }] }
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadDecoys } from "./decoys";
import { loadGuardedTokens } from "./guarded-tokens";
import { forMode, judge, personIsAsked, untrustedSource, type Judgement, type RuleContext, type Taint } from "./claude-hook-rules";
import { appendJournal, digestOf, journalDir, type JournalRecord } from "./claude-journal";
import { describeImpact, measure } from "./impact";
import { stateRoot } from "./launch";

export const HOOK_USAGE = `
oathrion hook claude-code pre|post

  Called by Claude Code's hooks (PreToolUse, PostToolUse), which "oathrion" installs: judges
  Claude Code's own shell and file writes, and keeps their journal. Not meant to be run by hand.
`;

/*
 * LE PLUGIN CLAUDE CODE (26 novembre) : le paquet npm est aussi un plugin (`plugin/`), dont les
 * hooks appellent ce fichier avec `--plugin`. Si `npx oathrion` a déjà posé nos hooks dans les
 * réglages, ceux-là jugent déjà chaque action : le plugin se tait, sinon tout serait jugé, et
 * demandé, deux fois. `OATHRION_PLUGIN_FORCE=1` le fait juger quand même (pour l'essayer).
 */
export const PLUGIN_FLAG = "--plugin";
const SETTINGS_HOOK = /\boathrion\b.*\bclaude-code (pre|post)\b/;

/** Nos hooks sont-ils déjà dans les réglages de Claude Code (personne, projet, local) ? */
export function settingsHaveOurHook(env: NodeJS.ProcessEnv, projectDir: string): boolean {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const files = [join(home, ".claude", "settings.json"), join(projectDir, ".claude", "settings.json"), join(projectDir, ".claude", "settings.local.json")];
  return files.some((file) => {
    try {
      const hooks = (JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, unknown> }).hooks ?? {};
      return Object.values(hooks).some(
        (entries) => Array.isArray(entries) && entries.some((entry) => Array.isArray((entry as { hooks?: unknown }).hooks) && ((entry as { hooks: { command?: unknown }[] }).hooks).some((h) => typeof h.command === "string" && !h.command.includes(PLUGIN_FLAG) && SETTINGS_HOOK.test(h.command))),
      );
    } catch {
      return false;
    }
  });
}

export const RULES_FILE = "claude-code-rules.json";

interface HookPayload {
  hook_event_name?: string;
  permission_mode?: string;
  session_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  /** `PostToolUseFailure` : le texte de l'erreur (jamais gardé) et l'interruption. */
  error?: unknown;
  is_interrupt?: unknown;
  cwd?: string;
  scratchpad_dir?: string;
}

type Extra = { id: string; pattern: RegExp; reason: string };

/** Les réglages de la personne. Une ligne mal formée est ignorée, jamais fatale. */
export function readRules(env: NodeJS.ProcessEnv): Pick<RuleContext, "disabled" | "extraDeny" | "extraAsk"> {
  const path = join(stateRoot(env), RULES_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { disable?: unknown; deny?: unknown; ask?: unknown };
    const list = (value: unknown): Extra[] =>
      (Array.isArray(value) ? value : []).flatMap((item: { id?: unknown; pattern?: unknown; reason?: unknown }) => {
        if (typeof item?.id !== "string" || typeof item.pattern !== "string") return [];
        try {
          return [{ id: item.id, pattern: new RegExp(item.pattern), reason: typeof item.reason === "string" ? item.reason : "a rule of yours." }];
        } catch {
          return [];
        }
      });
    return {
      disabled: new Set(Array.isArray(parsed.disable) ? parsed.disable.filter((d): d is string => typeof d === "string") : []),
      extraDeny: list(parsed.deny),
      extraAsk: list(parsed.ask),
    };
  } catch {
    return {};
  }
}

/** La marque d'une session : un petit fichier par session, sa PREMIÈRE lecture non fiable. */
function taintFile(env: NodeJS.ProcessEnv, session: string | null): string | null {
  if (!session) return null;
  return join(journalDir(env), "sessions", `${session.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}.json`);
}

export function readTaint(env: NodeJS.ProcessEnv, session: string | null): Taint | null {
  const file = taintFile(env, session);
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Taint>;
    return typeof parsed.source === "string" && typeof parsed.at === "string" ? { source: parsed.source, at: parsed.at } : null;
  } catch {
    return null;
  }
}

/** Marque la session (la première lecture reste la raison) ; les marques de plus de 7 jours partent. */
function markTainted(env: NodeJS.ProcessEnv, session: string | null, source: string, now: Date): void {
  const file = taintFile(env, session);
  if (!file || existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ source, at: now.toISOString() }), { mode: 0o600 });
  for (const name of readdirSync(dirname(file))) {
    const path = join(dirname(file), name);
    try {
      if (now.getTime() - statSync(path).mtimeMs > 7 * 24 * 3_600_000) rmSync(path);
    } catch {
      /* une marque illisible reste : elle ne gêne rien */
    }
  }
}

/** Suivi par git ? `null` hors d'un dépôt. */
function gitTracked(path: string): boolean | null {
  const run = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: dirname(path), encoding: "utf8", timeout: 2_000 });
  if (run.status === 0) return true;
  if (run.status === 1) return false;
  return null;
}

/** Ce qu'on garde d'une écriture : une empreinte et une taille, jamais le contenu. */
function written(input: Record<string, unknown>): { digest?: string; size?: number } {
  const content =
    typeof input.content === "string"
      ? input.content
      : typeof input.new_string === "string"
        ? input.new_string
        : Array.isArray(input.edits)
          ? JSON.stringify(input.edits)
          : typeof input.new_source === "string"
            ? input.new_source
            : null;
  return content === null ? {} : { digest: digestOf(content), size: Buffer.byteLength(content) };
}

/** Un outil qui a échoué : le code de sortie et la taille de l'erreur, jamais son texte. */
function failureOf(payload: HookPayload): Record<string, unknown> {
  const error = typeof payload.error === "string" ? payload.error : "";
  const code = /^Exit code (\d+)/.exec(error);
  return { failed: true, interrupted: payload.is_interrupt === true, ...(code ? { exitCode: Number(code[1]) } : {}), errorBytes: Buffer.byteLength(error) };
}

/** L'issue rapportée par Claude Code, sans la sortie ni le contenu. */
function outcomeOf(tool: string, response: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!response) return {};
  if (tool === "Bash") {
    return {
      interrupted: response.interrupted === true,
      stdoutBytes: typeof response.stdout === "string" ? Buffer.byteLength(response.stdout) : 0,
      stderrBytes: typeof response.stderr === "string" ? Buffer.byteLength(response.stderr) : 0,
    };
  }
  if (tool === "Write") return { kind: response.type === "create" || response.originalFile === null ? "created" : "replaced" };
  return { kind: "edited" };
}

/** Le pivot, vu du hook : de quoi créer une demande et la suivre. */
export interface AskChannel {
  op<T>(body: Record<string, unknown>): Promise<{ status: number; body: T | null }>;
}

type PersonAnswer = "approved" | "rejected" | "expired" | "pending" | "unreachable";

/**
 * MODE AUTOMATIQUE : Oathrion demande LUI-MÊME à une personne (décision du 5 novembre).
 *
 * Claude Code ne demande plus rien à personne ; une question de son hook serait tranchée par son
 * classifieur. Le hook passe donc par le pivot : la demande apparaît dans la console et sur le
 * bureau (« Decide »), et le hook attend sa réponse, `OATHRION_HOOK_WAIT_SECONDS` (50 par défaut).
 */
async function askPerson(
  channel: AskChannel,
  kind: "shell" | "file_write",
  target: string,
  command: string | undefined,
  reason: string,
  waitMs: number,
  pollMs: number,
  untrusted?: string,
): Promise<PersonAnswer> {
  /*
   * Le hook se déclare PORTEUR du pivot pendant son attente : un pivot sans porteur s'arrête seul
   * après trente secondes, et le hook peut attendre plus longtemps. Il bat à chaque relecture,
   * puis se retire.
   */
  const attached = await channel.op<{ holder?: string }>({ op: "attach", kind: "console" });
  const holder = attached.status === 200 ? (attached.body?.holder ?? null) : null;
  try {
    const asked = await channel.op<{ status?: string; approvalId?: string | null }>({ op: "claude-ask", kind, target, command, reason, ...(untrusted ? { untrusted } : {}) });
    if (asked.status !== 200 || !asked.body) return "unreachable";
    let status = asked.body.status;
    const approvalId = asked.body.approvalId ?? null;
    const deadline = Date.now() + waitMs;
    while (status === "pending" && approvalId && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, pollMs));
      if (holder) await channel.op({ op: "heartbeat", holder });
      const polled = await channel.op<{ status?: string }>({ op: "claude-status", approvalId });
      if (polled.status !== 200 || !polled.body?.status) return "unreachable";
      status = polled.body.status;
    }
    return status === "approved" || status === "rejected" || status === "expired" ? status : "pending";
  } finally {
    if (holder) await channel.op({ op: "detach", holder }).catch(() => undefined);
  }
}

/** Ce que la réponse de la personne devient pour Claude Code. */
function afterPerson(judgement: Judgement, answer: PersonAnswer, mode: string | undefined, tool: string): Judgement {
  const why = (judgement.reason ?? "Oathrion: this action").replace(/\s*Allow it\?$/, "");
  switch (answer) {
    case "approved":
      /* Le seul `allow` : la décision explicite d'une personne, pour CETTE commande, pas celle d'Oathrion. */
      return { ...judgement, verdict: "allow", reason: `${why} Approved by a person in Oathrion.` };
    case "rejected":
      return { ...judgement, verdict: "deny", reason: `${why} A person refused it in Oathrion.` };
    case "expired":
      return { ...judgement, verdict: "deny", reason: `${why} The request in Oathrion expired without an answer. Ask again to send a new one.` };
    case "pending":
      return {
        ...judgement,
        verdict: "deny",
        reason: `${why} Claude Code is in "${String(mode)}" mode, so Oathrion asked a person itself: approve it in Oathrion's console ("oathrion console", or the Decide notification), then ask again — the same command will go through.`,
      };
    default:
      return forMode(judgement, mode, tool);
  }
}

export interface HookOptions {
  now?: Date;
  /** Le pivot ; par défaut, celui de la machine (lancé s'il ne tourne pas). */
  channel?: () => Promise<AskChannel>;
  pollMs?: number;
}

/*
 * Le journal, d'où que le hook tourne. Enfermé (`oathrion jail`), le dossier du pivot n'est pas
 * accessible en écriture à l'agent : la ligne est AJOUTÉE par le pivot, dehors, et l'agent ne peut
 * pas réécrire le journal (pièce J2 de `notes/CONCEPTION-JAIL.md`).
 */
async function record(env: NodeJS.ProcessEnv, line: JournalRecord, now: Date, options: HookOptions): Promise<void> {
  const { JAIL_MARKER } = await import("./hub");
  if (!existsSync(join(stateRoot(env), "_local", JAIL_MARKER))) {
    appendJournal(env, line, now);
    return;
  }
  const channel = await (options.channel ?? (() => localHub(env)))();
  await channel.op({ op: "journal", record: line });
}

async function localHub(env: NodeJS.ProcessEnv): Promise<AskChannel> {
  const { ensureHub } = await import("./hub");
  return ensureHub(env, { log: () => undefined });
}

export async function runClaudeHook(argv: readonly string[], env: NodeJS.ProcessEnv, stdin: string, out: (line: string) => void, options: HookOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  const [client, phase] = argv;
  if (client !== "claude-code" || (phase !== "pre" && phase !== "post")) {
    out(HOOK_USAGE);
    return 3;
  }
  let payload: HookPayload;
  try {
    payload = JSON.parse(stdin) as HookPayload;
  } catch {
    return 0;
  }
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  const projectDir = env.CLAUDE_PROJECT_DIR?.trim() || payload.cwd || process.cwd();
  if (argv.includes(PLUGIN_FLAG) && env.OATHRION_PLUGIN_FORCE !== "1" && settingsHaveOurHook(env, projectDir)) return 0;
  const scratchDirs = [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"]), ...(typeof payload.scratchpad_dir === "string" ? [payload.scratchpad_dir] : [])];
  const session = payload.session_id ?? null;

  /*
   * Une lecture de contenu NON FIABLE (une page, une recherche, un ticket, un message) : la session
   * est marquée jusqu'à sa fin, et la lecture va au journal. Rien n'est bloqué ici : c'est APRÈS
   * la lecture, et ce qui suit sera jugé en connaissance de cause (`claude-hook-rules.ts`).
   */
  const source = phase === "post" && payload.hook_event_name !== "PostToolUseFailure" ? untrustedSource(tool, input) : null;
  if (source) {
    try {
      markTainted(env, session, source, now);
      await record(
        env,
        { phase, session, toolUseId: payload.tool_use_id ?? null, tool, action: "claude.read.untrusted", target: `untrusted://${source}`, untrusted: source, ...(typeof payload.permission_mode === "string" ? { mode: payload.permission_mode } : {}) },
        now,
        options,
      );
    } catch {
      /* Ni la marque ni le journal ne doivent empêcher Claude Code de travailler. */
    }
    return 0;
  }
  const taint = phase === "pre" ? readTaint(env, session) : null;

  let judgement: ReturnType<typeof judge> = null;
  try {
    judgement = judge({ tool, input }, { projectDir, home: env.HOME?.trim() || homedir(), scratchDirs, exists: existsSync, tracked: gitTracked, ...readRules(env), taint, decoys: loadDecoys(env), guarded: loadGuardedTokens(env) });
  } catch {
    return 0;
  }
  if (!judgement) return 0;
  let person: PersonAnswer | undefined;
  /* Le pivot ne sait demander qu'une commande ou une écriture : un appel d'outil en mode automatique est refusé, motif à l'appui. */
  if (phase === "pre" && judgement.verdict === "ask" && judgement.action !== "claude.tool" && !personIsAsked(payload.permission_mode, tool)) {
    const waitSeconds = Number(env.OATHRION_HOOK_WAIT_SECONDS ?? 50);
    const waitMs = Number.isFinite(waitSeconds) && waitSeconds >= 0 ? Math.min(waitSeconds, 100) * 1_000 : 50_000;
    try {
      const channel = await (options.channel ?? (() => localHub(env)))();
      const kind = tool === "Bash" ? "shell" : "file_write";
      person = await askPerson(
        channel,
        kind,
        judgement.target,
        typeof input.command === "string" ? input.command.slice(0, 1_000) : undefined,
        judgement.reason ?? "",
        waitMs,
        options.pollMs ?? 1_000,
        judgement.rule === "tainted-session" && taint ? `${taint.source}, at ${taint.at.slice(11, 16)} UTC` : undefined,
      );
    } catch {
      person = "unreachable";
    }
    judgement = afterPerson(judgement, person, payload.permission_mode, tool);
  } else {
    judgement = forMode(judgement, payload.permission_mode, tool);
  }

  /* Une suppression refusée : ce qu'elle aurait effacé, mesuré en lecture seule et borné. */
  const impact = phase === "pre" && judgement.verdict === "deny" && judgement.deleting ? measure(judgement.deleting) : null;
  const reason = impact && judgement.reason ? `${judgement.reason} It would have deleted ${describeImpact(impact)}.` : judgement.reason;

  /* Le verdict d'abord : il ne dépend d'aucune écriture. */
  if (phase === "pre" && judgement.verdict !== null) {
    out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: judgement.verdict, permissionDecisionReason: reason } }));
  }

  const line: JournalRecord = {
    phase,
    session: payload.session_id ?? null,
    toolUseId: payload.tool_use_id ?? null,
    tool,
    action: judgement.action,
    target: judgement.target,
    ...(tool === "Bash" && typeof input.command === "string" ? { command: input.command.slice(0, 1_000) } : judgement.description ? { command: judgement.description } : written(input)),
    ...(typeof payload.permission_mode === "string" ? { mode: payload.permission_mode } : {}),
    ...(phase === "pre"
      ? { verdict: judgement.verdict ?? "none", rule: judgement.rule, ...(person ? { person } : {}), ...(impact ? { impact } : {}) }
      : { outcome: payload.hook_event_name === "PostToolUseFailure" ? failureOf(payload) : outcomeOf(tool, payload.tool_response) }),
  };
  try {
    await record(env, line, now, options);
  } catch {
    /* Le journal ne doit jamais empêcher Claude Code de travailler. */
  }
  return 0;
}
