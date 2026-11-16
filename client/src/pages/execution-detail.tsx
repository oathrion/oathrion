import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { ArrowLeft, Loader2, RotateCcw, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryAffordance, toolOutcome } from "@/lib/run-presentation";
import { useToast } from "@/hooks/use-toast";
import {
  EmptyState,
  ErrorState,
  KeyValue,
  PageHeader,
  SectionCard,
  Surface,
  TableSkeleton,
} from "@/components/common/primitives";
import { ExecutionStatusBadge, Pill, RiskBadge } from "@/components/common/badges";
import { useARIA } from "@/lib/store";
import { api, type ExecutionDto } from "@/lib/api";
import { ApiError } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { currency, duration, fullDate, timeOfDay } from "@/lib/format";
import { auditEventLabel } from "@/lib/audit-labels";
import { decisionLabel, reasonLabel, resultLabel } from "@/lib/server-text";

const RUN_STATE_LABEL: Record<string, string> = {
  pending: "PENDING",
  running: "RUNNING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  skipped: "NOT STARTED",
};

const RUN_STATE_TONE = {
  pending: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
} as const;

const DECISION_TONE = {
  allow: "success",
  block: "danger",
  require_approval: "warning",
} as const;

export default function ExecutionDetailPage() {
  const [, params] = useRoute("/executions/:id");
  const { executions, loading, error, reload, retryExecution } = useARIA();
  const { can } = useAuth();
  const { toast } = useToast();
  const canExecute = can("execute");
  const canApprove = can("approve");
  const [checkedService, setCheckedService] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const id = params?.id ?? "";
  const cached = executions.find((e) => e.id === id);

  /*
   * ABSENTE DU CACHE ≠ ABSENTE DU SERVEUR. La liste du client est chargée à la connexion ;
   * une exécution créée depuis — par le scénario du démarrage guidé, par un agent — n'y
   * est pas. Le lien « Reçu d'audit » du démarrage menait donc à « Execution not found »
   * pour une exécution qui venait d'avoir lieu (relevé en répétant la recette
   * utilisateur). La page demande d'abord au serveur : présente, elle l'affiche telle
   * que le serveur l'a rendue et recharge le cache une fois (les listes la montreront) —
   * jamais en boucle, puisque l'exécution affichée ne dépend plus du cache ; absente
   * (404), elle le dit ; injoignable, elle le dit autrement.
   */
  const [lookup, setLookup] = useState<
    { id: string; verdict: "found"; execution: ExecutionDto } | { id: string; verdict: "missing" | "unreachable" } | null
  >(null);
  const fetched = lookup?.id === id && lookup.verdict === "found" ? lookup.execution : undefined;
  const execution = cached ?? fetched;
  const mustAsk = !loading && !error && !execution && id !== "";
  useEffect(() => {
    if (!mustAsk) return;
    let cancelled = false;
    api.getExecution(id).then(
      (found) => {
        if (cancelled) return;
        setLookup({ id, verdict: "found", execution: found });
        reload();
      },
      (failure: unknown) => {
        if (cancelled) return;
        setLookup({ id, verdict: failure instanceof ApiError && failure.status === 404 ? "missing" : "unreachable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mustAsk, id, reload]);
  const verdict = lookup?.id === id ? lookup.verdict : null;


  if (loading || (mustAsk && verdict === null)) {
    return (
      <Surface className="p-6">
        <TableSkeleton rows={4} cols={2} />
      </Surface>
    );
  }

  // Do not label an unreachable ledger as a record that has been rotated away.
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!execution && verdict === "unreachable") {
    return <ErrorState message="Could not reach Oathrion to load this execution." onRetry={reload} />;
  }

  if (!execution) {
    return (
      <Surface>
        <EmptyState
          icon={Terminal}
          title="Execution not found"
          description="This execution does not exist, or is no longer kept."
          action={
            <Link
              href="/executions"
              className="inline-flex h-9 items-center rounded-lg border border-card-border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              Back to executions
            </Link>
          }
        />
      </Surface>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/executions"
        data-testid="link-back-executions"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Executions
      </Link>

      <PageHeader
        title={execution.action}
        subtitle={`${execution.agentName} · ${execution.id}`}
        actions={
          <div className="flex items-center gap-2">
            <RiskBadge risk={execution.risk} />
            <ExecutionStatusBadge status={execution.status} />
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <SectionCard title="Request" bodyClassName="grid gap-x-8 px-5 sm:grid-cols-2">
            <KeyValue label="Agent">
              <Link href={`/agents/${execution.agentId}`} className="text-primary hover:opacity-70">
                {execution.agentName}
              </Link>
            </KeyValue>
            <KeyValue label="Action">{execution.action}</KeyValue>
            <KeyValue label="Target">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{execution.target}</code>
            </KeyValue>
            <KeyValue label="Date">{fullDate(execution.timestamp)}</KeyValue>
            <KeyValue label="Duration">
              <span className="tabular">{duration(execution.durationMs)}</span>
            </KeyValue>
            <KeyValue label="Cost">
              <span className="tabular">{currency(execution.cost, 3)}</span>
            </KeyValue>
          </SectionCard>

          <SectionCard title="Data sent" description="What the agent submitted to Oathrion.">
            <pre className="overflow-x-auto px-5 py-4 font-mono text-xs leading-relaxed text-muted-foreground">
              {JSON.stringify(execution.input, null, 2)}
            </pre>
          </SectionCard>

          <SectionCard title="Log" description="Hash-chained log of this execution. Tamper-evident: edits break the chain and are reported.">
            <ol className="divide-y divide-card-border">
              {execution.audit.map((a, i) => (
                <li key={i} className="flex gap-4 px-5 py-3.5">
                  <span className="shrink-0 tabular text-xs text-muted-foreground">
                    {timeOfDay(a.at)}
                  </span>
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-medium">{auditEventLabel(a.event)}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{a.detail ? reasonLabel(a.detail) : null}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground/70">{a.actor}</p>
                  </div>
                </li>
              ))}
            </ol>
          </SectionCard>
        </div>

        <div className="min-w-0 space-y-6">
          <SectionCard title="Decision" description="What the policy engine decided.">
            <div className="space-y-4 px-5 py-4">
              <Pill tone={DECISION_TONE[execution.decision]} dot className="text-sm">
                {decisionLabel(execution.decision)}
              </Pill>
              <p className="text-sm text-muted-foreground">{reasonLabel(execution.decisionReason)}</p>
            </div>
          </SectionCard>

          <SectionCard title="Rule applied">
            <div className="px-5 py-4">
              {execution.policyEvaluated ? (
                <>
                  <p className="text-sm font-medium">{execution.policyEvaluated}</p>
                  <Link
                    href="/policies"
                    className="mt-1 inline-block text-xs font-medium text-primary hover:opacity-70"
                  >
                    See the policies
                  </Link>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No rule targeted this action: the organisation's default posture applied.
                </p>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Result">
            <p className="px-5 py-4 text-sm text-muted-foreground">{resultLabel(execution.result)}</p>
          </SectionCard>

          <SectionCard
            title="Tool execution"
            description="The path of the tool call, tracked by the server."
          >
            <div className="space-y-4 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                {/*
                  * Un essai dont le service a reçu la requête sans répondre n'est pas un
                  * ÉCHEC : l'action a peut-être eu lieu. L'étiquette vient de ce que le
                  * connecteur a établi (`dispatched: "unknown"`), pas d'une supposition.
                  */}
                {toolOutcome({ attempted: true, succeeded: execution.runState === "succeeded", toolResult: execution.toolResult }) === "unknown" ? (
                  <Pill tone="warning" dot>
                    UNKNOWN OUTCOME
                  </Pill>
                ) : (
                  <Pill tone={RUN_STATE_TONE[execution.runState ?? "pending"]} dot>
                    {RUN_STATE_LABEL[execution.runState ?? "pending"]}
                  </Pill>
                )}
                <span className="tabular text-xs text-muted-foreground">
                  {execution.attempts ?? 0} attempt{(execution.attempts ?? 0) > 1 ? "s" : ""}
                </span>
              </div>

              {execution.lastError && (
                <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
                  {execution.lastError}
                </p>
              )}

              {/*
                * §8 — the button and the explanation both come from the server.
                *
                * The decision itself lives in `retryAffordance` (client/src/lib/
                * run-presentation.ts) and is unit-tested there. It used to be nested
                * ternaries here, which is how two false statements survived: the button
                * was gated on `runState === "failed"` while the backend refuses a retry
                * for three reasons, and a reader without `execute` looking at a FAILED
                * run was told "Waiting for a worker to claim this run".
                */}
              {(() => {
                const affordance = retryAffordance(execution.retry, canExecute, canApprove);
                if (affordance.kind === "confirm") {
                  /*
                   * EFFET INCONNU. Le service a reçu la requête sans répondre : l'action a
                   * peut-être eu lieu. Pas de bouton « réessayer » tout court — seulement
                   * une confirmation, par quelqu'un qui peut approuver, APRÈS vérification.
                   */
                  return (
                    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3" data-testid="panel-unknown-effect">
                      <p className="text-xs font-medium">Unknown outcome: check with the service before any new attempt.</p>
                      <p className="text-xs text-muted-foreground">{affordance.message}</p>
                      {affordance.canConfirm ? (
                        <>
                          <label className="flex items-start gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={checkedService}
                              onChange={(e) => setCheckedService(e.target.checked)}
                              className="mt-0.5"
                              data-testid="checkbox-confirm-not-applied"
                            />
                            I confirm I checked in the service that this action did NOT happen. Oathrion cannot check this
                            itself: my confirmation is written to the log, under my name.
                          </label>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            disabled={retrying || !checkedService}
                            data-testid="button-retry-confirmed"
                            onClick={async () => {
                              setRetrying(true);
                              try {
                                await retryExecution(execution.id, true);
                                toast({ title: "New attempt sent", description: "Your confirmation is written to the log." });
                              } catch (err) {
                                toast({
                                  title: "The server refused the new attempt",
                                  description: err instanceof Error ? err.message : undefined,
                                  variant: "destructive",
                                });
                              } finally {
                                setRetrying(false);
                                setCheckedService(false);
                              }
                            }}
                          >
                            {retrying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
                            Confirm and retry
                          </Button>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">Only a person who can approve can confirm and retry.</p>
                      )}
                    </div>
                  );
                }
                if (affordance.kind !== "button") {
                  return (
                    <p className="text-xs text-muted-foreground" data-testid="text-retry-blocked">
                      {affordance.message}
                    </p>
                  );
                }
                return (
                  <div className="space-y-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={retrying}
                      data-testid="button-retry-execution"
                      onClick={async () => {
                        if (!canExecute) return;
                        setRetrying(true);
                        try {
                          await retryExecution(execution.id);
                          toast({ title: "New attempt sent" });
                        } catch (err) {
                          // The server's message names the actual reason (and the
                          // ceiling, when that is the reason). Discarding it in favour
                          // of a generic line left the operator nothing to act on.
                          toast({
                            title: "The server refused this new attempt",
                            description: err instanceof Error ? err.message : undefined,
                            variant: "destructive",
                          });
                        } finally {
                          setRetrying(false);
                        }
                      }}
                    >
                      {retrying ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <RotateCcw className="h-4 w-4" aria-hidden />
                      )}
                      Retry the tool
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {affordance.remaining} attempt(s) left of {affordance.max}.
                    </p>
                  </div>
                );
              })()}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
