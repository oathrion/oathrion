/**
 * Migration 21 — le coffre de credentials des connecteurs.
 *
 * ## Ce que cette table rend possible, et qui manquait
 *
 * `server/secrets/envelope.ts` existe depuis la phase S1 : chiffrement d'enveloppe
 * AES-256-GCM, un DEK par valeur, un KEK qui l'emballe, rotation sans réécrire les
 * données. Il est éprouvé par `server/test/secrets.test.ts` — et il n'avait **aucun
 * consommateur**. `script/verify-disaster-recovery.ts` le disait franchement : « Aucune
 * donnée n'est chiffrée en base aujourd'hui ».
 *
 * La raison est simple : rien dans Oathrion ne détenait encore de credential d'un service
 * tiers. La table `integrations` ne stockait qu'une étiquette, une catégorie et un
 * booléen `connected` qu'un clic faisait basculer. Aucun jeton, aucun appel, aucun test
 * de connexion — une interface qui disait « Connected » sans que rien ne soit connecté.
 *
 * Cette table est le coffre qui manquait. Elle est le premier consommateur réel du
 * chiffrement d'enveloppe.
 *
 * ## Ce qui est chiffré, et ce qui ne l'est pas
 *
 * **Chiffré** : `secret_envelope`, et rien d'autre. C'est le jeton du service tiers —
 * la seule valeur qu'un dump de base ne doit pas livrer en clair.
 *
 * **En clair, délibérément** : le fournisseur, le compte visé, les portées accordées,
 * l'horodatage du dernier test de connexion et son résultat. Ce sont les données que la
 * console doit afficher et que l'exploitation doit pouvoir interroger. Les chiffrer
 * obligerait à déchiffrer pour dessiner une liste, donc à charger la clé à chaque
 * affichage, et ne protégerait rien : savoir qu'un locataire a connecté GitHub n'est pas
 * un secret pour qui lit déjà sa base.
 *
 * ## Le jeton n'est jamais relu par une route
 *
 * Il n'existe aucun chemin qui rende `secret_envelope` à un client HTTP, ni déchiffré ni
 * chiffré. Le seul lecteur est le connecteur lui-même, au moment d'un appel, à
 * l'intérieur de `Tool.run()`. `server/test/connector-credential-vault.test.ts` l'assied
 * structurellement : une route qui exposerait la colonne fait échouer la suite.
 *
 * ## `fingerprint` — reconnaître un jeton sans le détenir
 *
 * Les six premiers caractères de SHA-256 du jeton. Assez pour qu'un exploitant confirme
 * « c'est bien le jeton que j'ai créé mardi » et pour qu'un journal distingue deux
 * rotations ; inutilisable pour retrouver le jeton. La colonne existe parce que
 * l'alternative pratiquée partout est d'afficher les quatre derniers caractères du
 * secret lui-même, ce qui est un fragment du secret.
 *
 * ## Une seule ligne par (locataire, connecteur)
 *
 * Clé primaire composite `(organization_id, connector_id)`. Reconnecter REMPLACE :
 * conserver un historique de jetons révoqués serait conserver des credentials dont
 * personne n'a plus besoin, et un credential qu'on garde est un credential qui fuit.
 * La trace de la révocation va dans la piste d'audit, qui ne contient pas le secret.
 *
 * La colonne s'appelle bien `organization_id` ici — contrairement au registre
 * d'effacement de la migration 20. C'est voulu : un credential **appartient** au
 * locataire et doit disparaître avec lui. La découverte par nom de colonne qu'emploie
 * `script/lib/tenant-purge.ts` doit donc l'atteindre, et une purge doit emporter le
 * coffre. C'est exactement l'inverse du piège de la migration 20, pour exactement la
 * même raison : la colonne décide de l'appartenance.
 */

import type { Migration, SchemaInspect } from "./types";

export const CONNECTOR_CREDENTIALS_TABLE = "connector_credentials";

export const connectorCredentials: Migration = {
  version: 21,
  name: "connector-credentials",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(CONNECTOR_CREDENTIALS_TABLE)) return [];

    const common = `
         organization_id   TEXT NOT NULL,
         /* "github", "mcp", … — le fournisseur, pas une instance. */
         connector_id      TEXT NOT NULL,
         /* Le compte ou l'installation visée, en clair : la console l'affiche. */
         account           TEXT NOT NULL DEFAULT '',
         /* JSON: string[] — les portées que le service a RÉELLEMENT confirmées. */
         scopes            TEXT NOT NULL DEFAULT '[]',
         /* L'enveloppe AES-256-GCM. Jamais rendue par une route, ni en clair ni scellée. */
         secret_envelope   TEXT NOT NULL,
         /* 6 caractères de SHA-256 du jeton. Reconnaissable, pas réutilisable. */
         fingerprint       TEXT NOT NULL DEFAULT '',
         /* "connected" | "error" | "revoked" — l'état RÉEL, issu d'un appel. */
         status            TEXT NOT NULL DEFAULT 'connected',
         /* Le motif du dernier échec, tel que le service l'a donné. Jamais inventé. */
         status_detail     TEXT NOT NULL DEFAULT '',
         connected_by      TEXT NOT NULL DEFAULT ''`;

    if (schema.dialect === "sqlite") {
      return [
        `CREATE TABLE IF NOT EXISTS ${CONNECTOR_CREDENTIALS_TABLE} (${common},
           connected_at    TEXT NOT NULL,
           last_checked_at TEXT,
           PRIMARY KEY (organization_id, connector_id)
         )`,
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS ${CONNECTOR_CREDENTIALS_TABLE} (${common},
         connected_at    TIMESTAMPTZ NOT NULL,
         last_checked_at TIMESTAMPTZ,
         PRIMARY KEY (organization_id, connector_id)
       )`,
    ];
  },
};
