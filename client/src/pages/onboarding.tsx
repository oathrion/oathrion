/**
 * Le démarrage guidé — cinq étapes, de l'espace vide à une action réelle contrôlée.
 *
 * ## La progression n'est pas enregistrée : elle est LUE
 *
 * Chaque coche vient de l'état réel : un outil est « fait » quand le service a répondu,
 * le périmètre quand la règle existe, l'agent quand il existe. Une progression stockée à
 * part dirait « terminé » le jour où un jeton est révoqué ; celle-ci dit la vérité au
 * moment où la page s'ouvre, et elle reprend là où l'équipe s'était arrêtée.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { api, getOrganization, getSelection, listConnectors } from "@/lib/api";
import { useARIA } from "@/lib/store";
import { cn } from "@/lib/utils";

import { AgentStep, ONBOARDING_TAG } from "@/components/onboarding/AgentStep";
import { ScopeStep } from "@/components/onboarding/ScopeStep";
import { ToolsStep } from "@/components/onboarding/ToolsStep";
import { VerifyStep } from "@/components/onboarding/VerifyStep";
import { WorkspaceStep } from "@/components/onboarding/WorkspaceStep";

const STEPS = [
  { key: "workspace", label: "Your workspace" },
  { key: "tools", label: "Your tools" },
  { key: "scope", label: "What is allowed" },
  { key: "agent", label: "Your agent" },
  { key: "verify", label: "Check" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

/** Le résultat d'un retour OAuth, quand il arrive par l'adresse (fenêtre surgissante bloquée). */
function readReturn(): { connector: string; result: string; reason: string } | null {
  const hash = window.location.hash;
  if (!hash.includes("?")) return null;
  const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const result = params.get("result");
  if (!result) return null;
  window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}#/onboarding`);
  return { connector: params.get("connector") ?? "", result, reason: params.get("reason") ?? "" };
}

export default function OnboardingPage() {
  const queryClient = useQueryClient();
  const { refresh: refreshSnapshot } = useARIA();
  const { toast } = useToast();

  const organization = useQuery({ queryKey: ["/api/organization"], queryFn: getOrganization });
  const connectors = useQuery({ queryKey: ["/api/connectors"], queryFn: listConnectors });
  const agents = useQuery({ queryKey: ["/api/agents"], queryFn: api.listAgents });

  const connectedIds = (connectors.data ?? []).filter((c) => c.status.state === "connected").map((c) => c.id);
  const selections = useQuery({
    queryKey: ["/api/connectors", "selections", connectedIds.join(",")],
    queryFn: async () => Object.fromEntries(await Promise.all(connectedIds.map(async (id) => [id, await getSelection(id)] as const))),
    enabled: connectors.isSuccess,
  });

  const agent = useMemo(
    () => (agents.data ?? []).find((a) => a.tags?.includes(ONBOARDING_TAG) && a.status === "active") ?? null,
    [agents.data],
  );

  const done: Record<StepKey, boolean> = {
    workspace: organization.isSuccess,
    tools: connectedIds.length > 0,
    scope: connectedIds.length > 0 && connectedIds.every((id) => selections.data?.[id]?.resources != null),
    agent: agent !== null,
    verify: false,
  };

  const firstOpen = STEPS.find((s) => !done[s.key])?.key ?? "verify";
  const loaded = organization.isSuccess && connectors.isSuccess && agents.isSuccess && selections.isSuccess;
  /*
   * L'étape d'ouverture est calculée UNE fois, au premier chargement complet ; ensuite,
   * seule la personne change d'étape. Recalculée à chaque rendu, elle faisait sauter
   * l'écran à l'étape 3 dès le premier outil connecté — au moment précis où l'on voulait
   * connecter le deuxième.
   */
  const [current, setCurrent] = useState<StepKey | null>(null);
  const active = current ?? (loaded ? firstOpen : "workspace");
  const [opened, setOpened] = useState(false);
  if (loaded && !opened) {
    setOpened(true);
    if (current === null) setCurrent(firstOpen);
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/connectors"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/policies"] });
    /* Les écrans Agents, Politiques, Exécutions lisent l'instantané, pas ce cache. */
    refreshSnapshot();
  };

  /* Le retour d'une autorisation : par message (fenêtre surgissante) ou par l'adresse. */
  useEffect(() => {
    const announce = (connector: string, result: string, reason: string) => {
      refresh();
      const label = connector ? connector.charAt(0).toUpperCase() + connector.slice(1) : "The service";
      toast(
        result === "connected"
          ? { title: `${label} is connected`, description: "The service confirmed the connection." }
          : { title: `${label} was not connected`, description: reason || "Start the connection again.", variant: "destructive" },
      );
      setCurrent("tools");
    };
    const fromAddress = readReturn();
    if (fromAddress) announce(fromAddress.connector, fromAddress.result, fromAddress.reason);

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; connector?: string; result?: string; reason?: string } | null;
      if (data?.type !== "placet-connector-return") return;
      announce(data.connector ?? "", data.result ?? "error", data.reason ?? "");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const index = STEPS.findIndex((s) => s.key === active);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">Get started</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Five steps for a real action of your agents to go through Oathrion — and for you to see what it allowed,
          held or blocked. You can leave this page: it will pick up where you left off.
        </p>
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Getting started steps" className="min-w-0">
          <ol className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
            {STEPS.map((step, i) => {
              const isActive = step.key === active;
              const isDone = done[step.key];
              return (
                <li key={step.key} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setCurrent(step.key)}
                    aria-current={isActive ? "step" : undefined}
                    aria-label={`Step ${i + 1}: ${step.label}${isDone ? " (done)" : ""}`}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                      isActive ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
                        isDone ? "border-emerald-500 bg-emerald-500 text-white" : isActive ? "border-primary text-primary" : "border-border",
                      )}
                      aria-hidden="true"
                    >
                      {isDone ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </span>
                    <span className="whitespace-nowrap">{step.label}</span>
                    {isDone && <span className="sr-only">(done)</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="relative min-w-0" key={active}>
          {connectors.isError && (
            <p className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
              Oathrion is not answering. Check your connection, then reload the page.
            </p>
          )}
          {active === "workspace" && (
            <WorkspaceStep
              organizationName={organization.data?.name ?? ""}
              memberCount={organization.data?.memberCount ?? null}
              onNext={() => setCurrent("tools")}
            />
          )}
          {active === "tools" && <ToolsStep connectors={connectors.data ?? []} onChanged={refresh} onNext={() => setCurrent("scope")} />}
          {active === "scope" && (
            <ScopeStep
              connectors={connectors.data ?? []}
              onSaved={() => void selections.refetch()}
              onNext={() => setCurrent("agent")}
            />
          )}
          {active === "agent" && (
            <AgentStep connectors={connectors.data ?? []} agent={agent} onCreated={refresh} onNext={() => setCurrent("verify")} />
          )}
          {active === "verify" && (
            <VerifyStep agent={agent} slackChosen={(selections.data?.slack?.resources?.length ?? 0) > 0} />
          )}
          <p className="sr-only" aria-live="polite">
            Étape {index + 1} sur {STEPS.length} : {STEPS[index]?.label}
          </p>
        </div>
      </div>
    </div>
  );
}
