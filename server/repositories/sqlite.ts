/**
 * SQLite implementation of the Oathrion repositories (Drizzle + better-sqlite3).
 *
 * All JSON-in-TEXT (de)serialisation lives here. Callers exchange fully typed
 * domain objects from `@shared/types` and never see a raw row.
 */

import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db, rawDb } from "../db";
import { linkAuditEntries } from "../audit-chain";
import { DEFAULT_RESOLVED_APPROVAL_LIMIT, MAX_TOOL_ATTEMPTS } from "../limits";
import { approvalDeadline } from "@shared/approvals/ttl";
import {
  agentRows,
  approvalRows,
  executionRows,
  integrationRows,
  policyRows,
} from "@shared/schema";
import { EMPTY_MANDATE } from "@shared/policy/mandate";
import type { OrganizationId } from "@shared/tenancy";
import { assertWithinQuota } from "../quotas";
import type { AgentMandate } from "@shared/policy/mandate";
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
import { settledExecution, type ToolOutcome } from "./settle";

/* ----------------------------- JSON helpers ----------------------------- */

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const stringify = (value: unknown): string => JSON.stringify(value ?? null);

/* ------------------------------- Mappers -------------------------------- */

type AgentRow = typeof agentRows.$inferSelect;
type PolicyRow = typeof policyRows.$inferSelect;
type ExecutionRow = typeof executionRows.$inferSelect;
type ApprovalRow = typeof approvalRows.$inferSelect;
type IntegrationRow = typeof integrationRows.$inferSelect;

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider as Agent["provider"],
    model: row.model,
    status: row.status as Agent["status"],
    currentTask: row.currentTask,
    owner: row.owner,
    createdAt: row.createdAt,
    executions24h: row.executions24h,
    successRate: row.successRate,
    cost24h: row.cost24h,
    costMonth: row.costMonth,
    riskLevel: row.riskLevel as RiskLevel,
    permissions: parse<Permission[]>(row.permissions, []),
    mandate: parse<AgentMandate>(row.mandate, EMPTY_MANDATE),
    policyIds: parse<string[]>(row.policyIds, []),
    tags: parse<string[]>(row.tags, []),
  };
}

/*
 * The organization is a parameter, never a field on the domain object. A domain
 * object arrives from a request body, so if it carried its own tenant the caller
 * could choose one — which is the exact attack this layer exists to stop.
 */
function fromAgent(agent: Agent, organizationId: OrganizationId): AgentRow {
  return {
    organizationId,
    id: agent.id,
    name: agent.name,
    description: agent.description,
    provider: agent.provider,
    model: agent.model,
    status: agent.status,
    currentTask: agent.currentTask,
    owner: agent.owner,
    createdAt: agent.createdAt,
    executions24h: agent.executions24h,
    successRate: agent.successRate,
    cost24h: agent.cost24h,
    costMonth: agent.costMonth,
    riskLevel: agent.riskLevel,
    permissions: stringify(agent.permissions),
    mandate: stringify(agent.mandate),
    policyIds: stringify(agent.policyIds),
    tags: stringify(agent.tags),
  };
}

function toPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rule: row.rule,
    scope: row.scope as Policy["scope"],
    appliesTo: row.appliesTo,
    effect: row.effect as Policy["effect"],
    status: row.status as Policy["status"],
    triggeredCount: row.triggeredCount,
    updatedAt: row.updatedAt,
    type: (row.type as PolicyType | null) ?? undefined,
    condition: row.condition ? parse<PolicyCondition | undefined>(row.condition, undefined) : undefined,
    action: (row.action as PolicyAction | null) ?? undefined,
    appliesToAgentIds: row.appliesToAgentIds
      ? parse<string[] | null>(row.appliesToAgentIds, null)
      : null,
    risk: (row.risk as RiskLevel | null) ?? undefined,
    priority: row.priority,
  };
}

/*
 * The organization is a parameter, never a field on the domain object. A domain
 * object arrives from a request body, so if it carried its own tenant the caller
 * could choose one — which is the exact attack this layer exists to stop.
 */
function fromPolicy(policy: Policy, organizationId: OrganizationId): PolicyRow {
  return {
    organizationId,
    id: policy.id,
    name: policy.name,
    description: policy.description,
    rule: policy.rule,
    scope: policy.scope,
    appliesTo: policy.appliesTo,
    effect: policy.effect,
    status: policy.status,
    triggeredCount: policy.triggeredCount,
    updatedAt: policy.updatedAt,
    type: policy.type ?? null,
    condition: policy.condition ? stringify(policy.condition) : null,
    action: policy.action ?? null,
    appliesToAgentIds: policy.appliesToAgentIds ? stringify(policy.appliesToAgentIds) : null,
    risk: policy.risk ?? null,
    priority: policy.priority ?? 0,
  };
}

function toExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    action: row.action,
    target: row.target,
    status: row.status as Execution["status"],
    risk: row.risk as RiskLevel,
    durationMs: row.durationMs,
    cost: row.cost,
    timestamp: row.timestamp,
    input: parse<Execution["input"]>(row.input, {}),
    decision: row.decision as Execution["decision"],
    decisionReason: row.decisionReason,
    policyEvaluated: row.policyEvaluated,
    policyId: row.policyId,
    result: row.result,
    audit: parse<AuditEntry[]>(row.audit, []),
    approvalId: row.approvalId,
    toolId: row.toolId,
    toolExecutedAt: row.toolExecutedAt,
    toolResult: row.toolResult ? parse<Record<string, unknown>>(row.toolResult, {}) : null,
    runState: (row.runState ?? "pending") as Execution["runState"],
    attempts: row.attempts ?? 0,
    lastError: row.lastError,
    toolStartedAt: row.toolStartedAt,
  };
}

