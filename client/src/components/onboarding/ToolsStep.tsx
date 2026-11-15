import { useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Plug, RefreshCw } from "lucide-react";

import {
  connectConnector,
  startConnectorOAuth,
  testConnector,
  type ConnectorDescription,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { StepShell, TOKEN_STEPS, TOOL_COPY, inputClass, primaryButton, secondaryButton } from "./shared";

/** L'ordre du parcours : le dépôt, la conversation, les tâches, les paiements. */
const ORDER = ["github", "slack", "linear", "stripe"];

export function ToolsStep({
  connectors,
  onChanged,
  onNext,
}: {
  connectors: ConnectorDescription[];
  onChanged: () => void;
  onNext: () => void;
}) {
  const ordered = ORDER.map((id) => connectors.find((c) => c.id === id)).filter((c): c is ConnectorDescription => !!c);
  const connected = ordered.filter((c) => c.status.state === "connected").length;

  return (
    <StepShell
      eyebrow="Step 2 of 5"
      title="Connect the team's tools"
      lead='Each connection is checked with the service before it is saved. "Connected" means the service answered, not that a box was ticked.'
    >
      <ul className="grid gap-4">
        {ordered.map((connector) => (
          <li key={connector.id}>
            <ToolCard connector={connector} onChanged={onChanged} />
          </li>
        ))}
      </ul>
      <div className="mt-10 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onNext} disabled={connected === 0} className={primaryButton}>
          Choose what Oathrion allows
        </button>
        {connected === 0 && <p className="text-xs text-muted-foreground">Connect at least one tool to continue.</p>}
      </div>
    </StepShell>
  );
}

function ToolCard({ connector, onChanged }: { connector: ConnectorDescription; onChanged: () => void }) {
  const [mode, setMode] = useState<"idle" | "token">("idle");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState<"oauth" | "token" | "test" | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [popupBlocked, setPopupBlocked] = useState<string | null>(null);

  const state = connector.status.state;
  const copy = TOOL_COPY[connector.id];
  const oauth = connector.oauth?.available === true;
  const guide = TOKEN_STEPS[connector.id];

  async function connectWithOAuth() {
    setPending("oauth");
    setMessage(null);
    setPopupBlocked(null);
    const started = await startConnectorOAuth(connector.id);
    setPending(null);
    if (!started.ok) {
      setMessage({ tone: "error", text: started.message });
      return;
    }
    /*
     * Une fenêtre à part : la session de cet onglet vit en mémoire, et une navigation la
     * détruirait. Le retour est relayé par `main.tsx`, puis la page actualise l'état.
     */
    const popup = window.open(started.url, "placet-connexion", "popup,width=560,height=760");
    if (!popup) setPopupBlocked(started.url);
  }

  async function connectWithToken(event: React.FormEvent) {
    event.preventDefault();
    const value = secret.trim();
    setSecret("");
    if (value === "") return;
    setPending("token");
    setMessage(null);
    const result = await connectConnector(connector.id, value);
    setPending(null);
    if (result.connected) {
      setMode("idle");
      setMessage({ tone: "ok", text: result.detail });
      onChanged();
    } else {
      setMessage({ tone: "error", text: result.detail });
    }
  }

  async function retest() {
    setPending("test");
    setMessage(null);
    try {
      const result = await testConnector(connector.id);
      setMessage({ tone: result.ok ? "ok" : "error", text: result.detail });
    } catch {
      setMessage({ tone: "error", text: "The test could not start. Try again in a moment." });
    }
    setPending(null);
    onChanged();
  }

  return (
    <article
      className={cn(
        "rounded-2xl border bg-card p-5 transition-colors",
        state === "connected" ? "border-emerald-500/30" : state === "error" ? "border-rose-500/40" : "border-border",
      )}
      aria-labelledby={`tool-${connector.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-[52ch]">
          <h3 id={`tool-${connector.id}`} className="text-base font-semibold tracking-tight">
            {connector.label}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy?.benefit ?? connector.description}</p>
        </div>
        <StateLine state={state} account={connector.status.account} />
      </div>

      {state === "error" && connector.status.detail && (
        <p className="mt-4 flex gap-2 rounded-lg bg-rose-500/5 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {connector.status.detail}
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {state === "connected" || state === "error" ? (
          <button type="button" onClick={() => void retest()} disabled={pending !== null} className={secondaryButton}>
            {pending === "test" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            Check the connection
          </button>
        ) : null}
        {state !== "connected" && oauth && (
          <button type="button" onClick={() => void connectWithOAuth()} disabled={pending !== null} className={primaryButton}>
            {pending === "oauth" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plug className="h-4 w-4" aria-hidden="true" />}
            {state === "error" ? `Reconnect ${connector.label}` : `Connect ${connector.label}`}
          </button>
        )}
        {state !== "connected" && mode === "idle" && (
          <button type="button" onClick={() => setMode("token")} className={oauth ? "text-sm text-muted-foreground underline-offset-2 hover:underline" : primaryButton}>
            {!oauth && <KeyRound className="h-4 w-4" aria-hidden="true" />}
            {oauth ? "Use a token instead" : `Connect ${connector.label} with a token`}
          </button>
        )}
      </div>

      {oauth && state !== "connected" && connector.oauth && connector.oauth.permissions.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">What {connector.label} will ask you to grant</summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {connector.oauth.permissions.map((p) => (
              <li key={p.scope}>
                <span className="font-mono text-xs text-foreground">{p.scope}</span> — {p.why}
              </li>
            ))}
          </ul>
        </details>
      )}

      {popupBlocked && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm" role="alert">
          Your browser blocked the authorisation window. Allow pop-ups for this site and try again, or{" "}
          <a href={popupBlocked} className="font-medium text-primary underline-offset-2 hover:underline">
            continue in this tab
          </a>{" "}
          — you will then have to sign in to Oathrion again on return.
        </div>
      )}

      {mode === "token" && state !== "connected" && guide && (
        <form onSubmit={connectWithToken} className="mt-5 rounded-xl border border-dashed border-border p-4">
          {!oauth && (
            <p className="mb-3 text-xs text-muted-foreground">
              One-click connection is not enabled on this deployment: here you create a token at {connector.label}.
              It takes about two minutes.
            </p>
          )}
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
            {guide.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <label htmlFor={`secret-${connector.id}`} className="sr-only">
              {connector.label} token
            </label>
            <input
              id={`secret-${connector.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={guide.placeholder}
              className={`${inputClass} font-mono`}
            />
            <button type="submit" disabled={pending !== null || secret.trim() === ""} className={primaryButton}>
              {pending === "token" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Check and connect
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Oathrion checks the token with {connector.label}, encrypts it, and will never show it again.
          </p>
        </form>
      )}

      {message && (
        <p
          className={cn(
            "mt-4 rounded-lg px-3 py-2 text-sm",
            message.tone === "ok" ? "bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/5 text-rose-700 dark:text-rose-300",
          )}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.text}
          {message.tone === "error" && " Fix it, then try again."}
        </p>
      )}
    </article>
  );
}

function StateLine({ state, account }: { state: string; account?: string }) {
  if (state === "connected") {
    return (
      <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        Connected{account ? ` · ${account}` : ""}
      </p>
    );
  }
  if (state === "error") return <p className="text-sm font-medium text-rose-700 dark:text-rose-300">Connection error</p>;
  if (state === "revoked") return <p className="text-sm text-muted-foreground">Disconnected</p>;
  return <p className="text-sm text-muted-foreground">Not connected</p>;
}
