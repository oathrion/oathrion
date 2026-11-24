/**
 * « PRÊT À X/5 » (12 novembre 2026, le graal du parcours utilisateur) : en haut de l'accueil, ce
 * que la personne a déjà fait pour être bien protégée, et pour chaque étape qui manque, son geste
 * — un bouton, ou la commande à copier. Lu sur la machine (`/api/local/readiness`), rien
 * d'inventé. Tout fait : la carte se replie en une ligne. « Hide » la cache, dans ce navigateur.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { Link } from "wouter";

import { Surface } from "@/components/common/primitives";
import { PhonePairDialog } from "@/components/settings/PhonePairDialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getReadiness, showDemo, type Readiness } from "@/lib/api";
import { glowOf } from "@/lib/mascot-style";
import { cn } from "@/lib/utils";

const HIDDEN = "oathrion-readiness-hidden";

function hidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN) === "1";
  } catch {
    return false;
  }
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-2 rounded-lg border border-card-border bg-background/40 px-2.5 py-1 font-mono text-xs text-foreground hover:border-primary"
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <span className="truncate">{command}</span>
      {copied ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
    </button>
  );
}

type Step = Readiness["steps"][number];

export function ReadinessCard() {
  const readiness = useQuery({ queryKey: ["/api/local/readiness"], queryFn: getReadiness, refetchInterval: 10_000 });
  const client = useQueryClient();
  const { toast } = useToast();
  const [gone, setGone] = useState(hidden);
  const [pairing, setPairing] = useState(false);
  const demo = useMutation({
    mutationFn: showDemo,
    onSuccess: () => {
      toast({ title: "Look at your notification", description: "Oathrion paused Nova, a pretend agent: click « Stop »." });
      void client.invalidateQueries({ queryKey: ["/api/local/readiness"] });
    },
    onError: (error: Error) => toast({ title: "No notification", description: error.message, variant: "destructive" }),
  });

  const steps = readiness.data?.steps;
  if (!steps || gone) return null;
  /* Le compte ne porte que sur ce qui protège ; donner un nom est un plus, montré sans compter. */
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;

  const LABELS: Record<Step["id"], { title: string; action: (s: Step) => React.ReactNode; done: (s: Step) => string }> = {
    protected: {
      title: "Put your agents' servers behind Oathrion",
      done: (s) => `${String(s.count ?? 0)} server${s.count === 1 ? "" : "s"} behind Oathrion`,
      /* Configuré, mais aucun client ne s'est encore branché : il n'est pas encore protégé. */
      action: (s) =>
        (s.count ?? 0) > 0 ? (
          <span className="text-xs text-amber-500 dark:text-amber-300">Almost: restart Cursor or Claude Code to finish.</span>
        ) : (
          <CopyCommand command="npx oathrion" />
        ),
    },
    demo: {
      title: "See Oathrion stop an agent",
      done: () => "You saw it",
      action: () => (
        <Button size="sm" className="rounded-full" disabled={demo.isPending} onClick={() => demo.mutate()} data-testid="readiness-demo">
          Show me
        </Button>
      ),
    },
    phone: {
      title: "Decide from your phone, anywhere",
      done: (s) => (s.device ? `Paired (${s.device})` : `Paired (Telegram${s.bot ? `, @${s.bot}` : ""})`),
      /* 16 novembre : plus de terminal ni de jeton recopié du téléphone, l'assistant de la console (`PhonePairDialog`). */
      action: () => (
        <Button size="sm" variant="outline" className="rounded-full" onClick={() => setPairing(true)} data-testid="readiness-phone">
          Pair my phone
        </Button>
      ),
    },
    named: {
      title: "Give your agents a face and a name",
      done: () => "Done",
      action: () => (
        <Button asChild size="sm" variant="outline" className="rounded-full">
          <Link href="/agents">Choose</Link>
        </Button>
      ),
    },
    decision: {
      title: "Your first real decision",
      done: () => "Made",
      action: () => <span className="text-xs text-muted-foreground">Comes the first time one of your agents asks.</span>,
    },
  };

  if (done === required.length) {
    return (
      <Surface className="flex items-center gap-3 px-4 py-3 text-sm" data-testid="readiness-done">
        <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
        <span>Ready: Oathrion protects this machine, and reaches you anywhere.</span>
      </Surface>
    );
  }

  return (
    <Surface className="oath-glow relative overflow-hidden p-5" style={glowOf("nova")} data-testid="readiness">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold tracking-tight">
          Setting up: {done} of {required.length} done
        </h2>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            try {
              localStorage.setItem(HIDDEN, "1");
            } catch {
              /* sans stockage, elle reviendra au prochain chargement */
            }
            setGone(true);
          }}
        >
          Hide
        </button>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(done / required.length) * 100}%` }} />
      </div>
      <ol className="mt-4 space-y-3">
        {steps.map((step) => {
          const label = LABELS[step.id];
          return (
            <li key={step.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid={`readiness-${step.id}`}>
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                  step.done ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-400" : "border-card-border text-transparent",
                )}
                aria-label={step.done ? "Done" : "To do"}
              >
                <Check className="h-3.5 w-3.5" />
              </span>
              <span className={cn("min-w-[12rem] flex-1 text-sm", step.done && "text-muted-foreground")}>
                {label.title}
                {step.optional && !step.done ? <span className="ml-2 text-xs text-muted-foreground">optional</span> : null}
                {step.done ? <span className="ml-2 text-xs text-emerald-400">{label.done(step)}</span> : null}
              </span>
              {step.done ? null : <span className="max-w-full">{label.action(step)}</span>}
            </li>
          );
        })}
      </ol>
      <PhonePairDialog open={pairing} onClose={() => setPairing(false)} />
    </Surface>
  );
}
