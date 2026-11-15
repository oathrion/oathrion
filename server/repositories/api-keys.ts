/**
 * Machine credentials — P0-5.
 *
 * ## One unscoped read, and it is the one that resolves the tenant
 *
 * `resolve(hash)` takes no organization, exactly like `sessionStore.find` and
 * `userStore.findByEmail`: it runs before the tenant is known and is what determines it.
 * Everything else — `list`, `findIn`, `revoke`, `touch` — takes an `OrganizationId` and
 * carries it into the SQL, so an administrator of one tenant cannot see, rename or revoke
 * another tenant's key even by guessing its id. A foreign id reads as absent, which is
 * why `findIn` returns `undefined` rather than throwing: the route turns that into 404,
 * never 403, because 403 would confirm the row exists.
 *
 * ## What this store deliberately cannot do
 *
 * There is no `plaintext` anywhere, no method that returns a credential, and no update
 * path for `secret_hash`. Rotation is "create a new key, revoke the old one", which keeps
 * the audit trail honest — a rotated-in-place key would make every past use look like a
 * use of the current secret. Prepared statements throughout: `resolve` is on the
 * authentication path of every machine request.
 */

import { rawDb } from "../db";
import { isRole, type Role } from "@shared/roles";
import { organizationId, type OrganizationId } from "@shared/tenancy";

export interface ApiKeyRecord {
  id: string;
  organizationId: OrganizationId;
  name: string;
  role: Role;
  secretHash: string;
  prefix: string;
  source: "config" | "user";
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  /**
   * The one agent this credential may act as, or `null` when it is not pinned.
   *
   * Set at issue time and never updated: re-pointing a live credential at a
   * different agent would make every past use in the audit trail ambiguous, so
   * rebinding is "issue a new key, revoke the old one" — the same rule that
   * already governs the secret itself. See migration 10.
   */
  agentId: string | null;
}

/**
 * What may leave the server. Has no `secretHash` field *by construction*, so a route
 * cannot leak the digest by spreading a record into a response — the same technique that
 * keeps password hashes out of `PublicUser`.
 */
export interface PublicApiKey {
  id: string;
  name: string;
  role: Role;
  prefix: string;
  source: "config" | "user";
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  /** Computed, not stored: revoked, expired and live are three different states. */
  status: "active" | "revoked" | "expired";
  /**
   * The agent this credential is pinned to, or `null`.
   *
   * Safe to publish, and worth publishing: an operator auditing their key list
   * needs to see which credentials are confined and which are not, and "not
   * pinned" is exactly the state worth noticing. It is an agent id, not a
   * secret — it appears in the audit trail of every action the key takes.
   */
  agentId: string | null;
}

interface ApiKeyRow {
  id: string;
  organization_id: string;
  name: string;
  role: string;
  secret_hash: string;
  prefix: string;
  source: string;
  created_at: string;
  created_by: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  agent_id: string | null;
}

function toKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    organizationId: organizationId(row.organization_id),
    name: row.name,
    // A row whose role is unreadable resolves to `viewer`, the least privileged role,
    // rather than being trusted or crashing the request. Corrupt data must fail towards
    // less access; defaulting to the stored string would let a bad write mint an admin.
    role: isRole(row.role) ? row.role : "viewer",
    secretHash: row.secret_hash,
    prefix: row.prefix,
    source: row.source === "config" ? "config" : "user",
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokedReason: row.revoked_reason,
    /*
     * An empty string is normalised to `null`. The two would otherwise be
     * different values meaning the same thing — "not pinned" — and the binding
     * check tests for `null`. A row written with `''` by any path would then
     * read as pinned to an agent whose id is empty, which no agent lookup can
     * ever satisfy: the credential would be permanently unusable rather than
     * unpinned. Normalising here keeps that impossible for every caller.
     */
    agentId: row.agent_id && row.agent_id.length > 0 ? row.agent_id : null,
  };
}

export function isExpired(key: ApiKeyRecord, now = Date.now()): boolean {
  if (!key.expiresAt) return false;
  const at = Date.parse(key.expiresAt);
  // An unparseable expiry is treated as expired. A key whose lifetime cannot be
  // determined is refused rather than granted an unlimited one.
  return Number.isNaN(at) || at <= now;
}

export function toPublicKey(key: ApiKeyRecord): PublicApiKey {
  const status: PublicApiKey["status"] = key.revokedAt
    ? "revoked"
    : isExpired(key)
      ? "expired"
      : "active";
  return {
    id: key.id,
    name: key.name,
    role: key.role,
    prefix: key.prefix,
    source: key.source,
    createdAt: key.createdAt,
    createdBy: key.createdBy,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    revokedBy: key.revokedBy,
    revokedReason: key.revokedReason,
    status,
    agentId: key.agentId,
  };
}

