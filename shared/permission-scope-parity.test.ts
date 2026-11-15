/**
 * LE TYPE ET LE SCHÉMA DES PORTÉES NE DOIVENT PAS DIVERGER.
 *
 * ## Le défaut que ce fichier ferme
 *
 * `PermissionScope` (`shared/types.ts`) déclarait quinze portées.
 * `permissionScopeSchema` (`shared/validation.ts`) en acceptait douze. Les trois
 * manquantes avaient été ajoutées au TYPE avec une justification explicite : « without
 * these three entries no agent could ever hold that scope, so those verbs would be
 * permanently unreachable rather than governed ».
 *
 * Le type n'est pourtant pas la barrière. `POST /api/agents` valide avec le SCHÉMA, et
 * le schéma refusait `publish:content` en 400. Les verbes `publish` et `post` du
 * catalogue d'actions étaient donc protégés par accident — aucun agent créé par l'API ne
 * pouvait détenir la portée qu'ils exigent — pendant que le commentaire du type affirmait
 * qu'ils étaient gouvernés.
 *
 * Trouvé en ajoutant `read:repository` et `write:repository` pour le connecteur GitHub :
 * les ajouter au type seul aurait reproduit exactement le même défaut, un connecteur réel
 * dont aucun agent ne peut recevoir la permission.
 *
 * ## Pourquoi un test textuel
 *
 * Un `z.enum` ne se compare pas au type TypeScript à l'exécution : le type est effacé à
 * la compilation. Une assertion de type (`satisfies`) attraperait un ajout au schéma
 * absent du type, mais pas l'inverse — qui est précisément le sens dans lequel l'écart
 * s'est produit. Les deux sources sont donc relues et leurs listes comparées.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { permissionScopeSchema } from "./validation";

const SHARED = dirname(fileURLToPath(import.meta.url));

/** Les membres de l'union `PermissionScope`, lus dans le source du type. */
function scopesDeclaredInType(): string[] {
  /*
   * LES COMMENTAIRES SONT RETIRÉS AVANT DE CHERCHER LA FIN DE LA DÉCLARATION, ET
   * L'ORDRE EST LA RAISON POUR LAQUELLE CETTE FONCTION EXISTE SOUS CETTE FORME.
   *
   * Écrite dans l'autre ordre — chercher le « ; » puis dé-commenter — elle a rendu DOUZE
   * portées sur dix-sept, parce que le bloc expliquant `publish:content` contient
   * lui-même un point-virgule : « requiring a scope; without these three entries ».
   * La déclaration était donc tronquée à l'endroit exact où la liste devenait
   * intéressante, et l'égalité avec le schéma passait pour une mauvaise raison. C'est la
   * garde sur la garde, deux lignes plus bas, qui l'a dit.
   */
  const source = readFileSync(join(SHARED, "types.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const start = source.indexOf("export type PermissionScope =");
  expect(start, "le type PermissionScope est introuvable dans shared/types.ts").toBeGreaterThan(-1);
  const end = source.indexOf(";", start);
  expect(end, "la déclaration de PermissionScope n'est pas terminée").toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/"([a-z-]+:[a-z-]+)"/g)].map((m) => m[1]!).sort();
}

describe("les portées de permission ont une seule liste", () => {
  it("le schéma de validation accepte exactement les portées que le type déclare", () => {
    const fromType = scopesDeclaredInType();
    const fromSchema = [...permissionScopeSchema.options].sort();

    /*
     * Une garde sur la garde : si l'extraction textuelle cassait, les deux listes
     * seraient vides et l'égalité passerait à vide — le mode d'échec que tout ce fichier
     * existe pour supprimer.
     */
    expect(fromType.length).toBeGreaterThan(12);
    expect(fromSchema.length).toBeGreaterThan(12);

    expect(fromSchema).toEqual(fromType);
  });

  it("les trois portées qui manquaient au schéma y sont", () => {
    /*
     * Nommées, et pas seulement couvertes par l'égalité ci-dessus. Le test précédent
     * tomberait aussi si quelqu'un les retirait des DEUX côtés, ce qui rendrait les
     * verbes `publish`, `post`, `execute` et `deploy` inatteignables sans qu'aucune
     * assertion ne dise lesquels.
     */
    for (const scope of ["publish:content", "execute:code", "deploy:infrastructure"]) {
      expect(permissionScopeSchema.options as readonly string[]).toContain(scope);
    }
  });

  it("les portées du connecteur GitHub sont accordables par l'API", () => {
    /*
     * Un connecteur réel dont personne ne peut recevoir la permission serait un
     * connecteur décoratif d'un nouveau genre : le code marche, et aucun agent ne peut
     * l'atteindre.
     */
    for (const scope of ["read:repository", "write:repository"]) {
      expect(permissionScopeSchema.safeParse(scope).success).toBe(true);
    }
  });

  it("une portée inventée reste refusée", () => {
    /* La contrepartie : la liste est fermée, pas étendue à tout ce qui ressemble à une portée. */
    expect(permissionScopeSchema.safeParse("write:everything").success).toBe(false);
    expect(permissionScopeSchema.safeParse("read:repository ").success).toBe(false);
  });
});
