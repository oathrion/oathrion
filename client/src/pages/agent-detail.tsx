import { Link, useRoute } from "wouter";
import { ArrowLeft, Bot, Pause, Play, ShieldCheck } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  KeyValue,
  PageHeader,
  SectionCard,
  Surface,
  TableSkeleton,
} from "@/components/common/primitives";
import { AgentStatusBadge, Pill, RiskBadge } from "@/components/common/badges";
import { MandateCard } from "@/components/agents/MandateCard";
import { PermissionsCard } from "@/components/agents/PermissionsCard";
import { WithheldToolsNotice } from "@/components/agents/WithheldToolsNotice";
import { DoorsPanel, DoorsVerdictBadge, doorsKey } from "@/components/agents/DoorsPanel";
import { getAgentDoors } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { ExecutionTable } from "@/components/executions/ExecutionTable";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { useARIA } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { PROVIDER_LABEL } from "@/data/agents";
import { currency, percent } from "@/lib/format";
import { agentToggleAffordance, agentToggleDisabled } from "@/lib/agent-presentation";

export default function AgentDetailPage() {
  const [, params] = useRoute("/agents/:id");
  const { agents, executions, policies, activity, loading, error, reload, toggleAgentStatus } = useARIA();
  const { can } = useAuth();
  const canManage = can("manage");
  const agent = agents.find((a) => a.id === params?.id);
  /* Même clé de cache que le panneau : la pastille et le panneau lisent la même réponse. */
  const doors = useQuery({
    queryKey: doorsKey(params?.id ?? ""),
    queryFn: () => getAgentDoors(params?.id ?? ""),
    enabled: Boolean(params?.id && agent),
    staleTime: 0,
  });

  if (loading) {
    return (
      <div className="space-y-6">
        <Surface className="p-6">
          <TableSkeleton rows={3} cols={3} />
        </Surface>
      </div>
    );
  }

  // A failed snapshot is recoverable; it is not evidence that the record was deleted.
  if (error) return <ErrorState message={error} onRetry={reload} />;

  if (!agent) {
    return (
      <Surface>
        <EmptyState
          icon={Bot}
          title="Agent not found"
          description="This agent may have been deleted, or you do not have access to it."
          action={
            <Link
              href="/agents"
              className="inline-flex h-9 items-center rounded-lg border border-card-border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              Back to agents
            </Link>
          }
        />
      </Surface>
    );
  }

  const agentExecutions = executions.filter((e) => e.agentId === agent.id).slice(0, 8);
  const agentPolicies = policies.filter((p) => agent.policyIds.includes(p.id));
  const agentActivity = activity.filter((a) => a.actor === agent.name).slice(0, 6);

  return (
    <div className="space-y-6">
      <Link
        href="/agents"
        data-testid="link-back-agents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Agents
      </Link>

      <PageHeader
        title={agent.name}
        subtitle={agent.description}
        actions={
          <div className="flex items-center gap-2">
            <AgentStatusBadge status={agent.status} />
            {(() => {
              // One shared rule, tested in `agent-presentation.test.ts`. A draft
              // agent is activatable: disabling it here is what previously made
              // `draft` a terminal state in the console.
              const toggle = agentToggleAffordance(agent.status);
              return (
                <button
                  onClick={() => {
                    // Re-checked: `disabled` is a browser hint, not a boundary.
                    if (agentToggleDisabled(agent.status, canManage)) return;
                    void toggleAgentStatus(agent.id);
                  }}
                  disabled={agentToggleDisabled(agent.status, canManage)}
                  title={toggle.unavailableReason}
                  data-testid="button-pause-agent"
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-card-border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {toggle.icon === "pause" ? (
                    <Pause className="h-4 w-4" aria-hidden />
                  ) : (
                    <Play className="h-4 w-4" aria-hidden />
                  )}{" "}
                  {toggle.label}
                </button>
              );
            })()}
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <SectionCard title="Overview" bodyClassName="grid gap-x-8 px-5 sm:grid-cols-3">
            <KeyValue label="Provider">{PROVIDER_LABEL[agent.provider]}</KeyValue>
            <KeyValue label="Model">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{agent.model}</code>
            </KeyValue>
            <KeyValue label="Owner">{agent.owner}</KeyValue>
            <KeyValue label="Risk level">
              <RiskBadge risk={agent.riskLevel} />
            </KeyValue>
            <KeyValue label="Cost (24 h)">
              <span className="tabular">{currency(agent.cost24h)}</span>
            </KeyValue>
            <KeyValue label="Cost (month)">
              <span className="tabular">{currency(agent.costMonth)}</span>
            </KeyValue>
            <KeyValue label="Executions (24 h)">
              <span className="tabular">{agent.executions24h}</span>
            </KeyValue>
            <KeyValue label="Success rate">
              {/* Zero is an operational result, not a missing value. */}
              <span className="tabular">
                {agent.successRate === null || agent.successRate === undefined ? "—" : percent(agent.successRate)}
              </span>
            </KeyValue>
            <KeyValue label="Created on">{agent.createdAt}</KeyValue>
          </SectionCard>

          <MandateCard agent={agent} />

          <WithheldToolsNotice agentId={agent.id} />

          <PermissionsCard agent={agent} />

          {/*
            Les portes : l'agent garde-t-il une route qui contourne Oathrion ? L'état est
            celui du serveur, qui le garde depuis « Ajouter un agent existant ».
          */}
          <SectionCard
            title="Direct access to tools"
            description="Does the agent keep a key that would let it act without going through Oathrion?"
            action={doors.data && doors.data.tools.length > 0 ? <DoorsVerdictBadge verdict={doors.data.verdict} /> : undefined}
          >
            <DoorsPanel agentId={agent.id} canManage={canManage} />
          </SectionCard>

          <SectionCard
            title="Recent executions"
            description="The latest actions that went through the policy engine."
            action={
              <Link href="/executions" className="text-xs font-medium text-primary hover:opacity-70">
                See all
              </Link>
            }
          >
            <ExecutionTable executions={agentExecutions} compactMode />
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard title="Policies" description="The rules evaluated before each action.">
            {agentPolicies.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No policy attached"
                description="This agent has no extra guardrail."
              />
            ) : (
              <ul className="divide-y divide-card-border">
                {agentPolicies.map((p) => (
                  <li key={p.id} className="px-5 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium">{p.name}</p>
                      <Pill tone={p.effect === "block" ? "danger" : p.effect === "warn" ? "info" : "warning"}>
                        {p.effect.replace("_", " ")}
                      </Pill>
                    </div>
                    <code className="mt-1.5 block font-mono text-[11px] text-muted-foreground">{p.rule}</code>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Activity" description="This agent's latest events.">
            <ActivityFeed events={agentActivity} />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