/**
 * How long a `last_used_at` value may be stale.
 *
 * The field answers "is anyone still calling with this key?", which is a question about
 * days, not milliseconds. Writing it on every request would put an UPDATE — and on SQLite
 * a write lock — in front of every agent action in the system. One write per key per
 * minute is precise enough to be useful and cheap enough to be free.
 */
const TOUCH_INTERVAL_MS = 60_000;

export interface CreateApiKeyInput {
  id: string;
  organizationId: OrganizationId;
  name: string;
  role: Role;
  secretHash: string;
  prefix: string;
  source: "config" | "user";
  createdBy: string;
  expiresAt?: string | null;
  /** Pins the credential to one agent. Omitted means unpinned; see migration 10. */
  agentId?: string | null;
}

/*
 * PRÉPARÉES UNE FOIS, et c'est un gain en soi.
 *
 * Ce fichier appelait `rawDb.prepare(...)` à CHAQUE lecture — douze fois dans le module.
 * Sur le plan d'identité PostgreSQL, chaque `prepare` traverse le protocole du worker
 * synchrone ; sur SQLite, il recompile le SQL. Les déclarations des deux lectures du
 * chemin d'authentification sont donc hissées ici, comme `organizations.ts` le fait déjà
 * pour les siennes.
 */
const resolveStmt = rawDb.prepare<[string], ApiKeyRow>(
  `SELECT * FROM api_keys WHERE secret_hash = ?`,
);
const resolveWithOrganizationStmt = rawDb.prepare<[string], ApiKeyRow & { organization_active: unknown }>(
  `SELECT k.*, o.active AS organization_active
     FROM api_keys k
     LEFT JOIN organizations o ON o.id = k.organization_id
    WHERE k.secret_hash = ?`,
);

