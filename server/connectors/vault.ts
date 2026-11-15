/**
 * Le coffre de credentials des connecteurs.
 *
 * ## Ce que ce fichier est, et ce qu'il n'est pas
 *
 * C'est le premier consommateur réel de `server/secrets/envelope.ts`. Le chiffrement
 * d'enveloppe existait depuis la phase S1, éprouvé par `server/test/secrets.test.ts`, et
 * `script/verify-disaster-recovery.ts` notait sans détour : « Aucune donnée n'est
 * chiffrée en base aujourd'hui ». La raison était qu'aucune donnée ne le MÉRITAIT :
 * Oathrion ne détenait aucun jeton d'un service tiers.
 *
 * Ce n'est pas un gestionnaire de secrets. Les KEK viennent de l'environnement par
 * `SecretProvider`, et le dépôt n'en implémente aucun fournisseur cloud — c'est écrit
 * dans `server/secrets/provider.ts` et ce fichier ne le contredit pas.
 *
 * ## LA RÈGLE QUE CE MODULE FAIT TENIR
 *
 * **Aucune fonction d'ici ne rend un secret à un appelant HTTP.** `open()` est la seule
 * qui déchiffre, et son unique appelant est un connecteur, à l'intérieur de
 * `Tool.run()` — donc après un ALLOW de la passerelle. Les routes n'appellent que
 * `describe()`, qui ne rend ni le jeton ni son enveloppe.
 *
 * La séparation est structurelle et non une discipline : deux types de retour
 * différents, `StoredCredential` (avec l'enveloppe) interne au module, et
 * `ConnectorStatus` (sans) pour tout le reste. `server/test/connector-vault.test.ts`
 * assied la clôture en relisant les sources.
 *
 * ## Pourquoi le contexte de scellement contient le locataire
 *
 * `sealSecret(keyring, "connector:org_acme:github", token)`. Le contexte est authentifié
 * par AES-GCM : une enveloppe copiée dans la ligne d'un autre locataire ne déchiffre
 * pas. C'est l'exemple que `envelope.ts` donnait lui-même dans son message d'erreur, et
 * c'est la défense qui reste debout quand le filtre `organization_id` d'une requête est
 * oublié.
 */

import { createHash } from "node:crypto";

import type { OrganizationId } from "@shared/tenancy";

import {
  isEnvelope,
  loadKeyring,
  openSecret,
  sealSecret,
  type Keyring,
} from "../secrets/envelope";
import { resolveSecretProvider } from "../secrets/provider";
import type { SqlExecutor } from "../sql/executor";
import { CONNECTOR_CREDENTIALS_TABLE } from "../migrations/021-connector-credentials";

/**
 * L'état RÉEL d'un connecteur pour un locataire. Jamais une étiquette décorative.
 *
 * `stored_unverified` existe pour une raison précise et il ne faut pas le confondre avec
 * `connected`. Un credential de DESTINATION — la clé que le pare-feu injecte vers une API
 * quelconque — n'a pas de sonde : Oathrion ne sait pas comment Stripe, Jira ou une API
 * interne vérifient une clé, et il n'y a pas de connecteur du catalogue derrière pour le
 * lui dire. Le credential est donc scellé, utilisable, et **jamais annoncé comme
 * vérifié**. La première preuve qu'il est bon viendra du premier appel relayé.
 *
 * Inventer un `connected` ici serait exactement le faux statut « protégé » que ce dépôt
 * refuse : une pastille verte sur une clé que personne n'a essayée.
 */
export type ConnectorState =
  | "not_configured"
  | "connected"
  | "stored_unverified"
  | "error"
  | "revoked";

export class VaultUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `The credential vault is not available: ${detail}\n` +
        `  A connector cannot store a token without an encryption key. Declare ` +
        `OATHRION_KEK (32 bytes, base64 or hex) before connecting a service. Oathrion ` +
        `refuses to store a credential in cleartext, even temporarily.`,
    );
    this.name = "VaultUnavailableError";
  }
}

/**
 * Ce qu'une route peut voir. Pas de jeton, pas d'enveloppe, pas de longueur de secret.
 *
 * `fingerprint` est 6 caractères de SHA-256 du jeton : assez pour qu'un exploitant
 * confirme « c'est bien celui que j'ai créé mardi », inutilisable pour le reconstituer.
 * L'usage répandu — afficher les quatre derniers caractères du secret — divulgue un
 * fragment du secret lui-même.
 */
