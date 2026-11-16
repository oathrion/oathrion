import { contextLabel, reasonLabel } from "@/lib/server-text";
import { useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { AlertTriangle, Check, Inbox, X } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  FilterTabs,
  PageHeader,
  Surface,
} from "@/components/common/primitives";
import { ApprovalStatusBadge, RiskBadge } from "@/components/common/badges";
import { Skeleton } from "@/components/ui/skeleton";
import { useARIA, useFreshSnapshot, useLiveApprovals } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { grantAlways, grantHour } from "@/lib/api";
import { useLocalMode } from "@/lib/local-mode";
import { glowOf } from "@/lib/mascot-style";
import { useFaces } from "@/components/agents/MascotPicker";
import { useToast } from "@/hooks/use-toast";
import { relativeTime } from "@/lib/format";
import { decideOnceSuggestion, toolOf } from "@/lib/decide-once";
import { describeApproval } from "@/lib/approval-text";
import type { Approval, ApprovalStatus } from "@/types";
import { WithheldToolsNotice } from "@/components/agents/WithheldToolsNotice";
import { RunningAgentsPanel } from "@/components/agents/RunningAgentsPanel";
import { ReceiptMoment } from "@/components/receipts/ReceiptMoment";
import { UnknownProgramsNotice } from "@/components/agents/UnknownProgramsNotice";

type Filter = "pending" | "approved" | "rejected" | "all";

