/**
 * L'ACCUEIL DE LA CONSOLE LOCALE (11 novembre) : ce qui tourne en ce moment, et le FIL
 * D'ACTUALITÉ — ce qu'Oathrion a fait et ce que la personne a décidé, en phrases simples, avec la
 * mascotte de l'agent, et un bouton pour le partager (`components/feed/ShareDialog.tsx`).
 * `?share=<id>` ouvre le partage d'un élément (le bouton « Share » de la notification y mène).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { Newspaper, Share2 } from "lucide-react";

import { RunningAgentsPanel } from "@/components/agents/RunningAgentsPanel";
import { EmptyState, ErrorState, PageHeader, Surface, TableSkeleton } from "@/components/common/primitives";
import { ShareDialog } from "@/components/feed/ShareDialog";
import { ReadinessCard } from "@/components/home/ReadinessCard";
import { StoppedCard } from "@/components/home/StoppedCard";
import { Button } from "@/components/ui/button";
import { getFeed, listRunningAgents, type FeedItem } from "@/lib/api";
import { useARIA } from "@/lib/store";
import { relativeTime } from "@/lib/format";
import { glowOf } from "@/lib/mascot-style";
import { cn } from "@/lib/utils";

/* Le ton d'un élément : un point de couleur, discret ; la mascotte porte le reste. */
const TONE: Record<FeedItem["tone"], { dot: string; label: string }> = {
  good: { dot: "bg-emerald-400", label: "Protected" },
  warn: { dot: "bg-amber-400", label: "Needs you" },
  bad: { dot: "bg-red-500", label: "Alert" },
  info: { dot: "bg-muted-foreground/60", label: "" },
};

/** Le fil de l'accueil : les plus récents ; le reste est dans Activity (16 novembre, la passe de concentration). */
const FEED_SHOWN = 8;

/**
 * Ce qui se partage : un moment où Oathrion a protégé (un arrêt, un refus, un leurre lu, un agent
 * mis en pause, une décision). Pas « did one thing through Oathrion: shell », ni chaque commande
 * approuvée : un bouton « Share » sur chaque ligne n'en signalait plus aucune.
 */
function worthSharing(item: FeedItem): boolean {
  if (item.tone === "info") return false;
  return !(item.id.startsWith("apr_") && item.tone === "good");
}

/**
 * L'en-tête de l'accueil : Warden, la mascotte d'Oathrion, et la journée en trois chiffres tirés
 * du fil (ce qui a été protégé, ce qui attend, les alertes). Rien d'inventé : sans fil, la démo.
 */
function Hero({ items }: { items: FeedItem[] }) {
  /* L'heure d'ouverture de la page : le fil se relit toutes les 5 s, pas besoin d'une horloge qui bat. */
  const [openedAt] = useState(() => Date.now());
  const since = openedAt - 24 * 3_600_000;
  const today = items.filter((item) => Date.parse(item.at) >= since);
  const count = (tone: FeedItem["tone"]) => today.filter((item) => item.tone === tone).length;
  const alerts = count("bad");
  /*
   * « Needs you » : ce qui attend MAINTENANT (16 novembre, essai filmé : « Something needs a
   * look » et « Needs you 1 » quand plus rien n'était en attente — le compteur reprenait les
   * événements « à regarder » des dernières 24 h). Les demandes en attente, et les agents en pause.
   */
  const { approvals } = useARIA();
  const running = useQuery({ queryKey: ["/api/local/agents/running"], queryFn: listRunningAgents, retry: false, refetchInterval: 5_000 });
  const waiting = approvals.filter((a) => a.status === "pending").length + (running.data ?? []).filter((a) => a.paused).length;
  const headline = alerts > 0 ? "Oathrion stepped in today." : waiting > 0 ? "Something needs a look." : "Your AI agents are under watch.";
  return (
    <Surface className="oath-glow relative overflow-hidden p-6" style={glowOf("warden", alerts > 0)} data-testid="home-hero">
      <div className="flex flex-wrap items-center gap-6">
        <img src="/mascots/warden.png" alt="Warden" className="h-24 w-24 shrink-0 object-contain" />
        {/* Une largeur minimale : sur un écran étroit, ce sont les chiffres qui passent dessous, pas le titre qui s'écrase. */}
        <div className="min-w-[15rem] flex-1">
          <p className="text-[13px] font-medium text-muted-foreground">Today, on this machine</p>
          <h2 className="mt-1 font-serif text-[26px] font-medium leading-tight">{headline}</h2>
          {/* La démo n'est plus proposée ici : la carte « Ready » juste en dessous a son bouton « Show me ». */}
        </div>
        <dl className="flex gap-3">
          {(
            [
              ["Protected", count("good"), "text-emerald-500 dark:text-emerald-300"],
              ["Needs you", waiting, "text-amber-500 dark:text-amber-300"],
              ["Alerts", alerts, "text-red-500 dark:text-red-300"],
            ] as const
          ).map(([label, value, ink]) => (
            <div key={label} className="min-w-[92px] rounded-xl border border-card-border bg-background/30 px-4 py-3 text-center">
              <dd className={cn("text-[28px] font-semibold leading-none tabular-nums", value > 0 ? ink : "text-muted-foreground")}>{value}</dd>
              <dt className="mt-1.5 text-[12px] text-muted-foreground">{label}</dt>
            </div>
          ))}
        </dl>
      </div>
    </Surface>
  );
}

