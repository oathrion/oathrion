import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";

/*
 * There is no `users` table.
 *
 * A scaffold one used to live here, with a `password TEXT NOT NULL` column and
 * a `DatabaseStorage` class that wrote to it. Nothing in the control plane ever
 * read either: console sign-in resolves against OATHRION_CONSOLE_USERS and
 * issues a server-side session, and service callers present an API key. The
 * table was therefore a plaintext credential store waiting for someone to
 * connect it — the kind of dead code that becomes a breach when a later change
 * makes it look like the obvious place to put accounts.
 *
 * Both the table and the class are gone. Identities stay in the environment,
 * where they can be rotated without touching the database. See README, section
 * "Rotating and revoking credentials".
 */

/* ------------------------------------------------------------------------- *
 * Oathrion control plane.
 *
 * SQLite has no JSON or array columns, so structured fields (permissions,
 * conditions, payloads, audit trails) are stored as JSON text and parsed in the
 * repository layer. Nothing outside `server/repositories` reads these rows.
 * ------------------------------------------------------------------------- */

export const agentRows = sqliteTable("agents", {
  /**
   * Tenant discriminator. Every read and write in `server/repositories` filters on
   * this column; see `shared/tenancy.ts` for why the filter lives there and not in
   * the callers.
   */
  organizationId: text("organization_id").notNull(),
  id: text("id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  currentTask: text("current_task"),
  owner: text("owner").notNull().default(""),
  createdAt: text("created_at").notNull(),
  executions24h: integer("executions_24h").notNull().default(0),
  successRate: real("success_rate").notNull().default(100),
  cost24h: real("cost_24h").notNull().default(0),
  costMonth: real("cost_month").notNull().default(0),
  riskLevel: text("risk_level").notNull(),
  /** JSON: Permission[] */
  permissions: text("permissions").notNull().default("[]"),
  mandate: text("mandate").notNull().default("{}"),
  /** JSON: string[] */
  policyIds: text("policy_ids").notNull().default("[]"),
  /** JSON: string[] */
  tags: text("tags").notNull().default("[]"),
}, (t) => [
  /*
   * COMPOSITE PRIMARY KEY — (organization_id, id), not id alone.
   *
   * Ids on this table are chosen by the caller (`POST /api/agents` accepts an `id`).
   * A single global key would therefore mean the first customer to create
   * "agt_billing" makes that name permanently unavailable to every other customer,
   * and the resulting conflict error is itself an oracle: it confirms that some
   * other tenant holds that id. Scoping the key to the organization removes both
   * problems — the namespace is per tenant, exactly like the data.
   */
  primaryKey({ columns: [t.organizationId, t.id] }),
]);

export const policyRows = sqliteTable("policies", {
  /**
   * Tenant discriminator. Every read and write in `server/repositories` filters on
   * this column; see `shared/tenancy.ts` for why the filter lives there and not in
   * the callers.
   */
  organizationId: text("organization_id").notNull(),
  id: text("id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  rule: text("rule").notNull().default(""),
  scope: text("scope").notNull(),
  appliesTo: text("applies_to").notNull().default(""),
  effect: text("effect").notNull(),
  status: text("status").notNull(),
  triggeredCount: integer("triggered_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
  /** Executable definition — null for advisory policies. */
  type: text("type"),
  /** JSON: PolicyCondition */
  condition: text("condition"),
  action: text("action"),
  /** JSON: string[] | null (null = organization-wide) */
  appliesToAgentIds: text("applies_to_agent_ids"),
  risk: text("risk"),
  priority: integer("priority").notNull().default(0),
}, (t) => [
  /*
   * COMPOSITE PRIMARY KEY — (organization_id, id), not id alone.
   *
   * Ids on this table are chosen by the caller (`POST /api/policies` accepts an `id`).
   * A single global key would therefore mean the first customer to create
   * "pol_spend_cap" makes that name permanently unavailable to every other customer,
   * and the resulting conflict error is itself an oracle: it confirms that some
   * other tenant holds that id. Scoping the key to the organization removes both
   * problems — the namespace is per tenant, exactly like the data.
   */
  primaryKey({ columns: [t.organizationId, t.id] }),
]);

export const executionRows = sqliteTable("executions", {
  /**
   * Tenant discriminator. Every read and write in `server/repositories` filters on
   * this column; see `shared/tenancy.ts` for why the filter lives there and not in
   * the callers.
   */
  organizationId: text("organization_id").notNull(),
  id: text("id").notNull(),
  agentId: text("agent_id").notNull(),
  agentName: text("agent_name").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  status: text("status").notNull(),
  risk: text("risk").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  cost: real("cost").notNull().default(0),
  timestamp: text("timestamp").notNull(),
  /** JSON: Record<string, string | number> */
  input: text("input").notNull().default("{}"),
  decision: text("decision").notNull(),
  decisionReason: text("decision_reason").notNull().default(""),
  policyEvaluated: text("policy_evaluated"),
  policyId: text("policy_id"),
  result: text("result").notNull().default(""),
  /** JSON: AuditEntry[] */
  audit: text("audit").notNull().default("[]"),
  approvalId: text("approval_id"),
  toolId: text("tool_id"),
  toolExecutedAt: text("tool_executed_at"),
  /** JSON: Record<string, unknown> */
  toolResult: text("tool_result"),
  /** Tool-run lifecycle: pending | running | succeeded | failed | skipped. */
  runState: text("run_state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  toolStartedAt: text("tool_started_at"),
}, (t) => [
  /*
   * COMPOSITE PRIMARY KEY — (organization_id, id), not id alone.
   *
   * Ids on this table are chosen by the caller (`POST /api/executions` accepts an `id`).
   * A single global key would therefore mean the first customer to create
   * "exec_1" makes that name permanently unavailable to every other customer,
   * and the resulting conflict error is itself an oracle: it confirms that some
   * other tenant holds that id. Scoping the key to the organization removes both
   * problems — the namespace is per tenant, exactly like the data.
   */
  primaryKey({ columns: [t.organizationId, t.id] }),
]);

export const approvalRows = sqliteTable("approvals", {
  /**
   * Tenant discriminator. Every read and write in `server/repositories` filters on
   * this column; see `shared/tenancy.ts` for why the filter lives there and not in
   * the callers.
   */
  organizationId: text("organization_id").notNull(),
  id: text("id").notNull(),
  executionId: text("execution_id"),
  agentId: text("agent_id").notNull(),
  agentName: text("agent_name").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  requestedValue: text("requested_value").notNull().default(""),
  policyId: text("policy_id").notNull().default(""),
  policyName: text("policy_name").notNull().default(""),
  policyLimit: text("policy_limit").notNull().default(""),
  risk: text("risk").notNull(),
  status: text("status").notNull(),
  requestedAt: text("requested_at").notNull(),
  /**
   * Deadline after which this request can no longer release its action. Nullable
   * in the column only because migration 9 adds it to existing databases; every
   * write path stamps it, and a NULL reaching a decision is read as expired.
   */
  expiresAt: text("expires_at"),
  resolvedBy: text("resolved_by"),
  resolvedAt: text("resolved_at"),
  /** JSON: { label: string; value: string }[] */
  context: text("context").notNull().default("[]"),
}, (t) => [
  /*
   * COMPOSITE PRIMARY KEY — (organization_id, id), not id alone.
   *
   * Ids on this table are chosen by the caller (`POST /api/approvals` accepts an `id`).
   * A single global key would therefore mean the first customer to create
   * "apr_1" makes that name permanently unavailable to every other customer,
   * and the resulting conflict error is itself an oracle: it confirms that some
   * other tenant holds that id. Scoping the key to the organization removes both
   * problems — the namespace is per tenant, exactly like the data.
   */
  primaryKey({ columns: [t.organizationId, t.id] }),
]);

export const integrationRows = sqliteTable("integrations", {
  /**
   * Tenant discriminator. Every read and write in `server/repositories` filters on
   * this column; see `shared/tenancy.ts` for why the filter lives there and not in
   * the callers.
   */
  organizationId: text("organization_id").notNull(),
  id: text("id").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull().default(""),
  connected: integer("connected", { mode: "boolean" }).notNull().default(false),
  /** JSON: string[] */
  scopes: text("scopes").notNull().default("[]"),
  connectedAt: text("connected_at"),
  agentsUsing: integer("agents_using").notNull().default(0),
}, (t) => [
  /*
   * COMPOSITE PRIMARY KEY — (organization_id, id), not id alone.
   *
   * Ids on this table are chosen by the caller (`POST /api/integrations` accepts an `id`).
   * A single global key would therefore mean the first customer to create
   * "slack" makes that name permanently unavailable to every other customer,
   * and the resulting conflict error is itself an oracle: it confirms that some
   * other tenant holds that id. Scoping the key to the organization removes both
   * problems — the namespace is per tenant, exactly like the data.
   */
  primaryKey({ columns: [t.organizationId, t.id] }),
]);

/**
 * Console sessions.
 *
 * This table existed only as raw SQL in `server/db.ts` and was absent here, which
 * is a real problem rather than an aesthetic one: `npm run db:push` derives the
 * schema from THIS file, so a Drizzle-driven migration would not know the table
 * exists and could drop it — logging every console user out, or worse, recreating it
 * without `revoked_at` and silently reviving revoked sessions.
 *
 * It is declared here for that reason alone. The session store still uses prepared
 * statements rather than the query builder (session lookup is on the hot path of
 * every authenticated request), so this declaration is the schema's source of
 * truth, not a change of access pattern. `shared/schema-parity.test.ts` asserts the
 * two definitions cannot drift apart again.
 */
export const sessionRows = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  /**
   * The organization this session is scoped to. A session is a tenant-bound object:
   * the organization is resolved from the credential at sign-in and is never taken
   * from the request afterwards, so a caller cannot change tenant mid-session.
   */
  organizationId: text("organization_id").notNull(),
  subject: text("subject").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"),
  revokedBy: text("revoked_by"),
  /**
   * Fingerprint of the credential this session was opened with, so rotating or
   * removing a console user invalidates the sessions it issued. Nullable because
   * rows written before the column existed have none — server/auth.ts refuses
   * those rather than trusting them. See server/repositories/sessions.ts.
   */
  credentialFp: text("credential_fp"),
});

/* ------------------------------------------------------------------------- *
 * Tenancy
 * ------------------------------------------------------------------------- */

/**
 * Organizations (tenants).
 *
 * Not a customer-data table: it is the table that *defines* the scopes the others
 * are partitioned by, so it is the one table read without an organization filter —
 * always by primary key, never listed to a tenant caller.
 */
export const organizationRows = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /**
   * The normalised name (`lower(trim(name))`), UNIQUE since migration 18.
   *
   * It exists because the identifier above stopped being derived from the name. While
   * it was (`"Acme Corp"` → `org_acme_corp`), "the same name finds the same tenant at
   * the next boot" was free — and the identifier leaked the customer's name into every
   * log line, audit row and receipt. Identifiers are now opaque, so that idempotence
   * comes from a lookup on this column instead, which is why it carries a unique index
   * rather than a plain one: two organizations sharing a name would make the lookup
   * ambiguous, and an ambiguous tenant lookup is a cross-tenant scope waiting to
   * happen.
   *
   * Written by `organizationNameKey()` (`shared/tenancy.ts`) and by migration 18's
   * backfill in SQL. The two must agree; `tenant-opaque-id.test.ts` checks the stored
   * row against the function.
   */
  nameKey: text("name_key").notNull().default(""),
  createdAt: text("created_at").notNull(),
  /** 0 suspends every credential in the organization without deleting its data. */
  active: integer("active").notNull().default(1),
  /**
   * The tenant's unit of account: an ISO 4217 code from `shared/money.ts`.
   *
   * Mandate ceilings, policy thresholds and daily budgets belonging to this
   * organization are denominated in it, and an action declaring a different currency is
   * refused rather than converted — Oathrion holds no exchange rates. Before migration 15
   * this was a single module constant for the whole deployment, which made one instance
   * unable to serve two currency zones.
   */
  currency: text("currency").notNull().default("EUR"),
});

