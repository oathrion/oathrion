/**
 * Decision service — the only place that wires the Policy Engine to persistence.
 *
 *   API  →  DecisionService  →  evaluateAction()  →  Repositories
 *
 * Responsibilities:
 *  1. load the agent and the applicable policies,
 *  2. compute the agent's rolling daily spend,
 *  3. delegate the verdict to the pure engine,
 *  4. persist the resulting Execution and, when needed, an Approval,
 *  5. propagate an approval resolution back onto its Execution.
 */

import { evaluateAction } from "@shared/policy/engine";
import { resolveUndeclaredActionPosture } from "@shared/policy/posture";
import { toPolicyRules, toDecisionOutcome, toExecutionStatus, toUiRisk } from "@shared/policy/adapters";
import { DEFAULT_CURRENCY, type CurrencyCode } from "@shared/money";
import { formatAmount, readNumber } from "@shared/policy/matchers";
import { grantedScopes } from "@shared/agent-scopes";
import type { Decision, EvaluationResult } from "@shared/policy/types";
import type { Approval, AuditEntry, Execution } from "@shared/types";
import type { Repositories } from "../repositories/types";
import { notifier as defaultNotifier, type Notifier } from "../notifications";
import { timed } from "../observability/timing";

/** Une règle lit-elle la dépense du jour ? Seul un budget journalier le fait (journal §5.76). */
export function readsDailySpend(rules: readonly { condition: { kind: string } }[]): boolean {
  return rules.some((rule) => rule.condition.kind === "dailySpendAtMost");
}

export interface DecisionInput {
  agentId: string;
  action: string;
  target: string;
  metadata?: Record<string, unknown>;
  /** When false the decision is evaluated but nothing is written. Defaults to true. */
  persist?: boolean;
  actor?: string;
}

