#!/usr/bin/env node
/**
 * Le score de fluidité d'Oathrion, en %, critère par critère — reproductible d'une version à
 * l'autre.
 *
 *   node script/score-fluidite.mjs
 *
 * LA RÈGLE. Chaque critère a une CIBLE (le « graal », 100 %) et un SEUIL inacceptable
 * (0 %), fixés dans l'absolu — jamais d'après une version précédente, pour que le progrès
 * ne soit pas mesuré contre soi-même. Entre les deux, linéaire ; puis pondéré par famille.
 *
 * LES VALEURS. Les temps viennent de `script/mesure-fluidite.mjs` (à relancer, puis à
 * reporter ici) ; les comptes (commandes, questions, options) viennent du parcours décrit et
 * des tests de bout en bout. Chaque valeur dit d'où elle vient. `verifie` : vécu par une
 * personne dans un vrai client — le reste est mesuré par des bancs et des tests, et le score
 * le dit à part : un score mesuré n'est pas un score prouvé.
 *
 * Le temps d'une personne (lire, décider, cliquer) n'est mesuré nulle part.
 *
 * Pour une nouvelle version : ajouter une colonne à `MESURES`, la remplir, relancer.
 */

/** Les versions mesurées, dans l'ordre. */
const MESURES = ["28 oct.", "1er nov."];

/**
 * [famille, poids, critère, cible, seuil, valeurs par version, vérifié par une personne, source]
 * Pour les critères « oui / non », 0 = l'état souhaité, 1 = l'autre.
 */
const CRITERES = [
  ["Installation", 8, "Commandes pour protéger 4 serveurs (2 Cursor, 2 Claude Code)", 1, 10, [5, 1], false, "28 oct. : install cursor, puis claude mcp remove/add à la main pour chaque serveur de claude mcp add ; 1er nov. : npx oathrion (§5.63)"],
  ["Installation", 5, "Options à connaître", 0, 5, [3, 0], true, "--name, --approbation, le « -- » ; 1er nov. : aucune"],
  ["Installation", 4, "Confirmations", 1, 5, [2, 1], true, "une par client ; puis une seule (§5.63)"],
  ["Installation", 4, "Secondes jusqu'à la configuration écrite", 1, 30, [30, 0.39], true, "28 oct. : JSON à éditer à la main ; 1er nov. : mesure-fluidite"],
  ["Installation", 4, "Secondes jusqu'aux outils listés", 1, 10, [0.86, 1.45], false, "mesure-fluidite (1er nov. : pendant l'endurance)"],
  ["Installation", 5, "Relance du client nécessaire (0 = non)", 0, 1, [1, 1], true, "Claude Code et Cursor ne relisent pas leur configuration à chaud"],
  ["Décision", 9, "Questions par écriture", 1, 3, [2, 1], false, "Claude Code demandait aussi sa permission ; règle mcp__ (§5.65)"],
  ["Décision", 8, "Questions pour 20 écritures du même outil", 1, 20, [20, 1], false, "« décider une fois », pour la session (§5.70)"],
  ["Décision", 6, "Systèmes (sur 3) où décider demande le terminal", 0, 3, [2, 0], false, "« Décider » sous macOS et Windows (§5.72)"],
  ["Décision", 6, "Décision là où l'on travaille, par défaut (0 = oui)", 0, 1, [1, 0], false, "la question dans le client par défaut (§5.64)"],
  ["Décision", 6, "ms entre l'approbation et la réponse à l'agent", 100, 2000, [49, 71], false, "mesure-fluidite, dans le client"],
  ["Lecture", 6, "ms de surcoût d'Oathrion sur une lecture", 20, 200, [12, 15], false, "mesure-fluidite, médiane"],
  ["Lecture", 4, "Lectures qui demandent quelque chose", 0, 1, [0, 0], true, "les lectures passent"],
  ["Console", 5, "Mot de passe pour la console (0 = non)", 0, 1, [0, 0], true, "connexion par lien, depuis le 28 oct."],
  ["Console", 5, "Un écran dit si ça marche (0 = oui)", 0, 1, [1, 0], false, "écran « Serveurs » (§5.66)"],
  ["Console", 5, "Secondes pour ouvrir la console", 1, 10, [0.26, 0.34], true, "mesure-fluidite"],
  ["Couverture", 6, "Sortes de serveurs non protégeables (sur 4 : fichier, claude mcp add, distant à jeton, distant OAuth)", 0, 4, [3, 1], false, "distants à jeton (§5.69) ; OAuth pas encore"],
  ["Couverture", 4, "Commandes pour tout annuler", 1, 5, [2, 1], false, "--annuler par client ; puis une seule"],
];

const pct = (value, target, worst) => Math.max(0, Math.min(100, ((worst - value) / (worst - target)) * 100));
const weightOf = (list) => list.reduce((sum, c) => sum + c[1], 0);
const scoreOf = (list, version) => list.reduce((sum, c) => sum + c[1] * pct(c[5][version], c[3], c[4]), 0) / weightOf(list);
const cell = (value) => `${value.toFixed(0).padStart(4)} %`;

const families = [...new Set(CRITERES.map((c) => c[0]))];
console.log(`${"Famille".padEnd(14)} poids  ${MESURES.map((m) => m.padStart(9)).join(" ")}`);
for (const family of families) {
  const list = CRITERES.filter((c) => c[0] === family);
  console.log(`${family.padEnd(14)} ${String(weightOf(list)).padStart(5)}  ${MESURES.map((_, v) => cell(scoreOf(list, v)).padStart(9)).join(" ")}`);
}
console.log(`${"TOTAL".padEnd(14)} ${String(weightOf(CRITERES)).padStart(5)}  ${MESURES.map((_, v) => cell(scoreOf(CRITERES, v)).padStart(9)).join(" ")}`);

const last = MESURES.length - 1;
console.log(`\nPoids des critères vécus par une personne dans un vrai client : ${String(weightOf(CRITERES.filter((c) => c[6])))} / ${String(weightOf(CRITERES))}`);
console.log(`\nSous 100 % (${MESURES[last]}) :`);
for (const c of CRITERES) {
  const p = pct(c[5][last], c[3], c[4]);
  if (p < 100) console.log(`  ${cell(p)}  ${c[2]} — valeur ${String(c[5][last])}, cible ${String(c[3])} (${c[7]})`);
}
