/**
 * Le banc comparatif (18 novembre 2026) : Oathrion, Claude Code et les hooks concurrents, devant
 * le même corpus figé (`script/bench/corpus.ts`), pour mesurer plutôt que supposer ce qui fait
 * garder ou abandonner un outil de ce genre (`notes/CONCURRENCE.md`).
 *
 *   npx tsx script/bench-adoption.ts                    # tout, sans réseau, en quelques secondes
 *   npx tsx script/bench-adoption.ts --hook-reel        # + le VRAI hook d'Oathrion, processus par processus
 *   npx tsx script/bench-adoption.ts --observe <dossier> # + les relevés des vrais hooks concurrents
 *
 * Ce qui est mesuré :
 *   1. la fatigue et l'autonomie, sur une session type pondérée ;
 *   2. ce qui est arrêté, famille par famille, sur un corpus large (réécritures et outils MCP
 *      compris), et les faux positifs sur des pièges ;
 *   3. ce que chaque outil sait faire (demander à une personne, où, sur quels clients, avec quelle
 *      preuve), d'après sa documentation ;
 *   4. le surcoût réel par appel ;
 *   5. la confiance : un reçu signé, vérifié, puis mille copies falsifiées d'un caractère.
 *
 * LIMITES, dites dans le rapport : les étiquettes du corpus sont notre jugement ; Claude Code et
 * les concurrents sont MODÉLISÉS (`script/bench/juges.ts`), sauf quand un relevé observé existe
 * (`script/bench/vrais-hooks.ts`, lancé dans une machine jetable : `script/bench/LISEZMOI.md`).
 */
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { RECEIPT_TYPE, fingerprintOf, signStatement, verifyShared, type ReceiptStatement } from "../shared/receipt-share";
import { CORPUS, LARGE, PROJET, SESSION, type Cas, type Famille } from "./bench/corpus";
import { JUGES_MODELISES, SOURCES, claudeCode, oathrion, type Etat, type Juge, type Jugement, type NomConcurrent, type Verdict } from "./bench/juges";
import { releve, type Releve } from "./bench/vrais-hooks";

const argv = process.argv.slice(2);
const observeDir = argv.includes("--observe") ? argv[argv.indexOf("--observe") + 1] : undefined;
const avecHookReel = argv.includes("--hook-reel");

/* ─── Qui juge, et comment ─── */
interface Candidat {
  nom: string;
  court: string;
  juge: Juge;
  source: "réel" | "modélisé" | "observé";
}
const observes: Partial<Record<NomConcurrent, Releve>> = {};
if (observeDir) {
  for (const nom of Object.keys(JUGES_MODELISES) as NomConcurrent[]) {
    const f = join(observeDir, `${nom}.json`);
    if (existsSync(f)) observes[nom] = JSON.parse(readFileSync(f, "utf8")) as Releve;
  }
}
const depuisReleve = (r: Releve): Juge => {
  const par = new Map(r.resultats.map((x) => [x.id, x]));
  return (c) => {
    const x = par.get(c.id);
    if (!x) return { verdict: "passe", incertain: "absent du relevé" };
    return x.verdict === "erreur" ? { verdict: "passe", incertain: `erreur du hook : ${x.raison ?? ""}` } : { verdict: x.verdict };
  };
};
const NOMS: Record<NomConcurrent, string> = {
  bulkhead: "claude-bulkhead",
  guardrails: "dwarvesf/claude-guardrails « full »",
  karanb192: "karanb192/claude-code-hooks « guard-pack »",
};
const candidats: Candidat[] = [
  { nom: "Claude Code, mode par défaut", court: "CC défaut", juge: claudeCode("default"), source: "modélisé" },
  { nom: "Claude Code, acceptEdits", court: "CC acceptEdits", juge: claudeCode("acceptEdits"), source: "modélisé" },
  { nom: "Claude Code, mode YOLO", court: "CC YOLO", juge: claudeCode("yolo"), source: "modélisé" },
  ...(Object.keys(JUGES_MODELISES) as NomConcurrent[]).map((n) => ({
    nom: `${NOMS[n]} (sur YOLO)`,
    court: n,
    juge: observes[n] ? depuisReleve(observes[n]) : JUGES_MODELISES[n],
    source: (observes[n] ? "observé" : "modélisé") as Candidat["source"],
  })),
  { nom: "Oathrion", court: "Oathrion", juge: oathrion, source: "réel" },
];

