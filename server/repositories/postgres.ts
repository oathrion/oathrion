/**
 * PostgreSQL implementation of the Oathrion repositories (Phase 11).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Phase 9 refused to boot on `DATABASE_DRIVER=postgres` and said so plainly: the
 * repositories were synchronous better-sqlite3 statements. Phase 10 gave the new
 * action-authorization plane a real PostgreSQL path but left that refusal in
 * place. This file removes the refusal for the application data plane by
 * implementing the same contracts — `server/repositories/types.ts` — over
 * PostgreSQL.
 *
 * DESIGN DECISIONS, STATED RATHER THAN IMPLIED
 * -------------------------------------------
 *  1. Raw portable SQL through Phase 10's {@link SqlExecutor}, not Drizzle. The
 *     SQLite repositories are written against `sqliteTable` definitions; a
 *     PostgreSQL Drizzle port would mean a second schema declaration that can
 *     drift from the migrations, and the migrations already own the schema for
 *     both engines. `?` placeholders are rewritten to `$n` by the executor.
 *
 *  2. Every statement carries `organization_id`. Not as a convention: the class
 *     is constructed with one tenant and there is no unscoped instance to obtain,
 *     exactly as in the SQLite implementation. A conditional write (`resolve`,
 *     `claimToolRun`, `expire`) carries the tenant *inside* the single UPDATE, so
 *     a cross-tenant write cannot match a row.
 *
 *  3. Timestamps. The PostgreSQL schema stores `timestamptz` where SQLite stores
 *     TEXT, so `pg` hands back `Date` objects. Every read goes through
 *     {@link iso}, which returns the same ISO-8601 string shape the domain
 *     objects and the API contract use. Comparisons (`expires_at > ?`) are
 *     therefore real timestamp comparisons rather than the lexicographic string
 *     comparison SQLite performs — stricter, not looser, and the reason
 *     `server/db.ts` needed the ISO-shape fix for the session sweep.
 *
 *  4. Quotas are counted here rather than through `server/quotas.ts`, whose
 *     counting queries go through the synchronous SQLite handle. That module's
 *     own documentation predicted this: "when PostgreSQL becomes a repository
 *     backend, this file needs a sibling ... only the three counting queries
 *     move". The limits, the refusal type, the modes and the advisory
 *     measurement are imported from it, so there is exactly one definition of
 *     each and the two engines cannot disagree about the ceiling.
 */

import { randomUUID } from "node:crypto";
import { linkAuditEntries } from "../audit-chain";
import { settledExecution, type ToolOutcome } from "./settle";
import { DEFAULT_RESOLVED_APPROVAL_LIMIT, MAX_TOOL_ATTEMPTS } from "../limits";
import { QuotaExceededError, quotaLimitsFor, quotaModeNow } from "../quotas";
import { executionQuotaLockKey, incrementPeriodUsage, periodUsage, reportedUsage } from "../sql/execution-quota";
import { approvalDeadline } from "@shared/approvals/ttl";
import {
  periodResetFor,
  periodStartFor,
  quotaKind,
  QUOTA_COUNTER_NAMES,
  QUOTA_LABELS,
  type QuotaCounter,
  type QuotaUsage,
} from "@shared/quotas";
import { EMPTY_MANDATE, type AgentMandate } from "@shared/policy/mandate";
import type { OrganizationId } from "@shared/tenancy";
import type { SqlExecutor } from "../sql/executor";
import type {
  Agent,
  Approval,
  ApprovalStatus,
  AuditEntry,
  Execution,
  Integration,
  Permission,
  Policy,
  PolicyAction,
  PolicyCondition,
  PolicyType,
  RiskLevel,
} from "@shared/types";
import type {
  AgentRepository,
  ApprovalRepository,
  ExecutionRepository,
  ExecutionStatusCounts,
  IntegrationRepository,
  PolicyRepository,
  Repositories,
} from "./types";

/* ------------------------------ value helpers ----------------------------- */

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const stringify = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * `timestamptz` → the ISO-8601 string the domain uses.
 *
 * `pg` returns a `Date` for `timestamptz`, and a `Date` where the contract says
 * `string` would reach the API response as a different JSON shape. Strings are
 * passed through untouched so a column that is TEXT in some future migration does
 * not break here.
 */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

function numberOf(value: unknown): number {
  if (typeof value === "number") return value;
  // `count(*)` and `sum()` come back as strings from `pg` (bigint/numeric are not
  // safely representable as a JS number in general, so the driver refuses to guess).
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* --------------------------------- mappers -------------------------------- */

interface AgentRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  status: string;
  current_task: string | null;
  owner: string;
  created_at: unknown;
  executions_24h: number;
  success_rate: number;
  cost_24h: number;
  cost_month: number;
  risk_level: string;
  permissions: string;
  mandate: string;
  policy_ids: string;
  tags: string;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider as Agent["provider"],
    model: row.model,
    status: row.status as Agent["status"],
    currentTask: row.current_task,
    owner: row.owner,
    createdAt: iso(row.created_at),
    executions24h: numberOf(row.executions_24h),
    successRate: numberOf(row.success_rate),
    cost24h: numberOf(row.cost_24h),
    costMonth: numberOf(row.cost_month),
    riskLevel: row.risk_level as RiskLevel,
    permissions: parse<Permission[]>(row.permissions, []),
    mandate: parse<AgentMandate>(row.mandate, EMPTY_MANDATE),
    policyIds: parse<string[]>(row.policy_ids, []),
    tags: parse<string[]>(row.tags, []),
  };
}

