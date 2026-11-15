/**
 * Per-organization quota enforcement (P3).
 *
 * ## Why this is not in `server/limits.ts`
 *
 * The roadmap named `server/limits.ts` for this work, and that turned out to be the
 * wrong file. `limits.ts` is a dependency-free module of two constants —
 * `MAX_TOOL_ATTEMPTS` and `DEFAULT_RESOLVED_APPROVAL_LIMIT` — imported by
 * `server/gateway/retryability.ts`, `server/gateway/agent-gateway.ts` and
 * `server/repositories/sqlite.ts`. Quota enforcement has to import `./db`, and
 * `server/db.ts` opens SQLite and runs the migration ledger at import time. Putting
 * this code in `limits.ts` would therefore make a pure retryability calculation open a
 * database as a side effect of being imported, in every context that reads a constant
 * from it. The two concerns share a word, not a dependency footprint, so they stay in
 * separate files and `limits.ts` is left byte-identical.
 *
 * ## Where the check happens, and why it is not in a middleware
 *
 * The obvious place for a quota check is a middleware on the routes that create
 * things. It was rejected, for the same reason the tenant filter lives in the
 * repository rather than in the handlers.
 *
 * An execution is persisted by four different routes today — `POST /api/decision`
 * (when `persist` is set), `POST /api/execute`, `POST /api/evaluate` (when `persist`
 * is set) and `POST /api/executions` — plus `POST /api/executions/:id/retry`, which
 * writes to an existing row rather than creating one. A route-level guard therefore
 * has to be attached four times, correctly, and a fifth route added next quarter
 * bypasses the quota entirely while compiling, passing review and passing every
 * existing test. That is the same shape of defect as a repository method that forgets
 * `organization_id`, and it gets the same answer: the guard goes at the single point
 * where the row is actually written, so there is nothing to remember.
 *
 * A second, sharper reason: `/api/decision` and `/api/evaluate` both accept a dry run
 * that writes nothing. A middleware cannot tell a dry run from a persisted decision —
 * the distinction is a field in the body it has not parsed yet — so it would either
 * charge a customer's monthly execution quota for evaluations that left no trace, or
 * parse the body twice and disagree with the handler about what it says.
 *
 * ## Why the count is exact rather than a stored counter
 *
 * `assertWithinQuota` issues a tenant-filtered `count(*)` inside the same transaction
 * as the write it guards. It cannot drift and it cannot race: SQLite serialises
 * writers, so two concurrent creations at the ceiling cannot both read `used = 499`
 * and both insert. A stored counter would be O(1) and would drift; the reasoning is
 * in `server/migrations/007-usage-counters.ts`, and the cost of exactness is one
 * indexed aggregate served by indexes that already exist.
 *
 * ## Fail mode
 *
 * There is none, deliberately, and the asymmetry with the rate limiter is the point.
 * The limiter has a `RATE_LIMIT_FAIL_MODE` because its counter lives in a store that
 * can be unreachable while the database is fine. A quota count is a query against the
 * same database as the write it guards, inside the same transaction: if it fails, the
 * write was never going to succeed either. An unreachable quota therefore cannot
 * become a bypass, so there is no mode to get wrong.
 *
 * ## A recorded trade-off: this file talks to SQLite directly
 *
 * It issues Drizzle queries against `./db` rather than going through
 * `server/repositories/`, which is the layer that exists so the engine can be swapped.
 * That is a deliberate cost, forced by the paragraph above: the guard has to run
 * *inside* a `better-sqlite3` transaction to be race-free, those transactions are
 * synchronous and cannot await, and every method on the repository contract returns a
 * promise. Adding synchronous counting methods to that contract would push a
 * SQLite-shaped constraint into the interface PostgreSQL is supposed to be able to
 * implement — a worse outcome than confining it here, and the reason
 * `server/repositories/types.ts` is untouched by this phase.
 *
 * The consequence is written down rather than left to be discovered: when PostgreSQL
 * becomes a repository backend, this file needs a sibling in the same shape as
 * `server/rate-limit/postgres-store.ts`, and only the three counting queries move —
 * `assertWithinQuota`, the refusal, the modes and the measurement are
 * engine-independent already.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./db";
import { agentRows, executionRows, policyRows, usageCounterRows } from "@shared/schema";
import type { OrganizationId } from "@shared/tenancy";
import {
  DEFAULT_QUOTAS,
  EMPTY_QUOTA_OVERRIDES,
  LIFETIME_PERIOD,
  QUOTA_COUNTER_NAMES,
  QUOTA_LABELS,
  describeQuotaOverrides,
  limitsFor,
  parseQuotaOverrides,
  periodResetFor,
  periodStartFor,
  quotaKind,
  type QuotaCounter,
  type QuotaLimits,
  type QuotaMode,
  type QuotaOverrides,
  type QuotaUsage,
  InvalidQuotaOverride,
  quotaCeilingProblem,
} from "@shared/quotas";
import { organizationQuotaStore } from "./repositories/organization-quotas";
import { isLocalMode } from "./local-mode";
import "./env-compat";

/* ------------------------------- configuration ----------------------------- */

