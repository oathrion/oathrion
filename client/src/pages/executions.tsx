import { useMemo, useState } from "react";
import {
  ErrorState,
  FilterTabs,
  PageHeader,
  SearchInput,
  StatCard,
  Surface,
  TableSkeleton,
} from "@/components/common/primitives";
import { ExecutionTable } from "@/components/executions/ExecutionTable";
import { useARIA, useFreshSnapshot } from "@/lib/store";
import { CheckCircle2, CircleHelp, Clock, ShieldX, TriangleAlert } from "lucide-react";
import { executionDisplayStatus, type DisplayStatus } from "@/lib/run-presentation";

type Filter = "all" | DisplayStatus;

export default function ExecutionsPage() {
  const { executions, agents, loading, error, reload } = useARIA();
  useFreshSnapshot();
  const [filter, setFilter] = useState<Filter>("all");
  const [agentId, setAgentId] = useState("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(
    () => ({
      all: executions.length,
      allowed: executions.filter((e) => executionDisplayStatus(e) === "allowed").length,
      blocked: executions.filter((e) => executionDisplayStatus(e) === "blocked").length,
      pending: executions.filter((e) => executionDisplayStatus(e) === "pending").length,
      failed: executions.filter((e) => executionDisplayStatus(e) === "failed").length,
      unknown: executions.filter((e) => executionDisplayStatus(e) === "unknown").length,
    }),
    [executions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return executions.filter((e) => {
      const byStatus = filter === "all" || executionDisplayStatus(e) === filter;
      const byAgent = agentId === "all" || e.agentId === agentId;
      const byQuery =
        q.length === 0 ||
        e.action.toLowerCase().includes(q) ||
        e.target.toLowerCase().includes(q) ||
        e.agentName.toLowerCase().includes(q);
      return byStatus && byAgent && byQuery;
    });
  }, [executions, filter, agentId, query]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Executions"
        subtitle="Every action an agent attempted, and what the policy engine decided."
      />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Allowed" value={String(counts.allowed)} icon={CheckCircle2} />
            <StatCard label="Pending" value={String(counts.pending)} icon={Clock} />
            <StatCard label="Blocked" value={String(counts.blocked)} icon={ShieldX} tone="danger" />
            <StatCard label="Failed" value={String(counts.failed)} icon={TriangleAlert} />
            <StatCard label="Unknown outcome" value={String(counts.unknown)} icon={CircleHelp} />
          </div>

          <Surface className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-5 py-4">
              <FilterTabs<Filter>
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All", count: counts.all },
                  { value: "allowed", label: "Allowed" },
                  { value: "blocked", label: "Blocked" },
                  { value: "pending", label: "Pending" },
                  { value: "failed", label: "Failed" },
                  { value: "unknown", label: "Unknown outcome" },
                ]}
              />
              <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
                <select
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  data-testid="select-filter-agent"
                  aria-label="Filter by agent"
                  className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
                >
                  <option value="all">All agents</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder="Filter executions…"
                  className="w-full sm:w-60"
                  testId="input-filter-executions"
                />
              </div>
            </div>
            {loading ? <TableSkeleton rows={8} cols={7} /> : <ExecutionTable executions={filtered} />}
          </Surface>
        </>
      )}
    </div>
  );
}