/* ─── Les mesures ─── */
const etatDe = (c: Cas): Etat => ({ arbreSale: c.famille !== "session" });
const juger = (k: Candidat, c: Cas): Jugement => k.juge(c, etatDe(c));
const arrete = (v: Verdict) => v !== "passe";

function fatigue(k: Candidat) {
  const issues = SESSION.map((c) => ({ c, j: juger(k, c) }));
  const libres = issues.filter((x) => x.c.attendu === "libre");
  const dangereuses = issues.filter((x) => x.c.attendu !== "libre");
  const refusables = issues.filter((x) => x.c.attendu === "refuser");
  return {
    questions: (100 * issues.filter((x) => x.j.verdict === "demande").length) / issues.length,
    interruptions: (100 * issues.filter((x) => arrete(x.j.verdict)).length) / issues.length,
    autonomie: (100 * libres.filter((x) => x.j.verdict === "passe").length) / libres.length,
    arretees: dangereuses.filter((x) => arrete(x.j.verdict)).length,
    dangereuses: dangereuses.length,
    refusees: refusables.filter((x) => x.j.verdict === "refuse").length,
    refusables: refusables.length,
  };
}

const LARGE_IDS = LARGE.map((c) => ({ ...c, id: `large-${c.id}` }));
const FAMILLES: { f: Famille; titre: string }[] = [
  { f: "suppression", titre: "Supprimer des fichiers" },
  { f: "evasion", titre: "La même chose, réécrite" },
  { f: "git", titre: "Git" },
  { f: "base", titre: "Bases de données" },
  { f: "infra", titre: "Infrastructure, nuage" },
  { f: "sortie", titre: "Ce qui sort de la machine" },
  { f: "fichier", titre: "Fichiers sensibles" },
  { f: "mcp", titre: "Outils MCP (danger)" },
];
function parFamille(k: Candidat) {
  const lignes = FAMILLES.map(({ f }) => {
    const liste = LARGE_IDS.filter((c) => c.famille === f && c.attendu !== "libre");
    return { f, arretees: liste.filter((c) => arrete(juger(k, c).verdict)).length, total: liste.length };
  });
  const dangereux = LARGE_IDS.filter((c) => c.attendu !== "libre");
  const refusables = LARGE_IDS.filter((c) => c.attendu === "refuser");
  const libres = LARGE_IDS.filter((c) => c.attendu === "libre");
  const manquees = dangereux.filter((c) => !arrete(juger(k, c).verdict));
  const fauxPositifs = libres.filter((c) => arrete(juger(k, c).verdict));
  const incertains = CORPUS.filter((c) => juger(k, c).incertain).map((c) => `${c.id} (${String(juger(k, c).incertain)})`);
  const demandees = dangereux.filter((c) => juger(k, c).verdict === "demande").length;
  return {
    lignes,
    arretees: dangereux.length - manquees.length,
    dangereux: dangereux.length,
    demandees,
    refusees: refusables.filter((c) => juger(k, c).verdict === "refuse").length,
    refusables: refusables.length,
    fauxPositifs,
    libres: libres.length,
    manquees,
    incertains,
  };
}

/* Où les modèles se trompaient : le modèle contre le vrai hook, cas par cas. */
const ecarts = (Object.keys(observes) as NomConcurrent[]).map((n) => {
  const vu = depuisReleve(observes[n]!);
  const liste = CORPUS.map((c) => ({ c, modele: JUGES_MODELISES[n](c, etatDe(c)).verdict, observe: vu(c, etatDe(c)).verdict })).filter((x) => x.modele !== x.observe);
  return { n, liste };
});

const quoi = (c: Cas) => String(c.call.input.command ?? c.call.input.file_path ?? `${c.call.tool} ${JSON.stringify(c.call.input).slice(0, 60)}`);

