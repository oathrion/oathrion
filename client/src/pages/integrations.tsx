import { useState } from "react";
import { Blocks } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  Surface,
} from "@/components/common/primitives";
import { Pill } from "@/components/common/badges";
import { Skeleton } from "@/components/ui/skeleton";
import { useARIA } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import type { Integration, IntegrationCategory } from "@/types";

const CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  "model-provider": "Model providers",
  workspace: "Workspace",
  business: "Business systems",
};

const ORDER: IntegrationCategory[] = ["model-provider", "workspace", "business"];

export default function IntegrationsPage() {
  const { integrations, loading, error, reload, toggleIntegration } = useARIA();
  const { can } = useAuth();
  const [query, setQuery] = useState("");
  const canManage = can("manage");
  const { toast } = useToast();

  const q = query.trim().toLowerCase();
  const filtered = integrations.filter(
    (i) => !q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
  );

  const handleToggle = (i: Integration) => {
    if (!canManage) return;
    // The client mirrors the API capability before promising a connection change.
    void toggleIntegration(i.id);
    toast({
      /* Rien n'a été joint : le toast ne promet pas qu'un agent peut, ou ne peut plus, atteindre le service. */
      title: i.connected ? `${i.name}: marked disconnected` : `${i.name}: marked connected`,
      description: 'Demonstration only: no service was reached. The real connections are in "Connectors".',
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        subtitle='Demonstration catalogue. The real connections are in "Connectors".'
      />

      {/*
        CET AVERTISSEMENT EST LE PLUS IMPORTANT DE CET ÉCRAN.

        Cette page n'a jamais joint aucun service. Le bouton ci-dessous bascule un booléen
        en base : aucun credential n'est demandé, aucun appel n'est passé, aucun test
        n'est fait. Un exploitant pouvait donc lire « Slack · Connected » sur un
        déploiement où rien n'avait jamais parlé à Slack.

        L'écran a quitté la navigation plutôt que d'être supprimé : la table `integrations`
        et sa route sont encore couvertes par les tests d'isolation multi-locataire, et les
        retirer dans le même mouvement mélangerait deux changements. Il reste atteignable
        par son URL, et il dit désormais ce qu'il est.
      */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <strong>Nothing is connected here.</strong> This page lists a demonstration catalogue:
        the button flips a flag, asks for no credential and reaches no service. The real
        connections — token verified with the provider, sealed with AES-256-GCM, testable,
        revocable — are in{" "}
        <a className="underline" href="#/connectors">
          Connectors
        </a>
        .
      </div>

      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Filter integrations…"
        className="max-w-sm"
        testId="input-filter-integrations"
      />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Surface key={i} className="p-5">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <Skeleton className="mt-4 h-4 w-28" />
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-5 h-8 w-24" />
            </Surface>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Surface>
          <EmptyState
            icon={Blocks}
            title="No integration matches"
            description="Try another term."
          />
        </Surface>
      ) : (
        ORDER.map((category) => {
          const rows = filtered.filter((i) => i.category === category);
          if (rows.length === 0) return null;
          return (
            <section key={category} className="space-y-3">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABEL[category]}
              </h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {rows.map((i) => (
                  <IntegrationCard key={i.id} integration={i} canManage={canManage} onToggle={() => handleToggle(i)} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function IntegrationCard({
  integration,
  canManage,
  onToggle,
}: {
  integration: Integration;
  canManage: boolean;
  onToggle: () => void;
}) {
  return (
    <Surface className="flex flex-col p-5" data-testid={`card-integration-${integration.id}`}>
      <div className="flex items-start justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-muted/60 text-sm font-semibold">
          {integration.name.slice(0, 1)}
        </span>
        <Pill tone={integration.connected ? "success" : "neutral"} dot>
          {integration.connected ? "Marked connected" : "Not connected"}
        </Pill>
      </div>

      <h3 className="mt-4 text-sm font-semibold tracking-tight">{integration.name}</h3>
      <p className="mt-1 flex-1 text-sm text-muted-foreground">{integration.description}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {integration.scopes.map((s) => (
          <code
            key={s}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {s}
          </code>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-card-border pt-4">
        <span className="text-xs text-muted-foreground">
          {integration.connected
            ? `${integration.agentsUsing} agent${integration.agentsUsing === 1 ? "" : "s"}`
            : "No agent"}
        </span>
        <button
          onClick={() => {
            if (canManage) onToggle();
          }}
          disabled={!canManage}
          data-testid={`button-toggle-integration-${integration.id}`}
          className={
            integration.connected
              ? "rounded-lg border border-card-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              : "rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          }
        >
          {integration.connected ? "Mark disconnected" : "Mark connected"}
        </button>
      </div>
    </Surface>
  );
}
