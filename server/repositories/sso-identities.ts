/**
 * Le dépôt des liaisons entre une identité de fournisseur et un compte de console.
 *
 * ## Le défaut corrigé, en une phrase
 *
 * La première version du SSO reliait les deux par l'adresse électronique seule. Une
 * adresse est RÉATTRIBUABLE dans un annuaire d'entreprise ; un `sub` ne l'est pas. Le
 * jour où une adresse change de titulaire, la liaison par adresse donne silencieusement
 * le compte de console de l'ancien titulaire au nouveau — rôle, organisation et
 * approbations en attente comprises.
 *
 * ## La seule décision de ce fichier
 *
 * `resolve()` ne choisit jamais entre deux pistes contradictoires : il REFUSE. Une
 * question d'identité ne se tranche pas par convention, et le refus laisse un
 * administrateur corriger en connaissance de cause. Les trois verdicts sont nommés dans
 * `SsoResolution`, et l'appelant doit les traiter — le type ne permet pas de les oublier.
 *
 * ## Ce que ce fichier NE stocke pas
 *
 * Aucun jeton, aucune revendication brute. La table dit qui est qui ; elle n'archive pas
 * ce que le fournisseur a raconté. Le jour où un client demande l'effacement de ses
 * données, une ligne de cette table est une ligne lisible et explicable.
 */

import crypto from "node:crypto";

import { rawDb } from "../db";
import { SSO_IDENTITIES_TABLE } from "../migrations";

export interface SsoIdentityRecord {
  id: string;
  issuer: string;
  subject: string;
  userId: string;
  organizationId: string | null;
  lastEmail: string;
  createdAt: string;
  lastSeenAt: string;
}

interface Row {
  id: string;
  issuer: string;
  subject: string;
  user_id: string;
  organization_id: string | null;
  last_email: string;
  created_at: string;
  last_seen_at: string;
}

