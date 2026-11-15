/**
 * The agent's permission scopes — what tool-level actions the control plane
 * will honour for this agent, independent of the mandate (which limits
 * spending, categories and domains, not which scopes exist at all).
 *
 * This card is a thin view over `agent.permissions`. Editing writes through
 * the API to SQLite; the decision engine reads
 * `agent.permissions.filter(p => p.granted).map(p => p.scope)` on the next
 * evaluation, so a change here immediately changes what the agent is allowed
 * to do. No authorization logic lives in this component — the server
 * re-validates every scope against `permissionSchema` regardless of what the
 * client sends.
 */

import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { SectionCard } from "@/components/common/primitives";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RiskBadge } from "@/components/common/badges";
import { useToast } from "@/hooks/use-toast";
import { useARIA } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { PERMISSION_CATALOG } from "@/data/agents";
import { permissionText } from "@/lib/permission-labels";
import type { Agent, Permission } from "@/types";

/** Merge the agent's saved grants onto the full catalog, so every known scope
 * always renders — including ones the agent has never been granted. */
function withCatalog(permissions: Permission[]): Permission[] {
  const byScope = new Map(permissions.map((p) => [p.scope, p]));
  return PERMISSION_CATALOG.map((catalogEntry) => byScope.get(catalogEntry.scope) ?? catalogEntry);
}

export function PermissionsCard({ agent }: { agent: Agent }) {
  const { updateAgentPermissions } = useARIA();
  const { can } = useAuth();
  const { toast } = useToast();
  const canManage = can("manage");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Permission[]>(() => withCatalog(agent.permissions));

  const granted = agent.permissions.filter((p) => p.granted);

  function open() {
    if (!canManage) return;
    setDraft(withCatalog(agent.permissions));
    setEditing(true);
  }

  function toggle(scope: Permission["scope"]) {
    setDraft((prev) => prev.map((p) => (p.scope === scope ? { ...p, granted: !p.granted } : p)));
  }

  async function save() {
    if (!canManage) return;
    setSaving(true);
    try {
      // The full catalog (granted and ungranted) is sent as-is — the server
      // validates every entry against permissionSchema regardless, and the
      // decision engine only ever reads the granted ones. Sending the whole
      // list keeps this symmetric with how the mandate editor persists its
      // full draft, and means re-opening the editor later shows exactly what
      // was last saved, not a re-derived guess.
      await updateAgentPermissions(agent.id, draft);
      toast({
        title: "Permissions updated",
        description: `${agent.name} now has ${draft.filter((p) => p.granted).length} scope(s) granted.`,
      });
      setEditing(false);
    } catch (err) {
      toast({
        title: "The permissions could not be updated",
        description: err instanceof Error ? err.message : "Unexpected error",
        variant: "destructive",
      });
      // Keep editing mode open and the draft intact so nothing is lost.
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Permissions"
      description="The scopes Oathrion grants this agent."
      bodyClassName={editing ? undefined : "divide-y divide-card-border"}
      action={
        editing || !canManage ? null : (
          <button
            type="button"
            onClick={open}
            data-testid="button-edit-agent-permissions"
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
          {granted.length === 0 && (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No scope granted: this agent cannot do anything yet.
            </p>
          )}
          {granted.map((p) => (
            <div key={p.scope} className="flex items-start gap-3 px-5 py-3.5" data-testid={`permission-${p.scope}`}>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                <Check className="h-3 w-3" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{permissionText(p).label}</p>
                <p className="text-xs text-muted-foreground">{permissionText(p).description}</p>
              </div>
              <code className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:block">
                {p.scope}
              </code>
              <RiskBadge risk={p.risk} />
            </div>
          ))}
        </>
      )}

      {editing && (
        <div className="space-y-1 px-5 py-5">
          <ul className="divide-y divide-card-border" data-testid="list-permission-editor">
            {draft.map((p) => (
              <li key={p.scope} className="flex items-start gap-3 py-3.5 first:pt-0">
                <Switch
                  checked={p.granted}
                  onCheckedChange={() => toggle(p.scope)}
                  data-testid={`switch-permission-${p.scope}`}
                  aria-label={permissionText(p).label}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{permissionText(p).label}</p>
                  <p className="text-xs text-muted-foreground">{permissionText(p).description}</p>
                </div>
                <code className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:block">
                  {p.scope}
                </code>
                <RiskBadge risk={p.risk} />
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 pt-4">
            <Button size="sm" onClick={save} disabled={saving} data-testid="button-save-permissions">
              <Check className="mr-1.5 h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save permissions"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="button-cancel-permissions"
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
