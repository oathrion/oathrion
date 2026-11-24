/**
 * APPROUVER DEPUIS SON TÉLÉPHONE, EN UN SCAN (23 novembre, `notes/CONCEPTION-RELAIS-TELEPHONE.md`) :
 * « Pair my phone », un QR code, la page d'Oathrion s'ouvre sur le téléphone, « Allow
 * notifications », « Paired ». Les notifications du navigateur, par le relais d'Oathrion
 * (`server/local-phone-relay.ts`) : aucune application, aucun compte (le soir même, le fondateur
 * n'avait pas Telegram). Le dialogue suit le style du passeport (`ap-card`, `ap-btn`).
 *
 * L'assistant d'avant reste derrière « Use your own Telegram bot instead » (16 novembre, pour qui
 * a déjà son robot) :
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
import { Check, Copy, ExternalLink, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getPhonePairing, getRelayPairing, startPhonePairing, startRelayPairing, testPhone, testRelayPhone, unpairRelay, type PhonePairing, type RelayPairing } from "@/lib/api";
import { relativeTime } from "@/lib/format";
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

/** Son propre robot, créé chez @BotFather (l'assistant du 16 novembre). */
function OwnBotPairing({ open, onClose }: { open: boolean; onClose: () => void }) {
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
  );
}

