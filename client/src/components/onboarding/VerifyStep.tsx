import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowUpRight, Check, Loader2, Play, X } from "lucide-react";

import { notifyScenario, resolveApproval, runScenario, type ScenarioStep } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useARIA } from "@/lib/store";
import type { Agent } from "@/types";

import { ACTION_LABEL, DecisionBadge, StepShell, decisionSentence, primaryButton, secondaryButton } from "./shared";

/** Ce qu'une étape est devenue après une approbation ou un refus dans cette page. */
interface Resolution {
  outcome: "approved" | "rejected";
  succeeded: boolean;
  effectUnknown: boolean;
  url: string | null;
  summary: string | null;
}

function serviceOf(url: string): string {
  if (url.includes("github.com")) return "GitHub";
  if (url.includes("linear.app")) return "Linear";
  if (url.includes("slack.com")) return "Slack";
  if (url.includes("stripe.com")) return "Stripe";
  return "the service";
}

/**
 * Ce que le scénario a rendu, gardé dans le cache de la console et non dans l'état de
 * l'écran : relevé en répétant la recette à blanc (STRESS-TEST-LOG §5.15), les résultats
 * — et donc les liens « Reçu d'audit » de l'étape 8 — disparaissaient dès qu'on ouvrait un
 * autre écran, puisque quitter le démarrage démonte ce composant. Le cache est vidé à la
 * déconnexion ; un rechargement complet déconnecte de toute façon.
 */
export const SCENARIO_MEMORY = "onboarding-scenario";

interface Remembered {
  steps: ScenarioStep[];
  resolutions: Record<string, Resolution>;
}

