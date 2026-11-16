/**
 * LE MOMENT DU REÇU (16 novembre) : on ne lit pas qu'Oathrion signe des reçus, on en reçoit un.
 *
 * Juste après une décision (« Approve », « Reject »), la demande se change en reçu, comme un
 * ticket qui sort : l'action, l'agent, ce qui a été décidé, la signature de cet Oathrion — et le
 * navigateur de la personne qui VÉRIFIE la signature sous ses yeux (`lib/receipt-check.ts`).
 * Le fichier téléchargé est le même reçu, que n'importe qui vérifie sans Oathrion.
 *
 * L'issue d'une action approuvée arrive une seconde plus tard (le pivot l'exécute) : le reçu est
 * relu jusqu'à ce qu'elle soit connue, puis scellé tel quel. Rien n'est inventé : tout vient de
 * la déclaration signée (`/api/local/receipts/:ref/share?format=json`).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Download, X } from "lucide-react";

import { ActionWords } from "@/components/receipts/ActionWords";
import { Button } from "@/components/ui/button";
import { getReceipt, getSharedReceipt } from "@/lib/api";
import { checkReceipt } from "@/lib/receipt-check";
import { cn } from "@/lib/utils";
import { MARK_PATH, MARK_VIEWBOX } from "@shared/brand-mark";
import type { SharedReceipt } from "@shared/receipt-share";

/* Une action approuvée pas encore exécutée : son issue arrive, le reçu attend de la connaître. */
const UNSETTLED = new Set(["waiting", "running", "approved-not-run"]);

/** Le reçu, relu toutes les 0,8 s tant que l'issue n'est pas connue (dix secondes au plus). */
async function sealedReceipt(ref: string): Promise<SharedReceipt> {
  let shared = await getReceipt(ref);
  for (let read = 1; read < 12 && UNSETTLED.has(shared.statement.action.outcome); read += 1) {
    await new Promise((done) => setTimeout(done, 800));
    shared = await getReceipt(ref);
  }
  return shared;
}

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/*
 * « Try to change it » (16 novembre, retour des premiers testeurs : « on ne comprend pas le reçu,
 * ni à quoi il sert ») : plutôt qu'un paragraphe, l'expérience. La décision inscrite est inversée
 * dans une COPIE, sous les yeux de la personne, et son navigateur répond aussitôt qu'elle a été
 * changée. Rien n'est envoyé ni enregistré : le vrai reçu reste intact.
 */
function forged(shared: SharedReceipt): SharedReceipt {
  const { action } = shared.statement;
  const refused = action.outcome.startsWith("refused");
  return {
    ...shared,
    statement: {
      ...shared.statement,
      action: { ...action, outcome: refused ? "approved-done" : "refused-by-person", outcomeLabel: refused ? "Approved by a person, done" : "Refused by a person" },
    },
  };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-1.5">
      <dt className="w-24 shrink-0 text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-[14px]">{children}</dd>
    </div>
  );
}