/* ------------------------------------------------------------------------- *
 * Identity (P0-2)
 * ------------------------------------------------------------------------- */

/**
 * People who can sign in to the console.
 *
 * Not a tenant-scoped table, and that is deliberate. A person is identified by an
 * e-mail address, which is globally unique by nature; the tenants they may act
 * within are in `memberships`. Putting `organization_id` here instead would force a
 * second user row — and a second password — for anyone who works with two
 * organizations, and would make sign-in ambiguous: the server would have to know the
 * tenant *before* it knows who is asking.
 *
 * The row is read without a tenant filter for exactly one purpose: resolving a
 * sign-in. Every read after that goes through `memberships`, which is scoped.
 */
export const userRows = sqliteTable("users", {
  id: text("id").primaryKey(),
  /** Lower-cased at write time. The sign-in identifier. */
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** `scrypt$N$r$p$salt$hash`. Never a plaintext password, never reversible. */
  passwordHash: text("password_hash").notNull(),
  /**
   * Changes whenever the password does. Sessions are bound to it, so a rotation
   * invalidates every session that password had issued — the first move in any
   * credential-leak incident.
   */
  passwordUpdatedAt: text("password_updated_at").notNull(),
  /**
   * `config` for a user adopted from `OATHRION_CONSOLE_USERS`, `user` once the person
   * has set their own password. The environment stops overriding the hash at that
   * point: a stale entry in an .env file must not silently reset a real password.
   */
  passwordSource: text("password_source").notNull().default("config"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  lastLoginAt: text("last_login_at"),
});

/**
 * Which organizations a user may act within, and with which role.
 *
 * The role lives here rather than on the user: it is a property of the
 * relationship. The same person can be an admin of their own organization and a
 * viewer in a partner's, and a role stored on the user could not express that
 * without silently granting the wider one everywhere.
 */
export const membershipRows = sqliteTable(
  "memberships",
  {
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: text("created_at").notNull(),
    /**
     * Set when this person is barred from this organization without being barred
     * from any other — P2 identity. `users.status` already exists and already
     * blocks a sign-in, but it is deployment-wide: using it here would let one
     * customer lock a contractor out of another customer's organization. A
     * suspended membership is refused on the next request by
     * `credentialStillValid`, not merely at the next sign-in, and the row is kept
     * so that reinstating someone restores the role they had rather than a role
     * an administrator has to remember.
     */
    suspendedAt: text("suspended_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.userId] }),
  }),
);

/**
 * One-shot identity tokens: an invitation to join an organization, or a
 * password reset for somebody who already belongs to one — P2 identity.
 *
 * Keyed on `id` alone, and the same exception as `apiKeyRows` and `sessionRows`
 * applies for the same reason: the token arrives with no tenant attached, so the
 * read that resolves it cannot be filtered by the organization it is about to
 * reveal. Unlike those two, the id is not merely unguessable — presenting it is
 * not enough, because the 32-byte secret that accompanies it is compared against
 * `secretHash` in constant time.
 *
 * There is no column here that can be turned back into a token. Delivery is out
 * of band by design: no e-mail transport exists in this build, so the token is
 * returned exactly once to the administrator who issued it, and never again by
 * any route.
 */
export const identityTokenRows = sqliteTable("identity_tokens", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  /** `invite` or `reset`. Decides what consuming the token does, nothing else. */
  purpose: text("purpose").notNull(),
  /** Lower-cased, matching `userRows.email`. Binds the token to one person. */
  email: text("email").notNull(),
  /** The role an accepted invitation grants. Ignored for a reset. */
  role: text("role").notNull(),
  /** `sha256(secret)` as hex. Compared, never searched, never returned. */
  secretHash: text("secret_hash").notNull(),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
  expiresAt: text("expires_at").notNull(),
  /** Set by the single-use claim. A second presentation finds it non-null and is refused. */
  consumedAt: text("consumed_at"),
  consumedBy: text("consumed_by"),
  revokedAt: text("revoked_at"),
  revokedBy: text("revoked_by"),
});