export default function ApprovalsPage() {
  const { approvals, loading, error, reload, resolveApproval } = useARIA();
  useFreshSnapshot();
  useLiveApprovals();
  const { can } = useAuth();
  const [filter, setFilter] = useState<Filter>("pending");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  /*
   * Les reçus qui viennent de naître, en haut de la page (en local : l'action a un reçu signé).
   * `?receipt=<action>` : le bouton « Your signed receipt » de la fenêtre de notification y mène.
   */
  const search = useSearch();
  const [receipts, setReceipts] = useState<string[]>(() => {
    const asked = new URLSearchParams(search).get("receipt");
    return asked ? [asked] : [];
  });
  const { toast } = useToast();
  const canApprove = can("approve");
  /* « Décider une fois » : en local, et pour qui peut écrire une règle. */
  const local = useLocalMode();
  const canGrant = local && canApprove && can("manage");

  const counts = useMemo(
    () => ({
      all: approvals.length,
      pending: approvals.filter((a) => a.status === "pending").length,
      approved: approvals.filter((a) => a.status === "approved").length,
      rejected: approvals.filter((a) => a.status === "rejected").length,
    }),
    [approvals],
  );

  const filtered = approvals.filter((a) => filter === "all" || a.status === filter);

  const resolve = async (
    approval: Approval,
    status: Exclude<ApprovalStatus, "pending" | "expired">,
  ) => {
    if (!canApprove || resolvingId) return;
    // A decision is irreversible, so reject competing clicks while it is in flight.
    setResolvingId(approval.id);
    try {
      await resolveApproval(approval.id, status);
      const ref = local ? approval.executionId : null;
      if (ref) setReceipts((shown) => [ref, ...shown.filter((r) => r !== ref)]);
      else
        toast({
          title: status === "approved" ? "Action approved" : "Action rejected",
          description: describeApproval(approval).headline,
        });
    } catch {
      toast({
        title: "The decision could not be recorded",
        description: "Oathrion did not accept this decision.",
        variant: "destructive",
      });
    } finally {
      setResolvingId(null);
    }
  };

  /*
   * Approuver, et ne plus demander pour cet outil : d'abord la règle (le pivot refuse une
   * destruction, et on n'approuve alors rien), puis l'approbation habituelle.
   */
  const resolveAlways = async (approval: Approval) => {
    if (!canGrant || resolvingId) return;
    setResolvingId(approval.id);
    try {
      const granted = await grantAlways(approval.id);
      if (!granted.ok) {
        toast({ title: 'No "always" for this action', description: granted.message, variant: "destructive" });
        return;
      }
      await resolveApproval(approval.id, "approved");
      const ref = approval.executionId;
      if (ref) setReceipts((shown) => [ref, ...shown.filter((r) => r !== ref)]);
      toast({
        title: "Approved — this tool will not be asked again",
        description: 'An "allowed without approval" rule, in Policies, where you can remove it.',
      });
    } catch {
      toast({ title: "The decision could not be recorded", description: "Oathrion did not accept this decision.", variant: "destructive" });
    } finally {
      setResolvingId(null);
    }
  };

  /* « Allow 1 hour » : la permission d'abord, puis l'approbation de CETTE demande, et son reçu. */
  const resolveHour = async (approval: Approval) => {
    if (!canApprove || resolvingId) return;
    setResolvingId(approval.id);
    try {
      const granted = await grantHour(approval.id);
      if (!granted.ok) {
        toast({ title: "No hour for this action", description: granted.message, variant: "destructive" });
        return;
      }
      await resolveApproval(approval.id, "approved");
      const ref = approval.executionId;
      if (ref) setReceipts((shown) => [ref, ...shown.filter((r) => r !== ref)]);
      toast({ title: `Allowed until ${granted.clock}`, description: `${describeApproval(approval).headline}: not asked again for an hour.` });
    } catch {
      toast({ title: "The decision could not be recorded", description: "Oathrion did not accept this decision.", variant: "destructive" });
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        subtitle="What your agents asked to do, waiting for your decision."
      />

      <UnknownProgramsNotice />

      <FilterTabs<Filter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: "pending", label: "Pending", count: counts.pending },
          { value: "approved", label: "Approved", count: counts.approved },
          { value: "rejected", label: "Rejected", count: counts.rejected },
          { value: "all", label: "All", count: counts.all },
        ]}
      />

      {receipts.length > 0 ? (
        <div className="space-y-4" data-testid="receipts-just-made">
          {receipts.map((ref) => (
            <ReceiptMoment key={ref} executionRef={ref} onClose={() => setReceipts((shown) => shown.filter((r) => r !== ref))} />
          ))}
        </div>
      ) : null}

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Surface key={i} className="p-6">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-3 h-6 w-2/3" />
              <Skeleton className="mt-5 h-16 w-full" />
            </Surface>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Surface>
          {filter === "pending" ? (
            <div className="flex flex-col items-center px-6 py-16 text-center" data-testid="state-empty">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft">
                <Check className="h-7 w-7 text-success" aria-hidden />
              </div>
              <h2 className="mt-5 text-[20px] font-semibold tracking-[-0.02em]">You're all caught up.</h2>
              <p className="mt-1.5 max-w-sm text-[15px] text-muted-foreground">When an agent needs your decision, it shows up here, and Oathrion lets you know.</p>
              <Link href="/activity" className="mt-5 text-[15px] font-medium text-primary hover:underline">
                See what your agents did
              </Link>
            </div>
          ) : (
            <EmptyState icon={Inbox} title="Nothing here" description="No request matches this filter." />
          )}
        </Surface>
      ) : (
        <div className="space-y-4">
          {/* En attente : une grande carte chacune ; tranchées : une ligne d'historique. */}
          {filtered
            .filter((a) => a.status === "pending")
            .map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                canApprove={canApprove}
                resolving={resolvingId === a.id}
                onResolve={resolve}
                onAlways={canGrant && toolOf(a) !== null ? resolveAlways : undefined}
                onHour={local && canApprove && toolOf(a) !== null ? resolveHour : undefined}
                approvedInARow={canGrant ? decideOnceSuggestion(a, approvals) : null}
              />
            ))}
          {filtered.some((a) => a.status !== "pending") && (
            <Surface className="overflow-hidden p-0">
              <ul className="divide-y divide-card-border">
                {filtered
                  .filter((a) => a.status !== "pending")
                  .map((a) => (
                    <DecidedRow key={a.id} approval={a} withReceipt={local} />
                  ))}
              </ul>
            </Surface>
          )}
        </div>
      )}

      {/*
       * Sous les demandes, pas au-dessus (16 novembre) : ces bandeaux arrivent après le
       * chargement ; au-dessus, ils poussaient la carte au moment du clic, et « Reject » tombait
       * à côté — ou sur un autre bouton.
       */}
      <RunningAgentsPanel />
      <WithheldToolsNotice />
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-[15px] font-semibold text-foreground/80 shadow-xs" aria-hidden>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** « expires in 52 min » : le temps qui reste pour décider, s'il est connu. */
function expiresIn(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const minutes = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes < 60 ? `expires in ${String(minutes)} min` : `expires in ${String(Math.round(minutes / 60))} h`;
}

