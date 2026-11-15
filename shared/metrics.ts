/**
 * Dashboard metrics — pure derivations over the execution ledger.
 *
 * Every number the dashboard shows is computed here from records the Policy
 * Engine actually produced. No constants, no React, no I/O: give it the same
 * ledger and it returns the same numbers, which is what makes it testable.
 */

import type {
  ActivityEvent,
  Agent,
  Approval,
  Execution,
  KpiPoint,
  Policy,
  TimeSeriesPoint,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface DashboardMetrics {
  activeAgents: number;
  /** Executions recorded in the last 24 hours. */
  executionsToday: number;
  /** Percentage change vs. the preceding 24 hours. `null` when there is no baseline. */
  executionsDelta: number | null;
  /** Provider spend attributed to executions in the last 24 hours. */
  totalCost: number;
  costDelta: number | null;
  /** Blocked executions in the last 24 hours — i.e. policy violations. */
  violations: number;
  violationsDelta: number | null;
  pendingApprovals: number;
  enabledPolicies: number;
  /** Share of executions carrying at least one audit entry. */
  auditCoverage: number;
}

/** Percentage change from `previous` to `current`, or `null` without a baseline. */
export function delta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function windowed(executions: Execution[], from: number, to: number): Execution[] {
  return executions.filter((e) => {
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) && t >= from && t < to;
  });
}

export function computeDashboardMetrics(
  input: {
    agents: Agent[];
    executions: Execution[];
    approvals: Approval[];
    policies: Policy[];
  },
  now: Date = new Date(),
): DashboardMetrics {
  const end = now.getTime();
  const recent = windowed(input.executions, end - DAY_MS, end + HOUR_MS);
  const previous = windowed(input.executions, end - 2 * DAY_MS, end - DAY_MS);

  const cost = (list: Execution[]) => list.reduce((sum, e) => sum + (e.cost || 0), 0);
  const blocked = (list: Execution[]) => list.filter((e) => e.status === "blocked").length;

  const audited = input.executions.filter((e) => e.audit.length > 0).length;

  return {
    activeAgents: input.agents.filter((a) => a.status === "active").length,
    executionsToday: recent.length,
    executionsDelta: delta(recent.length, previous.length),
    totalCost: cost(recent),
    costDelta: delta(cost(recent), cost(previous)),
    violations: blocked(recent),
    violationsDelta: delta(blocked(recent), blocked(previous)),
    pendingApprovals: input.approvals.filter((a) => a.status === "pending").length,
    enabledPolicies: input.policies.filter((p) => p.status === "enabled").length,
    auditCoverage:
      input.executions.length === 0 ? 100 : (audited / input.executions.length) * 100,
  };
}

/** Executions bucketed into 2-hour slots over the last 24 hours. */
export function executionsOverTime(
  executions: Execution[],
  now: Date = new Date(),
  bucketHours = 2,
): TimeSeriesPoint[] {
  const bucketMs = bucketHours * HOUR_MS;
  const end = Math.ceil(now.getTime() / bucketMs) * bucketMs;
  const buckets: TimeSeriesPoint[] = [];

  for (let i = DAY_MS / bucketMs - 1; i >= 0; i--) {
    const from = end - (i + 1) * bucketMs;
    const slice = windowed(executions, from, from + bucketMs);
    buckets.push({
      label: new Date(from).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }),
      allowed: slice.filter((e) => e.status === "allowed").length,
      blocked: slice.filter((e) => e.status === "blocked" || e.status === "failed").length,
      pending: slice.filter((e) => e.status === "pending").length,
    });
  }
  return buckets;
}

/**
 * Provider spend per agent over a window, highest first.
 *
 * The window is a parameter because the analytics screen lets an operator switch
 * between 24 hours and 7 days. It was hard-coded to 24 hours, so filtering the
 * ledger before calling this had no effect — the caller's 7-day selection was
 * silently narrowed back to a day and the chart contradicted the KPIs beside it.
 */
export function costPerAgent(
  executions: Execution[],
  now: Date = new Date(),
  limit = 5,
  hours = 24,
): KpiPoint[] {
  const end = now.getTime();
  const totals = new Map<string, number>();
  for (const e of windowed(executions, end - hours * HOUR_MS, end + HOUR_MS)) {
    totals.set(e.agentName, (totals.get(e.agentName) ?? 0) + (e.cost || 0));
  }
  return Array.from(totals.entries())
    .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/* ------------------------- Analytics-grade series ------------------------- */

/**
 * Daily execution volume over the last `days` days, oldest first.
 *
 * Same shape as `executionsOverTime`, different bucket. Both read the ledger;
 * neither invents a point when a day is empty — an empty day is a real zero.
 */
export function executionsByDay(
  executions: Execution[],
  now: Date = new Date(),
  days = 7,
): TimeSeriesPoint[] {
  const end = now.getTime();
  const buckets: TimeSeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const from = end - (i + 1) * DAY_MS;
    // The newest bucket is stretched an hour past `now` so a row written this
    // very second lands in today rather than falling off the chart.
    const to = end - i * DAY_MS + (i === 0 ? HOUR_MS : 0);
    const slice = windowed(executions, from, to);
    buckets.push({
      label: new Date(end - i * DAY_MS).toLocaleDateString("en-GB", {
        weekday: "short",
        timeZone: "UTC",
      }),
      allowed: slice.filter((e) => e.status === "allowed").length,
      blocked: slice.filter((e) => e.status === "blocked" || e.status === "failed").length,
      pending: slice.filter((e) => e.status === "pending").length,
    });
  }
  return buckets;
}