/**
 * Machine credentials — P0-5.
 *
 * Tenant-scoped, but keyed on `id` alone rather than on `(organizationId, id)` like
 * agents or policies. A bearer credential arrives with nothing attached to it, so the
 * read that turns it into an identity cannot be filtered by an organization it has not
 * yet resolved — the same exception, for the same reason, as `sessionRows`.
 *
 * There is no column here that can be turned back into a credential. `secretHash` is a
 * SHA-256 digest and `prefix` is the eleven characters the console displays; the key
 * itself exists exactly once, in the response to the request that created it.
 */
export const apiKeyRows = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  /** What the audit log shows as the actor. Chosen to be recognisable by a human. */
  name: text("name").notNull(),
  role: text("role").notNull(),
  /**
   * `sha256$<hex>` of the full credential. Unique, because two rows sharing a digest
   * would be one credential resolving to two identities with the winner decided by row
   * order. It is also the lookup key on the authentication path, so the uniqueness
   * index is the index that path needs.
   */
  secretHash: text("secret_hash").notNull().unique(),
  /** `oathrion_ab12cd` for a generated key, `env:` for one adopted from the environment. */
  prefix: text("prefix").notNull(),
  /**
   * `config` for a key adopted from `OATHRION_API_KEYS`, `user` for one issued through the
   * console. Removing a line from the environment revokes the first kind and must never
   * touch the second — otherwise every restart would revoke the customer's own keys.
   */
  source: text("source").notNull().default("user"),
  createdAt: text("created_at").notNull(),
  /** The identity that issued it, or `OATHRION_API_KEYS` for an adopted key. */
  createdBy: text("created_by").notNull(),
  /** Optional. A key past this instant is refused without being revoked. */
  expiresAt: text("expires_at"),
  /**
   * Written at most once a minute, not on every request: this is the hot path, and one
   * UPDATE per call would take the write lock on every agent action for a field whose
   * purpose is answering "is this key still in use?" to the minute.
   */
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
  revokedBy: text("revoked_by"),
  revokedReason: text("revoked_reason"),
  /**
   * P6 — the one agent this credential speaks for, or `null` for an unpinned one.
   *
   * Nullable, and it has to be: console sessions and operator keys have no single
   * agent to be pinned to, and every key that existed before migration 010 has
   * none either — inventing one for them would be fabricating an authorisation
   * fact. When it is set, `server/identity/agent-binding.ts` confines the
   * credential to that agent and refuses any request naming a different one.
   *
   * Declared with no foreign key, matching every other cross-table reference in
   * this schema: the agent row is tenant-scoped and soft-managed, and a hard FK
   * would make deleting an agent fail on a revoked key that only the audit trail
   * still needs.
   */
  agentId: text("agent_id"),
});