/** Une demande déjà tranchée : une ligne, comme une entrée d'historique. */
function DecidedRow({ approval, withReceipt }: { approval: Approval; withReceipt: boolean }) {
  const text = describeApproval(approval);
  const [open, setOpen] = useState(false);
  /* En local, chaque décision a son reçu signé : il se rouvre ici, tel qu'il est né. */
  const ref = withReceipt && approval.status !== "expired" ? approval.executionId : null;
  return (
    <li data-testid={`card-approval-${approval.id}`}>
      <div className="flex items-center gap-4 px-5 py-4">
        <Avatar name={approval.agentName} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{text.headline}</p>
          <p className="truncate text-[13px] text-muted-foreground">
            {text.where ? `${text.where} · ` : ""}
            {approval.status === "expired" ? "nobody decided in time" : `by ${approval.resolvedBy ?? "—"}`} · {relativeTime(approval.resolvedAt ?? approval.requestedAt)}
          </p>
        </div>
        <ApprovalStatusBadge status={approval.status} />
        {ref ? (
          <button
            type="button"
            onClick={() => setOpen((shown) => !shown)}
            aria-expanded={open}
            className="shrink-0 rounded-full px-3 py-1 text-[13px] font-medium text-foreground/80 hover:bg-muted"
            data-testid={`button-receipt-${approval.id}`}
          >
            {open ? "Hide receipt" : "Receipt"}
          </button>
        ) : null}
      </div>
      {ref && open ? (
        <div className="px-5 pb-5">
          <ReceiptMoment executionRef={ref} />
        </div>
      ) : null}
    </li>
  );
}

