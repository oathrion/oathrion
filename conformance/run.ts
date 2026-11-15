/**
 * Point d'entrée du kit.
 *
 *   npm run conformance                 # contre l'implémentation de référence
 *   npm run conformance -- --mutant=X   # contre un mutant, pour prouver que le kit mord
 *   npm run conformance -- --mutants    # tous les mutants, et le tableau récapitulatif
 *
 * Le dernier mode est le seul qui ait de la valeur en continu. Un kit qui passe contre
 * l'implémentation de référence ne prouve rien tant qu'on n'a pas montré qu'il ÉCHOUE
 * contre une implémentation qui viole la propriété — une suite creuse passe partout, et
 * on ne s'en aperçoit que le jour où elle aurait dû attraper quelque chose.
 *
 * ## Pourquoi un processus par passe
 *
 * Le plan de contrôle limite le débit (120 décisions, 30 écritures par fenêtre), et ces
 * plafonds ne sont pas configurables. Six passes dans un seul processus épuisent le
 * quota : les 429 noient alors le signal, et deux mutants ont effectivement été
 * déclarés « manqués » pour cette raison et non pour la bonne. Chaque passe a donc son
 * processus et son serveur neuf.
 *
 * L'alternative — ajouter une opération « remets-toi à zéro » au driver — a été écartée :
 * elle aurait fait passer l'interface de une à deux opérations, et aurait demandé à tout
 * implémenteur tiers une capacité dont le kit n'a besoin que pour s'auto-éprouver.
 *
 * Codes de sortie : 0 tout s'est passé comme attendu · 1 non.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOathrionDriver } from "./drivers/placet";
import { MUTANTS, startMutantProxy } from "./mutants/proxy";
import { SOURCE_MUTANTS, applySourceMutant, restoreSources } from "./mutants/source";
import { render, run, type RunOutcome } from "./src/runner";

const RUNS = join(import.meta.dirname, ".runs");

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/**
 * Une passe : un serveur neuf, éventuellement derrière un proxy mutant.
 *
 * Un mutant de SOURCE, lui, est déjà appliqué sur le disque quand ce processus démarre —
 * c'est le parent qui l'a posé avant de lancer l'enfant. Le driver importe les modules du
 * produit, donc l'enfant voit la mutation sans qu'aucune reconstruction soit nécessaire.
 */
async function singlePass(mutant?: string): Promise<number> {
  const source = mutant !== undefined && mutant in SOURCE_MUTANTS;
  const base = await createOathrionDriver();
  const proxy = mutant && !source ? await startMutantProxy(base.baseUrl, mutant) : null;
  try {
    const driver = proxy ? { ...base, name: `mutant:${mutant}`, baseUrl: proxy.url } : base;
    const outcome = await run(driver);
    // eslint-disable-next-line no-console -- le rapport du kit EST sa sortie
    console.log(render(outcome));

    mkdirSync(RUNS, { recursive: true });
    writeFileSync(join(RUNS, `${mutant ?? "reference"}.json`), JSON.stringify(outcome, null, 2) + "\n");

    if (!mutant) return outcome.verdict === "CONFORME" ? 0 : 1;
    const caught = outcome.results.filter((r) => r.status === "FAIL").map((r) => r.id);
    const expected = source ? SOURCE_MUTANTS[mutant]!.breaks : MUTANTS[mutant]!.breaks;
    return expected.every((id) => caught.includes(id)) ? 0 : 1;
  } finally {
    if (proxy) await proxy.close();
    await base.close();
  }
}

/** Relance ce même script dans un processus neuf, pour une passe isolée. */
function spawnPass(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    /*
     * `tsx`, et non `process.execPath` : ce script est du TypeScript, et node seul le
     * refuse. L'enfant restait muet, les fichiers de résultat n'étaient jamais écrits,
     * et le tableau annonçait « attrapé rien » pour les six mutants — un faux négatif
     * parfait, qui aurait pu passer pour un kit creux.
     */
    const tsx = join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");
    const child = spawn(tsx, [process.argv[1]!, ...args], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function readOutcome(name: string): RunOutcome | null {
  try {
    return JSON.parse(readFileSync(join(RUNS, `${name}.json`), "utf8")) as RunOutcome;
  } catch {
    return null;
  }
}

async function allMutants(): Promise<number> {
  const proxyNames = Object.keys(MUTANTS);
  const sourceNames = Object.keys(SOURCE_MUTANTS);
  await spawnPass([]);
  for (const name of proxyNames) await spawnPass([`--mutant=${name}`]);

  /*
   * Les mutants de source, un par un : on pose la mutation, on lance la passe dans un
   * processus neuf, on restaure. Le `finally` restaure même si une passe lève — et le
   * manifeste sur disque est la seconde ligne de défense, pour le cas où ce processus
   * meurt sans exécuter son propre code.
   */
  for (const name of sourceNames) {
    try {
      applySourceMutant(name);
      await spawnPass([`--mutant=${name}`]);
    } finally {
      restoreSources();
    }
  }

  const lines = [
    "",
    "MUTANTS — une propriété n'est tenue que si son mutant la fait tomber",
    "─".repeat(92),
  ];
  let ok = true;
  const report = (name: string, expected: readonly string[], kind: string) => {
    const outcome = readOutcome(name);
    const caught = outcome?.results.filter((r) => r.status === "FAIL").map((r) => r.id) ?? [];
    const hit = expected.every((id) => caught.includes(id));
    if (!hit) ok = false;
    /*
     * `breaks: []` est une LIMITE DÉCLARÉE, pas une victoire : un mutant dont on sait
     * qu'aucune propriété ne peut l'attraper en boîte noire. La marquer évite qu'un
     * lecteur compte une ligne ✓ de plus.
     */
    const declared = expected.length === 0 ? "  (limite déclarée)" : "";
    lines.push(
      `  ${hit ? "✓" : "✗"} ${name.padEnd(26)} ${kind} cible ${(expected.join(",") || "—").padEnd(6)} ` +
        `attrapé ${caught.join(",") || "rien"}${declared}`,
    );
  };

  lines.push("  proxy — une forme de réponse mutée");
  for (const name of proxyNames) report(name, MUTANTS[name]!.breaks, "P");
  lines.push("  source — un état serveur muté, ce qu'un proxy ne peut pas simuler");
  for (const name of sourceNames) report(name, SOURCE_MUTANTS[name]!.breaks, "S");

  const reference = readOutcome("reference");
  lines.push("─".repeat(92));
  lines.push(`référence : ${reference?.verdict ?? "non exécutée"}`);
  lines.push("");
  // eslint-disable-next-line no-console -- idem : ce tableau est le livrable
  console.log(lines.join("\n"));
  return ok ? 0 : 1;
}

const only = arg("mutant");
/*
 * `--restore-sources` existe pour la seule panne que le manifeste ne peut pas réparer
 * seul : ce processus tué entre la mutation et la restauration. Documenté ici parce que
 * c'est le message que lira quelqu'un à qui le kit refuse de tourner.
 */
const promise = process.argv.includes("--restore-sources")
  ? Promise.resolve(((): number => {
      restoreSources();
      // eslint-disable-next-line no-console -- c'est la sortie de cette commande
      console.log("sources restaurées depuis .mutation-backup/, manifeste effacé.");
      return 0;
    })())
  : process.argv.includes("--mutants")
    ? allMutants()
    : singlePass(only);

promise
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