/*
 * The organization is a parameter, never a field on the domain object. A domain
 * object arrives from a request body, so if it carried its own tenant the caller
 * could choose one — which is the exact attack this layer exists to stop.
 */
function fromExecution(execution: Execution, organizationId: OrganizationId): ExecutionRow {
  return {
    organizationId,
    id: execution.id,
    agentId: execution.agentId,
    agentName: execution.agentName,
    action: execution.action,
    target: execution.target,
    status: execution.status,
    risk: execution.risk,
    durationMs: execution.durationMs,
    cost: execution.cost,
    timestamp: execution.timestamp,
    input: stringify(execution.input),
    decision: execution.decision,
    decisionReason: execution.decisionReason,
    policyEvaluated: execution.policyEvaluated,
    policyId: execution.policyId,
    result: execution.result,
    audit: stringify(execution.audit),
    approvalId: execution.approvalId ?? null,
    toolId: execution.toolId ?? null,
    toolExecutedAt: execution.toolExecutedAt ?? null,
    toolResult: execution.toolResult ? stringify(execution.toolResult) : null,
    runState: execution.runState ?? "pending",
    attempts: execution.attempts ?? 0,
    lastError: execution.lastError ?? null,
    toolStartedAt: execution.toolStartedAt ?? null,
  };
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    executionId: row.executionId,
    agentId: row.agentId,
    agentName: row.agentName,
    title: row.title,
    summary: row.summary,
    requestedValue: row.requestedValue,
    policyId: row.policyId,
    policyName: row.policyName,
    policyLimit: row.policyLimit,
    risk: row.risk as RiskLevel,
    status: row.status as ApprovalStatus,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt ?? null,
    resolvedBy: row.resolvedBy ?? undefined,
    resolvedAt: row.resolvedAt ?? null,
    context: parse<Approval["context"]>(row.context, []),
  };
}

/*
 * The organization is a parameter, never a field on the domain object. A domain
 * object arrives from a request body, so if it carried its own tenant the caller
 * could choose one — which is the exact attack this layer exists to stop.
 */
function fromApproval(approval: Approval, organizationId: OrganizationId): ApprovalRow {
  return {
    organizationId,
    id: approval.id,
    executionId: approval.executionId ?? null,
    agentId: approval.agentId,
    agentName: approval.agentName,
    title: approval.title,
    summary: approval.summary,
    requestedValue: approval.requestedValue,
    policyId: approval.policyId,
    policyName: approval.policyName,
    policyLimit: approval.policyLimit,
    risk: approval.risk,
    status: approval.status,
    requestedAt: approval.requestedAt,
    /*
     * Stamped here, at the single write boundary, rather than trusted from the
     * caller. Every construction site — the decision service, the seed, a test
     * fixture — therefore produces a row with a deadline without having to
     * remember to, which is what lets the decision paths treat a missing
     * deadline as a fault (expired) instead of as a normal case they must
     * tolerate. A caller that *does* supply one is respected, so a deployment
     * can shorten a specific request without reaching past this layer.
     */
    expiresAt: approval.expiresAt ?? approvalDeadline(approval.requestedAt),
    resolvedBy: approval.resolvedBy ?? null,
    resolvedAt: approval.resolvedAt ?? null,
    context: stringify(approval.context),
  };
}

function toIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id,
    name: row.name,
    category: row.category as Integration["category"],
    description: row.description,
    connected: row.connected,
    scopes: parse<string[]>(row.scopes, []),
    connectedAt: row.connectedAt ?? undefined,
    agentsUsing: row.agentsUsing,
  };
}

/* ----------------------------- Repositories ----------------------------- */

/*
 * TENANT ISOLATION — read this before changing anything below.
 *
 * Every class here is constructed with one `OrganizationId` and every statement it
 * issues carries `organization_id = <that org>` in its WHERE clause, or writes it in
 * its INSERT. There is no unscoped repository instance to obtain: `repositoriesFor()`
 * is the only constructor, and it requires an organization. That is deliberate —
 * "remember to pass the tenant" is a rule that gets forgotten exactly once, and once
 * is one customer reading another's data.
 *
 * Three consequences worth stating plainly, because each one is a bug that this
 * shape prevents rather than detects:
 *
 *  - `findById` returns `undefined` for a row that exists in another organization.
 *    Not 403, not an error: from this tenant's point of view the row does not exist,
 *    and saying anything else confirms that it does.
 *  - Conditional writes (`resolve`, `claimToolRun`, `completeToolRun`, `markSkipped`)
 *    carry the tenant inside the single UPDATE, so a cross-tenant write cannot match
 *    a row. The guard is in the statement, not in a check before it.
 *  - `update` re-reads through the scoped `findById`, so a patch aimed at another
 *    tenant's id finds nothing and writes nothing.
 *
 * `server/test/tenant-isolation.test.ts` attacks every one of these paths with two
 * real organizations. Adding a method here without a tenant filter has to make one of
 * those tests fail; if it does not, the test suite is the thing that needs fixing.
 */

class SqliteAgentRepository implements AgentRepository {
  constructor(private readonly org: OrganizationId) {}

  async list(): Promise<Agent[]> {
    return db
      .select()
      .from(agentRows)
      .where(eq(agentRows.organizationId, this.org))
      .all()
      .map(toAgent);
  }

  async findById(id: string): Promise<Agent | undefined> {
    const row = db
      .select()
      .from(agentRows)
      .where(and(eq(agentRows.organizationId, this.org), eq(agentRows.id, id)))
      .get();
    return row ? toAgent(row) : undefined;
  }

