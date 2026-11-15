/**
 * Compatibilité des noms de variables d'environnement à travers les renommages.
 *
 * ## Trois renommages, et un seul préfixe hérité encore honoré
 *
 * Ce produit a été renommé trois fois : **AgentOS → ARIA**, **ARIA → Placet**, puis
 * **Placet → Oathrion**. Chaque renommage déplace toutes les variables de configuration,
 * et un démarrage lit la configuration avant de pouvoir expliquer quoi que ce soit : sans
 * alias, un exploitant qui met à jour obtient un processus qui refuse de démarrer sur
 * `OATHRION_SESSION_SECRET` manquant, sans rien qui relie la panne au renommage.
 *
 * Les noms hérités sont donc honorés, mais **seulement comme alias**, et seulement
 * quand le nom courant est absent. La précédence est délibérée :
 *
 *   1. `OATHRION_X` posée → utilisée, l'héritée est ignorée entièrement. Pas de surprise
 *      où une vieille variable oubliée écrase une nouvelle posée exprès ;
 *   2. seule `PLACET_X` posée → copiée sur `OATHRION_X`, un avertissement par variable ;
 *   3. aucune des deux → intacte, le traitement normal de configuration manquante
 *      s'applique.
 *
 * ## `ARIA_` EST RETIRÉ à son tour (décision du 27 octobre 2026)
 *
 * Même règle qu'au renommage précédent : deux générations au plus. Un déploiement encore
 * configuré en `ARIA_*` ne démarre plus, et le message de refus nomme la variable
 * manquante. Aucun n'est connu.
 *
 * ## `AGENTOS_` EST RETIRÉ, et c'est une décision
 *
 * Le shim précédent honorait `AGENTOS_*`. Il était annoncé pour suppression en 2.0 dans
 * `ARIA-CHANGELOG.md`, et ce renommage est le moment de le tenir — pas par ménage, mais
 * parce que **trois générations de noms créent une précédence à trois branches que
 * personne n'éprouve**. `AGENTOS_X` l'emporterait-il sur `ARIA_X` ? Dans quel ordre la
 * copie se fait-elle ? Chaque réponse est défendable et aucune n'est évidente, ce qui
 * est exactement la propriété qu'une règle de configuration ne doit pas avoir.
 *
 * Conséquence assumée : un déploiement encore configuré en `AGENTOS_*` — s'il en existe
 * — ne démarre plus. Il aura traversé deux renommages sans jamais éditer son fichier
 * d'unité, et le message de refus nomme la variable manquante.
 *
 * Ce qui NE change pas : les valeurs refusées `agentos-demo` et `agentos-dev-key`
 * restent dans `FORBIDDEN_CREDENTIALS` (`server/auth.ts`). Un secret refusé doit le
 * rester à travers un renommage — cette liste ne fait que grandir, jamais rétrécir, et
 * c'est la différence entre retirer un alias et retirer une protection.
 *
 * Ce module est importé pour son effet de bord et doit l'être avant toute lecture de
 * configuration. Il est idempotent.
 */

const CURRENT_PREFIX = "OATHRION_";

/**
 * Les préfixes hérités encore honorés, du plus récent au plus ancien.
 *
 * Un seul aujourd'hui. La structure en liste est volontaire : au renommage suivant, on
 * ajoute un préfixe et on retire le plus ancien, et la boucle ci-dessous n'a pas à
 * changer. Le premier préfixe de la liste qui porte une valeur gagne, ce qui garde la
 * règle énonçable en une phrase même si la liste s'allonge.
 */
const LEGACY_PREFIXES = ["PLACET_"] as const;

export interface LegacyEnvAlias {
  legacy: string;
  current: string;
}

let applied: LegacyEnvAlias[] | null = null;

/**
 * Copie les variables héritées sur leur équivalent courant.
 *
 * Rend les alias réellement appliqués, pour qu'un appelant — ou un test — puisse
 * l'affirmer sans analyser une sortie de journal.
 */
export function applyLegacyEnvAliases(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): LegacyEnvAlias[] {
  const aliased: LegacyEnvAlias[] = [];

  for (const legacyPrefix of LEGACY_PREFIXES) {
    // On fige les clés : la boucle écrit dans `env`, et muter un objet en parcourant sa
    // liste de clés vivante est la façon d'en sauter.
    for (const legacy of Object.keys(env)) {
      if (!legacy.startsWith(legacyPrefix)) continue;
      const value = env[legacy];
      if (value === undefined) continue;

      const current = `${CURRENT_PREFIX}${legacy.slice(legacyPrefix.length)}`;
      if (env[current] !== undefined) continue; // le nom courant gagne, toujours.

      env[current] = value;
      aliased.push({ legacy, current });
    }
  }

  if (aliased.length > 0) {
    warn(
      `[oathrion] Deprecated environment variables detected (Placet naming). ` +
        `They are honored for this run and will be removed in the next ` +
        `major version:\n` +
        aliased.map(({ legacy, current }) => `  ${legacy} → rename to ${current}`).join("\n"),
    );
  }

  return aliased;
}

/** Seam de test : oublier que le shim a tourné pour pouvoir l'éprouver à nouveau. */
export function resetLegacyEnvAliases(): void {
  applied = null;
}

if (applied === null) {
  applied = applyLegacyEnvAliases();
}
