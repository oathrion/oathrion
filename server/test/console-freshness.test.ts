/**
 * La console montre ce qui vient de se passer — pas ce qu'elle a lu à la connexion.
 *
 * Relevé en répétant la recette à blanc (docs/STRESS-TEST-LOG.md §5.15), sur le parcours
 * de docs/PILOTE-RECETTE-UTILISATEUR.md :
 *
 *   - étape 4 : deux règles enregistrées par le démarrage guidé, et l'écran Politiques
 *     disait « No policies match » ;
 *   - étape 8 : trois exécutions venaient d'avoir lieu, et l'écran Exécutions affichait 0 ;
 *   - étape 8 encore : revenir au démarrage après avoir ouvert un autre écran effaçait les
 *     résultats du scénario, donc les liens « Reçu d'audit ».
 *
 * Recharger la page n'était pas une issue : la session n'est gardée que dans l'onglet.
 * Le client n'a pas de banc DOM ; comme les autres gardes de l'interface
 * (execution-detail-lookup.test.ts), ce test lit la source. La preuve de bout en bout
 * est le parcours rejoué dans un navigateur.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src");
const read = (relative: string) => readFileSync(path.join(CLIENT, relative), "utf8");

describe("les écrans de liste relisent l'instantané quand on les ouvre", () => {
  const store = read("lib/store.tsx");

  it("le magasin offre une relecture silencieuse et stable", () => {
    expect(store).toMatch(/const refresh = useCallback\(\(\) => setNonce\(\(n\) => n \+ 1\), \[\]\);/);
    expect(store).toMatch(/export function useFreshSnapshot\(\): void \{\s*const \{ refresh \} = useARIA\(\);\s*useEffect\(\(\) => \{\s*refresh\(\);\s*\}, \[refresh\]\);/);
  });

  it("la relecture silencieuse ne repasse pas par les squelettes", () => {
    const refreshBody = /const refresh = useCallback\(([^;]*)\);/.exec(store)?.[1] ?? "";
    expect(refreshBody).not.toContain("setLoading");
  });

  it.each(["policies", "executions", "approvals", "agents", "dashboard"])("l'écran %s s'en sert", (page) => {
    expect(read(`pages/${page}.tsx`)).toMatch(/\n\s*useFreshSnapshot\(\);\n/);
  });

  it("le démarrage guidé relit aussi l'instantané après chaque écriture", () => {
    const onboarding = read("pages/onboarding.tsx");
    expect(onboarding).toMatch(/const refresh = \(\) => \{[\s\S]{0,400}refreshSnapshot\(\);\s*\};/);
  });
});

describe("les résultats du scénario survivent à la navigation", () => {
  const verify = read("components/onboarding/VerifyStep.tsx");

  it("ils sont relus depuis le cache de la console à l'ouverture de l'étape", () => {
    expect(verify).toMatch(/queryClient\.getQueryData<Remembered>\(memoryKey\)/);
    expect(verify).toMatch(/useState<ScenarioStep\[\]>\(remembered\?\.steps \?\? \[\]\)/);
    expect(verify).toMatch(/useState<Record<string, Resolution>>\(remembered\?\.resolutions \?\? \{\}\)/);
  });

  it("ils y sont écrits à chaque changement, sans échéance de ramassage", () => {
    expect(verify).toMatch(/queryClient\.setQueryDefaults\(\[SCENARIO_MEMORY\], \{ gcTime: Infinity \}\)/);
    expect(verify).toMatch(/queryClient\.setQueryData<Remembered>\(\[SCENARIO_MEMORY, agent\.id\], \{ steps, resolutions \}\)/);
  });

  it("le scénario et chaque décision relisent l'instantané (pastille des approbations)", () => {
    expect(verify.match(/refreshSnapshot\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("le cache ne survit pas à la session", () => {
  it("se déconnecter vide le cache des requêtes", () => {
    const auth = read("lib/auth.tsx");
    const signOut = /const signOut = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/.exec(auth)?.[1] ?? "";
    expect(signOut).toContain("setAuthToken(null);");
    expect(signOut).toContain("queryClient.clear();");
  });
});