let overrides: QuotaOverrides | undefined;
let mode: QuotaMode | undefined;

/**
 * `enforce` by default — except in local mode (`oathrion wrap`), where it is `observe`.
 *
 * The quotas protect a shared deployment from a tenant's runaway integration. On a
 * person's own machine there is no other tenant to protect, and the ceiling bit the wrong
 * person: at 100 000 executions in a month, every call of every client failed until the
 * 1st (endurance bench, STRESS-TEST-LOG §5.75). The rate limiter still stops a runaway
 * loop locally; the quota keeps measuring. An explicit `OATHRION_QUOTA_MODE` still wins.
 */
export function resolveQuotaMode(env: NodeJS.ProcessEnv = process.env, local: boolean = isLocalMode()): QuotaMode {
  const raw = env.OATHRION_QUOTA_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return local ? "observe" : "enforce";
  if (raw === "enforce" || raw === "observe") return raw;
  throw new Error(
    `OATHRION_QUOTA_MODE is "${raw}", which is neither "enforce" nor "observe". An unrecognised ` +
      `value is refused rather than defaulted, because the two answers differ by whether a ` +
      `runaway integration is stopped or merely recorded.`,
  );
}

function activeOverrides(): QuotaOverrides {
  overrides ??= parseQuotaOverrides(process.env.OATHRION_QUOTAS);
  return overrides;
}

function activeMode(): QuotaMode {
  mode ??= resolveQuotaMode();
  return mode;
}

/**
 * The mode in force, including anything `configureQuotas` installed.
 *
 * Exported for the PostgreSQL counting sibling (`server/repositories/postgres.ts`),
 * which has to make the same enforce/observe decision this file makes. Re-deriving it
 * from the environment there would ignore the test seam and let the two engines
 * disagree about whether a breach refuses or is merely recorded.
 */
export function quotaModeNow(): QuotaMode {
  return activeMode();
}

/** Test seam: installs a configuration directly. Never called by the server. */
export function configureQuotas(next: { overrides?: QuotaOverrides; mode?: QuotaMode }): void {
  if (next.overrides !== undefined) overrides = next.overrides;
  if (next.mode !== undefined) mode = next.mode;
}

/** Test seam: forgets the configuration so the next call re-reads the environment. */
export function resetQuotaConfig(): void {
  overrides = undefined;
  mode = undefined;
}

/**
 * The ceilings in force for one organization — THE single resolution path (chantier 1).
 *
 * Order, lowest to highest precedence:
 *   1. the shipped defaults (`DEFAULT_QUOTAS`);
 *   2. `OATHRION_QUOTAS` `default:` entries — a property of the deployment, not of a tenant,
 *      so they stay in the environment and are never imported;
 *   3. `OATHRION_QUOTAS` `org_x:` entries — the bootstrap fallback, kept so a deployment that
 *      has only the environment behaves exactly as before, including on a process where
 *      the boot import below has not run (scripts, tests);
 *   4. the tenant's rows in `organization_quotas` — the source of truth.
 *
 * 3 and 4 agree on a running server: at boot, rows owned by the environment are
 * synchronised to it and a contradiction of a row owned by the application refuses the
 * boot (`importQuotaOverrides`); at runtime `setOrganizationQuota` refuses to write a
 * value the environment contradicts. The only window where they differ is a rolling
 * deploy in which another replica booted with a different OATHRION_QUOTAS — then the
 * database, shared by every replica, is what this one enforces.
 *
 * Read on every call — no cache. See `server/repositories/organization-quotas.ts` for
 * why, and docs/limitations.md for the cost.
 */
