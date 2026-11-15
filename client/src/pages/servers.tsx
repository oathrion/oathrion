/**
 * « Serveurs » — la console locale (`oathrion wrap`) répond à la question de la personne qui
 * vient de brancher Oathrion : est-ce que ça marche ? Pour chaque serveur sous Oathrion : quel
 * client le porte, ce qui passe, ce qui est demandé, ce qui est bloqué, et s'il a déjà servi.
 * Et, lus dans les configurations de Claude Code et de Cursor sur cette machine, les serveurs
 * qui passent À CÔTÉ d'Oathrion, avec la commande qui les protège.
 *
 * Rien n'est modifié d'ici : protéger un serveur change la configuration d'un client, ce que
 * `npx oathrion` fait après avoir montré la liste et demandé.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Server, ShieldAlert } from "lucide-react";

import { EmptyState, ErrorState, PageHeader, Surface, TableSkeleton } from "@/components/common/primitives";
import { getLocalServers, type LocalServer, type UnprotectedServer } from "@/lib/api";
import { relativeTime } from "@/lib/format";

const PROTECT = "npx oathrion";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-xl bg-card p-1.5 pl-3.5 shadow-xs ring-1 ring-card-border">
      <code className="flex-1 overflow-x-auto font-mono text-[13px]">{command}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-3 text-[13px] font-medium transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-testid="button-copy-protect"
      >
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const DECISIONS: Record<string, string> = {
  allow: "allowed",
  require_approval: "asked",
  block: "blocked",
};

function Count({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div>
      <p className={`text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${tone ?? ""}`}>{value}</p>
      <p className="mt-1 text-[12px] text-muted-foreground">{label}</p>
    </div>
  );
}

function ServerCard({ server }: { server: LocalServer }) {
  const { classes } = server;
  const live = server.clients.length > 0;
  return (
    <Surface className="flex flex-col gap-5 p-5" data-testid={`server-${server.name}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden>
          <Server className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold tracking-[-0.015em]">{server.name}</p>
          <p className="truncate text-[13px] text-muted-foreground">
            {server.server.name ? `${server.server.name}${server.server.version ? ` ${server.server.version}` : ""}` : "MCP server"}
          </p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${live ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-success" : "bg-muted-foreground/50"}`} aria-hidden />
          {live ? server.clients.join(", ") : "Idle"}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 rounded-xl bg-muted/60 px-4 py-3.5">
        <Count value={classes.read} label="reads go through" />
        <Count value={classes.write} label="writes ask you" tone="text-primary" />
        <Count value={classes.destructive} label="blocked" tone={classes.destructive > 0 ? "text-danger" : undefined} />
      </div>
      <p className="text-[13px] text-muted-foreground" data-testid={`server-${server.name}-state`}>
        {server.lastAction ? (
          <>
            Last action: <span className="font-medium text-foreground">{server.lastAction.tool}</span>, {DECISIONS[server.lastAction.decision] ?? server.lastAction.decision},{" "}
            {relativeTime(server.lastAction.at)} · {server.actions} in total
          </>
        ) : live ? (
          "Connected. Waiting for your agent's first action."
        ) : (
          "Not used yet."
        )}
      </p>
    </Surface>
  );
}

function Unprotected({ list }: { list: UnprotectedServer[] }) {
  const local = list.filter((s) => s.protectable);
  const remote = list.filter((s) => !s.protectable);
  if (local.length === 0 && remote.length === 0) return null;
  return (
    <Surface className="space-y-4 p-5" data-testid="unprotected">
      {local.length > 0 && (
        <>
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning" aria-hidden>
              <ShieldAlert className="h-4 w-4" />
            </span>
            <div className="space-y-0.5">
              <p className="text-[15px] font-semibold">
                {local.length === 1 ? "One server bypasses Oathrion" : `${String(local.length)} servers bypass Oathrion`}
              </p>
              <p className="text-[13px] text-muted-foreground">Your agent can use them without anything being asked of you or written to the log.</p>
            </div>
          </div>
          <ul className="divide-y divide-card-border overflow-hidden rounded-xl bg-muted/60">
            {local.map((s) => (
              <li key={`${s.where}-${s.name}`} className="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-2.5 text-[14px]">
                <span className="font-medium">{s.name}</span>
                <span className="text-[12px] text-muted-foreground">{s.where}</span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted-foreground">In a terminal, this command shows them and protects them once you agree:</p>
          <CopyCommand command={PROTECT} />
        </>
      )}
      {remote.length > 0 && (
        <p className="text-[13px] text-muted-foreground">
          Remote, with sign-in handled by your client (OAuth): Oathrion cannot sit in front of them yet —{" "}
          {remote.map((s) => `${s.name} (${s.where})`).join(", ")}.
        </p>
      )}
    </Surface>
  );
}

export default function ServersPage() {
  /* Relu toutes les 5 s : la première action de l'agent apparaît d'elle-même. */
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ["/api/local/servers"], queryFn: getLocalServers, refetchInterval: 5_000 });

  if (isError) {
    return <ErrorState message={error instanceof Error ? error.message : "The servers could not be read."} onRetry={() => void refetch()} />;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Servers" subtitle="Your agents' MCP servers, and what Oathrion does with them." />
      {isLoading || !data ? (
        <TableSkeleton rows={3} cols={3} />
      ) : (
        <>
          <Unprotected list={data.unprotected} />
          {data.servers.length === 0 ? (
            <Surface>
              <EmptyState
                icon={Server}
                title="No server behind Oathrion yet"
                description="A server shows up here as soon as your client (Claude Code, Cursor) starts it through Oathrion. To protect them all:"
                action={<CopyCommand command={PROTECT} />}
              />
            </Surface>
          ) : (
            <section className="grid gap-4 md:grid-cols-2" aria-label="Servers behind Oathrion">
              {data.servers.map((server) => (
                <ServerCard key={server.name} server={server} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