const AGENT_COLUMNS = `id, name, description, provider, model, status, current_task, owner,
  created_at, executions_24h, success_rate, cost_24h, cost_month, risk_level,
  permissions, mandate, policy_ids, tags`;

function agentValues(agent: Agent, org: OrganizationId): unknown[] {
  return [
    org,
    agent.id,
    agent.name,
    agent.description,
    agent.provider,
    agent.model,
    agent.status,
    agent.currentTask,
    agent.owner,
    agent.createdAt,
    agent.executions24h,
    agent.successRate,
    agent.cost24h,
    agent.costMonth,
    agent.riskLevel,
    stringify(agent.permissions),
    stringify(agent.mandate),
    stringify(agent.policyIds),
    stringify(agent.tags),
  ];
}

interface PolicyRow {
  id: string;
  name: string;
  description: string;
  rule: string;
  scope: string;
  applies_to: string;
  effect: string;
  status: string;
  triggered_count: number;
  updated_at: unknown;
  type: string | null;
  condition: string | null;
  action: string | null;
  applies_to_agent_ids: string | null;
  risk: string | null;
  priority: number;
}

function toPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rule: row.rule,
    scope: row.scope as Policy["scope"],
    appliesTo: row.applies_to,
    effect: row.effect as Policy["effect"],
    status: row.status as Policy["status"],
    triggeredCount: numberOf(row.triggered_count),
    updatedAt: iso(row.updated_at),
    type: (row.type as PolicyType | null) ?? undefined,
    condition: row.condition ? parse<PolicyCondition | undefined>(row.condition, undefined) : undefined,
    action: (row.action as PolicyAction | null) ?? undefined,
    appliesToAgentIds: row.applies_to_agent_ids
      ? parse<string[] | null>(row.applies_to_agent_ids, null)
      : null,
    risk: (row.risk as RiskLevel | null) ?? undefined,
    priority: numberOf(row.priority),
  };
}

const POLICY_COLUMNS = `id, name, description, rule, scope, applies_to, effect, status,
  triggered_count, updated_at, type, condition, action, applies_to_agent_ids, risk, priority`;

function policyValues(policy: Policy, org: OrganizationId): unknown[] {
  return [
    org,
    policy.id,
    policy.name,
    policy.description,
    policy.rule,
    policy.scope,
    policy.appliesTo,
    policy.effect,
    policy.status,
    policy.triggeredCount,
    policy.updatedAt,
    policy.type ?? null,
    policy.condition ? stringify(policy.condition) : null,
    policy.action ?? null,
    policy.appliesToAgentIds ? stringify(policy.appliesToAgentIds) : null,
    policy.risk ?? null,
    policy.priority ?? 0,
  ];
}

interface ExecutionRow {
  id: string;
  agent_id: string;
  agent_name: string;
  action: string;
  target: string;
  status: string;
  risk: string;
  duration_ms: number;
  cost: number;
  timestamp: unknown;
  input: string;
  decision: string;
  decision_reason: string;
  policy_evaluated: string | null;
  policy_id: string | null;
  result: string;
  audit: string;
  approval_id: string | null;
  tool_id: string | null;
  tool_executed_at: unknown;
  tool_result: string | null;
  run_state: string | null;
  attempts: number | null;
  last_error: string | null;
  tool_started_at: unknown;
}

function toExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    action: row.action,
    target: row.target,
    status: row.status as Execution["status"],
    risk: row.risk as RiskLevel,
    durationMs: numberOf(row.duration_ms),
    cost: numberOf(row.cost),
    timestamp: iso(row.timestamp),
    input: parse<Execution["input"]>(row.input, {}),
    decision: row.decision as Execution["decision"],
    decisionReason: row.decision_reason,
    policyEvaluated: row.policy_evaluated,
    policyId: row.policy_id,
    result: row.result,
    audit: parse<AuditEntry[]>(row.audit, []),
    approvalId: row.approval_id,
    toolId: row.tool_id,
    toolExecutedAt: isoOrNull(row.tool_executed_at),
    toolResult: row.tool_result ? parse<Record<string, unknown>>(row.tool_result, {}) : null,
    runState: (row.run_state ?? "pending") as Execution["runState"],
    attempts: numberOf(row.attempts),
    lastError: row.last_error,
    toolStartedAt: isoOrNull(row.tool_started_at),
  };
}

const EXECUTION_COLUMNS = `id, agent_id, agent_name, action, target, status, risk, duration_ms,
  cost, "timestamp", input, decision, decision_reason, policy_evaluated, policy_id, result,
  audit, approval_id, tool_id, tool_executed_at, tool_result, run_state, attempts, last_error,
  tool_started_at`;

function executionValues(execution: Execution, org: OrganizationId): unknown[] {
  return [
    org,
    execution.id,
    execution.agentId,
    execution.agentName,
    execution.action,
    execution.target,
    execution.status,
    execution.risk,
    execution.durationMs,
    execution.cost,
    execution.timestamp,
    stringify(execution.input),
    execution.decision,
    execution.decisionReason,
    execution.policyEvaluated,
    execution.policyId,
    execution.result,
    stringify(execution.audit),
    execution.approvalId ?? null,
    execution.toolId ?? null,
    execution.toolExecutedAt ?? null,
    execution.toolResult ? stringify(execution.toolResult) : null,
    execution.runState ?? "pending",
    execution.attempts ?? 0,
    execution.lastError ?? null,
    execution.toolStartedAt ?? null,
  ];
}