function ApprovalCard({
  approval,
  canApprove,
  resolving,
  onResolve,
  onAlways,
  onHour,
  approvedInARow = null,
}: {
  approval: Approval;
  canApprove: boolean;
  resolving: boolean;
  onResolve: (a: Approval, status: Exclude<ApprovalStatus, "pending" | "expired">) => void;
  /** « Décider une fois » (console locale) : approuver, et ne plus demander pour cet outil. */
  onAlways?: (a: Approval) => void;
  onHour?: (a: Approval) => void;
  /** Approbations de suite du même outil : au-delà du seuil, on propose de décider une fois. */
  approvedInARow?: number | null;
}) {
  const suggest = onAlways !== undefined && approvedInARow !== null;
  const text = describeApproval(approval);
  const expiry = expiresIn(approval.expiresAt);
  /* En local, l'agent se reconnaît à sa mascotte, comme dans la notification. */
  const local = useLocalMode();
  const face = useFaces()(approval.agentName);
  const mascot = face.id;
  return (
    <Surface className={`overflow-hidden ${text.untrusted ? "ring-1 ring-warning/50" : ""}`} data-testid={`card-approval-${approval.id}`}>
      {text.untrusted && (
        /* La session a lu du contenu écrit par d'autres : c'est la demande à LIRE avant de cliquer. */
        <div className="flex items-start gap-3 border-b border-warning/20 bg-warning-soft px-5 py-3.5 sm:px-6" data-testid={`untrusted-${approval.id}`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-[13px] leading-relaxed">
            <span className="font-semibold">This session read untrusted content</span> — {text.untrusted}. It may contain instructions written by someone else. Read
            this request before you approve it.
          </p>
        </div>
      )}
      <div className="flex items-start gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
        {local ? (
          <span className="oath-glow flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-background/40" style={glowOf(mascot)}>
            <img src={`/mascots/${mascot}.png`} alt={face.name} title={face.name} className="h-14 w-14 object-contain" />
          </span>
        ) : (
          <span className="hidden sm:block">
            <Avatar name={approval.agentName} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-muted-foreground">
            <Link href={`/agents/${approval.agentId}`} className="font-medium text-foreground/80 hover:text-primary">
              {approval.agentName}
            </Link>
            {" · "}
            {relativeTime(approval.requestedAt)}
            {expiry ? ` · ${expiry}` : ""}
          </p>
          <h2 className="mt-0.5 text-[20px] font-semibold leading-snug tracking-[-0.02em]">{text.headline}</h2>
          {text.where && <p className="text-[15px] text-muted-foreground">{text.where}</p>}
        </div>
        <RiskBadge risk={approval.risk} />
      </div>

      {(text.command || text.details.length > 0) && (
        <div className="mx-6 mt-5 overflow-hidden rounded-xl bg-muted/70">
          {text.command && <pre className="whitespace-pre-wrap break-all px-4 py-3 font-mono text-[13px] leading-relaxed">{text.command}</pre>}
          {text.details.length > 0 && (
            <dl className={text.command ? "border-t border-card-border" : ""}>
              {text.details.map((c) => (
                <div key={c.label} className="flex flex-col gap-0.5 border-b border-card-border/70 px-4 py-2.5 text-[13px] last:border-b-0 sm:flex-row sm:gap-4">
                  <dt className="shrink-0 text-muted-foreground sm:w-32">{contextLabel(c.label)}</dt>
                  <dd className="min-w-0 flex-1 break-words font-mono">{c.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      <p className="mx-6 mt-4 text-[13px] text-muted-foreground">
        <span className="font-medium text-foreground/80">Why you are asked:</span> {approval.policyName || reasonLabel(approval.summary)}
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-card-border bg-muted/30 px-6 py-4">
        <p className="text-[13px] text-muted-foreground" data-testid={suggest ? `text-decide-once-${approval.id}` : undefined}>
          {suggest ? `You approved this tool ${String(approvedInARow)} times in a row. Decide once?` : canApprove ? "Only this request is decided. Nothing else is allowed." : "You can read this request, but not decide it."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={!canApprove || resolving}
            onClick={() => {
              if (canApprove) onResolve(approval, "rejected");
            }}
            data-testid={`button-reject-${approval.id}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          >
            <X className="h-4 w-4" aria-hidden /> Reject
          </button>
          {onHour && (
            <button
              disabled={resolving}
              onClick={() => onHour(approval)}
              data-testid={`button-approve-hour-${approval.id}`}
              className="inline-flex h-9 items-center rounded-full px-4 text-[14px] font-medium text-foreground/80 transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Allow 1 hour
            </button>
          )}
          {onAlways && (
            <button
              disabled={resolving}
              onClick={() => onAlways(approval)}
              data-testid={`button-approve-always-${approval.id}`}
              className={`inline-flex h-9 items-center rounded-full px-4 text-[14px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${suggest ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-foreground/80 hover:bg-muted"}`}
            >
              Approve, don't ask again
            </button>
          )}
          <button
            disabled={!canApprove || resolving}
            onClick={() => {
              if (canApprove) onResolve(approval, "approved");
            }}
            data-testid={`button-approve-${approval.id}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <Check className="h-4 w-4" aria-hidden /> Approve
          </button>
        </div>
      </div>
    </Surface>
  );
}
