/**
 * Les plafonds du limiteur de débit, et leur lecture depuis l'environnement.
 *
 * ## Pourquoi ce fichier existe
 *
 * Les trois plafonds étaient des **littéraux** dans `server/routes.ts` :
 * `rateLimit("decision", 120, 60_000)`. Un exploitant ne pouvait donc pas les ajuster
 * sans recompiler, et un agent réel dont le trafic dépasse 120 décisions par minute
 * recevait des 429 qui ressemblent exactement à une panne.
 *
 * Le besoin a été constaté pendant le chantier du kit de conformité : six passes
 * successives contre la même instance épuisaient le quota, et les 429 noyaient le signal
 * au point de faire passer deux mutants pour « manqués ».
 *
 * ## La règle qui gouverne ce fichier
 *
 * Une valeur invalide **refuse le démarrage**, elle n'est jamais remplacée par le
 * défaut. C'est la même règle que `resolveFailMode` juste à côté, et elle existe pour la
 * même raison : un plafond mal orthographié qui retomberait silencieusement sur sa valeur
 * d'usine ferait croire à l'exploitant qu'il a configuré quelque chose. La Phase 13 a
 * déjà corrigé exactement ce défaut sur `RATE_LIMIT_FAIL_MODE=opn`, qui démarrait et
 * n'échouait qu'au premier client.
 *
 * ## Ce que ce fichier ne fait pas
 *
 * Il ne rend pas les plafonds configurables **par locataire**. C'est délibéré : un
 * limiteur de débit protège la capacité du déploiement, pas le contrat d'un client — ce
 * dernier est l'affaire des quotas (`shared/quotas.ts`), qui sont déjà par organisation
 * et en base depuis la migration 17. Mélanger les deux donnerait deux endroits où lire
 * « combien ce client a-t-il droit ».
 */

/** Les trois portées limitées, avec le plafond livré par défaut. */
export const RATE_LIMIT_DEFAULTS = {
  /** Autorisations et décisions : le chemin chaud. */
  decision: 120,
  /** Écritures de configuration : agents, règles, credentials. */
  write: 30,
  /** Approbations et rejets. */
  approval: 60,
} as const;

export type RateLimitScope = keyof typeof RATE_LIMIT_DEFAULTS;

export const RATE_LIMIT_SCOPES = Object.keys(RATE_LIMIT_DEFAULTS) as RateLimitScope[];

export const DEFAULT_RATE_WINDOW_MS = 60_000;

/**
 * Bornes de la fenêtre.
 *
 * En dessous d'une seconde, une fenêtre ne limite rien d'utile et trahit presque
 * toujours une unité confondue — `RATE_LIMIT_WINDOW_MS=60` voulait dire soixante
 * secondes. Au-delà d'une heure, ce n'est plus un garde-fou de rafale mais un quota, et
 * les quotas ont leur propre mécanisme, par organisation et en base.
 */
export const MIN_RATE_WINDOW_MS = 1_000;
export const MAX_RATE_WINDOW_MS = 3_600_000;

/** Le nom de la variable qui règle une portée. */
export function rateLimitVariable(scope: RateLimitScope): string {
  return `RATE_LIMIT_${scope.toUpperCase()}`;
}

export interface RateLimits {
  readonly perScope: Readonly<Record<RateLimitScope, number>>;
  readonly windowMs: number;
}

export class InvalidRateLimit extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRateLimit";
  }
}

/**
 * La seule règle de ce qu'une valeur peut être, quelle que soit la variable.
 *
 * Rend la raison, ou `null`. Même forme que `quotaCeilingProblem` dans
 * `shared/quotas.ts`, et pour le même motif : une définition unique de « valeur
 * acceptable », pour que la plus faible de deux ne devienne pas celle qu'un exploitant
 * atteint.
 *
 * **Zéro est refusé.** Un plafond de zéro refuserait toute requête de la portée — c'est
 * fermé, donc sûr, mais ce n'est jamais ce que quelqu'un a voulu écrire, et la façon
 * honnête de couper une route n'est pas de lui donner un plafond nul.
 */
