import { useState } from "react";
import { Bot, Check, Copy, Loader2 } from "lucide-react";

import { api, createApiKey, type ConnectorDescription } from "@/lib/api";
import { cn } from "@/lib/utils";
import { agentForTools } from "@/lib/agent-template";
import type { Agent } from "@/types";

import { StepShell, inputClass, primaryButton, secondaryButton } from "./shared";

/** L'étiquette qui reconnaît l'agent créé par ce parcours. */
export const ONBOARDING_TAG = "demarrage";

function agentFor(name: string, connected: string[]): Agent {
  return agentForTools(name, connected, {
    description: "Team agent created from the guided start. It acts only through Oathrion.",
    tags: [ONBOARDING_TAG],
  });
}

type Tab = "mcp" | "http";

export function AgentStep({
  connectors,
  agent,
  onCreated,
  onNext,
}: {
  connectors: ConnectorDescription[];
  agent: Agent | null;
  onCreated: () => void;
  onNext: () => void;
}) {
  const connected = connectors.filter((c) => c.status.state === "connected").map((c) => c.id);
  const [name, setName] = useState("Team agent");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("mcp");
  const [copied, setCopied] = useState<string | null>(null);

  async function create() {
    setPending(true);
    setError(null);
    try {
      const created = agent ?? (await api.createAgent(agentFor(name.trim() || "Team agent", connected)));
      const key = await createApiKey({ name: `${created.name} key`, role: "operator", agentId: created.id, expiresInDays: 90 });
      setSecret(key.secret);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Creation failed. Try again.");
    }
    setPending(false);
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  const origin = window.location.origin;
  const key = secret ?? "<your key>";
  const mcpConfig = JSON.stringify(
    { mcpServers: { oathrion: { url: `${origin}/api/mcp`, headers: { Authorization: `Bearer ${key}` } } } },
    null,
    2,
  );
  const curl = [
    `curl -X POST ${origin}/api/execute \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"action":"slack.message.post","target":"slack.com/<CHANNEL_ID>","metadata":{"text":"Hello"}}'`,
  ].join("\n");

  return (
    <StepShell
      eyebrow="Step 4 of 5"
      title="Connect an agent"
      lead="The agent gets a key that can only act in its own name, and only through Oathrion. It holds no GitHub, Slack or Linear token: those stay in Oathrion's vault."
    >
      {!agent && !secret && (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <label htmlFor="agent-name" className="text-xs font-medium text-muted-foreground">
              Agent name
            </label>
            <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </div>
          <button type="button" onClick={() => void create()} disabled={pending || connected.length === 0} className={primaryButton}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Bot className="h-4 w-4" aria-hidden="true" />}
            Create the agent and its key
          </button>
        </div>
      )}

      {agent && !secret && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-sm">
            <span className="font-medium">{agent.name}</span> is ready. Its key can no longer be shown: create a new
            one if you did not copy the previous one.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => void create()} disabled={pending} className={secondaryButton}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Create a new key
            </button>
            <button type="button" onClick={onNext} className={primaryButton}>
              Check on a real action
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {secret && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-sm font-medium">Copy the key now: it will not be shown again.</p>
            <div className="mt-3 flex gap-2">
              <input readOnly value={secret} className={`${inputClass} font-mono text-xs`} aria-label="Agent key" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" onClick={() => void copy("key", secret)} className={secondaryButton}>
                {copied === "key" ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                {copied === "key" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div>
            <div role="tablist" aria-label="How to connect the agent" className="inline-flex rounded-lg border border-border p-1">
              {(
                [
                  ["mcp", "MCP client"],
                  ["http", "HTTP API"],
                ] as [Tab, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="tab"
                  type="button"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={cn("rounded-md px-3 py-1.5 text-sm", tab === value ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "mcp" ? (
              <div className="mt-4 space-y-3 text-sm leading-relaxed">
                <p>
                  Add this server to your agent's MCP configuration. Oathrion shows it the allowed GitHub, Slack and Linear
                  tools, and decides on every call.
                </p>
                <CodeBlock text={mcpConfig} onCopy={() => void copy("mcp", mcpConfig)} copied={copied === "mcp"} />
                <p className="text-xs text-muted-foreground">
                  With Cursor: save this block in <span className="font-mono">.cursor/mcp.json</span> (project) or{" "}
                  <span className="font-mono">~/.cursor/mcp.json</span>, then approve the "oathrion" server. Verified with
                  Cursor (cursor-agent 2026.08.11). Oathrion accepts MCP revisions{" "}
                  <span className="font-mono">2025-06-18</span>, <span className="font-mono">2025-03-26</span> and{" "}
                  <span className="font-mono">2026-07-28</span>. Other clients — including Claude Desktop — have not been
                  verified: if it fails, use the HTTP API.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-3 text-sm leading-relaxed">
                <p>Any agent or script can request an action over HTTP. Oathrion answers with its decision and, if allowed, with the service's result.</p>
                <CodeBlock text={curl} onCopy={() => void copy("http", curl)} copied={copied === "http"} />
              </div>
            )}
          </div>

          <button type="button" onClick={onNext} className={primaryButton}>
            Check on a real action
          </button>
        </div>
      )}
    </StepShell>
  );
}

function CodeBlock({ text, onCopy, copied }: { text: string; onCopy: () => void; copied: boolean }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-4 text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
      <button type="button" onClick={onCopy} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs">
        {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