export function quotaLimitsFor(organization: OrganizationId): QuotaLimits {
  return { ...limitsFor(organization, activeOverrides()), ...organizationQuotaStore.ceilingsFor(organization) };
}

/**
 * Raised when `OATHRION_QUOTAS` and the database hold different ceilings for the same
 * tenant and counter.
 *
 * Refused rather than resolved, by the operator's decision recorded for chantier 1:
 * letting the database win silently would make an edited `OATHRION_QUOTAS` look applied
 * while doing nothing; letting the environment win would undo, at the next restart,
 * a change made at runtime. Either way the ceiling in force would not be the one the
 * operator believes. The message names both values and their sources so the fix —
 * align or remove the environment entry — is the obvious one.
 */
export class QuotaConfigurationConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaConfigurationConflict";
  }
}

function conflictMessage(
  organization: string,
  counter: QuotaCounter,
  environment: number,
  stored: { ceiling: number; source: string },
): string {
  return (
    `OATHRION_QUOTAS sets ${organization}:${counter}=${environment}, but the database holds ` +
    `${stored.ceiling} for the same tenant and counter (source: ${stored.source}). ` +
    `The two sources disagree, so Oathrion refuses to guess which one is meant. Since chantier 1 ` +
    `the database is the source of truth: remove "${organization}:${counter}" from OATHRION_QUOTAS ` +
    `(or set it to ${stored.ceiling}) and start again.`
  );
}

/**
 * Brings the database in line with the per-organization entries of `OATHRION_QUOTAS`. Run
 * once per boot, before the server accepts traffic (`registerRoutes`).
 *
 * ## Who owns a row decides what the environment may do to it
 *
 * A row imported from the environment (`source = 'environment'`) keeps FOLLOWING the
 * environment: edit the entry and restart, the row is updated; remove the entry and
 * restart, the row is deleted and the tenant falls back to the default. That is exactly
 * what `OATHRION_QUOTAS` did before this table existed, including the documented way to
 * lift a freeze ("remove the line", DEPLOYMENT.md §15.3). The first version of this
 * function imported once and then treated any later difference as a conflict; that
 * would have left a frozen tenant frozen after its line was removed — a deployment
 * with only environment variables would NOT have behaved as before, which the
 * chantier forbids. Found while updating §15.3, before it shipped.
 *
 * A row written by the application (`source = 'api'`) is the source of truth. An
 * `OATHRION_QUOTAS` entry that contradicts it refuses the boot with both values named
 * (`QuotaConfigurationConflict`, the operator's decision for chantier 1); an entry that
 * agrees with it is accepted; removing the entry leaves the row alone.
 *
 * ## Properties
 *
 * Idempotent: an unchanged deployment's second boot writes nothing (`updated_at`
 * included). Safe between replicas booting together: inserts are `INSERT OR IGNORE`
 * compared against what is stored afterwards, and updates/deletes carry
 * `source = 'environment'` in their WHERE clause, so a booting replica can never touch a
 * row the application owns. During a rolling deploy, replicas with an old and a new
 * `OATHRION_QUOTAS` each rewrite the environment-owned rows on their own boot; the last
 * boot wins — the same window as before, when each process read its own environment.
 *
 * On the first conflict it throws; rows already synchronised in the same run are not
 * rolled back, since each one equals the environment — the state the corrected boot
 * would produce anyway.
 */
