import type { AgentMandate } from "@shared/policy/mandate";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type {
  ApprovalResolution,
  DecisionRequest,
  DecisionResponse,
  EvaluateRequest,
  EvaluateResponse,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionDto,
} from "@/lib/api";
import type {
  ActivityEvent,
  Agent,
  Approval,
  ApprovalStatus,
  Integration,
  Permission,
  Policy,
} from "@/types";
import { activityFromExecutions } from "@shared/metrics";
import { agentTransitionMessage } from "@/lib/agent-presentation";
import { decisionLabel } from "@/lib/server-text";
import { pollWhileVisible } from "@/lib/poll";

interface ARIAState {
  loading: boolean;
  error: string | null;
  agents: Agent[];
  executions: ExecutionDto[];
  policies: Policy[];
  approvals: Approval[];
  integrations: Integration[];
  activity: ActivityEvent[];
  reload: () => void;
  /**
   * Relit l'instantané SANS repasser par les squelettes : l'écran garde ce qu'il montre
   * jusqu'à ce que la réponse arrive. Voir `useFreshSnapshot`.
   */
  refresh: () => void;
  /** Relit les seules approbations : une requête légère, que la page Approvals répète (`useLiveApprovals`). */
  refreshApprovals: () => Promise<void>;
  toggleAgentStatus: (id: string) => Promise<void>;
  addAgent: (agent: Agent) => Promise<void>;
  updateAgentMandate: (id: string, mandate: AgentMandate) => Promise<void>;
  updateAgentPermissions: (id: string, permissions: Permission[]) => Promise<void>;
  addPolicy: (policy: Policy) => Promise<void>;
  togglePolicy: (id: string) => Promise<void>;
  /*
   * `expired` is excluded alongside `pending`: it is a state the server reaches on
   * its own when a deadline passes, never an outcome a human can ask for. Letting
   * it through here would offer the console a call the API has no route for.
   */
  resolveApproval: (
    id: string,
    status: Exclude<ApprovalStatus, "pending" | "expired">,
  ) => Promise<ApprovalResolution>;
  toggleIntegration: (id: string) => Promise<void>;
  /** Sends an action through the Policy Engine and folds the outcome into state. */
  evaluate: (request: DecisionRequest) => Promise<DecisionResponse>;
  /** Runs an action through the Gateway: decision, then the tool if ALLOWed. */
  execute: (request: ExecuteRequest) => Promise<ExecuteResponse>;
  /**
   * Evaluates an action WITHOUT persisting anything: no Execution, no Approval,
   * no policy counter, no audit entry, no tool. Used by the sandbox so testing
   * a rule never pollutes the registry.
   */
  dryRun: (request: EvaluateRequest) => Promise<EvaluateResponse>;
  /**
   * Re-dispatches a tool run that failed. The server refuses anything that is
   * not an allowed execution in the `failed` state, so a success can never be
   * replayed and a blocked action can never be smuggled through.
   */
  /** `confirmNotApplied`: the caller checked the service and the earlier attempt left no effect. */
  retryExecution: (id: string, confirmNotApplied?: boolean) => Promise<void>;
}

const ARIAContext = createContext<ARIAState | null>(null);