/* ------------------------------------------------------------------------- *
 * Quota measurement (P3)
 * ------------------------------------------------------------------------- */

/**
 * Advisory usage measurements per organization, counter and period.
 *
 * **No quota decision reads this table.** Enforcement compares against an exact,
 * tenant-filtered `count(*)` taken inside the transaction it guards — see
 * `server/quotas.ts` and the long note in `server/migrations/007-usage-counters.ts`
 * for why a stored counter was rejected as the source of truth: it drifts, and the
 * direction of the drift decides whether a paying customer is wrongly refused or
 * silently allowed past the ceiling they are billed against.
 *
 * What lives here is the two things the data cannot answer: the high-water mark
 * (needed to set a ceiling that will not interrupt a customer) and the refusal count
 * (which leaves no trace anywhere else, because the write did not happen).
 *
 * Tenant-scoped, keyed on `(organization_id, counter, period_start)`. `organization_id`
 * leads the key so a per-tenant read is a prefix scan.
 */
export const usageCounterRows = sqliteTable(
  "usage_counters",
  {
    organizationId: text("organization_id").notNull(),
    /** A `QuotaCounter` name from `shared/quotas.ts`: `agents`, `policies`, `executions`. */
    counter: text("counter").notNull(),
    /** ISO-8601 start of the UTC month, or the literal `lifetime` for a count counter. */
    periodStart: text("period_start").notNull(),
    /** Highest value ever observed for this counter in this period. */
    observedMax: integer("observed_max").notNull().default(0),
    /** How many requests this counter has refused in this period. */
    refusals: integer("refusals").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.counter, t.periodStart] })],
);

