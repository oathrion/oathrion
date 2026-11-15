import { useMemo } from "react";
import { Link } from "wouter";
import { ArrowRight, Bot, DollarSign, ShieldAlert, Zap } from "lucide-react";
import {
  ErrorState,
  PageHeader,
  SectionCard,
  StatCard,
  StatCardSkeleton,
  TableSkeleton,
} from "@/components/common/primitives";
import { AgentTable } from "@/components/agents/AgentTable";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { PolicySandbox } from "@/components/policy/PolicySandbox";
import { ExecutionsChart, CostBars } from "@/components/charts";
import { useARIA, useFreshSnapshot } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { currency, compact, percent } from "@/lib/format";
import { computeDashboardMetrics, costPerAgent, executionsOverTime } from "@shared/metrics";
import { RunningAgentsPanel } from "@/components/agents/RunningAgentsPanel";

export default function DashboardPage() {
  const { loading, error, agents, executions, activity, policies, approvals, toggleAgentStatus, reload } =
    useARIA();
  useFreshSnapshot();
  const { identity, can } = useAuth();
  const canManage = can("manage");

  // Every KPI below is derived from the execution ledger the Policy Engine writes.
  const metrics = useMemo(
    () => computeDashboardMetrics({ agents, executions, approvals, policies }),
    [agents, executions, approvals, policies],
  );
  const executionsSeries = useMemo(() => executionsOverTime(executions), [executions]);
  const costByAgent = useMemo(() => costPerAgent(executions), [executions]);

  const visibleAgents = agents.filter((a) => a.status !== "draft").slice(0, 5);

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Hello${identity?.name ? `, ${identity.name}` : ""}.`}
        subtitle="Your AI agents are working for you."
        actions={
          canManage ? (
            <Link
              href="/agents/new"
            data-testid="link-new-agent-dashboard"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            New agent
            </Link>
          ) : null
        }
      />

      <RunningAgentsPanel />

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
                  label="Active agents"
                  value={String(metrics.activeAgents)}
                  deltaLabel={`of ${agents.length} registered`}
                  icon={Bot}
                  testId="stat-active-agents"
                />
                <StatCard
                  label="Executions · 24 h"
                  value={compact(metrics.executionsToday)}
                  delta={metrics.executionsDelta ?? undefined}
                  deltaLabel={metrics.executionsDelta === null ? "no baseline over the previous 24 h" : "compared with the previous 24 h"}
                  icon={Zap}
                  testId="stat-executions"
                />
                <StatCard
                  label="Cost · 24 h"
                  value={currency(metrics.totalCost)}
                  delta={metrics.costDelta ?? undefined}
                  deltaLabel={metrics.costDelta === null ? "no baseline over the previous 24 h" : "compared with the previous 24 h"}
                  icon={DollarSign}
                  betterWhen="down"
                  testId="stat-cost"
                />
                <StatCard
                  label="Policy violations"
                  value={String(metrics.violations)}
                  delta={metrics.violationsDelta ?? undefined}
                  deltaLabel={metrics.violationsDelta === null ? "no baseline over the previous 24 h" : "compared with the previous 24 h"}
                  icon={ShieldAlert}
                  tone="danger"
                  betterWhen="down"
                  testId="stat-violations"
                />
              </>
            )}
          </section>

          <PolicySandbox />

          <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <SectionCard
              title="Agents"
              description="All the agents registered in Oathrion."
              action={
                <Link
                  href="/agents"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-70"
                  data-testid="link-all-agents"
                >
                  View all <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              }
            >
              {loading ? (
                <TableSkeleton rows={5} cols={6} />
              ) : (
                <AgentTable agents={visibleAgents} onToggleStatus={toggleAgentStatus} />
              )}
            </SectionCard>

            {/*
              This card used to be titled "Live activity", described as
              "streaming", and badged with a green "Live" pill. Nothing streams:
              there is no websocket and no polling, so the feed is whatever was
              read when the page loaded. A governance console that overstates
              the freshness of its own audit view teaches the operator to trust
              a screen that can be hours stale, so the labels now say what the
              data actually is.
            */}
            <SectionCard
              title="Recent activity"
              description="Read when this page loaded. Reload to refresh it."
              className="h-fit"
            >
              {loading ? <TableSkeleton rows={6} cols={1} /> : <ActivityFeed events={activity.slice(0, 8)} />}
            </SectionCard>
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <SectionCard
              title="Executions"
              description="Actions allowed, pending and blocked over the last 24 hours."
            >
              {loading ? <TableSkeleton rows={4} cols={2} /> : <ExecutionsChart data={executionsSeries} />}
            </SectionCard>

            <SectionCard title="Cost per agent" description="Spend with providers, per agent, over the last 24 hours.">
              {loading ? <TableSkeleton rows={4} cols={2} /> : <CostBars data={costByAgent} />}
            </SectionCard>
          </section>

          <SectionCard
            title="Security and policies"
            description="The state of governance in the organisation."
            action={
              <Link
                href="/policies"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-70"
                data-testid="link-all-policies"
              >
                Manage <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            }
            bodyClassName="grid gap-px bg-card-border sm:grid-cols-2 lg:grid-cols-4"
          >
            <SecurityTile label="Active policies" value={String(metrics.enabledPolicies)} hint="Evaluated on every action" />
            <SecurityTile
              label="Pending approvals"
              value={String(metrics.pendingApprovals)}
              hint="Waiting for a human decision"
              tone="warning"
            />
            <SecurityTile label="Blocked actions" value={String(metrics.violations)} hint="Last 24 hours" tone="danger" />
            <SecurityTile
              label="Log coverage"
              value={percent(metrics.auditCoverage, 0)}
              hint="Executions with a log"
              tone="success"
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}

function SecurityTile({
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
    <div className="bg-card px-5 py-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-2 text-xl font-semibold tabular ${color}`}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
