/**
 * « SEND PROOF » — un verbe, pas un onglet (`notes/CONCEPTION-SAINT-GRAAL-RECUS.md`, lot 1).
 * D'abord POUR QUI : un client (le relevé de ce que les agents ont fait chez lui, avec ses
 * décisions signées par son téléphone), ou un relecteur (le reçu d'une branche, dans la PR).
 * Puis SUR QUOI : le dossier, les serveurs, la période. Puis l'aperçu, exactement ce qui sortira.
 * Enfin la page signée à télécharger, et un message prêt à coller. Rien ne part sans la personne.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, Check, Copy, Download, GitPullRequest, Smartphone } from "lucide-react";

import { downloadHtml } from "@/components/passport/Passport";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { getSignedStatement, getStatementOptions, getStatementPreview, type StatementPreview, type StatementQuery } from "@/lib/api";
import { compact, relativeTime } from "@/lib/format";
import { plainAction } from "@/lib/plain-action";
import { cn } from "@/lib/utils";

const PERIODS = [7, 30, 90] as const;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Le message que la personne colle dans son e-mail ou son Slack, avec le fichier en pièce jointe. */
export function statementMessage(preview: StatementPreview, file: string): string {
  const { summary } = preview;
  const decided = (preview.decisions?.length ?? 0) + (preview.decisionsTruncated ?? 0);
  const signed = summary.signedByPhone ?? 0;
  return [
    `Hello${preview.subject ? ` ${preview.subject}` : ""},`,
    "",
    `Here is the signed statement of what our AI agents did on your project, ${day(preview.period.since)} to ${day(preview.period.until)}: ${String(summary.total)} actions, ${String(decided)} decided by a person${signed > 0 ? ` (${String(signed)} signed on the person's own phone)` : ""}, ${String(summary.blocked)} stopped before they ran.`,
    "",
    `Open the attached file (${file}) in any browser: it checks its own signatures, offline. To check it without trusting the page: npx oathrion receipt verify ${file}`,
  ].join("\n");
}

function Choice({ active, icon, title, detail, onClick, testId }: { active: boolean; icon: React.ReactNode; title: string; detail: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn("ap-tile flex flex-1 items-start gap-3 rounded-2xl px-4 py-3 text-left transition", active ? "ring-2 ring-[#8d7bff]" : "opacity-80 hover:opacity-100")}
      data-testid={testId}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>
        <span className="block text-[15px] font-semibold">{title}</span>
        <span className="block text-[13px] text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function CopyBlock({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-[#06081e] px-3 py-2 font-mono text-[12.5px]" data-testid={testId}>
        {text}
      </pre>
      <button
        type="button"
        className="ap-ghost flex h-9 items-center justify-center gap-2 self-start rounded-lg px-3 text-[13px] font-semibold"
        onClick={() => void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })}
      >
        {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}

