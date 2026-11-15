/**
 * Où passent les millisecondes d'un appel relayé.
 *
 * ## Pourquoi ce fichier existe
 *
 * Le banc d'endurance a mesuré le surcoût du pare-feu : **32 à 37 ms** de médiane à
 * médiane, reproductible sur trois passages. C'est un chiffre honnête et parfaitement
 * inutile pour agir : il dit *combien*, jamais *où*.
 *
 * Sans ce découpage, réduire la latence revient à deviner — on optimise ce qu'on croit
 * coûteux, on remesure le total, et on n'apprend rien quand il ne bouge pas. Un profil
 * CPU ne suffit pas non plus : l'essentiel du temps d'un plan de contrôle est de
 * l'ATTENTE (aller-retours de base, `fsync` de validation, socket vers le fournisseur),
 * qui n'apparaît pas dans un profil processeur.
 *
 * Ce module mesure donc du temps d'horloge par phase nommée, et le rend dans l'en-tête
 * standard `Server-Timing` — celui que les navigateurs et les outils de trace savent
 * déjà lire.
 *
 * ## ÉTEINT PAR DÉFAUT, et ce n'est pas de la frilosité
 *
 * `OATHRION_TIMING_HEADER=1` l'allume. Éteint, `timed()` appelle sa fonction et rend sa
 * promesse sans rien allouer ni lire d'horloge : le coût est celui d'un appel de
 * fonction, donc la mesure ne peut pas changer ce qu'elle mesure.
 *
 * Allumé, il publie à l'appelant la durée de chaque phase interne. Sur un plan de
 * contrôle, c'est un oracle temporel : la différence entre « aucune politique ne
 * correspond » et « une politique a été évaluée puis a refusé » devient lisible de
 * l'extérieur. C'est acceptable pour un exploitant qui diagnostique sa propre
 * installation ; ça ne doit pas être le défaut d'une passerelle exposée à des agents.
 *
 * ## Les phases s'ADDITIONNENT, elles ne se contiennent pas
 *
 * Chaque nom est mesuré une fois et cumulé. Une phase qui en englobe une autre serait
 * comptée deux fois dans le total et rendrait la lecture fausse : on instrumente donc
 * des segments disjoints, et c'est au lecteur de constater que leur somme s'approche du
 * temps total — l'écart restant étant Express, la sérialisation JSON et l'ordonnanceur.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Les cumuls de la requête servie sur cette pile asynchrone. */
const storage = new AsyncLocalStorage<Map<string, number>>();

/*
 * Lu une fois au démarrage plutôt qu'à chaque appel. `process.env` est un objet hôte :
 * sa lecture traverse une barrière C++, et la faire sur le chemin chaud ferait payer la
 * mesure même quand elle est éteinte — exactement ce que ce module promet d'éviter.
 */
let enabled = false;

/** Appelé au démarrage, et par les tests pour forcer un état connu. */
export function configureTiming(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OATHRION_TIMING_HEADER?.trim().toLowerCase() ?? "";
  enabled = raw === "1" || raw === "true" || raw === "yes";
  return enabled;
}

export function timingEnabled(): boolean {
  return enabled;
}

/**
 * Ouvre une collecte pour la durée de `fn`.
 *
 * Éteint, c'est `fn()` — pas de `Map`, pas de contexte asynchrone. Allumé, chaque
 * `timed()` exécuté sous cette pile y dépose son cumul.
 */
export function withTimings<T>(fn: () => T): T {
  if (!enabled) return fn();
  return storage.run(new Map<string, number>(), fn);
}

/**
 * Mesure `fn` sous le nom `name`.
 *
 * Le cumul est écrit même si `fn` lève : une phase qui échoue est précisément celle dont
 * on veut connaître la durée, et la perdre laisserait un total inexpliqué.
 */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const spans = storage.getStore();
  if (!spans) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    spans.set(name, (spans.get(name) ?? 0) + (performance.now() - started));
  }
}

/** La même chose pour une phase synchrone (appariement de règle, extraction). */
export function timedSync<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const spans = storage.getStore();
  if (!spans) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    spans.set(name, (spans.get(name) ?? 0) + (performance.now() - started));
  }
}

/**
 * L'en-tête `Server-Timing`, ou `null` quand il n'y a rien à dire.
 *
 * Format : `nom;dur=12.34`, séparés par des virgules — la grammaire de la RFC, pas une
 * invention locale, pour que les outils existants le lisent sans adaptateur.
 *
 * Les noms sont les nôtres, écrits dans le code, donc il n'y a aucune donnée d'appelant
 * ici : rien à échapper, et aucune voie par laquelle un en-tête de requête pourrait se
 * retrouver dans un en-tête de réponse.
 */
export function serverTimingHeader(): string | null {
  if (!enabled) return null;
  const spans = storage.getStore();
  if (!spans || spans.size === 0) return null;
  return [...spans]
    .map(([name, ms]) => `${name};dur=${ms.toFixed(2)}`)
    .join(", ");
}

/** Test-only : les cumuls bruts de la pile courante. */
export function currentTimings(): Record<string, number> | null {
  const spans = storage.getStore();
  return spans ? Object.fromEntries(spans) : null;
}
