/**
 * The organization (tenant) registry.
 *
 * This is the one table read without a tenant filter, because it is the table that
 * *defines* the tenants everything else is filtered by. It is always read by primary
 * key and is never listed to a tenant caller — an endpoint that returned the list of
 * organizations would hand every customer the names of all the others.
 *
 * Prepared statements rather than the query builder, for the same reason as the
 * session store: `isActive` runs on the authentication path of every request.
 */

import crypto from "node:crypto";
import { rawDb } from "../db";
import { DEFAULT_CURRENCY, parseCurrency, type CurrencyCode } from "@shared/money";
import {
  organizationId,
  organizationNameKey,
  organizationNameProblem,
  type Organization,
  type OrganizationId,
} from "@shared/tenancy";

interface Row {
  id: string;
  name: string;
  /** The normalised name, UNIQUE since migration 18. The key a tenant is found by. */
  name_key: string;
  created_at: string;
  active: number;
  currency: string | null;
}

/** Raised when a caller asks for an organization under a name that cannot be a key. */
export class InvalidOrganizationName extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidOrganizationName";
  }
}

/**
 * The alphabet of an opaque identifier: lowercase letters and digits.
 *
 * No `-` and no `_`, although `ORGANIZATION_ID_PATTERN` allows both. An identifier must
 * not be able to *look* like a slug of a company name, because the whole point of
 * migration 18 is that reading an identifier tells you nothing about the customer. A
 * reader who sees `org_k3f9x2qd7m1v8sb4tz0h` cannot wonder whether the separators mean
 * something.
 */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Characters of randomness after `org_`. 20 × log2(36) ≈ 103 bits. */
const ID_LENGTH = 20;

/**
 * Mints an opaque organization identifier. **This is the only place in the codebase
 * that may produce one**, which `tenant-opaque-id.test.ts` asserts by scanning the
 * sources — the rule that replaced `organizationIdFromName`.
 *
 * `crypto.randomInt` rather than `Math.random`: an identifier is not a secret (it is
 * printed in logs and URLs), but it is a key in a shared namespace, and a predictable
 * generator would let someone who has seen a few identifiers guess the next tenant's.
 * `randomInt` is also free of the modulo bias a `randomBytes % 36` would introduce,
 * which would have made some characters likelier than others and quietly cost entropy.
 *
 * No collision check: with 36^20 values, a collision is not a case worth code. If one
 * ever happened, `INSERT OR IGNORE` would ignore it, the read-back would return the
 * other tenant's row, and `ensureByName` would notice that its name does not match and
 * throw rather than hand over a foreign scope. That guard is what makes the absence of
 * a check safe, and it is tested.
 */
function newOrganizationId(): OrganizationId {
  let out = "";
  for (let index = 0; index < ID_LENGTH; index += 1) {
    out += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  }
  return organizationId(`org_${out}`);
}

function toOrganization(row: Row): Organization {
  /*
   * A row whose currency cannot be parsed falls back to the default rather than throwing.
   * The column is NOT NULL with a default since migration 15, so the only way to reach
   * this branch is a value written outside the application — by hand, or by a restore
   * from a database that predates the migration. The alternative, throwing, would make
   * one bad row deny authentication for the whole tenant, and the amounts in that tenant
   * were denominated in the default anyway, which is what migration 15 backfilled.
   *
   * It is deliberately not silent: `parseCurrency` returning null here means the stored
   * value is not a currency Oathrion knows, and that is worth a line in the log.
   */
  const stored = parseCurrency(row.currency);
  if (stored === null && row.currency !== null && row.currency !== "") {
    console.error(
      `[organizations] "${row.id}" stores currency "${row.currency}", which is not supported; ` +
        `reading it as ${DEFAULT_CURRENCY}. Correct the row or add the currency to shared/money.ts.`,
    );
  }
  return {
    id: organizationId(row.id),
    name: row.name,
    createdAt: row.created_at,
    active: row.active !== 0,
    currency: stored ?? DEFAULT_CURRENCY,
  };
}

