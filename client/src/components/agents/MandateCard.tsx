/**
 * The agent mandate — what this agent may do on its own authority.
 *
 * This card is a thin view over `agent.mandate`. Editing writes through the
 * API to SQLite; the policy engine reads the same record on the next
 * evaluation, so a change here immediately changes what the agent is allowed
 * to do. No logic lives in this component.
 */

import { useState } from "react";
import { Ban, Check, Globe, Pencil, Wallet, X } from "lucide-react";
import { SectionCard } from "@/components/common/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useARIA } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { CATEGORY_CATALOG } from "@/data/agents";
import { currency } from "@/lib/format";
import type { Agent, AgentMandate } from "@/types";

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Wallet;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-3.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

function Chips({
  values,
  tone,
  empty,
  testId,
}: {
  values: string[];
  tone: "neutral" | "danger";
  empty: string;
  testId: string;
}) {
  if (values.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {values.map((value) => (
        <span
          key={value}
          className={`rounded-full border px-2 py-0.5 text-xs ${
            tone === "danger"
              ? "border-danger/25 bg-danger-soft text-danger"
              : "border-card-border bg-muted/60 text-foreground"
          }`}
        >
          {value}
        </span>
      ))}
    </div>
  );
}

export function MandateCard({ agent }: { agent: Agent }) {
  const { updateAgentMandate } = useARIA();
  const { can } = useAuth();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<AgentMandate>(agent.mandate);
  const [limitInput, setLimitInput] = useState(
    agent.mandate.maxTransactionAmount === null ? "" : String(agent.mandate.maxTransactionAmount),
  );
  const canManage = can("manage");

  const mandate = agent.mandate;

  function open() {
    if (!canManage) return;
    setDraft(agent.mandate);
    setLimitInput(agent.mandate.maxTransactionAmount === null ? "" : String(agent.mandate.maxTransactionAmount));
    setEditing(true);
  }

  function toggle(list: keyof AgentMandate, value: string) {
    const current = draft[list] as string[];
    setDraft({
      ...draft,
      [list]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    });
  }

  async function save() {
    if (!canManage) return;
    const normalized = limitInput.trim().replace(/[€\s]/g, "").replace(",", ".");
    const maxTransactionAmount = normalized === "" ? null : Number(normalized);
    // An invalid draft must not silently become an unlimited mandate.
    if (maxTransactionAmount !== null && (!Number.isFinite(maxTransactionAmount) || maxTransactionAmount < 0)) {
      toast({ title: "Invalid limit", description: "Enter a valid limit, in euros.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await updateAgentMandate(agent.id, { ...draft, maxTransactionAmount });
      toast({ title: "Mandate updated", description: `${agent.name} now follows the new limits.` });
      setEditing(false);
    } catch (err) {
      toast({
        title: "The mandate could not be updated",
        description: err instanceof Error ? err.message : "Unexpected error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Mandate"
      description="What this agent can do on its own authority, before the organisation's policies."
      bodyClassName={editing ? undefined : "divide-y divide-card-border"}
      action={
        editing || !canManage ? null : (
          <button
            type="button"
            onClick={open}
            data-testid="button-edit-permissions"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:opacity-70"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )
      }
    >
      {!editing && (
        <>
          <Row icon={Wallet} label="Maximum transaction">
            <p className="tabular text-sm" data-testid="text-mandate-limit">
              {mandate.maxTransactionAmount === null
                ? "No autonomous limit"
                : `${currency(mandate.maxTransactionAmount)} per transaction`}
            </p>
          </Row>
          <Row icon={Check} label="Allowed categories">
            <Chips
              values={mandate.allowedCategories}
              tone="neutral"
              empty="Any category that is not blocked."
              testId="list-allowed-categories"
            />
          </Row>
          <Row icon={Ban} label="Blocked categories">
            <Chips
              values={mandate.blockedCategories}
              tone="danger"
              empty="None."
              testId="list-blocked-categories"
            />
          </Row>
          <Row icon={Globe} label="Allowed domains">
            <Chips
              values={mandate.allowedDomains}
              tone="neutral"
              empty="All domains."
              testId="list-allowed-domains"
            />
          </Row>
        </>
      )}

      {editing && (
        <div className="space-y-5 px-5 py-5">
          <div className="space-y-1.5">
            <label htmlFor="mandate-limit" className="text-sm font-medium">
              Maximum transaction (EUR)
            </label>
            <Input
              id="mandate-limit"
              inputMode="decimal"
              placeholder="No limit"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              className="tabular"
              data-testid="input-mandate-limit"
            />
            <p className="text-xs text-muted-foreground">
              Above this amount, a purchase will ask for a person's approval.
            </p>
          </div>

          {(
            [
              ["allowedCategories", "Allowed categories"],
              ["blockedCategories", "Blocked categories"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-2">
              <p className="text-sm font-medium">{label}</p>
              <div className="flex flex-wrap gap-2">
                {CATEGORY_CATALOG.map((category) => {
                  const on = (draft[key] as string[]).includes(category);
                  const danger = key === "blockedCategories";
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() => toggle(key, category)}
                      data-testid={`chip-${key}-${category.toLowerCase().replace(/\s+/g, "-")}`}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        on
                          ? danger
                            ? "border-danger/30 bg-danger-soft text-danger"
                            : "border-primary/30 bg-primary/10 text-primary"
                          : "border-card-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {category}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="space-y-1.5">
            <label htmlFor="mandate-domains" className="text-sm font-medium">
              Allowed domains
            </label>
            <Input
              id="mandate-domains"
              placeholder="amazon.com, staples.com"
              value={draft.allowedDomains.join(", ")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  allowedDomains: e.target.value
                    .split(",")
                    .map((d) => d.trim())
                    .filter(Boolean),
                })
              }
              data-testid="input-mandate-domains"
            />
            <p className="text-xs text-muted-foreground">
              Comma separated. Leave empty to allow any domain.
            </p>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={save} disabled={saving} data-testid="button-save-mandate">
              <Check className="mr-1.5 h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save mandate"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="button-cancel-mandate"
            >
              <X className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