export interface ConnectorStatus {
  connectorId: string;
  state: ConnectorState;
  /** Le compte ou l'installation réellement joints, tels que le service les a nommés. */
  account: string;
  /** Les portées que le SERVICE a confirmées, jamais celles que l'exploitant a demandées. */
  scopes: string[];
  fingerprint: string;
  detail: string;
  connectedBy: string;
  connectedAt: string | null;
  lastCheckedAt: string | null;
}

/** Interne au module. L'enveloppe ne sort pas d'ici. */
interface StoredCredential {
  secretEnvelope: string;
  account: string;
  scopes: string[];
}

interface Row {
  connector_id: string;
  account: string;
  scopes: string;
  secret_envelope: string;
  fingerprint: string;
  status: string;
  status_detail: string;
  connected_by: string;
  connected_at: string;
  last_checked_at: string | null;
}

function parseScopes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function toStatus(row: Row): ConnectorStatus {
  return {
    connectorId: row.connector_id,
    /*
     * La liste est explicite, et un état inconnu devient `error` plutôt que d'être rendu
     * tel quel : une valeur arrivée en base par un chemin qu'on n'a pas prévu ne doit pas
     * s'afficher comme si elle était comprise.
     *
     * `stored_unverified` a dû être AJOUTÉ ici, et l'oubli était instructif : un
     * credential de destination parfaitement scellé s'affichait « error ». Un faux statut
     * dans ce sens-là est moins dangereux que l'inverse, et il reste faux.
     */
    state:
      row.status === "connected" ||
      row.status === "stored_unverified" ||
      row.status === "error" ||
      row.status === "revoked"
        ? row.status
        : "error",
    account: row.account,
    scopes: parseScopes(row.scopes),
    fingerprint: row.fingerprint,
    detail: row.status_detail,
    connectedBy: row.connected_by,
    connectedAt: isoInstant(row.connected_at),
    lastCheckedAt: row.last_checked_at === null ? null : isoInstant(row.last_checked_at),
  };
}

/**
 * Un instant TOUJOURS rendu en texte ISO. Sous PostgreSQL, ces colonnes sont
 * `TIMESTAMPTZ` et `pg` rend un objet `Date` ; sous SQLite, du texte. Le type promettait
 * du texte dans les deux cas, et le JSON des routes masquait l'écart — jusqu'à ce que la
 * réconciliation passe `connectedAt` à GitHub comme borne `since` : « Sun Oct 25 2026… »,
 * illisible pour GitHub, qui ne rendait plus rien (STRESS-TEST-LOG §5.19).
 */
function isoInstant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

/** Les 6 premiers caractères de SHA-256. Reconnaissable, pas réversible. */
export function fingerprintOf(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 6);
}

/*
 * Le trousseau est chargé une fois par processus et conservé : `loadKeyring` lit
 * l'environnement et décode les clés, et le refaire à chaque appel multiplierait les
 * copies de clé en mémoire sans rien gagner. Une erreur de chargement n'est PAS mise en
 * cache : une configuration corrigée doit pouvoir réussir au prochain essai sans
 * redémarrer.
 */
let cachedKeyring: Keyring | null = null;

export async function vaultKeyring(env: NodeJS.ProcessEnv = process.env): Promise<Keyring> {
  if (cachedKeyring) return cachedKeyring;
  try {
    cachedKeyring = await loadKeyring(resolveSecretProvider(env));
  } catch (error) {
    throw new VaultUnavailableError(error instanceof Error ? error.message : String(error));
  }
  return cachedKeyring;
}

/** Test-only : oublie le trousseau pour qu'un autre environnement puisse être chargé. */
export function resetVaultKeyring(): void {
  cachedKeyring = null;
}

/**
 * Le contexte de scellement. Lié au locataire ET au connecteur.
 *
 * `envelope.ts` refuse un contexte contenant « . » (il casserait son format), d'où la
 * vérification explicite : un identifiant de connecteur mal formé doit être refusé ici
 * plutôt que de produire une enveloppe au contexte tronqué.
 */
export function sealingContext(org: OrganizationId, connectorId: string): string {
  if (connectorId.includes(".") || connectorId.includes(":") || connectorId.trim() === "") {
    throw new VaultUnavailableError(
      `the connector ID ${JSON.stringify(connectorId)} is invalid; ` +
        `it cannot contain "." or ":".`,
    );
  }
  return `connector:${org}:${connectorId}`;
}

