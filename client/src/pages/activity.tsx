/**
 * « Activity » — LA CHRONOLOGIE UNIQUE de la console locale : tout ce que les agents ont fait,
 * sur un seul fil. Ce qui est passé PAR Oathrion (serveurs MCP) et ce que Claude Code a exécuté
 * LUI-MÊME (son hook : shell, écritures), chaque ligne disant laquelle des deux, avec la décision,
 * la réponse de la personne quand il y en a une, et l'issue.
 *
 * L'audit se prouve : l'état de la chaîne du journal du hook est affiché, et l'export (JSON, CSV)
 * emporte exactement ce qui est montré. Relu toutes les 5 s tant que l'onglet est visible.
 *
 * EN TÊTE, LE BILAN (`server/local-summary.ts`) : ce que les agents ont fait aujourd'hui (ou sur
 * 7 jours) en trois nombres, ce à quoi on a échappé, et la preuve — les deux chaînes relues.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Download, FileCheck2, History, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";

import { Pill } from "@/components/common/badges";
import { EmptyState, ErrorState, PageHeader, Surface, TableSkeleton } from "@/components/common/primitives";
import { ActionWords } from "@/components/receipts/ActionWords";
import { getLocalActivity, getLocalSummary, getSharedReceipt, type ActivityEntry, type ActivityOutcome, type LocalSummary } from "@/lib/api";
import { toCsv } from "@/lib/activity-export";
import { relativeTime } from "@/lib/format";
import { plainDetail } from "@/lib/plain-action";

const OUTCOME: Record<ActivityOutcome, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  refused: { label: "Refused by Oathrion", tone: "danger" },
  waiting: { label: "Waiting for you", tone: "warning" },
  "asked-done": { label: "Asked, then done", tone: "success" },
  "asked-failed": { label: "Asked, then failed", tone: "danger" },
  "asked-not-run": { label: "Asked, not run", tone: "neutral" },
  "approved-done": { label: "Approved by a person, done", tone: "success" },
  "approved-failed": { label: "Approved by a person, failed", tone: "danger" },
  "refused-by-person": { label: "Refused by a person", tone: "danger" },
  "approved-not-run": { label: "Approved — ask the agent again to run it", tone: "info" },
  "not-run": { label: "Not run", tone: "neutral" },
  running: { label: "Running", tone: "info" },
};

/** Le téléchargement de ce qui est montré : rien de plus, rien de moins. */
function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * « Receipt » : le reçu signé de cette action, un fichier HTML que n'importe qui vérifie sans
 * Oathrion (`shared/receipt-share.ts`). C'est le moment « waouh » : quelqu'un qui n'utilise pas
 * Oathrion fait confiance à un reçu Oathrion.
 */
function ShareReceipt({ entry }: { entry: ActivityEntry }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  return (
    <button
      type="button"
      disabled={state === "busy"}
      onClick={() => {
        setState("busy");
        getSharedReceipt(entry.ref)
          .then((html) => {
            download(`oathrion-receipt-${entry.ref}.html`, "text/html", html);
            setState("idle");
          })
          .catch(() => setState("failed"));
      }}
      title="A signed receipt anyone can check, without Oathrion"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-60"
      data-testid={`button-receipt-${entry.ref}`}
    >
      <FileCheck2 className="h-3.5 w-3.5" aria-hidden /> {state === "failed" ? "Retry" : "Receipt"}
    </button>
  );
}

function Row({ entry }: { entry: ActivityEntry }) {
  const outcome = OUTCOME[entry.outcome];
  return (
    <li className="grid gap-1 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[7rem_8rem_1fr_auto_auto] md:items-center md:gap-4" data-testid={`activity-${entry.ref}`}>
      <time className="text-xs text-muted-foreground" dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>
        {relativeTime(entry.at)}
      </time>
      <span className="text-sm font-medium">{entry.agent}</span>
      <div className="min-w-0">
        <ActionWords action={entry.action} target={entry.target} />
        {entry.impact || entry.detail ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {entry.impact ? <span className="font-semibold text-danger">Would have deleted {entry.impact}</span> : null}
            {entry.impact && plainDetail(entry.detail) ? " · " : ""}
            {plainDetail(entry.detail)}
          </p>
        ) : null}
      </div>
      <Pill tone={outcome.tone} dot>
        {outcome.label}
      </Pill>
      <ShareReceipt entry={entry} />
    </li>
  );
}