export function rateLimitProblem(
  variable: string,
  raw: string,
  bounds: { min: number; max: number },
): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return `${variable} is empty. Remove the variable to keep the default value, or give it a number.`;
  }
  if (!/^\d+$/.test(trimmed)) {
    return (
      `${variable} is "${raw}", which is not a positive integer written in digits. ` +
      `The forms "1_000", "1e3", " 12 " and "12.0" are refused rather than interpreted: ` +
      `a guessed value would be a cap no one chose.`
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return `${variable} is ${trimmed}, which is too large to be compared exactly.`;
  }
  if (value < bounds.min || value > bounds.max) {
    return `${variable} is ${value}, outside the accepted bounds [${bounds.min}, ${bounds.max}].`;
  }
  return null;
}

/**
 * Lit les plafonds. Lève `InvalidRateLimit` à la première valeur refusée.
 *
 * Une variable absente garde le défaut livré — c'est le cas de tout déploiement
 * existant, qui doit continuer à se comporter exactement comme avant ce changement.
 */
export function parseRateLimits(env: NodeJS.ProcessEnv = process.env): RateLimits {
  const windowRaw = env.RATE_LIMIT_WINDOW_MS;
  let windowMs = DEFAULT_RATE_WINDOW_MS;
  if (windowRaw !== undefined) {
    const problem = rateLimitProblem("RATE_LIMIT_WINDOW_MS", windowRaw, {
      min: MIN_RATE_WINDOW_MS,
      max: MAX_RATE_WINDOW_MS,
    });
    if (problem !== null) throw new InvalidRateLimit(problem);
    windowMs = Number(windowRaw.trim());
  }

  const perScope = {} as Record<RateLimitScope, number>;
  for (const scope of RATE_LIMIT_SCOPES) {
    const variable = rateLimitVariable(scope);
    const raw = env[variable];
    if (raw === undefined) {
      perScope[scope] = RATE_LIMIT_DEFAULTS[scope];
      continue;
    }
    /*
     * Plafond maximal : `Number.MAX_SAFE_INTEGER`. Il n'y a pas de raison de principe
     * de brider un exploitant qui veut, de fait, désactiver la limite sur une portée —
     * mais `describeRateLimits()` le dit au démarrage, parce qu'une limite désactivée
     * doit être un choix lisible dans les journaux et non une découverte d'incident.
     */
    const problem = rateLimitProblem(variable, raw, { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (problem !== null) throw new InvalidRateLimit(problem);
    perScope[scope] = Number(raw.trim());
  }

  return { perScope, windowMs };
}

/**
 * Les problèmes, pour la porte de démarrage, qui les rapporte tous ensemble plutôt que
 * d'en révéler un par redémarrage.
 */
export function rateLimitConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  const windowRaw = env.RATE_LIMIT_WINDOW_MS;
  if (windowRaw !== undefined) {
    const problem = rateLimitProblem("RATE_LIMIT_WINDOW_MS", windowRaw, {
      min: MIN_RATE_WINDOW_MS,
      max: MAX_RATE_WINDOW_MS,
    });
    if (problem !== null) problems.push(problem);
  }

  for (const scope of RATE_LIMIT_SCOPES) {
    const variable = rateLimitVariable(scope);
    const raw = env[variable];
    if (raw === undefined) continue;
    const problem = rateLimitProblem(variable, raw, { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (problem !== null) problems.push(problem);
  }

  return problems;
}

/** Une ligne pour le démarrage : ce qui est en vigueur, et ce qui ne limite plus rien. */
export function describeRateLimits(limits: RateLimits): string {
  const parts = RATE_LIMIT_SCOPES.map((scope) => {
    const value = limits.perScope[scope];
    const note = value === RATE_LIMIT_DEFAULTS[scope] ? "" : " (configured)";
    return `${scope}=${value}${note}`;
  });
  return `window ${limits.windowMs} ms, ${parts.join(", ")}`;
}