export interface DecisionOutput {
  decision: Decision;
  reason: string;
  policyId: string | null;
  policyName: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  matched: EvaluationResult["matched"];
  execution: Execution | null;
  approval: Approval | null;
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Unknown agent "${agentId}".`);
    this.name = "AgentNotFoundError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function describeRequest(
  action: string,
  target: string,
  metadata: Record<string, unknown>,
  currency: CurrencyCode,
): string {
  const amount = readNumber(metadata, "amount");
  const label = action.replace(/_/g, " ");
  return amount !== null
    ? `${label} ${formatAmount(amount, currency)} · ${target}`
    : `${label} · ${target}`;
}

export class DecisionService {
  constructor(
    private readonly repos: Repositories,
    private readonly notifier: Notifier = defaultNotifier,
    /**
     * The tenant's unit of account, resolved once per tenant scope in `routes.ts`.
     *
     * Every ceiling this service evaluates and every amount it renders is denominated in
     * it. There is no default-to-EUR left on this path: a franc CFA tenant whose amounts
     * were formatted as euros would be a financial control displaying the wrong unit.
     */
    private readonly currency: CurrencyCode = DEFAULT_CURRENCY,
  ) {}

  /** Evaluate one agent action and, unless `persist: false`, record the outcome. */
  async decide(input: DecisionInput): Promise<DecisionOutput> {
    const startedAt = Date.now();
    /*
     * LES DEUX LECTURES PARTENT ENSEMBLE. Elles sont indépendantes — l'agent ne décide
     * pas quelles politiques lire — et elles étaient séquentielles, donc deux
     * allers-retours de base l'un après l'autre sur le chemin critique. Mesuré : 1,2 ms
     * et 1,0 ms, dont un seul reste visible.
     *
     * L'ordre des refus est préservé : l'agent inconnu lève AVANT que la décision ne
     * regarde quoi que ce soit, comme avant. Seule l'attente est partagée.
     */
    const [agent, policies] = await Promise.all([
      timed("agent", () => this.repos.agents.findById(input.agentId)),
      timed("policies", () => this.repos.policies.list()),
    ]);
    if (!agent) throw new AgentNotFoundError(input.agentId);

    const metadata = input.metadata ?? {};

    const evaluationAgent = {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      // Shared with the MCP gateway's tools/list filter, so a listing can never
      // advertise a scope the engine would refuse. See shared/agent-scopes.ts.
      permissions: grantedScopes(agent),
      policyIds: agent.policyIds,
      mandate: agent.mandate,
    };
    const rules = toPolicyRules(policies);
    /*
     * LA DÉPENSE DU JOUR N'EST LUE QUE SI UNE RÈGLE LA LIT. Seul un budget journalier
     * (`dailySpendAtMost`) s'en sert, et la somme parcourt chaque exécution autorisée de
     * l'agent sur 24 h glissantes : 17 à 28 ms à 100 000 exécutions, mesuré, et le p50 du
     * pivot local passait de 10 à 56 ms sur le banc de 12 h (journal §5.76). Sans budget,
     * `null` : la somme est sautée et la décision voit 0, qu'aucune règle ne lit.
     */
    const since = readsDailySpend(rules) ? new Date(Date.now() - DAY_MS).toISOString() : null;
    /*
     * Read per evaluation rather than cached at module load. The cost is one
     * property read and a lowercase, and the benefit is that the posture cannot
     * be frozen at import time by whichever test file happened to run first —
     * which is precisely the kind of ordering dependency that makes a security
     * default look tested when it is not.
     *
     * A malformed value throws here. That is the intended behaviour: the server
     * also validates it at boot (see `server/config-check.ts`), so reaching this
     * line with a bad value means the variable was changed after start-up, and
     * refusing the request is safer than guessing which posture was meant.
     */
    const undeclaredActionPosture = resolveUndeclaredActionPosture(process.env);
    const evaluate = (dailySpend: number) =>
      evaluateAction({
        agent: evaluationAgent,
        action: input.action,
        target: input.target,
        metadata,
        policies: rules,
        dailySpend,
        undeclaredActionPosture,
        orgCurrency: this.currency,
      });

    if (input.persist === false) {
      // Dry run: nothing is written, so there is nothing for a concurrent
      // caller to race against. A plain, non-atomic read is enough here —
      // the atomic path below exists specifically to protect the write.
      const dailySpend = since === null ? 0 : await this.repos.executions.dailySpend(agent.id, since);
      return { ...this.summary(evaluate(dailySpend)), execution: null, approval: null };
    }

    const actor = input.actor ?? "Policy Engine";
    const now = new Date().toISOString();
    const executionId = newId("exe");

    // Set inside `build`, which runs synchronously to completion before
    // `decideAndPersist` resolves — reading it right after is not itself a
    // race, it is just picking up the value the atomic transaction already
    // computed.
    let result!: EvaluationResult;

    const build = (dailySpend: number) => {
      result = evaluate(dailySpend);
      const approvalId = result.decision === "APPROVAL_REQUIRED" ? newId("apr") : null;

      // Audit vocabulary is fixed: every decision writes "Action requested" then
      // "Policy evaluated", then exactly one outcome event. The Gateway appends
      // the tool events afterwards.
      const audit: AuditEntry[] = [
        {
          at: now,
          actor: agent.name,
          event: "Action requested",
          detail: describeRequest(input.action, input.target, metadata, this.currency),
        },
        {
          at: now,
          actor,
          event: "Policy evaluated",
          detail: result.policyName
            ? `${result.policyName} → ${result.decision}`
            : `No policy matched → ${result.decision}`,
        },
        {
          at: now,
          actor,
          event:
            result.decision === "ALLOW"
              ? "Decision made"
              : result.decision === "BLOCK"
                ? "Action blocked"
                : "Approval requested",
          detail: result.reason,
        },
      ];

      const execution: Execution = {
        id: executionId,
        agentId: agent.id,
        agentName: agent.name,
        action: input.action,
        target: input.target,
        status: toExecutionStatus(result.decision),
        risk: toUiRisk(result.riskLevel),
        durationMs: Math.max(1, Date.now() - startedAt),
        cost: readNumber(metadata, "cost") ?? 0,
        timestamp: now,
        input: Object.fromEntries(
          Object.entries(metadata).map(([k, v]) => [
            k,
            typeof v === "number" || typeof v === "string" ? v : JSON.stringify(v),
          ]),
        ),
        decision: toDecisionOutcome(result.decision),
        decisionReason: result.reason,
        policyEvaluated: result.policyName,
        policyId: result.policyId,
        result:
          result.decision === "ALLOW"
            ? "Action forwarded to the tool."
            : result.decision === "BLOCK"
              ? "Action denied before reaching the tool."
              : "Held for human approval.",
        audit,
        approvalId,
        // A BLOCK can never reach a tool, so its run is terminal from birth.
        // ALLOW and APPROVAL_REQUIRED start `pending`; only the Gateway's claim
        // moves them to `running`.
        runState: result.decision === "BLOCK" ? "skipped" : "pending",
        attempts: 0,
        lastError: result.decision === "BLOCK" ? result.reason : null,
        toolStartedAt: null,
      };

      let approval: Approval | null = null;
      if (approvalId) {
        const amount = readNumber(metadata, "amount");
        approval = {
          id: approvalId,
          executionId,
          agentId: agent.id,
          agentName: agent.name,
          title: describeRequest(input.action, input.target, metadata, this.currency),
          summary: result.reason,
          requestedValue: amount !== null ? formatAmount(amount, this.currency) : input.target,
          policyId: result.policyId ?? "",
          policyName: result.policyName ?? "",
          policyLimit: this.describeLimit(result.policyId, policies),
          risk: toUiRisk(result.riskLevel),
          status: "pending",
          requestedAt: now,
          context: [
            { label: "Action", value: input.action },
            { label: "Target", value: input.target },
            ...approvalContextRows(metadata),
          ],
        };
      }

      return { execution, approval };
    };

    // The daily-spend read, the full policy re-evaluation and the write all
    // happen inside one synchronous SQLite transaction: no concurrent
    // decision for this agent can be interleaved between the read and the
    // write, closing the race a separate read-then-write used to allow.
    // `decideAndPersist` also bumps the matched policy's trigger counter inside
    // the same commit, keyed off the verdict it actually wrote.
    const { execution, approval } = await timed("persist", () =>
      this.repos.decideAndPersist(agent.id, since, build),
    );

    // Notification is emitted only after the approval is durably stored, so a
    // human can never be paged about a request that does not exist. `emit` is
    // non-blocking and cannot throw: a dead webhook must not fail a decision.
    if (approval) {
      this.notifier.emit({
        type: "approval.requested",
        title: `Approval required — ${approval.title}`,
        summary: approval.summary,
        risk: approval.risk,
        agentId: agent.id,
        agentName: agent.name,
        executionId: execution.id,
        approvalId: approval.id,
        policyId: result.policyId,
        policyName: result.policyName,
        data: {
          action: input.action,
          target: input.target,
          /* La commande d'un hook Claude Code : la notification la montre (on ne décide pas sans savoir quoi). */
          ...(typeof metadata.command === "string" ? { command: metadata.command.slice(0, 200) } : {}),
          requestedValue: approval.requestedValue,
          policyLimit: approval.policyLimit,
          requestedAt: approval.requestedAt,
        },
      });
    } else if (result.decision === "BLOCK") {
      this.notifier.emit({
        type: "action.blocked",
        title: `Action blocked — ${describeRequest(input.action, input.target, metadata, this.currency)}`,
        summary: result.reason,
        risk: toUiRisk(result.riskLevel),
        agentId: agent.id,
        agentName: agent.name,
        executionId: execution.id,
        approvalId: null,
        policyId: result.policyId,
        policyName: result.policyName,
        data: { action: input.action, target: input.target },
      });
    }

    return { ...this.summary(result), execution, approval };
  }

  /**
   * Resolve a pending approval and propagate the outcome onto its execution.
   * approve → execution `allowed`; reject → execution `blocked`.
   */
  async resolveApproval(
    id: string,
    status: "approved" | "rejected",
    resolvedBy: string,
  ): Promise<{
    approval: Approval;
    execution: Execution | null;
    changed: boolean;
    /** The window closed before this decision landed; no action was released. */
    expired?: boolean;
  } | null> {
    const before = await this.repos.approvals.findById(id);
    if (!before) return null;

    // Already resolved: return the current state untouched. Re-approving must
    // never append a second "Approval granted" entry to the audit trail.
    if (before.status !== "pending") {
      const current = before.executionId
        ? ((await this.repos.executions.findById(before.executionId)) ?? null)
        : null;
      return {
        approval: before,
        execution: current,
        changed: false,
        expired: before.status === "expired",
      };
    }

    const resolution = await this.repos.approvals.resolve(id, status, resolvedBy);
    if (!resolution) return null;
    const { approval, claimed } = resolution;

    /*
     * Not claimed, and the row is still pending: the only condition in that
     * statement that can refuse a pending row of the right tenant is the
     * deadline. So this call arrived too late.
     *
     * Note what is deliberately *not* done here: re-reading the clock and
     * deciding for ourselves whether it was too late. The database already made
     * that decision atomically; asking again could disagree with it, and the
     * disagreement would be resolved in favour of whichever answer the code
     * happened to trust. The SQL is the verdict, this branch only reports it.
     */
    if (!claimed && approval.status === "pending") {
      return await this.expireApproval(approval, resolvedBy);
    }

    // Lost the race: another approver's conditional UPDATE landed first between
    // the read above and this write. Report the final state without writing a
    // duplicate audit entry, a duplicate notification, or triggering a second
    // dispatch.
    if (!claimed) {
      const current = approval.executionId
        ? ((await this.repos.executions.findById(approval.executionId)) ?? null)
        : null;
      return {
        approval,
        execution: current,
        changed: false,
        expired: approval.status === "expired",
      };
    }

    let execution: Execution | null = null;
    if (approval.executionId) {
      const current = await this.repos.executions.findById(approval.executionId);
      if (current) {
        const at = new Date().toISOString();
        /*
         * Appended atomically, before the scalar patch. This used to be part of the
         * patch below as `audit: [...current.audit, entry]`, which rebuilt the trail
         * from the snapshot read a moment earlier and could overwrite entries the
         * gateway had appended in between — including the two lines that prove a
         * tool ran.
         */
        await this.repos.executions.appendAudit(current.id, [
          {
            at,
            actor: resolvedBy,
            event: status === "approved" ? "Approval granted" : "Approval rejected",
            detail: approval.policyName,
          },
        ]);
        execution =
          (await this.repos.executions.update(current.id, {
            status: status === "approved" ? "allowed" : "blocked",
            decision: status === "approved" ? "allow" : "block",
            decisionReason:
              status === "approved"
                ? `Approved by ${resolvedBy} after policy review.`
                : `Rejected by ${resolvedBy} after policy review.`,
            result:
              status === "approved"
                ? "Action forwarded to the tool after approval."
                : "Action denied by the approver.",
          })) ?? null;

        // A rejected action is terminal: no worker may ever claim it.
        if (status === "rejected") {
          await this.repos.executions.markSkipped(
            current.id,
            `Rejected by ${resolvedBy}; the action never reached a tool.`,
          );
          execution = (await this.repos.executions.findById(current.id)) ?? execution;
        }
      }
    }

    this.notifier.emit({
      type: "approval.resolved",
      title: `Approval ${status} — ${approval.title}`,
      summary: `${resolvedBy} ${status} this request.`,
      risk: approval.risk,
      agentId: approval.agentId,
      agentName: approval.agentName,
      executionId: approval.executionId ?? null,
      approvalId: approval.id,
      policyId: approval.policyId || null,
      policyName: approval.policyName || null,
      data: { status, resolvedBy },
    });

    return { approval, execution, changed: true };
  }

  /**
   * Turn a past-deadline request into the terminal `expired` state.
   *
   * Called both when an approver arrives too late and by the sweep, so the two
   * paths cannot drift into recording expiry differently.
   *
   * The load-bearing part is `markSkipped`. Transitioning the approval alone
   * would leave the execution sitting in a claimable run state, and
   * `claimToolRun` accepts `pending` — so a worker, a retry, or a second
   * dispatch could still pick the action up and send it downstream *after* the
   * authorisation to do so had lapsed. Expiry has to close the execution as
   * firmly as a rejection does, which is why this mirrors the rejection branch
   * above rather than being a lighter version of it.
   */
  private async expireApproval(
    approval: Approval,
    observedBy: string,
  ): Promise<{ approval: Approval; execution: Execution | null; changed: boolean; expired: true }> {
    const outcome = await this.repos.approvals.expire(approval.id);
    const finalApproval = outcome?.approval ?? approval;

    // Only the caller whose conditional UPDATE actually performed the transition
    // writes the trail and emits the notification. A concurrent second observer
    // gets the state and stays silent.
    if (!outcome?.claimed) {
      const current = finalApproval.executionId
        ? ((await this.repos.executions.findById(finalApproval.executionId)) ?? null)
        : null;
      return { approval: finalApproval, execution: current, changed: false, expired: true };
    }

    let execution: Execution | null = null;
    if (finalApproval.executionId) {
      const current = await this.repos.executions.findById(finalApproval.executionId);
      if (current) {
        /*
         * `actor` is the system, not `observedBy`. The person who happened to
         * click the late approve button did not expire this request — the clock
         * did — and naming them here would put a human's name against a decision
         * they did not make. `observedBy` survives in the detail line so the
         * trail still records who ran into the closed window.
         */
        await this.repos.executions.appendAudit(current.id, [
          {
            at: new Date().toISOString(),
            actor: "Oathrion",
            event: "Approval expired",
            detail: `The approval window closed before a decision landed; observed by ${observedBy}.`,
          },
        ]);

        execution =
          (await this.repos.executions.update(current.id, {
            status: "blocked",
            decision: "block",
            decisionReason: "The approval window closed before a human decided.",
            result: "Action never reached a tool: the approval expired.",
          })) ?? null;

        await this.repos.executions.markSkipped(
          current.id,
          "The approval expired; the action never reached a tool.",
        );
        execution = (await this.repos.executions.findById(current.id)) ?? execution;
      }
    }

    this.notifier.emit({
      type: "approval.resolved",
      title: `Approval expired — ${finalApproval.title}`,
      summary: "The approval window closed before a human decided; no action was taken.",
      risk: finalApproval.risk,
      agentId: finalApproval.agentId,
      agentName: finalApproval.agentName,
      executionId: finalApproval.executionId ?? null,
      approvalId: finalApproval.id,
      policyId: finalApproval.policyId || null,
      policyName: finalApproval.policyName || null,
      data: { status: "expired", resolvedBy: "" },
    });

    return { approval: finalApproval, execution, changed: true, expired: true };
  }

  /**
   * Expire every past-deadline pending request of this tenant.
   *
   * Returns the ids transitioned. One implementation shared with the
   * late-approver path, so a swept row and a late-clicked row end up recorded
   * identically.
   */
  async expirePendingApprovals(): Promise<string[]> {
    const due = await this.repos.approvals.expirePending();
    for (const id of due) {
      const approval = await this.repos.approvals.findById(id);
      if (!approval) continue;
      await this.closeExpiredExecution(approval);
    }
    return due;
  }

  /** The execution-closing half of expiry, for rows the sweep has already transitioned. */
  private async closeExpiredExecution(approval: Approval): Promise<void> {
    if (!approval.executionId) return;
    const current = await this.repos.executions.findById(approval.executionId);
    if (!current || current.runState === "skipped") return;

    await this.repos.executions.appendAudit(current.id, [
      {
        at: new Date().toISOString(),
        actor: "Oathrion",
        event: "Approval expired",
        detail: "The approval window closed before a decision landed.",
      },
    ]);
    await this.repos.executions.update(current.id, {
      status: "blocked",
      decision: "block",
      decisionReason: "The approval window closed before a human decided.",
      result: "Action never reached a tool: the approval expired.",
    });
    await this.repos.executions.markSkipped(
      current.id,
      "The approval expired; the action never reached a tool.",
    );

    this.notifier.emit({
      type: "approval.resolved",
      title: `Approval expired — ${approval.title}`,
      summary: "The approval window closed before a human decided; no action was taken.",
      risk: approval.risk,
      agentId: approval.agentId,
      agentName: approval.agentName,
      executionId: approval.executionId,
      approvalId: approval.id,
      policyId: approval.policyId || null,
      policyName: approval.policyName || null,
      data: { status: "expired", resolvedBy: "" },
    });
  }

  private describeLimit(
    policyId: string | null,
    policies: Awaited<ReturnType<Repositories["policies"]["list"]>>,
  ): string {
    const policy = policies.find((p) => p.id === policyId);
    if (!policy?.condition) return policy?.rule ?? "";
    const c = policy.condition;
    if (c.kind === "amountAtMost") return `Limit ${formatAmount(c.max, this.currency)}`;
    if (c.kind === "dailySpendAtMost") return `Daily budget ${formatAmount(c.max, this.currency)}`;
    return c.targets.join(", ");
  }

  private summary(result: EvaluationResult) {
    return {
      decision: result.decision,
      reason: result.reason,
      policyId: result.policyId,
      policyName: result.policyName,
      riskLevel: result.riskLevel,
      matched: result.matched,
    };
  }
}

/*
 * Ce que la personne qui approuve doit pouvoir LIRE. `String(value)` rendait « [object
 * Object] » pour les arguments d'un outil enveloppé (`oathrion wrap`) : l'approbatrice
 * voyait la demande sans voir ce qu'elle contenait — le texte de la note, le titre de
 * l'issue. Trouvé en passant la console en français, le 28 octobre 2026.
 *
 * Un objet est déplié, une ligne par champ (`arguments.text`) ; une valeur imbriquée est
 * écrite en JSON. Bornes : 20 lignes, 2 000 caractères par valeur, dites quand elles coupent.
 */
const CONTEXT_ROWS_MAX = 20;
const CONTEXT_VALUE_MAX = 2_000;

function contextValue(value: unknown): string {
  const text = typeof value === "string" ? value : value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > CONTEXT_VALUE_MAX ? `${text.slice(0, CONTEXT_VALUE_MAX)}… (truncated)` : text;
}

export function approvalContextRows(metadata: Record<string, unknown>): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const [label, raw] of Object.entries(metadata)) {
    let value: unknown = raw;
    if (typeof raw === "string" && raw.startsWith("{")) {
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        value = raw;
      }
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) rows.push({ label, value: "{}" });
      for (const [key, inner] of entries) rows.push({ label: `${label}.${key}`, value: contextValue(inner) });
    } else {
      rows.push({ label, value: contextValue(value) });
    }
  }
  if (rows.length > CONTEXT_ROWS_MAX) {
    const hidden = rows.length - CONTEXT_ROWS_MAX;
    return [...rows.slice(0, CONTEXT_ROWS_MAX), { label: "…", value: `${String(hidden)} more field(s), visible in the execution's detail` }];
  }
  return rows;
}