const toRecord = (row: Row): SsoIdentityRecord => ({
  id: row.id,
  issuer: row.issuer,
  subject: row.subject,
  userId: row.user_id,
  organizationId: row.organization_id,
  lastEmail: row.last_email,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

/*
 * Préparation PARESSEUSE. Une préparation au niveau du module s'exécuterait pendant
 * l'évaluation de `db.ts`, quand le plan d'identité n'existe pas encore — et elle
 * reste hissée, donc le SQL n'est analysé qu'une fois malgré tout. C'est la leçon du
 * profil CPU du chantier précédent : `api-keys.ts` réanalysait son SQL à chaque appel
 * et cela pesait 2,6 s sur 11 s de blocage.
 */
type Statement = ReturnType<typeof rawDb.prepare<unknown[]>>;
function lazy(sql: string): () => Statement {
  let prepared: Statement | undefined;
  return () => (prepared ??= rawDb.prepare<unknown[]>(sql));
}

const byIdentity = lazy(
  `SELECT * FROM ${SSO_IDENTITIES_TABLE} WHERE issuer = ? AND subject = ?`,
);
const byAccount = lazy(`SELECT * FROM ${SSO_IDENTITIES_TABLE} WHERE issuer = ? AND user_id = ?`);
const insert = lazy(
  `INSERT INTO ${SSO_IDENTITIES_TABLE}
     (id, issuer, subject, user_id, organization_id, last_email, created_at, last_seen_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const removeIdentity = lazy(
  `DELETE FROM ${SSO_IDENTITIES_TABLE} WHERE issuer = ? AND subject = ?`,
);
const removeForUser = lazy(
  `DELETE FROM ${SSO_IDENTITIES_TABLE} WHERE issuer = ? AND user_id = ?`,
);
const touch = lazy(
  `UPDATE ${SSO_IDENTITIES_TABLE} SET last_email = ?, last_seen_at = ?, organization_id = ?
     WHERE issuer = ? AND subject = ?`,
);

/** Ce que la liaison permet de conclure — et les deux cas où elle refuse de conclure. */
export type SsoResolution =
  /** `(issuer, sub)` est déjà lié : c'est ce compte, quelle que soit l'adresse du jour. */
  | { kind: "bound"; userId: string; emailChangedFrom: string | null }
  /** Aucune liaison pour ce `sub` : l'appelant peut lier ce compte-ci. */
  | { kind: "unbound" }
  /**
   * L'adresse désigne un compte DÉJÀ lié à un autre `sub` chez le même émetteur. C'est
   * exactement la réattribution d'adresse, et suivre l'une ou l'autre piste serait un
   * choix arbitraire sur une question d'identité.
   */
  | { kind: "conflict"; reason: "email_belongs_to_another_identity"; boundSubject: string };

export const ssoIdentityStore = {
  find(issuer: string, subject: string): SsoIdentityRecord | null {
    const row = byIdentity().get(issuer, subject) as Row | undefined;
    return row ? toRecord(row) : null;
  },

  findForUser(issuer: string, userId: string): SsoIdentityRecord | null {
    const row = byAccount().get(issuer, userId) as Row | undefined;
    return row ? toRecord(row) : null;
  },

  /**
   * Le verdict d'identité, pour un `(issuer, sub)` et le compte que l'adresse désigne.
   *
   * `candidateUserId` est le compte trouvé par adresse — c'est-à-dire l'ANCIENNE méthode,
   * qui reste utile pour la PREMIÈRE liaison et pour rien d'autre. Passez `null` si
   * aucun compte ne porte cette adresse.
   */
  resolve(
    issuer: string,
    subject: string,
    candidateUserId: string | null,
    email: string,
  ): SsoResolution {
    const bound = this.find(issuer, subject);
    if (bound) {
      /*
       * Le `sub` gagne, toujours. Une adresse qui a changé est un mariage ou un
       * changement de nom, pas une attaque — mais on le signale, parce qu'un changement
       * d'adresse silencieux est aussi ce qu'on voudrait voir dans un journal le jour
       * où une question se pose.
       */
      return {
        kind: "bound",
        userId: bound.userId,
        emailChangedFrom: bound.lastEmail === email ? null : bound.lastEmail,
      };
    }
    if (candidateUserId !== null) {
      const already = this.findForUser(issuer, candidateUserId);
      if (already) {
        return {
          kind: "conflict",
          reason: "email_belongs_to_another_identity",
          boundSubject: already.subject,
        };
      }
    }
    return { kind: "unbound" };
  },

  /**
   * Lie `(issuer, sub)` à un compte, ou rafraîchit une liaison existante.
   *
   * L'unicité est posée par la BASE : deux connexions simultanées de la même personne
   * lisent toutes les deux « aucune liaison » avant que l'une ait écrit, et c'est la
   * seconde écriture qui échoue. L'échec est rattrapé ici en relisant — la course a un
   * gagnant, et les deux connexions aboutissent au même compte.
   */
  bind(input: {
    issuer: string;
    subject: string;
    userId: string;
    organizationId: string | null;
    email: string;
  }): SsoIdentityRecord {
    const now = new Date().toISOString();
    const existing = this.find(input.issuer, input.subject);
    if (existing) {
      touch().run(
        input.email,
        now,
        input.organizationId,
        input.issuer,
        input.subject,
      );
      return { ...existing, lastEmail: input.email, lastSeenAt: now };
    }
    try {
      insert().run(
        `sso_${crypto.randomBytes(12).toString("hex")}`,
        input.issuer,
        input.subject,
        input.userId,
        input.organizationId,
        input.email,
        now,
        now,
      );
    } catch (error) {
      /*
       * La course décrite ci-dessus. On relit : si la ligne est là, l'autre connexion a
       * gagné et le résultat est le bon. Sinon l'erreur est réelle et remonte.
       */
      const raced = this.find(input.issuer, input.subject);
      if (!raced) throw error;
      return raced;
    }
    return this.find(input.issuer, input.subject)!;
  },

  /**
   * LA SORTIE DE SECOURS, et elle n'est pas facultative.
   *
   * Le refus de conflit protège un compte, mais il a un coût d'exploitation réel : si le
   * fournisseur réémet un `sub` pour la MÊME personne — un annuaire reconstruit, un
   * utilisateur re-provisionné, une migration d'IdP — le compte devient inaccessible et
   * aucune connexion ne peut plus le rattraper. Sans ce chemin, la seule issue serait un
   * `DELETE` à la main dans la base de production, c'est-à-dire la pire des procédures
   * d'incident.
   *
   * La liaison est donc délibérément EFFAÇABLE. La connexion suivante en recrée une par
   * l'adresse, exactement comme une première connexion — et c'est un acte
   * d'administration explicite, pas un repli automatique.
   */
  unbind(issuer: string, subject: string): void {
    removeIdentity().run(issuer, subject);
  },

  /** La même sortie, prise par le compte quand on ne connaît pas le `sub`. */
  unbindUser(issuer: string, userId: string): void {
    removeForUser().run(issuer, userId);
  },
};