const findStmt = rawDb.prepare(`SELECT * FROM organizations WHERE id = ?`);
const insertStmt = rawDb.prepare(
  // `true` rather than `1`, and `(? <> 0)` below rather than `?`: both are valid SQLite
  // and valid PostgreSQL, where `active` is a real boolean column. Writing `1` into it
  // would fail on PostgreSQL, and reading a boolean as `!== 0` would make a suspended
  // organization read as active — so the portable form is used on both engines (Phase 12).
  `INSERT OR IGNORE INTO organizations (id, name, name_key, created_at, active, currency)
     VALUES (?, ?, ?, ?, true, ?)`,
);
/*
 * The lookup that replaced the slug. `INSERT OR IGNORE` translates to an UNTARGETED
 * `ON CONFLICT DO NOTHING` on PostgreSQL (`identity/sync-postgres.ts`), so it absorbs a
 * violation of the UNIQUE index on `name_key` and not only one of the primary key —
 * which is what makes two processes booting at once safe here.
 */
const findByNameKeyStmt = rawDb.prepare(`SELECT * FROM organizations WHERE name_key = ?`);
const setCurrencyStmt = rawDb.prepare(`UPDATE organizations SET currency = ? WHERE id = ?`);
const activeStmt = rawDb.prepare(`SELECT active FROM organizations WHERE id = ?`);
const setActiveStmt = rawDb.prepare(`UPDATE organizations SET active = (? <> 0) WHERE id = ?`);
const listStmt = rawDb.prepare(`SELECT * FROM organizations ORDER BY created_at ASC, id ASC`);

