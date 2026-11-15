/**
 * Les plafonds du limiteur se configurent, et une valeur invalide refuse le démarrage.
 *
 * ## Ce que ce fichier ferme
 *
 * Les trois plafonds étaient des littéraux dans `server/routes.ts` :
 * `rateLimit("decision", 120, 60_000)`. Un exploitant ne pouvait pas les ajuster sans
 * recompiler, et un agent réel dont le trafic dépasse 120 décisions par minute reçoit
 * des 429 qui, vus du client, ressemblent exactement à une panne.
 *
 * Le besoin s'est constaté pendant le chantier du kit de conformité : six passes contre
 * la même instance épuisaient le quota, et les 429 noyaient le signal au point de faire
 * passer deux mutants pour « manqués ».
 *
 * ## Les deux moitiés de ce fichier
 *
 * La première prouve que la valeur configurée **est réellement appliquée** — qu'elle
 * n'est pas lue puis ignorée, ce qui serait pire que de ne pas l'avoir : un exploitant
 * croirait avoir réglé quelque chose.
 *
 * La seconde prouve qu'une valeur invalide **refuse le démarrage avec une raison
 * nommée**, plutôt que de retomber en silence sur le défaut. C'est la règle de
 * `resolveFailMode` juste à côté, et c'est le défaut D3 de la Phase 13 :
 * `RATE_LIMIT_FAIL_MODE=opn` démarrait et n'échouait qu'au premier client.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { securityPostureNotices } from "../config-check";
import {
  DEFAULT_RATE_WINDOW_MS,
  InvalidRateLimit,
  MAX_RATE_WINDOW_MS,
  MIN_RATE_WINDOW_MS,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_SCOPES,
  describeRateLimits,
  parseRateLimits,
  rateLimitConfigProblems,
  rateLimitVariable,
} from "../rate-limit/limits";
import { runtimeConfigProblems } from "../config-check";
import { resetRateLimitConfig, resetRateLimits } from "../rate-limit";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

/** Un environnement nu : les tests ne doivent rien hériter du processus. */
const bare = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  extra as NodeJS.ProcessEnv;

afterEach(() => {
  for (const scope of RATE_LIMIT_SCOPES) delete process.env[rateLimitVariable(scope)];
  delete process.env.RATE_LIMIT_WINDOW_MS;
});

describe("sans configuration", () => {
  it("garde exactement les plafonds livrés", () => {
    const limits = parseRateLimits(bare());
    expect(limits.windowMs).toBe(DEFAULT_RATE_WINDOW_MS);
    expect(limits.perScope).toEqual(RATE_LIMIT_DEFAULTS);
  });

  it("ne signale aucun problème", () => {
    expect(rateLimitConfigProblems(bare())).toEqual([]);
  });

  it("les valeurs livrées sont celles qui étaient codées en dur dans routes.ts", () => {
    /*
     * Le changement devait être invisible pour tout déploiement existant. Ces trois
     * nombres sont ceux que `rateLimit("decision", 120, …)` portait ; les modifier
     * serait un changement de comportement, pas un changement de configuration.
     */
    expect(RATE_LIMIT_DEFAULTS).toEqual({ decision: 120, write: 30, approval: 60 });
    expect(DEFAULT_RATE_WINDOW_MS).toBe(60_000);
  });
});

describe("une valeur configurée est appliquée", () => {
  it("remplace le plafond de sa portée, et d'elle seule", () => {
    const limits = parseRateLimits(bare({ RATE_LIMIT_DECISION: "7" }));
    expect(limits.perScope.decision).toBe(7);
    expect(limits.perScope.write).toBe(RATE_LIMIT_DEFAULTS.write);
    expect(limits.perScope.approval).toBe(RATE_LIMIT_DEFAULTS.approval);
  });

  it("règle la fenêtre", () => {
    expect(parseRateLimits(bare({ RATE_LIMIT_WINDOW_MS: "5000" })).windowMs).toBe(5000);
  });

  it("chaque portée a sa propre variable, et elles ne se mélangent pas", () => {
    const env = bare({ RATE_LIMIT_DECISION: "11", RATE_LIMIT_WRITE: "22", RATE_LIMIT_APPROVAL: "33" });
    expect(parseRateLimits(env).perScope).toEqual({ decision: 11, write: 22, approval: 33 });
  });

  it("se dit au démarrage, en marquant ce qui a été configuré", () => {
    const line = describeRateLimits(parseRateLimits(bare({ RATE_LIMIT_WRITE: "500" })));
    expect(line).toContain("write=500 (configured)");
    expect(line).toContain("decision=120");
    expect(line).not.toContain("decision=120 (configured)");
  });
});

