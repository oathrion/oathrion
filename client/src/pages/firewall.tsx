/**
 * LE PARE-FEU — le journal d'interception, et le bouton qui tranche.
 *
 * ## Ce que cet écran est
 *
 * Deux choses, et rien d'autre : ce qui est passé par le proxy avec la décision rendue,
 * et les requêtes retenues avec un bouton Approuver / Rejeter. C'est l'écran qu'un
 * opérateur garde ouvert pendant un pilote.
 *
 * ## Ce qu'il n'invente pas
 *
 * Chaque ligne est une exécution réelle, relue depuis `/api/executions`. La décision, la
 * règle qui l'a rendue, le montant évalué, l'horodatage : tout vient du serveur. Il n'y a
 * pas de ligne d'exemple, pas de compteur estimé, et aucune ligne n'apparaît avant qu'une
 * requête soit réellement passée.
 *
 * Une base vide affiche un vide — pas une démonstration.
 *
 * ## Le rafraîchissement, et pourquoi 4 secondes
 *
 * Un journal « temps réel » voudrait un flux poussé. Un flux poussé veut un transport
 * supplémentaire à authentifier, à limiter en débit et à reconnecter, pour gagner trois
 * secondes sur un écran qu'un humain lit. Un rafraîchissement court le dit aussi bien et
 * n'ajoute aucune surface. Quand le volume le justifiera, ce sera un vrai flux, pas un
 * intervalle plus court.
 */

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert, ShieldCheck, ShieldX, XCircle } from "lucide-react";

import { Pill, RiskBadge } from "@/components/common/badges";
import { EmptyState, ErrorState, PageHeader, Surface } from "@/components/common/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import type { ExecutionDto } from "@/lib/api";
import type { Approval } from "@/types";

const EXECUTIONS_KEY = ["/api/executions"] as const;
const APPROVALS_KEY = ["/api/approvals"] as const;

/** Quatre secondes : voir l'en-tête pour pourquoi ce n'est pas un flux poussé. */
const REFRESH_MS = 4_000;

/**
 * Une exécution est-elle venue du proxy ?
 *
 * `interceptRule` est posé par `server/routes-intercept.ts` et persisté avec
 * l'exécution. Filtrer là-dessus plutôt que sur le verbe est ce qui distingue une
 * requête INTERCEPTÉE d'un appel passé directement par `/api/execute` — les deux peuvent
 * porter le même verbe, et seule la première a traversé le pare-feu.
 */
function interceptRuleOf(execution: ExecutionDto): string | null {
  const value = (execution.input as Record<string, unknown> | undefined)?.interceptRule;
  return typeof value === "string" && value !== "" ? value : null;
}

const DECISION_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  allow: "success",
  allowed: "success",
  block: "danger",
  blocked: "danger",
  approval_required: "warning",
  pending: "warning",
};

function decisionIcon(decision: string) {
  const d = decision.toLowerCase();
  if (d.startsWith("block")) return ShieldX;
  if (d.startsWith("approval") || d === "pending") return ShieldAlert;
  return ShieldCheck;
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString();
}