export function ARIAProvider({ children }: { children: ReactNode }) {
  const { identity } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [executions, setExecutions] = useState<ExecutionDto[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  // Live activity only. The feed starts empty and fills from the audit trail of
  // real executions — there is no fixture behind it.
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [nonce, setNonce] = useState(0);
  const activitySeq = useRef(0);

  // Hydrates the control-plane snapshot on mount and on every manual reload.
  // `loading` starts at `true`, so the first paint already shows skeletons; the
  // flags are only flipped from inside async callbacks, never in the effect body.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listAgents(),
      api.listExecutions(),
      api.listPolicies(),
      api.listApprovals(),
      api.listIntegrations(),
    ])
      .then(([a, e, p, ap, i]) => {
        if (cancelled) return;
        setAgents(a);
        setExecutions(e);
        setPolicies(p);
        setApprovals(ap);
        setIntegrations(i);
        // Rebuilt from the audit trail on every load, so a refresh shows the
        // real history rather than whatever this tab happened to witness.
        setActivity(activityFromExecutions(e));
        setError(null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Oathrion is unreachable: the server is not answering.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  /* Stable : `useFreshSnapshot` en dépend, et ne doit relire qu'à l'ouverture de la page. */
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const refreshApprovals = useCallback(async () => {
    setApprovals(await api.listApprovals());
  }, []);

  const pushActivity = useCallback((event: Omit<ActivityEvent, "id" | "at">) => {
    activitySeq.current += 1;
    setActivity((prev) => [
      { ...event, id: `act_live_${activitySeq.current}`, at: "just now" },
      ...prev,
    ]);
  }, []);

  const value = useMemo<ARIAState>(
    () => ({
      loading,
      error,
      agents,
      executions,
      policies,
      approvals,
      integrations,
      activity,
      reload: () => {
        setLoading(true);
        setNonce((n) => n + 1);
      },
      refresh,
      refreshApprovals,

      toggleAgentStatus: async (id) => {
        const agent = agents.find((a) => a.id === id);
        if (!agent) return;
        const next = agent.status === "active" ? "paused" : "active";
        const updated = await api.updateAgent(id, {
          status: next,
          currentTask: next === "paused" ? null : agent.currentTask,
        });
        setAgents((prev) => prev.map((a) => (a.id === id ? updated : a)));
        pushActivity({
          actor: agent.name,
          // Derived from the transition actually performed: a first activation
          // out of `draft` is not a resumption, and the feed used to call it one.
          message: agentTransitionMessage(agent.status, next),
          kind: next === "paused" ? "pending" : "success",
        });
      },

      updateAgentMandate: async (id, mandate) => {
        const updated = await api.updateAgent(id, { mandate });
        setAgents((prev) => prev.map((a) => (a.id === id ? updated : a)));
        pushActivity({
          actor: updated.name,
          message: "Agent mandate updated by a person",
          kind: "info",
        });
      },

      updateAgentPermissions: async (id, permissions) => {
        const updated = await api.updateAgent(id, { permissions });
        setAgents((prev) => prev.map((a) => (a.id === id ? updated : a)));
        pushActivity({
          actor: updated.name,
          message: "Agent permissions updated by a person",
          kind: "info",
        });
      },

      addAgent: async (agent) => {
        const created = await api.createAgent(agent);
        setAgents((prev) => [created, ...prev]);
        pushActivity({ actor: "System", message: `${created.name} registered`, kind: "info" });
      },

      addPolicy: async (policy) => {
        const created = await api.createPolicy(policy);
        setPolicies((prev) => [created, ...prev]);
        pushActivity({ actor: "System", message: `Policy "${created.name}" created`, kind: "info" });
      },

      togglePolicy: async (id) => {
        const policy = policies.find((p) => p.id === id);
        if (!policy) return;
        const updated = await api.updatePolicy(id, {
          status: policy.status === "enabled" ? "disabled" : "enabled",
        });
        setPolicies((prev) => prev.map((p) => (p.id === id ? updated : p)));
      },

      resolveApproval: async (id, status) => {
        const resolution = await api.resolveApproval(id, status);
        const { approval, execution } = resolution;
        setApprovals((prev) => prev.map((a) => (a.id === id ? approval : a)));
        if (execution) {
          setExecutions((prev) => prev.map((e) => (e.id === execution.id ? execution : e)));
        }
        // The approver's name comes from the authenticated identity the server
        // stamped on the audit entry — never from a hardcoded string.
        const approver = resolution.approval.resolvedBy ?? identity?.name ?? "the operator";
        pushActivity({
          actor: approval.agentName,
          message:
            status === "approved"
              ? `${approval.title} approved by ${approver}`
              : `${approval.title} rejected by ${approver}`,
          kind: status === "approved" ? "success" : "blocked",
        });
        return resolution;
      },

      execute: async (request) => {
        const response = await api.execute(request);
        if (response.execution) {
          const created = response.execution;
          setExecutions((prev) => [created, ...prev.filter((e) => e.id !== created.id)]);
        }
        if (response.approvalId) {
          // The approval was created server-side; refetch the list so /approvals
          // stays authoritative rather than mirroring a guess.
          void api.listApprovals().then(setApprovals);
        }
        if (response.policyId) {
          setPolicies((prev) =>
            prev.map((p) =>
              p.id === response.policyId ? { ...p, triggeredCount: p.triggeredCount + 1 } : p,
            ),
          );
        }
        const agentName = agents.find((a) => a.id === request.agentId)?.name ?? "Agent";
        /*
         * `decision` is the policy verdict, NOT the tool's runtime outcome: an
         * ALLOWed action can still fail when the tool actually runs. And
         * `executed` means *attempted* — it is true for a tool that ran and threw
         * — so rendering it as success would show a failed payment as a green
         * tick. The server now says both things explicitly: `attempted` for "a
         * tool was invoked", `succeeded` for "and it worked". This reads those
         * rather than re-deriving them, so the console cannot disagree with the
         * backend.
         */
        const attempted = response.attempted;
        const toolFailed = attempted && !response.succeeded;
        pushActivity({
          actor: agentName,
          message: attempted
            ? toolFailed
              ? `${request.action} attempted via ${response.toolId} — the tool failed`
              : `${request.action} executed via ${response.toolId}`
            : `${request.action} : ${decisionLabel(response.decision.toLowerCase()).toLowerCase()}`,
          kind: toolFailed
            ? "blocked"
            : response.decision === "ALLOW"
              ? "success"
              : response.decision === "BLOCK"
                ? "blocked"
                : "pending",
        });
        return response;
      },

      toggleIntegration: async (id) => {
        const updated = await api.toggleIntegration(id);
        setIntegrations((prev) => prev.map((i) => (i.id === id ? updated : i)));
      },

      dryRun: async (request) => api.evaluate({ ...request, persist: false }),

      retryExecution: async (id, confirmNotApplied = false) => {
        const response = await api.retryExecution(id, confirmNotApplied);
        const updated = response.execution;
        setExecutions((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
        // `executed: true` only means the tool was genuinely invoked again — it
        // says nothing about the outcome, and a retry that fails still sets it.
        // Reading it as success would show a failed retry as a green "success"
        // entry. `succeeded` is the field that answers the question.
        const succeeded = response.succeeded;
        pushActivity({
          actor: updated.agentName,
          message: succeeded
            ? `${updated.action} retried — ${response.toolId} completed`
            : `${updated.action} retried — the tool failed again`,
          kind: succeeded ? "success" : "blocked",
        });
      },

      evaluate: async (request) => {
        const response = await api.evaluateDecision(request);
        if (response.execution) {
          const created = response.execution;
          setExecutions((prev) => [created, ...prev]);
        }
        if (response.approval) {
          const created = response.approval;
          setApprovals((prev) => [created, ...prev]);
        }
        if (response.policyId) {
          setPolicies((prev) =>
            prev.map((p) =>
              p.id === response.policyId ? { ...p, triggeredCount: p.triggeredCount + 1 } : p,
            ),
          );
        }
        const agentName = agents.find((a) => a.id === request.agentId)?.name ?? "Agent";
        pushActivity({
          actor: agentName,
          message:
            response.decision === "ALLOW"
              ? `${request.action} on ${request.target} allowed`
              : response.decision === "BLOCK"
                ? `${request.action} on ${request.target} blocked by policy`
                : `${request.action} on ${request.target} held for approval`,
          kind:
            response.decision === "ALLOW"
              ? "success"
              : response.decision === "BLOCK"
                ? "blocked"
                : "pending",
        });
        return response;
      },
    }),
    [loading, error, agents, executions, policies, approvals, integrations, activity, identity, pushActivity, refresh, refreshApprovals],
  );

  return <ARIAContext.Provider value={value}>{children}</ARIAContext.Provider>;
}

export function useARIA(): ARIAState {
  const ctx = useContext(ARIAContext);
  if (!ctx) throw new Error("useARIA must be used within <ARIAProvider>");
  return ctx;
}

/**
 * Une page de liste relit l'instantané quand on l'ouvre.
 *
 * L'instantané (agents, exécutions, règles, approbations) est chargé à la connexion. Le
 * démarrage guidé, lui, écrit par d'autres chemins — choisir un dépôt crée deux règles,
 * le scénario crée des exécutions — et un agent branché par MCP agit pendant que la
 * console est ouverte. Relevé en répétant la recette à blanc (STRESS-TEST-LOG §5.15) :
 * l'écran Politiques disait « No policies match » juste après l'enregistrement de deux
 * règles, et Exécutions affichait 0 après le scénario. Recharger la page n'était pas une
 * issue : la session n'est gardée que dans l'onglet, recharger déconnecte.
 */
export function useFreshSnapshot(): void {
  const { refresh } = useARIA();
  useEffect(() => {
    refresh();
  }, [refresh]);
}

/** Toutes les combien une page ouverte relit les approbations. */
export const APPROVALS_REFRESH_MS = 3_000;

/**
 * Les approbations, à jour tant que la page est ouverte : une demande qui arrive apparaît
 * sans recharger la page (`client/src/lib/poll.ts` dit pourquoi).
 */
export function useLiveApprovals(everyMs = APPROVALS_REFRESH_MS): void {
  const { refreshApprovals } = useARIA();
  useEffect(() => pollWhileVisible(refreshApprovals, everyMs), [refreshApprovals, everyMs]);
}