  async create(agent: Agent): Promise<Agent> {
    // P3: guarded here rather than in the route, so a second caller of `create`
    // cannot exist without the ceiling. Throws `QuotaExceededError`, which
    // `server/routes.ts` renders as 409 `quota_exceeded` with the numbers.
    assertWithinQuota(this.org, "agents");
    db.insert(agentRows).values(fromAgent(agent, this.org)).run();
    return agent;
  }

  async update(id: string, patch: Partial<Agent>): Promise<Agent | undefined> {
    // Reads through the scoped findById, so an id belonging to another organization
    // returns undefined here and no UPDATE is issued at all.
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id };
    db.update(agentRows)
      .set(fromAgent(next, this.org))
      .where(and(eq(agentRows.organizationId, this.org), eq(agentRows.id, id)))
      .run();
    return next;
  }
}

class SqlitePolicyRepository implements PolicyRepository {
  constructor(private readonly org: OrganizationId) {}

  async list(): Promise<Policy[]> {
    return db
      .select()
      .from(policyRows)
      .where(eq(policyRows.organizationId, this.org))
      .all()
      .map(toPolicy);
  }

  async findById(id: string): Promise<Policy | undefined> {
    const row = db
      .select()
      .from(policyRows)
      .where(and(eq(policyRows.organizationId, this.org), eq(policyRows.id, id)))
      .get();
    return row ? toPolicy(row) : undefined;
  }

  async create(policy: Policy): Promise<Policy> {
    assertWithinQuota(this.org, "policies");
    db.insert(policyRows).values(fromPolicy(policy, this.org)).run();
    return policy;
  }

  async update(id: string, patch: Partial<Policy>): Promise<Policy | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id };
    db.update(policyRows)
      .set(fromPolicy(next, this.org))
      .where(and(eq(policyRows.organizationId, this.org), eq(policyRows.id, id)))
      .run();
    return next;
  }

  async incrementTriggered(id: string): Promise<void> {
    db.update(policyRows)
      .set({ triggeredCount: sql`${policyRows.triggeredCount} + 1` })
      .where(and(eq(policyRows.organizationId, this.org), eq(policyRows.id, id)))
      .run();
  }
}

class SqliteExecutionRepository implements ExecutionRepository {
  constructor(private readonly org: OrganizationId) {}

  async list(limit = 200): Promise<Execution[]> {
    return executionTimelineQuery(this.org, limit).all().map(toExecution);
  }

  /**
   * Un `GROUP BY` cadré au locataire, et non un comptage de ce que `list()` a bien
   * voulu rendre.
   *
   * Compté sur `status` et non sur `decision` : les deux existent et ne disent pas la
   * même chose. `decision` est le verdict du moteur, `status` est ce qu'il est DEVENU —
   * une action autorisée dont l'outil a échoué est `failed`, et la compter comme
   * autorisée masquerait exactement ce qui réclame l'attention de l'exploitant.
   */
  async statusCounts(): Promise<ExecutionStatusCounts> {
    const rows = db
      .select({ status: executionRows.status, n: sql<number>`count(*)` })
      .from(executionRows)
      .where(eq(executionRows.organizationId, this.org))
      .groupBy(executionRows.status)
      .all();
    return foldStatusCounts(rows);
  }

  async findById(id: string): Promise<Execution | undefined> {
    const row = db
      .select()
      .from(executionRows)
      .where(and(eq(executionRows.organizationId, this.org), eq(executionRows.id, id)))
      .get();
    return row ? toExecution(row) : undefined;
  }

  async actionActivity(prefix: string): Promise<{ count: number; latest: Execution | undefined }> {
    const matches = and(eq(executionRows.organizationId, this.org), sql`substr(${executionRows.action}, 1, ${prefix.length}) = ${prefix}`);
    const counted = db.select({ n: sql<number>`count(*)` }).from(executionRows).where(matches).get();
    const latest = db.select().from(executionRows).where(matches).orderBy(desc(executionRows.timestamp)).limit(1).get();
    return { count: Number(counted?.n ?? 0), latest: latest ? toExecution(latest) : undefined };
  }

  /**
   * The decision service hands over an execution that already carries its opening trail
   * ("Action requested", "Policy evaluated", the outcome). Those entries are chained
   * here rather than at the call site, so the repository stays the single authority on
   * the chain and no creation path can insert an unhashed trail — including future ones.
   * The chained execution is returned so the caller sees what was actually stored.
   */
  async create(execution: Execution): Promise<Execution> {
    /*
     * P3 — the executions ceiling, checked here as well as in the two transaction
     * helpers below.
     *
     * Found by `quotas.test.ts`, not by reading the code: guarding only
     * `insertExecutionAndApproval` and `decideAndPersistTx` left this method — the one
     * `POST /api/executions` uses — as an unmetered way to create executions. A quota
     * with one uncounted door is not a quota. This is the argument for enforcing at
     * every point of persistence rather than at the routes: there were three, and the
     * third was missed even while deliberately looking for them.
     */
    assertWithinQuota(this.org, "executions");
    const chained: Execution = {
      ...execution,
      audit: linkAuditEntries(this.org, execution.id, [], execution.audit),
    };
    db.insert(executionRows).values(fromExecution(chained, this.org)).run();
    return chained;
  }