export default function HomePage() {
  const search = useSearch();
  const wanted = new URLSearchParams(search).get("share");
  const feed = useQuery({ queryKey: ["/api/local/feed"], queryFn: getFeed, refetchInterval: 5_000 });
  const [sharing, setSharing] = useState<FeedItem | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  /* Venu du bouton « Share » d'une notification : le partage s'ouvre tout seul, une fois. */
  if (wanted && opened !== wanted && feed.data) {
    const item = feed.data.find((i) => i.id === wanted);
    if (item) {
      setOpened(wanted);
      setSharing(item);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Home" subtitle="What your AI agents are doing, and what Oathrion did about it." />
      <Hero items={feed.data ?? []} />
      <StoppedCard />
      <ReadinessCard />
      <RunningAgentsPanel />
      <section className="space-y-3" data-testid="feed">
        <h2 className="px-1 text-[13px] font-semibold text-muted-foreground">What happened</h2>
        {feed.isLoading ? (
          <TableSkeleton rows={4} />
        ) : feed.isError ? (
          <ErrorState message="The feed could not be read." onRetry={() => void feed.refetch()} />
        ) : !feed.data || feed.data.length === 0 ? (
          <Surface>
            <EmptyState
              icon={Newspaper}
              title="Nothing yet"
              description="When your agents act, or Oathrion steps in, it is told here, in plain words. To see what Oathrion shows when an agent acts without permission: oathrion demo"
            />
          </Surface>
        ) : (
          <ul className="space-y-2.5">
            {feed.data.slice(0, FEED_SHOWN).map((item) => (
              <li key={item.id}>
                <Surface
                  className={cn("flex items-center gap-4 p-3.5 pr-4", item.tone === "bad" && "oath-glow")}
                  style={item.tone === "bad" ? glowOf(item.mascot.id, true) : undefined}
                  data-testid={`feed-item-${item.id}`}
                >
                  <span className="oath-glow flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-background/40" style={glowOf(item.mascot.id, item.tone === "bad")}>
                    <img src={`/mascots/${item.mascot.id}.png`} alt={item.mascot.name} title={item.mascot.name} className="h-12 w-12 object-contain" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium leading-snug">{item.title}</p>
                    {item.detail ? <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{item.detail}</p> : null}
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn("h-1.5 w-1.5 rounded-full", TONE[item.tone].dot)} aria-hidden />
                      {TONE[item.tone].label ? `${TONE[item.tone].label} · ` : ""}
                      {relativeTime(item.at)}
                    </p>
                  </div>
                  {worthSharing(item) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full border-primary/30 bg-primary/10 text-foreground hover:bg-primary/20"
                      onClick={() => setSharing(item)}
                      aria-label="Share"
                      data-testid={`button-share-${item.id}`}
                    >
                      <Share2 className="h-4 w-4" aria-hidden="true" />
                      <span className="ml-1.5 hidden sm:inline">Share</span>
                    </Button>
                  ) : null}
                </Surface>
              </li>
            ))}
          </ul>
        )}
        {feed.data && feed.data.length > FEED_SHOWN ? (
          <p className="px-1 text-[13px]">
            <Link href="/activity" className="font-medium underline-offset-2 hover:underline" data-testid="link-feed-all">
              Everything your agents did, in Activity
            </Link>
          </p>
        ) : null}
      </section>
      <ShareDialog item={sharing} onClose={() => setSharing(null)} />
    </div>
  );
}
