/**
 * Migration 22 — les requêtes interceptées qui attendent un humain.
 *
 * ## Le défaut que cette table ferme
 *
 * Le pare-feu garait la requête interceptée dans une `Map` du processus, avec un TTL de
 * **soixante secondes**. Pour un ALLOW, qui est synchrone, cela suffisait. Pour une
 * approbation humaine, cela donnait à l'opérateur une minute pour décider : au-delà,
 * l'approbation réussissait et le relais répondait « la requête n'est plus disponible ».
 * L'appel de l'agent était perdu.
 *
 * Deux autres conséquences du même choix : un redémarrage effaçait toutes les requêtes en
 * attente, et sur deux instances derrière un répartiteur, approuver sur l'une ne pouvait
 * pas relâcher une requête garée sur l'autre.
 *
 * Le défaut échouait du bon côté — rien ne partait, le motif était nommé — mais il rendait
 * la fonctionnalité inutilisable là où elle compte.
 *
 * ## Pourquoi seule la voie LENTE est persistée
 *
 * Un ALLOW ne touche pas cette table. La requête reste en mémoire, le relais la reprend
 * dans la même requête HTTP, et rien n'est écrit : payer une écriture et une suppression
 * pour chaque appel autorisé serait une amplification d'écriture au bénéfice de personne.
 *
 * La route n'écrit ici **que** lorsque la décision est APPROVAL_REQUIRED, c'est-à-dire
 * quand un humain entre dans la boucle et que l'attente se mesure en minutes.
 *
 * ## Ce qui est chiffré, et pourquoi c'est une tension assumée
 *
 * `headers_envelope` et `body_envelope` sont chiffrés par `server/secrets/envelope.ts`,
 * du même chiffrement d'enveloppe que le coffre de credentials.
 *
 * Il y a une contradiction apparente avec la règle que ce dépôt vient d'imposer au
 * pare-feu : **le corps d'une requête ne doit pas être persisté**. Elle ne disparaît pas,
 * elle est arbitrée. Pour compléter une requête APRÈS qu'un humain l'ait approuvée, il
 * faut la conserver : l'alternative est de la perdre, ce qui est exactement le défaut
 * qu'on corrige. Les trois garde-fous sont donc :
 *
 *   1. **chiffré au repos**, avec le locataire dans le contexte authentifié ;
 *   2. **à usage unique** — la ligne est supprimée à la reprise ;
 *   3. **borné dans le temps** — `expires_at` suit le TTL d'approbation, et une ligne
 *      expirée n'est jamais rendue, même si personne ne l'a balayée.
 *
 * Ce n'est pas la trace d'audit : celle-ci ne porte toujours que les champs évalués.
 * C'est un sas, dont le contenu est illisible sans la clé et disparaît à l'usage.
 *
 * ## La colonne s'appelle bien `organization_id`
 *
 * Comme le coffre de credentials, et contrairement au registre d'effacement : ces lignes
 * **appartiennent** au locataire et doivent partir avec lui. La découverte par nom de
 * colonne qu'emploie `script/lib/tenant-purge.ts` doit donc les atteindre.
 */

import type { Migration, SchemaInspect } from "./types";

export const PENDING_INTERCEPTIONS_TABLE = "pending_interceptions";

export const pendingInterceptions: Migration = {
  version: 22,
  name: "pending-interceptions",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(PENDING_INTERCEPTIONS_TABLE)) return [];

    const common = `
         organization_id      TEXT NOT NULL,
         /* Le jeton tiré par la route, porté par les métadonnées de l'exécution. */
         ref                  TEXT NOT NULL,
         /* L'exécution retenue, pour qu'un opérateur puisse relier les deux. */
         execution_id         TEXT NOT NULL DEFAULT '',
         destination_id       TEXT NOT NULL,
         method               TEXT NOT NULL,
         path                 TEXT NOT NULL,
         /* JSON en clair : une chaîne de requête n'est pas un secret, et un index la lit. */
         query                TEXT NOT NULL DEFAULT '{}',
         /* Chiffrés : un en-tête peut porter un jeton, un corps peut porter un client. */
         headers_envelope     TEXT NOT NULL,
         body_envelope        TEXT NOT NULL,
         credential_header    TEXT NOT NULL,
         credential_template  TEXT NOT NULL,
         /*
          * JSON: string[] -- l'allowlist d'en-tetes de la regle, FIGEE au moment de la
          * decision. La relire depuis OATHRION_INTERCEPTS a la reprise ferait partir la
          * requete avec la permission du moment ou un humain clique, qui peut etre plus
          * large que celle qui a ete jugee. (Sans accent ni backtick : ce commentaire vit
          * dans un litteral de gabarit, ou un backtick fermerait la chaine.)
          */
         forward_headers      TEXT NOT NULL DEFAULT '[]'`;

    if (schema.dialect === "sqlite") {
      return [
        `CREATE TABLE IF NOT EXISTS ${PENDING_INTERCEPTIONS_TABLE} (${common},
           created_at TEXT NOT NULL,
           expires_at TEXT NOT NULL,
           PRIMARY KEY (organization_id, ref)
         )`,
        /*
         * Sur `expires_at` : le balayage des lignes périmées est une suppression par
         * plage, et c'est la requête qui tournera le plus souvent sur cette table.
         */
        `CREATE INDEX IF NOT EXISTS ${PENDING_INTERCEPTIONS_TABLE}_by_expiry
           ON ${PENDING_INTERCEPTIONS_TABLE} (expires_at)`,
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS ${PENDING_INTERCEPTIONS_TABLE} (${common},
         created_at TIMESTAMPTZ NOT NULL,
         expires_at TIMESTAMPTZ NOT NULL,
         PRIMARY KEY (organization_id, ref)
       )`,
      `CREATE INDEX IF NOT EXISTS ${PENDING_INTERCEPTIONS_TABLE}_by_expiry
         ON ${PENDING_INTERCEPTIONS_TABLE} (expires_at)`,
    ];
  },
};
