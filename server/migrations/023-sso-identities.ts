/**
 * Migration 23 — la liaison entre une identité du fournisseur et un compte de console.
 *
 * ## Le défaut que cette table corrige
 *
 * La première version du SSO reliait les deux par l'ADRESSE ÉLECTRONIQUE, et par elle
 * seule : `findByEmail(verdict.email)`. C'est le raccourci naturel, et il a un mode de
 * défaillance qui ne se voit pas en recette.
 *
 * Une adresse électronique est RÉATTRIBUABLE. Dans un annuaire d'entreprise,
 * `comptabilite@client.example` ou même `marie.dupont@client.example` peut changer de
 * titulaire : un départ, une homonymie, un alias repris par le service informatique. Le
 * jour où cela arrive, la nouvelle personne se connecte et hérite SILENCIEUSEMENT du
 * compte de console de l'ancienne — avec son rôle, son organisation et ses approbations
 * en attente. Aucun journal ne signale quoi que ce soit, puisque du point de vue de
 * Oathrion c'est la même adresse qui revient.
 *
 * Le `sub` d'un jeton d'identité, lui, est stable et ne se réattribue jamais : c'est
 * précisément ce que la spécification lui demande d'être. La paire `(issuer, sub)` est
 * donc la clé d'identité, et l'adresse redevient ce qu'elle est — un attribut, utile pour
 * la PREMIÈRE liaison et pour l'affichage.
 *
 * ## Ce que la table permet de refuser
 *
 * Trois situations deviennent détectables, et chacune est refusée plutôt que devinée :
 *
 *   · un `sub` connu dont l'adresse a changé → on suit le `sub`, et on journalise le
 *     changement d'adresse. C'est un mariage, pas une attaque.
 *   · une adresse connue portée par un `sub` INCONNU alors que le compte est déjà lié à
 *     un autre `sub` → REFUS. C'est exactement le cas de la réattribution d'adresse, et
 *     suivre l'une ou l'autre piste serait un choix arbitraire sur une question
 *     d'identité.
 *   · un `sub` déjà lié à un AUTRE compte de console → REFUS. Deux comptes pour une
 *     personne est une erreur d'administration qui doit se corriger à la main.
 *
 * ## Les contraintes, et pourquoi la base les porte
 *
 * **`UNIQUE (issuer, subject)`** : une identité du fournisseur ne désigne qu'un compte.
 * **`UNIQUE (issuer, user_id)`** : un compte n'a qu'une identité CHEZ UN ÉMETTEUR DONNÉ —
 * la paire laisse la place à un second fournisseur plus tard sans migration.
 *
 * Les deux sont posées par la BASE et non par l'application, parce que deux connexions
 * simultanées de la même personne lisent toutes les deux « aucune liaison » avant que
 * l'une ait écrit. Un contrôle applicatif se perd dans cette fenêtre ; une contrainte
 * d'unicité fait échouer la seconde écriture, et l'échec est rattrapable.
 *
 * Il n'y a **pas** de colonne pour le jeton, ni pour une revendication brute. Cette table
 * dit QUI est qui ; elle n'archive pas ce que le fournisseur a raconté.
 */

import type { Migration, SchemaInspect } from "./types";

export const SSO_IDENTITIES_TABLE = "sso_identities";

export const ssoIdentities: Migration = {
  version: 23,
  name: "sso-identities",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(SSO_IDENTITIES_TABLE)) return [];

    const common = `
         id              TEXT PRIMARY KEY,
         issuer          TEXT NOT NULL,
         subject         TEXT NOT NULL,
         user_id         TEXT NOT NULL,
         organization_id TEXT,
         last_email      TEXT NOT NULL`;

    const indexes = [
      /* Une identité du fournisseur ne désigne qu'un seul compte de console. */
      `CREATE UNIQUE INDEX IF NOT EXISTS ${SSO_IDENTITIES_TABLE}_identity
         ON ${SSO_IDENTITIES_TABLE} (issuer, subject)`,
      /* Et un compte n'a qu'une identité chez un émetteur donné. */
      `CREATE UNIQUE INDEX IF NOT EXISTS ${SSO_IDENTITIES_TABLE}_account
         ON ${SSO_IDENTITIES_TABLE} (issuer, user_id)`,
    ];

    if (schema.dialect === "sqlite") {
      return [
        `CREATE TABLE IF NOT EXISTS ${SSO_IDENTITIES_TABLE} (${common},
           created_at    TEXT NOT NULL,
           last_seen_at  TEXT NOT NULL
         )`,
        ...indexes,
      ];
    }
    return [
      `CREATE TABLE IF NOT EXISTS ${SSO_IDENTITIES_TABLE} (${common},
         created_at    TIMESTAMPTZ NOT NULL,
         last_seen_at  TIMESTAMPTZ NOT NULL
       )`,
      ...indexes,
    ];
  },
};
