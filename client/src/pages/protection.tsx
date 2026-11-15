/**
 * « Protection » — ce qu'Oathrion couvre réellement sur cette machine, agent par agent, et ce
 * qu'il ne voit pas. La promesse (« il s'interpose sur chaque action ») n'est vraie que de ce
 * qui passe par lui : cet écran le dit porte par porte, sans arrondir.
 *
 * Tout vient du serveur (`server/local-protection.ts`) : l'écran n'ajoute rien, ne calcule
 * rien, et ne change aucune configuration. Ce qui peut l'être l'est par `npx oathrion`, dans un
 * terminal, après avoir montré la liste et demandé.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { EyeOff, ShieldAlert, ShieldCheck, ShieldHalf } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { ErrorState, PageHeader, Surface, TableSkeleton } from "@/components/common/primitives";
import { getLocalProtection, type Coverage, type ProtectionItem } from "@/lib/api";
import { Logo } from "@/components/layout/Logo";
import { glowOf } from "@/lib/mascot-style";
import { CopyCommand } from "@/pages/servers";

const STATE: Record<Coverage, { text: string; icon: LucideIcon; tint: string; ink: string; bar: string }> = {
  protected: { text: "Protected", icon: ShieldCheck, tint: "bg-success-soft text-success", ink: "text-success", bar: "bg-success" },
  checked: { text: "Checked by rules", icon: ShieldHalf, tint: "bg-info-soft text-info", ink: "text-info", bar: "bg-info" },
  bypasses: { text: "Bypasses Oathrion", icon: ShieldAlert, tint: "bg-warning-soft text-warning", ink: "text-warning", bar: "bg-warning" },
  blind: { text: "Not visible to Oathrion", icon: EyeOff, tint: "bg-muted text-muted-foreground", ink: "text-muted-foreground", bar: "bg-muted-foreground/40" },
};

function Item({ item }: { item: ProtectionItem }) {
  const state = STATE[item.coverage];
  const Icon = state.icon;
  return (
    <li className="flex items-start gap-3.5 px-5 py-4" data-testid={`protection-${item.coverage}`}>
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${state.tint}`} aria-hidden>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-[15px] font-medium">
            {item.what}
            {item.kind === "mcp-server" && <span className="font-normal text-muted-foreground"> · MCP server</span>}
          </p>
          <span className={`text-[13px] font-medium ${state.ink}`}>{state.text}</span>
        </div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          {item.why}
          {item.where ? <span className="text-muted-foreground/80"> · {item.where}</span> : null}
        </p>
      </div>
    </li>
  );
}

export default function ProtectionPage() {
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ["/api/local/protection"], queryFn: getLocalProtection, refetchInterval: 10_000 });

  if (isError) {
    return <ErrorState message={error instanceof Error ? error.message : "The protection could not be read."} onRetry={() => void refetch()} />;
  }
  const fixable = data ? data.agents.some((agent) => agent.items.some((item) => item.fix !== null)) : false;
  const total = data ? data.counts.protected + data.counts.checked + data.counts.bypasses + data.counts.blind : 0;
  const covered = data ? data.counts.protected + data.counts.checked : 0;
  return (
    <div className="space-y-6">
      <PageHeader title="Protection" subtitle="What Oathrion covers on this machine, agent by agent, and what it cannot see." />
      {isLoading || !data ? (
        <TableSkeleton rows={4} cols={2} />
      ) : data.agents.length === 0 ? (
        <Surface className="px-6 py-14 text-center">
          <h2 className="text-[20px] font-semibold tracking-[-0.02em]">No agent found on this machine.</h2>
          <p className="mx-auto mt-1.5 max-w-sm text-[15px] text-muted-foreground">Oathrion looks for Claude Code, Cursor and Claude Desktop. Once one is installed, run <code className="font-mono text-[13px]">npx oathrion</code>.</p>
        </Surface>
      ) : (
        <>
          <Surface className="oath-glow space-y-5 p-6" style={glowOf("warden", covered !== total && data.counts.bypasses > 0)} data-testid="protection-summary">
            <div className="flex items-center gap-5">
              <Logo className="h-16 w-16 shrink-0 drop-shadow-[0_0_22px_rgba(150,62,255,0.55)]" />
              <div>
                <p className="text-[13px] font-medium text-muted-foreground">On this machine</p>
                <h2 className="mt-1 text-[24px] font-semibold leading-tight tracking-[-0.022em]">
                  {covered === total ? "Everything Oathrion can see is covered." : `${String(covered)} of ${String(total)} ways your agents act are covered.`}
                </h2>
              </div>
            </div>
            <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              {(["protected", "checked", "bypasses", "blind"] as const)
                .filter((coverage) => data.counts[coverage] > 0)
                .map((coverage) => (
                  <div key={coverage} className={STATE[coverage].bar} style={{ width: `${(data.counts[coverage] / total) * 100}%` }} />
                ))}
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {(["protected", "checked", "bypasses", "blind"] as const).map((coverage) => (
                <div key={coverage}>
                  <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    <span className={`h-2 w-2 rounded-full ${STATE[coverage].bar}`} aria-hidden />
                    {STATE[coverage].text}
                  </p>
                  <p className="mt-0.5 text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{data.counts[coverage]}</p>
                </div>
              ))}
            </div>
            {fixable && (
              <div className="space-y-2 rounded-xl bg-warning-soft/60 p-4">
                <p className="text-[14px] font-medium">What bypasses Oathrion can be put behind it.</p>
                <p className="text-[13px] text-muted-foreground">In a terminal, this command shows the list and changes nothing until you agree:</p>
                <CopyCommand command="npx oathrion" />
              </div>
            )}
          </Surface>
          {data.agents.map((agent) => (
            <section key={agent.client} className="space-y-2" data-testid={`protection-agent-${agent.client}`}>
              <h2 className="px-1 text-[13px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{agent.client}</h2>
              <Surface className="overflow-hidden p-0">
                <ul className="divide-y divide-card-border">
                  {agent.items.map((item) => (
                    <Item key={`${item.what}-${item.where ?? ""}`} item={item} />
                  ))}
                </ul>
              </Surface>
            </section>
          ))}
          <p className="px-1 text-[13px] leading-relaxed text-muted-foreground">
            Whatever Oathrion covers, an agent with an unrestricted shell on this machine could read Oathrion's own files. Keep your client's approval on for its shell. What every action
            did is in{" "}
            <Link href="/activity" className="text-primary hover:underline">
              Activity
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