/**
 * A tenant's own quota ceilings (chantier 1, migration 17).
 *
 * Read and written only through `server/repositories/organization-quotas.ts`, and
 * resolved only by `quotaLimitsFor` in `server/quotas.ts`. Declared here so
 * `schema-parity.test.ts` checks the live table against this shape; the CHECK
 * constraints that bound `counter`, `ceiling` and `source` live in the migration,
 * which Drizzle's SQLite declarations do not model.
 */
export const organizationQuotaRows = sqliteTable(
  "organization_quotas",
  {
    organizationId: text("organization_id").notNull(),
    /** A `QuotaCounter` name from `shared/quotas.ts`. */
    counter: text("counter").notNull(),
    ceiling: integer("ceiling").notNull(),
    /** `environment` (imported from OATHRION_QUOTAS at boot) or `api` (written by Oathrion). */
    source: text("source").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.counter] })],
);

/**
 * Les retours produit (migration 19).
 *
 * Déclarés ici parce que `schema-parity.test.ts` exige que toute table vivante soit
 * décrite pour Drizzle : une table créée par une migration brute et jamais déclarée
 * serait supprimée au prochain `db:push`. La garde a trouvé celle-ci le jour même où
 * elle est née, ce qui est exactement son travail.
 *
 * Pas de clé étrangère vers `organizations` : aucune autre table de ce schéma n'en
 * porte, et en introduire une ici ferait de cette table la seule dont la suppression
 * d'un locataire dépendrait d'un ordre particulier.
 */
