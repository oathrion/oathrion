/**
 * Les problèmes d'une déclaration d'interception, nommés AU DÉMARRAGE.
 *
 * `parseInterceptRules` valide la FORME. Ceci valide ce qu'une forme valide peut encore
 * avoir faux, et qui ne se verrait autrement qu'au premier appel d'un agent :
 *
 *   1. **Un verbe hors catalogue.** C'est l'entrée de `shared/policy/actions.ts` qui fait
 *      appliquer la portée de permission, le plafond de mandat et l'allowlist de domaine.
 *      Une règle qui nomme un verbe absent ferait du proxy une route non gouvernée — et
 *      `ToolRegistry` refuserait de toute façon, mais par une exception au chargement du
 *      module plutôt que par un motif lisible dans la liste des problèmes.
 *
 *   2. **Une destination absente du registre.** La requête serait reconnue, autorisée, et
 *      n'atteindrait personne.
 *
 *   3. **Deux règles qui se recouvrent.** La première gagne, donc la seconde est morte et
 *      personne ne le sait. Sur un pare-feu, une règle morte est une règle dont l'auteur
 *      croit qu'elle protège quelque chose.
 *
 * Rend une liste, jamais une exception : `runtimeConfigProblems` rapporte toutes les
 * fautes d'un coup.
 */

import { lookupAction, normalizeActionName } from "@shared/policy/actions";

import { listDestinations } from "../authority/destinations";
import { parseInterceptRules, pathMatches, type InterceptRule } from "./rules";

export function interceptRuleProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  let rules: InterceptRule[];
  try {
    rules = parseInterceptRules(env);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (rules.length === 0) return [];

  const problems: string[] = [];

  let known: string[] | null = null;
  try {
    known = listDestinations(env).map((entry) => entry.id);
  } catch {
    /* `destinationRegistryProblems` le dit déjà, avec la cause. Ne pas la noyer. */
    known = null;
  }

  for (const rule of rules) {
    const descriptor = lookupAction(normalizeActionName(rule.action));
    if (!descriptor) {
      problems.push(
        `OATHRION_INTERCEPTS: rule "${rule.id}" names the verb "${rule.action}", which is missing from ` +
          `shared/policy/actions.ts. Declare it there — with its permission scope and whether ` +
          `it is financial or outbound — so that the policy, the mandate and the ` +
          `permissions apply to it. A route that is intercepted but not governed would be worse ` +
          `than a route that is not intercepted: it would look controlled.`,
      );
    } else if (!descriptor.requiredScope) {
      problems.push(
        `OATHRION_INTERCEPTS: rule "${rule.id}" names "${rule.action}", which requires no ` +
          `permission scope. A relayable action without a scope is reachable by any agent.`,
      );
    }

    if (known !== null && !known.includes(rule.destination)) {
      problems.push(
        `OATHRION_INTERCEPTS: rule "${rule.id}" targets the destination "${rule.destination}", ` +
          `which is not registered. Known: ${known.length ? known.join(", ") : "none"}. ` +
          `Declare it in OATHRION_DESTINATIONS: otherwise the request would be recognized, ` +
          `authorized, and reach no one.`,
      );
    }
  }

  /*
   * Le recouvrement. Comparé dans l'ordre déclaré, parce que c'est l'ordre dans lequel
   * `matchRule` choisit : seule une règle PRÉCÉDENTE peut masquer une suivante.
   */
  for (let later = 1; later < rules.length; later += 1) {
    const candidate = rules[later]!;
    for (let earlier = 0; earlier < later; earlier += 1) {
      const first = rules[earlier]!;
      if (first.method !== candidate.method) continue;
      /*
       * Un motif plus général en masque un plus spécifique : `/v1/*` déclaré avant
       * `/v1/refunds` rend le second inatteignable. Le test est « le premier
       * reconnaîtrait-il tout ce que le second reconnaît ? », approché par le cas où le
       * chemin littéral du second matche le motif du premier.
       */
      if (pathMatches(first.path, candidate.path)) {
        problems.push(
          `OATHRION_INTERCEPTS: rule "${candidate.id}" (${candidate.method} ${candidate.path}) ` +
            `is unreachable: "${first.id}" (${first.method} ${first.path}) is declared earlier ` +
            `and matches the same requests. Put the more specific rule first, or ` +
            `remove one — a dead rule on a firewall is a rule whose author believes ` +
            `it protects something.`,
        );
        break;
      }
    }
  }

  return problems;
}