/**
 * Share of *permitted* executions that completed without error, per day.
 *
 * Two exclusions, both deliberate. Pending rows have not finished, so counting
 * them either way would misstate the rate. Blocked rows are not failures — the
 * Policy Engine doing its job is a success of the control plane, and folding
 * them in would make good governance look like an outage. A day with no
 * finished execution reports 100: nothing failed.
 */
export function successRateByDay(
  executions: Execution[],
  now: Date = new Date(),
  days = 7,
): KpiPoint[] {
  const end = now.getTime();
  const points: KpiPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const from = end - (i + 1) * DAY_MS;
    const to = end - i * DAY_MS + (i === 0 ? HOUR_MS : 0);
    const slice = windowed(executions, from, to).filter(
      (e) => e.status !== "pending" && e.status !== "blocked",
    );
    const ok = slice.filter((e) => e.status === "allowed").length;
    points.push({
      label: new Date(end - i * DAY_MS).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
      value: slice.length === 0 ? 100 : Math.round((ok / slice.length) * 1000) / 10,
    });
  }
  return points;
}

/**
 * Overall success rate across a window, as a percentage.
 *
 * Same exclusions as `successRateByDay`: pending rows are unfinished, blocked
 * rows are governance rather than failure.
 */
export function successRate(executions: Execution[], now: Date = new Date(), hours = 24): number {
  const end = now.getTime();
  const slice = windowed(executions, end - hours * HOUR_MS, end + HOUR_MS).filter(
    (e) => e.status !== "pending" && e.status !== "blocked",
  );
  if (slice.length === 0) return 100;
  const ok = slice.filter((e) => e.status === "allowed").length;
  return Math.round((ok / slice.length) * 1000) / 10;
}

/** Executions recorded in the last `hours`. */
export function executionsInWindow(
  executions: Execution[],
  now: Date = new Date(),
  hours = 24,
): number {
  const end = now.getTime();
  return windowed(executions, end - hours * HOUR_MS, end + HOUR_MS).length;
}

/**
 * The live activity feed, derived from the audit trail of real executions.
 *
 * This replaces the hand-written fixture that used to seed the dashboard: every
 * line below corresponds to an event the Policy Engine actually recorded.
 */
export function activityFromExecutions(
  executions: Execution[],
  now: Date = new Date(),
  limit = 8,
): ActivityEvent[] {
  const events = executions
    .flatMap((execution) =>
      execution.audit.map((entry, index) => ({
        id: `act_${execution.id}_${index}`,
        actor: entry.actor,
        message: entry.detail ? `${entry.event} — ${entry.detail}` : entry.event,
        kind: kindOf(entry.event),
        at: relative(entry.at, now),
        sortKey: Date.parse(entry.at) || 0,
      })),
    )
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, limit);

  return events.map(({ sortKey: _sortKey, ...event }) => event);
}

/**
 * Classifies one audit line on its own wording. Deliberately not on the run's
 * final verdict: "Action requested" is informational even when the run was
 * ultimately blocked, and colouring it red would misrepresent the trail.
 */
function kindOf(event: string): ActivityEvent["kind"] {
  if (/blocked|failed|rejected|denied/i.test(event)) return "blocked";
  if (/approval requested|retried/i.test(event)) return "pending";
  if (/completed|granted/i.test(event)) return "success";
  return "info";
}

/** "just now", "12m ago", "3h ago", "2d ago". */
function relative(at: string, now: Date): string {
  const ms = now.getTime() - (Date.parse(at) || now.getTime());
  if (ms < 60_000) return "just now";
  if (ms < HOUR_MS) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}

/** Provider spend attributed to executions in the last `hours`. */
export function costInWindow(
  executions: Execution[],
  now: Date = new Date(),
  hours = 24,
): number {
  const end = now.getTime();
  const total = windowed(executions, end - hours * HOUR_MS, end + HOUR_MS).reduce(
    (sum, e) => sum + (e.cost || 0),
    0,
  );
  return Math.round(total * 100) / 100;
}