export function ReceiptMoment({ executionRef, onClose }: { executionRef: string; onClose?: () => void }) {
  const receipt = useQuery({ queryKey: ["/api/local/receipts", executionRef], queryFn: () => sealedReceipt(executionRef), retry: 3, staleTime: Infinity });
  const [changed, setChanged] = useState(false);
  const shown = receipt.data && changed ? forged(receipt.data) : receipt.data;
  /* Le verdict du navigateur, recalculé pour CE que la personne voit : le vrai reçu, ou la copie changée. */
  const verdict = useQuery({ queryKey: ["receipt-check", shown?.signature, changed], queryFn: () => checkReceipt(shown!), enabled: shown !== undefined, staleTime: Infinity });
  const [saving, setSaving] = useState<"idle" | "busy" | "failed">("idle");

  if (receipt.isError) {
    return (
      <div className="rounded-xl border border-dashed border-card-border px-5 py-4 text-[14px] text-muted-foreground" data-testid={`receipt-${executionRef}`}>
        Decided. The receipt could not be read yet: it is in Activity, under Details.
      </div>
    );
  }

  if (!shown) {
    return (
      <div className="rounded-xl border border-card-border bg-card px-5 py-4 text-[14px] text-muted-foreground" data-testid={`receipt-${executionRef}`} aria-live="polite">
        Sealing the receipt…
      </div>
    );
  }

  const { action, evidence, issuer, issuedAt } = shown.statement;
  const checked = verdict.data;
  return (
    <article className="receipt-print overflow-hidden rounded-xl border border-card-border bg-card" data-testid={`receipt-${executionRef}`} aria-label="Signed receipt">
      <header className="flex items-center justify-between gap-3 px-5 pt-4">
        <span className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
          <svg viewBox={MARK_VIEWBOX} className="h-4 w-4" aria-hidden>
            <path d={MARK_PATH} fill="currentColor" fillRule="evenodd" />
          </svg>
          Receipt · your proof of this decision
        </span>
        <span className="font-mono text-[12px] text-muted-foreground">{clock(issuedAt)}</span>
      </header>

      <div className="px-5 pb-4 pt-2">
        <p className={cn("font-serif text-[20px] leading-snug", changed && "rounded bg-warning-soft px-1 text-warning")} data-testid={`receipt-outcome-${executionRef}`}>
          {action.outcomeLabel}
        </p>
        <dl className="mt-2">
          <Row label="Agent">{action.agent}</Row>
          <Row label="Action">
            <ActionWords action={action.what} target={action.target} />
          </Row>
          {action.impact ? <Row label="Impact">{action.impact}</Row> : null}
        </dl>
      </div>

      {/* La perforation du ticket : au-dessus, ce qui s'est passé ; en dessous, la preuve. */}
      <div className="border-t border-dashed border-card-border" aria-hidden />

      <div className="space-y-2 px-5 py-4">
        <p className="text-[13px] text-muted-foreground">
          <span title={`Key ${issuer.fingerprint} · reference ${action.ref}`}>Sealed by your Oathrion</span>
        </p>
        <p className="receipt-stamp flex items-center gap-2 text-[14px] font-medium" aria-live="polite" data-testid={`receipt-verdict-${executionRef}`}>
          {!checked ? (
            <span className="text-muted-foreground">Your browser is checking the seal…</span>
          ) : checked.ok === true ? (
            <>
              <Check className="h-4 w-4 text-success" aria-hidden />
              <span>Checked by your browser just now: nothing has changed since it was sealed.</span>
            </>
          ) : checked.ok === false ? (
            <>
              <X className="h-4 w-4 text-danger" aria-hidden />
              <span className="text-danger">{changed ? "Changed after it was sealed: do not trust it." : checked.reason}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{checked.reason}</span>
          )}
        </p>
        <p className="text-[13px] text-muted-foreground">
          {evidence.chainIntact
            ? `Nothing before it was erased or rewritten (${evidence.chainEntries.toLocaleString()} earlier records checked).`
            : "Something before it was erased or rewritten: see Activity, under Details."}
        </p>
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-card-border bg-muted/30 px-5 py-3">
        <Button size="sm" variant="ghost" className="mr-auto" onClick={() => setChanged((on) => !on)} aria-pressed={changed} data-testid={`receipt-try-${executionRef}`}>
          {changed ? "Put it back" : "Try to change it"}
        </Button>
        {onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose} data-testid={`receipt-close-${executionRef}`}>
            Done
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={saving === "busy" || changed}
          onClick={() => {
            setSaving("busy");
            getSharedReceipt(executionRef)
              .then((html) => {
                download(`oathrion-receipt-${executionRef.replace(/[^a-zA-Z0-9_-]/g, "")}.html`, html);
                setSaving("idle");
              })
              .catch(() => setSaving("failed"));
          }}
          data-testid={`receipt-download-${executionRef}`}
        >
          <Download className="h-4 w-4" aria-hidden />
          <span className="ml-1.5">{saving === "failed" ? "Retry" : "Download: anyone can check it"}</span>
        </Button>
      </footer>
    </article>
  );
}
