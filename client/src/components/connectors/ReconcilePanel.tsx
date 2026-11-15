/**
 * « Qu'est-ce qui s'est passé chez ce service SANS Oathrion ? » — la réconciliation d'un
 * connecteur.
 *
 * Ce que le panneau montre sans qu'on clique : le dernier passage (lancé ici ou par la tâche
 * périodique), et toutes les écritures déjà vues hors d'Oathrion depuis la connexion, chacune
 * avec la date où elle a été vue la première fois (`GET /api/connectors/:id/reconcile`).
 * « Vérifier maintenant » relance un passage. Les limites sont dites à côté du résultat :
 * « rien trouvé » n'est jamais présenté comme « rien ne s'est passé » quand la lecture
 * était partielle.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, SearchCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getReconcileState, reconcileConnector, type ReconcileFinding, type ReconcileReport, type ReconcileState } from "@/lib/api";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ReconcileFinding["kind"], string> = {
  issue: "Issue",
  pull_request: "Pull request",
  comment: "Comment",
  refund: "Refund",
  payout: "Payout",
  payment: "Payment",
  customer: "Customer",
  dispute: "Dispute",
  missing_receipt: "Action without a receipt",
  message: "Message",
  task: "Task",
};

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function ReconcilePanel({ connectorId, label }: { connectorId: string; label: string }) {
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [busy, setBusy] = useState(false);
  const state = useQuery({ queryKey: ["/api/connectors", connectorId, "reconcile"], queryFn: () => getReconcileState(connectorId), staleTime: 0 });

  async function run() {
    setBusy(true);
    setReport(
      await reconcileConnector(connectorId).catch(
        (e: unknown): ReconcileReport => ({ ok: false, detail: e instanceof Error ? e.message : "The check failed." }),
      ),
    );
    await state.refetch();
    setBusy(false);
  }

  const lastRun = state.data?.lastRun ?? null;
  const findings = state.data?.findings ?? [];

  return (
    <div className="space-y-3 border-t pt-4" data-testid={`reconcile-${connectorId}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">What happened without Oathrion</p>
          <p className="text-xs text-muted-foreground">
            Oathrion re-reads what {label} recorded since the connection, compares it with its own receipts, and alerts. It
            also does so on its own, at regular intervals.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()} data-testid={`button-reconcile-${connectorId}`}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <SearchCheck className="mr-1 h-3.5 w-3.5" />}
          Check now
        </Button>
      </div>

      {report && !report.ok && (
        <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          Could not check: {report.detail}
        </p>
      )}

      {lastRun ? <LastRun run={lastRun} label={label} /> : <p className="text-xs text-muted-foreground">Not checked yet.</p>}

      {findings.length > 0 && (
        <Findings
          title={`Seen outside Oathrion since the connection (${String(findings.length)})`}
          items={findings}
        />
      )}

      {report?.ok && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">What this check cannot see</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {report.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function LastRun({ run, label }: { run: NonNullable<ReconcileState["lastRun"]>; label: string }) {
  const how = run.trigger === "auto" ? "automatic" : "started from the console";
  if (!run.ok) {
    return (
      <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
        The last check ({how}, on {when(run.ranAt)}) did not complete: {run.detail}
      </p>
    );
  }
  const flagged = run.outsideCount + run.unknownCount;
  return (
    <div className="space-y-1.5">
      <div
        role="status"
        className={cn(
          "flex items-start gap-2 rounded-md border p-3 text-sm",
          run.verdict === "clean" && "border-emerald-500/30 bg-emerald-500/10",
          run.verdict === "alert" && "border-rose-500/30 bg-rose-500/10",
          run.verdict === "partial" && "border-amber-500/30 bg-amber-500/10",
        )}
      >
        {run.verdict === "clean" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span>
          {run.verdict === "clean" && `Nothing went outside Oathrion on ${label} since ${when(run.since)}.`}
          {run.verdict === "partial" &&
            `Nothing abnormal in what was read, but ${label} had more to say than what was read: the result is partial.`}
          {run.verdict === "alert" &&
            `${String(flagged)} write(s) on ${label} did not come from Oathrion since ${when(run.since)}. A key or direct access is still open.`}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Last check {how}, on {when(run.ranAt)} · {run.scanned} write(s) read · {run.viaOathrion} through
        Oathrion · {run.others} by other accounts (counted, not judged) · Oathrion&apos;s identity: {run.identity}
      </p>
    </div>
  );
}

function Findings({ title, items }: { title: string; items: ReconcileState["findings"] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium">{title}</p>
      <ul className="divide-y rounded-md border text-sm">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
            <span>
              <span className="font-medium">{KIND_LABEL[item.kind]}</span> · {item.summary}
              <span className="block text-xs text-muted-foreground">
                {item.category === "unknown_marker" ? "Unknown Oathrion marker" : "Outside Oathrion"}
                {item.actor ? ` · by ${item.actor}` : ""} · made on {when(item.createdAt)} · seen on {when(item.firstSeenAt)}
              </span>
            </span>
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                {item.id} <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
