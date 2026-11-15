/**
 * Amorçage du premier administrateur — G10 de l'audit d'architecte.
 *
 * ## POURQUOI CE FICHIER EXISTE
 *
 * Avant lui, la seule façon de créer un compte humain était `OATHRION_CONSOLE_USERS`,
 * c'est-à-dire **un mot de passe en clair dans l'environnement du processus**. Ce que
 * `server/passwords.ts` dit déjà de cette forme reste vrai tant qu'elle est le seul
 * chemin d'entrée : la valeur est lisible par tout ce qui peut lire
 * `/proc/<pid>/environ`, un vidage mémoire, un journal de CI ou un tableau de bord
 * PaaS. Le hachage scrypt en base protège la base ; il ne protège pas la variable.
 *
 * Ce module est l'autre chemin : le secret est fourni sur l'entrée standard, haché
 * immédiatement, écrit une fois, et n'existe nulle part ailleurs.
 *
 * ## CE QU'IL NE FAIT PAS, ET POURQUOI
 *
 * Il ne réimplémente **aucune** règle. La validation de mot de passe est celle de
 * `passwordProblems()`, la liste de valeurs de démonstration refusées est celle de
 * `server/auth.ts`, le hachage est `hashPassword()`, l'insertion est
 * `userStore.ensure()`, l'appartenance est `userStore.grant()`. Dupliquer l'une de ces
 * règles ici créerait deux définitions de « mot de passe acceptable » qui divergeraient
 * au premier durcissement — et la plus faible des deux serait celle qui crée les
 * administrateurs.
 *
 * Il n'écrit ni ne renvoie jamais le mot de passe. La seule valeur dérivée qui sort est
 * une empreinte **du hachage stocké**, pas du secret : le hachage est salé, donc
 * l'empreinte ne permet aucune vérification hors ligne. Une empreinte du mot de passe
 * lui-même, même tronquée à quelques octets, serait cassable par dictionnaire.
 *
 * ## LA GARDE QUI COMPTE
 *
 * Créer un administrateur dans une organisation qui en a déjà un actif est refusé sans
 * `force`, et écraser le mot de passe d'un compte existant l'est aussi. Ces deux
 * refus existent parce que la commande s'exécute avec un accès direct à la base : sans
 * eux, « amorcer le premier administrateur » serait indistinguable d'une prise de
 * contrôle d'un compte en place, y compris dans le journal.
 *
 * ## SÉPARATION TEST / RÉEL
 *
 * Ce module ne contient aucun identifiant, aucune valeur par défaut de mot de passe et
 * aucun compte de test. Il n'y a rien à confondre avec `server/test/setup.ts`.
 */

import crypto from "node:crypto";
import { FORBIDDEN_CREDENTIALS } from "./auth";
import { rawDb } from "./db";
import { hashPassword, passwordProblems } from "./passwords";
import { organizationStore } from "./repositories/organizations";
import { normaliseEmail, userStore } from "./repositories/users";
import { organizationNameProblem, type OrganizationId } from "@shared/tenancy";

/**
 * Nom d'organisation retenu quand l'appelant n'en donne pas.
 *
 * Un défaut est acceptable ici — contrairement à un secret — parce qu'il ne donne
 * aucun accès : il ne fait que nommer le locataire créé, et il est affiché dans le
 * compte rendu de la commande.
 */
export const DEFAULT_BOOTSTRAP_ORGANIZATION_NAME = "Oathrion";

/**
 * Validation d'adresse volontairement grossière : une adresse sans `@`, sans point
 * dans le domaine ou contenant une espace n'est pas un identifiant de connexion
 * utilisable. Valider plus finement que cela reviendrait à réécrire la RFC 5322 et à
 * refuser des adresses légitimes — ce qui, pour la commande qui crée le seul compte
 * d'administration, serait un échec pire qu'une acceptation trop large.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BootstrapRefusalCode =
  | "invalid_email"
  | "invalid_name"
  | "invalid_organization"
  | "weak_password"
  | "forbidden_password"
  | "admin_exists"
  | "account_exists";

export interface BootstrapAdminInput {
  /** Adresse de connexion. Normalisée par `normaliseEmail`, comme partout ailleurs. */
  email: string;
  /** Le secret en clair. Consommé, haché, jamais conservé ni renvoyé. */
  password: string;
  /** Nom affiché. Par défaut, la partie locale de l'adresse. */
  name?: string;
  /** Nom du locataire. Son identifiant est opaque et retrouvé par ce nom (migration 18). */
  organizationName?: string;
  /**
   * Autorise les deux cas dangereux : une organisation qui a déjà un administrateur
   * actif, et un compte qui existe déjà (son mot de passe est alors remplacé).
   */
  force?: boolean;
}

