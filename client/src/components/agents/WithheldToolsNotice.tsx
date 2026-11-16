/**
 * Les outils qu'Oathrion cache à un agent, faute d'une permission — et le geste pour les
 * autoriser, ici, en un clic.
 *
 * Trouvé dans l'essai réel du 28 octobre 2026 (STRESS-TEST-LOG §5.57) : le serveur de
 * fichiers déclare `write_file` destructeur, l'outil disparaissait pour l'agent, l'agent
 * inventait une raison, et la personne devait trouver « Agents → l'agent → Permissions →
 * Modifier → Détruire → Enregistrer », puis relancer son client. Personne ne le trouvait
 * seul. Autorisés, ces outils restent soumis à la règle par défaut : chaque appel attend
 * l'accord de la personne.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { PERMISSION_CATALOG } from "@/data/agents";
import { listWithheldTools, type WithheldToolsEntry } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useARIA } from "@/lib/store";

const QUERY_KEY = ["/api/withheld-tools"] as const;

export function WithheldToolsNotice({ agentId }: { agentId?: string }) {
  const { can } = useAuth();
  const canManage = can("manage");
  const { agents, updateAgentPermissions } = useARIA();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: listWithheldTools });

  const entries = (data ?? []).filter((entry) => agentId === undefined || entry.agentId === agentId);
  if (entries.length === 0) return null;

  const allow = async (entry: WithheldToolsEntry) => {
    const agent = agents.find((candidate) => candidate.id === entry.agentId);
    if (!agent) return;
    setBusy(entry.agentId);
    try {
      const needed = new Set(entry.tools.map((tool) => tool.scope).filter((scope): scope is string => scope !== null));
      const permissions = agent.permissions.map((p) => (needed.has(p.scope) ? { ...p, granted: true } : p));
      for (const scope of needed) {
        if (permissions.some((p) => p.scope === scope)) continue;
        const fromCatalog = PERMISSION_CATALOG.find((p) => p.scope === scope);
        if (fromCatalog) permissions.push({ ...fromCatalog, granted: true });
      }
      await updateAgentPermissions(agent.id, permissions);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({
        title: "Tools allowed",
        description: "Each call will wait for your approval. Restart your MCP client (Cursor…): it reads the tool list when it starts.",
      });
    } catch (error) {
      toast({
        title: "The tools could not be allowed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="withheld-tools">
      {entries.map((entry) => {
        const servers = [...new Set(entry.tools.map((tool) => tool.server))].join(", ");
        const destructive = entry.tools.some((tool) => tool.toolClass === "destructive");
        return (
          <section key={entry.agentId} className="flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
            <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium">
                {entry.agentName} cannot see {entry.tools.length} tool{entry.tools.length > 1 ? "s" : ""} of "{servers}":{" "}
                <span className="font-mono text-xs">{entry.tools.map((tool) => tool.name).join(", ")}</span>
              </p>
              <p className="text-muted-foreground">
                {destructive ? "They can destroy things: delete, overwrite, move or run. " : ""}
                If you show {entry.tools.length > 1 ? "them" : "it"} to the agent, every use still waits for your yes.
              </p>
            </div>
            {canManage ? (
              <Button size="sm" disabled={busy === entry.agentId} onClick={() => void allow(entry)} data-testid={`button-allow-withheld-${entry.agentId}`}>
                {busy === entry.agentId ? "Showing…" : entry.tools.length > 1 ? "Show them" : "Show it"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">A person who manages agents can allow them.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