/* ─── Le vrai hook d'Oathrion, processus par processus ─── */
let reel: { releve: Releve; desaccords: string[]; medianeMs: number; p95Ms: number; videMs: number; lents: string[] } | null = null;
if (avecHookReel) {
  const hook = resolve("dist/oathrion-hook.mjs");
  if (!existsSync(hook)) throw new Error("dist/oathrion-hook.mjs manque : npm run build d'abord.");
  const dossier = resolve("../stress-runs/bench-hook-reel");
  rmSync(dossier, { recursive: true, force: true });
  mkdirSync(dossier, { recursive: true });
  const config = join(dossier, "settings.json");
  writeFileSync(config, JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `"${process.execPath}" "${hook}" claude-code pre` }] }] } }));
  Object.assign(process.env, { OATHRION_WRAP_HOME: join(dossier, "etat"), OATHRION_NO_SESSION_CHANGES: "1", OATHRION_LOCAL_AGENT_WATCH: "0", OATHRION_LOCAL_NOTIFY_POPUP: "0" });
  /* Mode « default » : une question revient à Claude Code, sans pivot ni personne à attendre. */
  const r = await releve("oathrion", config, { mode: "default", racinePlugin: dossier, preparerMachine: true, sous: join(dossier, "machine") });
  const par = new Map(r.resultats.map((x) => [x.id, x]));
  const desaccords = CORPUS.filter((c) => !c.call.tool.startsWith("mcp__"))
    .map((c) => ({ c, attendu: oathrion(c, etatDe(c)).verdict, vu: par.get(c.id)?.verdict }))
    .filter((x) => x.attendu !== x.vu)
    .map((x) => `${x.c.id} \`${quoi(x.c)}\` : en direct ${x.attendu}, processus ${String(x.vu)}`);
  const ms = r.resultats.map((x) => x.ms).sort((a, b) => a - b);
  /* La référence : un hook Node qui ne fait rien, lancé de la même façon, sur la même machine. */
  const vide = join(dossier, "vide.mjs");
  writeFileSync(vide, 'let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => console.log("{}"));\n');
  const configVide = join(dossier, "vide.json");
  writeFileSync(configVide, JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `"${process.execPath}" "${vide}"` }] }] } }));
  const rv = await releve("vide", configVide, { mode: "default", racinePlugin: dossier, preparerMachine: false, sous: join(dossier, "machine") });
  const msv = rv.resultats.map((x) => x.ms).sort((a, b) => a - b);
  const lents = [...r.resultats].sort((a, b) => b.ms - a.ms).slice(0, 3).map((x) => `${x.id} ${x.ms.toFixed(0)} ms`);
  reel = { releve: r, desaccords, medianeMs: ms[Math.floor(ms.length / 2)]!, p95Ms: ms[Math.floor(ms.length * 0.95)]!, videMs: msv[Math.floor(msv.length / 2)]!, lents };
}

