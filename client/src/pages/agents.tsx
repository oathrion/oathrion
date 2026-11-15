import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Plug, Plus } from "lucide-react";
import {
  ErrorState,
  FilterTabs,
  PageHeader,
  SearchInput,
  Surface,
  TableSkeleton,
} from "@/components/common/primitives";
import { AgentTable } from "@/components/agents/AgentTable";
import { useARIA, useFreshSnapshot } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { useLocalMode } from "@/lib/local-mode";
import type { AgentStatus } from "@/types";
import { LocalAgentCards } from "@/components/agents/LocalAgentCards";
import { RunningAgentsPanel } from "@/components/agents/RunningAgentsPanel";

type Filter = "all" | Extract<AgentStatus, "active" | "paused"> | "draft";

export default function AgentsPage() {
  const { agents, loading, error, reload, toggleAgentStatus } = useARIA();
  useFreshSnapshot();
  const { can } = useAuth();
  const canManage = can("manage");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(
    () => ({
      all: agents.length,
      active: agents.filter((a) => a.status === "active").length,
      paused: agents.filter((a) => a.status === "paused").length,
      draft: agents.filter((a) => a.status === "draft").length,
    }),
    [agents],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      const matchesFilter = filter === "all" || a.status === filter;
      const matchesQuery =
        q.length === 0 ||
        a.name.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q) ||
        a.tags.some((t) => t.includes(q));
      return matchesFilter && matchesQuery;
    });
  }, [agents, filter, query]);

  const local = useLocalMode();
  const newAgentButton = canManage ? (
    <Link
      href="/agents/new"
      data-testid="link-new-agent"
      className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Plus className="h-4 w-4" aria-hidden />
      New agent
    </Link>
  ) : null;

  /* L'entrée la plus fréquente d'une équipe qui a déjà des agents : les brancher, pas les recréer. */
  const connectExistingButton = canManage ? (
    <Link
      href="/agents/connect"
      data-testid="link-connect-existing-agent"
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Plug className="h-4 w-4" aria-hidden />
      Add an existing agent
    </Link>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        subtitle={local ? "The AI agents on this machine, and what Oathrion lets them do." : "All the AI agents of your organisation."}
        actions={
          local ? undefined : (
            <div className="flex flex-wrap gap-2">
              {connectExistingButton}
              {newAgentButton}
            </div>
          )
        }
      />

      <RunningAgentsPanel />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : local ? (
        loading ? <TableSkeleton rows={3} cols={1} /> : <LocalAgentCards agents={agents} />
      ) : (
        <Surface className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-5 py-4">
            <FilterTabs<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All", count: counts.all },
                { value: "active", label: "Active", count: counts.active },
                { value: "paused", label: "Paused", count: counts.paused },
                { value: "draft", label: "Drafts", count: counts.draft },
              ]}
            />
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Filter agents…"
              className="w-full sm:w-64"
              testId="input-filter-agents"
            />
          </div>
          {loading ? (
            <TableSkeleton rows={6} cols={7} />
          ) : (
            <AgentTable
              agents={filtered}
              onToggleStatus={toggleAgentStatus}
              showRisk
              emptyAction={
                <div className="flex flex-wrap justify-center gap-2">
                  {connectExistingButton}
                  {newAgentButton}
                </div>
              }
            />
          )}
        </Surface>
      )}
    </div>
  );
}
