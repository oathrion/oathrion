/**
 * Les « portes » d'un agent : garde-t-il une route qui contourne Oathrion ?
 *
 * L'état est celui que le SERVEUR garde (`GET /api/agents/:id/doors`, migration 25), pas
 * l'état de l'écran : il survit à la navigation, se relit sur la fiche de l'agent, et le
 * verdict est calculé côté serveur par la même fonction que la console
 * (`shared/agent-doors.ts`). Une vérification n'est jamais posée par cette page : elle
 * présente l'ancienne clé, et c'est le serveur qui écrit ce que le service a répondu.
 *
 * Servi à l'étape 4 de « Ajouter un agent existant » et sur la fiche de chaque agent.
 */
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Lock, ShieldAlert, ShieldCheck } from "lucide-react";

import {
  checkOldCredential,
  declareAgentDoor,
  getAgentDoors,
  type AgentDoorsPayload,
  type CredentialCheck,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { REVOKE_PAGE, inputClass, secondaryButton } from "@/components/onboarding/shared";

export const doorsKey = (agentId: string) => ["/api/agents", agentId, "doors"] as const;

const VERDICT_TEXT: Record<AgentDoorsPayload["verdict"], string> = {
  locked: "Oathrion cannot be bypassed on these tools: the agent had no other key, or it was verified dead with the service.",
  declared: "Revocation declared, not verified yet. Check each old key to be sure: a forgotten key is an open door.",
  open: "A door is still open: an old key still works. While it lives, the agent can go around Oathrion.",
  incomplete: "Answer for each tool.",
};

export function DoorsVerdictBadge({ verdict }: { verdict: AgentDoorsPayload["verdict"] }) {
  const label = { locked: "Cannot be bypassed", declared: "Declared, not verified", open: "Door open", incomplete: "Not answered" }[verdict];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        verdict === "locked" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        verdict === "open" && "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        (verdict === "declared" || verdict === "incomplete") && "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
      )}
    >
      {verdict === "locked" ? <Lock className="h-3 w-3" aria-hidden="true" /> : <ShieldAlert className="h-3 w-3" aria-hidden="true" />}
      {label}
    </span>
  );
}

export function DoorsPanel({
  agentId,
  canManage,
  footer,
}: {
  agentId: string;
  canManage: boolean;
  footer?: (payload: AgentDoorsPayload) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const doors = useQuery({ queryKey: doorsKey(agentId), queryFn: () => getAgentDoors(agentId), staleTime: 0 });
  const update = (payload: AgentDoorsPayload) => queryClient.setQueryData(doorsKey(agentId), payload);

  if (doors.isLoading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (!doors.data) {
    return (
      <p className="text-sm text-muted-foreground" role="alert">
        The state of direct access could not be read.
      </p>
    );
  }
  const payload = doors.data;
  if (payload.tools.length === 0) {
    return <p className="text-sm text-muted-foreground">This agent has no permission to act on any connected tool.</p>;
  }

  return (
    <div className="space-y-4">
      {payload.tools.map((tool) => (
        <DoorCard
          key={tool.id}
          agentId={agentId}
          tool={tool}
          record={payload.doors.find((d) => d.connectorId === tool.id) ?? null}
          canManage={canManage}
          onChange={update}
          onChecked={() => void doors.refetch()}
        />
      ))}

      <div
        role="status"
        className={cn(
          "flex items-start gap-3 rounded-2xl border p-4 text-sm",
          payload.verdict === "locked" && "border-emerald-500/30 bg-emerald-500/10",
          payload.verdict === "open" && "border-rose-500/30 bg-rose-500/10",
          (payload.verdict === "declared" || payload.verdict === "incomplete") && "border-amber-500/30 bg-amber-500/10",
        )}
      >
        {payload.verdict === "locked" ? (
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span>{VERDICT_TEXT[payload.verdict]}</span>
      </div>

      {footer?.(payload)}
    </div>
  );
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function DoorCard({
  agentId,
  tool,
  record,
  canManage,
  onChange,
  onChecked,
}: {
  agentId: string;
  tool: { id: string; label: string };
  record: AgentDoorsPayload["doors"][number] | null;
  canManage: boolean;
  onChange: (payload: AgentDoorsPayload) => void;
  onChecked: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* « placet » n'est jamais enregistré par le serveur : on le montre, sans qu'il compte. */
  const [lastOathrion, setLastOathrion] = useState<CredentialCheck | null>(null);
  const revoke = REVOKE_PAGE[tool.id];
  const declared = record?.declared ?? null;

  async function declare(next: "none" | "revoked") {
    setBusy(true);
    setError(null);
    try {
      onChange(await declareAgentDoor(agentId, tool.id, next));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The declaration failed.");
    }
    setBusy(false);
  }

  async function check() {
    setBusy(true);
    const result = await checkOldCredential(tool.id, value, agentId).catch(
      (e: unknown): CredentialCheck => ({ state: "unknown", detail: e instanceof Error ? e.message : "The check could not run." }),
    );
    /* La clé ne reste pas dans l'écran une seconde de plus que nécessaire. */
    setValue("");
    setBusy(false);
    setLastOathrion(result.state === "placet" ? result : null);
    onChecked();
  }

  const shown = lastOathrion ?? (record?.check ? { state: record.check.state, detail: record.check.detail } : null);

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-sm font-medium">Did the agent have its own {tool.label} key?</p>
      {canManage ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={declared === "none"}
            disabled={busy}
            className={cn(secondaryButton, declared === "none" && "border-primary")}
            onClick={() => void declare("none")}
          >
            No, none
          </button>
          <button
            type="button"
            aria-pressed={declared === "revoked"}
            disabled={busy}
            className={cn(secondaryButton, declared === "revoked" && "border-primary")}
            onClick={() => void declare("revoked")}
          >
            Yes — I revoke it
          </button>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {declared === "none" ? "Declared: no key." : declared === "revoked" ? "Declared: revoked." : "Not answered."}
        </p>
      )}
      {record && (
        <p className="mt-2 text-xs text-muted-foreground">
          Declared by {record.declaredBy} on {when(record.declaredAt)}
          {record.check ? ` · checked by ${record.check.checkedBy} on ${when(record.check.checkedAt)}` : ""}.
        </p>
      )}

      {declared === "revoked" && canManage && revoke && (
        <div className="mt-4 space-y-3 text-sm">
          <p>
            Delete {revoke.what}:{" "}
            <a href={revoke.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline">
              {revoke.where} <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </p>
          <div className="space-y-1.5">
            <label htmlFor={`old-${agentId}-${tool.id}`} className="text-xs font-medium text-muted-foreground">
              Then paste the old key here to check with {tool.label} that it no longer works (it is not
              stored)
            </label>
            <div className="flex gap-2">
              <input
                id={`old-${agentId}-${tool.id}`}
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className={inputClass}
              />
              <button type="button" className={secondaryButton} disabled={busy || value.trim() === ""} onClick={() => void check()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                Check
              </button>
            </div>
          </div>
        </div>
      )}

      {shown && declared === "revoked" && (
        <p
          role="status"
          className={cn(
            "mt-3 rounded-lg border px-3 py-2 text-sm",
            shown.state === "dead" && "border-emerald-500/30 bg-emerald-500/10",
            shown.state === "alive" && "border-rose-500/30 bg-rose-500/10",
            (shown.state === "unknown" || shown.state === "placet") && "border-amber-500/30 bg-amber-500/10",
          )}
        >
          {shown.state === "dead" && "Dead — "}
          {shown.state === "alive" && "Still active — "}
          {shown.state === "unknown" && "Cannot conclude — "}
          {shown.detail}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
