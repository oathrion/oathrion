/**
 * LE PASSEPORT D'UN AGENT, DANS LA CONSOLE (23 novembre : « la page dans laquelle presque tout
 * tourne », `notes/CONSTRUCTION-CONSOLE-PASSEPORT.md`). Le style de l'image qui l'a inspiré —
 * verre, lueurs, « AGENT PASSPORT » en dégradé — avec le logo d'Oathrion (l'anneau), jamais un
 * autre. Les chiffres viennent du passeport calculé par le pivot (`/api/local/passports`) : des
 * faits comptés, pas une note.
 */
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { BarChart3, Box, CalendarClock, Check, ChevronRight, Download, Send, ShieldCheck, ShieldX, User } from "lucide-react";

import { Logo } from "@/components/layout/Logo";
import { SendProofDialog } from "@/components/receipts/SendProofDialog";
import { getSignedPassport, type AgentPassport, type PassportEntry } from "@/lib/api";
import { friendlyApproval } from "@shared/approval-text";
import { FRIENDLY_BUTTONS } from "@shared/friendly-words";
import { compact, relativeTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useARIA } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Approval } from "@shared/types";

export const passportHref = (agent: string) => `/passport/${encodeURIComponent(agent)}`;

/** « AGENT PASSPORT », le logo d'Oathrion devant. */
export function PassportTitle({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <div className="flex items-center gap-2.5 whitespace-nowrap">
      <Logo className={cn("ap-logo shrink-0", size === "lg" ? "h-14 w-14" : size === "md" ? "h-9 w-9" : "h-6 w-6")} />
      <div className="flex flex-col gap-1">
        <span className={cn("font-semibold leading-none tracking-[0.01em]", size === "lg" ? "text-[34px]" : size === "md" ? "text-[20px]" : "text-[15px]")}>
          AGENT <span className="ap-grad">PASSPORT</span>
        </span>
        {size === "lg" ? <span className="text-[14px] font-medium tracking-[0.12em] text-muted-foreground">TRUST · CONTROL · TRANSPARENCY</span> : null}
      </div>
    </div>
  );
}

export function SignedBadge({ label = "Signed", small = false }: { label?: string; small?: boolean }) {
  return (
    <span className={cn("ap-signed inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold", small ? "py-1 pl-1.5 pr-3 text-[12px]" : "py-1.5 pl-2 pr-4 text-[15px]")}>
      <span className={cn("flex items-center justify-center rounded-full bg-[#28d3b6]", small ? "h-4 w-4" : "h-5 w-5")}>
        <Check className={cn("text-[#06231e]", small ? "h-2.5 w-2.5" : "h-3 w-3")} strokeWidth={4} aria-hidden="true" />
      </span>
      {label}
    </span>
  );
}

/** La mascotte de l'agent dans l'anneau lumineux. */
export function PassportFace({ face, size }: { face: { id: string; name: string }; size: number }) {
  return (
    <div className="ap-ring shrink-0 rounded-full p-[3px]" style={{ width: size, height: size }}>
      <div className="ap-ring-inner flex h-full w-full items-center justify-center rounded-full">
        <img src={`/mascots/${face.id}.png`} alt={face.name} className="object-contain drop-shadow-[0_0_14px_rgba(160,140,255,0.55)]" style={{ width: size * 0.7, height: size * 0.7 }} />
      </div>
    </div>
  );
}

/** Ce qui est passé, ce qui a été demandé, ce qui a été bloqué : la barre en dégradé du passeport. */
export function RecordBar({ record }: { record: AgentPassport["record"] }) {
  if (record.total === 0) return <div className="h-2.5 rounded-full bg-[#0e1032]" aria-hidden="true" />;
  return (
    <div
      role="img"
      aria-label={`${String(record.passed)} went through, ${String(record.asked)} asked you, ${String(record.blocked)} blocked`}
      className="flex h-2.5 overflow-hidden rounded-full bg-[#0e1032]"
    >
      <div className="ap-bar" style={{ flexGrow: record.passed }} />
      {record.asked > 0 ? <div className="min-w-[8px] bg-[#3fe3c8]" style={{ flexGrow: record.asked }} /> : null}
      {record.blocked > 0 ? <div className="min-w-[6px] bg-[#ff9a52]" style={{ flexGrow: record.blocked }} /> : null}
    </div>
  );
}