export const apiKeyStore = {
  /**
   * The authentication path. Unscoped by necessity (see the header), and narrow on
   * purpose: it matches on the digest only, and the caller decides what to do about
   * revocation, expiry and organization status. Putting those checks here would hide
   * them from the tests that guard them, which live at the auth layer.
   */
  resolve(secretHash: string): ApiKeyRecord | undefined {
    const row = resolveStmt.get(secretHash);
    return row ? toKey(row) : undefined;
  },

  /**
   * La clé ET l'état de son organisation, EN UN SEUL ALLER-RETOUR.
   *
   * ## Pourquoi cette méthode existe
   *
   * `resolveBearer` faisait deux lectures d'identité par requête authentifiée :
   * `apiKeyStore.resolve`, puis `organizationStore.isActive`. Sur le plan d'identité
   * PostgreSQL, chacune est un aller-retour **bloquant** — c'est le prix assumé de la
   * phase 12, qui garde une seule implémentation des opérations de sécurité pour les deux
   * moteurs.
   *
   * Mesuré par un profil processeur sous 48 clients concurrents : ces deux appels
   * représentaient **2,6 s de temps processeur bloquant sur 11 s de profil**, les deux
   * plus gros consommateurs du processus, loin devant le reste. Et ce temps-là ne se
   * chevauche pas : pendant qu'une requête attend sa clé, aucune autre n'avance.
   *
   * Une jointure rend la même information en un aller-retour. Ce n'est PAS un cache : la
   * révocation d'une clé et la suspension d'une organisation prennent effet au prochain
   * appel, exactement comme avant. Il y a juste une attente de moins.
   *
   * `LEFT JOIN` et non `JOIN` : une clé dont l'organisation a disparu doit être trouvée
   * puis REFUSÉE, et non devenir introuvable — les deux se ressemblent du dehors et pas
   * du dedans, et c'est l'appelant qui doit décider.
   */
  resolveWithOrganization(
    secretHash: string,
  ): { key: ApiKeyRecord; organizationActive: boolean } | undefined {
    const row = resolveWithOrganizationStmt.get(secretHash);
    if (!row) return undefined;
    return {
      key: toKey(row),
      /*
       * `active` peut être un booléen (PostgreSQL) ou un entier (SQLite). La comparaison
       * couvre les deux sans supposer lequel répond — c'est la même règle que
       * `organizationStore.isActive`, qui lit `row.active !== 0`.
       */
      organizationActive: row.organization_active !== null && Number(row.organization_active) !== 0,
    };
  },

  findIn(organization: OrganizationId, id: string): ApiKeyRecord | undefined {
    const row = rawDb
      .prepare<[string, string], ApiKeyRow>(
        `SELECT * FROM api_keys WHERE organization_id = ? AND id = ?`,
      )
      .get(organization, id);
    return row ? toKey(row) : undefined;
  },

  list(organization: OrganizationId): ApiKeyRecord[] {
    return rawDb
      .prepare<[string], ApiKeyRow>(
        `SELECT * FROM api_keys WHERE organization_id = ? ORDER BY created_at DESC, id`,
      )
      .all(organization)
      .map(toKey);
  },

  /** Adoption asks this once per boot: which keys does the environment own here? */
  listBySource(source: "config" | "user"): ApiKeyRecord[] {
    return rawDb
      .prepare<[string], ApiKeyRow>(`SELECT * FROM api_keys WHERE source = ?`)
      .all(source)
      .map(toKey);
  },

  create(input: CreateApiKeyInput): ApiKeyRecord {
    const now = new Date().toISOString();
    rawDb
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, name, role, secret_hash, prefix, source,
            created_at, created_by, expires_at, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.organizationId,
        input.name,
        input.role,
        input.secretHash,
        input.prefix,
        input.source,
        now,
        input.createdBy,
        input.expiresAt ?? null,
        // Same normalisation as `toKey`, applied on the way in so the empty
        // string never reaches storage in the first place.
        input.agentId && input.agentId.length > 0 ? input.agentId : null,
      );
    const created = this.resolve(input.secretHash);
    if (!created) {
      // Unreachable unless the INSERT silently did nothing. Failing loudly beats
      // returning a fabricated record that the caller would then hand to a client.
      throw new Error(`api key ${input.id} disappeared immediately after insert`);
    }
    return created;
  },

  /**
   * Revocation is scoped, and only takes effect while the key is live.
   *
   * `revoked_at IS NULL` in the WHERE clause is not a nicety: without it, revoking twice
   * would overwrite the first revocation's actor and timestamp, and the record of who cut
   * off a credential — the thing an incident review reads — would be the second person
   * to press the button rather than the first.
   */
  revoke(organization: OrganizationId, id: string, by: string, reason?: string): boolean {
    const result = rawDb
      .prepare(
        `UPDATE api_keys
            SET revoked_at = ?, revoked_by = ?, revoked_reason = ?
          WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), by, reason ?? null, organization, id);
    return result.changes > 0;
  },

  /** Renaming changes only the audit label, never the credential. */
  rename(organization: OrganizationId, id: string, name: string): boolean {
    const result = rawDb
      .prepare(`UPDATE api_keys SET name = ? WHERE organization_id = ? AND id = ?`)
      .run(name, organization, id);
    return result.changes > 0;
  },

  /**
   * Re-points an adopted key at a new secret when the environment's value changes.
   *
   * Only ever called for a `config`-sourced key, and the caller enforces that. A key
   * issued through the console has no plaintext anywhere, so there is nothing an
   * environment edit could match — and letting the environment overwrite such a key's
   * digest would be a way for a stale `.env` file to take over a customer's credential.
   */
  replaceSecret(id: string, secretHash: string, prefix: string): boolean {
    const result = rawDb
      .prepare(
        `UPDATE api_keys
            SET secret_hash = ?, prefix = ?, revoked_at = NULL, revoked_by = NULL, revoked_reason = NULL
          WHERE id = ? AND source = 'config'`,
      )
      .run(secretHash, prefix, id);
    return result.changes > 0;
  },

  /** Re-applies the configured role to an adopted key. Never widens a `user` key. */
  setRole(id: string, role: Role): boolean {
    const result = rawDb
      .prepare(`UPDATE api_keys SET role = ? WHERE id = ? AND source = 'config'`)
      .run(role, id);
    return result.changes > 0;
  },

  /** Brings an adopted key back after its line was restored in the environment. */
  reinstate(id: string): boolean {
    const result = rawDb
      .prepare(
        `UPDATE api_keys
            SET revoked_at = NULL, revoked_by = NULL, revoked_reason = NULL
          WHERE id = ? AND source = 'config'`,
      )
      .run(id);
    return result.changes > 0;
  },

  /**
   * Records use, at most once per `TOUCH_INTERVAL_MS`. Returns whether it wrote, which
   * exists for the test — "the throttle throttles" is otherwise unobservable.
   */
  touch(key: ApiKeyRecord, now = Date.now()): boolean {
    if (key.lastUsedAt) {
      const previous = Date.parse(key.lastUsedAt);
      if (!Number.isNaN(previous) && now - previous < TOUCH_INTERVAL_MS) return false;
    }
    rawDb
      .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .run(new Date(now).toISOString(), key.id);
    return true;
  },
};
