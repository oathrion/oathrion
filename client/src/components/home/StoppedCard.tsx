/**
 * « WHAT OATHRION STOPPED », EN TÊTE DE L'ACCUEIL (16 novembre, la passe de concentration). Le
 * meilleur moment du produit (ce qu'Oathrion a arrêté, et son reçu) était trois clics plus loin,
 * dans « Details », « Activity ». L'accueil répond maintenant à trois questions : suis-je protégé ?
 * quelque chose m'attend-il ? qu'est-ce qu'Oathrion a arrêté pour moi ?
 *
 * Les mêmes données que la page Activity (`/api/local/summary`, sur 7 jours) ; « Receipt » ouvre le
 * reçu sur place, vérifié par le navigateur (`components/receipts/ReceiptMoment.tsx`).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Link } from "wouter";

import { Surface } from "@/components/common/primitives";
import { ActionWords } from "@/components/receipts/ActionWords";
import { ReceiptMoment } from "@/components/receipts/ReceiptMoment";
import { getLocalSummary } from "@/lib/api";
import { relativeTime } from "@/lib/format";

const SHOWN = 5;

export function StoppedCard() {
  const summary = useQuery({ queryKey: ["/api/local/summary", "7d"], queryFn: () => getLocalSummary("7d"), refetchInterval: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  const data = summary.data;
  if (!data) return null;

  if (data.saves.length === 0) {
    return (
      <Surface className="flex items-center gap-3 px-5 py-4 text-[14px]" data-testid="home-stopped-none">
        <ShieldCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
        <span>
          In the last 7 days, Oathrion checked {data.total.toLocaleString()} action{data.total === 1 ? "" : "s"} of your agents; none had to be blocked by its rules.
        </span>
      </Surface>
    );
  }

  return (
    <Surface className="overflow-hidden" data-testid="home-stopped">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-danger">
          <ShieldAlert className="h-4 w-4" aria-hidden /> What Oathrion stopped
        </h2>
        <span className="text-[13px] text-muted-foreground">
          Last 7 days · {data.total.toLocaleString()} actions checked
        </span>
      </div>
      <ul className="mt-2 divide-y divide-card-border">
        {data.saves.slice(0, SHOWN).map((save) => {
          const key = `${save.source}-${save.ref}`;
          return (
            <li key={key} className="px-5 py-3">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <ActionWords action={save.action} target={save.target} />
                  <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                    {save.impact ? <span className="font-semibold text-danger">Would have deleted {save.impact} · </span> : null}
                    {save.agent} · {relativeTime(save.at)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen((current) => (current === key ? null : key))}
                  aria-expanded={open === key}
                  className="shrink-0 rounded-full px-3 py-1 text-[13px] font-medium text-foreground/80 hover:bg-muted"
                  data-testid={`home-stopped-receipt-${save.ref}`}
                >
                  {open === key ? "Hide receipt" : "Receipt"}
                </button>
              </div>
              {open === key ? (
                <div className="pt-3">
                  <ReceiptMoment executionRef={save.ref} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.saves.length > SHOWN ? (
        <p className="border-t border-card-border px-5 py-3 text-[13px]">
          <Link href="/activity" className="font-medium underline-offset-2 hover:underline">
            All {data.saves.length} in Activity
          </Link>
        </p>
      ) : null}
    </Surface>
  );
}