export const productFeedbackRows = sqliteTable("product_feedback", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  authorUserId: text("author_user_id").notNull(),
  /** −1, 0 ou +1. Le zéro est un retour SANS vote : un signalement n'est pas un avis. */
  vote: integer("vote").notNull(),
  category: text("category").notNull(),
  comment: text("comment"),
  feature: text("feature").notNull(),
  productVersion: text("product_version").notNull(),
  /** Référence courte et non sensible. Jamais un argument d'outil ni un prompt. */
  contextRef: text("context_ref"),
  status: text("status").notNull(),
  resolutionNote: text("resolution_note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Le coffre de credentials des connecteurs (migration 21).
 *
 * Déclaré ici — contrairement au registre d'effacement, qui en est délibérément absent.
 * La différence est le chemin applicatif : ce coffre EST lu par une route (la console
 * affiche l'état réel de chaque connecteur), donc il doit être joignable par une requête
 * de locataire, et une requête de locataire est filtrée sur `organization_id` par
 * construction. Le registre d'effacement, lui, recense les effacements de tous les
 * locataires : son absence de modèle est ce qui le rend inatteignable.
 *
 * `secretEnvelope` est la seule colonne chiffrée (AES-256-GCM, `server/secrets/envelope.ts`)
 * et la seule qu'aucune route ne rend. Les autres sont en clair parce que la console doit
 * les afficher : les chiffrer obligerait à charger la clé pour dessiner une liste et ne
 * protégerait rien qu'un lecteur de la base ne sache déjà.
 */
export const connectorCredentialRows = sqliteTable("connector_credentials", {
  organizationId: text("organization_id").notNull(),
  connectorId: text("connector_id").notNull(),
  account: text("account").notNull().default(""),
  /** JSON: string[] — les portées que le service a CONFIRMÉES, pas celles demandées. */
  scopes: text("scopes").notNull().default("[]"),
  /** L'enveloppe. Jamais rendue par une route, ni déchiffrée ni scellée. */
  secretEnvelope: text("secret_envelope").notNull(),
  /** 6 caractères de SHA-256 du jeton : reconnaissable, inutilisable. */
  fingerprint: text("fingerprint").notNull().default(""),
  status: text("status").notNull().default("connected"),
  statusDetail: text("status_detail").notNull().default(""),
  connectedBy: text("connected_by").notNull().default(""),
  connectedAt: text("connected_at").notNull(),
  lastCheckedAt: text("last_checked_at"),
}, (t) => [
  /*
   * Clé composite, et reconnecter REMPLACE. Garder un historique de jetons révoqués
   * serait garder des credentials dont plus personne n'a besoin.
   */
  primaryKey({ columns: [t.organizationId, t.connectorId] }),
]);

/**
 * La mémoire de la réconciliation (migration 26) : le dernier passage par outil, et
 * chaque écriture vue hors d'Oathrion, une seule fois. Lues et écrites par des routes de
 * locataire (`server/connectors/reconcile-store.ts`), filtrées sur `organization_id`.
 */
export const reconcileRunRows = sqliteTable("reconcile_runs", {
  organizationId: text("organization_id").notNull(),
  connectorId: text("connector_id").notNull(),
  ranAt: text("ran_at").notNull(),
  runTrigger: text("run_trigger").notNull(),
  ok: integer("ok").notNull(),
  verdict: text("verdict").notNull(),
  since: text("since").notNull().default(""),
  identity: text("identity").notNull().default(""),
  scanned: integer("scanned").notNull().default(0),
  viaOathrion: integer("via_placet").notNull().default(0),
  outsideCount: integer("outside_count").notNull().default(0),
  unknownCount: integer("unknown_count").notNull().default(0),
  others: integer("others").notNull().default(0),
  truncated: integer("truncated").notNull().default(0),
  detail: text("detail").notNull().default(""),
}, (t) => [primaryKey({ columns: [t.organizationId, t.connectorId] })]);

export const reconcileFindingRows = sqliteTable("reconcile_findings", {
  organizationId: text("organization_id").notNull(),
  connectorId: text("connector_id").notNull(),
  itemId: text("item_id").notNull(),
  /** « outside » (sans marque, même identité) ou « unknown_marker ». */
  category: text("category").notNull(),
  kind: text("kind").notNull(),
  url: text("url"),
  summary: text("summary").notNull().default(""),
  actor: text("actor"),
  marker: text("marker"),
  itemCreatedAt: text("item_created_at").notNull().default(""),
  firstSeenAt: text("first_seen_at").notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.connectorId, t.itemId] })]);