export function VerifyStep({ agent, slackChosen }: { agent: Agent | null; slackChosen: boolean }) {
  const { can } = useAuth();
  const { refresh: refreshSnapshot } = useARIA();
  const queryClient = useQueryClient();
  const memoryKey = [SCENARIO_MEMORY, agent?.id ?? ""];
  const remembered = agent ? queryClient.getQueryData<Remembered>(memoryKey) : undefined;
  const [steps, setSteps] = useState<ScenarioStep[]>(remembered?.steps ?? []);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>(remembered?.resolutions ?? {});

  useEffect(() => {
    if (!agent || steps.length === 0) return;
    queryClient.setQueryDefaults([SCENARIO_MEMORY], { gcTime: Infinity });
    queryClient.setQueryData<Remembered>([SCENARIO_MEMORY, agent.id], { steps, resolutions });
  }, [agent, steps, resolutions, queryClient]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!agent) return;
    setPending("run");
    setError(null);
    setResolutions({});
    const result = await runScenario(agent.id);
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSteps(result.steps);
    /* Le scénario a écrit des exécutions et, peut-être, des demandes d'approbation. */
    refreshSnapshot();
  }

  async function resolve(step: ScenarioStep, decision: "approve" | "reject") {
    if (!step.approvalId) return;
    setPending(step.approvalId);
    const result = await resolveApproval(step.approvalId, decision);
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setResolutions((r) => ({
      ...r,
      [step.approvalId!]: {
        outcome: decision === "approve" ? "approved" : "rejected",
        succeeded: result.succeeded,
        effectUnknown: result.effectUnknown,
        url: result.url,
        summary: result.summary,
      },
    }));
    refreshSnapshot();
  }

  async function notify() {
    if (!agent) return;
    setPending("notify");
    setError(null);
    const ids = steps.filter((s) => s.executionId && s.key !== "notify").map((s) => s.executionId!);
    const result = await notifyScenario(agent.id, ids);
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSteps((s) => [...s.filter((x) => x.key !== "notify"), result.step]);
  }

  const waiting = steps.filter((s) => s.decision === "APPROVAL_REQUIRED" && s.approvalId && !resolutions[s.approvalId]);
  const notified = steps.some((s) => s.key === "notify");

  return (
    <StepShell
      eyebrow="Step 5 of 5"
      title="Check the control on a real action"
      lead={
        <>
          Oathrion plays a team agent's task in the name of <strong className="text-foreground">{agent?.name ?? "your agent"}</strong>{" "}
          : read the context, prepare a task, propose an issue, and deliberately try to act outside what you allowed.
          Each action goes through your rules and reaches the real service — except the ones Oathrion stops.
        </>
      }
    >
      {!agent && <p className="text-sm text-muted-foreground">Create the agent at step 4 first.</p>}

      {agent && steps.length === 0 && (
        <button type="button" onClick={() => void run()} disabled={pending !== null} className={primaryButton}>
          {pending === "run" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          Run the scenario
        </button>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {steps.length > 0 && (
        <ol className="relative space-y-4 border-l border-border pl-6" aria-label="Scenario run">
          {steps.map((step) => {
            const resolution = step.approvalId ? resolutions[step.approvalId] : undefined;
            const url = resolution?.url ?? step.url;
            return (
              <li key={`${step.key}-${step.executionId ?? step.target}`} className="relative">
                <span className="absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-muted-foreground/60" aria-hidden="true" />
                <article className="rounded-2xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">{step.title}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">{step.explanation}</p>
                    </div>
                    <DecisionBadge decision={step.decision} />
                  </div>

                  <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                    <dt className="text-muted-foreground">Action</dt>
                    <dd>
                      {ACTION_LABEL[step.action] ?? step.action} <span className="font-mono text-muted-foreground">· {step.action}</span>
                    </dd>
                    <dt className="text-muted-foreground">Resource</dt>
                    <dd className="font-mono break-all">{step.target}</dd>
                    <dt className="text-muted-foreground">Why</dt>
                    <dd>{decisionSentence(step.decision, step.policyName)}</dd>
                    <dt className="text-muted-foreground">Technical reason</dt>
                    <dd className="font-mono text-[11px] text-muted-foreground">{step.reason}</dd>
                  </dl>

                  {step.decision === "BLOCK" && (
                    <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">Nothing was sent to the service.</p>
                  )}
                  {(step.effectUnknown || resolution?.effectUnknown) && (
                    <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300" role="status">
                      The service received the request but did not answer: the action MAY have happened. Check in the
                      service before trying again — the audit receipt offers a retry on confirmation.
                    </p>
                  )}
                  {step.decision === "ALLOW" && !step.succeeded && !step.effectUnknown && (
                    <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">Allowed, but the service refused: {step.summary ?? "see the receipt."}</p>
                  )}
                  {resolution?.outcome === "rejected" && <p className="mt-3 text-sm text-muted-foreground">Rejected: nothing was sent.</p>}
                  {resolution?.outcome === "approved" && resolution.succeeded && (
                    <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">Approved — the service carried out the action.</p>
                  )}
                  {resolution?.outcome === "approved" && !resolution.succeeded && !resolution.effectUnknown && (
                    <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">Approved, but the service refused: {resolution.summary ?? "see the receipt."}</p>
                  )}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {step.decision === "APPROVAL_REQUIRED" && step.approvalId && !resolution && (
                      can("approve") ? (
                        <>
                          <button type="button" onClick={() => void resolve(step, "approve")} disabled={pending !== null} className={primaryButton}>
                            {pending === step.approvalId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
                            Approve
                          </button>
                          <button type="button" onClick={() => void resolve(step, "reject")} disabled={pending !== null} className={secondaryButton}>
                            <X className="h-4 w-4" aria-hidden="true" /> Reject
                          </button>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">Waiting for an approver, in "Approvals".</p>
                      )
                    )}
                    {url && (
                      <a href={url} target="_blank" rel="noreferrer" className={secondaryButton}>
                        See in {serviceOf(url)} <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                      </a>
                    )}
                    {step.executionId && (
                      <Link href={`/executions/${step.executionId}`} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
                        Audit receipt
                      </Link>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}

      {steps.length > 0 && (
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {slackChosen && !notified && (
            <button type="button" onClick={() => void notify()} disabled={pending !== null || waiting.length > 0} className={primaryButton}>
              {pending === "notify" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Post the summary to Slack
            </button>
          )}
          {waiting.length > 0 && slackChosen && !notified && (
            <p className="text-xs text-muted-foreground">Decide on the pending actions first: the summary announces their outcome.</p>
          )}
          <button type="button" onClick={() => void run()} disabled={pending !== null} className={secondaryButton}>
            Run the scenario again
          </button>
          <Link href="/executions" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            The whole log
          </Link>
        </div>
      )}
    </StepShell>
  );
}