export default function FirewallPage() {
  const { can } = useAuth();
  const canApprove = can("approve");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const executions = useQuery({
    queryKey: EXECUTIONS_KEY,
    queryFn: api.listExecutions,
    refetchInterval: REFRESH_MS,
  });
  const approvals = useQuery({
    queryKey: APPROVALS_KEY,
    queryFn: api.listApprovals,
    refetchInterval: REFRESH_MS,
  });

  /** Le journal : uniquement ce qui est passé par le proxy, le plus récent d'abord. */
  const intercepted = useMemo(() => {
    const rows = executions.data ?? [];
    return rows
      .filter((row) => interceptRuleOf(row) !== null)
      .slice()
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [executions.data]);

  /** Les retenues : une approbation en attente dont l'exécution vient du proxy. */
  const held = useMemo(() => {
    const byId = new Map((executions.data ?? []).map((row) => [row.id, row]));
    return (approvals.data ?? [])
      .filter((approval) => approval.status === "pending")
      .map((approval) => ({
        approval,
        execution: approval.executionId ? byId.get(approval.executionId) : undefined,
      }))
      .filter((entry) => entry.execution === undefined || interceptRuleOf(entry.execution) !== null);
  }, [approvals.data, executions.data]);

  const resolve = async (approval: Approval, status: "approved" | "rejected") => {
    try {
      await api.resolveApproval(approval.id, status);
      /*
       * Les DEUX listes sont invalidées : approuver relâche l'action, donc l'exécution
       * change aussi. N'invalider que la file laisserait le journal afficher « retenu »
       * pour une requête déjà partie.
       */
      await queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
      await queryClient.invalidateQueries({ queryKey: EXECUTIONS_KEY });
      toast({
        title: status === "approved" ? "Action released" : "Action rejected",
        description:
          status === "approved"
            ? "The request was passed to the API. The log carries the provider's answer."
            : "Nothing was passed on. The rejection is recorded.",
        variant: status === "approved" ? undefined : "destructive",
      });
    } catch (cause) {
      toast({
        title: "The decision could not be recorded",
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "destructive",
      });
    }
  };

  if (executions.isError || approvals.isError) {
    const error = executions.error ?? approvals.error;
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "The log could not be read."}
        onRetry={() => {
          void queryClient.invalidateQueries({ queryKey: EXECUTIONS_KEY });
          void queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Firewall"
        subtitle="What went through the proxy, and what is waiting for a human decision."
      />

      {/* ------------------------------ les retenues ------------------------------ */}
      <Surface className="space-y-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Waiting for validation
            {held.length > 0 ? (
              <Pill tone="warning" className="ml-2">
                {held.length}
              </Pill>
            ) : null}
          </h3>
          {approvals.isLoading ? <Skeleton className="h-4 w-24" /> : null}
        </div>

        {held.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No request held. An action above a ceiling or targeted by an approval rule will show up
            here, and nothing will go out before a human decides.
          </p>
        ) : (
          <ul className="space-y-2">
            {held.map(({ approval, execution }) => (
              <li
                key={approval.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 p-3"
                data-testid={`held-${approval.id}`}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {/*
                      L'exécution d'abord, l'approbation en repli. `Approval` porte un
                      titre et un résumé écrits pour un humain ; l'exécution porte le
                      verbe et la cible exacts, qui sont ce sur quoi la décision a porté.
                    */}
                    <span className="font-mono">{execution?.action ?? approval.title}</span>
                    <span className="truncate font-mono text-muted-foreground">
                      {execution?.target ?? approval.requestedValue}
                    </span>
                    <RiskBadge risk={execution?.risk ?? approval.risk} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {/* Le motif du serveur, pas une phrase de cet écran. */}
                    {execution?.decisionReason ?? approval.summary}
                  </p>
                </div>
                {canApprove ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      onClick={() => void resolve(approval, "approved")}
                      data-testid={`approve-${approval.id}`}
                    >
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void resolve(approval, "rejected")}
                      data-testid={`reject-${approval.id}`}
                    >
                      <XCircle className="mr-1 h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </div>
                ) : (
                  /*
                   * Pas de bouton désactivé : un bouton gris invite à cliquer et laisse
                   * croire à un droit qu'on n'a pas. La phrase dit ce qui manque.
                   */
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Approving requires the "approve" capability.
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Surface>

      {/* ------------------------------- le journal ------------------------------- */}
      <Surface className="space-y-3 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Interception log</h3>
          <span className="text-xs text-muted-foreground">
            {intercepted.length} request{intercepted.length === 1 ? "" : "s"} · refreshed every{" "}
            {REFRESH_MS / 1000} s
          </span>
        </div>

        {executions.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : intercepted.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No request intercepted"
            description="Point your agent's base URL at /api/v1/intercept/<destination>. Every request will show up here with the decision made."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Time</th>
                  <th className="pb-2 pr-4 font-medium">Decision</th>
                  <th className="pb-2 pr-4 font-medium">Rule</th>
                  <th className="pb-2 pr-4 font-medium">Action</th>
                  <th className="pb-2 pr-4 font-medium">Target</th>
                  <th className="pb-2 pr-4 font-medium">Evaluated</th>
                  <th className="pb-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {intercepted.map((row) => {
                  const Icon = decisionIcon(row.decision);
                  const amount = (row.input as Record<string, unknown>).amount;
                  const currency = (row.input as Record<string, unknown>).currency;
                  return (
                    <tr key={row.id} className="border-t" data-testid={`intercept-${row.id}`}>
                      <td className="py-2 pr-4 font-mono text-xs tabular-nums">{shortTime(row.timestamp)}</td>
                      <td className="py-2 pr-4">
                        <Pill tone={DECISION_TONE[row.decision.toLowerCase()] ?? "neutral"} dot>
                          <Icon className="mr-1 inline h-3 w-3" />
                          {row.decision}
                        </Pill>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{interceptRuleOf(row)}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{row.action}</td>
                      <td className="max-w-[16rem] truncate py-2 pr-4 font-mono text-xs">{row.target}</td>
                      <td className="py-2 pr-4 text-xs tabular-nums">
                        {/* Ce que la politique a pesé — extrait de la requête, pas annoncé par l'agent. */}
                        {typeof amount === "number"
                          ? `${String(amount)} ${typeof currency === "string" ? currency : ""}`.trim()
                          : "—"}
                      </td>
                      <td className="py-2 text-xs">
                        <span className="text-muted-foreground">{row.result || row.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {/*
        LA LIMITE, AFFICHÉE DANS L'ÉCRAN ET PAS SEULEMENT DANS LA DOCUMENTATION.
        Un opérateur qui lit « 0 bloqué » doit savoir que cela peut aussi vouloir dire
        « rien ne passe par ici ». C'est la seule phrase qui empêche cet écran de rassurer
        à tort.
      */}
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        This log only shows traffic that <strong>goes through Oathrion</strong>. An agent that still
        holds the API key can call it directly, and this page will not see it. Going around becomes
        impossible — not merely discouraged — when the provider&apos;s credential lives only in
        Oathrion&apos;s vault.
      </p>
    </div>
  );
}
