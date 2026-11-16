/**
 * APPROUVER DEPUIS SON TÉLÉPHONE, EN TROIS ÉTAPES (16 novembre, retour des premiers testeurs :
 * « le parcours est trop complexe »). Avant : un terminal, @BotFather sur le téléphone, puis un
 * jeton de 46 caractères à recopier du téléphone vers l'ordinateur. Maintenant, tout part d'ici :
 *
 *   1. @BotFather s'ouvre SUR CET ORDINATEUR (Telegram ou web.telegram.org) : le jeton arrive là
 *      où il faut le coller ; les trois messages à envoyer se copient d'un clic ;
 *   2. le jeton se colle ici, et Telegram le vérifie ;
 *   3. le téléphone scanne le QR code et touche Start ; la console voit l'appairage arriver,
 *      et une demande d'essai part sur le téléphone.
 *
 * Le serveur fait le reste (`server/local-phone-pairing.ts`) ; rien n'est gardé dans ce navigateur.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getPhonePairing, startPhonePairing, testPhone, type PhonePairing } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Un identifiant de robot libre, très probablement : BotFather exige qu'il finisse par « bot ». */
const freshUsername = () => `oathrion_${Math.random().toString(36).slice(2, 7)}_bot`;

function CopyLine({ text, hint }: { text: string; hint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-card-border bg-background px-3 py-2">
      <span className="min-w-0">
        <code className="font-mono text-[13px] text-foreground">{text}</code>
        <span className="ml-2 text-[13px] text-muted-foreground">{hint}</span>
      </span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-foreground/80 hover:bg-muted"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </li>
  );
}

