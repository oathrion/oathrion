/**
 * COUVERTURE — ce qui est réellement gouverné, et ce qui manque pour la suite.
 *
 * ## La question à laquelle cet écran répond
 *
 * Un exploitant peut déjà lire ses agents, ses politiques, ses outils et ses connecteurs
 * sur quatre écrans. Ce qu'il ne pouvait pas lire, c'est la seule question qui décide
 * s'il peut passer en pilote : **quelles actions sont effectivement contrôlées, et qu'est-ce
 * qui manque pour que la prochaine le soit ?**
 *
 * ## Tout vient du serveur, y compris la réserve
 *
 * Aucun nombre n'est calculé ici. `GET /api/coverage` compte en base, dans la portée du
 * locataire, et lit les verbes gouvernés dans la table de ROUTAGE du registre — donc ce
 * qui atteindrait réellement un outil, pas un catalogue.
 *
 * La phrase `caveat` est affichée telle quelle et ne peut pas être perdue : une liste
 * d'obstacles vide ne veut pas dire « vous êtes protégé », parce que la couverture dépend
 * aussi de ce qu'Oathrion ne voit pas.
 *
 * ## Ce que cet écran n'est pas
 *
 * Pas un assistant pas-à-pas en treize étapes. Il dit où l'on en est et quelle est la
 * prochaine action utile, avec le lien pour la faire. Un parcours guidé qui masquerait les
 * choix de sécurité serait pire qu'une liste honnête.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";

import { Pill } from "@/components/common/badges";
import { ErrorState, PageHeader, Surface } from "@/components/common/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { getCoverage } from "@/lib/api";

const QUERY_KEY = ["/api/coverage"] as const;

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warning" | "danger";
}) {
  return (
    <div className="space-y-1">
      <div
        className={
          "text-2xl font-semibold tabular-nums " +
          (tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "")
        }
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function CoveragePage() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getCoverage,
  });

  if (isError) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "The coverage could not be read."}
        onRetry={() => void refetch()}
      />
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Coverage" subtitle="What is really governed." />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const { counts, blocking, governedActions, connectors, interceptRules } = data;
  const unavailableRules = data.interceptRulesUnavailable ?? [];
  const ready = blocking.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coverage"
        subtitle="What is really governed for this organisation, counted in the database."
      />

      {/* ------------------------- la prochaine action ------------------------- */}
      <Surface className="space-y-4 p-5">
        <div className="flex items-center gap-2">
          {ready ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-warning" />
          )}
          <h3 className="text-sm font-semibold">
            {ready ? "Nothing blocks a governed action" : "What is missing, in order"}
          </h3>
        </div>

        {ready ? (
          <p className="text-sm text-muted-foreground">
            An agent is declared, a tool is reachable, a policy is active and at least one action
            has been judged. Read the caveat below before concluding that the perimeter is
            covered.
          </p>
        ) : (
          <ol className="space-y-3">
            {blocking.map((item, index) => (
              <li key={item.step} className="flex gap-3" data-testid={`blocking-${String(index)}`}>
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0 space-y-1">
                  <Link href={item.where} className="text-sm font-medium underline">
                    {item.step}
                    <ArrowRight className="ml-1 inline h-3 w-3" />
                  </Link>
                  {/* Le motif vient du serveur : il explique POURQUOI, pas seulement quoi. */}
                  <p className="text-xs text-muted-foreground">{item.why}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Surface>

      {/* ----------------------------- les chiffres ---------------------------- */}
      <Surface className="p-5">
        <h3 className="mb-4 text-sm font-semibold">Counted in the database, for this organisation</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Figure label="Declared agents" value={counts.agents} />
          <Figure label="Active policies" value={counts.policies} />
          <Figure label="Connected connectors" value={counts.connectorsConnected} />
          <Figure label="Firewall rules" value={counts.interceptRules} />
          <Figure label="Judged actions" value={counts.executions} />
          <Figure label="Allowed and executed" value={counts.allowed} />
          <Figure label="Blocked" value={counts.blocked} />
          <Figure
            label="Pending approvals"
            value={counts.pendingApprovals}
            tone={counts.pendingApprovals > 0 ? "warning" : undefined}
          />
          {/*
            En rouge quand il y en a, parce que c'est la colonne qui réclame une
            intervention : une action autorisée dont l'outil a échoué. Elle est comptée
            à part et PAS parmi les autorisées — l'y inclure masquerait précisément ce
            qu'un opérateur doit voir.
          */}
          <Figure
            label="Execution failures"
            value={counts.failed}
            tone={counts.failed > 0 ? "danger" : undefined}
          />
        </div>
      </Surface>

      {/* --------------------------- ce qui est câblé -------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Surface className="space-y-3 p-5">
          <h3 className="text-sm font-semibold">Verbs that would reach a tool</h3>
          {governedActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None. An allowed action would come back <code className="text-xs">skipped</code>:
              a real decision, no call.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {governedActions.map((action) => (
                <Pill key={action} tone="neutral">
                  <span className="font-mono text-xs">{action}</span>
                </Pill>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Read from the registry&apos;s routing table, not from a catalogue: this is what an action
            would really reach.
          </p>
        </Surface>

        <Surface className="space-y-3 p-5">
          <h3 className="text-sm font-semibold">Intercepted routes</h3>
          {interceptRules.length === 0 ? (
            /*
             * DEUX VIDES DIFFÉRENTS, et les confondre était le défaut.
             *
             * « Aucune règle déclarée » et « des règles existent mais aucune ne vous est
             * ouverte » demandent des actions opposées : écrire une règle dans un cas,
             * demander l'ouverture d'une destination dans l'autre. L'écran disait le
             * premier message dans les deux cas, donc il envoyait l'exploitant écrire une
             * règle de plus qui aurait été refusée pour la même raison que les autres.
             */
            unavailableRules.length > 0 ? (
              <p className="text-sm text-warning">
                {unavailableRules.length} rule(s) are declared on this deployment, but none is open
                to your organisation: their destination is not in your scope. A request reaching
                the proxy would be refused. Ask for the destination to be opened, rather than
                writing one more rule.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No rule declared. Any request reaching the proxy would be refused
                (<code className="text-xs">deny by default</code>).
              </p>
            )
          ) : (
            <ul className="space-y-1 text-xs">
              {interceptRules.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-baseline gap-2 font-mono">
                  <span className="font-semibold">{rule.method}</span>
                  <span>{rule.path}</span>
                  <span className="text-muted-foreground">→ {rule.action}</span>
                  <span className="text-muted-foreground">@{rule.destination}</span>
                </li>
              ))}
            </ul>
          )}

          {unavailableRules.length > 0 && interceptRules.length > 0 ? (
            /*
             * Affichées même quand d'autres règles marchent : sans cette ligne, un
             * exploitant qui écrit une règle vers une destination hors de sa portée la
             * voit simplement disparaître, et conclut que sa syntaxe est fausse.
             */
            <p className="pt-1 text-xs text-warning">
              {unavailableRules.length} other declared rule(s) are not open to you — destination
              outside your scope:{" "}
              <span className="font-mono">
                {unavailableRules.map((rule) => rule.destination).join(", ")}
              </span>
            </p>
          ) : null}

          {connectors.length > 0 ? (
            <>
              <h4 className="pt-2 text-xs font-semibold text-muted-foreground">Connectors</h4>
              <ul className="space-y-1 text-xs">
                {connectors.map((connector) => (
                  <li key={connector.id} className="flex items-center gap-2">
                    <Pill tone={connector.state === "connected" ? "success" : "neutral"} dot>
                      {connector.state === "connected" ? "connected" : connector.state}
                    </Pill>
                    <span>{connector.label}</span>
                    <span className="font-mono text-muted-foreground">
                      {connector.actions.join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Surface>
      </div>

      {/* ------------------------------ la réserve ----------------------------- */}
      <Surface className="flex gap-3 border-warning/40 bg-warning/5 p-5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">What this page cannot see</h3>
          {/*
            Rendue TELLE QUELLE depuis le serveur. Une liste d'obstacles vide ne veut pas
            dire « vous êtes protégé », et c'est la seule phrase qui empêche cet écran de
            rassurer à tort.
          */}
          <p className="text-sm text-muted-foreground">{data.caveat}</p>
        </div>
      </Surface>
    </div>
  );
}