/** Une part du bilan : sa couleur, son nombre, ce qu'il veut dire. */
function Share({ color, value, label }: { color: string; value: number; label: string }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
        {label}
      </p>
      <p className="mt-0.5 text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{value.toLocaleString()}</p>
    </div>
  );
}

/** Ce que la preuve établit, et rien de plus : les chaînes relues, intactes ou non. */
function Proof({ proof }: { proof: LocalSummary["proof"] }) {
  const parts = [
    proof.receipts.entries > 0 ? `${proof.receipts.entries.toLocaleString()} Oathrion receipt${proof.receipts.entries > 1 ? "s" : ""}` : null,
    proof.journal.entries > 0 ? `${proof.journal.entries.toLocaleString()} Claude Code journal line${proof.journal.entries > 1 ? "s" : ""}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  if (proof.intact) {
    return (
      <p className="flex items-start gap-2.5 text-[13px]" data-testid="summary-proof">
        <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-success" aria-hidden />
        <span>
          <span className="font-medium">Nothing has been changed, removed or reordered.</span>{" "}
          <span className="text-muted-foreground">Checked: {parts.join(" and ")}.</span>
        </span>
      </p>
    );
  }
  const broken = [!proof.receipts.ok ? `receipts: ${proof.receipts.reason ?? "broken"}` : null, !proof.journal.ok ? `journal: ${proof.journal.reason ?? "broken"}` : null].filter(Boolean);
  return (
    <p className="flex items-start gap-2.5 text-[13px] text-danger" data-testid="summary-proof">
      <ShieldX className="mt-px h-4 w-4 shrink-0" aria-hidden />
      <span>
        <span className="font-medium">The record has been altered.</span> {broken.join(" · ")}
      </span>
    </p>
  );
}

function Summary() {
  const [period, setPeriod] = useState<"today" | "7d">("today");
  const { data } = useQuery({ queryKey: ["/api/local/summary", period], queryFn: () => getLocalSummary(period), refetchInterval: 15_000 });
  if (!data) return null;
  const when = period === "today" ? "Today" : "In the last 7 days";
  /* Une seule barre, trois parts : ce qui est passé seul, ce qui a été demandé, ce qui a été bloqué. */
  const parts = [
    { key: "passed", value: data.passed, color: "bg-muted-foreground/35" },
    { key: "asked", value: data.asked, color: "bg-primary" },
    { key: "blocked", value: data.blocked, color: "bg-danger" },
  ].filter((part) => part.value > 0);
  return (
    <Surface className="overflow-hidden" data-testid="activity-summary">
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-medium text-muted-foreground">{when}</p>
            <h2 className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.022em]">
              {data.total === 0 ? "Your agents haven't acted through Oathrion yet." : `Your agents did ${data.total.toLocaleString()} action${data.total > 1 ? "s" : ""}.`}
            </h2>
          </div>
          <div className="flex rounded-[10px] bg-muted p-0.5 text-[13px]" role="tablist" aria-label="Period">
            {(["today", "7d"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={period === value}
                onClick={() => setPeriod(value)}
                className={`rounded-lg px-3 py-1 font-medium transition-all ${period === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                data-testid={`button-summary-${value}`}
              >
                {value === "today" ? "Today" : "7 days"}
              </button>
            ))}
          </div>
        </div>
        {data.total === 0 ? (
          <p className="text-[15px] text-muted-foreground">
            Is it working? <Link href="/servers" className="text-primary hover:underline">Servers</Link> shows what is behind Oathrion, and{" "}
            <Link href="/protection" className="text-primary hover:underline">Protection</Link> what is not.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              {parts.map((part) => (
                <div key={part.key} className={`${part.color} first:rounded-l-full last:rounded-r-full`} style={{ width: `${Math.max((part.value / data.total) * 100, 1.5)}%` }} />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Share color="bg-muted-foreground/35" value={data.passed} label="Went through" />
              <Share color="bg-primary" value={data.asked} label={data.waiting > 0 ? `Asked you · ${String(data.waiting)} waiting` : "Asked you"} />
              <Share color="bg-danger" value={data.blocked} label="Blocked" />
            </div>
          </div>
        )}
      </div>
      {data.saves.length > 0 && (
        <div className="border-t border-card-border bg-danger-soft/40 px-6 py-5" data-testid="summary-saves">
          <p className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-danger">
            <ShieldAlert className="h-4 w-4" aria-hidden /> What Oathrion stopped
          </p>
          <ul className="divide-y divide-danger/10">
            {data.saves.map((save) => (
              <li key={`${save.source}-${save.ref}`} className="flex items-center gap-4 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <ActionWords action={save.action} target={save.target} />
                  <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                    {save.impact ? <span className="font-semibold text-danger">Would have deleted {save.impact} · </span> : null}
                    {save.agent} · {relativeTime(save.at)}
                  </p>
                </div>
                <ShareReceipt entry={save} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="border-t border-card-border px-6 py-4">
        <Proof proof={data.proof} />
      </div>
    </Surface>
  );
}

export default function ActivityPage() {
  const [agent, setAgent] = useState("");
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["/api/local/activity", agent],
    queryFn: () => getLocalActivity(agent || undefined),
    refetchInterval: 5_000,
  });

  if (isError) {
    return <ErrorState message={error instanceof Error ? error.message : "The activity could not be read."} onRetry={() => void refetch()} />;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        subtitle="Everything your agents did, on one timeline: what went through Oathrion, and what Claude Code ran itself."
        actions={
          data && data.entries.length > 0 ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => download(`oathrion-activity-${stamp}.json`, "application/json", JSON.stringify(data.entries, null, 2))}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:border-primary"
                data-testid="button-export-json"
              >
                <Download className="h-4 w-4" aria-hidden /> JSON
              </button>
              <button
                type="button"
                onClick={() => download(`oathrion-activity-${stamp}.csv`, "text/csv", toCsv(data.entries))}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:border-primary"
                data-testid="button-export-csv"
              >
                <Download className="h-4 w-4" aria-hidden /> CSV
              </button>
            </div>
          ) : undefined
        }
      />
      {isLoading || !data ? (
        <TableSkeleton rows={6} cols={4} />
      ) : (
        <>
          <Summary />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Agent</span>
              <select value={agent} onChange={(event) => setAgent(event.target.value)} className="h-9 rounded-lg border border-border bg-background px-2 text-sm" data-testid="select-activity-agent">
                <option value="">All agents</option>
                {data.agents.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {data.journal.entries > 0 ? (
              <Pill tone={data.journal.ok ? "success" : "danger"} data-testid="pill-journal-chain">
                {data.journal.ok ? <ShieldCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden /> : <ShieldX className="mr-1 inline h-3.5 w-3.5" aria-hidden />}
                {data.journal.ok ? `Claude Code journal: chain intact (${String(data.journal.entries)} lines)` : `Claude Code journal: BROKEN — ${data.journal.reason ?? "unknown reason"}`}
              </Pill>
            ) : null}
          </div>
          {data.entries.length === 0 ? (
            <Surface>
              <EmptyState icon={History} title="Nothing yet" description="As soon as an agent acts through Oathrion, or Claude Code runs a command, it shows up here." />
            </Surface>
          ) : (
            <Surface className="p-0">
              <ul aria-label="Agent activity">
                {data.entries.map((entry) => (
                  <Row key={`${entry.source}-${entry.ref}`} entry={entry} />
                ))}
              </ul>
            </Surface>
          )}
        </>
      )}
    </div>
  );
}