interface ApprovalRow {
  id: string;
  execution_id: string | null;
  agent_id: string;
  agent_name: string;
  title: string;
  summary: string;
  requested_value: string;
  policy_id: string;
  policy_name: string;
  policy_limit: string;
  risk: string;
  status: string;
  requested_at: unknown;
  expires_at: unknown;
  resolved_by: string | null;
  resolved_at: unknown;
  context: string;
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    title: row.title,
    summary: row.summary,
    requestedValue: row.requested_value,
    policyId: row.policy_id,
    policyName: row.policy_name,
    policyLimit: row.policy_limit,
    risk: row.risk as RiskLevel,
    status: row.status as ApprovalStatus,
    requestedAt: iso(row.requested_at),
    expiresAt: isoOrNull(row.expires_at),
    resolvedBy: row.resolved_by ?? undefined,
    resolvedAt: isoOrNull(row.resolved_at),
    context: parse<Approval["context"]>(row.context, []),
  };
}

const APPROVAL_COLUMNS = `id, execution_id, agent_id, agent_name, title, summary, requested_value,
  policy_id, policy_name, policy_limit, risk, status, requested_at, expires_at, resolved_by,
  resolved_at, context`;

function approvalValues(approval: Approval, org: OrganizationId): unknown[] {
  return [
    org,
    approval.id,
    approval.executionId ?? null,
    approval.agentId,
    approval.agentName,
    approval.title,
    approval.summary,
    approval.requestedValue,
    approval.policyId,
    approval.policyName,
    approval.policyLimit,
    approval.risk,
    approval.status,
    approval.requestedAt,
    // Stamped at the single write boundary, exactly as the SQLite mapper does, so a
    // row without a deadline cannot be created by any construction site.
    approval.expiresAt ?? approvalDeadline(approval.requestedAt),
    approval.resolvedBy ?? null,
    approval.resolvedAt ?? null,
    stringify(approval.context),
  ];
}

interface IntegrationRow {
  id: string;
  name: string;
  category: string;
  description: string;
  connected: boolean;
  scopes: string;
  connected_at: unknown;
  agents_using: number;
}

function toIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id,
    name: row.name,
    category: row.category as Integration["category"],
    description: row.description,
    connected: row.connected,
    scopes: parse<string[]>(row.scopes, []),
    connectedAt: isoOrNull(row.connected_at) ?? undefined,
    agentsUsing: numberOf(row.agents_using),
  };
}

/* --------------------------------- quotas --------------------------------- */

/**
 * The PostgreSQL sibling `server/quotas.ts` said would be needed.
 *
 * Only the counting moved: the ceiling comes from `quotaLimitsFor`, the mode from
 * `quotaModeNow`, and the refusal is the same `QuotaExceededError` the routes
 * already render as 409/429. `used + 1` is compared against the limit for the same
 * reason as on SQLite — the caller has not written yet.
 *
 * Runs on the transaction executor when there is one, so the count and the write it
 * guards are one unit and two concurrent creations at the ceiling cannot both see
 * `used = limit - 1`.
 */
async function assertWithinQuotaPg(
  sql: SqlExecutor,
  org: OrganizationId,
  counter: QuotaCounter,
  at: Date = new Date(),
): Promise<void> {
  const limit = quotaLimitsFor(org)[counter];
  /*
   * Le relais et la voie directe partagent le plafond d'exécutions : le même verrou par
   * locataire que `ActionAuthorityStore.consumeGrant`, pris dans la transaction de
   * l'appelant, pour que les deux voies ne comptent jamais en même temps.
   */
  if (counter === "executions" && sql.dialect === "postgres") {
    await sql.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, [executionQuotaLockKey(org)]);
  }
  /*
   * Les exécutions : le COMPTEUR de la période (`server/sql/execution-quota.ts`), lu sous
   * le verrou, et incrémenté plus bas si l'écriture est permise — dans la transaction de
   * l'appelant, qui insère l'exécution juste après. Compter à chaque fois coûtait ~1 s à un
   * million d'actions dans le mois (journal §5.34).
   */
  const periodStart = periodStartFor("executions", at);
  const used = counter === "executions" ? await periodUsage(sql, org, periodStart) : await currentUsagePg(sql, org, counter, at);
  const wouldBe = used + 1;
  const exceeded = wouldBe > limit;

  await recordUsagePg(sql, org, counter, wouldBe, exceeded, at);

  if (exceeded && quotaModeNow() !== "observe") {
    throw new QuotaExceededError({ counter, limit, used, resetAt: periodResetFor(counter, at) });
  }
  if (exceeded) {
    console.warn(
      `[quotas] ${org} is over its ${counter} quota (${wouldBe} > ${limit}) but ` +
        `OATHRION_QUOTA_MODE=observe, so the write was allowed.`,
    );
  }
  if (counter === "executions") await incrementPeriodUsage(sql, org, periodStart);
}

async function currentUsagePg(
  sql: SqlExecutor,
  org: OrganizationId,
  counter: QuotaCounter,
  at: Date,
): Promise<number> {
  if (counter === "agents") {
    const rows = await sql.all<{ n: unknown }>(
      `SELECT count(*) AS n FROM agents WHERE organization_id = ?`,
      [org],
    );
    return numberOf(rows[0]?.n);
  }
  if (counter === "policies") {
    const rows = await sql.all<{ n: unknown }>(
      `SELECT count(*) AS n FROM policies WHERE organization_id = ?`,
      [org],
    );
    return numberOf(rows[0]?.n);
  }
  /* Les deux voies, comme `currentUsage` côté SQLite : le relais (`executions`) et la voie directe (autorisations consommées). */
  /* Le compteur s'il existe, sinon un comptage — sans rien écrire : c'est un rapport. */
  return reportedUsage(sql, org, periodStartFor("executions", at));
}

