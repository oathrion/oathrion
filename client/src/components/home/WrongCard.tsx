/**
 * « OATHRION GOT IT WRONG » (16 novembre) : la personne a répondu « No » à « Was Oathrion right? » ;
 * c'est le retour le plus précieux, et l'accueil le lui redemande, une fois, jusqu'à ce qu'elle
 * l'ait partagé (`pages/local-feedback.tsx`). Rien ne part sans elle.
 */
import { useQuery } from "@tanstack/react-query";
import { ThumbsDown } from "lucide-react";
import { Link } from "wouter";

import { Surface } from "@/components/common/primitives";
import { Button } from "@/components/ui/button";
import { getLocalFeedback } from "@/lib/api";

export function WrongCard() {
  const feedback = useQuery({ queryKey: ["/api/local/feedback"], queryFn: getLocalFeedback, refetchInterval: 30_000, retry: false });
  const data = feedback.data;
  const wrong = data?.answers.filter((answer) => !answer.right && (!data.sharedUntil || answer.at > data.sharedUntil)) ?? [];
  if (wrong.length === 0) return null;
  return (
    <Surface className="flex flex-wrap items-center gap-4 p-5" data-testid="home-wrong">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
        <ThumbsDown className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{wrong.length === 1 ? "You said Oathrion got it wrong" : `You said Oathrion got it wrong ${String(wrong.length)} times`}</p>
        <p className="truncate text-[13px] text-muted-foreground">{wrong[0]!.about}: tell us what it should have done, and we fix it.</p>
      </div>
      <Button asChild size="sm" className="rounded-full">
        <Link href="/feedback?wrong=1">Tell us what happened</Link>
      </Button>
    </Surface>
  );
}