export function importQuotaOverrides(
  knownOrganizations: Iterable<OrganizationId>,
  overrides: QuotaOverrides = activeOverrides(),
): { imported: number; updated: number; removed: number; unchanged: number } {
  let imported = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;
  for (const [organization, counters] of Object.entries(overrides.byOrganization)) {
    for (const [counter, ceiling] of Object.entries(counters) as [QuotaCounter, number][]) {
      const org = organization as OrganizationId;
      const { inserted, stored } = organizationQuotaStore.insertIfAbsent(org, counter, ceiling, "environment");
      if (inserted) {
        imported += 1;
      } else if (stored.ceiling === ceiling) {
        unchanged += 1;
      } else if (stored.source === "environment" && organizationQuotaStore.updateEnvironmentOwned(org, counter, ceiling)) {
        updated += 1;
      } else {
        // Owned by the application (or taken over between the read and the update):
        // the environment contradicts the source of truth.
        const current = organizationQuotaStore.find(org, counter) ?? stored;
        throw new QuotaConfigurationConflict(conflictMessage(organization, counter, ceiling, current));
      }
    }
  }
  /*
   * Removal is looked up per tenant — the registered organizations plus those the
   * environment names — rather than by one scan of every environment-owned row, which
   * would be a cross-tenant statement. The consequence, written in docs/limitations.md:
   * a row imported for an organization that was never created and whose entry was then
   * removed is not found here; it stays, inert, and would apply if an organization with
   * that exact id were created later.
   */
  const tenants = new Set<string>([...knownOrganizations, ...Object.keys(overrides.byOrganization)]);
  for (const organization of tenants) {
    const org = organization as OrganizationId;
    for (const counter of organizationQuotaStore.environmentOwnedFor(org)) {
      const stillDeclared = overrides.byOrganization[organization]?.[counter as QuotaCounter];
      if (stillDeclared === undefined && organizationQuotaStore.deleteEnvironmentOwned(org, counter as QuotaCounter)) {
        removed += 1;
      }
    }
  }
  return { imported, updated, removed, unchanged };
}

/**
 * Sets one tenant's ceiling for one counter — the single WRITE path, used by the
 * administration API (later step of chantier 1) and by tests.
 *
 * Refuses, with a named reason:
 *   - an invalid ceiling or counter (`quotaCeilingProblem`, the rule `OATHRION_QUOTAS`
 *     also uses) — `InvalidQuotaOverride`;
 *   - a value that differs from an `OATHRION_QUOTAS` entry for the same tenant and counter —
 *     `QuotaConfigurationConflict`. Without this refusal the application itself could
 *     write a database state that makes the NEXT boot refuse to start, which is the one
 *     kind of runtime write that must never succeed.
 */
export function setOrganizationQuota(
  organization: OrganizationId,
  counter: QuotaCounter,
  ceiling: number,
): void {
  const problem = quotaCeilingProblem(counter, ceiling);
  if (problem !== null) throw new InvalidQuotaOverride(problem);
  const environment = activeOverrides().byOrganization[organization]?.[counter];
  if (environment !== undefined && environment !== ceiling) {
    throw new QuotaConfigurationConflict(
      `OATHRION_QUOTAS sets ${organization}:${counter}=${environment}; writing ${ceiling} to the ` +
        `database would make the next boot refuse to start. Remove "${organization}:${counter}" ` +
        `from OATHRION_QUOTAS first — since chantier 1 the database is the source of truth.`,
    );
  }
  organizationQuotaStore.set(organization, counter, ceiling, "api");
}

/**
 * One line for the boot report.
 *
 * Every accepted override is printed. An operator who mistypes an organization id
 * gets a silently inert override otherwise — the ceiling they configured applies to
 * an organization that does not exist, and the real one keeps the default — and the
 * only place that becomes visible is here.
 */
export function describeQuotaConfiguration(): string {
  const active = activeMode();
  const listed = describeQuotaOverrides(activeOverrides());
  const defaults = QUOTA_COUNTER_NAMES.map((c) => `${c}=${DEFAULT_QUOTAS[c]}`).join(" ");
  /*
   * Named, not counted: a count would be a cross-tenant query, which the tenant
   * isolation barrier forbids. What the boot line must show is that a database layer
   * exists above these values, so nobody reads "no OATHRION_QUOTAS overrides" as "no
   * per-tenant ceilings". Each tenant reads its own through `GET /api/usage`.
   */
  const stored = "per-tenant ceilings stored in the database take precedence";
  return listed === ""
    // No `[quotas]` prefix here: the caller in server/index.ts passes "quotas" to `log`,
    // which prefixes the line itself. Including it produced `[quotas] [quotas] mode=...`.
    ? `mode=${active}, defaults: ${defaults} (no OATHRION_QUOTAS overrides), ${stored}`
    : `mode=${active}, defaults: ${defaults}, overrides: ${listed}, ${stored}`;
}