/**
 * Advisory high-water mark, upserted.
 *
 * `GREATEST` rather than SQLite's two-argument `max`, which is the one dialect
 * difference in this file. Never throws for the reason `recordUsage` does not: a
 * failed measurement must not fail the request being measured.
 *
 * Difference from the SQLite path, recorded rather than hidden: a refusal's
 * measurement is written inside the transaction that is about to roll back, so it
 * is lost. On SQLite that case is deferred to `setImmediate`. Doing the same here
 * would need a second connection outside the transaction; the counter is advisory
 * (enforcement always re-derives an exact `count(*)`), so this is a known gap in a
 * statistic, never in a decision. See PHASE-11-REPORT.md §16.
 */
async function recordUsagePg(
  sql: SqlExecutor,
  org: OrganizationId,
  counter: QuotaCounter,
  observed: number,
  refused: boolean,
  at: Date,
): Promise<void> {
  try {
    await sql.run(
      `INSERT INTO usage_counters
         (organization_id, counter, period_start, observed_max, refusals, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, counter, period_start) DO UPDATE
         SET observed_max = GREATEST(usage_counters.observed_max, EXCLUDED.observed_max),
             refusals = usage_counters.refusals + EXCLUDED.refusals,
             updated_at = EXCLUDED.updated_at`,
      [org, counter, periodStartFor(counter, at), observed, refused ? 1 : 0, at.toISOString()],
    );
  } catch (error) {
    console.error(
      `[quotas] could not record usage for ${counter} in ${org}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * The quota report, on PostgreSQL.
 *
 * ## Why this had to be written
 *
 * Phase 11 gave this file an enforcement sibling for every counting path —
 * `assertWithinQuotaPg`, `currentUsagePg`, `recordUsagePg` — but no sibling for
 * *reading the report back*. `GET /api/usage` kept calling `usageReport()` in
 * server/quotas.ts, which issues Drizzle statements against the SQLite handle. On a
 * PostgreSQL deployment that handle is a stub that throws by design ("this is not a
 * fallback path"), so the route answered 500 on every request.
 *
 * It went unnoticed because no harness ever drove the shipped bundle with the whole
 * PostgreSQL set: the smoke test booted it on a temporary SQLite file. Phase 12.2
 * moved that harness onto PostgreSQL, and the 500 surfaced on the first run.
 *
 * Limits, labels, periods and the kind of each counter come from `@shared/quotas` and
 * `quotaLimitsFor`, exactly as the SQLite path does, so the two engines cannot report
 * different ceilings for the same configuration.
 */
export async function usageReportPg(
  sql: SqlExecutor,
  org: OrganizationId,
  at: Date = new Date(),
): Promise<QuotaUsage[]> {
  const limits = quotaLimitsFor(org);
  return Promise.all(
    QUOTA_COUNTER_NAMES.map(async (counter) => {
      const used = await currentUsagePg(sql, org, counter, at);
      return {
        counter,
        label: QUOTA_LABELS[counter],
        kind: quotaKind(counter),
        used,
        limit: limits[counter],
        remaining: Math.max(limits[counter] - used, 0),
        resetAt: periodResetFor(counter, at),
        refusals: await refusalsForPg(sql, org, counter, at),
      };
    }),
  );
}

/** The advisory refusal count for one counter in the current period. */
async function refusalsForPg(
  sql: SqlExecutor,
  org: OrganizationId,
  counter: QuotaCounter,
  at: Date,
): Promise<number> {
  const rows = await sql.all<{ refusals: unknown }>(
    `SELECT refusals FROM usage_counters
      WHERE organization_id = ? AND counter = ? AND period_start = ?`,
    [org, counter, periodStartFor(counter, at)],
  );
  return numberOf(rows[0]?.refusals);
}

/* ------------------------------- repositories ----------------------------- */

class PostgresAgentRepository implements AgentRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
  ) {}

  async list(): Promise<Agent[]> {
    const rows = await this.sql.all<AgentRow>(
      `SELECT ${AGENT_COLUMNS} FROM agents WHERE organization_id = ?`,
      [this.org],
    );
    return rows.map(toAgent);
  }

  async findById(id: string): Promise<Agent | undefined> {
    const rows = await this.sql.all<AgentRow>(
      `SELECT ${AGENT_COLUMNS} FROM agents WHERE organization_id = ? AND id = ?`,
      [this.org, id],
    );
    return rows[0] ? toAgent(rows[0]) : undefined;
  }

  async create(agent: Agent): Promise<Agent> {
    await this.sql.transaction(async (tx) => {
      await assertWithinQuotaPg(tx, this.org, "agents");
      await tx.run(
        `INSERT INTO agents (organization_id, ${AGENT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        agentValues(agent, this.org),
      );
    });
    return agent;
  }

  async update(id: string, patch: Partial<Agent>): Promise<Agent | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id };
    await this.sql.run(
      `UPDATE agents SET
         name = ?, description = ?, provider = ?, model = ?, status = ?, current_task = ?,
         owner = ?, created_at = ?, executions_24h = ?, success_rate = ?, cost_24h = ?,
         cost_month = ?, risk_level = ?, permissions = ?, mandate = ?, policy_ids = ?, tags = ?
       WHERE organization_id = ? AND id = ?`,
      [...agentValues(next, this.org).slice(2), this.org, id],
    );
    return next;
  }
}