/** Le jumelage en un scan : le robot officiel, par le relais d'Oathrion. */
function OneScanPairing({ open, onClose, onOwnBot }: { open: boolean; onClose: () => void; onOwnBot: () => void }) {
  const queryClient = useQueryClient();
  const [tested, setTested] = useState<"idle" | "sent" | "failed">("idle");
  const pairing = useQuery({
    queryKey: ["/api/local/phone/relay"],
    queryFn: getRelayPairing,
    enabled: open,
    refetchInterval: (query) => {
      const state = (query.state.data as RelayPairing | undefined)?.state;
      /* En attente, souvent : la console suit le téléphone en direct (la page ouverte, puis appairé). */
      return state === "waiting" || state === "connecting" ? 1_000 : state === "paired" ? 10_000 : false;
    },
  });
  const set = (state: RelayPairing) => queryClient.setQueryData(["/api/local/phone/relay"], state);
  const pair = useMutation({ mutationFn: startRelayPairing, onSuccess: set });
  const unpair = useMutation({ mutationFn: unpairRelay, onSuccess: set });
  const state: RelayPairing | null = pair.isPending ? { state: "connecting" } : (pairing.data ?? null);
  /* Appairé, ou plus : les réglages et la carte « Setting up » le disent aussi. */
  const pairedNow = state?.state === "paired";
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["/api/local/settings"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/local/readiness"] });
  }, [pairedNow, queryClient]);

  const primary = "ap-btn inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold disabled:opacity-60";
  const ghost = "ap-ghost inline-flex h-10 items-center justify-center rounded-xl px-4 text-[14px] font-medium disabled:opacity-60";

  return (
    <div className="space-y-5 pt-1">
      {state?.state === "unavailable" ? (
        <div className="ap-soft space-y-3 rounded-[20px] p-5">
          <p className="text-[14px]">{state.message}</p>
          <button type="button" className={ghost} onClick={onOwnBot} data-testid="button-own-bot">
            Use your own Telegram bot
          </button>
        </div>
      ) : state?.state === "waiting" && state.seen ? (
        /* Les deux écrans se répondent : le téléphone a ouvert la page, le QR code a fait son travail. */
        <div className="ap-card ap-wait flex flex-col items-center gap-4 rounded-[28px] p-6 text-center" data-testid="phone-seen" aria-live="polite">
          <span className="ap-ring flex h-20 w-20 items-center justify-center rounded-full p-[3px] animate-in zoom-in-75 duration-500">
            <span className="ap-ring-inner flex h-full w-full items-center justify-center rounded-full">
              <Smartphone className="h-8 w-8 text-[#7ff0dc]" aria-hidden="true" />
            </span>
          </span>
          <div className="space-y-1">
            <p className="text-[17px] font-semibold">Your phone opened the page</p>
            <p className="text-[14px] text-muted-foreground">On your phone, tap Allow notifications. This window follows along.</p>
          </div>
        </div>
      ) : state?.state === "waiting" ? (
        <div className="ap-card ap-wait flex flex-wrap items-center gap-5 rounded-[28px] p-5" data-testid="phone-qr">
          <div className="rounded-2xl bg-white p-2 shadow-[0_0_24px_rgba(63,227,200,0.35)]">
            <Qr qr={state.qr} />
          </div>
          <div className="min-w-0 flex-1 space-y-2 text-[14px]">
            {state.kind === "web" ? (
              <>
                <p className="font-semibold">Scan with your phone's camera</p>
                <p className="text-muted-foreground">Oathrion's page opens. Tap Allow notifications: that is all. No app, no account.</p>
                <p className="text-[13px] text-muted-foreground">On iPhone, the page first asks you to add it to your home screen.</p>
              </>
            ) : (
              <>
                <p className="font-semibold">Scan with your phone, then tap Start</p>
                <p className="text-muted-foreground">Your phone's camera opens Telegram on @{state.bot}. Tap Start: that is all.</p>
              </>
            )}
            <p className="text-[13px] text-muted-foreground">
              Reading this on your phone?{" "}
              <a href={state.link} target="_blank" rel="noreferrer" className="font-medium text-foreground underline-offset-2 hover:underline">
                Open the link
              </a>
            </p>
            <p className="font-medium text-[#7ff0dc]" aria-live="polite">
              Waiting for your phone…
            </p>
          </div>
        </div>
      ) : state?.state === "paired" ? (
        <div className="ap-card space-y-4 rounded-[28px] p-5" aria-live="polite" data-testid="phone-paired">
          <div className="flex items-center gap-4">
            {/* La fête de l'appairage : Warden, la gardienne, dans l'anneau d'Oathrion (comme sur le téléphone). */}
            <span className="ap-ring relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full p-[3px] animate-in zoom-in-50 duration-500">
              <span className="ap-ring-inner flex h-full w-full items-center justify-center rounded-full">
                <img src="/mascots/warden.png" alt="" className="h-[74%] w-[74%] object-contain drop-shadow-[0_0_12px_rgba(160,140,255,0.55)]" />
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-[#28d3b6] shadow-[0_0_12px_rgba(63,227,200,0.8)]">
                <Check className="h-4 w-4 text-[#06231e]" strokeWidth={4} aria-hidden="true" />
              </span>
            </span>
            <div className="min-w-0 space-y-1.5">
              <p className="text-[17px] font-semibold">
                Paired with <span className="ap-grad">{state.account}</span>
              </p>
              <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium", state.online ? "bg-[#28d3b6]/15 text-[#7ff0dc]" : "bg-[#ff9a52]/15 text-[#ffb27a]")} data-testid="phone-online">
                <span className={cn("h-2 w-2 rounded-full", state.online ? "bg-[#28d3b6] shadow-[0_0_8px_rgba(63,227,200,0.9)]" : "bg-[#ff9a52]")} aria-hidden="true" />
                {state.online ? "Connected" : "Reconnecting…"}
              </span>
            </div>
          </div>
          <p className="text-[14px] text-muted-foreground">
            {!state.online
              ? "Reconnecting to Oathrion's relay… Requests wait in the console meanwhile."
              : state.kind === "web"
                ? "Your agents' requests reach this phone as notifications: answer yes or no, anywhere."
                : `Your agents' requests reach your phone on Telegram (@${state.bot}): answer yes or no, anywhere.`}
            {state.lastAt ? ` Last notification: ${relativeTime(state.lastAt)}.` : ""}
          </p>
          <p className="text-[13px] text-muted-foreground">{state.kind === "web" ? "Not your phone? Unpair now: only the phone paired here can decide." : "Not your account? Unpair now: only the account shown here can decide."}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={onClose}>
              Done
            </button>
            <button
              type="button"
              className={ghost}
              onClick={() => {
                testRelayPhone()
                  .then(() => setTested("sent"))
                  .catch(() => setTested("failed"));
              }}
            >
              {tested === "sent" ? "Sent again" : tested === "failed" ? "Not sent: retry" : "Send a test"}
            </button>
            <button type="button" className={ghost} disabled={unpair.isPending} onClick={() => unpair.mutate()} data-testid="button-phone-unpair">
              {unpair.isPending ? "Unpairing…" : "Unpair"}
            </button>
          </div>
        </div>
      ) : (
        <div className="ap-card space-y-4 rounded-[28px] p-5">
          <div className="flex items-center gap-3">
            <span className="ap-ring flex h-12 w-12 shrink-0 items-center justify-center rounded-full p-[2px]">
              <span className="ap-ring-inner flex h-full w-full items-center justify-center rounded-full">
                <Smartphone className="h-5 w-5" aria-hidden="true" />
              </span>
            </span>
            <p className="text-[14px] text-muted-foreground">One scan with your phone, one tap to allow notifications. No app to install, no account.</p>
          </div>
          {state?.state === "idle" && state.notice ? <p className="text-[13px] text-[#ffb27a]">{state.notice}</p> : null}
          {state?.state === "expired" ? <p className="text-[13px] text-muted-foreground">No answer from your phone in five minutes: show a new code.</p> : null}
          {state?.state === "failed" ? <p className="text-[13px] text-danger">{state.message}</p> : null}
          {pair.isError ? <p className="text-[13px] text-danger">{pair.error.message}</p> : null}
          <button type="button" className={primary} disabled={state?.state === "connecting"} onClick={() => pair.mutate()} data-testid="button-phone-pair-relay">
            {state?.state === "connecting" ? "Connecting…" : state?.state === "expired" ? "Show a new code" : "Pair my phone"}
          </button>
        </div>
      )}
      <p className="text-[12px] text-muted-foreground">
        Your phone gets the title and the reason of each request, never its content. They are encrypted on this computer for your phone alone: Oathrion's relay passes them on without being able to read them.
      </p>
      {state?.state !== "paired" && state?.state !== "unavailable" ? (
        <button type="button" className="text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={onOwnBot} data-testid="button-own-bot">
          Use your own Telegram bot instead
        </button>
      ) : null}
    </div>
  );
}

export function PhonePairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [ownBot, setOwnBot] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setOwnBot(false);
        onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[22px] font-semibold">
            Approve from <span className="ap-grad">your phone</span>
          </DialogTitle>
          <DialogDescription>
            {ownBot
              ? "About two minutes. You make a small Telegram bot that only you use: your agents' requests reach your phone through it, and you answer yes or no."
              : "Your agents' requests reach your phone: you answer yes or no. Your computer can stay at home."}
          </DialogDescription>
        </DialogHeader>
        {ownBot ? (
          <>
            <OwnBotPairing open={open} onClose={onClose} />
            <button type="button" className="text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setOwnBot(false)}>
              Back to pairing in one scan
            </button>
          </>
        ) : (
          <OneScanPairing open={open} onClose={onClose} onOwnBot={() => setOwnBot(true)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