function Qr({ qr }: { qr: { size: number; cells: string } }) {
  const quiet = 3;
  const side = qr.size + quiet * 2;
  const dark: string[] = [];
  for (let i = 0; i < qr.cells.length; i += 1) if (qr.cells[i] === "1") dark.push(`M${String((i % qr.size) + quiet)} ${String(Math.floor(i / qr.size) + quiet)}h1v1h-1z`);
  return (
    <svg viewBox={`0 0 ${String(side)} ${String(side)}`} className="h-44 w-44 rounded-md bg-white" shapeRendering="crispEdges" role="img" aria-label="QR code to pair your phone">
      <path d={dark.join("")} fill="#000" />
    </svg>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold", done ? "border-success/50 bg-success-soft text-success" : "border-card-border")}>
        {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 text-[14px]">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </section>
  );
}

export function PhonePairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState(freshUsername);
  const [token, setToken] = useState("");
  const [tested, setTested] = useState<"idle" | "sent" | "failed">("idle");
  const pairing = useQuery({
    queryKey: ["/api/local/phone"],
    queryFn: getPhonePairing,
    enabled: open,
    refetchInterval: (query) => ((query.state.data as PhonePairing | undefined)?.state === "waiting" ? 2_000 : false),
  });
  const pair = useMutation({
    mutationFn: () => startPhonePairing(token),
    onSuccess: (state) => queryClient.setQueryData(["/api/local/phone"], state),
  });
  const state = pair.isPending ? null : (pairing.data ?? null);
  const waiting = state?.state === "waiting" ? (state as Extract<PhonePairing, { state: "waiting" }>) : null;
  const paired = state?.state === "paired" ? (state as Extract<PhonePairing, { state: "paired" }>) : null;
  const tokenDone = waiting !== null || paired !== null;
  /* Appairé : les réglages et la carte « Setting up » le disent aussi. */
  const pairedBot = paired?.bot;
  useEffect(() => {
    if (pairedBot) {
      void queryClient.invalidateQueries({ queryKey: ["/api/local/settings"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/local/readiness"] });
    }
  }, [pairedBot, queryClient]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-[22px] font-medium">Approve from your phone</DialogTitle>
          <DialogDescription>
            About two minutes. You make a small Telegram bot that only you use: your agents' requests reach your phone through it, with Approve and Reject.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 pt-2">
          <Step n={1} title="Create your bot, on this computer" done={tokenDone}>
            {tokenDone ? null : (
              <>
                {/*
                 * Telegram Web d'abord (essai réel du 16 novembre) : « t.me/BotFather » cherche
                 * l'application de l'ordinateur, que beaucoup n'ont pas (Telegram seulement sur le
                 * téléphone) ; le navigateur proposait alors « xdg-open », puis « aucune application ».
                 */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" variant="outline">
                    <a href="https://web.telegram.org/k/#@BotFather" target="_blank" rel="noreferrer" data-testid="link-botfather-web">
                      Open BotFather in Telegram Web <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden />
                    </a>
                  </Button>
                  <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                    or in the Telegram app
                  </a>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  The first time, Telegram Web shows a code: scan it with Telegram on your phone (Settings, Devices, Link Desktop Device). Then, in the chat with BotFather (in Telegram, not in a terminal), send these three messages, one after the other:
                </p>
                <ol className="space-y-1.5">
                  <CopyLine text="/newbot" hint="start" />
                  <CopyLine text="Oathrion" hint="its name" />
                  <CopyLine text={username} hint="its username" />
                </ol>
                <p className="text-[13px] text-muted-foreground">
                  Username taken?{" "}
                  <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => setUsername(freshUsername())}>
                    Another one
                  </button>
                  . BotFather then sends a token: a line like <code className="font-mono">123456789:AA…</code>
                </p>
              </>
            )}
          </Step>

          <Step n={2} title="Paste the token here" done={tokenDone}>
            {tokenDone ? (
              <p className="text-[13px] text-muted-foreground">Bot found: @{waiting?.bot ?? paired?.bot}.</p>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (token.trim() !== "") pair.mutate();
                }}
              >
                <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="123456789:AA…" autoComplete="off" spellCheck={false} className="font-mono text-[13px]" aria-label="Bot token" data-testid="input-phone-token" />
                <Button type="submit" disabled={pair.isPending || token.trim() === ""} data-testid="button-phone-check">
                  {pair.isPending ? "Checking…" : "Check"}
                </Button>
              </form>
            )}
            {state?.state === "failed" ? <p className="text-[13px] text-danger">{state.message}</p> : null}
            {pair.isError ? <p className="text-[13px] text-danger">{pair.error.message}</p> : null}
          </Step>

          <Step n={3} title="Scan with your phone, then tap Start" done={paired !== null}>
            {waiting ? (
              <div className="flex flex-wrap items-start gap-4">
                <Qr qr={waiting.qr} />
                <div className="min-w-0 flex-1 space-y-2 text-[13px] text-muted-foreground">
                  <p>Open your phone's camera on this code: Telegram opens on your bot. Tap Start.</p>
                  <p>
                    No camera? In Telegram, search <span className="font-medium text-foreground">@{waiting.bot}</span>, tap Start, then send <code className="font-mono text-foreground">{waiting.code}</code>.
                  </p>
                  <p className="font-medium text-foreground" aria-live="polite">Waiting for your phone…</p>
                </div>
              </div>
            ) : paired ? (
              <div className="space-y-2" aria-live="polite" data-testid="phone-paired">
                <p className="text-[14px]">Paired with @{paired.bot}. A test request was sent to your phone: that is how your agents' requests will look.</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      testPhone()
                        .then(() => setTested("sent"))
                        .catch(() => setTested("failed"));
                    }}
                  >
                    {tested === "sent" ? "Sent again" : tested === "failed" ? "Telegram refused: retry" : "Send another test"}
                  </Button>
                  <Button size="sm" onClick={onClose}>
                    Done
                  </Button>
                </div>
              </div>
            ) : state?.state === "expired" ? (
              <div className="space-y-2">
                <p className="text-[13px] text-muted-foreground">No answer from your phone in five minutes.</p>
                <Button size="sm" variant="outline" disabled={pair.isPending} onClick={() => pair.mutate()}>
                  Show a new code
                </Button>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">The code to scan appears here once the token is checked.</p>
            )}
          </Step>
        </div>
      </DialogContent>
    </Dialog>
  );
}