describe("une valeur invalide refuse le démarrage", () => {
  const refused: [string, Record<string, string>, RegExp][] = [
    ["zéro", { RATE_LIMIT_DECISION: "0" }, /outside the accepted bounds/],
    ["négatif", { RATE_LIMIT_DECISION: "-5" }, /positive integer/],
    ["décimal", { RATE_LIMIT_DECISION: "12.0" }, /positive integer/],
    ["notation scientifique", { RATE_LIMIT_DECISION: "1e3" }, /positive integer/],
    ["séparateur de milliers", { RATE_LIMIT_WRITE: "1_000" }, /positive integer/],
    ["texte", { RATE_LIMIT_APPROVAL: "beaucoup" }, /positive integer/],
    ["vide", { RATE_LIMIT_DECISION: "" }, /is empty/],
    ["fenêtre trop courte", { RATE_LIMIT_WINDOW_MS: String(MIN_RATE_WINDOW_MS - 1) }, /outside the accepted bounds/],
    ["fenêtre trop longue", { RATE_LIMIT_WINDOW_MS: String(MAX_RATE_WINDOW_MS + 1) }, /outside the accepted bounds/],
  ];

  for (const [label, env, reason] of refused) {
    it(`avec une raison nommée : ${label}`, () => {
      const problems = rateLimitConfigProblems(bare(env));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(reason);
      // La variable fautive est nommée : un exploitant doit savoir laquelle corriger.
      expect(problems[0]).toContain(Object.keys(env)[0]!);
      expect(() => parseRateLimits(bare(env))).toThrow(InvalidRateLimit);
    });
  }

  it("rapporte TOUS les problèmes d'un coup, pas un par redémarrage", () => {
    const problems = rateLimitConfigProblems(
      bare({ RATE_LIMIT_DECISION: "zéro", RATE_LIMIT_WRITE: "-1", RATE_LIMIT_WINDOW_MS: "10" }),
    );
    expect(problems).toHaveLength(3);
  });

  it("est branchée sur la même porte de démarrage que les quotas et les destinations", () => {
    process.env.RATE_LIMIT_DECISION = "pas-un-nombre";
    expect(runtimeConfigProblems(process.env).join("\n")).toMatch(/RATE_LIMIT_DECISION/);
  });

  it("une fenêtre d'une seconde et une d'une heure sont admises, les bornes incluses", () => {
    expect(rateLimitConfigProblems(bare({ RATE_LIMIT_WINDOW_MS: String(MIN_RATE_WINDOW_MS) }))).toEqual([]);
    expect(rateLimitConfigProblems(bare({ RATE_LIMIT_WINDOW_MS: String(MAX_RATE_WINDOW_MS) }))).toEqual([]);
  });
});

