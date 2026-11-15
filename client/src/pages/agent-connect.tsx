/**
 * « Ajouter un agent existant » — brancher sur Oathrion un agent qu'une équipe utilise déjà,
 * sans le reconstruire, et le rendre incontournable.
 *
 * Cinq étapes, écrites pour quelqu'un qui n'est pas développeur :
 *
 *   1. où vit l'agent (Cursor, Claude Desktop, autre outil MCP, agent maison) ;
 *   2. ce qu'il fait — les outils déjà connectés à Oathrion, et les règles qui s'y appliquent ;
 *   3. le brancher — une clé liée à cet agent seul, et la configuration à poser ;
 *   4. fermer les autres portes — révoquer la clé qu'il détenait, et VÉRIFIER auprès du
 *      service qu'elle ne fonctionne plus ;
 *   5. vérifier en direct — la première action de l'agent apparaît ici, avec sa décision.
 *
 * Ce que l'écran promet, et pas plus : l'agent n'a pas d'autre chemin vers les outils dont
 * l'ancienne clé est vérifiée morte. Ce qui n'est que déclaré est dit « déclaré ». Un outil
 * non vérifié par Oathrion (Claude Desktop) est dit non vérifié. Voir
 * `docs/FEUILLE-DE-ROUTE-AGENTS.md` §1.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, Download, KeyRound, Loader2, ShieldCheck } from "lucide-react";

import {
  api,
  createApiKey,
  getSelection,
  listConnectors,
  type ConnectorSelection,
} from "@/lib/api";
import { agentForTools } from "@/lib/agent-template";
import { DoorsPanel } from "@/components/agents/DoorsPanel";
import { useARIA } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Agent } from "@/types";
import {
  ACTION_LABEL,
  DecisionBadge,
  StepShell,
  inputClass,
  primaryButton,
  secondaryButton,
  type Decision,
} from "@/components/onboarding/shared";

/** L'étiquette qui reconnaît un agent branché par cet écran. */
export const EXISTING_AGENT_TAG = "existant";

type PlaceId = "cursor" | "claude" | "mcp" | "code";

interface Place {
  id: PlaceId;
  label: string;
  hint: string;
  /** Vérifié de bout en bout par l'équipe Oathrion — sinon l'écran le dit. */
  verified: boolean;
  provider: Agent["provider"];
  /** Le nom proposé, court : « Agent Cursor », pas « Agent Agent développé en interne ». */
  defaultName: string;
  /** Comment faire agir l'agent à l'étape 5, dans les mots de cet outil. */
  liveHint: (agent: string) => string;
}

const PLACES: Place[] = [
  {
    id: "cursor",
    label: "Cursor",
    hint: "The editor with a built-in agent. Verified end to end.",
    verified: true,
    provider: "custom",
    defaultName: "Agent Cursor",
    liveHint: (agent) => `In Cursor, ask ${agent} for an action with the oathrion tool.`,
  },
  {
    id: "claude",
    label: "Claude Desktop",
    hint: "The Claude desktop app. Not verified by Oathrion to date.",
    verified: false,
    provider: "anthropic",
    defaultName: "Agent Claude",
    liveHint: (agent) => `In Claude Desktop, ask ${agent} for an action with the oathrion tool.`,
  },
  {
    id: "mcp",
    label: "Another MCP-compatible tool",
    hint: "Any tool that accepts a remote MCP server.",
    verified: false,
    provider: "custom",
    defaultName: "Agent MCP",
    liveHint: (agent) => `In your tool, ask ${agent} for an action with the oathrion tool.`,
  },
  {
    id: "code",
    label: "In-house agent",
    hint: "Python, TypeScript, n8n, Make, Zapier…: anything that can make an HTTP call.",
    verified: true,
    provider: "custom",
    defaultName: "In-house agent",
    liveHint: (agent) => `Run ${agent} — or the example from step 3 — so that it performs an action.`,
  },
];

