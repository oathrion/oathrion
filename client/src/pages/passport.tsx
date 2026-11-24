/**
 * LE PASSEPORT D'UN AGENT, OUVERT (23 novembre, `notes/CONSTRUCTION-CONSOLE-PASSEPORT.md`) : la page
 * autour de laquelle tout tourne. En tête, ce que l'agent attend de la personne ; puis son
 * passeport ; puis ce qui était dispersé entre Home, Activity, Protection et les reçus :
 * « What it did » (le fil de CET agent), « What it may do » (ses règles), « Tools », « Receipts ».
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";

import { ErrorState, Surface, TableSkeleton } from "@/components/common/primitives";
import { FeedList } from "@/components/feed/FeedList";
import { ShareDialog } from "@/components/feed/ShareDialog";
import { PassportFull, usePendingFor, WaitingDecision } from "@/components/passport/Passport";
import { getFeed, getLocalActivity, getPassports, type FeedItem, type PassportEntry } from "@/lib/api";
import { ActivityRow } from "@/pages/activity";
import { compact } from "@/lib/format";
import { cn } from "@/lib/utils";

const DAYS = 30;
type Tab = "did" | "may" | "tools" | "receipts";
const TABS: { id: Tab; label: string }[] = [
  { id: "did", label: "What it did" },
  { id: "may", label: "What it may do" },
  { id: "tools", label: "Tools" },
  { id: "receipts", label: "Receipts" },
];

function MayDo({ entry }: { entry: PassportEntry }) {
  const { hookRules, rules } = entry.passport;
  return (
    <div className="space-y-4">
      <div className="ap-tile space-y-2 rounded-2xl p-5 text-[15px] leading-relaxed">
        <p>
          <span className="font-semibold">Goes through</span> <span className="text-muted-foreground">what no rule holds: reads, tests, edits in the project.</span>
        </p>
        <p>
          <span className="font-semibold text-[#8ff2e4]">Asks you</span> <span className="text-muted-foreground">what a rule holds for a person: pushing, publishing, destroying production…</span>
        </p>
        <p>
          <span className="font-semibold text-[#ffb27a]">Refused</span> <span className="text-muted-foreground">what can never be undone: deleting outside the project, sending secrets out…</span>
        </p>
        {hookRules ? (
          <p className="pt-1 text-muted-foreground">
            {hookRules.inForce.length} rules in force for Claude Code
            {hookRules.off.length > 0 ? `; turned off by you: ${hookRules.off.join(", ")}` : "; none turned off"}
            {hookRules.extraDeny + hookRules.extraAsk > 0 ? `; ${String(hookRules.extraDeny + hookRules.extraAsk)} of your own` : ""}.
          </p>
        ) : null}
        <p className="pt-1">
          <Link href="/protection" className="font-semibold text-sidebar-primary underline-offset-2 hover:underline">
            What Oathrion covers on this machine, and what it cannot see
          </Link>
        </p>
      </div>
      {rules.length > 0 ? (
        <div className="ap-tile rounded-2xl p-5">
          <p className="mb-3 text-[15px] font-semibold">The rules that held it, last {DAYS} days</p>
          <ul className="space-y-1.5 text-[14px]">
            {rules.map((rule) => (
              <li key={rule.rule} className="flex justify-between gap-4">
                <span className="truncate font-mono">{rule.rule}</span>
                <span className="shrink-0 text-muted-foreground">
                  {rule.asked > 0 ? `${String(rule.asked)} asked` : ""}
                  {rule.asked > 0 && rule.blocked > 0 ? " · " : ""}
                  {rule.blocked > 0 ? `${String(rule.blocked)} blocked` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Tools({ entry }: { entry: PassportEntry }) {
  const { tools } = entry.passport;
  if (tools.length === 0) return <p className="ap-tile rounded-2xl p-5 text-muted-foreground">It has not reached any tool through Oathrion in the last {DAYS} days.</p>;
  return (
    <ul className="space-y-[3px]">
      {tools.map((tool) => (
        <li key={tool.tool} className="ap-tile flex items-center justify-between gap-4 rounded-xl px-5 py-3.5 text-[15px]">
          <span className="font-semibold">{tool.tool}</span>
          <span className="text-muted-foreground">
            {compact(tool.total)} actions · {compact(tool.asked)} asked · {compact(tool.blocked)} blocked
          </span>
        </li>
      ))}
    </ul>
  );
}

function Receipts({ entry }: { entry: PassportEntry }) {
  const { evidence } = entry.passport;
  return (
    <div className="ap-tile space-y-3 rounded-2xl p-5 text-[15px] leading-relaxed">
      <p className={cn("font-semibold", evidence.intact ? "text-[#8ff2e4]" : "text-[#ffb27a]")}>{evidence.intact ? "Both records intact" : "A record is NOT intact"}</p>
      <p className="text-muted-foreground">
        {compact(evidence.receipts.entries)} chained receipts for what went through Oathrion, {compact(evidence.journal.entries)} journal lines for what Claude Code ran.
        Every action of this agent has its signed receipt in Activity.
      </p>
      <p className="text-muted-foreground">
        « Share passport » downloads this passport signed by this machine's key. Whoever receives it checks it, offline:{" "}
        <code className="rounded bg-background/50 px-1.5 py-0.5 font-mono text-[13px]">npx oathrion receipt verify oathrion-passport.json</code>
      </p>
      <p>
        <Link href="/activity" className="font-semibold text-sidebar-primary underline-offset-2 hover:underline">
          Every action, with its receipt, in Activity
        </Link>
      </p>
    </div>
  );
}

export default function PassportPage() {
  const params = useParams<{ agent: string }>();
  const agent = decodeURIComponent(params.agent ?? "");
  const passports = useQuery({ queryKey: ["/api/local/passports", DAYS], queryFn: () => getPassports(DAYS), refetchInterval: 10_000 });
  const feed = useQuery({ queryKey: ["/api/local/feed"], queryFn: getFeed, refetchInterval: 5_000 });
  const activity = useQuery({ queryKey: ["/api/local/activity", agent], queryFn: () => getLocalActivity(agent), refetchInterval: 5_000 });
  const pending = usePendingFor(agent);
  const [tab, setTab] = useState<Tab>("did");
  const [sharing, setSharing] = useState<FeedItem | null>(null);
  const entry = passports.data?.passports.find((p) => p.agent === agent);

  if (passports.isLoading) return <TableSkeleton rows={4} />;
  if (passports.isError) return <ErrorState message="The passport could not be read." onRetry={() => void passports.refetch()} />;
  if (!entry) {
    return (
      <Surface className="p-6 text-[15px]">
        No passport for « {agent} ». <Link href="/home" className="font-semibold underline-offset-2 hover:underline">See your agents' passports</Link>
      </Surface>
    );
  }
  const items = (feed.data ?? []).filter((item) => item.agent === agent);

  return (
    <div className="space-y-6">
      <p className="text-[14px] text-muted-foreground">
        <Link href="/home" className="underline-offset-2 hover:underline">
          Passports
        </Link>{" "}
        / {entry.face.name}
      </p>
      {pending.map((approval) => (
        <WaitingDecision key={approval.id} approval={approval} face={entry.face} />
      ))}
      <PassportFull entry={entry} days={DAYS} />

      <div role="tablist" aria-label="Passport sections" className="flex flex-wrap gap-1.5 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn("h-11 px-4 text-[15px]", tab === t.id ? "border-b-2 border-[#8e9bff] font-semibold text-foreground" : "text-muted-foreground hover:text-foreground")}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "did" ? (
        <div className="space-y-5">
          {items.length > 0 ? <FeedList items={items.slice(0, 8)} onShare={setSharing} /> : null}
          {(activity.data?.entries.length ?? 0) === 0 ? (
            <p className="ap-tile rounded-2xl p-5 text-muted-foreground">Nothing yet for this agent. Everything it does through Oathrion shows up here, each with its signed receipt.</p>
          ) : (
            <div className="ap-tile overflow-hidden rounded-2xl">
              <ul>
                {activity.data!.entries.slice(0, 60).map((entry) => (
                  <ActivityRow key={`${entry.source}-${entry.ref}`} entry={entry} />
                ))}
              </ul>
              <p className="border-t border-border px-4 py-3 text-[14px]">
                <Link href="/activity" className="font-semibold text-sidebar-primary underline-offset-2 hover:underline">
                  Everything, in Activity
                </Link>
              </p>
            </div>
          )}
        </div>
      ) : tab === "may" ? (
        <MayDo entry={entry} />
      ) : tab === "tools" ? (
        <Tools entry={entry} />
      ) : (
        <Receipts entry={entry} />
      )}
      <ShareDialog item={sharing} onClose={() => setSharing(null)} />
    </div>
  );
}
