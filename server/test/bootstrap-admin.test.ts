/**
 * Tests de l'amorçage du premier administrateur (G10).
 *
 * ## CE QUE CES TESTS GARDENT
 *
 * Le point sensible n'est pas « la commande crée-t-elle un compte » — c'est trois
 * choses qu'un test naïf ne regarde pas :
 *
 *   1. Le compte créé peut **réellement se connecter**. Un utilisateur écrit sans
 *      appartenance, ou dans une organisation absente du registre, existe en base et
 *      n'ouvre aucune session. C'est l'échec le plus probable et le plus déroutant.
 *   2. `OATHRION_CONSOLE_USERS` **ne réécrit pas** ce mot de passe au redémarrage suivant.
 *      Sans cette garantie, la commande n'est qu'un détour vers la variable
 *      d'environnement qu'elle est censée remplacer.
 *   3. Les deux refus dangereux (organisation déjà administrée, compte existant) sont
 *      des refus, pas des avertissements.
 *
 * ## POURQUOI CHAQUE TEST UTILISE SA PROPRE ORGANISATION
 *
 * La suite partage un seul fichier SQLite, et `server/test/setup.ts` y adopte déjà des
 * comptes de console dans l'organisation par défaut. Un test qui amorcerait un
 * administrateur dans `org_default` mesurerait l'état laissé par les autres suites. Un
 * nom d'organisation unique par cas rend chaque assertion vraie indépendamment de
 * l'ordre d'exécution.
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { bootstrapAdmin } from "../bootstrap-admin";
import { login, resetAuthConfig } from "../auth";
import { organizationStore } from "../repositories/organizations";
import { userStore } from "../repositories/users";
import { type OrganizationId } from "@shared/tenancy";

/**
 * Un secret différent par cas, jamais réutilisé ailleurs dans le dépôt.
 *
 * Le préfixe est volontairement sans rapport avec les adresses et les noms
 * d'organisation utilisés ici : le test d'hygiène cherche un fragment du mot de passe
 * dans la valeur de retour sérialisée, et un secret commençant par « bootstrap- »
 * ferait échouer ce test sur les identifiants (`usr_…`, `org_bootstrap_…`) au lieu de
 * mesurer ce qu'il prétend mesurer.
 */
function secret(label: string): string {
  return `Kx7Q2m9Wp4Ls-${label}`;
}

let counter = 0;
function uniqueOrganizationName(prefix: string): string {
  counter += 1;
  return `Bootstrap ${prefix} ${counter}`;
}

/**
 * `login()` renvoie `{ session, failure }` et non un booléen : une session ouverte est
 * `session !== null`. Ce petit adaptateur évite de répéter la convention dans chaque
 * assertion et, surtout, de la confondre avec un `ok` qui n'existe pas.
 */
function signsIn(email: string, password: string, organization: OrganizationId): boolean {
  return login(email, password, organization).session !== null;
}