/* ─── La confiance : un reçu signé, vérifié, puis falsifié ─── */
const { privateKey } = generateKeyPairSync("ed25519");
const brut = Buffer.from((createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x, "base64url");
const statement: ReceiptStatement = {
  type: RECEIPT_TYPE,
  issuedAt: "2026-11-18T09:00:00.000Z",
  issuer: { name: "Oathrion local", publicKey: brut.toString("base64"), fingerprint: fingerprintOf(brut) },
  action: {
    at: "2026-11-18T08:59:58.000Z",
    agent: "Claude Code",
    via: "Run by Claude Code itself, checked by Oathrion's hook",
    what: "docker volume prune -f",
    target: `shell://${PROJET}`,
    outcome: "refused-by-person",
    outcomeLabel: "Refused by a person",
    detail: "rule docker-prune",
    impact: null,
    ref: "toolu_bench",
  },
  evidence: { chain: "Claude Code journal kept by Oathrion's hook", entries: [{ seq: 41, hash: "a".repeat(64) }], chainIntact: true, chainEntries: 41, chainHead: "b".repeat(64) },
};
const signe = signStatement(statement, privateKey);
let t = performance.now();
const essais = 1000;
for (let i = 0; i < essais; i += 1) verifyShared(signe);
const msParVerification = (performance.now() - t) / essais;
const intact = verifyShared(signe).ok;
const texte = JSON.stringify(signe);
const positions = [...texte.matchAll(/[A-Za-z0-9]/g)].map((m) => m.index!).filter((i) => i > texte.indexOf('"statement"'));
let falsifies = 0;
let reperes = 0;
let graine = 7;
const hasard = () => (graine = (graine * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
t = performance.now();
for (let i = 0; i < essais; i += 1) {
  const p = positions[Math.floor(hasard() * positions.length)]!;
  const copie = texte.slice(0, p) + (texte[p] === "x" ? "y" : "x") + texte.slice(p + 1);
  let objet: unknown;
  try {
    objet = JSON.parse(copie);
  } catch {
    continue;
  }
  falsifies += 1;
  if (!verifyShared(objet).ok) reperes += 1;
}

/* ─── Le rapport ─── */
const pct = (v: number) => `${v.toFixed(0)} %`;
const sur = (a: number, b: number) => `${String(a)}/${String(b)}`;
const etiquette = (k: Candidat) => `${k.nom}${k.source === "réel" ? "" : ` (${k.source})`}`;
const concurrents = candidats.filter((k) => !k.court.startsWith("CC"));
const F = candidats.map((k) => ({ k, r: fatigue(k) }));
const L = concurrents.map((k) => ({ k, r: parFamille(k) }));
const compte = (f: Famille, a?: string) => LARGE.filter((c) => c.famille === f && (a ? c.attendu === a : true)).length;

const lignes: string[] = [
  "# Banc comparatif : Oathrion, Claude Code et les hooks concurrents",
  "",
  `Corpus figé : une session type de ${String(SESSION.length)} actions pondérées, et ${String(LARGE.length)} actions vues une fois (${String(LARGE.filter((c) => c.attendu !== "libre").length)} dangereuses, ${String(LARGE.filter((c) => c.attendu === "libre").length)} sans risque, dont ${String(compte("piege"))} pièges).`,
  `Sources : Oathrion, son vrai code ; Claude Code, modélisé d'après sa documentation ; les concurrents, ${observeDir && Object.keys(observes).length ? `observés pour ${Object.keys(observes).join(", ")}, modélisés pour les autres` : "modélisés d'après leur code source"} (${Object.values(SOURCES).map((s) => `${s.depot}@${s.sha.slice(0, 7)}`).join(", ")}).`,
  "Les hooks concurrents sont posés sur le mode YOLO de Claude Code ; posés sur son mode par défaut, ils héritent de ses questions.",
  "",
  "## 1. La fatigue et l'autonomie (session type)",
  "",
  "| | Questions pour 100 actions | Interruptions pour 100 actions | Actions sans risque qui passent seules | Actions dangereuses arrêtées | Refusées sans question |",
  "|---|---|---|---|---|---|",
  ...F.map(({ k, r }) => `| ${etiquette(k)} | ${r.questions.toFixed(1)} | ${r.interruptions.toFixed(1)} | ${pct(r.autonomie)} | ${sur(r.arretees, r.dangereuses)} | ${sur(r.refusees, r.refusables)} |`),
  "",
  "Une interruption, c'est une question ou un refus : dans les deux cas, l'agent s'arrête. Anthropic mesure que ses utilisateurs approuvent 93 % des questions de Claude Code.",
  "",
  "## 2. Ce qui est arrêté, famille par famille (corpus large)",
  "",
  `| Famille (actions dangereuses) | ${concurrents.map((k) => k.court).join(" | ")} |`,
  `|---|${concurrents.map(() => "---").join("|")}|`,
  ...FAMILLES.map(({ f, titre }) => `| ${titre} (${String(compte(f) - compte(f, "libre"))}) | ${L.map(({ r }) => { const l = r.lignes.find((x) => x.f === f)!; return sur(l.arretees, l.total); }).join(" | ")} |`),
  `| **Total arrêtées** | ${L.map(({ r }) => `**${sur(r.arretees, r.dangereux)}**`).join(" | ")} |`,
  `| … dont par une question à une personne | ${L.map(({ r }) => String(r.demandees)).join(" | ")} |`,
  `| À refuser, refusées sans question | ${L.map(({ r }) => sur(r.refusees, r.refusables)).join(" | ")} |`,
  `| **Faux positifs** (sans risque, mais arrêtées) | ${L.map(({ r }) => `**${sur(r.fauxPositifs.length, r.libres)}**`).join(" | ")} |`,
  "",
  ...L.flatMap(({ k, r }) => [
    `**${etiquette(k)}**`,
    `- laissées passer : ${r.manquees.length ? r.manquees.map((c) => `\`${quoi(c)}\``).join(" ; ") : "aucune"}`,
    `- faux positifs : ${r.fauxPositifs.length ? r.fauxPositifs.map((c) => `\`${quoi(c)}\`${c.note ? ` (${c.note})` : ""}`).join(" ; ") : "aucun"}`,
    ...(r.incertains.length ? [`- cas incertains du modèle, comptés en sa faveur : ${r.incertains.join(" ; ")}`] : []),
    "",
  ]),
  ...(ecarts.length
    ? [
        "### Les modèles contre les vrais hooks",
        "",
        ...ecarts.flatMap(({ n, liste }) => [
          `- **${NOMS[n]}** : ${String(CORPUS.length - liste.length)}/${String(CORPUS.length)} verdicts identiques.${liste.length ? ` Écarts : ${liste.map((x) => `\`${quoi(x.c)}\` (modèle ${x.modele}, vrai ${x.observe})`).join(" ; ")}` : ""}`,
        ]),
        "",
      ]
    : []),
  "## 3. Ce que chaque outil sait faire (d'après sa documentation)",
  "",
  "| | claude-bulkhead | claude-guardrails | karanb192 guard-pack | Oathrion |",
  "|---|---|---|---|---|",
  "| Demander à une personne | non : refuse ; la personne débloque par une commande (`bulkhead allow`) | non : refuse | en option (`HOOK_ASK_*`), dans le terminal | oui : terminal, console, notification, téléphone |",
  "| Décider sans être devant le terminal | non | non | non | oui (notification, téléphone) |",
  "| Outils MCP | non vus | non vus | non vus | sous garde (`oathrion wrap`) : lecture libre, écriture demandée, destruction bloquée |",
  "| Clients | Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor et d'autres | Claude Code | Claude Code, Codex CLI | Claude Code, Cursor, tout client MCP |",
  "| Preuve | journal local (`bulkhead log`) | aucune | journal JSONL ; « reçu de provenance » en texte dans les PR | reçu signé Ed25519, vérifiable par un tiers sans Oathrion, et journal chaîné |",
  "| Ce qu'il fait mieux | sessions entre elles : processus, ports, mémoire | secrets dans les messages, injection de prompt (avertit) | sept gardes, dont secrets et tests | — |",
  "| Licence | MIT | MIT | MIT | Apache-2.0 |",
  "",
  "## 4. Le surcoût par appel",
  "",
  ...(reel
    ? [
        `- **Oathrion, vrai hook, un processus par appel** : médiane ${reel.medianeMs.toFixed(0)} ms, p95 ${reel.p95Ms.toFixed(0)} ms, sur ${String(reel.releve.resultats.length)} appels (${reel.releve.node}, cette machine). Les plus lents : ${reel.lents.join(", ")}.`,
        `- **Un hook Node qui ne fait rien**, lancé de la même façon sur la même machine : médiane ${reel.videMs.toFixed(0)} ms. Le travail propre d'Oathrion coûte donc environ ${(reel.medianeMs - reel.videMs).toFixed(0)} ms par appel ; le reste est le démarrage de Node, que paie tout hook écrit en Node.`,
        `- Accord entre le vrai hook et le jugement en direct : ${reel.desaccords.length === 0 ? "total" : `${String(reel.desaccords.length)} désaccords`}${reel.desaccords.length ? ` : ${reel.desaccords.join(" ; ")}` : ""}.`,
      ]
    : ["- Oathrion : relancer avec `--hook-reel` pour mesurer le vrai hook, processus par processus."]),
  ...Object.values(observes).map((r) => {
    const ms = r.resultats.map((x) => x.ms).sort((a, b) => a - b);
    return `- **${r.nom}, observé** : médiane ${ms[Math.floor(ms.length / 2)]!.toFixed(0)} ms, p95 ${ms[Math.floor(ms.length * 0.95)]!.toFixed(0)} ms (${r.node}, ${r.date.slice(0, 10)}, dans le conteneur jetable : même machine, mais pas les mêmes conditions qu'Oathrion, mesuré directement).`;
  }),
  "- karanb192 publie 38 ms de médiane pour son guard-pack (Apple M3 Pro, `bench/RESULTS.md`). claude-guardrails lance six sous-shells par commande (sa documentation). Ces chiffres ne viennent pas de la même machine.",
  "",
  "## 5. La confiance : la preuve",
  "",
  `- Un reçu Oathrion authentique est vérifié : ${intact ? "oui" : "NON"}, en ${msParVerification.toFixed(3)} ms.`,
  `- Falsifications d'un seul caractère repérées : ${sur(reperes, falsifies)} (sur ${String(essais)} essais, ${String(essais - falsifies)} copies rendues illisibles écartées).`,
  "- Un journal ou un texte non signé (les trois concurrents) ne permet pas de repérer une falsification : 0 %, par construction.",
  "",
  "## Limites",
  "",
  "- Les étiquettes du corpus sont notre jugement ; elles sont écrites avant les mesures, et le corpus ne se corrige pas pour faire gagner un outil.",
  "- Claude Code est modélisé. Les concurrents le sont aussi tant qu'aucun relevé observé n'est fourni : un modèle peut se tromper sur un cas limite. Les cas incertains sont comptés en leur faveur.",
  "- bulkhead dépend de l'état de la machine : `git reset --hard` et `git clean` ne sont arrêtés que s'il reste du travail non commité (vrai dans le corpus large, faux dans la session type, juste après un commit) ; `docker … prune`, seulement si une autre session tourne (ici, une seule).",
  "- Les outils MCP d'Oathrion sont jugés par la classification réelle de `oathrion wrap`, outil par outil, sans les annotations des serveurs.",
];
console.log(lignes.join("\n"));