export const organizationStore = {
  find(id: OrganizationId): Organization | null {
    const row = findStmt.get(id) as Row | undefined;
    return row ? toOrganization(row) : null;
  },

  /**
   * Creates the organization if it does not exist, and returns it.
   *
   * `INSERT OR IGNORE` rather than a read-then-write: this runs at boot for every
   * organization named by a credential, and two workers starting at once must not
   * race into a primary-key error. An existing organization is never renamed — the
   * name in the environment is a label for a new tenant, not an authority over one
   * that already has data.
   */
  ensure(id: OrganizationId, name: string, currency: CurrencyCode = DEFAULT_CURRENCY): Organization {
    /*
     * The currency applies only to a tenant being created. `INSERT OR IGNORE` means an
     * existing organization keeps the one it has — for the same reason it is never
     * renamed here, and more strongly: its mandates, policy ceilings and recorded spend
     * are already denominated in that currency, so changing it from a boot-time label
     * would silently reinterpret every amount the tenant has. Changing it is
     * `setCurrency`, a deliberate call.
     */
    const problem = organizationNameProblem(name);
    if (problem !== null) throw new InvalidOrganizationName(problem);

    insertStmt.run(id, name, organizationNameKey(name), new Date().toISOString(), currency);
    const found = this.find(id);
    if (!found) {
      /*
       * Since migration 18 there are two ways to get here, and they need different
       * messages.
       *
       * The first is a name already held by ANOTHER organization: the UNIQUE index on
       * `name_key` refused the row, and `INSERT OR IGNORE` swallowed the refusal. Naming
       * that explicitly matters, because the caller's mental model ("I asked for id X")
       * is not where the conflict is. It is refused rather than resolved: silently
       * returning the organization that holds the name would hand this caller another
       * tenant's scope, which is the one failure this file exists to prevent.
       *
       * The second is the original one — the insert failed for a reason the schema
       * should make impossible.
       */
      const holder = findByNameKeyStmt.get(organizationNameKey(name)) as Row | undefined;
      if (holder) {
        throw new InvalidOrganizationName(
          `the name "${name}" already belongs to organization "${holder.id}", and a name ` +
            `identifies at most one organization since migration 18. Creating "${id}" under ` +
            `that name is refused: returning "${holder.id}" instead would scope this caller ` +
            `to another tenant. Choose a different name, or use the existing organization.`,
        );
      }
      throw new Error(`organization "${id}" could not be created or read back`);
    }
    return found;
  },

  /** The organization holding this name, or `null`. Normalised through `organizationNameKey`. */
  findByName(name: string): Organization | null {
    const row = findByNameKeyStmt.get(organizationNameKey(name)) as Row | undefined;
    return row ? toOrganization(row) : null;
  },

  /**
   * Finds the organization carrying this name, creating it with a **fresh opaque
   * identifier** if it does not exist. The single entry point for "a tenant named X".
   *
   * ## Why this replaced `organizationIdFromName`
   *
   * The two production paths that create a tenant name it rather than identify it:
   * `OATHRION_CONSOLE_USERS` (`server/auth.ts`) and `npm run bootstrap:admin`. Both must be
   * idempotent across restarts — the same entry at the next boot has to find the same
   * tenant, not make a second one. The old code bought that idempotence by *computing*
   * the identifier from the name, which is what leaked the customer's name into every
   * log line and audit row. Here it comes from a lookup on `name_key`, backed by the
   * UNIQUE index of migration 18, and the identifier carries no information.
   *
   * ## The order of operations, which is the whole of the concurrency argument
   *
   * Look up, then `INSERT OR IGNORE`, then look up again — never insert-then-trust.
   * Two replicas booting with the same `OATHRION_CONSOLE_USERS` both miss on the first
   * lookup and both insert; the UNIQUE index lets exactly one through, the other's
   * insert is ignored, and the second lookup returns the winner's row. Both callers
   * therefore return the SAME organization, with the winner's identifier. A
   * read-then-create without the index would have produced two tenants with the same
   * name and different identifiers — one of which no credential would ever name again.
   *
   * The final guard (`name_key` of the row read back must equal the one asked for)
   * exists for the pathological case: an identifier collision, or a row changed
   * underneath. It makes "returned the wrong tenant" impossible rather than unlikely,
   * which is why `newOrganizationId` needs no collision check of its own.
   */
  ensureByName(name: string, currency: CurrencyCode = DEFAULT_CURRENCY): Organization {
    const problem = organizationNameProblem(name);
    if (problem !== null) throw new InvalidOrganizationName(problem);

    const key = organizationNameKey(name);
    const existing = findByNameKeyStmt.get(key) as Row | undefined;
    if (existing) return toOrganization(existing);

    insertStmt.run(newOrganizationId(), name, key, new Date().toISOString(), currency);

    const stored = findByNameKeyStmt.get(key) as Row | undefined;
    if (!stored) {
      throw new Error(`organization named "${name}" could not be created or read back`);
    }
    if (organizationNameKey(stored.name) !== key) {
      throw new Error(
        `organization lookup for "${name}" read back "${stored.name}" ("${stored.id}"). ` +
          `Refusing to return it: a tenant scope must never come from a row that does not ` +
          `carry the name it was asked for.`,
      );
    }
    return toOrganization(stored);
  },

  /**
   * Whether this organization may currently be used.
   *
   * An **unknown** organization is inactive. That is the important half: it means a
   * credential naming an organization that does not exist authenticates nobody,
   * instead of opening a session scoped to an id no row matches — a scope that would
   * read as empty today and could collide with a real customer tomorrow.
   */
  isActive(id: OrganizationId): boolean {
    const row = activeStmt.get(id) as { active: number } | undefined;
    return row !== undefined && row.active !== 0;
  },

  /** Suspends or restores an organization without touching its data. */
  setActive(id: OrganizationId, active: boolean): boolean {
    return setActiveStmt.run(active ? 1 : 0, id).changes > 0;
  },

  /**
   * Changes the tenant's unit of account.
   *
   * Deliberately NOT a reinterpretation of existing amounts. Every mandate ceiling,
   * policy threshold and recorded spend already stored for this tenant is a number in the
   * OLD currency, and this call does not convert them — Oathrion holds no exchange rates. So
   * switching a live tenant from EUR to XOF leaves a 500 ceiling meaning 500 francs where
   * it meant 500 euros, which is a ~328-fold reduction in real terms.
   *
   * It is exposed because a tenant configured in the wrong currency before any amount was
   * entered must be fixable, which is the realistic case. Anything else needs the
   * ceilings restated, and no code can decide what the operator meant.
   */
  setCurrency(id: OrganizationId, currency: CurrencyCode): boolean {
    return setCurrencyStmt.run(currency, id).changes > 0;
  },

  /** Operator-facing only. Never exposed to a tenant caller. */
  list(): Organization[] {
    return (listStmt.all() as Row[]).map(toOrganization);
  },
};
