/**
 * LE FIL D'ACTUALITÉ EN PHRASES SIMPLES (`server/local-feed.ts`) : ce qu'Oathrion a fait et ce
 * que la personne a décidé, avec la mascotte de l'agent, et « Share » sur ce qui en vaut la peine.
 * Il était sur l'accueil ; depuis le 23 novembre il est l'onglet « What it did » du passeport.
 */
import { Share2 } from "lucide-react";

import { Surface } from "@/components/common/primitives";
import { Button } from "@/components/ui/button";
import type { FeedItem } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/* Le ton d'un élément : un point de couleur, discret ; la mascotte porte le reste. */
const TONE: Record<FeedItem["tone"], { dot: string; label: string }> = {
  good: { dot: "bg-emerald-400", label: "Protected" },
  warn: { dot: "bg-amber-400", label: "Needs you" },
  bad: { dot: "bg-red-500", label: "Alert" },
  info: { dot: "bg-muted-foreground/60", label: "" },
};

/**
 * Ce qui se partage : un moment où Oathrion a protégé (un arrêt, un refus, un leurre lu, un agent
 * mis en pause, une décision). Pas « did one thing through Oathrion: shell », ni chaque commande
 * approuvée : un bouton « Share » sur chaque ligne n'en signalait plus aucune.
 */
export function worthSharing(item: FeedItem): boolean {
  if (item.tone === "info") return false;
  return !(item.id.startsWith("apr_") && item.tone === "good");
}

export function FeedList({ items, onShare }: { items: FeedItem[]; onShare: (item: FeedItem) => void }) {
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.id}>
          <Surface className={cn("ap-tile flex items-center gap-4 rounded-2xl p-3.5 pr-4", item.tone === "bad" && "ap-stop")} data-testid={`feed-item-${item.id}`}>
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-background/40">
              <img src={`/mascots/${item.mascot.id}.png`} alt={item.mascot.name} title={item.mascot.name} className="h-12 w-12 object-contain" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium leading-snug">{item.title}</p>
              {item.detail ? <p className="mt-0.5 line-clamp-2 break-words text-[13px] text-muted-foreground">{item.detail}</p> : null}
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
                className="ap-ghost rounded-full"
                onClick={() => onShare(item)}
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
  );
}
