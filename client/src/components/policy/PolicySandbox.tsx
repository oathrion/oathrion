/**
 * Test Agent Action — the live demo of the Oathrion Gateway.
 *
 * Purely presentational. It collects an action, posts it to `POST /api/execute`
 * and renders whatever the server returns. No policy logic, no decision logic
 * and no tool logic live here: every field below — decision, reason, executed,
 * toolId, toolResult — is read straight off the response.
 */

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Loader2, Play, ShieldCheck, ShieldX, TimerReset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pill, RiskBadge } from "@/components/common/badges";
import { SectionCard } from "@/components/common/primitives";
import { FilterTabs } from "@/components/common/primitives";
import { useARIA } from "@/lib/store";
import { toolOutcome, toolOutcomeLabel, toolOutcomeSentence } from "@/lib/run-presentation";
import { decisionLabel, reasonLabel } from "@/lib/server-text";
import { useToast } from "@/hooks/use-toast";
import type {
  DecisionResponse,
  EngineDecision,
  EngineRisk,
  EvaluateResponse,
  ExecuteResponse,
} from "@/lib/api";
import { toUiRisk } from "@/lib/api";
import { currency } from "@/lib/format";
import { useAuth } from "@/lib/auth";

/** Dry run evaluates and writes nothing; enforce runs the real Gateway. */
type SandboxMode = "dry" | "enforce";

interface ActionPreset {
  id: string;
  label: string;
  action: string;
  target: string;
  /** Which numeric field the amount input feeds, if any. */
  amountField: "amount" | "cost" | null;
  defaultAmount: number;
  hint: string;
}

const PRESETS: ActionPreset[] = [
  {
    id: "purchase",
    label: "Purchase",
    action: "purchase",
    target: "supplier-x.com",
    amountField: "amount",
    defaultAmount: 850,
    hint: "Judged against the agent's mandate, then the organisation's purchase ceiling.",
  },
  {
    id: "send_email",
    label: "Send an external email",
    action: "send_email",
    target: "external_email",
    amountField: null,
    defaultAmount: 0,
    hint: "A message leaving the organisation.",
  },
  {
    id: "access_prod_db",
    label: "Access the production database",
    action: "access",
    target: "production_database",
    amountField: null,
    defaultAmount: 0,
    hint: "Restricted-access infrastructure.",
  },
  {
    id: "call_api",
    label: "Call a provider's API",
    action: "call_api",
    target: "openai",
    amountField: "cost",
    defaultAmount: 40,
    hint: "Counted in the daily spend budget.",
  },
  {
    id: "query_warehouse",
    label: "Query the analytics warehouse",
    action: "query",
    target: "analytics_warehouse",
    amountField: null,
    defaultAmount: 0,
    hint: "Explicitly allowed read.",
  },
];

/** The canonical control-loop scenarios, one click each. */
const QUICK_RUNS = [
  {
    id: "allow",
    label: `${currency(420, 0)} · within the mandate`,
    testId: "button-run-allow",
    request: {
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      metadata: { amount: 420, category: "Office supplies" },
    },
  },
  {
    id: "approval",
    label: `${currency(850, 0)} · purchase at Supplier X`,
    testId: "button-run-approval",
    request: {
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      metadata: { amount: 850, category: "Office supplies" },
    },
  },
  {
    id: "block-category",
    label: "Cryptocurrency purchase",
    testId: "button-run-block-category",
    request: {
      agentId: "agt_procurement",
      action: "purchase",
      target: "coinbase.com",
      metadata: { amount: 300, category: "Cryptocurrency" },
    },
  },
  {
    id: "block",
    label: "Production database access",
    testId: "button-run-block",
    request: {
      agentId: "agt_data",
      action: "access",
      target: "production_database",
      metadata: {},
    },
  },
] as const;

const DECISION_COPY: Record<
  EngineDecision,
  { label: string; tone: "success" | "warning" | "danger"; icon: typeof ShieldCheck }
> = {
  ALLOW: { label: "Allowed", tone: "success", icon: ShieldCheck },
  APPROVAL_REQUIRED: { label: "Approval required", tone: "warning", icon: TimerReset },
  BLOCK: { label: "Blocked", tone: "danger", icon: ShieldX },
};