  /**
   * Whole-row read-modify-write.
   *
   * Note what this cannot safely do: append to a list. The patch is merged onto a
   * snapshot the CALLER read, so `update(id, { audit: [...mine, entry] })` writes
   * back a trail assembled from a possibly-stale copy and silently drops anything
   * another writer added in between. That is exactly how audit entries were being
   * lost. Use `appendAudit` for appends; this method's `audit` patch now means
   * "replace the trail", which is what it always literally did.
   */
  async update(id: string, patch: Partial<Execution>): Promise<Execution | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id };
    db.update(executionRows)
      .set(fromExecution(next, this.org))
      .where(and(eq(executionRows.organizationId, this.org), eq(executionRows.id, id)))
      .run();
    return next;
  }

  /**
   * Append to the audit trail atomically.
   *
   * The read and the write happen inside one SQLite transaction and the base list
   * comes from the STORED row, never from a caller's snapshot — which is the whole
   * point. better-sqlite3 is synchronous, so the callback below runs to completion
   * with no interleaving, and SQLite serialises writers across connections.
   *
   * The audit trail is the one structure in this system that must not lose a row:
   * it is the record of what happened to a governed action, and it is trusted. An
   * append that occasionally drops an entry under load is worse than no trail.
   *
   * Returns `undefined` when the execution does not exist *in this organization*,
   * and creates nothing. The tenant is bound into both the SELECT and the UPDATE
   * rather than checked beforehand, so there is no window between the two.
   */
  async appendAudit(id: string, entries: AuditEntry[]): Promise<Execution | undefined> {
    if (entries.length === 0) return this.findById(id);

    const org = this.org;
    const append = rawDb.transaction((rows: AuditEntry[]) => {
      const row = rawDb
        .prepare(`SELECT audit FROM executions WHERE organization_id = ? AND id = ?`)
        .get(org, id) as { audit: string | null } | undefined;
      if (!row) return false;

      const current = parse<AuditEntry[]>(row.audit, []);
      /**
       * The chain is computed HERE, from the STORED trail, inside the transaction — not
       * from a caller's snapshot and not from whatever `prevHash` a caller supplied.
       * Both matter: the first would fork the chain under concurrent appends, the second
       * would let a caller dictate its own link and forge continuity.
       */
      const linked = linkAuditEntries(org, id, current, rows);
      rawDb
        .prepare(`UPDATE executions SET audit = ? WHERE organization_id = ? AND id = ?`)
        .run(stringify([...current, ...linked]), org, id);
      return true;
    });

    return append(entries) ? this.findById(id) : undefined;
  }

  /**
   * Take the run lock for one execution.
   *
   * A single conditional UPDATE. better-sqlite3 is synchronous and SQLite
   * serialises writers, so exactly one concurrent caller can win the claim.
   * Claimable states:
   *   - `pending` — never dispatched,
   *   - `failed`  — a controlled retry,
   *   - `running` whose claim predates `staleBefore` — the worker that held it
   *     died, so the row is recovered instead of being stuck forever.
   * `succeeded` and `skipped` are terminal and can never be claimed again,
   * which is what makes a double approve or a double execute a no-op.
   *
   * ATTEMPT CEILING
   * ---------------
   * `attempts` used to be incremented and never read, so a `failed` row could be
   * claimed without limit. Since a tool is the side-effecting edge — `purchase`,
   * `payment`, `refund` — and a tool can fail *after* the provider accepted the
   * request, unbounded retry means spending money N times while the audit trail
   * records N failures. `maxAttempts` is therefore checked here, in the single SQL
   * statement that is the only door to a tool, rather than in the service layer:
   * every path (retry, re-approval, stale recovery, any future queue worker) is
   * bounded by construction and cannot reopen the hole.
   *
   * A refused claim consumes no attempt, because the UPDATE simply does not match.
   *
   * `organization_id` is part of that same WHERE clause, which is what makes a
   * cross-tenant claim impossible rather than merely unlikely: the statement cannot
   * match a foreign row, so it cannot invoke a tool on another tenant's execution.
   */
  async claimToolRun(
    id: string,
    toolId: string,
    at: string,
    staleBefore?: string,
    maxAttempts?: number,
  ): Promise<boolean> {
    const info = rawDb
      .prepare(
        `UPDATE executions
            SET run_state = 'running',
                tool_id = ?,
                tool_started_at = ?,
                attempts = attempts + 1
          WHERE organization_id = ?
            AND id = ?
            AND attempts < ?
            AND (
                  run_state IN ('pending', 'failed')
               OR (run_state = 'running' AND (tool_started_at IS NULL OR tool_started_at < ?))
            )`,
      )
      // The default is the ceiling, NOT unbounded. A caller that forgets the
      // argument must inherit the protection, not lose it — a safety limit whose
      // default is "no limit" protects only the code paths someone remembered.
      .run(toolId, at, this.org, id, maxAttempts ?? MAX_TOOL_ATTEMPTS, staleBefore ?? at);
    return info.changes === 1;
  }

  /** Close a claimed run. Only a `running` row in this organization can transition. */
  async completeToolRun(
    id: string,
    outcome:
      | { ok: true; at: string; result: Record<string, unknown> | null }
      | { ok: false; at: string; error: string },
  ): Promise<boolean> {
    const info = outcome.ok
      ? rawDb
          .prepare(
            `UPDATE executions
                SET run_state = 'succeeded', tool_executed_at = ?, tool_result = ?, last_error = NULL
              WHERE organization_id = ? AND id = ? AND run_state = 'running'`,
          )
          .run(outcome.at, outcome.result ? JSON.stringify(outcome.result) : null, this.org, id)
      : rawDb
          .prepare(
            `UPDATE executions
                SET run_state = 'failed', last_error = ?
              WHERE organization_id = ? AND id = ? AND run_state = 'running'`,
          )
          .run(outcome.error, this.org, id);
    return info.changes === 1;
  }

  /**
   * Les trois ecritures de cloture, en une transaction. Voir `types.ts` pour le pourquoi.
   *
   * better-sqlite3 est synchrone : le callback ci-dessous s'execute sans entrelacement,
   * et SQLite serialise les ecrivains entre connexions. La condition `run_state =
   * 'running'` est portee par la SELECTION, donc une seconde cloture ne trouve rien —
   * meme propriete que la clause conditionnelle de `completeToolRun`, au meme endroit.
   */
  async settleToolRun(
    id: string,
    outcome: ToolOutcome,
    entries: AuditEntry[],
    patch: Partial<Execution>,
  ): Promise<Execution | undefined> {
    const org = this.org;
    const settle = rawDb.transaction((): Execution | undefined => {
      const row = rawDb
        .prepare(
          `SELECT * FROM executions
            WHERE organization_id = ? AND id = ? AND run_state = 'running'`,
        )
        .get(org, id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const current = toExecution(row as never);
      const next = settledExecution(org, current, outcome, entries, patch);
      db.update(executionRows)
        .set(fromExecution(next, org))
        .where(and(eq(executionRows.organizationId, org), eq(executionRows.id, id)))
        .run();
      return next;
    });
    return settle();
  }

  /** Mark an execution as one that will never reach a tool. */
  async markSkipped(id: string, reason: string): Promise<void> {
    rawDb
      .prepare(
        `UPDATE executions SET run_state = 'skipped', last_error = ?
          WHERE organization_id = ? AND id = ? AND run_state IN ('pending', 'failed')`,
      )
      .run(reason, this.org, id);
  }

  async dailySpend(agentId: string, since: string): Promise<number> {
    return dailySpendSync(this.org, agentId, since);
  }
}

