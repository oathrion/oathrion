/**
 * L'ACCUEIL DE LA CONSOLE LOCALE : LES PASSEPORTS (23 novembre, `notes/CONSTRUCTION-CONSOLE-PASSEPORT.md`).
 * « YOUR AGENTS » : ce qui attend la personne en tête, puis un passeport par agent
 * (`components/passport/Passport.tsx`) — son visage, son bilan, la dernière action arrêtée —, ce
 * qui tourne sans Oathrion, puis l'état de la machine. Le fil d'actualité vit maintenant dans le
 * passeport de chaque agent ; `?share=<id>` ouvre encore le partage d'un élément (le bouton
 * « Share » de la notification y mène).
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { Newspaper, Send } from "lucide-react";

import { Logo } from "@/components/layout/Logo";
import { PassportCard, usePendingFor, WaitingDecision } from "@/components/passport/Passport";

import { RunningAgentsPanel } from "@/components/agents/RunningAgentsPanel";
import { SendProofDialog } from "@/components/receipts/SendProofDialog";
import { EmptyState, ErrorState, Surface, TableSkeleton } from "@/components/common/primitives";
import { ShareDialog } from "@/components/feed/ShareDialog";
import { ReadinessCard } from "@/components/home/ReadinessCard";
import { StoppedCard } from "@/components/home/StoppedCard";
import { WrongCard } from "@/components/home/WrongCard";
import { Button } from "@/components/ui/button";
import { getFeed, getLocalSummary, getPassports, showDemo, type FeedItem } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export default function HomePage() {
  const search = useSearch();
  const wanted = new URLSearchParams(search).get("share");
  const feed = useQuery({ queryKey: ["/api/local/feed"], queryFn: getFeed, refetchInterval: 5_000 });
  const passports = useQuery({ queryKey: ["/api/local/passports", 7], queryFn: () => getPassports(7), refetchInterval: 10_000 });
  const summary = useQuery({ queryKey: ["/api/local/summary", "7d"], queryFn: () => getLocalSummary("7d"), refetchInterval: 15_000 });
  const pending = usePendingFor(null);
  const { toast } = useToast();
  const demo = useMutation({
    mutationFn: showDemo,
    onSuccess: () => toast({ title: "Look at your notification", description: "Oathrion paused Nova, a pretend agent: click « Stop »." }),
    onError: (error: Error) => toast({ title: "No notification", description: error.message, variant: "destructive" }),
  });
  const [sharing, setSharing] = useState<FeedItem | null>(null);
  const [proving, setProving] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  /* Venu du bouton « Share » d'une notification : le partage s'ouvre tout seul, une fois. */
  if (wanted && opened !== wanted && feed.data) {
    const item = feed.data.find((i) => i.id === wanted);
    if (item) {
      setOpened(wanted);
      setSharing(item);
    }
  }
  const faceOf = (agent: string) => passports.data?.passports.find((p) => p.agent === agent)?.face;
  const proof = summary.data?.proof;

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[40px] font-semibold leading-none tracking-[0.01em]" style={{ fontFamily: "var(--font-sans)" }}>
            YOUR <span className="ap-grad">AGENTS</span>
          </h1>
          <p className="text-[14px] font-medium tracking-[0.12em] text-muted-foreground">TRUST · CONTROL · TRANSPARENCY</p>
        </div>
        <div className="flex max-w-md flex-col items-end gap-3">
          <p className="text-right text-[14px] text-muted-foreground">Every agent on this machine has a passport: who it is, what it may do, what it did.</p>
          <button type="button" className="ap-btn flex h-11 items-center gap-2 rounded-xl px-5 text-[15px] font-semibold" onClick={() => setProving(true)} data-testid="send-proof-open">
            <Send className="h-4 w-4" aria-hidden="true" />
            Send proof
          </button>
        </div>
      </header>

      {pending.slice(0, 3).map((approval) => (
        <WaitingDecision key={approval.id} approval={approval} face={faceOf(approval.agentName)} compactView />
      ))}
      {pending.length > 3 ? (
        <p className="px-1 text-[14px]">
          <Link href="/approvals" className="font-semibold underline-offset-2 hover:underline">
            {pending.length - 3} more waiting for you
          </Link>
        </p>
      ) : null}

      {passports.isLoading ? (
        <TableSkeleton rows={3} />
      ) : passports.isError ? (
        <ErrorState message="The passports could not be read." onRetry={() => void passports.refetch()} />
      ) : !passports.data || passports.data.passports.length === 0 ? (
        <Surface>
          <EmptyState
            icon={Newspaper}
            title="No passport yet"
            description="Each agent gets its passport the first time it acts through Oathrion. Run npx oathrion once, or see Oathrion stop a pretend agent."
            action={
              <Button size="sm" className="rounded-full" disabled={demo.isPending} onClick={() => demo.mutate()} data-testid="feed-demo">
                See Oathrion stop an agent
              </Button>
            }
          />
        </Surface>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-6" data-testid="passports">
          {passports.data.passports.map((entry) => (
            <PassportCard key={entry.agent} entry={entry} waiting={pending.some((a) => a.agentName === entry.agent)} />
          ))}
        </div>
      )}

      <RunningAgentsPanel />

      <section aria-label="This machine" className="ap-soft flex flex-wrap items-center gap-x-8 gap-y-4 rounded-[22px] px-6 py-5" data-testid="machine-strip">
        <Logo className="ap-logo h-11 w-11 shrink-0" />
        <div className="min-w-[16rem] flex-1">
          <p className="text-[17px] font-semibold">This machine</p>
          <p className="text-[14px] text-muted-foreground">
            {proof ? `${proof.intact ? "Both records intact" : "A record is NOT intact"} · ${String(proof.receipts.entries)} receipts · ${String(proof.journal.entries)} journal lines` : "Reading the records…"}
          </p>
        </div>
        <Link href="/protection" className="text-[15px] font-semibold text-sidebar-primary underline-offset-2 hover:underline">
          What is covered
        </Link>
        <Link href="/activity" className="text-[15px] font-semibold text-sidebar-primary underline-offset-2 hover:underline">
          Everything, in Activity
        </Link>
      </section>

      <StoppedCard />
      <WrongCard />
      <ReadinessCard />
      <ShareDialog item={sharing} onClose={() => setSharing(null)} />
      <SendProofDialog open={proving} onOpenChange={setProving} />
    </div>
  );
}