/*
 * LA CLÉ DE SIGNATURE D'UNE ORGANISATION (le mandat vérifiable, `server/mandates.ts`). Scellée et
 * ouverte ICI, parce que ce fichier est le seul à déchiffrer (`connector-single-path.test.ts`).
 * Elle ne sort jamais vers un appelant HTTP : le service des mandats signe avec, et c'est tout.
 */
export async function sealOrganizationSigningKey(org: OrganizationId, pem: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return sealSecret(await vaultKeyring(env), `mandate:${org}:organization`, pem);
}

export async function openOrganizationSigningKey(org: OrganizationId, sealed: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return openSecret(await vaultKeyring(env), `mandate:${org}:organization`, sealed);
}

export class ConnectorVault {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** L'état de chaque connecteur configuré. Sans secret, pour les routes. */
  async describeAll(): Promise<ConnectorStatus[]> {
    const rows = await this.sql.all<Row>(
      `SELECT connector_id, account, scopes, secret_envelope, fingerprint, status,
              status_detail, connected_by, connected_at, last_checked_at
         FROM ${CONNECTOR_CREDENTIALS_TABLE} WHERE organization_id = ?
        ORDER BY connector_id ASC`,
      [this.org],
    );
    return rows.map(toStatus);
  }

  async describe(connectorId: string): Promise<ConnectorStatus | null> {
    const rows = await this.sql.all<Row>(
      `SELECT connector_id, account, scopes, secret_envelope, fingerprint, status,
              status_detail, connected_by, connected_at, last_checked_at
         FROM ${CONNECTOR_CREDENTIALS_TABLE}
        WHERE organization_id = ? AND connector_id = ?`,
      [this.org, connectorId],
    );
    const row = rows[0];
    return row ? toStatus(row) : null;
  }

