/**
 * PARTAGER DEPUIS LA NOTIFICATION (11 novembre, essai réel : l'image copiée par la fenêtre de
 * notification n'arrivait pas dans Chrome). « LinkedIn » dans la notification ouvre ici la carte ;
 * un clic la fait copier par le navigateur lui-même, puis ouvre le post, où elle se colle.
 * `?t=<jeton>&to=linkedin|x|whatsapp`.
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";

import { ErrorState, PageHeader } from "@/components/common/primitives";
import { ShareDialog } from "@/components/feed/ShareDialog";
import { getShareCard, type FeedItem } from "@/lib/api";
import { SHARE_NETWORKS, type ShareNetwork } from "@shared/share";

export default function SharePage() {
  const params = new URLSearchParams(useSearch());
  const token = params.get("t") ?? "";
  const to = params.get("to");
  const network = SHARE_NETWORKS.includes(to as ShareNetwork) ? (to as ShareNetwork) : undefined;
  const [, navigate] = useLocation();
  const card = useQuery({ queryKey: ["/api/local/share-cards", token], queryFn: () => getShareCard(token), enabled: token !== "", retry: false });
  const item: FeedItem | null = card.data
    ? { id: token, at: card.data.at, agent: "", mascot: card.data.mascot, tone: card.data.tone, title: card.data.sentence, share: card.data.sentence }
    : null;
  return (
    <div className="space-y-6">
      <PageHeader title="Share" subtitle="Your card is ready: one click copies it and opens your post." />
      {card.isError || token === "" ? (
        <ErrorState message="This card is no longer here: share it again from the notification, or from Home." onRetry={() => navigate("/home")} />
      ) : null}
      <ShareDialog item={item} network={network} onClose={() => navigate("/home")} />
    </div>
  );
}