class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly org: OrganizationId) {}

  async list(resolvedLimit = DEFAULT_RESOLVED_APPROVAL_LIMIT): Promise<Approval[]> {
    // Two queries rather than one, because the two halves have different rules:
    // pending is returned in full, resolved is capped. See the interface doc in
    // `types.ts` for why a single `LIMIT` over the whole table would be a bug.
    //
    // Both halves are tenant-scoped. Note that this is not only an isolation
    // requirement: an unscoped `LIMIT` would let a busy tenant's resolved history
    // push a quiet tenant's rows out of its own list.
    const pending = db
      .select()
      .from(approvalRows)
      .where(and(eq(approvalRows.organizationId, this.org), eq(approvalRows.status, "pending")))
      .orderBy(desc(approvalRows.requestedAt))
      .all();
    const resolved = db
      .select()
      .from(approvalRows)
      .where(and(eq(approvalRows.organizationId, this.org), ne(approvalRows.status, "pending")))
      .orderBy(desc(approvalRows.requestedAt))
      .limit(resolvedLimit)
      .all();
    // Re-sorted after the merge: the console renders this order directly, and two
    // separately-ordered result sets concatenated are not ordered.
    return [...pending, ...resolved]
      .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
      .map(toApproval);
  }

  async findById(id: string): Promise<Approval | undefined> {
    const row = db
      .select()
      .from(approvalRows)
      .where(and(eq(approvalRows.organizationId, this.org), eq(approvalRows.id, id)))
      .get();
    return row ? toApproval(row) : undefined;
  }

  async create(approval: Approval): Promise<Approval> {
    db.insert(approvalRows).values(fromApproval(approval, this.org)).run();
    return approval;
  }

  /**
   * The approval that gated an execution, if one did.
   *
   * Newest first, because nothing forbids an execution from having been gated
   * more than once across its life and the current window is the one that
   * governs it. Tenant-scoped like every other read here.
   */
  async findByExecutionId(executionId: string): Promise<Approval | undefined> {
    const row = db
      .select()
      .from(approvalRows)
      .where(
        and(eq(approvalRows.organizationId, this.org), eq(approvalRows.executionId, executionId)),
      )
      .orderBy(desc(approvalRows.requestedAt))
      .get();
    return row ? toApproval(row) : undefined;
  }

  /**
   * Batch form of `findByExecutionId`, for the reason given on the interface.
   *
   * Chunked at 400 ids because SQLite's default host-parameter ceiling is 999
   * and this list is caller-supplied. The list route caps at 300 today, so the
   * chunking is unreachable from it — which is exactly why it is here rather
   * than left as a comment: the next caller does not have that cap.
   *
   * Newest-first is preserved per execution by ordering on `requestedAt` and
   * keeping the FIRST row seen for each id, matching `findByExecutionId`.
   */
  async findGatingExpiries(executionIds: string[]): Promise<Map<string, string | null>> {
    const expiries = new Map<string, string | null>();
    if (executionIds.length === 0) return expiries;

    const unique = [...new Set(executionIds)];
    for (let at = 0; at < unique.length; at += 400) {
      const chunk = unique.slice(at, at + 400);
      const rows = db
        .select({ executionId: approvalRows.executionId, expiresAt: approvalRows.expiresAt })
        .from(approvalRows)
        .where(
          and(
            eq(approvalRows.organizationId, this.org),
            inArray(approvalRows.executionId, chunk),
          ),
        )
        .orderBy(desc(approvalRows.requestedAt))
        .all();
      for (const row of rows) {
        if (row.executionId === null) continue;
        if (expiries.has(row.executionId)) continue;
        expiries.set(row.executionId, row.expiresAt ?? null);
      }
    }
    return expiries;
  }

  /**
   * Move a pending request to `expired`.
   *
   * Conditional on the deadline having actually passed, so this can never be used
   * as a back door to kill a live request: a caller who wants an approval gone
   * before its time has to reject it, under `approve` capability, leaving a named
   * human in the trail.
   */
  async expire(id: string, now: string = new Date().toISOString()): Promise<{ approval: Approval; claimed: boolean } | undefined> {
    const info = db
      .update(approvalRows)
      .set({ status: "expired", resolvedAt: now })
      .where(
        and(
          eq(approvalRows.organizationId, this.org),
          eq(approvalRows.id, id),
          eq(approvalRows.status, "pending"),
          // `isNull OR <= now` — the fail-closed reading of a missing deadline,
          // expressed in SQL so it matches what `resolve` refuses to claim.
          or(isNull(approvalRows.expiresAt), lte(approvalRows.expiresAt, now)),
        ),
      )
      .run();

    const approval = await this.findById(id);
    if (!approval) return undefined;
    return { approval, claimed: info.changes === 1 };
  }

  /**
   * Sweep every pending request of this tenant whose deadline has passed.
   *
   * Returns the ids it actually transitioned, so a caller can act on each one
   * (mark its execution terminal, write the trail) instead of guessing. Tenant
   * scoped like every other statement here: a sweep is a write, and a write that
   * crossed tenants would be as damaging as any other.
   */
  async expirePending(now: string = new Date().toISOString()): Promise<string[]> {
    const due = db
      .select({ id: approvalRows.id })
      .from(approvalRows)
      .where(
        and(
          eq(approvalRows.organizationId, this.org),
          eq(approvalRows.status, "pending"),
          or(isNull(approvalRows.expiresAt), lte(approvalRows.expiresAt, now)),
        ),
      )
      .all();

    const expired: string[] = [];
    for (const row of due) {
      // Through the conditional statement rather than one bulk UPDATE, so a row
      // an approver resolves in the middle of the sweep is left alone and is not
      // reported as expired when a human actually decided it.
      const result = await this.expire(row.id, now);
      if (result?.claimed) expired.push(row.id);
    }
    return expired;
  }

  async resolve(
    id: string,
    status: Exclude<ApprovalStatus, "pending" | "expired">,
    resolvedBy: string,
    now: string = new Date().toISOString(),
  ): Promise<{ approval: Approval; claimed: boolean } | undefined> {
    // Atomic, conditional write — the same defensive shape as claimToolRun():
    // the WHERE clause itself is the guard, evaluated by SQLite in one
    // indivisible statement, so a second concurrent caller can never win a
    // resolution that already landed.
    //
    // `info.changes` is the only signal that says whether *this* call was the
    // winner. It used to be discarded, so both racing approvers were told they
    // had resolved the request: the audit trail grew two "Approval granted"
    // entries, two `approval.resolved` notifications went out, and the gateway
    // attempted a second dispatch (stopped only by claimToolRun's idempotence).
    //
    // The tenant is the third condition. An approver in one organization therefore
    // cannot approve — cannot authorise a real-world side effect on — another
    // organization's pending request. This is the single most dangerous
    // cross-tenant write in the system, which is why the guard is in the statement.
    //
    // The deadline is the fourth condition, and it is *here* rather than in a
    // check before the call for the same reason the other three are: a read that
    // says "still valid", followed by a write, is a time-of-check/time-of-use
    // race. Between the two the clock advances, and the window an operator can
    // aim at is exactly the latency of whatever sits in between. Inside the
    // statement there is no window at all — SQLite evaluates the predicate and
    // the write as one indivisible step, so an approval that expires mid-flight
    // loses, deterministically.
    //
    // A NULL deadline is refused rather than treated as "no limit". See
    // `shared/approvals/ttl.ts`; the short version is that a row nobody stamped
    // is a bug, and the safe reading of a bug is not "valid forever".
    const info = db
      .update(approvalRows)
      .set({ status, resolvedBy, resolvedAt: now })
      .where(
        and(
          eq(approvalRows.organizationId, this.org),
          eq(approvalRows.id, id),
          eq(approvalRows.status, "pending"),
          isNotNull(approvalRows.expiresAt),
          gt(approvalRows.expiresAt, now),
        ),
      )
      .run();

    // `findById` afterwards always reflects the one true, final state — never a
    // stale read — whichever caller won.
    const approval = await this.findById(id);
    if (!approval) return undefined;
    return { approval, claimed: info.changes === 1 };
  }
}