export function PolicySandbox() {
  const { agents, execute, dryRun, resolveApproval, loading } = useARIA();
  const { can } = useAuth();
  const { toast } = useToast();
  const canExecute = can("execute");
  const canApprove = can("approve");

  const selectableAgents = useMemo(
    () => agents.filter((a) => a.status !== "draft"),
    [agents],
  );

  const [agentId, setAgentId] = useState("agt_procurement");
  const [presetId, setPresetId] = useState("purchase");
  const [amount, setAmount] = useState("850");
  const [target, setTarget] = useState("supplier-x.com");
  const [running, setRunning] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [context, setContext] = useState("");
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  /**
   * Dry run is the default. In this mode the request goes to `POST /api/evaluate`
   * with `persist: false`: the Policy Engine returns a verdict, and the server
   * writes nothing — no Execution, no Approval, no policy counter, no audit
   * entry, no tool call. Enforce is the real Gateway path.
   */
  const [mode, setMode] = useState<SandboxMode>("dry");
  const [persisted, setPersisted] = useState(false);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const effectiveAgentId =
    selectableAgents.some((a) => a.id === agentId) ? agentId : (selectableAgents[0]?.id ?? agentId);

  function selectPreset(id: string) {
    const next = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
    setPresetId(id);
    setTarget(next.target);
    setAmount(next.amountField ? String(next.defaultAmount) : "");
    setResult(null);
  }

  async function send(request: {
    agentId: string;
    action: string;
    target: string;
    metadata: Record<string, unknown>;
  }) {
    setRunning(true);
    setResult(null);
    try {
      // A short, deliberate beat so the verdict reads as a decision, not a flicker.
      const [response] = await Promise.all([
        mode === "dry" ? dryRun(request).then(asVerdict) : execute(request),
        new Promise((r) => setTimeout(r, 420)),
      ]);
      setResult(response);
      setPersisted(mode === "enforce");
    } catch {
      toast({
        title: "The call to the gateway failed",
        description: "Oathrion returned no decision.",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  }

  function run() {
    if (!canExecute) return;
    const metadata: Record<string, unknown> = {};
    if (preset.amountField) {
      const normalized = amount.trim().replace(/[€\s]/g, "").replace(",", ".");
      const parsed = Number(normalized);
      // Never turn malformed spend into zero: that could bypass an amount policy.
      // The empty string is checked separately because `Number("")` is 0, not NaN —
      // an operator who cleared the field would otherwise submit a zero-euro
      // purchase and be allowed through a spend limit.
      if (normalized === "" || !Number.isFinite(parsed) || parsed < 0) {
        toast({
          title: "Invalid amount",
          description: "Enter a valid amount, in euros, before judging the action.",
          variant: "destructive",
        });
        return;
      }
      metadata[preset.amountField] = parsed;
    }
    if (context.trim()) metadata.context = context.trim();
    void send({ agentId: effectiveAgentId, action: preset.action, target, metadata });
  }

  async function resolve(status: "approved" | "rejected") {
    if (!canApprove || !result?.approvalId) return;
    setResolving(true);
    try {
      // The verdict shown after a resolution comes from the server response —
      // the UI never invents a decision or a tool outcome.
      const resolution = await resolveApproval(result.approvalId, status);
      const execution = resolution.execution;
      setResult((prev) =>
        prev
          ? {
              ...prev,
              decision: execution?.decision === "allow" ? "ALLOW" : "BLOCK",
              reason: execution?.decisionReason ?? prev.reason,
              executed: resolution.executed,
              attempted: resolution.attempted,
              succeeded: resolution.succeeded,
              runState: resolution.runState,
              toolId: resolution.toolId,
              toolResult: resolution.toolResult,
              approvalId: null,
              execution: execution ?? prev.execution,
            }
          : prev,
      );
      toast({
        title: status === "approved" ? "Action approved" : "Action rejected",
        // `attempted` means the tool was reached; `succeeded` says whether it worked.
        // Reporting "Released to X" for an attempt that failed told the approver their
        // approval had gone through when the action had not actually happened.
        description: resolution.attempted
          ? resolution.succeeded
            ? `Passed to ${resolution.toolId}, which completed it.`
            : `Passed to ${resolution.toolId}, which failed. The action did not complete.`
          : "The execution is rejected and recorded. No tool was called.",
      });
    } catch {
      toast({ title: "The approval could not be decided", variant: "destructive" });
    } finally {
      setResolving(false);
    }
  }

  return (
    <SectionCard
      title="Try an agent action"
      description="Send a request through the gateway. The tool is reached only if the policies allow it."
      action={
        <div className="flex items-center gap-2">
          <FilterTabs<SandboxMode>
            value={mode}
            onChange={(next) => {
              setMode(next);
              setResult(null);
            }}
            options={[
              { value: "dry", label: "Dry run" },
              { value: "enforce", label: "For real" },
            ]}
          />
          <Pill tone={mode === "dry" ? "neutral" : "info"}>
            {mode === "dry" ? "Nothing is written" : "Real execution"}
          </Pill>
        </div>
      }
    >
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {/* ---------------------------- Request ---------------------------- */}
        <div className="space-y-4">
          <Field label="Agent" htmlFor="sandbox-agent">
            <Select value={effectiveAgentId} onValueChange={setAgentId} disabled={loading}>
              <SelectTrigger id="sandbox-agent" data-testid="select-sandbox-agent">
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {selectableAgents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Action" htmlFor="sandbox-action" hint={preset.hint}>
            <Select value={presetId} onValueChange={selectPreset}>
              <SelectTrigger id="sandbox-action" data-testid="select-sandbox-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Target" htmlFor="sandbox-target">
            <Input
              id="sandbox-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              data-testid="input-sandbox-target"
            />
          </Field>

          {preset.amountField && (
            <Field
              label={preset.amountField === "amount" ? "Amount (EUR)" : "Call cost (EUR)"}
              htmlFor="sandbox-amount"
            >
              <Input
                id="sandbox-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tabular"
                data-testid="input-sandbox-amount"
              />
            </Field>
          )}

          <Field label="Context" htmlFor="sandbox-context" hint="Optional. Attached to the log.">
            <textarea
              id="sandbox-context"
              rows={2}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Office renewal, quote #4821"
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="input-sandbox-context"
            />
          </Field>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Scenarios
            </p>
            <div className="grid gap-2">
              {QUICK_RUNS.map((scenario) => (
                <Button
                  key={scenario.id}
                  variant="outline"
                  size="sm"
                  className="w-full justify-start"
                  disabled={!canExecute || running || loading}
                  onClick={() => {
                    if (!canExecute) return;
                    void send({ ...scenario.request, metadata: { ...scenario.request.metadata } });
                  }}
                  data-testid={scenario.testId}
                >
                  {scenario.label}
                </Button>
              ))}
            </div>
          </div>

          <Button
            onClick={run}
            disabled={!canExecute || running || loading}
            className="w-full"
            data-testid="button-evaluate-action"
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Judging…
              </>
            ) : (
              <>
                <Play className="h-4 w-4" aria-hidden />
                {mode === "dry" ? "Judge the action (dry run)" : "Judge the action"}
              </>
            )}
          </Button>
        </div>

        {/* ---------------------------- Verdict ---------------------------- */}
        <div className="rounded-xl border border-card-border bg-muted/30 p-5">
          {running ? (
            <PendingState />
          ) : result ? (
            <Verdict
              result={result}
              persisted={persisted}
              resolving={resolving}
              canApprove={canApprove}
              onApprove={() => resolve("approved")}
              onReject={() => resolve("rejected")}
            />
          ) : (
            <IdleState mode={mode} />
          )}
        </div>
      </div>
    </SectionCard>
  );
}

/**
 * Renders an `/api/evaluate` verdict in the shape the Verdict panel expects.
 * A dry run reaches no tool by construction, so nothing was attempted, nothing
 * succeeded, there is no run state and there is no tool to name.
 */
function asVerdict(response: EvaluateResponse): ExecuteResponse {
  return {
    decision: response.decision,
    executed: false,
    attempted: false,
    succeeded: false,
    runState: null,
    reason: response.reason,
    policyId: response.policyId,
    policyName: response.policyName,
    riskLevel: response.risk.toUpperCase() as EngineRisk,
    matched: response.matched,
    executionId: response.executionId,
    approvalId: response.approvalId,
    toolId: null,
    toolResult: null,
    execution: null,
  };
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function IdleState({ mode }: { mode: SandboxMode }) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center text-center">
      <ShieldCheck className="h-6 w-6 text-muted-foreground/60" aria-hidden />
      <p className="mt-3 text-sm font-medium">No decision yet</p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
        {mode === "dry"
          ? "Choose an agent and an action, then judge it. In a dry run, the verdict is real and nothing is written."
          : "Choose an agent and an action, then judge it. Each try is recorded as a real execution."}
      </p>
    </div>
  );
}

function PendingState() {
  return (
    <div
      className="flex h-full min-h-[220px] flex-col items-center justify-center text-center"
      data-testid="state-evaluating"
    >
      <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
      <p className="mt-3 text-sm font-medium">Checking the policies…</p>
      <p className="mt-1 text-xs text-muted-foreground">The request is checked against every active rule.</p>
    </div>
  );
}

function Verdict({
  result,
  persisted,
  resolving,
  canApprove,
  onApprove,
  onReject,
}: {
  result: ExecuteResponse;
  /** True when the run went through the Gateway and left records behind. */
  persisted: boolean;
  resolving: boolean;
  canApprove: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const copy = DECISION_COPY[result.decision];
  const Icon = copy.icon;

  return (
    <div className="animate-in-up space-y-5" data-testid={`verdict-${result.decision}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Icon
            className={
              copy.tone === "success"
                ? "h-5 w-5 text-success"
                : copy.tone === "danger"
                  ? "h-5 w-5 text-danger"
                  : "h-5 w-5 text-warning"
            }
            aria-hidden
          />
          <p className="text-base font-semibold tracking-tight">{copy.label}</p>
        </div>
        <div className="flex items-center gap-2">
          {!persisted && (
            <Pill tone="neutral" data-testid="badge-dry-run">
              Dry run
            </Pill>
          )}
          <RiskBadge risk={toUiRisk(result.riskLevel)} />
        </div>
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground" data-testid="text-verdict-reason">
        {reasonLabel(result.reason)}
      </p>

      <dl className="grid gap-px overflow-hidden rounded-lg border border-card-border bg-card-border sm:grid-cols-2">
        <Cell label="Policy" value={result.policyName ?? "None"} />
        <Cell label="Decision" value={DECISION_COPY[result.decision].label} mono />
        <Cell label="Execution" value={result.executionId ?? "—"} mono />
        <Cell label="Risk" value={result.riskLevel} mono />
        <Cell label="Tool called" value={result.attempted ? "Yes" : "No"} mono />
        <Cell label="Tool outcome" value={toolOutcomeLabel(result)} mono />
        <Cell label="Tool" value={result.toolId ?? "—"} mono />
      </dl>

      {/*
        * §7/§8 — success is read from `succeeded`, not guessed.
        *
        * This block used to infer the outcome from `toolResult.ok !== false`, which
        * is the same ambiguity the gateway contract was fixed to remove, quietly
        * reimplemented in the UI. A tool that threw returns no `toolResult` at all,
        * so `?.ok !== false` was TRUE and the panel went green for a failure. A tool
        * that returned `{ ok: false }` was only caught because it happened to expose
        * that shape — a private convention of the current tools, not a contract.
        *
        * `succeeded` is the server's own answer and cannot be wrong here.
        */}
      <div
        className={`rounded-lg border px-4 py-3 text-xs ${
          {
            succeeded: "border-success/25 bg-success/5 text-success",
            failed: "border-destructive/25 bg-destructive/5 text-destructive",
            unknown: "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-300",
            "not-attempted": "border-card-border bg-card text-muted-foreground",
          }[toolOutcome(result)]
        }`}
        data-testid="text-tool-status"
      >
        {toolOutcomeSentence(result, persisted)}
      </div>

      {result.toolResult && (
        <pre
          className="max-h-40 overflow-auto rounded-lg border border-card-border bg-card p-3 text-xs leading-relaxed"
          data-testid="text-tool-result"
        >
          {JSON.stringify(result.toolResult, null, 2)}
        </pre>
      )}

      {result.matched.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Every policy checked
          </p>
          <ul className="space-y-1">
            {result.matched.map((m: DecisionResponse["matched"][number]) => (
              <li key={m.policyId} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-muted-foreground">{m.policyName}</span>
                <span className="shrink-0 font-medium tabular">{decisionLabel(m.decision)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.approvalId ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-card-border pt-4">
          <Button
            size="sm"
            onClick={onApprove}
            disabled={!canApprove || resolving}
            data-testid="button-sandbox-approve"
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onReject}
            disabled={!canApprove || resolving}
            data-testid="button-sandbox-reject"
          >
            Reject
          </Button>
          <Link
            href="/approvals"
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-70"
            data-testid="link-sandbox-approvals"
          >
            Open approvals <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      ) : (
        result.executionId && (
          <div className="border-t border-card-border pt-4">
            <Link
              href={`/executions/${result.executionId}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-70"
              data-testid="link-sandbox-execution"
            >
              See the execution <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
        )
      )}
    </div>
  );
}

function Cell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm font-medium ${mono ? "tabular" : ""}`}>{value}</dd>
    </div>
  );
}
