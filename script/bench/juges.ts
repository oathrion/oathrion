/**
 * Les juges du banc comparatif : ce que chaque outil ferait de chaque action du corpus.
 *
 *   · Oathrion : son VRAI code, en direct (`judge` pour Claude Code, `classifyTool` pour les outils
 *     MCP que `oathrion wrap` met sous sa garde).
 *   · Claude Code : ses modes de permission, MODÉLISÉS d'après sa documentation.
 *   · Les hooks concurrents : MODÉLISÉS d'après leur code source, lu le 18 novembre 2026 aux
 *     versions ci-dessous. Les règles écrites ici sont les nôtres : elles reproduisent leurs
 *     verdicts, pas leur code. Leur vrai verdict se mesure avec `script/bench/vrais-hooks.ts`,
 *     dans une machine jetable (`script/bench/LISEZMOI.md`) ; le banc le préfère quand il existe.
 *
 * Deux règles d'honnêteté :
 *   · un cas où le modèle n'est pas sûr est marqué `incertain`, et compté EN FAVEUR du concurrent
 *     (arrêté s'il est dangereux, laissé passer s'il est sans risque) ;
 *   · les hooks concurrents sont posés sur le mode « bypassPermissions » (YOLO) de Claude Code, le
 *     cas où l'on compte sur eux : posés sur le mode par défaut, ils héritent de ses questions.
 */
import { judge, type RuleContext, type ToolCall } from "../../cli/wrap/claude-hook-rules";
import { classifyTool } from "../../server/gateway/tools/stdio-mcp-tool";
import { HOME, PROJET, type Cas } from "./corpus";

export type Verdict = "passe" | "demande" | "refuse";
export interface Jugement {
  verdict: Verdict;
  /** Le modèle n'est pas sûr : pourquoi. */
  incertain?: string;
}
/** L'état du dépôt : propre juste après un commit (SESSION), ou avec du travail en cours (LARGE). */
export interface Etat {
  arbreSale: boolean;
}
export type Juge = (c: Cas, etat: Etat) => Jugement;

export const SOURCES = {
  bulkhead: { depot: "dooly6276/claude-bulkhead", sha: "366f4a4ef0af2f92caad1bb2c9d3add9cf3bd9c7", etoiles: 35, lus: "src/basics.js, src/kill-extras.js, src/shell.js, hooks/hooks.json" },
  guardrails: { depot: "dwarvesf/claude-guardrails", sha: "39440d99715d67166e73d2765a347ca0bce1a877", etoiles: 44, lus: "full/settings.json" },
  karanb192: { depot: "karanb192/claude-code-hooks", sha: "4b03f99be3df83773b1c4ae699c30195b6f716bf", etoiles: 587, lus: "plugins/guard-pack/ (block-dangerous-commands, git-safety, protect-secrets, config-guard), hooks/hooks.json" },
} as const;

const commande = (c: Cas) => (c.call.tool === "Bash" ? String(c.call.input.command ?? "") : "");
const chemin = (c: Cas) => String(c.call.input.file_path ?? c.call.input.path ?? "");
const estMcp = (c: Cas) => c.call.tool.startsWith("mcp__");
const ecritFichier = (c: Cas) => ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(c.call.tool);
const sur = (verdict: Verdict): Jugement => ({ verdict });

/* ─── Oathrion : le vrai code ─── */
const CONTEXTE: RuleContext = {
  projectDir: PROJET,
  home: HOME,
  scratchDirs: ["/tmp"],
  exists: () => true,
  tracked: (path) => (path.startsWith(PROJET) && !path.includes("/dist") && !path.includes("node_modules") ? true : null),
};
export const oathrion: Juge = (c) => {
  const j = judge(c.call, CONTEXTE)?.verdict ?? null;
  if (j === "deny") return sur("refuse");
  if (j === "ask") return sur("demande");
  /* Un outil MCP passe par `oathrion wrap` : la lecture passe, l'écriture attend une personne, la destruction est bloquée. */
  const mcp = /^mcp__(.+?)__(.+)$/.exec(c.call.tool);
  if (mcp) {
    const classe = classifyTool({ name: mcp[2]! }).toolClass;
    return sur(classe === "read" ? "passe" : classe === "write" ? "demande" : "refuse");
  }
  return sur("passe");
};