class SqliteIntegrationRepository implements IntegrationRepository {
  constructor(private readonly org: OrganizationId) {}

  async list(): Promise<Integration[]> {
    return db
      .select()
      .from(integrationRows)
      .where(eq(integrationRows.organizationId, this.org))
      .all()
      .map(toIntegration);
  }

  async toggle(id: string): Promise<Integration | undefined> {
    const row = db
      .select()
      .from(integrationRows)
      .where(and(eq(integrationRows.organizationId, this.org), eq(integrationRows.id, id)))
      .get();
    if (!row) return undefined;
    const connected = !row.connected;
    db.update(integrationRows)
      .set({
        connected,
        connectedAt: connected ? new Date().toISOString().slice(0, 10) : null,
      })
      .where(and(eq(integrationRows.organizationId, this.org), eq(integrationRows.id, id)))
      .run();
    return toIntegration({
      ...row,
      connected,
      connectedAt: connected ? new Date().toISOString().slice(0, 10) : null,
    });
  }
}

/**
 * Cross-aggregate writes that must not half-apply.
 *
 * better-sqlite3 transactions are synchronous, so the callback below cannot be
 * async — the two inserts are issued directly against the driver inside one
 * SQLite transaction. If either throws, neither row is committed and no orphan
 * Approval can point at a missing Execution (or vice versa).
 *
 * The organization is threaded through as an argument rather than captured, because
 * this is a module-level prepared transaction shared by every tenant.
 */