export const recordLine = (record: AgentPassport["record"]) =>
  record.total === 0 ? "quiet this period" : `${compact(record.total)} actions · ${compact(record.asked)} asked you · ${compact(record.blocked)} blocked`;

/** Une ligne de verre du passeport : une icône, un titre, un détail, une flèche si elle mène ailleurs. */
export function PassportRow({ icon, title, detail, children, href, className }: { icon: ReactNode; title: string; detail: string; children?: ReactNode; href?: string; className?: string }) {
  const body = (
    <>
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[17px] font-semibold leading-tight">{title}</p>
        <p className="truncate text-[14px] text-muted-foreground">{detail}</p>
        {children}
      </div>
      {href ? <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
    </>
  );
  const style = cn("ap-tile flex min-h-[72px] items-center gap-4 px-5 py-3", className);
  return href ? (
    <Link href={href} className={cn(style, "transition-colors hover:brightness-110")}>
      {body}
    </Link>
  ) : (
    <div className={style}>{body}</div>
  );
}

/** Un fichier HTML à télécharger, fabriqué dans la page : rien ne part ailleurs. */
export function downloadHtml(name: string, html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Télécharger le passeport signé : un fichier que n'importe qui vérifie avec `npx oathrion receipt verify`. */
export function useSharePassport() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (agent: string) => ({ agent, signed: await getSignedPassport(agent) }),
    onSuccess: ({ agent, signed }) => {
      const slug = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
      downloadHtml(`oathrion-passport-${slug}.html`, signed);
      toast({ title: "Passport downloaded, signed", description: "A page that checks itself in any browser. Nothing was sent." });
    },
    onError: (error: Error) => toast({ title: "The passport could not be signed", description: error.message, variant: "destructive" }),
  });
}

/** Les demandes en attente d'un agent : elles s'affichent sur son passeport. */
export function usePendingFor(agent: string | null): Approval[] {
  const { approvals } = useARIA();
  return approvals.filter((a) => a.status === "pending" && (agent === null || a.agentName === agent));
}

/** Une décision qui attend : sur le passeport de l'agent, et en tête de l'accueil. */
export function WaitingDecision({ approval, face, compactView = false }: { approval: Approval; face?: { id: string; name: string }; compactView?: boolean }) {
  const { resolveApproval } = useARIA();
  const { toast } = useToast();
  /* Les mêmes mots que la notification : l'agent demande, comme un ami (`shared/friendly-words.ts`). */
  const text = friendlyApproval(approval);
  const decide = useMutation({
    mutationFn: (status: "approved" | "rejected") => resolveApproval(approval.id, status),
    onSuccess: (_, status) => toast({ title: status === "approved" ? "You said yes, this once" : "You said no" }),
    onError: () => toast({ title: "The decision could not be recorded", variant: "destructive" }),
  });
  return (
    <section aria-label="Waiting for you" className="ap-soft ap-wait flex flex-wrap items-center gap-4 rounded-[20px] px-5 py-4" data-testid={`waiting-${approval.id}`}>
      {face ? <PassportFace face={face} size={52} /> : null}
      <div className="min-w-[16rem] flex-1">
        <p className="text-[12px] font-semibold tracking-[0.12em] text-[#8ff2e4]">
          {(face?.name ?? approval.agentName).toUpperCase()} IS WAITING FOR YOU · {relativeTime(approval.requestedAt).toUpperCase()}
        </p>
        <p className="mt-1 text-[17px] font-semibold">{text.ask}</p>
        {text.why ? <p className="text-[14px] text-muted-foreground">{text.why}</p> : null}
        {text.code && !compactView ? <p className="mt-2 overflow-x-auto rounded-xl border border-border bg-[#06081e] px-3 py-2 font-mono text-[13px]">{text.where ? `on ${text.where}: ` : ""}{text.code}</p> : null}
        {text.code && compactView ? <p className="truncate font-mono text-[13px] text-muted-foreground">{text.code}</p> : null}
      </div>
      <div className="flex gap-2.5">
        <button type="button" className="ap-btn h-11 rounded-xl px-5 text-[15px] font-semibold disabled:opacity-60" disabled={decide.isPending} onClick={() => decide.mutate("approved")} data-testid={`allow-${approval.id}`}>
          {FRIENDLY_BUTTONS.approve}
        </button>
        <button type="button" className="h-11 rounded-xl border border-[#ff9a52]/60 bg-[#3c1e14]/30 px-5 text-[15px] font-semibold text-[#ffb27a] disabled:opacity-60" disabled={decide.isPending} onClick={() => decide.mutate("rejected")} data-testid={`stop-${approval.id}`}>
          {FRIENDLY_BUTTONS.reject}
        </button>
      </div>
    </section>
  );
}