class PostgresPolicyRepository implements PolicyRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
  ) {}

  async list(): Promise<Policy[]> {
    const rows = await this.sql.all<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM policies WHERE organization_id = ?`,
      [this.org],
    );
    return rows.map(toPolicy);
  }

  async findById(id: string): Promise<Policy | undefined> {
    const rows = await this.sql.all<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM policies WHERE organization_id = ? AND id = ?`,
      [this.org, id],
    );
    return rows[0] ? toPolicy(rows[0]) : undefined;
  }

  async create(policy: Policy): Promise<Policy> {
    await this.sql.transaction(async (tx) => {
      await assertWithinQuotaPg(tx, this.org, "policies");
      await tx.run(
        `INSERT INTO policies (organization_id, ${POLICY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        policyValues(policy, this.org),
      );
    });
    return policy;
  }

  async update(id: string, patch: Partial<Policy>): Promise<Policy | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id };
    await this.sql.run(
      `UPDATE policies SET
         name = ?, description = ?, rule = ?, scope = ?, applies_to = ?, effect = ?, status = ?,
         triggered_count = ?, updated_at = ?, type = ?, condition = ?, action = ?,
         applies_to_agent_ids = ?, risk = ?, priority = ?
       WHERE organization_id = ? AND id = ?`,
      [...policyValues(next, this.org).slice(2), this.org, id],
    );
    return next;
  }

  async incrementTriggered(id: string): Promise<void> {
    await this.sql.run(
      `UPDATE policies SET triggered_count = triggered_count + 1
        WHERE organization_id = ? AND id = ?`,
      [this.org, id],
    );
  }
}

class PostgresExecutionRepository implements ExecutionRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
  ) {}

  async list(limit = 200): Promise<Execution[]> {
    const rows = await this.sql.all<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM executions
        WHERE organization_id = ? ORDER BY "timestamp" DESC LIMIT ?`,
      [this.org, limit],
    );
    return rows.map(toExecution);
  }

  async findById(id: string): Promise<Execution | undefined> {
    const rows = await this.sql.all<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE organization_id = ? AND id = ?`,
      [this.org, id],
    );
    return rows[0] ? toExecution(rows[0]) : undefined;
  }

  /** Le même début exact que la voie SQLite (`left`, pas `LIKE`). */
  async actionActivity(prefix: string): Promise<{ count: number; latest: Execution | undefined }> {
    const counted = await this.sql.all<{ n: unknown }>(
      `SELECT count(*) AS n FROM executions WHERE organization_id = ? AND left(action, ?) = ?`,
      [this.org, prefix.length, prefix],
    );
    const latest = await this.sql.all<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE organization_id = ? AND left(action, ?) = ? ORDER BY timestamp DESC LIMIT 1`,
      [this.org, prefix.length, prefix],
    );
    return { count: numberOf(counted[0]?.n), latest: latest[0] ? toExecution(latest[0]) : undefined };
  }

  async create(execution: Execution): Promise<Execution> {
    const chained: Execution = {
      ...execution,
      audit: linkAuditEntries(this.org, execution.id, [], execution.audit),
    };
    await this.sql.transaction(async (tx) => {
      await assertWithinQuotaPg(tx, this.org, "executions");
      await insertExecution(tx, this.org, chained);
    });
    return chained;
  }

  async update(id: string, patch: Partial<Execution>): Promise<Execution | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id };
    await this.sql.run(
      `UPDATE executions SET
         agent_id = ?, agent_name = ?, action = ?, target = ?, status = ?, risk = ?,
         duration_ms = ?, cost = ?, "timestamp" = ?, input = ?, decision = ?, decision_reason = ?,
         policy_evaluated = ?, policy_id = ?, result = ?, audit = ?, approval_id = ?, tool_id = ?,
         tool_executed_at = ?, tool_result = ?, run_state = ?, attempts = ?, last_error = ?,
         tool_started_at = ?
       WHERE organization_id = ? AND id = ?`,
      [...executionValues(next, this.org).slice(2), this.org, id],
    );
    return next;
  }

  /**
   * Append to the audit trail atomically.
   *
   * `SELECT ... FOR UPDATE` inside the transaction is what SQLite got from being
   * synchronous and serialising writers: it takes a row lock, so a second appender
   * waits rather than reading the same base trail and overwriting the first one's
   * entries. The chain is computed from the STORED trail inside the lock, never from
   * a caller's snapshot and never from a caller-supplied `prevHash`.
   */
  async appendAudit(id: string, entries: AuditEntry[]): Promise<Execution | undefined> {
    if (entries.length === 0) return this.findById(id);
    const org = this.org;
    const appended = await this.sql.transaction(async (tx) => {
      const rows = await tx.all<{ audit: string | null }>(
        `SELECT audit FROM executions WHERE organization_id = ? AND id = ? FOR UPDATE`,
        [org, id],
      );
      const row = rows[0];
      if (!row) return false;
      const current = parse<AuditEntry[]>(row.audit, []);
      const linked = linkAuditEntries(org, id, current, entries);
      await tx.run(`UPDATE executions SET audit = ? WHERE organization_id = ? AND id = ?`, [
        stringify([...current, ...linked]),
        org,
        id,
      ]);
      return true;
    });
    return appended ? this.findById(id) : undefined;
  }

  async claimToolRun(
    id: string,
    toolId: string,
    at: string,
    staleBefore?: string,
    maxAttempts?: number,
  ): Promise<boolean> {
    const changed = await this.sql.run(
      `UPDATE executions
          SET run_state = 'running', tool_id = ?, tool_started_at = ?, attempts = attempts + 1
        WHERE organization_id = ?
          AND id = ?
          AND attempts < ?
          AND (
                run_state IN ('pending', 'failed')
             OR (run_state = 'running' AND (tool_started_at IS NULL OR tool_started_at < ?))
          )`,
      [toolId, at, this.org, id, maxAttempts ?? MAX_TOOL_ATTEMPTS, staleBefore ?? at],
    );
    return changed === 1;
  }

  async completeToolRun(
    id: string,
    outcome:
      | { ok: true; at: string; result: Record<string, unknown> | null }
      | { ok: false; at: string; error: string },
  ): Promise<boolean> {
    const changed = outcome.ok
      ? await this.sql.run(
          `UPDATE executions
              SET run_state = 'succeeded', tool_executed_at = ?, tool_result = ?, last_error = NULL
            WHERE organization_id = ? AND id = ? AND run_state = 'running'`,
          [outcome.at, outcome.result ? JSON.stringify(outcome.result) : null, this.org, id],
        )
      : await this.sql.run(
          `UPDATE executions SET run_state = 'failed', last_error = ?
            WHERE organization_id = ? AND id = ? AND run_state = 'running'`,
          [outcome.error, this.org, id],
        );
    return changed === 1;
  }

  /**
   * Les trois ecritures de cloture, en une transaction. Voir `types.ts` pour le pourquoi.
   *
   * `FOR UPDATE` ET `run_state = 'running'` dans la meme selection : le verrou de ligne
   * empeche deux clotures concurrentes de lire la meme trace, et la condition d'etat fait
   * que la seconde ne trouve rien du tout. Les deux serrures sont necessaires — la
   * premiere protege la chaine d'audit, la seconde la propriete exactement-une-fois.
   */
  async settleToolRun(
    id: string,
    outcome: ToolOutcome,
    entries: AuditEntry[],
    patch: Partial<Execution>,
  ): Promise<Execution | undefined> {
    const org = this.org;
    return this.sql.transaction(async (tx) => {
      const rows = await tx.all<ExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM executions
          WHERE organization_id = ? AND id = ? AND run_state = 'running' FOR UPDATE`,
        [org, id],
      );
      const row = rows[0];
      if (!row) return undefined;
      const next = settledExecution(org, toExecution(row), outcome, entries, patch);
      await tx.run(
        `UPDATE executions SET
           agent_id = ?, agent_name = ?, action = ?, target = ?, status = ?, risk = ?,
           duration_ms = ?, cost = ?, "timestamp" = ?, input = ?, decision = ?, decision_reason = ?,
           policy_evaluated = ?, policy_id = ?, result = ?, audit = ?, approval_id = ?, tool_id = ?,
           tool_executed_at = ?, tool_result = ?, run_state = ?, attempts = ?, last_error = ?,
           tool_started_at = ?
         WHERE organization_id = ? AND id = ?`,
        [...executionValues(next, org).slice(2), org, id],
      );
      return next;
    });
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    await this.sql.run(
      `UPDATE executions SET run_state = 'skipped', last_error = ?
        WHERE organization_id = ? AND id = ? AND run_state IN ('pending', 'failed')`,
      [reason, this.org, id],
    );
  }

  async dailySpend(agentId: string, since: string): Promise<number> {
    return dailySpendPg(this.sql, this.org, agentId, since);
  }

  /** Le même `GROUP BY` que la voie SQLite, et le même pliage. Voir le contrat. */
  async statusCounts(): Promise<ExecutionStatusCounts> {
    const rows = await this.sql.all<{ status: string; n: unknown }>(
      `SELECT status, count(*) AS n FROM executions WHERE organization_id = ? GROUP BY status`,
      [this.org],
    );
    const counts: ExecutionStatusCounts = {
      total: 0, allowed: 0, blocked: 0, pending: 0, failed: 0,
    };
    for (const row of rows) {
      const n = numberOf(row.n);
      counts.total += n;
      if (row.status === "allowed") counts.allowed += n;
      else if (row.status === "blocked") counts.blocked += n;
      else if (row.status === "pending") counts.pending += n;
      else if (row.status === "failed") counts.failed += n;
    }
    return counts;
  }
}

class PostgresApprovalRepository implements ApprovalRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
  ) {}

  async list(resolvedLimit = DEFAULT_RESOLVED_APPROVAL_LIMIT): Promise<Approval[]> {
    // Two queries, for the reason given on the interface: pending is returned in
    // full and only the resolved history is capped.
    const pending = await this.sql.all<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
        WHERE organization_id = ? AND status = 'pending' ORDER BY requested_at DESC`,
      [this.org],
    );
    const resolved = await this.sql.all<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
        WHERE organization_id = ? AND status <> 'pending'
        ORDER BY requested_at DESC LIMIT ?`,
      [this.org, resolvedLimit],
    );
    return [...pending, ...resolved]
      .map(toApproval)
      .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
  }

  async findById(id: string): Promise<Approval | undefined> {
    const rows = await this.sql.all<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE organization_id = ? AND id = ?`,
      [this.org, id],
    );
    return rows[0] ? toApproval(rows[0]) : undefined;
  }

  async create(approval: Approval): Promise<Approval> {
    await this.sql.run(
      `INSERT INTO approvals (organization_id, ${APPROVAL_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      approvalValues(approval, this.org),
    );
    return approval;
  }

  async findByExecutionId(executionId: string): Promise<Approval | undefined> {
    const rows = await this.sql.all<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
        WHERE organization_id = ? AND execution_id = ?
        ORDER BY requested_at DESC LIMIT 1`,
      [this.org, executionId],
    );
    return rows[0] ? toApproval(rows[0]) : undefined;
  }

  async findGatingExpiries(executionIds: string[]): Promise<Map<string, string | null>> {
    const expiries = new Map<string, string | null>();
    if (executionIds.length === 0) return expiries;
    const unique = [...new Set(executionIds)];
    for (let at = 0; at < unique.length; at += 400) {
      const chunk = unique.slice(at, at + 400);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await this.sql.all<{ execution_id: string | null; expires_at: unknown }>(
        `SELECT execution_id, expires_at FROM approvals
          WHERE organization_id = ? AND execution_id IN (${placeholders})
          ORDER BY requested_at DESC`,
        [this.org, ...chunk],
      );
      for (const row of rows) {
        if (row.execution_id === null) continue;
        if (expiries.has(row.execution_id)) continue;
        expiries.set(row.execution_id, isoOrNull(row.expires_at));
      }
    }
    return expiries;
  }

  async expire(
    id: string,
    now: string = new Date().toISOString(),
  ): Promise<{ approval: Approval; claimed: boolean } | undefined> {
    const changed = await this.sql.run(
      `UPDATE approvals SET status = 'expired', resolved_at = ?
        WHERE organization_id = ? AND id = ? AND status = 'pending'
          AND (expires_at IS NULL OR expires_at <= ?)`,
      [now, this.org, id, now],
    );
    const approval = await this.findById(id);
    if (!approval) return undefined;
    return { approval, claimed: changed === 1 };
  }

  async expirePending(now: string = new Date().toISOString()): Promise<string[]> {
    const due = await this.sql.all<{ id: string }>(
      `SELECT id FROM approvals
        WHERE organization_id = ? AND status = 'pending'
          AND (expires_at IS NULL OR expires_at <= ?)`,
      [this.org, now],
    );
    const expired: string[] = [];
    for (const row of due) {
      const result = await this.expire(row.id, now);
      if (result?.claimed) expired.push(row.id);
    }
    return expired;
  }

  /**
   * Atomic, conditional resolution — the same four conditions as the SQLite
   * statement, in the same single UPDATE: tenant, id, still pending, and a deadline
   * that exists and has not passed. A NULL deadline is refused rather than read as
   * "no limit", and the deadline is checked inside the statement so there is no
   * time-of-check/time-of-use window.
   */
  async resolve(
    id: string,
    status: Exclude<ApprovalStatus, "pending" | "expired">,
    resolvedBy: string,
    now: string = new Date().toISOString(),
  ): Promise<{ approval: Approval; claimed: boolean } | undefined> {
    const changed = await this.sql.run(
      `UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = ?
        WHERE organization_id = ? AND id = ? AND status = 'pending'
          AND expires_at IS NOT NULL AND expires_at > ?`,
      [status, resolvedBy, now, this.org, id, now],
    );
    const approval = await this.findById(id);
    if (!approval) return undefined;
    return { approval, claimed: changed === 1 };
  }
}

