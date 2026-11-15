import { useLocation } from "wouter";
import { Terminal } from "lucide-react";
import { DataTable, type Column } from "@/components/common/DataTable";
import { ExecutionStatusBadge, Pill, RiskBadge } from "@/components/common/badges";
import { executionDisplayStatus } from "@/lib/run-presentation";
import { EmptyState } from "@/components/common/primitives";
import { duration, timeOfDay } from "@/lib/format";
import type { Execution } from "@/types";

export function ExecutionTable({
  executions,
  compactMode = false,
}: {
  executions: Execution[];
  compactMode?: boolean;
}) {
  const [, navigate] = useLocation();

  const columns: Column<Execution>[] = [
    {
      key: "time",
      header: "Time",
      render: (e) => <span className="tabular text-sm text-muted-foreground">{timeOfDay(e.timestamp)}</span>,
    },
    {
      key: "agent",
      header: "Agent",
      render: (e) => <span className="text-sm font-medium">{e.agentName}</span>,
    },
    {
      key: "action",
      header: "Action",
      render: (e) => <span className="text-sm">{e.action}</span>,
    },
    {
      key: "target",
      header: "Target",
      render: (e) => (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
          {e.target}
        </code>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (e) =>
        executionDisplayStatus(e) === "unknown" ? (
          <Pill tone="warning" dot data-testid="status-execution-unknown">
            Unknown outcome
          </Pill>
        ) : (
          <ExecutionStatusBadge status={e.status} />
        ),
    },
    ...(compactMode
      ? []
      : ([
          { key: "risk", header: "Risk", render: (e: Execution) => <RiskBadge risk={e.risk} /> },
          {
            key: "duration",
            header: "Duration",
            align: "right",
            render: (e: Execution) => (
              <span className="tabular text-sm text-muted-foreground">{duration(e.durationMs)}</span>
            ),
          },
        ] as Column<Execution>[])),
  ];

  return (
    <DataTable
      columns={columns}
      rows={executions}
      onRowClick={(e) => navigate(`/executions/${e.id}`)}
      rowTestId={(e) => `row-execution-${e.id}`}
      emptyState={
        <EmptyState
          icon={Terminal}
          title="No execution matches these filters"
          description="Change the filters or widen the period to see your agents' activity."
        />
      }
    />
  );
}
