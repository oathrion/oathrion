import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { PageHeader, Surface } from "@/components/common/primitives";
import { Pill, RiskBadge } from "@/components/common/badges";
import { useARIA } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { CATEGORY_CATALOG, PERMISSION_CATALOG, PROVIDER_LABEL, PROVIDER_MODELS } from "@/data/agents";
import { permissionText } from "@/lib/permission-labels";
import { DEFAULT_CURRENCY } from "@shared/money";
import { cn } from "@/lib/utils";
import type { Agent, PermissionScope, ProviderId } from "@/types";

const STEPS = ["The agent", "Provider", "Permissions", "Policies", "Review"] as const;

interface Draft {
  name: string;
  description: string;
  provider: ProviderId;
  model: string;
  scopes: PermissionScope[];
  policyIds: string[];
  /** Autonomous spending ceiling, as typed. Empty = no ceiling of its own. */
  maxTransactionAmount: string;
  blockedCategories: string[];
}

export default function AgentNewPage() {
  const [, navigate] = useLocation();
  const { policies, addAgent } = useARIA();
  const { can, identity } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const canManage = can("manage");
  const [draft, setDraft] = useState<Draft>({
    name: "",
    description: "",
    provider: "openai",
    model: PROVIDER_MODELS.openai[0],
    scopes: [],
    policyIds: ["pol_purchase_limit"],
    maxTransactionAmount: "500",
    blockedCategories: ["Cryptocurrency"],
  });

  const nameError = draft.name.trim().length < 3 ? "Give the agent a name of at least 3 characters." : null;
  const normalizedLimit = draft.maxTransactionAmount.trim().replace(/[€\s]/g, "").replace(",", ".");
  const maxTransactionAmount = normalizedLimit === "" ? null : Number(normalizedLimit);
  const limitError =
    maxTransactionAmount !== null && (!Number.isFinite(maxTransactionAmount) || maxTransactionAmount < 0)
      ? "Enter a valid limit, in euros."
      : null;
  const canContinue = step === 0 ? !nameError : step === 2 ? !limitError : true;

  const next = () => {
    if (step === 0 || step === 2) {
      setTouched(true);
      if (step === 0 ? nameError : limitError) return;
    }
    if (step < STEPS.length - 1) setStep((s) => s + 1);
  };

  const submit = async () => {
    if (!canManage || submitting) return;
    if (limitError) {
      setStep(2);
      setTouched(true);
      return;
    }
    const permissions = PERMISSION_CATALOG.filter((p) => draft.scopes.includes(p.scope)).map((p) => ({
      ...p,
      granted: true,
    }));
    const highest = permissions.reduce<Agent["riskLevel"]>((acc, p) => {
      const order = { low: 0, medium: 1, high: 2, critical: 3 } as const;
      return order[p.risk] > order[acc] ? p.risk : acc;
    }, "low");

    const agent: Agent = {
      id: `agt_${Date.now().toString(36)}`,
      name: draft.name.trim(),
      description: draft.description.trim() || "No description.",
      provider: draft.provider,
      model: draft.model,
      status: "draft",
      currentTask: null,
      /* La personne qui crée l’agent. C’était un nom inventé, « Alex Moreau », écrit en base pour chaque agent. */
      owner: identity?.name ?? "—",
      createdAt: new Date().toISOString().slice(0, 10),
      executions24h: 0,
      successRate: 0,
      cost24h: 0,
      costMonth: 0,
      riskLevel: highest,
      permissions,
      mandate: {
        maxTransactionAmount,
        currency: DEFAULT_CURRENCY,
        allowedCategories: [],
        blockedCategories: draft.blockedCategories,
        allowedDomains: [],
      },
      policyIds: draft.policyIds,
      tags: [],
    };
    // Lock the final action while the request is in flight to avoid duplicate agents.
    setSubmitting(true);
    try {
      await addAgent(agent);
      toast({ title: "Agent created", description: `${agent.name} is registered as a draft.` });
      navigate(`/agents/${agent.id}`);
    } catch {
      toast({
        title: "The agent could not be registered",
        description: "Oathrion refused the request.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        data-testid="link-back-agents"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Agents
      </Link>

      <PageHeader title="New agent" subtitle="Register an agent and say how Oathrion should govern it." />

      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <button
              onClick={() => i <= step && setStep(i)}
              disabled={i > step}
              data-testid={`button-step-${i}`}
              className={cn(
                "flex items-center gap-2 rounded-full px-2.5 py-1 font-medium transition-colors",
                i === step
                  ? "bg-primary text-primary-foreground"
                  : i < step
                    ? "bg-success-soft text-success"
                    : "text-muted-foreground",
              )}
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px]">
                {i < step ? <Check className="h-2.5 w-2.5" /> : i + 1}
              </span>
              {label}
            </button>
            {i < STEPS.length - 1 && <span className="text-muted-foreground/40">›</span>}
          </li>
        ))}
      </ol>

      <Surface className="p-6">
        {step === 0 && (
          <div className="space-y-5">
            <Field label="Agent name" htmlFor="agent-name" hint="Shown everywhere in the console.">
              <input
                id="agent-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Purchasing agent"
                data-testid="input-agent-name"
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
              />
              {touched && nameError && (
                <p className="mt-1.5 text-xs text-danger" data-testid="text-name-error">
                  {nameError}
                </p>
              )}
            </Field>
            <Field label="Description" htmlFor="agent-description" hint="What is this agent in charge of?">
              <textarea
                id="agent-description"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                rows={3}
                placeholder="Compares supplier quotes and prepares purchase requests."
                data-testid="input-agent-description"
                className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
              />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <Field label="Provider" hint="Oathrion never replaces the model: it governs it.">
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setDraft({ ...draft, provider: p, model: PROVIDER_MODELS[p][0] })}
                    data-testid={`button-provider-${p}`}
                    className={cn(
                      "rounded-lg border px-4 py-3 text-left text-sm transition-colors",
                      draft.provider === p
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-card-border hover:bg-muted",
                    )}
                  >
                    <span className="font-medium">{PROVIDER_LABEL[p]}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {PROVIDER_MODELS[p].length} models available
                    </span>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Model" htmlFor="agent-model">
              <select
                id="agent-model"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                data-testid="select-model"
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
              >
                {PROVIDER_MODELS[draft.provider].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">
              Every scope you grant becomes enforceable at runtime. Nothing else will be permitted.
            </p>

            <div className="space-y-3 rounded-lg border border-card-border p-4">
              <div>
                <p className="text-sm font-medium">Autonomous spending limit</p>
                <p className="text-xs text-muted-foreground">
                  Above this amount, a purchase will ask for a person's approval.
                </p>
              </div>
              <label htmlFor="agent-limit" className="sr-only">Autonomous spending limit (EUR)</label>
              <Input
                id="agent-limit"
                inputMode="decimal"
                value={draft.maxTransactionAmount}
                placeholder="No limit"
                onChange={(e) => setDraft({ ...draft, maxTransactionAmount: e.target.value })}
                className="tabular"
                data-testid="input-agent-limit"
              />
              {touched && limitError && <p className="text-xs text-danger">{limitError}</p>}
              <div>
                <p className="text-sm font-medium">Blocked categories</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {CATEGORY_CATALOG.map((category) => {
                    const on = draft.blockedCategories.includes(category);
                    return (
                      <button
                        key={category}
                        type="button"
                        data-testid={`chip-blocked-${category.toLowerCase().replace(/\s+/g, "-")}`}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            blockedCategories: on
                              ? draft.blockedCategories.filter((c) => c !== category)
                              : [...draft.blockedCategories, category],
                          })
                        }
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          on
                            ? "border-danger/30 bg-danger/10 text-danger"
                            : "border-card-border text-muted-foreground hover:bg-muted/50"
                        }`}
                      >
                        {category}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="divide-y divide-card-border rounded-lg border border-card-border">
              {PERMISSION_CATALOG.map((p) => {
                const checked = draft.scopes.includes(p.scope);
                return (
                  <label
                    key={p.scope}
                    className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      data-testid={`checkbox-scope-${p.scope}`}
                      onChange={() =>
                        setDraft({
                          ...draft,
                          scopes: checked
                            ? draft.scopes.filter((s) => s !== p.scope)
                            : [...draft.scopes, p.scope],
                        })
                      }
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{permissionText(p).label}</span>
                      <span className="block text-xs text-muted-foreground">{permissionText(p).description}</span>
                    </span>
                    <RiskBadge risk={p.risk} />
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Attach rules. The organisation's policies always apply on top.
            </p>
            <div className="divide-y divide-card-border rounded-lg border border-card-border">
              {policies.map((p) => {
                const checked = draft.policyIds.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      data-testid={`checkbox-policy-${p.id}`}
                      onChange={() =>
                        setDraft({
                          ...draft,
                          policyIds: checked
                            ? draft.policyIds.filter((id) => id !== p.id)
                            : [...draft.policyIds, p.id],
                        })
                      }
                      className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{p.name}</span>
                      <code className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{p.rule}</code>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {step === 4 && (
          <dl className="grid gap-x-8 sm:grid-cols-2">
            <ReviewRow label="Name">{draft.name || "—"}</ReviewRow>
            <ReviewRow label="Provider">{PROVIDER_LABEL[draft.provider]}</ReviewRow>
            <ReviewRow label="Model">{draft.model}</ReviewRow>
            <ReviewRow label="Status on creation">
              <Pill tone="info">Draft</Pill>
            </ReviewRow>
            <ReviewRow label="Description" full>
              {draft.description || "No description."}
            </ReviewRow>
            <ReviewRow label="Permissions" full>
              {draft.scopes.length === 0 ? (
                <span className="text-muted-foreground">No scope granted: the agent cannot do anything yet.</span>
              ) : (
                <span className="flex flex-wrap gap-1.5">
                  {draft.scopes.map((s) => (
                    <Pill key={s} tone="neutral">
                      {s}
                    </Pill>
                  ))}
                </span>
              )}
            </ReviewRow>
            <ReviewRow label="Policies" full>
              <span className="flex flex-wrap gap-1.5">
                {draft.policyIds.map((id) => (
                  <Pill key={id} tone="info">
                    {policies.find((p) => p.id === id)?.name ?? id}
                  </Pill>
                ))}
              </span>
            </ReviewRow>
          </dl>
        )}

        <div className="mt-8 flex items-center justify-between border-t border-card-border pt-5">
          <button
            onClick={() => (step === 0 ? navigate("/agents") : setStep((s) => s - 1))}
            data-testid="button-back"
            className="inline-flex h-9 items-center rounded-lg border border-card-border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {step === 0 ? "Cancel" : "Back"}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={next}
              disabled={!canContinue && touched}
              data-testid="button-next"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Continue <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
          ) : canManage ? (
              <button
                onClick={submit}
                disabled={submitting}
                data-testid="button-create-agent"
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Check className="h-4 w-4" aria-hidden /> {submitting ? "Creating…" : "Create agent"}
              </button>
          ) : null}
        </div>
      </Surface>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {htmlFor ? <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label> : <p className="block text-sm font-medium">{label}</p>}
      {hint && <p className="mb-2 mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className={hint ? "" : "mt-2"}>{children}</div>
    </div>
  );
}

function ReviewRow({
  label,
  children,
  full = false,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={cn("border-b border-card-border py-3 last:border-0", full && "sm:col-span-2")}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}