/**
 * Le compteur d'exécutions du mois (migration 28) : une ligne par (organisation,
 * compteur, début de période), incrémentée dans la même transaction que l'écriture
 * comptée. Voir `server/sql/execution-quota.ts`.
 */
export const quotaPeriodCountRows = sqliteTable("quota_period_counts", {
  organizationId: text("organization_id").notNull(),
  counter: text("counter").notNull(),
  periodStart: text("period_start").notNull(),
  used: integer("used").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.organizationId, t.counter, t.periodStart] })]);

/**
 * Le point de reprise de la vérification de chaque chaîne de reçus (migration 29). Voir
 * `server/authority/store.ts` (`chainCheckpoint`) et la route de vérification.
 */
export const receiptChainCheckpointRows = sqliteTable("receipt_chain_checkpoints", {
  organizationId: text("organization_id").primaryKey(),
  entries: integer("entries").notNull(),
  entrySeq: integer("entry_seq").notNull(),
  entryHash: text("entry_hash").notNull(),
  verifiedAt: text("verified_at").notNull(),
  fullVerifiedAt: text("full_verified_at"),
});

/**
 * Les portes de chaque agent (migration 25) : pour chaque outil, ce que la personne a
 * DÉCLARÉ, et ce que le SERVICE a répondu quand l'ancienne clé lui a été présentée.
 *
 * Déclaré ici comme le coffre : des routes de locataire le lisent et l'écrivent, filtrées
 * sur `organization_id`. `checkState` n'est écrit que par la route de vérification
 * (`server/connectors/doors.ts`) ; aucune clé n'y est jamais gardée.
 */
