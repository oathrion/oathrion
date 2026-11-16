/**
 * CHOISIR LA MASCOTTE D'UN AGENT, ET LUI DONNER UN NOM (11 novembre : « l'expérience de choix et
 * de personnalisation »). La personne voit tout de suite ce que donnera sa notification. Le choix
 * vaut pour toute la famille de l'agent, et se voit partout : notifications, fil, console.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { MASCOT_NAMES, agentFamily, mascotIdFor, type MascotId } from "@shared/mascots";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { chooseMascot, getMascots, type MascotCatalog } from "@/lib/api";
import { glowOf } from "@/lib/mascot-style";
import { cn } from "@/lib/utils";

export const MASCOTS_KEY = ["/api/local/mascots"] as const;

/** Le visage d'un agent dans la console : le choix de la personne, sinon la mascotte d'office. */
export function useFaces(): (agent: string) => { id: string; name: string } {
  const { data } = useQuery({ queryKey: MASCOTS_KEY, queryFn: getMascots, retry: false });
  return (agent) => faceOf(data, agent);
}

export function faceOf(data: MascotCatalog | undefined, agent: string): { id: string; name: string } {
  const choice = data?.choices[agentFamily(agent)];
  if (choice) return { id: choice.mascot, name: choice.nickname ?? MASCOT_NAMES[choice.mascot as MascotId] ?? choice.mascot };
  const id = mascotIdFor(agent);
  return { id, name: MASCOT_NAMES[id] };
}

export function MascotPicker({ agent, onClose }: { agent: string | null; onClose: () => void }) {
  const { data } = useQuery({ queryKey: MASCOTS_KEY, queryFn: getMascots, retry: false });
  if (!agent) return null;
  /* Le formulaire part de l'état enregistré à chaque ouverture (la clé le recrée). */
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-xl">
        <Form key={`${agent}-${data ? "ready" : "loading"}`} agent={agent} data={data} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function Form({ agent, data, onClose }: { agent: string; data: MascotCatalog | undefined; onClose: () => void }) {
  const current = faceOf(data, agent);
  const choice = data?.choices[agentFamily(agent)];
  const [mascot, setMascot] = useState(current.id);
  const [nickname, setNickname] = useState(choice?.nickname ?? "");
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const catalog = data?.catalog ?? [];
  const shownName = nickname.trim() || MASCOT_NAMES[mascot as MascotId] || mascot;

  const save = async () => {
    setSaving(true);
    try {
      await chooseMascot(agent, mascot, nickname.trim());
      await Promise.all([MASCOTS_KEY, ["/api/local/feed"], ["/api/local/agents/running"]].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      toast({ title: `${agent} is now ${shownName}`, description: "Its notifications, the feed and the console show it from now on." });
      onClose();
    } catch (error) {
      toast({ title: "That did not work", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Give {agent} a face</DialogTitle>
        <DialogDescription>Choose its mascot and its name: you will recognise it at once when Oathrion stops it.</DialogDescription>
      </DialogHeader>
      <ul className="grid grid-cols-4 gap-3 sm:grid-cols-7" role="radiogroup" aria-label="Mascot">
        {catalog.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              role="radio"
              aria-checked={mascot === m.id}
              onClick={() => setMascot(m.id)}
              className={cn(
                "flex w-full flex-col items-center gap-1 rounded-2xl border border-card-border bg-background/30 p-2 text-[11px] font-medium",
                mascot === m.id && "oath-glow",
              )}
              style={mascot === m.id ? glowOf(m.id) : undefined}
              data-testid={`mascot-option-${m.id}`}
            >
              <img src={`/mascots/${m.id}.png`} alt="" className="h-12 w-12 object-contain" />
              {m.name}
            </button>
          </li>
        ))}
      </ul>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">Its name</span>
        <Input
          value={nickname}
          maxLength={24}
          placeholder={MASCOT_NAMES[mascot as MascotId] ?? ""}
          onChange={(event) => setNickname(event.target.value)}
          data-testid="input-agent-nickname"
        />
      </label>
      {/* L'aperçu : la notification telle qu'elle arrivera. */}
      <div className="oath-glow flex items-center gap-4 rounded-2xl border border-card-border bg-card p-4" style={glowOf(mascot)} data-testid="mascot-preview">
        <img src={`/mascots/${mascot}.png`} alt="" className="h-16 w-16 shrink-0 object-contain" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">Your notification</p>
          <p className="truncate text-[17px] font-semibold tracking-tight">
            {shownName} ({agent}) is paused
          </p>
          <p className="text-[13px] text-muted-foreground">It was running without Oathrion's protection. Nothing is lost.</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving || catalog.length === 0} data-testid="button-save-mascot">
          Save
        </Button>
      </div>
    </>
  );
}