describe("le plafond configuré est réellement appliqué, sur HTTP", () => {
  let client: TestClient;

  beforeAll(async () => {
    client = await startTestServer();
  });

  afterAll(async () => {
    await client.close();
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_WRITE;
    resetRateLimitConfig();
    resetRateLimits();
  });

  const agent = (id: string) => ({
    id,
    name: "Rate limit fixture",
    description: "Fixture",
    provider: "openai" as const,
    model: "gpt-4o",
    status: "active" as const,
    owner: "rate-limit-suite",
    mandate: {
      maxTransactionAmount: 100,
      currency: "EUR" as const,
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
    permissions: [],
    policyIds: [],
    tags: [],
  });

  it("refuse la requête qui dépasse le plafond, et pas celles d'avant", async () => {
    /*
     * LE test de ce fichier. Vérifier qu'une valeur est LUE ne prouve rien : une valeur
     * lue puis ignorée serait pire que pas de configuration du tout, puisque
     * l'exploitant croirait avoir réglé quelque chose.
     *
     * Plafond à 3 : les trois premières écritures passent, la quatrième est refusée.
     */
    process.env.RATE_LIMIT_WRITE = "3";
    resetRateLimitConfig();
    resetRateLimits();

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await client.post(`/api/agents`, agent(`agt_rl_${Date.now()}_${i}`), {
        auth: ROLE_KEYS.admin,
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3).every((s) => s < 400)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  it("avec le plafond livré, les mêmes quatre écritures passent", async () => {
    /*
     * Contrôle positif. Sans lui, le test précédent passerait aussi sur un serveur qui
     * refuse la quatrième écriture pour une raison étrangère au plafond.
     */
    resetRateLimitConfig();
    resetRateLimits();

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await client.post(`/api/agents`, agent(`agt_rl_ok_${Date.now()}_${i}`), {
        auth: ROLE_KEYS.admin,
      });
      statuses.push(res.status);
    }
    expect(statuses.every((s) => s < 400)).toBe(true);
  });
});

/**
 * Le limiteur est-il PARTAGÉ ? Le défaut est non, et c'est le genre de défaut qui se
 * découvre en lisant le code plutôt qu'en lisant la configuration.
 *
 * `RATE_LIMIT_STORE` vide vaut « memory », donc un compteur local au processus. Derrière
 * deux instances, chacune accorde le plafond entier : l'exploitant qui a écrit 120
 * décisions par minute en accorde 240. L'erreur est silencieuse ET va dans le sens
 * permissif, ce qui est la pire combinaison disponible.
 *
 * MAIS CE N'EST PAS UN TROU EN PRODUCTION, et l'écrire ici évite de le recompter comme
 * tel : `database-config.ts` refuse de démarrer si `NODE_ENV=production` sans
 * `RATE_LIMIT_STORE=postgres`. Le compteur local est inatteignable là où il ferait des
 * dégâts. Cet avis vise ce qui reste — une préproduction ou une démonstration montée à
 * plusieurs instances, où le plafond double sans que rien ne le dise.
 */
describe("l'avis au démarrage sur le partage du limiteur", () => {
  const limiterLines = (env: Record<string, string | undefined>) =>
    securityPostureNotices(env as NodeJS.ProcessEnv).filter((line) =>
      line.includes("rate limit sharing: PROCESS-LOCAL"),
    );

  it("annonce le compteur local quand RATE_LIMIT_STORE est absent", () => {
    const lines = limiterLines({});
    expect(lines).toHaveLength(1);
    /* Le motif doit dire CE QUI se multiplie, pas seulement qu'il y a un risque. */
    expect(lines[0]).toContain("N times");
    /* Et la correction, pour que la ligne soit actionnable sans ouvrir le code. */
    expect(lines[0]).toContain("RATE_LIMIT_STORE=postgres");
    /*
     * ET la portée : la ligne doit dire que la production ne peut PAS atteindre ce mode.
     * Sans cette phrase, un lecteur ajoute « limiteur non partagé » à sa liste de risques
     * de production, où c'est déjà un refus de démarrage.
     */
    expect(lines[0]).toContain("Production cannot reach this mode");
  });

  it("l'annonce aussi quand la valeur est explicitement « memory »", () => {
    expect(limiterLines({ RATE_LIMIT_STORE: "memory" })).toHaveLength(1);
    /* La casse et les espaces ne doivent pas faire disparaître l'avis. */
    expect(limiterLines({ RATE_LIMIT_STORE: "  MEMORY  " })).toHaveLength(1);
  });

  it("se taît quand le limiteur est réellement partagé", () => {
    /*
     * Contrôle négatif, et il porte : un avis qui s'afficherait toujours serait du bruit,
     * et un exploitant qui a fait le bon réglage apprendrait à ignorer la ligne — donc
     * aussi celle du déploiement d'à côté qui, lui, ne l'a pas fait.
     */
    expect(limiterLines({ RATE_LIMIT_STORE: "postgres", DATABASE_URL: "postgres://x/y" })).toHaveLength(0);
    expect(limiterLines({ RATE_LIMIT_STORE: "postgresql", DATABASE_URL: "postgres://x/y" })).toHaveLength(0);
  });
});
