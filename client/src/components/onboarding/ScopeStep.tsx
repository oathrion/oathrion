import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";

import {
  connectorResources,
  getSelection,
  saveSelection,
  type ConnectorDescription,
  type WriteMode,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { StepShell, TOOL_COPY, primaryButton, secondaryButton } from "./shared";

const WRITE_MODES: { value: WriteMode; label: string; hint: string }[] = [
  { value: "approval", label: "On approval", hint: "Recommended. Nothing is written before a person approves in Oathrion." },
  { value: "allow", label: "Free", hint: "Writes to the chosen resources go through without approval." },
  { value: "block", label: "Forbidden", hint: "The agent can only read." },
];

export function ScopeStep({
  connectors,
  onSaved,
  onNext,
}: {
  connectors: ConnectorDescription[];
  onSaved: () => void;
  onNext: () => void;
}) {
  const connected = connectors.filter((c) => c.status.state === "connected" && TOOL_COPY[c.id]);
  return (
    <StepShell
      eyebrow="Step 3 of 5"
      title="Choose what Oathrion allows"
      lead="For each tool, the resources your agents can act on. Everything else is blocked before it reaches the service. Your choice becomes rules visible on the Policies screen."
    >
      <div className="grid gap-5">
        {connected.map((connector) => (
          <ScopePanel key={connector.id} connector={connector} onSaved={onSaved} />
        ))}
      </div>
      <div className="mt-10">
        <button type="button" onClick={onNext} className={primaryButton}>
          Connect an agent
        </button>
      </div>
    </StepShell>
  );
}

function useResources(id: string) {
  return useQuery({
    queryKey: ["/api/connectors", id, "resources"],
    queryFn: () => connectorResources(id),
  });
}

function ScopePanel({ connector, onSaved }: { connector: ConnectorDescription; onSaved: () => void }) {
  const resources = useResources(connector.id);
  const selection = useQuery({
    queryKey: ["/api/connectors", connector.id, "selection"],
    queryFn: () => getSelection(connector.id),
  });

  if (selection.isLoading) {
    return (
      <article className="rounded-2xl border border-border bg-card p-5">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the rules in place…
        </p>
      </article>
    );
  }
  return (
    <ScopeForm
      connector={connector}
      resources={resources}
      initialResources={selection.data?.resources ?? []}
      initialWrites={selection.data?.writes ?? "approval"}
      saved={selection.data?.resources != null}
      onSaved={() => {
        void selection.refetch();
        onSaved();
      }}
    />
  );
}

function ScopeForm({
  connector,
  resources,
  initialResources,
  initialWrites,
  saved,
  onSaved,
}: {
  connector: ConnectorDescription;
  resources: ReturnType<typeof useResources>;
  initialResources: string[];
  initialWrites: WriteMode;
  saved: boolean;
  onSaved: () => void;
}) {
  const copy = TOOL_COPY[connector.id]!;
  const [chosen, setChosen] = useState<string[]>(initialResources);
  const [writes, setWrites] = useState<WriteMode>(initialWrites);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function save() {
    setPending(true);
    setMessage(null);
    const result = await saveSelection(connector.id, chosen, writes);
    setPending(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.message });
      return;
    }
    setMessage({
      tone: "ok",
      text:
        chosen.length === 0
          ? `Saved. No resource chosen: every ${connector.label} action is blocked.`
          : `Saved. Agents act only on ${chosen.length} ${chosen.length > 1 ? copy.resourcesLower : copy.resource}.`,
    });
    onSaved();
  }

  const listed = resources.data;

  return (
    <article className="rounded-2xl border border-border bg-card p-5" aria-labelledby={`scope-${connector.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={`scope-${connector.id}`} className="text-base font-semibold tracking-tight">
          {connector.label} · {copy.resources}
        </h3>
        {saved && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Rules in place
          </span>
        )}
      </div>

      {resources.isLoading && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {connector.label} is answering…
        </p>
      )}
      {listed && !listed.ok && (
        <div className="mt-4 rounded-lg bg-rose-500/5 px-3 py-2 text-sm text-rose-700 dark:text-rose-300" role="alert">
          {listed.detail}
          <button type="button" onClick={() => void resources.refetch()} className="ml-2 font-medium underline-offset-2 hover:underline">
            Try again
          </button>
        </div>
      )}
      {listed?.ok && (
        <>
          {listed.resources.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {connector.label} shows nothing to this connection yet. {listed.note}
            </p>
          ) : (
            <fieldset className="mt-4">
              <legend className="sr-only">Allowed {copy.resourcesLower}</legend>
              <ul className="grid max-h-72 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
                {listed.resources.map((r) => {
                  const checked = chosen.includes(r.target);
                  return (
                    <li key={r.target}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors",
                          checked ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted/60",
                        )}
                      >
                        <input
                          type="checkbox"
                          aria-label={r.label}
                          checked={checked}
                          onChange={() => setChosen(checked ? chosen.filter((t) => t !== r.target) : [...chosen, r.target])}
                          className="h-4 w-4 accent-[hsl(var(--primary))]"
                        />
                        <span className="min-w-0 truncate font-medium">{r.label}</span>
                        {r.detail && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{r.detail}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          )}
          {listed.note && listed.resources.length > 0 && (
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              {listed.note}
              <button type="button" onClick={() => void resources.refetch()} className="inline-flex items-center gap-1 font-medium text-primary">
                <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh
              </button>
            </p>
          )}

          <fieldset className="mt-6">
            <legend className="text-sm font-medium">Writes to these {copy.resourcesLower}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {WRITE_MODES.map((m) => (
                <label
                  key={m.value}
                  className={cn(
                    "cursor-pointer rounded-xl border p-3 text-sm transition-colors",
                    writes === m.value ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                  )}
                >
                  <input
                    type="radio"
                    name={`writes-${connector.id}`}
                    value={m.value}
                    aria-label={`Writes: ${m.label}`}
                    checked={writes === m.value}
                    onChange={() => setWrites(m.value)}
                    className="sr-only"
                  />
                  <span className="font-medium">{m.label}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{m.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void save()} disabled={pending} className={secondaryButton}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Save for {connector.label}
            </button>
            {message && (
              <p
                className={cn("text-sm", message.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300")}
                role={message.tone === "error" ? "alert" : "status"}
              >
                {message.text}
              </p>
            )}
          </div>
        </>
      )}
    </article>
  );
}
