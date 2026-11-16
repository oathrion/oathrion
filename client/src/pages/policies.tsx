import { useMemo, useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  Surface,
} from "@/components/common/primitives";
import { Pill, PolicyStatusBadge } from "@/components/common/badges";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useARIA, useFreshSnapshot } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { currency, dayDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import type { Policy, PolicyAction, PolicyCondition, PolicyEffect, PolicyScope, PolicyType, RiskLevel } from "@/types";

/* Les valeurs stockées (API, moteur), dites en clair. Les politiques créées par la console française gardent « tous les agents ». */
const EFFECT_LABEL: Record<string, string> = { block: "blocks", require_approval: "approval required", warn: "warns" };
const TYPE_LABEL: Record<string, string> = {
  MAX_TRANSACTION_AMOUNT: "maximum amount",
  MAX_DAILY_SPEND: "daily spend",
  REQUIRE_HUMAN_APPROVAL: "human approval",
  BLOCK_TOOL: "block",
  ALLOW_TOOL: "allow",
};
const SCOPE_LABEL: Record<string, string> = { organization: "Organisation", agent: "Agent", integration: "Integration" };
const APPLIES_TO_LABEL: Record<string, string> = { "tous les agents": "all agents", "agents choisis": "selected agents" };

function typeRepeatsEffect(policy: Policy): boolean {
  return (
    (policy.type === "REQUIRE_HUMAN_APPROVAL" && policy.effect === "require_approval") ||
    (policy.type === "BLOCK_TOOL" && policy.effect === "block")
  );
}

const EFFECT_TONE: Record<PolicyEffect, "danger" | "warning" | "info"> = {
  block: "danger",
  require_approval: "warning",
  warn: "info",
};

export default function PoliciesPage() {
  const { policies, loading, error, reload, addPolicy, togglePolicy } = useARIA();
  useFreshSnapshot();
  const { can } = useAuth();
  const [query, setQuery] = useState("");
  const canManage = can("manage");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return policies;
    return policies.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [policies, query]);

  const newButton = canManage ? (
    <button
      onClick={() => setOpen(true)}
      data-testid="button-new-policy"
      className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Plus className="h-4 w-4" aria-hidden /> New policy
    </button>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Policies"
        subtitle="The rules evaluated before each action of an agent."
        actions={newButton}
      />

      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Filter policies…"
        className="max-w-sm"
        testId="input-filter-policies"
      />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Surface key={i} className="p-5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-2/3" />
              <Skeleton className="mt-4 h-8 w-full" />
            </Surface>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Surface>
          <EmptyState
            icon={ShieldCheck}
            title="No policy matches"
            description="Create a policy to frame what your agents are allowed to do."
            action={newButton}
          />
        </Surface>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {filtered.map((p) => (
            <PolicyCard key={p.id} policy={p} canManage={canManage} onToggle={() => togglePolicy(p.id)} />
          ))}
        </div>
      )}

      {canManage && <NewPolicyDialog open={open} onOpenChange={setOpen} onCreate={addPolicy} />}
    </div>
  );
}