class PostgresIntegrationRepository implements IntegrationRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
  ) {}

  async list(): Promise<Integration[]> {
    const rows = await this.sql.all<IntegrationRow>(
      `SELECT id, name, category, description, connected, scopes, connected_at, agents_using
         FROM integrations WHERE organization_id = ?`,
      [this.org],
    );
    return rows.map(toIntegration);
  }

  async toggle(id: string): Promise<Integration | undefined> {
    const rows = await this.sql.all<IntegrationRow>(
      `SELECT id, name, category, description, connected, scopes, connected_at, agents_using
         FROM integrations WHERE organization_id = ? AND id = ?`,
      [this.org, id],
    );
    const row = rows[0];
    if (!row) return undefined;
    const connected = !row.connected;
    const connectedAt = connected ? new Date().toISOString() : null;
    await this.sql.run(
      `UPDATE integrations SET connected = ?, connected_at = ?
        WHERE organization_id = ? AND id = ?`,
      [connected, connectedAt, this.org, id],
    );
    return toIntegration({ ...row, connected, connected_at: connectedAt });
  }
}

/* ---------------------------- shared statements --------------------------- */

async function insertExecution(
  sql: SqlExecutor,
  org: OrganizationId,
  execution: Execution,
): Promise<void> {
  await sql.run(
    `INSERT INTO executions (organization_id, ${EXECUTION_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    executionValues(execution, org),
  );
}

async function dailySpendPg(
  sql: SqlExecutor,
  org: OrganizationId,
  agentId: string,
  since: string,
): Promise<number> {
  const rows = await sql.all<{ total: unknown }>(
    `SELECT coalesce(sum(cost), 0) AS total FROM executions
      WHERE organization_id = ? AND agent_id = ? AND status = 'allowed' AND "timestamp" >= ?`,
    [org, agentId, since],
  );
  return numberOf(rows[0]?.total);
}

/* --------------------------------- factory -------------------------------- */

const byOrganization = new Map<string, Repositories>();

/**
 * The PostgreSQL repository set for one tenant.
 *
 * Cached per organization for the same reason as the SQLite factory: `routes.ts`
 * resolves a set on every request. The instances hold only the executor and the
 * tenant, so sharing them is safe.
 */
export function postgresRepositoriesFor(
  sql: SqlExecutor,
  organizationId: OrganizationId,
): Repositories {
  const key = `${organizationId}`;
  const cached = byOrganization.get(key);
  if (cached) return cached;

  const org = organizationId;
  const built: Repositories = {
    /**
     * Execution + Approval in one transaction. Either both land or neither does,
     * so no orphan Approval can point at a missing Execution.
     */
    async createExecutionWithApproval(execution: Execution, approval: Approval | null) {
      const stored = await sql.transaction(async (tx) => {
        await assertWithinQuotaPg(tx, org, "executions");
        const chained: Execution = {
          ...execution,
          audit: linkAuditEntries(org, execution.id, [], execution.audit),
        };
        await insertExecution(tx, org, chained);
        if (approval) {
          await tx.run(
            `INSERT INTO approvals (organization_id, ${APPROVAL_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            approvalValues(approval, org),
          );
        }
        return chained;
      });
      return { execution: stored, approval };
    },

    /**
     * The daily-spend TOCTOU, closed on PostgreSQL.
     *
     * SQLite got serialisation for free (one writer at a time). Here the spend is
     * summed inside the transaction *after* taking a per-agent advisory lock, so two
     * concurrent decisions for the same agent cannot both read the total as it stood
     * before either wrote. `pg_advisory_xact_lock` is released by the commit or the
     * rollback, so a failing build cannot strand the lock, and it is keyed by
     * tenant+agent so decisions for different agents still run in parallel.
     */
    async decideAndPersist(
      agentId: string,
      since: string | null,
      build: (dailySpend: number) => { execution: Execution; approval: Approval | null },
    ) {
      return sql.transaction(async (tx) => {
        /*
         * LE VERROU ET LA DÉPENSE DANS LE MÊME ALLER-RETOUR.
         *
         * C'étaient deux requêtes à la suite, et chaque aller-retour vers PostgreSQL
         * coûte environ 0,9 ms quand la base est dans un conteneur voisin — mesuré, pas
         * supposé. Le verrou consultatif n'a aucune sémantique à répliquer : c'est un
         * appel de fonction dont on ne lit pas le résultat, donc le fusionner avec la
         * lecture qu'il protège ne change rien à ce qui est verrouillé ni à quand.
         *
         * `pg_advisory_xact_lock` est évalué AVANT la sous-requête dans le même ordre
         * qu'avant — la cible du verrou est la paire (organisation, agent), et la lecture
         * de dépense porte sur cette même paire.
         *
         * Le contrôle de quota reste une requête séparée, délibérément : il lit un
         * compteur, en écrit un, et refuse. Le replier ici demanderait de recopier son
         * SQL, et une seconde copie d'une règle de refus est une copie qui prend du
         * retard.
         */
        /* Sans budget journalier (`since` nul), le verrou seul : la somme n'est pas lue (§5.76). */
        const spendRows =
          since === null
            ? await tx.all<{ total: unknown }>(`SELECT pg_advisory_xact_lock(hashtext(?)) AS lock_taken, 0 AS total`, [
                `placet:spend:${org}:${agentId}`,
              ])
            : await tx.all<{ total: unknown }>(
                `SELECT pg_advisory_xact_lock(hashtext(?)) AS lock_taken,
                  (SELECT coalesce(sum(cost), 0) FROM executions
                    WHERE organization_id = ? AND agent_id = ? AND status = 'allowed'
                      AND "timestamp" >= ?) AS total`,
                [`placet:spend:${org}:${agentId}`, org, agentId, since],
              );
        await assertWithinQuotaPg(tx, org, "executions");
        const dailySpend = numberOf(spendRows[0]?.total);
        const { execution, approval } = build(dailySpend);
        const chained: Execution = {
          ...execution,
          audit: linkAuditEntries(org, execution.id, [], execution.audit),
        };
        await insertExecution(tx, org, chained);
        if (approval) {
          await tx.run(
            `INSERT INTO approvals (organization_id, ${APPROVAL_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            approvalValues(approval, org),
          );
        }
        // The trigger counter belongs to the same commit as the row it counts, and is
        // tenant-scoped so a decision cannot increment another tenant's policy.
        if (execution.policyId) {
          await tx.run(
            `UPDATE policies SET triggered_count = triggered_count + 1
              WHERE organization_id = ? AND id = ?`,
            [org, execution.policyId],
          );
        }
        return { execution: chained, approval };
      });
    },

    /**
     * Liveness. Touches a real table rather than `SELECT 1`, so a database whose
     * schema is gone reports unhealthy. Never throws and never returns the error:
     * the message would carry the connection string.
     *
     * `LIMIT 1`, not `count(*)`: a count reads every execution of every tenant, so the
     * probe grew with the table it was only meant to touch.
     */
    async ping() {
      try {
        await sql.all(`SELECT 1 AS ok FROM executions LIMIT 1`);
        return true;
      } catch (error) {
        console.error("[health] database check failed:", error);
        return false;
      }
    },
    agents: new PostgresAgentRepository(sql, org),
    policies: new PostgresPolicyRepository(sql, org),
    executions: new PostgresExecutionRepository(sql, org),
    approvals: new PostgresApprovalRepository(sql, org),
    integrations: new PostgresIntegrationRepository(sql, org),
  };

  byOrganization.set(key, built);
  return built;
}

/** Test-only: drops the instance cache so a suite can rebuild against a fresh pool. */
export function resetPostgresRepositoryCache(): void {
  byOrganization.clear();
}

/**
 * Exposed for the parity suite, which needs a receipt-shaped unique id without
 * importing a UUID library into the test itself.
 */
export const newId = (): string => randomUUID();