export interface BootstrapAdminSuccess {
  ok: true;
  userId: string;
  email: string;
  name: string;
  organizationId: OrganizationId;
  organizationName: string;
  role: "admin";
  /** `false` quand un compte existait déjà et que `force` a remplacé son mot de passe. */
  created: boolean;
  /** `true` quand un compte suspendu a été réactivé. */
  reactivated: boolean;
  /**
   * 12 caractères hexadécimaux de `sha256(hachage stocké)`. Permet de vérifier qu'une
   * rotation a bien eu lieu sans jamais manipuler le secret.
   */
  passwordFingerprint: string;
}

export interface BootstrapAdminRefusal {
  ok: false;
  code: BootstrapRefusalCode;
  /** Toutes les raisons, pas seulement la première : l'opérateur corrige en une passe. */
  problems: string[];
}

export type BootstrapAdminResult = BootstrapAdminSuccess | BootstrapAdminRefusal;

function fingerprintOf(storedHash: string): string {
  return crypto.createHash("sha256").update(storedHash).digest("hex").slice(0, 12);
}

/**
 * Crée — ou, sous `force`, réinitialise — un administrateur d'organisation.
 *
 * ## Ordre des opérations, qui est le contrat
 *
 * 1. **Tout** est validé avant la première écriture. Une commande qui crée
 *    l'organisation puis refuse le mot de passe laisserait derrière elle un locataire
 *    vide que rien ne nettoie.
 * 2. Les deux gardes (`admin_exists`, `account_exists`) sont évaluées sur l'état lu
 *    avant écriture.
 * 3. Le hachage est calculé **hors** transaction : scrypt coûte ~40 ms et une
 *    transaction SQLite ouverte pendant ce temps bloquerait un serveur qui tourne.
 * 4. Organisation, compte, statut et appartenance sont écrits dans **une seule**
 *    transaction. Sans cela, une interruption pourrait laisser un utilisateur sans
 *    appartenance : un compte qui existe, dont le mot de passe est correct, et qui
 *    n'ouvre aucune session — l'état le plus difficile à diagnostiquer.
 */