export const agentDoorRows = sqliteTable("agent_doors", {
  organizationId: text("organization_id").notNull(),
  agentId: text("agent_id").notNull(),
  connectorId: text("connector_id").notNull(),
  /** « none » (l'agent n'avait pas de clé) ou « revoked » (déclarée révoquée). */
  declared: text("declared").notNull(),
  declaredBy: text("declared_by").notNull(),
  declaredAt: text("declared_at").notNull(),
  /** « dead », « alive », « unknown » — la réponse du service ; NULL tant que rien n'est vérifié. */
  checkState: text("check_state"),
  checkDetail: text("check_detail").notNull().default(""),
  checkedBy: text("checked_by"),
  checkedAt: text("checked_at"),
}, (t) => [primaryKey({ columns: [t.organizationId, t.agentId, t.connectorId] })]);

/**
 * Le sas des requêtes interceptées qui attendent un humain (migration 22).
 *
 * Déclaré ici comme le coffre : une route le lit — pas pour le rendre, mais pour le
 * consommer — donc il doit être joignable par une requête de locataire, laquelle est
 * filtrée sur `organization_id` par construction.
 *
 * `headersEnvelope` et `bodyEnvelope` sont chiffrés. C'est le seul endroit du produit où
 * un corps de requête est persisté, et c'est un arbitrage : pour compléter une requête
 * APRÈS qu'un humain l'ait approuvée, il faut la conserver. Trois garde-fous — chiffré,
 * à usage unique, expirant avec l'approbation.
 */
export const pendingInterceptionRows = sqliteTable("pending_interceptions", {
  organizationId: text("organization_id").notNull(),
  /** Le jeton tiré par la route, porté par les métadonnées de l'exécution. */
  ref: text("ref").notNull(),
  executionId: text("execution_id").notNull().default(""),
  destinationId: text("destination_id").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  /** JSON en clair : une chaîne de requête n'est pas un secret. */
  query: text("query").notNull().default("{}"),
  headersEnvelope: text("headers_envelope").notNull(),
  bodyEnvelope: text("body_envelope").notNull(),
  credentialHeader: text("credential_header").notNull(),
  credentialTemplate: text("credential_template").notNull(),
  /** JSON: string[] — l'allowlist d'en-têtes de la règle, figée à la décision. */
  forwardHeaders: text("forward_headers").notNull().default("[]"),
  /** Migration 24 : où lire la réussite dans la réponse. NULL = le statut HTTP suffit. */
  successField: text("success_field"),
  createdAt: text("created_at").notNull(),
  /** Suit le TTL d'approbation. Une ligne expirée n'est jamais rendue. */
  expiresAt: text("expires_at").notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.ref] })]);

/**
 * La liaison entre une identité du fournisseur d'identité et un compte de console.
 *
 * Déclarée ici parce que `schema-parity.test.ts` l'exige : une table vivante que Drizzle
 * ne connaît pas est une table qu'un `db:push` supprime. Le garde a trouvé celle-ci dès
 * sa création, ce qui est exactement son office.
 *
 * `issuer` + `subject` est l'identité ; `last_email` n'est qu'un attribut CONSERVÉ POUR
 * MÉMOIRE, jamais une clé de lecture — c'est tout le propos de la migration 23.
 */
export const ssoIdentityRows = sqliteTable("sso_identities", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  userId: text("user_id").notNull(),
  organizationId: text("organization_id"),
  lastEmail: text("last_email").notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});
