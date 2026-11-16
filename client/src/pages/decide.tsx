/**
 * LA DÉCISION DANS LA CONSOLE (11 novembre, avant la publication) : sous macOS et Windows, la
 * notification du système n'a qu'un bouton, « Decide ». Il ouvre ici la même carte que la fenêtre
 * de Linux : la mascotte de l'agent, ce qui se passe, ses boutons ; puis ce qui a été fait,
 * « Was this right? », et le partage (la carte s'ouvre dans `/share`, qui la copie et ouvre le
 * réseau). `?e=<identifiant>` (`server/local-decisions.ts`).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2, ThumbsDown, ThumbsUp } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";

import { ErrorState } from "@/components/common/primitives";
import { ReceiptMoment } from "@/components/receipts/ReceiptMoment";
import { Button } from "@/components/ui/button";
import { getDecision, makeDecision, shareDecision, type LocalDecision } from "@/lib/api";
import { accentOf, glowOf } from "@/lib/mascot-style";
import { cn } from "@/lib/utils";
import { MARK_PATH, MARK_VIEWBOX } from "@shared/brand-mark";
import { SHARE_NETWORKS, type ShareNetwork } from "@shared/share";

const NETWORK_LABELS: Record<ShareNetwork, string> = { linkedin: "LinkedIn", x: "X", whatsapp: "WhatsApp" };

export default function DecidePage() {
  const id = new URLSearchParams(useSearch()).get("e") ?? "";
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const key = ["/api/local/decisions", id];
  const decision = useQuery({ queryKey: key, queryFn: () => getDecision(id), enabled: id !== "", retry: false });
  const settle = (next: LocalDecision) => client.setQueryData(key, next);
  const act = useMutation({
    mutationFn: (body: { action: string } | { right: boolean }) => makeDecision(id, body),
    onSuccess: settle,
    onError: (error: Error) => setFailure(error.message),
  });
  const share = useMutation({
    mutationFn: (network: ShareNetwork) => shareDecision(id, network).then(({ token }) => ({ token, network })),
    onSuccess: ({ token, network }) => navigate(`/share?t=${token}&to=${network}`),
    onError: (error: Error) => setFailure(error.message),
  });

  if (id === "" || decision.isError) {
    return (
      <div className="mx-auto max-w-xl pt-10">
        <ErrorState message="This decision is no longer here: it may have been made already. Your agents and what they did are on Home." onRetry={() => navigate("/home")} />
      </div>
    );
  }
  const d = decision.data;
  if (!d) return <div className="mx-auto mt-16 h-72 max-w-xl animate-pulse rounded-3xl bg-card" />;

  const mascot = d.mascot ?? { id: "warden", name: "Warden" };
  const accent = accentOf(mascot.id, d.danger);
  const busy = act.isPending || share.isPending;

  return (
    <div className="mx-auto max-w-xl pt-6 sm:pt-12">
      <section
        className="oath-glow relative overflow-hidden rounded-3xl border bg-card p-6 sm:p-8"
        style={{ ...glowOf(mascot.id, d.danger), borderColor: accent.main }}
        aria-live="polite"
        data-testid="decision-card"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <svg width="20" height="20" viewBox={MARK_VIEWBOX} aria-hidden="true">
            <path fill={accent.main} fillRule="evenodd" d={MARK_PATH} />
          </svg>
          Oathrion
        </div>

        <div className="mt-5 flex flex-col items-center gap-5 text-center sm:flex-row sm:items-start sm:text-left">
          <img
            src={`/mascots/${mascot.id}.png`}
            alt={mascot.name}
            className="h-36 w-36 shrink-0 object-contain"
            style={{ filter: `drop-shadow(0 14px 26px ${accent.main}73)` }}
          />
          <div className="min-w-0 flex-1">
            <h1 className={cn("text-2xl font-bold tracking-tight", d.danger && !d.done && "text-destructive")} data-testid="decision-title">
              {d.done ? d.done.text : d.title}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{d.done ? "Was this right?" : d.body}</p>

            {d.done ? (
              <div className="mt-4 flex justify-center gap-2 sm:justify-start">
                {d.judged ? (
                  <p className="text-sm text-muted-foreground" data-testid="decision-thanks">Thanks: Oathrion learns from it.</p>
                ) : (
                  <>
                    <Button variant="outline" size="icon" className="rounded-full" aria-label="Yes, right" disabled={busy} onClick={() => act.mutate({ right: true })}>
                      <ThumbsUp className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="icon" className="rounded-full" aria-label="No, wrong" disabled={busy} onClick={() => act.mutate({ right: false })}>
                      <ThumbsDown className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="mt-5 flex flex-wrap justify-center gap-2 sm:justify-start">
                {d.actions.map((action, at) => (
                  <Button
                    key={action.id}
                    variant={at === 0 ? "default" : "outline"}
                    className="rounded-full"
                    disabled={busy}
                    data-testid={`decision-${action.id}`}
                    /* « See what happened » : le fil, ici même. */
                    onClick={() => (action.id === "open" ? navigate("/home") : act.mutate({ action: action.id }))}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>

        {d.share && (d.done || d.danger) ? (
          <div className="mt-6 rounded-2xl border bg-background/40 p-4" data-testid="decision-share">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Share2 className="h-4 w-4" aria-hidden="true" /> Share it
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Your card, with {mascot.name}: nothing private, just what Oathrion did.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {SHARE_NETWORKS.map((network, at) => (
                <Button key={network} size="sm" variant={at === 0 ? "default" : "outline"} className="rounded-full" disabled={busy} onClick={() => share.mutate(network)}>
                  {NETWORK_LABELS[network]}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {failure ? <p className="mt-4 text-sm text-destructive">{failure}</p> : null}
      </section>

      {/* Une demande d'approbation tranchée : son reçu signé sort juste en dessous. */}
      {d.done && d.executionId ? (
        <div className="mt-4">
          <ReceiptMoment executionRef={d.executionId} />
        </div>
      ) : null}

      <p className="mt-4 text-center text-xs text-muted-foreground">
        <Link href="/home" className="underline-offset-4 hover:underline">Back to Home</Link>
      </p>
    </div>
  );
}