const STEPS = ["Where does it live?", "What does it do?", "Connect it", "Close the other doors", "Check"] as const;

const WRITES_LABEL: Record<string, string> = {
  approval: "writes on approval",
  allow: "free writes",
  block: "writes forbidden",
};

const DECISION_OF: Record<string, Decision> = { allow: "ALLOW", block: "BLOCK", require_approval: "APPROVAL_REQUIRED" };

export default function AgentConnectPage() {
  const { refresh: refreshSnapshot } = useARIA();
  const [step, setStep] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);
  const [name, setName] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectors = useQuery({ queryKey: ["/api/connectors"], queryFn: listConnectors });
  const connected = (connectors.data ?? []).filter((c) => c.status.state === "connected");
  const selections = useQuery({
    queryKey: ["/api/connectors", "selections", connected.map((c) => c.id).join(",")],
    queryFn: async () => {
      const entries = await Promise.all(connected.map(async (c) => [c.id, await getSelection(c.id)] as const));
      return Object.fromEntries(entries) as Record<string, ConnectorSelection>;
    },
    enabled: connected.length > 0,
  });

  async function create() {
    if (!place) return;
    setPending(true);
    setError(null);
    try {
      const label = name.trim() || place.defaultName;
      const created = await api.createAgent(
        agentForTools(label, tools, {
          description: `Existing agent (${place.label}) connected to Oathrion: it acts only through Oathrion.`,
          provider: place.provider,
          tags: [EXISTING_AGENT_TAG, place.id],
        }),
      );
      const key = await createApiKey({ name: `${created.name} key`, role: "operator", agentId: created.id, expiresInDays: 90 });
      setAgent(created);
      setSecret(key.secret);
      refreshSnapshot();
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Creation failed. Try again.");
    }
    setPending(false);
  }

  return (
    <div className="space-y-8">
      <div>
        <Link href="/agents" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Agents
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Add an existing agent</h1>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
          Your agent keeps working as before. It simply goes through Oathrion, which applies your rules to each of
          its actions and keeps the proof.
        </p>
      </div>

      <ol className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs",
              index === step ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground",
            )}
          >
            {index < step ? <Check className="mr-1 inline h-3 w-3" aria-hidden="true" /> : `${String(index + 1)}. `}
            {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <StepShell eyebrow="Step 1 of 5" title="Where does your agent live?" lead="Choose the tool your agent works in today.">
          <ul className="grid gap-3 sm:grid-cols-2">
            {PLACES.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPlace(p);
                    setStep(1);
                  }}
                  className="h-full w-full rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{p.label}</span>
                    {!p.verified && (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-300">
                        not verified
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">{p.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </StepShell>
      )}

      {step === 1 && place && (
        <StepShell
          eyebrow="Step 2 of 5"
          title="What does your agent do?"
          lead="Tick the tools it acts on. It will get only those permissions, and only through Oathrion."
        >
          {connectors.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />}
          {!connectors.isLoading && connected.length === 0 && (
            <p className="rounded-2xl border border-border bg-card p-4 text-sm">
              No tool is connected to Oathrion yet.{" "}
              <Link href="/onboarding" className="font-medium text-primary underline-offset-2 hover:underline">
                Connect GitHub, Slack, Linear or Stripe first
              </Link>
              , then come back here.
            </p>
          )}
          {connected.length > 0 && (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <label htmlFor="agent-name" className="text-xs font-medium text-muted-foreground">
                  Agent name
                </label>
                <input
                  id="agent-name"
                  value={name}
                  placeholder={place.defaultName}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                />
              </div>
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-muted-foreground">Tools used</legend>
                {connected.map((c) => {
                  const selection = selections.data?.[c.id];
                  const count = selection?.resources?.length ?? 0;
                  const checked = tools.includes(c.id);
                  return (
                    <label key={c.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-3">
                      <input
                        type="checkbox"
                        aria-label={c.label}
                        checked={checked}
                        onChange={() => setTools((t) => (checked ? t.filter((x) => x !== c.id) : [...t, c.id]))}
                        className="mt-1"
                      />
                      <span className="text-sm">
                        <span className="font-medium">{c.label}</span>
                        <span className="block text-muted-foreground">
                          {count === 0
                            ? "No resource chosen: the agent cannot do anything there until you choose some."
                            : `${String(count)} resource(s) allowed, ${WRITES_LABEL[selection?.writes ?? ""] ?? "write rule to choose"}.`}
                        </span>
                      </span>
                    </label>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  Rules are changed at the "What is allowed" step of{" "}
                  <Link href="/onboarding" className="underline-offset-2 hover:underline">
                    Get started
                  </Link>{" "}
                  and on the Policies screen. They apply to every agent.
                </p>
              </fieldset>
              {error && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondaryButton} onClick={() => setStep(0)}>
                  Back
                </button>
                <button type="button" className={primaryButton} disabled={pending || tools.length === 0} onClick={() => void create()}>
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}
                  Create the agent and its key
                </button>
              </div>
            </div>
          )}
        </StepShell>
      )}

      {step === 2 && place && agent && (
        <InstallStep place={place} agent={agent} secret={secret} tools={tools} selections={selections.data ?? {}} onNext={() => setStep(3)} />
      )}

      {step === 3 && agent && (
        <StepShell
          eyebrow="Step 4 of 5"
          title="Close the other doors"
          lead="If your agent kept its own key to a service, it could still act without going through Oathrion. Revoke it at the provider: that is what makes Oathrion impossible to bypass. What you declare and what the service answers stay on the agent's page."
        >
          <DoorsPanel
            agentId={agent.id}
            canManage
            footer={(payload) => (
              <button type="button" className={primaryButton} disabled={payload.verdict === "incomplete"} onClick={() => setStep(4)}>
                Check live
              </button>
            )}
          />
        </StepShell>
      )}

      {step === 4 && agent && <LiveStep agent={agent} place={place} />}
    </div>
  );
}

/* ------------------------------------------------------------------ étape 3 */

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }
  return { copied, copy };
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Une action d'exemple que l'agent peut tenter tout de suite, sur une ressource choisie. */
function sampleAction(tools: string[], selections: Record<string, ConnectorSelection>) {
  const tool = tools[0] ?? "github";
  const target = selections[tool]?.resources?.[0];
  const verbs: Record<string, string> = {
    github: "github.issue.search",
    slack: "slack.history.read",
    linear: "linear.issue.search",
    stripe: "stripe.balance.read",
  };
  const placeholders: Record<string, string> = {
    github: "github.com/<owner>/<repo>",
    slack: "slack.com/<channel ID>",
    linear: "linear.app/<TEAM>",
    stripe: "stripe.com/<acct_…>",
  };
  return { action: verbs[tool] ?? "github.issue.search", target: target ?? placeholders[tool] ?? "" };
}

function InstallStep({
  place,
  agent,
  secret,
  tools,
  selections,
  onNext,
}: {
  place: Place;
  agent: Agent;
  secret: string | null;
  tools: string[];
  selections: Record<string, ConnectorSelection>;
  onNext: () => void;
}) {
  const { copied, copy } = useCopy();
  const origin = window.location.origin;
  const key = secret ?? "<your key>";
  const sample = sampleAction(tools, selections);

  const cursorConfig = JSON.stringify({ mcpServers: { oathrion: { url: `${origin}/api/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  /*
   * Claude Desktop ne pose pas d'en-tête d'autorisation sur un serveur distant : le pont
   * `mcp-remote` le fait. L'en-tête passe par une variable, parce qu'une espace dans un
   * argument (« Bearer … ») est mal transmise sous Windows — voir la documentation de
   * mcp-remote. NON VÉRIFIÉ par Oathrion : l'écran le dit.
   */
  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        oathrion: {
          command: "npx",
          args: ["-y", "mcp-remote", `${origin}/api/mcp`, "--header", "Authorization:${OATHRION_AUTH}"],
          env: { OATHRION_AUTH: `Bearer ${key}` },
        },
      },
    },
    null,
    2,
  );
  const curl = [
    `curl -X POST ${origin}/api/execute \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify({ action: sample.action, target: sample.target, metadata: {} })}'`,
  ].join("\n");
  const python = [
    "import requests",
    "",
    `OATHRION = "${origin}"`,
    `KEY = "${key}"  # this agent's key, keep it out of the code (environment variable)`,
    "",
    "response = requests.post(",
    '    f"{OATHRION}/api/execute",',
    '    headers={"Authorization": f"Bearer {KEY}"},',
    `    json={"action": "${sample.action}", "target": "${sample.target}", "metadata": {}},`,
    "    timeout=30,",
    ")",
    'print(response.json()["decision"])  # ALLOW, APPROVAL_REQUIRED or BLOCK',
  ].join("\n");

  return (
    <StepShell
      eyebrow="Step 3 of 5"
      title={`Connect ${agent.name} to Oathrion`}
      lead="Your agent gets an Oathrion key that acts only in its name. It no longer needs any GitHub, Slack, Linear or Stripe key: Oathrion's vault holds those."
    >
      <div className="space-y-6">
        {secret && (
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
        )}

        {place.id === "cursor" && (
          <Instructions
            steps={[
              <>Download the configuration file below (it already holds the key).</>,
              <>
                Put it in your project folder, as <code>.cursor/mcp.json</code> — create the <code>.cursor</code> folder{" "}
                if it does not exist. For all your projects: <code>~/.cursor/mcp.json</code>.
              </>,
              <>Restart Cursor, open Settings → MCP, and enable the "oathrion" server.</>,
              <>
                Ask the agent: "With the oathrion tool, {(ACTION_LABEL[sample.action] ?? sample.action).toLowerCase()} on{" "}
                {sample.target}."
              </>,
              <>
                On the first call, Cursor asks you to allow the oathrion tool: accept. Without this permission, Cursor itself
                refuses the call and nothing reaches Oathrion.
              </>,
            ]}
            file={{ name: "mcp.json", text: cursorConfig }}
            copied={copied}
            copy={copy}
          />
        )}

        {place.id === "claude" && (
          <>
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
              Not verified by Oathrion: if Oathrion does not show up in Claude after these steps, choose "In-house agent" or
              "Another MCP-compatible tool". Node.js must be installed on the computer.
            </p>
            <Instructions
              steps={[
                <>In Claude Desktop: Settings → Developer → "Edit Config".</>,
                <>
                  Replace the content of the opened file (<code>claude_desktop_config.json</code>) with the one below — or
                  add the "oathrion" entry if it already holds other servers.
                </>,
                <>Quit Claude Desktop completely, then open it again.</>,
                <>
                  Ask: "With the oathrion tool, {(ACTION_LABEL[sample.action] ?? sample.action).toLowerCase()} on {sample.target}."
                  Accept when Claude asks for permission to use the tool.
                </>,
              ]}
              file={{ name: "claude_desktop_config.json", text: claudeConfig }}
              copied={copied}
              copy={copy}
            />
          </>
        )}

        {place.id === "mcp" && (
          <div className="space-y-3 text-sm">
            <p>In your tool's MCP settings, add a remote server with these two values:</p>
            <CopyLine label="Server address" value={`${origin}/api/mcp`} copied={copied} copy={copy} />
            <CopyLine label="Authorization header" value={`Bearer ${key}`} copied={copied} copy={copy} />
            <p className="text-muted-foreground">
              Verified with Cursor only. If your tool cannot add a header, use "In-house agent".
            </p>
          </div>
        )}

        {place.id === "code" && (
          <div className="space-y-4 text-sm">
            <p>
              Where your agent called the service directly, it calls Oathrion. Oathrion decides, then acts with the key from its
              vault. These examples make a first allowed read.
            </p>
            <Snippet title="Python" text={python} copied={copied} copy={copy} />
            <Snippet title="Command line (curl), n8n, Make or Zapier: HTTP request" text={curl} copied={copied} copy={copy} />
          </div>
        )}

        <button type="button" className={primaryButton} onClick={onNext}>
          Done: close the other doors
        </button>
      </div>
    </StepShell>
  );
}

function Instructions({
  steps,
  file,
  copied,
  copy,
}: {
  steps: ReactNode[];
  file: { name: string; text: string };
  copied: string | null;
  copy: (label: string, text: string) => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} onClick={() => download(file.name, file.text)}>
          <Download className="h-4 w-4" aria-hidden="true" /> Download {file.name}
        </button>
        <button type="button" className={secondaryButton} onClick={() => void copy(file.name, file.text)}>
          {copied === file.name ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copied === file.name ? "Copied" : "Copy the content"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-3 text-xs">{file.text}</pre>
    </div>
  );
}

function Snippet({ title, text, copied, copy }: { title: string; text: string; copied: string | null; copy: (l: string, t: string) => Promise<void> }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => void copy(title, text)}>
          {copied === title ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-3 text-xs">{text}</pre>
    </div>
  );
}

function CopyLine({ label, value, copied, copy }: { label: string; value: string; copied: string | null; copy: (l: string, t: string) => Promise<void> }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        <input readOnly value={value} className={`${inputClass} font-mono text-xs`} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className={secondaryButton} onClick={() => void copy(label, value)}>
          {copied === label ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ étape 4 */

/* ------------------------------------------------------------------ étape 5 */

function LiveStep({ agent, place }: { agent: Agent; place: Place | null }) {
  const { refresh: refreshSnapshot } = useARIA();
  const executions = useQuery({
    queryKey: ["agent-connect-live", agent.id],
    queryFn: api.listExecutions,
    refetchInterval: 4000,
    staleTime: 0,
  });
  const mine = useMemo(
    () =>
      (executions.data ?? [])
        .filter((e) => e.agentId === agent.id)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 8),
    [executions.data, agent.id],
  );

  /*
   * Une nouvelle action de l'agent peut avoir ouvert une demande d'approbation : la
   * pastille « Approvals » de la barre latérale lit l'instantané, qu'on relit alors.
   * Relevé par l'essai avec Cursor (STRESS-TEST-LOG §5.17) : la pastille restait à 0.
   */
  const count = mine.length;
  useEffect(() => {
    if (count > 0) refreshSnapshot();
  }, [count, refreshSnapshot]);

  return (
    <StepShell
      eyebrow="Step 5 of 5"
      title="Check live"
      lead={`${place ? place.liveHint(agent.name) : `Make ${agent.name} act.`} Each action shows up here as soon as it goes through Oathrion, with the decision made.`}
    >
      {mine.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Waiting for {agent.name}'s first action…
        </div>
      ) : (
        <div className="space-y-4">
          <p className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm" role="status">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Oathrion controls {agent.name}: each of its actions goes through your rules and leaves a receipt.
          </p>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
            {mine.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                  <span className="block text-xs text-muted-foreground">{e.target}</span>
                </span>
                <span className="flex items-center gap-3">
                  <DecisionBadge decision={DECISION_OF[e.decision] ?? "BLOCK"} />
                  <Link href={`/executions/${e.id}`} className="text-xs text-primary underline-offset-2 hover:underline">
                    Receipt
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Link href={`/agents/${agent.id}`} className={secondaryButton}>
          See the agent's page
        </Link>
        <Link href="/agents" className={secondaryButton}>
          Back to agents
        </Link>
      </div>
    </StepShell>
  );
}