  /**
   * Scelle un jeton et l'écrit. Reconnecter REMPLACE la ligne précédente.
   *
   * Le jeton n'est jamais écrit en clair, pas même transitoirement : le scellement a lieu
   * avant la requête, et c'est l'enveloppe qui est passée en paramètre. Un `INSERT` du
   * clair suivi d'un `UPDATE` du chiffré laisserait le secret dans le WAL et dans les
   * journaux de requêtes lentes.
   */
  /**
   * Scelle un credential.
   *
   * `verified` dit si un SERVICE a confirmé la clé. `true` vient d'une sonde réussie d'un
   * connecteur du catalogue ; `false` est le cas d'une destination du pare-feu, où aucune
   * sonde n'existe. L'argument est obligatoire plutôt que par défaut : un défaut à `true`
   * ferait qu'un futur appelant qui l'oublie annonce « connecté » sans avoir rien
   * vérifié, et un défaut à `false` dégraderait silencieusement le chemin du catalogue.
   */
  async store(params: {
    connectorId: string;
    secret: string;
    account: string;
    scopes: string[];
    connectedBy: string;
    verified: boolean;
    now?: Date;
  }): Promise<ConnectorStatus> {
    const keyring = await vaultKeyring(this.env);
    const context = sealingContext(this.org, params.connectorId);
    const envelope = sealSecret(keyring, context, params.secret);
    const at = (params.now ?? new Date()).toISOString();

    /*
     * Supprimer puis insérer, et non `ON CONFLICT` : les deux dialectes écrivent la
     * clause de conflit différemment, et cette table est la dernière où une divergence
     * de SQL entre SQLite et PostgreSQL devrait pouvoir passer inaperçue. Les deux ordres
     * portent la même clé, donc aucune fenêtre où deux lignes coexistent.
     */
    await this.sql.run(
      `DELETE FROM ${CONNECTOR_CREDENTIALS_TABLE} WHERE organization_id = ? AND connector_id = ?`,
      [this.org, params.connectorId],
    );
    await this.sql.run(
      `INSERT INTO ${CONNECTOR_CREDENTIALS_TABLE}
         (organization_id, connector_id, account, scopes, secret_envelope, fingerprint,
          status, status_detail, connected_by, connected_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
      [
        this.org,
        params.connectorId,
        params.account,
        JSON.stringify(params.scopes),
        envelope,
        fingerprintOf(params.secret),
        params.verified ? "connected" : "stored_unverified",
        params.connectedBy,
        at,
        at,
      ],
    );
    const stored = await this.describe(params.connectorId);
    if (!stored) {
      throw new VaultUnavailableError(
        "the credential was written, then not found when read back; the table is not the one " +
          "that was just written.",
      );
    }
    return stored;
  }

  /**
   * Le seul déchiffrement du dépôt.
   *
   * Appelé par un connecteur, depuis `Tool.run()`, donc après un ALLOW. Rend `null`
   * quand rien n'est configuré ou quand le credential a été révoqué — un connecteur doit
   * alors refuser l'appel, jamais le tenter sans jeton.
   */
  async open(connectorId: string): Promise<StoredCredential | null> {
    const rows = await this.sql.all<Row>(
      `SELECT connector_id, account, scopes, secret_envelope, fingerprint, status,
              status_detail, connected_by, connected_at, last_checked_at
         FROM ${CONNECTOR_CREDENTIALS_TABLE}
        WHERE organization_id = ? AND connector_id = ?`,
      [this.org, connectorId],
    );
    const row = rows[0];
    if (!row) return null;
    /*
     * Un credential révoqué n'est pas déchiffré. L'enveloppe est déjà effacée par
     * `revoke()`, donc ce test ne fait que nommer le refus au lieu de laisser
     * `openSecret` échouer sur une chaîne vide.
     */
    if (row.status === "revoked" || !isEnvelope(row.secret_envelope)) return null;

    const keyring = await vaultKeyring(this.env);
    const secret = openSecret(keyring, sealingContext(this.org, connectorId), row.secret_envelope);
    return {
      secretEnvelope: secret,
      account: row.account,
      scopes: parseScopes(row.scopes),
    };
  }

  /** Enregistre le résultat d'un test de connexion RÉEL. */
  async recordCheck(
    connectorId: string,
    outcome: { ok: boolean; detail: string; account?: string; scopes?: string[] },
    now: Date = new Date(),
  ): Promise<ConnectorStatus | null> {
    const existing = await this.describe(connectorId);
    if (!existing) return null;
    /*
     * Un échec ne fait PAS passer l'état à "revoked" : une panne réseau n'est pas une
     * révocation, et confondre les deux ferait disparaître un credential encore valide.
     * Seul `revoke()` révoque, et il est explicite.
     */
    await this.sql.run(
      `UPDATE ${CONNECTOR_CREDENTIALS_TABLE}
          SET status = ?, status_detail = ?, last_checked_at = ?, account = ?, scopes = ?
        WHERE organization_id = ? AND connector_id = ?`,
      [
        outcome.ok ? "connected" : "error",
        outcome.detail,
        now.toISOString(),
        outcome.account ?? existing.account,
        JSON.stringify(outcome.scopes ?? existing.scopes),
        this.org,
        connectorId,
      ],
    );
    return this.describe(connectorId);
  }

  /**
   * Révoque côté Oathrion : l'enveloppe est écrasée, la ligne reste en état `revoked`.
   *
   * ## CE QUE CECI NE FAIT PAS, ET IL FAUT LE DIRE
   *
   * Oathrion oublie le jeton. Il ne l'invalide PAS chez le fournisseur — aucune API de
   * révocation n'est appelée ici, parce qu'un jeton personnel GitHub ne s'invalide que
   * depuis le compte qui l'a créé. Un jeton effacé d'ici reste donc valide ailleurs
   * jusqu'à ce que son propriétaire le supprime.
   *
   * La ligne est conservée plutôt que supprimée pour que la console puisse dire
   * « révoqué » au lieu de « jamais configuré » : la différence importe à l'exploitant
   * qui cherche pourquoi un agent a cessé d'agir.
   */
  async revoke(connectorId: string, by: string, now: Date = new Date()): Promise<boolean> {
    const changed = await this.sql.run(
      `UPDATE ${CONNECTOR_CREDENTIALS_TABLE}
          SET secret_envelope = '', status = 'revoked',
              status_detail = ?, last_checked_at = ?, scopes = '[]'
        WHERE organization_id = ? AND connector_id = ?`,
      [`Revoked by ${by}. Oathrion has forgotten the token; the third-party service still considers it valid.`,
       now.toISOString(), this.org, connectorId],
    );
    return changed > 0;
  }

  /** Oublie complètement un connecteur. Utilisé par les tests et par la purge. */
  async forget(connectorId: string): Promise<void> {
    await this.sql.run(
      `DELETE FROM ${CONNECTOR_CREDENTIALS_TABLE} WHERE organization_id = ? AND connector_id = ?`,
      [this.org, connectorId],
    );
  }
}