/* --------------------------------- refusal --------------------------------- */

/**
 * Raised when a write would take an organization past a ceiling.
 *
 * Carries the numbers rather than only a sentence. `server/routes.ts` turns it into a
 * response body containing `counter`, `limit`, `used` and `resetAt`, because the
 * caller's next action depends on which of those it is: a `count` ceiling is fixed by
 * deleting something or buying more, a `period` ceiling is fixed by waiting until a
 * date the reply names. A single opaque "quota exceeded" string forces a support
 * ticket to learn which.
 */
export class QuotaExceededError extends Error {
  readonly counter: QuotaCounter;
  readonly limit: number;
  readonly used: number;
  readonly resetAt: string | null;
  /**
   * 409 for a ceiling on live rows, 429 for a ceiling on events in a period.
   *
   * Not 403 for either: a 403 already means "your role does not allow this" in this
   * API, and a client that cannot tell "you lack the capability" from "you are full"
   * will retry the first as though it were the second — or, worse, escalate a user's
   * role to fix a quota problem. 429 is correct for the period counter because
   * waiting genuinely resolves it, and it carries `Retry-After`. 409 is correct for
   * the row counter because waiting resolves nothing: the conflict is with the
   * current state of the collection, which is what 409 means.
   */
  readonly status: 409 | 429;

  constructor(args: {
    counter: QuotaCounter;
    limit: number;
    used: number;
    resetAt: string | null;
  }) {
    const { counter, limit, used, resetAt } = args;
    const remedy =
      resetAt === null
        ? `Remove one first, or ask your operator to raise the limit.`
        : `The counter resets at ${resetAt}.`;
    super(
      `Quota reached for ${QUOTA_LABELS[counter]}: the limit is ${limit} and ${used} are ` +
        `already counted for this organization. ${remedy}`,
    );
    this.name = "QuotaExceededError";
    this.counter = counter;
    this.limit = limit;
    this.used = used;
    this.resetAt = resetAt;
    this.status = resetAt === null ? 409 : 429;
  }
}

/* ----------------------- the period counter (SQLite) ----------------------- */

/*
 * La version SYNCHRONE de `server/sql/execution-quota.ts`, pour les dépôts SQLite dont les
 * transactions ne peuvent pas attendre. Même table, même clé, même sens.
 */
function readPeriodCounterSync(organization: OrganizationId, periodStart: string): number | null {
  const row = db.get<{ used: number }>(
    sql`SELECT used FROM quota_period_counts WHERE organization_id = ${organization} AND counter = 'executions' AND period_start = ${periodStart}`,
  );
  return row ? Number(row.used) : null;
}

function periodUsageSync(organization: OrganizationId, periodStart: string): number {
  const known = readPeriodCounterSync(organization, periodStart);
  if (known !== null) return known;
  const counted = currentUsage(organization, "executions", new Date(periodStart));
  db.run(
    sql`INSERT INTO quota_period_counts (organization_id, counter, period_start, used) VALUES (${organization}, 'executions', ${periodStart}, ${counted}) ON CONFLICT (organization_id, counter, period_start) DO NOTHING`,
  );
  return readPeriodCounterSync(organization, periodStart) ?? counted;
}

function incrementPeriodUsageSync(organization: OrganizationId, periodStart: string): void {
  db.run(
    sql`UPDATE quota_period_counts SET used = used + 1 WHERE organization_id = ${organization} AND counter = 'executions' AND period_start = ${periodStart}`,
  );
}

/* ---------------------------------- counting -------------------------------- */

/**
 * The exact current value of a counter for one organization.
 *
 * Synchronous. Every caller is either inside a `better-sqlite3` transaction (which
 * cannot await) or a route that is happy to block on a point query, and making this
 * async would mean the guard could not run inside the transaction that makes it
 * race-free.
 *
 * Each query leads with `organization_id`, which is both the isolation guarantee and
 * the index prefix: `(organization_id, id)` is the primary key of `agents` and
 * `policies`, and `idx_executions_org_ts` is `(organization_id, timestamp)`. So the
 * counts are index scans over one tenant's slice, never over the table.
 */
