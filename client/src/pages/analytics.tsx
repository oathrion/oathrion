/**
 * Analytics — every number on this page is derived from the execution ledger.
 *
 * The static fixtures that used to back these charts are gone: the series come
 * from `shared/metrics.ts`, the same pure module the dashboard and the test
 * suite use. When the ledger is empty the charts are empty, which is honest.
 */

import { useMemo, useState } from "react";
import { CheckCircle2, DollarSign, ShieldX, Zap } from "lucide-react";
import {
  ErrorState,
  FilterTabs,
  PageHeader,
  SectionCard,
  StatCard,
  StatCardSkeleton,
  TableSkeleton,
} from "@/components/common/primitives";
import { CostBars, ExecutionsChart, StackedBars, TrendLine } from "@/components/charts";
import { useARIA } from "@/lib/store";
import {
  computeDashboardMetrics,
  costInWindow,
  costPerAgent,
  executionsByDay,
  executionsInWindow,
  executionsOverTime,
  successRate as successRateOf,
  successRateByDay,
} from "@shared/metrics";
import { currency, compact, percent } from "@/lib/format";

type Range = "24h" | "7d";

export default function AnalyticsPage() {
  const { loading, error, reload, agents, executions, policies, approvals } = useARIA();
  const [range, setRange] = useState<Range>("7d");

  const hours = range === "24h" ? 24 : 24 * 7;
  const days = hours <= 24 ? 1 : Math.ceil(hours / 24);
  const [now] = useState(() => new Date());
  const windowedExecutions = useMemo(
    () => executions.filter((e) => new Date(e.timestamp).getTime() >= now.getTime() - hours * 3_600_000),
    [executions, now, hours],
  );
  const windowedApprovals = useMemo(
    () => approvals.filter((a) => new Date(a.requestedAt).getTime() >= now.getTime() - hours * 3_600_000),
    [approvals, now, hours],
  );

  const stats = useMemo(() => {
    // These helpers window internally, so pass the selected period rather than pre-filtering twice.
    const metrics = computeDashboardMetrics({ agents, executions, policies, approvals });
    return {
      metrics,
      totalExecutions: executionsInWindow(executions, now, hours),
      totalCost: costInWindow(executions, now, hours),
      successRate: successRateOf(executions, now, hours),
      hourly: executionsOverTime(executions, now),
      daily: executionsByDay(executions, now, days),
      cost: costPerAgent(executions, now, 5, hours),
      trend: successRateByDay(executions, now, days),
    };
  }, [agents, executions, policies, approvals, now, hours, days]);

  const blocked = windowedExecutions.filter((e) => e.status === "blocked").length;
  const pendingApprovals = windowedApprovals.filter((a) => a.status === "pending").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        subtitle="How your agents behave, what they cost, and where governance steps in."
        actions={
          <FilterTabs<Range>
            value={range}
            onChange={setRange}
            options={[
              { value: "24h", label: "24 hours" },
              { value: "7d", label: "7 days" },
            ]}
          />
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
            ) : (
              <>
                <StatCard
                  label="Agent executions"
                  value={compact(stats.totalExecutions)}
                  delta={stats.metrics.executionsDelta ?? undefined}
                  icon={Zap}
                />
                <StatCard
                  label="Cost"
                  value={currency(stats.totalCost)}
                  delta={range === "24h" ? stats.metrics.costDelta ?? undefined : undefined}
                  icon={DollarSign}
                  betterWhen="down"
                />
                <StatCard
                  label="Successful executions"
                  value={percent(stats.successRate)}
                  icon={CheckCircle2}
                />
                <StatCard
                  label="Policy violations"
                  value={String(blocked)}
                  delta={range === "24h" ? stats.metrics.violationsDelta ?? undefined : undefined}
                  icon={ShieldX}
                  tone="danger"
                  betterWhen="down"
                />
              </>
            )}
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <SectionCard
              title="Executions over time"
              description={range === "24h" ? "Volume per hour, last 24 hours." : "Volume per day, last 7 days."}
            >
              {loading ? (
                <TableSkeleton rows={4} cols={2} />
              ) : range === "24h" ? (
                <ExecutionsChart data={stats.hourly} />
              ) : (
                <StackedBars data={stats.daily} />
              )}
            </SectionCard>

            <SectionCard title="Cost per agent" description="Spend with providers, per agent.">
              {loading ? <TableSkeleton rows={4} cols={2} /> : <CostBars data={stats.cost} />}
            </SectionCard>

            <SectionCard
              title="Successful executions"
              description="Share of allowed executions that completed without error. Blocked actions are governance, not failure: they are excluded."
            >
              {loading ? (
                <TableSkeleton rows={4} cols={2} />
              ) : (
                <TrendLine data={stats.trend} domain={[0, 100]} />
              )}
            </SectionCard>

            <SectionCard
              title="Governance interventions"
              description="Where the policy engine stepped in."
              bodyClassName="grid gap-px bg-card-border sm:grid-cols-2"
            >
              <Tile label="Blocked actions" value={String(blocked)} hint="Refused before execution" tone="danger" />
              <Tile
                label="Approvals requested"
                value={String(windowedApprovals.length)}
                hint="Escalated to a person"
                tone="warning"
              />
              <Tile label="Pending approvals" value={String(pendingApprovals)} hint="Waiting for a decision" />
              <Tile
                label="Log coverage"
                value={percent(stats.metrics.auditCoverage)}
                hint="Executions with a complete log"
                tone="success"
              />
            </SectionCard>
          </section>
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "neutral" | "warning" | "danger" | "success";
}) {
  const color =
    tone === "warning"
      ? "text-warning"
      : tone === "danger"
        ? "text-danger"
        : tone === "success"
          ? "text-success"
          : "text-foreground";
  return (
    <div className="bg-card px-5 py-6">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={`mt-2 text-xl font-semibold tabular ${color}`}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