function ClientStatement() {
  const { toast } = useToast();
  const options = useQuery({ queryKey: ["/api/local/statement/options"], queryFn: getStatementOptions });
  const [subject, setSubject] = useState("");
  const [project, setProject] = useState<string | null | undefined>(undefined);
  const [servers, setServers] = useState<string[]>([]);
  const [days, setDays] = useState<number>(30);
  const [file, setFile] = useState<string | null>(null);
  /* Le dossier où les agents ont le plus travaillé, choisi d'office. */
  const chosen = project === undefined ? (options.data?.projects[0]?.path ?? null) : project;
  const query: StatementQuery = { project: chosen, servers, days, for: subject };
  const ready = chosen !== null || servers.length > 0;
  const preview = useQuery({ queryKey: ["/api/local/statement", query], queryFn: () => getStatementPreview(query), enabled: ready && options.isSuccess });
  const download = useMutation({
    mutationFn: () => getSignedStatement(query),
    onSuccess: (html) => {
      const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const name = `oathrion-statement-${slug ? `${slug}-` : ""}${new Date().toISOString().slice(0, 10)}.html`;
      downloadHtml(name, html);
      setFile(name);
      toast({ title: "Statement downloaded, signed", description: "Read it, then send it yourself. Nothing was sent." });
    },
    onError: (error: Error) => toast({ title: "The statement could not be signed", description: error.message, variant: "destructive" }),
  });
  const data = preview.data;
  const decided = data ? (data.decisions?.length ?? 0) + (data.decisionsTruncated ?? 0) : 0;
  const signed = data?.summary.signedByPhone ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
          Client
          <input value={subject} onChange={(e) => setSubject(e.target.value.slice(0, 120))} placeholder="Acme" className="h-10 rounded-lg border border-border bg-[#06081e] px-3 text-[14px] font-normal" data-testid="proof-client" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
          Period
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-10 rounded-lg border border-border bg-[#06081e] px-3 text-[14px] font-normal" data-testid="proof-period">
            {PERIODS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
        Project folder
        <select
          value={chosen ?? ""}
          onChange={(e) => setProject(e.target.value === "" ? null : e.target.value)}
          className="h-10 rounded-lg border border-border bg-[#06081e] px-3 text-[14px] font-normal"
          data-testid="proof-project"
        >
          <option value="">No folder: MCP servers only</option>
          {(options.data?.projects ?? []).map((p) => (
            <option key={p.path} value={p.path}>
              {p.display} · {compact(p.actions)} actions
            </option>
          ))}
        </select>
      </label>
      {options.data && options.data.servers.length > 0 ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[13px] font-semibold">MCP servers for this client</legend>
          <div className="flex flex-wrap gap-2">
            {options.data.servers.map((name) => {
              const on = servers.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setServers(on ? servers.filter((s) => s !== name) : [...servers, name])}
                  className={cn("rounded-full border px-3 py-1 text-[13px]", on ? "border-[#8d7bff] bg-[#8d7bff]/20 font-semibold" : "border-border text-muted-foreground")}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <section className="ap-soft flex flex-col gap-3 rounded-2xl px-4 py-4" aria-label="What will be in the statement" data-testid="proof-preview">
        {!ready ? (
          <p className="text-[14px] text-muted-foreground">Choose a project folder or a server.</p>
        ) : preview.isLoading || !data ? (
          <p className="text-[14px] text-muted-foreground">{preview.isError ? "The statement could not be prepared." : "Preparing what will be in it…"}</p>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                [data.summary.total, "Actions"],
                [data.summary.passed, "Within the rules"],
                [decided, "Decided by a person"],
                [data.summary.blocked, "Stopped"],
              ].map(([value, label]) => (
                <div key={label} className="rounded-xl bg-[#06081e] px-2 py-2">
                  <p className="text-[20px] font-semibold">{compact(Number(value))}</p>
                  <p className="text-[11.5px] text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
            {decided > 0 ? (
              <p className={cn("flex items-center gap-2 text-[13px] font-semibold", signed > 0 ? "text-[#46e3d2]" : "text-[#ffb27a]")}>
                <Smartphone className="h-4 w-4" aria-hidden="true" />
                {signed > 0 ? `${String(signed)} of ${String(decided)} decisions signed on the person's own phone` : "No decision signed on a phone yet: pair one in Settings, so each decision carries its own signature."}
              </p>
            ) : null}
            <ul className="flex flex-col gap-1.5">
              {(data.decisions ?? []).slice(0, 4).map((d) => (
                <li key={d.ref} className="flex min-w-0 items-start gap-2 text-[13px]">
                  {d.approval ? <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#46e3d2]" aria-label="Signed on a phone" /> : <span className="w-3.5 shrink-0" />}
                  {/* L'action en mots d'abord ; la commande exacte en petit, coupée. */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{plainAction(d.what, d.what.startsWith("mcp.") ? "" : "shell://").title}</span>
                    <span className="block truncate font-mono text-[11.5px] text-muted-foreground">{d.what}</span>
                  </span>
                  <span className="shrink-0 text-right text-[12px] text-muted-foreground">
                    {relativeTime(d.at)}
                    <br />
                    {d.approval ? `on ${d.approval.device.label || "a phone"}` : "no phone signature"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-[12.5px] text-muted-foreground">
              Only this folder and these servers. Paths are written « . » and « ~ »; secrets recognisable in commands are masked before signing.
            </p>
          </>
        )}
      </section>

      <button
        type="button"
        className="ap-btn flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold disabled:opacity-60"
        disabled={!ready || download.isPending || !data}
        onClick={() => download.mutate()}
        data-testid="proof-download"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        Download the signed statement
      </button>
      {file && data ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-semibold">Message to send with the file</p>
          <CopyBlock text={statementMessage(data, file)} label="Copy the message" testId="proof-message" />
        </div>
      ) : null}
    </div>
  );
}

function ReviewerReceipt() {
  return (
    <div className="flex flex-col gap-3 text-[14px]">
      <p>
        In the branch the agent worked on, sign what Claude Code did there. The receipt goes in the pull request; Oathrion's GitHub Action checks it, and can be required before a merge.
      </p>
      <CopyBlock text={"npx oathrion receipt bundle\ngit add .oathrion/receipts && git commit -m \"Oathrion receipt\""} label="Copy the commands" testId="proof-bundle" />
      <p className="text-[13px] text-muted-foreground">Each decision signed on a phone appears in the pull request, checked.</p>
    </div>
  );
}

export function SendProofDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [who, setWho] = useState<"client" | "reviewer">("client");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Une seule colonne qui peut rétrécir : une longue commande ne pousse plus la fenêtre hors de l'écran (essai du fondateur, 23 novembre). */}
      <DialogContent className="max-h-[92vh] max-w-xl grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto" data-testid="send-proof">
        <DialogHeader>
          <DialogTitle>Send proof</DialogTitle>
          <DialogDescription>A page that checks its own signatures, for whoever asked. Nothing is sent: you download it, read it, then send it yourself.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Choice active={who === "client"} icon={<Building2 className="h-5 w-5 text-[#a98cff]" aria-hidden="true" />} title="A client" detail="What your agents did for them, with their decisions" onClick={() => setWho("client")} testId="proof-for-client" />
          <Choice active={who === "reviewer"} icon={<GitPullRequest className="h-5 w-5 text-[#5fb8ff]" aria-hidden="true" />} title="A reviewer" detail="What the agent did on a branch, in the pull request" onClick={() => setWho("reviewer")} testId="proof-for-reviewer" />
        </div>
        {who === "client" ? <ClientStatement /> : <ReviewerReceipt />}
      </DialogContent>
    </Dialog>
  );
}
