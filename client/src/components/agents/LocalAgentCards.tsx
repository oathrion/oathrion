/**
 * LES AGENTS, SUR UNE SEULE MACHINE (11 novembre : « enlever tout ce qui rend l'expérience
 * complexe ») : une carte par agent, sa mascotte, ce qu'il a fait aujourd'hui. Pas de coût, de
 * risque ni de filtres d'équipe : ils ne disent rien à une personne seule devant son ordinateur.
 * Chaque agent reçoit le visage que la personne lui choisit (« Customize », `MascotPicker`).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Palette } from "lucide-react";

import { MascotPicker, MASCOTS_KEY, useFaces } from "@/components/agents/MascotPicker";
import { getMascots } from "@/lib/api";
import { compact } from "@/lib/format";
import { glowOf } from "@/lib/mascot-style";
import { cn } from "@/lib/utils";
import type { Agent } from "@/types";

export function LocalAgentCards({ agents }: { agents: Agent[] }) {
  const face = useFaces();
  const [picking, setPicking] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: MASCOTS_KEY, queryFn: getMascots, retry: false });
  if (agents.length === 0) {
    return (
      <p className="rounded-2xl border bg-card p-5 text-sm text-muted-foreground" data-testid="local-agents-empty">
        No agent has gone through Oathrion yet. Run <code className="font-mono">npx oathrion</code> once: your AI agents show up here
        the first time they act.
      </p>
    );
  }
  const nobodyChosen = data !== undefined && Object.keys(data.choices).length === 0;
  return (
    <div className="space-y-3">
      {nobodyChosen ? (
        <p className="flex items-center gap-2 px-1 text-[14px] text-muted-foreground" data-testid="mascot-invite">
          <Palette className="h-4 w-4 text-sidebar-primary" aria-hidden="true" />
          Give each agent a face: choose its mascot and its name. You will recognise it at once in a notification.
        </p>
      ) : null}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="local-agents">
        {agents.map((agent) => {
          const mascot = face(agent.name);
          const paused = agent.status === "paused";
          return (
            <li
              key={agent.id}
              className="oath-glow relative flex items-center gap-4 rounded-2xl border border-card-border bg-card p-5 transition-transform hover:-translate-y-0.5"
              style={glowOf(mascot.id, paused)}
              data-testid={`card-agent-${agent.id}`}
            >
              <button
                type="button"
                onClick={() => setPicking(agent.name)}
                title="Choose its mascot and its name"
                className="group relative z-10 shrink-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                data-testid={`button-customize-${agent.id}`}
              >
                <img src={`/mascots/${mascot.id}.png`} alt={mascot.name} className="h-20 w-20 object-contain drop-shadow-[0_8px_18px_rgba(0,0,0,0.35)] transition-transform group-hover:scale-105" />
                <span className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-card-border bg-background text-sidebar-primary shadow-sm">
                  <Palette className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </button>
              <Link href={`/agents/${agent.id}`} className="min-w-0 flex-1 after:absolute after:inset-0 after:content-['']">
                <p className="truncate text-[17px] font-semibold tracking-tight">{mascot.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {agent.name} · {agent.executions24h > 0 ? `${compact(agent.executions24h)} actions today` : "nothing today"}
                </p>
                <span
                  className={cn(
                    "mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium",
                    paused ? "bg-destructive/15 text-destructive" : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                  )}
                >
                  {paused ? "Paused: its actions are refused" : "Guarded by Oathrion"}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <MascotPicker agent={picking} onClose={() => setPicking(null)} />
    </div>
  );
}