export function currentUsage(organization: OrganizationId, counter: QuotaCounter, at: Date = new Date()): number {
  switch (counter) {
    case "agents": {
      const row = db
        .select({ n: sql<number>`count(*)` })
        .from(agentRows)
        .where(eq(agentRows.organizationId, organization))
        .get();
      return row?.n ?? 0;
    }
    case "policies": {
      const row = db
        .select({ n: sql<number>`count(*)` })
        .from(policyRows)
        .where(eq(policyRows.organizationId, organization))
        .get();
      return row?.n ?? 0;
    }
    case "executions": {
      /*
       * Counted by `timestamp`, the column the execution itself carries, and not by
       * an insertion clock. The two differ for a backfill or an import, and the
       * quota an operator sells is "executions in August", which is a property of
       * when the decision happened rather than of when the row was written.
       */
      const start = periodStartFor("executions", at);
      /* Le compteur de la période s'il est ouvert ; sinon le comptage ci-dessous, sans rien écrire. */
      const known = readPeriodCounterSync(organization, start);
      if (known !== null) return known;
      const row = db
        .select({ n: sql<number>`count(*)` })
        .from(executionRows)
        .where(
          and(
            eq(executionRows.organizationId, organization),
            gte(executionRows.timestamp, start),
          ),
        )
        .get();
      /*
       * ET LA VOIE DIRECTE. `/api/actions/execute` n'écrit pas dans `executions` : il
       * consomme une autorisation (`action_grants.consumed_at`), puis écrit un reçu APRÈS
       * l'appel au fournisseur. On compte la consommation, l'instant où l'exécution est
       * décidée : compter les reçus laissait passer toutes les exécutions en vol (1 279
       * pour un plafond de 600 à 1 024 clients, journal §5.27). Les deux voies n'écrivent
       * jamais pour la même action : la somme ne compte rien deux fois. Servi par
       * `idx_action_grants_consumed` (migration 27). Même requête que
       * `countExecutionsSince` dans `server/authority/store.ts`.
       *
       * Limite : si le plan d'autorisation vit sur une autre base que les dépôts (SQLite
       * d'un côté, PostgreSQL de l'autre), chaque voie ne voit que la part de sa base.
       */
      const consumed = db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM action_grants WHERE organization_id = ${organization} AND consumed_at >= ${start}`,
      );
      return (row?.n ?? 0) + (consumed?.n ?? 0);
    }
  }
}

/* ------------------------------- measurement ------------------------------- */

/**
 * Records the high-water mark and, optionally, a refusal. Advisory — see the table's
 * own documentation.
 *
 * `observed_max` is raised with `max(...)` inside the statement rather than by reading
 * the row and writing back a larger number: the read-modify-write version loses
 * measurements under concurrency, and `max` in SQL is supported identically by SQLite
 * and PostgreSQL so the two engines record the same thing.
 *
 * Never throws. A failure to record a measurement must not fail the request it was
 * measuring — the write it guards was already decided, and a broken advisory counter
 * that could refuse traffic would be a worse defect than the missing measurement.
 */
export function recordUsage(
  organization: OrganizationId,
  counter: QuotaCounter,
  observed: number,
  refused: boolean,
  at: Date = new Date(),
  /**
   * How many refusals this call represents. Defaults to one. Above one only when a
   * deferred flush collapsed a burst against the same counter in the same tick, which
   * must add all of them rather than one.
   */
  refusalCount = 1,
): void {
  try {
    const periodStart = periodStartFor(counter, at);
    const now = at.toISOString();
    db.insert(usageCounterRows)
      .values({
        organizationId: organization,
        counter,
        periodStart,
        observedMax: observed,
        refusals: refused ? refusalCount : 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          usageCounterRows.organizationId,
          usageCounterRows.counter,
          usageCounterRows.periodStart,
        ],
        set: {
          observedMax: sql`max(${usageCounterRows.observedMax}, ${observed})`,
          refusals: sql`${usageCounterRows.refusals} + ${refused ? refusalCount : 0}`,
          updatedAt: now,
        },
      })
      .run();
  } catch (error) {
    console.error(
      `[quotas] could not record usage for ${counter} in ${organization}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** The refusals recorded for one counter in the current period. Advisory. */
function refusalsFor(organization: OrganizationId, counter: QuotaCounter, at: Date): number {
  const row = db
    .select({ refusals: usageCounterRows.refusals })
    .from(usageCounterRows)
    .where(
      and(
        eq(usageCounterRows.organizationId, organization),
        eq(usageCounterRows.counter, counter),
        eq(usageCounterRows.periodStart, periodStartFor(counter, at)),
      ),
    )
    .get();
  return row?.refusals ?? 0;
}

/**
 * Refusals awaiting a flush, keyed so that a burst of refusals against the same
 * counter in the same tick costs one statement instead of one per request.
 */
const pendingRefusals = new Map<
  string,
  { organization: OrganizationId; counter: QuotaCounter; observed: number; at: Date; count: number }
>();

/** Whether a flush is already scheduled, so a burst schedules one and not hundreds. */
let refusalFlushScheduled = false;

/**
 * Records a refusal AFTER the current call stack unwinds.
 *
 * See the long comment at the call site in `assertWithinQuota` for why this cannot be
 * written inline. Exported for tests, which need to flush deterministically rather than
 * waiting on the event loop.
 */
function queueRefusal(
  organization: OrganizationId,
  counter: QuotaCounter,
  observed: number,
  at: Date,
): void {
  const key = `${organization}\u0000${counter}\u0000${periodStartFor(counter, at)}`;
  const existing = pendingRefusals.get(key);
  if (existing) {
    existing.count += 1;
    // Keep the highest attempt seen: the peak is the informative number.
    existing.observed = Math.max(existing.observed, observed);
    return;
  }
  pendingRefusals.set(key, { organization, counter, observed, at, count: 1 });

  if (refusalFlushScheduled) return;
  refusalFlushScheduled = true;
  const timer = setImmediate(flushPendingRefusals);
  /*
   * Do not hold the event loop open for an advisory counter. Without this, a process
   * that has finished its work waits on this timer before exiting, which would make a
   * measurement delay a shutdown — and `smoke` asserts a clean exit on SIGTERM.
   */
  timer.unref?.();
}

/**
 * Writes every queued refusal. Idempotent and safe to call when nothing is queued, so a
 * test can call it unconditionally.
 */
export function flushPendingRefusals(): void {
  refusalFlushScheduled = false;
  if (pendingRefusals.size === 0) return;
  const batch = [...pendingRefusals.values()];
  pendingRefusals.clear();
  for (const item of batch) {
    // `recordUsage` never throws, so one bad row cannot strand the rest of the batch.
    recordUsage(item.organization, item.counter, item.observed, true, item.at, item.count);
  }
}

/* -------------------------------- the guard -------------------------------- */

/**
 * Refuses the write about to happen if it would take `organization` past its ceiling.
 *
 * Compares `used + 1` against the limit: the caller has not written yet, so the
 * question is whether the row it is about to add fits. A limit of 0 therefore refuses
 * everything, which is the honest reading of "you may have zero of these" and is what
 * makes a quota usable as a suspension.
 *
 * In `observe` mode the excess is recorded and the write proceeds. Nothing else
 * differs — the same count is taken and the same measurement is written — so an
 * operator can switch to `enforce` knowing exactly what would have been refused.
 */
export function assertWithinQuota(
  organization: OrganizationId,
  counter: QuotaCounter,
  at: Date = new Date(),
): void {
  const limit = quotaLimitsFor(organization)[counter];
  /*
   * Les exécutions : le compteur de la période (`server/sql/execution-quota.ts`, ici en
   * synchrone pour SQLite), ouvert si besoin par un comptage, puis incrémenté plus bas si
   * l'écriture est permise — dans la transaction de l'appelant.
   */
  const periodStart = periodStartFor("executions", at);
  const used = counter === "executions" ? periodUsageSync(organization, periodStart) : currentUsage(organization, counter, at);
  const wouldBe = used + 1;
  const exceeded = wouldBe > limit;

  /*
   * The high-water mark records what was ATTEMPTED, not what was stored. A refused
   * attempt is the most informative measurement there is — it is the moment the
   * ceiling actually bit — and recording only successful writes would leave the peak
   * pinned at the limit with no indication of how far past it demand went.
   *
   * `exceeded` is passed WITHOUT consulting the mode, and that is a correction of a
   * real defect this file shipped with for one afternoon: it recorded a breach only
   * when the mode was `enforce`. Observe mode exists precisely to measure the
   * refusals that WOULD happen before an operator turns enforcement on, so suppressing
   * the count there made the one mode whose entire purpose is measurement the one mode
   * that measured nothing. Caught by `quotas.test.ts`.
   */
  if (!exceeded || activeMode() === "observe") {
    /*
     * The write is going ahead, so this statement will commit with it. Recorded inline.
     */
    recordUsage(organization, counter, wouldBe, exceeded, at);
  } else {
    /*
     * The write is about to be REFUSED, and that changes where the measurement can be
     * written.
     *
     * Three of the five guarded call sites are inside a `db.transaction(...)`. The
     * exception thrown below unwinds that transaction, and SQLite rolls back everything
     * it contains — including a measurement written inline here. So the inline version
     * of this call recorded refusals that were then discarded by the very refusal they
     * were recording, and `usage_counters.refusals` stayed at 0 forever on the
     * executions path. That is the counter an operator reads to decide whether it is
     * safe to switch from `observe` to `enforce`, so a permanent 0 there does not merely
     * lose a statistic: it silently answers "nobody would be refused" to the one
     * question the mode exists to answer.
     *
     * Found by driving the built bundle with `executions=0` and watching `refusals`
     * stay at 0 after a genuine 429 — not by any test, and not by the type checker.
     *
     * The fix defers the write until after the stack has unwound, when no transaction is
     * open and the statement commits on its own. `setImmediate` and not `process.nextTick`:
     * nextTick runs before I/O and, more importantly, still inside the same synchronous
     * turn as the unwinding, which is exactly what has to be escaped.
     *
     * Accepted cost, stated rather than hidden: if the process dies between the refusal
     * and the flush, that one refusal is not counted. `usage_counters` is advisory by
     * design — enforcement always re-derives the truth with an exact `count(*)` — so the
     * failure mode is a slightly low statistic, never a wrongly allowed or wrongly
     * refused write.
     */
    queueRefusal(organization, counter, wouldBe, at);
  }

  if (!exceeded) {
    if (counter === "executions") incrementPeriodUsageSync(organization, periodStart);
    return;
  }

  if (activeMode() === "observe") {
    console.warn(
      `[quotas] ${organization} is over its ${counter} quota (${wouldBe} > ${limit}) but ` +
        `OATHRION_QUOTA_MODE=observe, so the write was allowed.`,
    );
    if (counter === "executions") incrementPeriodUsageSync(organization, periodStart);
    return;
  }

  throw new QuotaExceededError({
    counter,
    limit,
    used,
    resetAt: periodResetFor(counter, at),
  });
}

/* --------------------------------- reporting -------------------------------- */

/**
 * Every counter's state for one organization, for `GET /api/usage`.
 *
 * Exposed to the tenant and not only to the operator: an organization that is about
 * to hit a ceiling can see it coming, and a client that has just been refused can
 * confirm the numbers in the refusal rather than take them on trust. It reveals
 * nothing about any other tenant — every query here is scoped to the caller's own
 * organization, and `remaining` is clamped at 0 so an over-quota organization in
 * observe mode does not report a negative allowance.
 */
export function usageReport(organization: OrganizationId, at: Date = new Date()): QuotaUsage[] {
  const limits = quotaLimitsFor(organization);
  return QUOTA_COUNTER_NAMES.map((counter) => {
    const used = currentUsage(organization, counter, at);
    return {
      counter,
      label: QUOTA_LABELS[counter],
      kind: quotaKind(counter),
      used,
      limit: limits[counter],
      remaining: Math.max(limits[counter] - used, 0),
      resetAt: periodResetFor(counter, at),
      refusals: refusalsFor(organization, counter, at),
    };
  });
}

export { EMPTY_QUOTA_OVERRIDES, LIFETIME_PERIOD };
