import { useLocation } from "wouter";
import { Bot, Pause, Play } from "lucide-react";
import { DataTable, type Column } from "@/components/common/DataTable";
import { AgentStatusBadge, RiskBadge } from "@/components/common/badges";
import { EmptyState } from "@/components/common/primitives";
import { currency, compact } from "@/lib/format";
import { PROVIDER_LABEL } from "@/data/agents";
import { useAuth } from "@/lib/auth";
import { agentToggleAffordance, agentToggleDisabled } from "@/lib/agent-presentation";
import type { Agent } from "@/types";

export function AgentTable({
  agents,
  onToggleStatus,
  showRisk = false,
  emptyAction,
}: {
  agents: Agent[];
  onToggleStatus: (id: string) => void;
  showRisk?: boolean;
  emptyAction?: React.ReactNode;
}) {
  const [, navigate] = useLocation();
  const { can } = useAuth();
  const canManage = can("manage");

  const columns: Column<Agent>[] = [
    {
      key: "agent",
      header: "Agent",
      render: (a) => (
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-card-border bg-muted/60">
            <Bot className="h-4 w-4 text-muted-foreground" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium" data-testid={`text-agent-name-${a.id}`}>
              {a.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {PROVIDER_LABEL[a.provider]} · {a.model}
            </p>
          </div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (a) => <AgentStatusBadge status={a.status} /> },
    {
      key: "task",
      header: "Current task",
      render: (a) =>
        a.currentTask ? (
          <span className="text-sm">{a.currentTask}</span>
        ) : (
          <span className="text-sm text-muted-foreground">Idle</span>
        ),
    },
    {
      key: "usage",
      header: "Usage",
      align: "right",
      render: (a) => (
        <span className="tabular text-sm text-muted-foreground">{compact(a.executions24h)} runs</span>
      ),
    },
    ...(showRisk
      ? [{ key: "risk", header: "Risk", render: (a: Agent) => <RiskBadge risk={a.riskLevel} /> } as Column<Agent>]
      : []),
    {
      key: "cost",
      header: "Cost",
      align: "right",
      render: (a) => <span className="tabular text-sm font-medium">{currency(a.cost24h)}</span>,
    },
    {
      key: "action",
      header: "Action",
      align: "right",
      render: (a) => {
        // Same shared rule as the detail page, so the two controls cannot
        // disagree about whether a draft agent may be activated.
        const toggle = agentToggleAffordance(a.status);
        const disabled = agentToggleDisabled(a.status, canManage);
        return (
          <button
            onClick={(e) => {
              e.stopPropagation();
              // A disabled control is not enough if a caller invokes the handler directly.
              if (disabled) return;
              onToggleStatus(a.id);
            }}
            disabled={disabled}
            data-testid={`button-toggle-${a.id}`}
            aria-label={`${toggle.label} — ${a.name}`}
            title={toggle.unavailableReason}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-card-border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {toggle.icon === "pause" ? (
              <Pause className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}{" "}
            {/* Compact label for the table: the affordance's verb without the noun. */}
            {toggle.label}
          </button>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={agents}
      onRowClick={(a) => navigate(`/agents/${a.id}`)}
      rowTestId={(a) => `row-agent-${a.id}`}
      emptyState={
        <EmptyState
          icon={Bot}
          title="No agent yet"
          description="Register your first agent to route its actions through Oathrion."
          action={emptyAction}
        />
      }
    />
  );
}