const insertExecutionAndApproval = rawDb.transaction(
  (org: OrganizationId, execution: Execution, approval: Approval | null) => {
    /*
     * P3 — the execution quota, checked INSIDE the transaction.
     *
     * Position matters twice over. Inside, because SQLite serialises writers, so two
     * concurrent callers at the ceiling cannot both read the same count and both
     * insert; a check before `rawDb.transaction(...)` would leave exactly that window
     * open. And first, because a refusal must leave nothing behind — throwing here
     * rolls the transaction back, so neither the execution nor its approval is
     * committed and no orphan can point at a row that was refused.
     */
    assertWithinQuota(org, "executions");
    /*
     * P6 — the audit trail is chained HERE, in the same commit as the insert.
     *
     * It was not, and that was a real hole rather than a tidiness issue. Three
     * paths insert an execution — `create()`, this transaction, and
     * `decideAndPersistTx` — and only `create()` linked the entries it was handed.
     * This one and `decideAndPersistTx` are the paths the DecisionService and the
     * Gateway use, so in practice EVERY real decision was stored with its opening
     * entries unhashed: "Action requested", "Policy evaluated" and "Decision made",
     * the last of which is the record of the verdict itself.
     *
     * The gap hid itself. When `appendAudit` later added "Tool execution started",
     * it took its previous hash from `headHash(org, id, stored)`, which falls back
     * to the genesis hash when the last stored entry has none — so the chain
     * restarted from genesis and verified cleanly from that point on, instead of
     * leaving a visible break. Found by pointing the new
     * `GET /api/executions/:id/audit/verify` at a real execution; see
     * `notes/P6-FINDING-audit-chain-gap.md` for the measured trail.
     *
     * Rows written before this fix keep their unhashed entries and are reported as
     * broken by the verifier. They are not re-linked: this process forging
     * continuity for history it cannot vouch for is exactly what the chain exists
     * to make impossible.
     */
    const chained: Execution = {
      ...execution,
      audit: linkAuditEntries(org, execution.id, [], execution.audit),
    };
    db.insert(executionRows).values(fromExecution(chained, org)).run();
    if (approval) db.insert(approvalRows).values(fromApproval(approval, org)).run();
    /*
     * Returned so the caller can hand back the trail that was actually stored.
     * Previously this transaction returned nothing and the caller echoed its own
     * unchained input, which would now mean the API response and the database
     * disagreed about the hashes on the same entries.
     */
    return chained;
  },
);

/**
 * The daily-spend query, as a builder.
 *
 * Extracted so the query-plan regression test can call `.toSQL()` on the REAL query
 * instead of asserting against a hand-copied SQL string. A test that checks a
 * duplicate of the query proves nothing once the original drifts.
 *
 * `organization_id` leads the WHERE clause because it leads
 * `idx_executions_org_spend`: a budget is per tenant, and a spend total summed
 * across tenants would both leak and mis-govern.
 */
function dailySpendQuery(org: OrganizationId, agentId: string, since: string) {
  return db
    .select({ total: sql<number>`coalesce(sum(${executionRows.cost}), 0)` })
    .from(executionRows)
    .where(
      and(
        eq(executionRows.organizationId, org),
        eq(executionRows.agentId, agentId),
        eq(executionRows.status, "allowed"),
        gte(executionRows.timestamp, since),
      ),
    );
}

/*
 * The console's newest-first timeline read, extracted so that the query-plan test
 * and the repository share one definition. A plan test written against a copy of
 * the SQL keeps passing after the original has drifted, which is exactly the
 * failure mode these tests exist to prevent.
 */
function executionTimelineQuery(org: OrganizationId, limit: number) {
  return db
    .select()
    .from(executionRows)
    .where(eq(executionRows.organizationId, org))
    .orderBy(desc(executionRows.timestamp))
    .limit(limit);
}

/** Exposed for the query-plan regression test; not part of the repository contract. */
export function executionTimelineSqlForPlan(
  org: OrganizationId,
  limit: number,
): { sql: string; params: unknown[] } {
  const { sql: text, params } = executionTimelineQuery(org, limit).toSQL();
  return { sql: text, params };
}

/** Exposed for the query-plan regression test; not part of the repository contract. */
export function dailySpendSqlForPlan(
  org: OrganizationId,
  agentId: string,
  since: string,
): { sql: string; params: unknown[] } {
  const { sql: text, params } = dailySpendQuery(org, agentId, since).toSQL();
  return { sql: text, params };
}

/**
 * Same sum as `SqliteExecutionRepository.dailySpend`, but called from inside
 * a transaction, on the same synchronous connection, never through the
 * async wrapper.
 */
/**
 * Plie les lignes d'un `GROUP BY status` en un objet de comptages.
 *
 * Les quatre statuts sont initialisés à ZÉRO, et c'est le point : une base sans aucune
 * exécution bloquée doit rendre `blocked: 0`, pas un champ absent qui deviendrait `NaN`
 * au premier calcul de pourcentage côté console. `total` est la somme des lignes
 * réellement vues, donc il inclut un statut inconnu d'une version future — un total qui
 * oublierait une catégorie serait pire qu'un total qui la compte sans la nommer.
 */
function foldStatusCounts(rows: readonly { status: string; n: number }[]): ExecutionStatusCounts {
  const counts: ExecutionStatusCounts = { total: 0, allowed: 0, blocked: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    counts.total += n;
    if (row.status === "allowed") counts.allowed += n;
    else if (row.status === "blocked") counts.blocked += n;
    else if (row.status === "pending") counts.pending += n;
    else if (row.status === "failed") counts.failed += n;
  }
  return counts;
}