/** La carte passeport de l'accueil : un agent, son visage, son bilan, la dernière action arrêtée. */
export function PassportCard({ entry, waiting }: { entry: PassportEntry; waiting: boolean }) {
  const share = useSharePassport();
  const { passport, face } = entry;
  return (
    <article className="ap-card flex flex-col gap-4 rounded-[32px] p-5" data-testid={`passport-${entry.agent}`}>
      <div className="flex items-center justify-between gap-2">
        <PassportTitle size="sm" />
        {waiting ? <SignedBadge label="Needs you" small /> : passport.evidence.intact ? <SignedBadge small /> : null}
      </div>
      <div className="flex items-center gap-4">
        <PassportFace face={face} size={88} />
        <div className="min-w-0">
          <p className="truncate text-[25px] font-semibold leading-tight">{face.name}</p>
          <p className="truncate text-[14px] text-muted-foreground">{entry.agent}</p>
        </div>
      </div>
      <div className="flex flex-col gap-[3px]">
        <PassportRow icon={<BarChart3 className="h-6 w-6 text-[#5fb8ff]" aria-hidden="true" />} title="Record · 7 days" detail={recordLine(passport.record)} className="rounded-t-[14px] rounded-b-md">
          <div className="mt-2">
            <RecordBar record={passport.record} />
          </div>
        </PassportRow>
        {passport.lastStopped ? (
          <PassportRow
            icon={<ShieldX className="h-6 w-6 text-[#ffb27a]" aria-hidden="true" />}
            title="Last stopped"
            detail={`${relativeTime(passport.lastStopped.at)} · ${passport.lastStopped.what}`}
            className="ap-stop rounded-b-[14px] rounded-t-md"
          />
        ) : (
          <PassportRow
            icon={<Box className="h-6 w-6 text-[#5fb8ff]" aria-hidden="true" />}
            title="Tools Access"
            detail={passport.tools.length > 0 ? passport.tools.map((t) => t.tool).join(", ") : "nothing yet"}
            className="rounded-b-[14px] rounded-t-md"
          />
        )}
      </div>
      <div className="mt-auto flex gap-2.5">
        <Link href={passportHref(entry.agent)} className="ap-btn flex h-11 flex-1 items-center justify-center rounded-xl text-[15px] font-semibold" data-testid={`open-passport-${entry.agent}`}>
          Open passport
        </Link>
        <button type="button" aria-label={`Download ${face.name}'s signed passport`} className="ap-ghost flex h-11 w-11 items-center justify-center rounded-xl" disabled={share.isPending} onClick={() => share.mutate(entry.agent)}>
          <Download className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

/** Le passeport en grand, en tête de la page d'un agent. */
export function PassportFull({ entry, days }: { entry: PassportEntry; days: number }) {
  const share = useSharePassport();
  const [proving, setProving] = useState(false);
  const { passport, face } = entry;
  const hook = passport.hookRules;
  const program = passport.agent.program;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return (
    <section className="ap-card flex flex-col gap-6 rounded-[40px] p-7" aria-label="Agent passport" data-testid="passport-full">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <PassportTitle size="lg" />
        {passport.evidence.intact ? <SignedBadge /> : <span className="rounded-full border border-[#ff9a52] px-4 py-1.5 text-[14px] font-semibold text-[#ffb27a]">Records not intact</span>}
      </header>
      <div className="flex flex-wrap gap-7">
        <div className="flex flex-[1_1_260px] flex-col items-center gap-2.5">
          <PassportFace face={face} size={204} />
          <p className="mt-2 text-[30px] font-semibold leading-tight">{face.name}</p>
          <p className="text-[16px] text-muted-foreground">{entry.agent}</p>
          <div className="my-1 h-px w-56 bg-gradient-to-r from-transparent via-[#a0aaff]/60 to-transparent" aria-hidden="true" />
          <p className="text-center text-[16px] leading-snug">
            Your AI agent, on the record.
            <br />
            Every action signed.
          </p>
          <button type="button" className="ap-btn mt-3 flex h-11 items-center gap-2 rounded-xl px-5 text-[15px] font-semibold disabled:opacity-60" disabled={share.isPending} onClick={() => share.mutate(entry.agent)} data-testid="share-passport">
            <Download className="h-4 w-4" aria-hidden="true" />
            Share passport
          </button>
          <button type="button" className="ap-ghost flex h-10 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold" onClick={() => setProving(true)} data-testid="send-proof-passport">
            <Send className="h-4 w-4" aria-hidden="true" />
            Send proof to a client
          </button>
          <SendProofDialog open={proving} onOpenChange={setProving} />
        </div>
        <div className="flex min-w-0 flex-[1.4_1_340px] flex-col gap-[3px]">
          <PassportRow
            icon={<User className="h-7 w-7 text-[#a98cff]" aria-hidden="true" />}
            title="Identity"
            detail={program ? `${program.executable} · fingerprint ${program.sha256.slice(0, 4)} ${program.sha256.slice(4, 8)} … ${program.sha256.slice(-4)}` : `${entry.agent} · checked by Oathrion's hook`}
            className="rounded-t-2xl rounded-b-md"
          />
          <PassportRow
            icon={<ShieldCheck className="h-7 w-7 text-[#46e3d2]" aria-hidden="true" />}
            title="Permissions"
            detail={hook ? `${String(hook.inForce.length)} rules in force · ${hook.off.length > 0 ? `turned off: ${hook.off.join(", ")}` : "none turned off"}` : `${String(passport.rules.length)} rule(s) applied to it`}
            href="/protection"
            className="rounded-md"
          />
          <PassportRow
            icon={<Box className="h-7 w-7 text-[#5fb8ff]" aria-hidden="true" />}
            title="Tools Access"
            detail={passport.tools.length > 0 ? passport.tools.map((t) => t.tool).join(", ") : "nothing yet"}
            className="rounded-md"
          />
          <PassportRow icon={<BarChart3 className="h-7 w-7 text-[#5fb8ff]" aria-hidden="true" />} title={`Record · ${String(days)} days`} detail={recordLine(passport.record)} className="rounded-md">
            <div className="mt-2">
              <RecordBar record={passport.record} />
            </div>
          </PassportRow>
          <PassportRow
            icon={<CalendarClock className="h-7 w-7 text-[#a98cff]" aria-hidden="true" />}
            title="Protected since"
            detail={passport.agent.firstSeen ? day(passport.agent.firstSeen) : "—"}
            className="rounded-md"
          />
          <PassportRow
            icon={<ShieldCheck className="h-7 w-7 text-[#5fb8ff]" aria-hidden="true" />}
            title="Audit Trail"
            detail={`${compact(passport.evidence.receipts.entries + passport.evidence.journal.entries)} signed entries · ${passport.evidence.intact ? "intact" : "NOT intact"}`}
            href="/activity"
            className="rounded-b-2xl rounded-t-md"
          />
        </div>
      </div>
    </section>
  );
}
