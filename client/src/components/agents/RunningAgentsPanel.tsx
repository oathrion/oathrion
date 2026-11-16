/**
 * « RUNNING NOW » : chaque agent d'IA qui tourne sur la machine, et où (10 novembre), sur
 * l'accueil, la page des agents et celle des approbations. Sobre (11 novembre : « enlever tout ce
 * qui rend l'expérience complexe ») : UNE ligne par agent et par état — sa mascotte, un mot
 * d'état, combien de fois il tourne —, une phrase courte, les boutons ; les chemins et numéros de
 * processus repliés derrière « details ». Les boutons d'une ligne agissent sur tous ses processus.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { actOnRunningAgent, getTripwire, listRunningAgents, revokeOutsideAllowance, type RunningAgent } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MascotPicker } from "@/components/agents/MascotPicker";
import { glowOf } from "@/lib/mascot-style";
import { cn } from "@/lib/utils";

const QUERY_KEY = ["/api/local/agents/running"] as const;

type State = "jailed" | "paused" | "allowed" | "once" | "outside";

const STATE: Record<State, { label: string; badge: string; line: (agent: string) => string }> = {
  jailed: { label: "Protected", badge: "bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-300", line: () => "It cannot go around Oathrion." },
  paused: { label: "Paused", badge: "bg-red-500/15 text-red-600 ring-1 ring-inset ring-red-500/30 dark:text-red-300", line: () => "It was running without Oathrion's protection. Nothing it was doing is lost." },
  outside: { label: "Not protected", badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400", line: () => "It can go around Oathrion." },
  once: { label: "Resumed this time", badge: "bg-muted text-muted-foreground", line: () => "Next time it starts without Oathrion's protection, it is paused again." },
  allowed: { label: "Allowed without Oathrion", badge: "bg-muted text-muted-foreground", line: () => "You let it run without Oathrion's protection." },
};

const stateOf = (agent: RunningAgent): State => (agent.jailed ? "jailed" : agent.paused ? "paused" : agent.allowedOutside ? "allowed" : agent.allowedOnce ? "once" : "outside");

interface Group {
  key: string;
  agent: string;
  state: State;
  mascot?: { id: string; name: string };
  members: RunningAgent[];
}

export function RunningAgentsPanel() {
  const { can } = useAuth();
  const canManage = can("manage");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  /* Une console d'équipe n'a pas de pivot : la route répond 404, et rien ne s'affiche. */
  const { data, isError } = useQuery({ queryKey: QUERY_KEY, queryFn: listRunningAgents, retry: false, refetchInterval: 5_000 });
  const { data: trip } = useQuery({ queryKey: ["/api/local/tripwire"], queryFn: getTripwire, retry: false, refetchInterval: 5_000 });
  if (isError || !data) return null;

  const groups: Group[] = [];
  for (const agent of data) {
    const state = stateOf(agent);
    const key = `${agent.agent}|${state}`;
    const group = groups.find((g) => g.key === key);
    if (group) group.members.push(agent);
    else groups.push({ key, agent: agent.agent, state, ...(agent.mascot ? { mascot: agent.mascot } : {}), members: [agent] });
  }
  const order: State[] = ["paused", "outside", "once", "allowed", "jailed"];
  groups.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));

  const run = async (group: Group, what: "stop" | "allow" | "revoke") => {
    setBusy(group.key);
    try {
      if (what === "revoke") await revokeOutsideAllowance(group.members[0]!.exe);
      else for (const member of group.members) await actOnRunningAgent(member.pid, what);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ["/api/local/feed"] });
      toast({
        title: what === "stop" ? `${group.agent} stopped` : what === "allow" ? `${group.agent} may run without Oathrion's protection` : `${group.agent} must run with Oathrion's protection again`,
        description:
          what === "stop" ? `Start it again protected: « oathrion jail -- ${group.agent} ».` : what === "allow" ? "It goes on where it was. « Stop allowing », here, undoes it." : "Started without Oathrion's protection, it is paused again.",
      });
    } catch (error) {
      toast({ title: "That did not work", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-2 rounded-2xl border border-card-border bg-card p-5 text-sm" data-testid="running-agents">
      <h2 className="text-[13px] font-semibold text-muted-foreground">Running now</h2>
      {groups.length === 0 ? (
        <p className="text-muted-foreground">No AI agent is running on this machine right now.</p>
      ) : (
        <ul className="divide-y">
          {groups.map((group) => {
            const look = STATE[group.state];
            const many = group.members.length > 1;
            return (
              <li key={group.key} className="py-3" data-testid={`running-group-${group.agent}-${group.state}`}>
                <div className="flex flex-wrap items-center gap-3">
                  {group.mascot ? (
                    <button
                      type="button"
                      onClick={() => setPicking(group.agent)}
                      title="Choose its mascot and its name"
                      className="oath-glow flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-background/40"
                      style={glowOf(group.mascot.id, group.state === "paused")}
                      data-testid={`button-customize-running-${group.agent}`}
                    >
                      <img src={`/mascots/${group.mascot.id}.png`} alt={group.mascot.name} className="h-10 w-10 object-contain" />
                    </button>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-medium">{group.mascot ? `${group.mascot.name} · ${group.agent}` : group.agent}</span>
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", look.badge)}>{look.label}</span>
                      {many ? <span className="text-xs text-muted-foreground">×{group.members.length}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {look.line(group.agent)}{" "}
                      <button type="button" className="underline-offset-2 hover:underline" onClick={() => setOpen(open === group.key ? null : group.key)} data-testid={`button-details-${group.agent}-${group.state}`}>
                        {open === group.key ? "hide details" : "details"}
                      </button>
                    </p>
                  </div>
                  {canManage && group.state !== "jailed" ? (
                    <div className="flex gap-2">
                      {group.state === "allowed" ? (
                        <Button size="sm" variant="outline" disabled={busy === group.key} onClick={() => void run(group, "revoke")} data-testid={`button-revoke-${group.agent}`}>
                          Stop allowing
                        </Button>
                      ) : group.state === "paused" || group.state === "outside" ? (
                        <Button size="sm" variant="outline" disabled={busy === group.key} onClick={() => void run(group, "allow")} data-testid={`button-allow-${group.agent}`}>
                          {group.state === "paused" ? "Resume & allow" : "Allow"}
                        </Button>
                      ) : null}
                      <Button size="sm" variant={group.state === "paused" || group.state === "outside" ? "default" : "outline"} disabled={busy === group.key} onClick={() => void run(group, "stop")} data-testid={`button-stop-${group.agent}-${group.state}`}>
                        {many ? "Stop all" : "Stop"}
                      </Button>
                    </div>
                  ) : null}
                </div>
                {open === group.key ? (
                  <ul className="mt-2 space-y-0.5 pl-[60px] font-mono text-[11px] text-muted-foreground">
                    {group.members.map((member) => (
                      <li key={member.launch} className="break-all">
                        {member.exe}
                        {member.script ? ` ${member.script}` : ""} · process {member.pid}
                        {member.allowance ? ` · allowed by ${member.allowance.by}` : ""}
                      </li>
                    ))}
                    {group.state !== "jailed" ? <li className="font-sans">To run it where it cannot go around Oathrion: oathrion jail -- {group.agent}</li> : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {trip && trip.events.length > 0 ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive" data-testid="decoys-read">
          A decoy was read: no honest task reads it. See « What happened ».
        </p>
      ) : null}
      <MascotPicker agent={picking} onClose={() => setPicking(null)} />
    </section>
  );
}