function dailySpendSync(org: OrganizationId, agentId: string, since: string): number {
  const row = dailySpendQuery(org, agentId, since).get();
  return row?.total ?? 0;
}

/**
 * Closes the TOCTOU on the daily spend budget: reading the current total,
 * deciding, and writing the new execution used to be three separate steps
 * with `await` points between them, so two concurrent decisions for the same
 * agent could both read the total as it stood before either had written —
 * each individually within budget, together over it. better-sqlite3
 * transactions are synchronous and SQLite serialises writers, so running the
 * read, the caller-supplied `build` (which re-evaluates the full policy set,
 * including the daily-spend rule, against the total read *inside* this
 * transaction), and the write as one unit closes the gap: the second of two
 * concurrent callers is guaranteed to see the first one's spend already
 * counted, whichever order they land in.
 */
const decideAndPersistTx = rawDb.transaction(
  (
    org: OrganizationId,
    agentId: string,
    since: string | null,
    build: (dailySpend: number) => { execution: Execution; approval: Approval | null },
  ) => {
    // Before `build` runs, not after: `build` re-evaluates the whole policy set and
    // there is no reason to spend that work on a decision that will be refused.
    assertWithinQuota(org, "executions");
    const dailySpend = since === null ? 0 : dailySpendSync(org, agentId, since);
    const { execution, approval } = build(dailySpend);
    // P6 — chained in this commit, for the reason spelled out on
    // `insertExecutionAndApproval` above. This is the busiest of the three insert
    // paths and was the one leaving "Decision made" unhashed.
    const chained: Execution = {
      ...execution,
      audit: linkAuditEntries(org, execution.id, [], execution.audit),
    };
    db.insert(executionRows).values(fromExecution(chained, org)).run();
    if (approval) db.insert(approvalRows).values(fromApproval(approval, org)).run();

    // The trigger counter belongs to the same commit as the row it counts.
    // It used to be bumped by the caller *after* the transaction returned, so a
    // crash in between left a persisted decision that no policy admitted to
    // having made — and the caller keyed it off its own pre-transaction
    // evaluation rather than the verdict actually written here, which could
    // credit a different policy than the one stored on the execution.
    //
    // Scoped to the organization, so a decision can never increment a counter on a
    // policy belonging to a different tenant — which would both corrupt that
    // tenant's policy statistics and reveal, through the count, that traffic
    // elsewhere referenced it.
    if (execution.policyId) {
      db.update(policyRows)
        .set({ triggeredCount: sql`${policyRows.triggeredCount} + 1` })
        .where(and(eq(policyRows.organizationId, org), eq(policyRows.id, execution.policyId)))
        .run();
    }

    /*
     * The CHAINED execution is returned, not the one `build` produced. The caller
     * hands this straight back to the API response, and a response whose audit
     * entries lacked the hashes the database holds would make the endpoint and the
     * row disagree about the same trail.
     */
    return { execution: chained, approval };
  },
);

/**
 * Cheap liveness probe. Shared by every organization because it is not about any
 * organization's data: it asks whether the database file is open, readable and still
 * has the shape the application expects.
 *
 * `SELECT 1` would pass against a database whose schema is gone, so this touches an
 * actual table. It stays a single indexed count, cheap enough to be polled every few
 * seconds.
 *
 * Never throws and never returns the error: the message carries the database path,
 * and `/api/health` is the one endpoint an unauthenticated caller can always reach.
 * The full error goes to the server log.
 */
async function ping(): Promise<boolean> {
  try {
    rawDb.prepare("SELECT 1 AS ok FROM executions LIMIT 1").get();
    return true;
  } catch (error) {
    console.error("[health] database check failed:", error);
    return false;
  }
}

/**
 * Instances are cached per organization.
 *
 * Not an optimisation for its own sake: `server/routes.ts` resolves a repository set
 * on every request, and building six objects per request would also mean building a
 * DecisionService and an AgentGateway per request. The instances are stateless
 * apart from the organization they are bound to, so caching them is safe. The map is
 * bounded by the number of organizations, which is bounded by the number of paying
 * customers.
 */
const byOrganization = new Map<string, Repositories>();

/**
 * The only way to obtain a repository set.
 *
 * There is deliberately no unscoped export. A module-level `repositories` object
 * would be reachable from anywhere, would compile, would pass every existing test,
 * and would read across every tenant — so the safest thing that can be done about it
 * is to make it impossible to write.
 */
export function repositoriesFor(organizationId: OrganizationId): Repositories {
  const cached = byOrganization.get(organizationId);
  if (cached) return cached;

  const org = organizationId;
  const built: Repositories = {
    /** Atomic Execution + Approval write. Either both land, or neither does. */
    async createExecutionWithApproval(execution: Execution, approval: Approval | null) {
      const stored = insertExecutionAndApproval(org, execution, approval);
      return { execution: stored, approval };
    },
    async decideAndPersist(
      agentId: string,
      since: string | null,
      build: (dailySpend: number) => { execution: Execution; approval: Approval | null },
    ) {
      return decideAndPersistTx(org, agentId, since, build);
    },
    ping,
    agents: new SqliteAgentRepository(org),
    policies: new SqlitePolicyRepository(org),
    executions: new SqliteExecutionRepository(org),
    approvals: new SqliteApprovalRepository(org),
    integrations: new SqliteIntegrationRepository(org),
  };

  byOrganization.set(organizationId, built);
  return built;
}

/** Test-only: drops the instance cache so a suite can rebuild against a fresh database. */
export function resetRepositoryCache(): void {
  byOrganization.clear();
}