/* ─── Claude Code, modélisé ─── */
const LECTURE = /^(git (status|diff|log)\b|ls\b|cat\b|grep\b|find\b(?!.*-(delete|exec))|pwd\b|echo\b(?!.*>)|head\b|tail\b|wc\b)/;
const LECTURE_MCP = /^mcp__.+?__(get|list|read|search|fetch|query|find|describe|show|view)/;
export const claudeCode = (mode: "default" | "acceptEdits" | "yolo"): Juge => (c) => {
  if (mode === "yolo") return sur("passe");
  if (estMcp(c)) return sur(LECTURE_MCP.test(c.call.tool) ? "passe" : "demande");
  if (c.call.tool !== "Bash") return sur(mode === "acceptEdits" && chemin(c).startsWith(`${PROJET}/`) ? "passe" : "demande");
  return sur(LECTURE.test(commande(c)) ? "passe" : "demande");
};

/* ─── Outils communs aux modèles ─── */
const versMaison = (p: string) => p.replace(/^~(?=\/|$)/, HOME).replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, HOME);
const sansGuillemets = (m: string) => m.replace(/^(["'])(.*)\1$/s, "$2");
/** Les commandes simples d'une ligne, séparées hors des guillemets. */
function decouper(ligne: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = "";
  for (let i = 0; i < ligne.length; i += 1) {
    const ch = ligne[i]!;
    if (q) {
      cur += ch;
      if (ch === q) q = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    const deux = ligne.slice(i, i + 2);
    if (deux === "&&" || deux === "||") {
      out.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      out.push(cur);
      cur = ch === "|" ? "|" : "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s && s !== "|");
}
/** Les mots d'une commande simple, guillemets ôtés. */
function mots(commandeSimple: string): string[] {
  return (commandeSimple.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(sansGuillemets);
}

/* ─── claude-bulkhead : un vrai lecteur de shell ─── */
const CACHES = /^\.?(cache|caches|tmp|temp|npm|pnpm-store|yarn|bun|gradle|m2|nuget|cargo|rustup|deno|expo|Trash|node-gyp|pyenv|bundle|cocoapods)$/i;
const A_GARDER = /^(library|documents|desktop|downloads|pictures|movies|music|videos|onedrive|appdata|\.ssh|\.gnupg|\.config|\.local|\.aws)$/i;
/** Les commandes que bulkhead lit, emballages ôtés et shells ouverts (`bash -c`, `eval`, `printf … | sh`). */
function commandesBulkhead(ligne: string, profondeur = 0): { argv: string[]; avant: string; parXargs: boolean }[] {
  const out: { argv: string[]; avant: string; parXargs: boolean }[] = [];
  const parties = decouper(ligne);
  let lu = "";
  for (let k = 0; k < parties.length; k += 1) {
    const brut = parties[k]!.replace(/^\|\s*/, "");
    let argv = mots(brut).map((m) => m.replace(/^\\/, ""));
    let parXargs = false;
    for (;;) {
      const b = argv[0]?.split("/").pop();
      if (b === "sudo" || b === "command" || b === "nohup" || b === "time" || b === "exec") argv = argv.slice(1).filter((x, i) => i > 0 || !x.startsWith("-"));
      else if (b === "env") argv = argv.slice(1).filter((x) => !/^\w+=/.test(x));
      else if (b === "xargs") {
        argv = argv.slice(1);
        parXargs = true;
      } else break;
    }
    const b = argv[0]?.split("/").pop() ?? "";
    if (profondeur < 3 && /^(ba|z|da|k)?sh$/.test(b) && argv[1] === "-c" && argv[2]) out.push(...commandesBulkhead(argv[2], profondeur + 1));
    else if (profondeur < 3 && b === "eval" && argv[1]) out.push(...commandesBulkhead(argv.slice(1).join(" "), profondeur + 1));
    else if (profondeur < 3 && /^(ba|z|da|k)?sh$/.test(b) && argv.length === 1 && k > 0) {
      const prec = mots(parties[k - 1]!);
      if (["printf", "echo"].includes(prec[0] ?? "")) out.push(...commandesBulkhead(prec.slice(1).join(" "), profondeur + 1));
    } else out.push({ argv, avant: lu, parXargs });
    lu += `${brut}; `;
  }
  return out;
}
function cibleDangereuse(p: string): boolean {
  const abs = (p.startsWith("/") ? p : `${PROJET}/${p === "*" ? "." : p}`).replace(/\/\*$/, "").replace(/\/\.?$/, "").replace(/\/+$/, "") || "/";
  const norme = abs.split("/").reduce<string[]>((acc, seg) => (seg === ".." ? acc.slice(0, -1) : seg && seg !== "." ? [...acc, seg] : acc), []);
  const n = `/${norme.join("/")}`;
  if (n === "/" || n === HOME || HOME.startsWith(`${n}/`)) return true;
  if (n.startsWith(`${HOME}/`)) {
    const rel = n.slice(HOME.length + 1);
    if (A_GARDER.test(rel.split("/")[0]!) && !rel.includes("/")) return true;
    if (!rel.includes("/") && !CACHES.test(rel)) return true;
  }
  return /^\/[^/]+$/.test(n);
}
export const bulkhead: Juge = (c, etat) => {
  if (c.call.tool !== "Bash") return sur("passe");
  for (const { argv, avant, parXargs } of commandesBulkhead(commande(c))) {
    const b = argv[0]?.split("/").pop() ?? "";
    const opts = argv.slice(1).filter((a) => a.startsWith("-"));
    if (b === "rm" && !parXargs) {
      const r = opts.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
      const f = opts.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force");
      if (r && f) {
        for (const brut of argv.slice(1).filter((a) => !a.startsWith("-"))) {
          let cible = brut;
          for (const m of avant.matchAll(/(?:^|[\s;])(\w+)=([^\s;]+)/g)) cible = cible.replace(new RegExp(`\\$\\{?${m[1]!}\\}?`), sansGuillemets(m[2]!));
          cible = versMaison(cible);
          if (/^\$\{?\w+\}?\/(\*)?$/.test(cible) && !/^\$\{?(HOME|PWD)\}?/.test(cible)) return sur("refuse");
          if (/(^|\/)\.git\/?$/.test(cible)) return sur("refuse");
          if (!cible.includes("$") && cibleDangereuse(cible)) return sur("refuse");
        }
      }
    }
    if (b === "rsync" && argv.some((a) => /^--del/.test(a)) && /^\$\{?\w+\}?\/?$/.test(argv[argv.length - 1]!)) return sur("refuse");
    if (b === "git") {
      const i = argv.findIndex((a, j) => j > 0 && !a.startsWith("-") && argv[j - 1] !== "-C" && argv[j - 1] !== "-c");
      const sub = argv.slice(i);
      const autreDepot = argv.includes("-C");
      if (sub[0] === "push") {
        const force = sub.some((a) => a === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith("+"));
        const refs = sub.slice(1).filter((a) => !a.startsWith("-")).slice(1).map((r) => r.replace(/^\+/, "").split(":").pop());
        if (force && refs.some((r) => r === "main" || r === "master")) return sur("refuse");
        if ((sub.includes("--delete") || sub.includes("-d")) && refs.some((r) => r === "main" || r === "master")) return sur("refuse");
      }
      if (sub[0] === "branch" && sub.some((a) => a === "-D" || a === "--force") && sub.some((a) => a === "main" || a === "master")) return sur("refuse");
      const reset = sub[0] === "reset" && sub.includes("--hard");
      const clean = sub[0] === "clean" && sub.some((a) => /^-[a-z]*f/.test(a) || a === "--force") && sub.some((a) => /^-[a-z]*[dx]/.test(a));
      /* Seulement s'il reste du travail non commité ; dans un autre dépôt, on ne sait pas. */
      if ((reset || clean) && autreDepot) return { verdict: "refuse", incertain: "l'état de l'autre dépôt" };
      if ((reset || clean) && etat.arbreSale) return sur("refuse");
    }
  }
  return sur("passe");
};

/* ─── dwarvesf/claude-guardrails « full » : règles de refus et expressions régulières ─── */
const GR_EDIT_REFUS = /^(~|\/home\/dev)\/\.(bashrc|zshrc|bash_profile|zprofile|profile)$|^(~|\/home\/dev)\/\.claude\/settings(\.local)?\.json$|(^|\/)\.env(\.[^/]*)?$/;
export const guardrails: Juge = (c) => {
  if (ecritFichier(c)) return sur(GR_EDIT_REFUS.test(chemin(c)) ? "refuse" : "passe");
  if (c.call.tool !== "Bash") return sur("passe");
  const t = commande(c);
  /* Les règles `permissions.deny` de Claude Code, sur chaque commande simple. */
  for (const s of decouper(t)) {
    const nu = s.replace(/^\|\s*/, "");
    if (/^(sudo|mkfs|dd) /.test(nu) || nu.startsWith("rm -rf ")) return sur("refuse");
    if (/^xargs\b.*\brm -rf\b/.test(nu)) return { verdict: "refuse", incertain: "si Claude Code ôte xargs avant ses règles" };
  }
  if (/rm\s+-(r|f|rf|fr)\s+(\/|~|\$HOME)/i.test(t)) return sur("refuse");
  if (/(^|[&|;(])\s*git\s+push\s+.*\b(main|master|production)([\s;|&)]|$)/i.test(t)) return sur("refuse");
  if (/curl\s.*\|\s*(bash|sh|zsh)|wget\s.*\|\s*(bash|sh|zsh)/i.test(t)) return sur("refuse");
  if (/(curl|wget|nc|ncat).*\b(ngrok|burp|requestbin|pipedream|webhook\.site|hookbin|canarytokens)\b/i.test(t)) return sur("refuse");
  return sur("passe");
};

/* ─── karanb192/claude-code-hooks « guard-pack », niveau « high » : des motifs sur tout le texte ─── */
const K_RM = String.raw`\brm\s+(?:\S+\s+)*`;
const K_FIN = String.raw`(?=\s|$|[;&|])`;
const K_BASH: RegExp[] = [
  new RegExp(`${K_RM}["']?(?:~|\\$HOME|\\$\\{HOME\\})(?:\\/\\.{1,2})*\\/?["']?${K_FIN}`),
  new RegExp(`${K_RM}["']?\\/(?:home|Users)(?:\\/[^\\/\\s"';&|]+)?(?:\\/\\.{1,2})*\\/?["']?${K_FIN}`),
  new RegExp(String.raw`\brm\s+(?:-\S+\s+)*\/(?=\*|\s|$|[;&|])`),
  new RegExp(String.raw`\brm\s+(?:-\S+\s+)*\/(?:etc|usr|var|bin|sbin|lib|boot|dev|proc|sys)(?:\/|\s|$)`),
  new RegExp(String.raw`\brm\s+(?:-\S+\s+)*(?:\.\/?|\*|\.\/\*)` + K_FIN),
  new RegExp(String.raw`\brm\s+(?:-\S+\s+)*["']?(?:[^\s"';&|]*\/)?\.\.(?:\/\.{1,2})*\/?\*?["']?` + K_FIN),
  /\bdocker\s+volume\s+(rm|prune)/,
  /\bgh\s+(pr\s+(merge|close)|issue\s+close|release\s+delete|repo\s+delete)\b/,
  /\b(cat|less|head|tail|more|bat)\s+[^|;]*(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.pem|\.key)\b/i,
  /\b(cat|less|head|tail|more|bat|view)\s+[^|;]*\.env\b(?!\.(example|sample|template))/i,
  /\bcurl\b[^;|&]*(-d\s*@|-F\s*[^=]+=@|--data[^=]*=@|--upload-file[=\s]+)[^;|&]*(\.env|credentials|secrets)/i,
  /\bchmod\b.+\b777\b/,
];
const K_GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s*\S+|--[\w-]+(?:=\S+)?|-[A-Za-z]))*\s+`;
const K_SEGMENT: RegExp[] = [
  new RegExp(`${K_GIT}push\\b(?=[^;&|\\n]*\\s["']?(?:--force|-f)["']?(?=\\s|$))(?=[^;&|\\n]*(?:[\\s:"']|refs\\/heads\\/)(?:main|master)(?=$|[\\s;&|"']))`),
  new RegExp(`${K_GIT}push\\b[^;&|\\n]*(?:[\\s:+"']|refs\\/heads\\/)(?:main|master)(?=$|[\\s;&|:"'])`),
  new RegExp(`${K_GIT}reset\\b[^;&|\\n]*\\s--hard\\b`),
  new RegExp(`${K_GIT}clean\\s+(?:-\\w*f|-f)`),
  new RegExp(`${K_GIT}branch\\s+.*(?:-[dD]|--delete)\\s+(?:main|master)\\b`),
];
const K_FICHIERS = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/, /(?:^|\/)\.envrc$/, /(?:^|\/)\.ssh\/(id_[^/]+|authorized_keys)$/, /(?:^|\/)\.aws\/(credentials|config)$/, /(?:^|\/)\.kube\/config$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i, /(?:^|\/)(secrets?|credentials?)\.(json|ya?ml|toml)$/i, /(?:^|\/)\.(netrc|git-credentials|npmrc|pypirc|pgpass)$/, /(?:^|\/)\.docker\/config\.json$/,
  /(?:^|\/)\.claude\/settings(\.local)?\.json$/i, /(?:^|\/)managed-settings\.json$/i, /(?:^|\/)\.claude\/hooks(\/|$)/i, /(?:^|\/)hooks\.json$/i, /(?:^|\/)\.mcp\.json$/i, /(?:^|\/)\.claude-plugin(\/|$)/i,
];
const K_MODELES = /\.env\.(example|sample|template|schema|defaults)$|env\.example$|example\.env$/i;
export const karanb192: Juge = (c) => {
  if (ecritFichier(c)) {
    const p = chemin(c);
    return sur(!K_MODELES.test(p) && K_FICHIERS.some((r) => r.test(p)) ? "refuse" : "passe");
  }
  if (c.call.tool !== "Bash") return sur("passe");
  const t = commande(c).replace(/\\\r?\n/g, "");
  if (K_BASH.some((r) => r.test(t))) return sur("refuse");
  /* Les motifs git se lisent hors des guillemets : un message de commit n'est pas une commande. */
  const masque = t.replace(/"[^"]*"|'[^']*'/g, (m) => m.replace(/[;&|]/g, "_"));
  if (K_SEGMENT.some((r) => r.test(masque))) return sur("refuse");
  /* Un téléchargement envoyé à un shell. */
  if (/(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(t)) return sur("refuse");
  return sur("passe");
};

export const JUGES_MODELISES = { bulkhead, guardrails, karanb192 } as const;
export type NomConcurrent = keyof typeof JUGES_MODELISES;
export type { ToolCall };