function PolicyCard({ policy, canManage, onToggle }: { policy: Policy; canManage: boolean; onToggle: () => void }) {
  return (
    <Surface className="flex flex-col p-5" data-testid={`card-policy-${policy.id}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight">{policy.name}</h3>
        <PolicyStatusBadge status={policy.status} />
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{policy.description}</p>

      {/* Les règles écrites par le démarrage guidé n'ont pas d'expression : pas de cadre vide. */}
      {policy.rule.trim() !== "" && (
        <code className="mt-4 block overflow-x-auto rounded-lg border border-card-border bg-muted/60 px-3 py-2 font-mono text-xs text-foreground/80">
          {policy.rule}
        </code>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Pill tone={EFFECT_TONE[policy.effect]}>{EFFECT_LABEL[policy.effect] ?? policy.effect}</Pill>
        {/* Le type n'est montré que s'il dit autre chose que l'effet (« approval required » deux fois, relevé par l'audit). */}
        {!typeRepeatsEffect(policy) && (
          <Pill tone={policy.type ? "info" : "neutral"}>{policy.type ? (TYPE_LABEL[policy.type] ?? policy.type) : "indicative"}</Pill>
        )}
        <span>{SCOPE_LABEL[policy.scope] ?? policy.scope}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>{APPLIES_TO_LABEL[policy.appliesTo.toLowerCase()] ?? policy.appliesTo}</span>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-card-border pt-4">
        <span className="text-xs text-muted-foreground">
          Triggered <span className="tabular font-medium text-foreground">{policy.triggeredCount}×</span> · updated on{" "}
          {dayDate(policy.updatedAt)}
        </span>
        <button
          onClick={() => {
            if (!canManage) return;
            onToggle();
          }}
          disabled={!canManage}
          data-testid={`button-toggle-policy-${policy.id}`}
          className="rounded-lg border border-card-border bg-background px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {policy.status === "enabled" ? "Disable" : "Enable"}
        </button>
      </div>
    </Surface>
  );
}

function NewPolicyDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (p: Policy) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<PolicyType>("MAX_TRANSACTION_AMOUNT");
  const [limit, setLimit] = useState("2000");
  const [targets, setTargets] = useState("");
  const [actions, setActions] = useState("");
  const [scope, setScope] = useState<PolicyScope>("organization");
  const [risk, setRisk] = useState<RiskLevel>("high");
  const [error, setError] = useState<string | null>(null);

  const usesAmount = type === "MAX_TRANSACTION_AMOUNT" || type === "MAX_DAILY_SPEND";

  /** Derives the executable condition, the enforced action and the display rule. */
  const compile = (): { condition: PolicyCondition; action: PolicyAction; rule: string; effect: PolicyEffect } | null => {
    const list = (v: string) =>
      v.split(",").map((t) => t.trim()).filter(Boolean);

    if (usesAmount) {
      const normalized = limit.trim().replace(/[€\s]/g, "").replace(",", ".");
      const max = Number(normalized);
      // An empty field is refused rather than read as zero: `Number("")` is 0, so a
      // blank limit used to compile into a "nothing above €0" policy that held every
      // single purchase for approval, with no error shown to explain why.
      if (normalized === "" || !Number.isFinite(max) || max < 0) return null;
      if (type === "MAX_TRANSACTION_AMOUNT") {
        return {
          condition: { kind: "amountAtMost", field: "amount", max, actions: list(actions) },
          action: "APPROVAL_REQUIRED",
          effect: "require_approval",
          rule: `action.amount > ${currency(max)} → require_approval`,
        };
      }
      return {
        condition: { kind: "dailySpendAtMost", field: "cost", max },
        action: "BLOCK",
        effect: "block",
        rule: `agent.daily_spend + action.cost > ${currency(max)} → block`,
      };
    }

    const t = list(targets);
    if (t.length === 0) return null;
    const condition: PolicyCondition = { kind: "targetMatches", targets: t, actions: list(actions) };
    if (type === "BLOCK_TOOL") {
      return { condition, action: "BLOCK", effect: "block", rule: `target ∈ {${t.join(", ")}} → block` };
    }
    if (type === "ALLOW_TOOL") {
      return { condition, action: "ALLOW", effect: "warn", rule: `target ∈ {${t.join(", ")}} → allow` };
    }
    return {
      condition,
      action: "APPROVAL_REQUIRED",
      effect: "require_approval",
      rule: `target ∈ {${t.join(", ")}} → require_approval`,
    };
  };

  const preview = compile();

  const submit = () => {
    const compiled = compile();
    if (name.trim().length < 3) {
      setError("A policy needs a name of at least 3 characters.");
      return;
    }
    if (!compiled) {
      setError(usesAmount ? "Enter a valid numeric limit." : "Give at least one target.");
      return;
    }
    onCreate({
      id: `pol_${Date.now().toString(36)}`,
      name: name.trim(),
      description: description.trim() || "No description.",
      rule: compiled.rule,
      scope,
      appliesTo: scope === "organization" ? "all agents" : "selected agents",
      effect: compiled.effect,
      status: "enabled",
      triggeredCount: 0,
      updatedAt: new Date().toISOString().slice(0, 10),
      type,
      condition: compiled.condition,
      action: compiled.action,
      appliesToAgentIds: null,
      risk,
      priority: 50,
    });
    toast({ title: "Policy created", description: `${name.trim()} is now enforced by the engine.` });
    setName("");
    setDescription("");
    setTargets("");
    setActions("");
    setError(null);
    onOpenChange(false);
  };

  const inputClass =
    "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New policy</DialogTitle>
          <DialogDescription>
            Policies are evaluated by the control plane before an action reaches your systems.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="policy-name" className="mb-1.5 block text-sm font-medium">Name</label>
            <input
              id="policy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Maximum refund amount"
              data-testid="input-policy-name"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="policy-description" className="mb-1.5 block text-sm font-medium">Description</label>
            <textarea
              id="policy-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Above the threshold, a refund waits for a person."
              data-testid="input-policy-description"
              className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
            />
          </div>
          <div>
            <label htmlFor="policy-type" className="mb-1.5 block text-sm font-medium">Policy type</label>
            <select
              id="policy-type"
              value={type}
              onChange={(e) => setType(e.target.value as PolicyType)}
              data-testid="select-policy-type"
              className={inputClass}
            >
              <option value="MAX_TRANSACTION_AMOUNT">Maximum amount per transaction</option>
              <option value="MAX_DAILY_SPEND">Maximum daily spend</option>
              <option value="REQUIRE_HUMAN_APPROVAL">Human approval required</option>
              <option value="BLOCK_TOOL">Block</option>
              <option value="ALLOW_TOOL">Allow</option>
            </select>
          </div>

          {usesAmount ? (
            <div>
              <label htmlFor="policy-limit" className="mb-1.5 block text-sm font-medium">
                {type === "MAX_DAILY_SPEND" ? "Daily budget (EUR)" : "Limit (EUR)"}
              </label>
              <input
                id="policy-limit"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                inputMode="decimal"
                data-testid="input-policy-limit"
                className={`${inputClass} tabular`}
              />
            </div>
          ) : (
            <div>
              <label htmlFor="policy-targets" className="mb-1.5 block text-sm font-medium">Targets</label>
              <input
                id="policy-targets"
                value={targets}
                onChange={(e) => setTargets(e.target.value)}
                placeholder="production_database, postgres.prod*"
                data-testid="input-policy-targets"
                className={`${inputClass} font-mono text-xs`}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Comma-separated. <code>*</code> matches any suffix.
              </p>
            </div>
          )}

          <div>
            <label htmlFor="policy-actions" className="mb-1.5 block text-sm font-medium">Actions (optional)</label>
            <input
              id="policy-actions"
              value={actions}
              onChange={(e) => setActions(e.target.value)}
              placeholder="purchase, refund"
              data-testid="input-policy-actions"
              className={`${inputClass} font-mono text-xs`}
            />
            <p className="mt-1 text-xs text-muted-foreground">Leave empty to target every action.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="policy-scope" className="mb-1.5 block text-sm font-medium">Scope</label>
              <select
                id="policy-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as PolicyScope)}
                data-testid="select-policy-scope"
                className={inputClass}
              >
                {/* Agent and integration scopes stay unavailable until their target selectors exist. */}
                <option value="organization">Organisation</option>
              </select>
            </div>
            <div>
              <label htmlFor="policy-risk" className="mb-1.5 block text-sm font-medium">Risk</label>
              <select
                id="policy-risk"
                value={risk}
                onChange={(e) => setRisk(e.target.value as RiskLevel)}
                data-testid="select-policy-risk"
                className={inputClass}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <div className="rounded-lg border border-card-border bg-muted/50 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">
              Compiled rule
            </p>
            <code
              className="mt-1 block break-words font-mono text-xs text-foreground/80"
              data-testid="text-policy-preview"
            >
              {preview?.rule ?? "Incomplete definition"}
            </code>
          </div>

          {error && (
            <p className="text-xs text-danger" data-testid="text-policy-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 items-center rounded-lg border border-card-border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            data-testid="button-create-policy"
            className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Create policy
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