export function bootstrapAdmin(input: BootstrapAdminInput): BootstrapAdminResult {
  /* ---------------------------- 1. validation ---------------------------- */

  const email = typeof input.email === "string" ? normaliseEmail(input.email) : "";
  if (!EMAIL_SHAPE.test(email)) {
    return {
      ok: false,
      code: "invalid_email",
      problems: [
        `"${String(input.email)}" is not a usable sign-in address. ` +
          `Expected: an address of the form person@example.com, without spaces.`,
      ],
    };
  }

  const name = (typeof input.name === "string" ? input.name : email.split("@")[0]).trim();
  if (name === "") {
    return {
      ok: false,
      code: "invalid_name",
      problems: [
        "The display name is empty. This name appears in the audit log " +
          "as the author of a decision; a log with an empty author does not answer " +
          "the question \"who acted\".",
      ],
    };
  }

  const organizationName = (
    typeof input.organizationName === "string" && input.organizationName.trim() !== ""
      ? input.organizationName
      : DEFAULT_BOOTSTRAP_ORGANIZATION_NAME
  ).trim();

  /*
   * Depuis la migration 18, l'identifiant n'est plus dérivé du nom : il est OPAQUE, et
   * il n'existe que dans le registre. Ici on ne fait donc qu'une RECHERCHE, sans rien
   * créer — la création appartient à la transaction d'écriture plus bas, pour qu'une
   * commande qui échoue à la validation du mot de passe ne laisse pas derrière elle une
   * organisation vide.
   *
   * `null` signifie « cette organisation n'existe pas encore », et c'est une
   * information utile plus bas : une organisation inexistante ne peut pas avoir
   * d'administrateur actif, donc la garde du §3 n'a rien à interroger.
   */
  const nameProblem = organizationNameProblem(organizationName);
  if (nameProblem !== null) {
    return {
      ok: false,
      code: "invalid_organization",
      problems: [`The organization "${organizationName}" is refused: ${nameProblem}`],
    };
  }
  const knownOrganization: OrganizationId | null =
    organizationStore.findByName(organizationName)?.id ?? null;

  const password = typeof input.password === "string" ? input.password : "";
  const problems = passwordProblems(password);
  if (problems.length > 0) {
    return { ok: false, code: "weak_password", problems };
  }
  /*
   * La même liste que celle qui refuse un secret de démonstration au démarrage. Elle
   * est importée, pas recopiée : un ajout dans `server/auth.ts` doit protéger aussi
   * cette commande, et un opérateur qui contourne un refus de boot en amorçant le même
   * mot de passe par la CLI n'aurait rien gagné en sécurité.
   */
  if (FORBIDDEN_CREDENTIALS.has(password.toLowerCase())) {
    return {
      ok: false,
      code: "forbidden_password",
      problems: [
        "This password is a known demo value, published in " +
          "documentation, and it is refused just as it is at server startup.",
      ],
    };
  }

  /* ------------------------------ 2. gardes ------------------------------ */

  const force = input.force === true;
  const existing = userStore.findByEmail(email);
  /*
   * `hasAnotherActiveAdmin(org, "")` : la chaîne vide n'est l'identifiant de personne,
   * donc le `u.id <> ?` de la requête n'exclut aucune ligne et le compte porte bien sur
   * *tous* les administrateurs actifs. La méthode existante est réutilisée telle quelle
   * plutôt qu'une nouvelle requête ajoutée au dépôt.
   */
  /*
   * Une organisation qui n'existe pas encore n'a aucun membre, donc aucun
   * administrateur actif. Interroger `hasAnotherActiveAdmin` avec un identifiant
   * fabriqué pour l'occasion aurait été la seule autre option, et aurait voulu dire
   * créer l'organisation avant d'avoir validé quoi que ce soit.
   */
  const organizationHasAdmin =
    knownOrganization !== null && userStore.hasAnotherActiveAdmin(knownOrganization, "");

  if (organizationHasAdmin && !force) {
    return {
      ok: false,
      code: "admin_exists",
      problems: [
        `The organization "${organizationName}" (${knownOrganization}) already has at least one ` +
          `active administrator. Bootstrap is refused: a bootstrap command that ` +
          `runs on an already administered system is indistinguishable from a ` +
          `takeover. Manage accounts from the console, or run again with --force if ` +
          `you are deliberately recovering lost access.`,
      ],
    };
  }

  if (existing && !force) {
    return {
      ok: false,
      code: "account_exists",
      problems: [
        `The account "${email}" already exists. Its password is not replaced without ` +
          `--force: overwriting it silently would be a password reset ` +
          `disguised as account creation.`,
      ],
    };
  }

  /* ----------------------- 3. hachage, hors transaction ------------------ */

  const passwordHash = hashPassword(password);

  /* ------------------------- 4. écriture atomique ------------------------ */

  const created = existing === null;
  let reactivated = false;

  /*
   * La transaction renvoie l'identifiant qu'elle a frappé, au lieu de l'écrire dans une
   * variable de la portée englobante : le compilateur ne peut pas prouver qu'une closure
   * passée à `transaction()` a bien été exécutée, et un `organizationId` « peut-être
   * assigné » n'a aucune place dans le compte rendu d'une commande qui crée un
   * administrateur.
   */
  const write = rawDb.transaction(() => {
    /*
     * Crée l'organisation si elle n'existe pas, sinon retrouve celle qui porte ce nom —
     * et c'est ici, et nulle part ailleurs, que l'identifiant opaque est frappé. Dans la
     * transaction : une commande interrompue entre la création de l'organisation et
     * celle de l'administrateur ne doit pas laisser un locataire sans compte.
     */
    const organization = organizationStore.ensureByName(organizationName).id;

    const user = userStore.ensure({
      email,
      name,
      passwordHash,
      // `user`, jamais `config` : c'est ce marqueur qui empêche `OATHRION_CONSOLE_USERS`
      // d'écraser ce mot de passe au démarrage suivant, et donc qui fait de cette
      // commande une alternative réelle à la variable d'environnement plutôt qu'un
      // détour vers elle.
      passwordSource: "user",
    });

    if (!created) {
      // `ensure` ne touche jamais un mot de passe existant — c'est la bonne règle pour
      // l'adoption au démarrage. Ici l'intention est explicite et couverte par --force.
      userStore.setPassword(user.id, passwordHash, "user");
    }
    if (user.status !== "active") {
      userStore.setStatus(user.id, "active");
      reactivated = true;
    }
    userStore.grant(organization, user.id, "admin");
    return { userId: user.id, organization };
  });

  const { userId, organization } = write();

  return {
    ok: true,
    userId,
    email,
    name,
    organizationId: organization,
    organizationName,
    role: "admin",
    created,
    reactivated,
    passwordFingerprint: fingerprintOf(passwordHash),
  };
}