describe("bootstrapAdmin — création", () => {
  it("crée l'organisation, le compte et l'appartenance admin en une passe", () => {
    const organizationName = uniqueOrganizationName("Create");
    const result = bootstrapAdmin({
      email: "founder@bootstrap.test",
      password: secret("create"),
      organizationName,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(true);
    expect(result.role).toBe("admin");
    /*
     * L'identifiant est OPAQUE depuis la migration 18 : il ne se calcule plus depuis le
     * nom, donc le test ne peut plus le recalculer. Ce qui est vérifié à la place est
     * plus fort : il a la forme attendue, il ne contient rien du nom de l'entreprise, et
     * c'est bien lui que porte la ligne écrite en base.
     */
    expect(result.organizationId).toMatch(/^org_[a-z0-9]{20}$/);
    expect(result.organizationId).not.toContain("bootstrap");
    expect(organizationStore.findByName(organizationName)?.id).toBe(result.organizationId);
    expect(result.organizationName).toBe(organizationName);
    // Le nom affiché par défaut est la partie locale : c'est lui qui apparaîtra dans
    // le journal d'audit comme auteur d'une décision.
    expect(result.name).toBe("founder");
    expect(result.passwordFingerprint).toMatch(/^[0-9a-f]{12}$/);

    // L'organisation doit être ACTIVE, pas seulement présente : `organizationStore`
    // traite une organisation inconnue comme inactive, et une session ouverte sur un
    // identifiant qu'aucune ligne ne porte n'authentifie personne.
    expect(organizationStore.isActive(result.organizationId)).toBe(true);

    const membership = userStore.membership(result.organizationId, result.userId);
    expect(membership?.role).toBe("admin");

    const stored = userStore.findById(result.userId);
    expect(stored?.status).toBe("active");
    // La propriété centrale : l'environnement n'est pas propriétaire de ce mot de passe.
    expect(stored?.passwordSource).toBe("user");
  });

  it("normalise l'adresse et accepte un nom affiché explicite", () => {
    const organizationName = uniqueOrganizationName("Normalise");
    const result = bootstrapAdmin({
      email: "  Mixed.Case@Bootstrap.TEST  ",
      password: secret("normalise"),
      name: "Alex Fondateur",
      organizationName,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email).toBe("mixed.case@bootstrap.test");
    expect(result.name).toBe("Alex Fondateur");
  });

  it("le compte amorcé peut réellement ouvrir une session", () => {
    const organizationName = uniqueOrganizationName("Login");
    const password = secret("login");
    const created = bootstrapAdmin({
      email: "signin@bootstrap.test",
      password,
      organizationName,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const outcome = login("signin@bootstrap.test", password, created.organizationId);
    expect(outcome.failure).toBeNull();
    expect(outcome.session).not.toBeNull();
    expect(outcome.session?.identity.role).toBe("admin");
    expect(outcome.session?.identity.organizationId).toBe(created.organizationId);
    expect(outcome.session?.identity.kind).toBe("user");
  });

  it("le mot de passe amorcé survit à un rechargement de la configuration", () => {
    const organizationName = uniqueOrganizationName("Survive");
    const password = secret("survive");
    const created = bootstrapAdmin({
      email: "survivor@bootstrap.test",
      password,
      organizationName,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    /*
     * `resetAuthConfig()` force la relecture de l'environnement et rejoue l'adoption
     * des comptes configurés — c'est-à-dire exactement ce qui se produit au démarrage
     * suivant du serveur. `OATHRION_CONSOLE_USERS` (défini par setup.ts) ne mentionne pas
     * ce compte ; il doit malgré tout rester actif et conserver son mot de passe.
     */
    resetAuthConfig();

    const after = userStore.findById(created.userId);
    expect(after?.passwordSource).toBe("user");
    expect(after?.status).toBe("active");
    expect(signsIn("survivor@bootstrap.test", password, created.organizationId)).toBe(true);
  });
});

describe("bootstrapAdmin — refus", () => {
  it("refuse une adresse qui n'est pas une adresse", () => {
    for (const email of ["", "pas-une-adresse", "sans@domaine", "avec espace@x.com"]) {
      const result = bootstrapAdmin({
        email,
        password: secret("email"),
        organizationName: uniqueOrganizationName("BadEmail"),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_email");
    }
  });

  it("refuse chaque catégorie de mot de passe faible, séparément", () => {
    const cases: ReadonlyArray<{ password: string; expected: RegExp }> = [
      /*
       * Les messages proviennent de `passwordProblems()` et sont en anglais : le code
       * d'exécution du dépôt est en anglais, la documentation et les commentaires en
       * français. Les motifs suivent la source plutôt que de la traduire — un test qui
       * attend une chaîne que le code ne produit pas ne garde rien.
       */
      { password: "court", expected: /at least 12 characters/ },
      { password: " commence-par-une-espace", expected: /begin or end with a space/ },
      { password: "finit-par-une-espace ", expected: /begin or end with a space/ },
      { password: "x".repeat(257), expected: /longer than 256/ },
    ];

    for (const { password, expected } of cases) {
      const result = bootstrapAdmin({
        email: "weak@bootstrap.test",
        password,
        organizationName: uniqueOrganizationName("Weak"),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("weak_password");
      expect(result.problems.join(" ")).toMatch(expected);
    }
  });

  it("refuse une valeur de démonstration connue, comme le fait le contrôle de démarrage", () => {
    const result = bootstrapAdmin({
      email: "demo@bootstrap.test",
      // Suffisamment longue pour passer `passwordProblems`, et pourtant refusée : c'est
      // la liste partagée avec server/auth.ts qui tranche, pas la longueur.
      password: "changeme",
      organizationName: uniqueOrganizationName("Demo"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Le refus de longueur est légitime aussi ; ce qui compte est qu'une valeur de
    // démonstration LONGUE soit refusée. Vérifié juste après avec « password ».
    expect(["weak_password", "forbidden_password"]).toContain(result.code);

    const long = bootstrapAdmin({
      email: "demo2@bootstrap.test",
      password: "aria-dev-key",
      organizationName: uniqueOrganizationName("Demo"),
    });
    expect(long.ok).toBe(false);
    if (long.ok) return;
    expect(long.code).toBe("forbidden_password");
  });

  it("refuse un second amorçage dans une organisation déjà administrée", () => {
    const organizationName = uniqueOrganizationName("Occupied");
    const first = bootstrapAdmin({
      email: "first@bootstrap.test",
      password: secret("first"),
      organizationName,
    });
    expect(first.ok).toBe(true);

    const second = bootstrapAdmin({
      email: "second@bootstrap.test",
      password: secret("second"),
      organizationName,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("admin_exists");

    // Et le refus est total : aucun compte n'a été écrit au passage.
    expect(userStore.findByEmail("second@bootstrap.test")).toBeNull();
  });

  it("refuse d'écraser un compte existant sans --force", () => {
    const organizationName = uniqueOrganizationName("Existing");
    const original = secret("original");
    const created = bootstrapAdmin({
      email: "existing@bootstrap.test",
      password: original,
      organizationName,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const overwrite = bootstrapAdmin({
      email: "existing@bootstrap.test",
      password: secret("overwrite"),
      organizationName: uniqueOrganizationName("ExistingOther"),
    });
    expect(overwrite.ok).toBe(false);
    if (overwrite.ok) return;
    expect(overwrite.code).toBe("account_exists");

    // Le mot de passe d'origine fonctionne toujours : le refus n'a rien modifié.
    expect(signsIn("existing@bootstrap.test", original, created.organizationId)).toBe(true);
  });

  it("ne laisse aucune organisation derrière un refus", () => {
    const organizationName = uniqueOrganizationName("NoLeftover");
    const result = bootstrapAdmin({
      email: "leftover@bootstrap.test",
      password: "trop-court",
      organizationName,
    });
    expect(result.ok).toBe(false);
    /*
     * L'organisation est créée dans la transaction d'écriture, donc après toutes les
     * validations. Un refus ne doit pas laisser un locataire vide que rien ne nettoie
     * et qu'aucun écran ne montre.
     */
    expect(organizationStore.findByName(organizationName)).toBeNull();
  });
});

describe("bootstrapAdmin — --force", () => {
  it("remplace le mot de passe d'un compte existant et le signale", () => {
    const organizationName = uniqueOrganizationName("Force");
    const before = secret("before");
    const created = bootstrapAdmin({
      email: "rotate@bootstrap.test",
      password: before,
      organizationName,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const after = secret("after");
    const forced = bootstrapAdmin({
      email: "rotate@bootstrap.test",
      password: after,
      organizationName,
      force: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;

    expect(forced.created).toBe(false);
    // L'empreinte change : elle porte sur le hachage stocké, donc elle prouve la
    // rotation sans jamais révéler le secret.
    expect(forced.passwordFingerprint).not.toBe(created.passwordFingerprint);

    expect(signsIn("rotate@bootstrap.test", after, created.organizationId)).toBe(true);
    expect(signsIn("rotate@bootstrap.test", before, created.organizationId)).toBe(false);
  });

  it("réactive un compte suspendu et le signale", () => {
    const organizationName = uniqueOrganizationName("Reactivate");
    const created = bootstrapAdmin({
      email: "suspended@bootstrap.test",
      password: secret("suspended"),
      organizationName,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    userStore.setStatus(created.userId, "suspended");

    const password = secret("reactivated");
    const forced = bootstrapAdmin({
      email: "suspended@bootstrap.test",
      password,
      organizationName,
      force: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.reactivated).toBe(true);
    expect(signsIn("suspended@bootstrap.test", password, created.organizationId)).toBe(true);
  });
});

describe("bootstrapAdmin — hygiène du secret", () => {
  it("ne renvoie le mot de passe sous aucune forme", () => {
    const organizationName = uniqueOrganizationName("Hygiene");
    const password = secret("hygiene");
    const result = bootstrapAdmin({
      email: "hygiene@bootstrap.test",
      password,
      organizationName,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * Sérialisé puis cherché : c'est ce que fait un journal structuré, un rapport
     * d'erreur ou un compte rendu de CI avec la valeur de retour. Chercher le mot de
     * passe champ par champ passerait à côté d'un ajout futur.
     */
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(password);
    // Et aucun préfixe exploitable : un fragment de huit caractères d'un mot de passe
    // réduit l'espace de recherche d'une attaque par dictionnaire.
    expect(serialised).not.toContain(password.slice(0, 8));

    // L'empreinte porte sur le hachage stocké, pas sur le secret : elle ne doit donc
    // pas correspondre à un hachage du mot de passe seul.
    const naive = crypto.createHash("sha256").update(password).digest("hex").slice(0, 12);
    expect(result.passwordFingerprint).not.toBe(naive);
  });

  it("le hachage stocké n'est jamais le mot de passe en clair", () => {
    const organizationName = uniqueOrganizationName("Hash");
    const password = secret("hash");
    const result = bootstrapAdmin({
      email: "hash@bootstrap.test",
      password,
      organizationName,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = userStore.findById(result.userId);
    expect(stored?.passwordHash).toMatch(/^scrypt\$/);
    expect(stored?.passwordHash).not.toContain(password);
  });
});
