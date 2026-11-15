/**
 * Les programmes qu'Oathrion n'a jamais vus (demandé par l'utilisateur le 9 novembre) : rien de
 * ce qu'ils demandent ne passe — pas même une lecture — tant qu'une personne ne les a pas
 * confirmés ici. On montre ce qu'on SAIT (l'exécutable réel, son empreinte) à côté de ce que le
 * programme DIT (son nom), pour qu'un faux « Claude Code » se voie.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { decideProgram, listPrograms, type KnownProgram } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const QUERY_KEY = ["/api/local/programs"] as const;

export function UnknownProgramsNotice() {
  const { can } = useAuth();
  const canManage = can("manage");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  /* Une console d'équipe n'a pas de pivot : la route répond 404, et rien ne s'affiche. */
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: listPrograms, retry: false, refetchInterval: 5_000 });

  const pending = (data ?? []).filter((program) => program.status === "pending");
  if (pending.length === 0) return null;

  const decide = async (program: KnownProgram, decision: "trust" | "block") => {
    setBusy(program.id);
    try {
      await decideProgram(program.id, decision);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({
        title: decision === "trust" ? "Program confirmed" : "Program blocked",
        description: decision === "trust" ? `"${program.name}" goes through Oathrion again, under your rules. It picks up on its own within a few seconds.` : `Nothing "${program.name}" asks will go through.`,
      });
    } catch (error) {
      toast({ title: "The decision could not be saved", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="unknown-programs">
      {pending.map((program) => (
        <section key={program.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">A program Oathrion has never seen wants to use your servers. It says it is "{program.name}".</p>
            {program.identity ? (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {program.identity.exe}
                {program.identity.script ? ` ${program.identity.script}` : ""} · sha256 {program.identity.sha256.slice(0, 16)}…
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Its executable could not be read on this system: only the name it gives is known.</p>
            )}
            <p className="text-muted-foreground">
              Until you confirm it, nothing it asks goes through — not even a read. Confirm it only if you started this program yourself.
            </p>
          </div>
          {canManage ? (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === program.id} onClick={() => void decide(program, "trust")} data-testid={`button-trust-program-${program.id}`}>
                It's mine, confirm
              </Button>
              <Button size="sm" variant="outline" disabled={busy === program.id} onClick={() => void decide(program, "block")} data-testid={`button-block-program-${program.id}`}>
                Block it
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">A person who manages agents can confirm it.</p>
          )}
        </section>
      ))}
    </div>
  );
}
