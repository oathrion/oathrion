/**
 * LES RÉGLAGES DE LA CONSOLE LOCALE (11 novembre : « enlever tout ce qui rend l'expérience
 * complexe ») : l'état de chaque protection de la machine, en une page. Les notifications se
 * règlent ici d'un clic ; la veille, la prison par défaut et les leurres se posent par une
 * commande, que la page donne (ils installent des services et des fichiers). L'organisation, les
 * membres, les clés API : « Details », « Advanced settings ».
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Bell, Check, Copy, Eye, KeyRound, ShieldCheck, Smartphone, Users } from "lucide-react";

import { PageHeader, Surface } from "@/components/common/primitives";
import { PhonePairDialog } from "@/components/settings/PhonePairDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { getLocalSettings, setDesktopNotifications } from "@/lib/api";
import { cn } from "@/lib/utils";

function Row({ icon: Icon, title, state, on, children }: { icon: typeof Bell; title: string; state: string; on: boolean; children: React.ReactNode }) {
  return (
    <Surface className="flex items-start gap-4 p-5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-sidebar-primary ring-1 ring-inset ring-primary/25">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{title}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", on ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground")}>{state}</span>
        </p>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </Surface>
  );
}

/*
 * Ce qui ne se fait que dans un terminal (16 novembre, « trop de lignes de commande ») : la
 * phrase reste en mots, et la commande n'apparaît que pour qui la demande, prête à copier.
 */
function InTerminal({ label, command }: { label: string; command: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!open) {
    return (
      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="mt-2 flex flex-wrap items-center gap-2">
      <span>Paste this in a terminal:</span>
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-lg border border-card-border bg-background px-2.5 py-1 font-mono text-xs text-foreground hover:border-primary"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {command}
        {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
      </button>
    </span>
  );
}

export default function LocalSettingsPage() {
  const settings = useQuery({ queryKey: ["/api/local/settings"], queryFn: getLocalSettings });
  const [pairing, setPairing] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const data = settings.data;
  /* La veille et la prison n'existent que sous Linux : ailleurs, ce n'est pas « Off » à allumer. */
  const linux = (data?.platform ?? "linux") === "linux";

  const toggleDesktop = async (desktop: boolean) => {
    try {
      await setDesktopNotifications(desktop);
      await queryClient.invalidateQueries({ queryKey: ["/api/local/settings"] });
    } catch (error) {
      toast({ title: "That did not work", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="How Oathrion protects this machine." />
      {data ? (
        <div className="space-y-3">
          <Row icon={Bell} title="Notifications" state={data.notifications.desktop ? "On" : "Off"} on={data.notifications.desktop}>
            <div className="flex items-center justify-between gap-3">
              <span>Oathrion's window, with your agent's mascot: decide without opening the console.{data.notifications.slack ? " Also on Slack." : ""}</span>
              <Switch checked={data.notifications.desktop} onCheckedChange={(value) => void toggleDesktop(value)} aria-label="Desktop notifications" data-testid="switch-desktop-notifications" />
            </div>
          </Row>
          <Row icon={Smartphone} title="Your phone" state={data.phone?.paired ? "Paired" : "Not paired"} on={data.phone?.paired === true}>
            {data.phone?.paired ? (
              data.phone.via === "relay" ? (
                <>
                  {data.phone.kind === "web"
                    ? `Requests reach ${data.phone.account ?? "your phone"} as notifications: answer yes or no, anywhere.`
                    : `Requests reach you on Telegram (@${String(data.phone.bot)}${data.phone.account ? `, ${data.phone.account}` : ""}): answer yes or no, anywhere.`}{" "}
                  <Button size="sm" variant="outline" onClick={() => setPairing(true)} data-testid="button-manage-phone">
                    Manage
                  </Button>
                </>
              ) : (
                <>Requests reach you on Telegram (@{data.phone.bot}): answer yes or no, anywhere. <InTerminal label="Unpair" command="oathrion phone off" /></>
              )
            ) : (
              <span className="flex flex-wrap items-center justify-between gap-3">
                <span>Away from your computer, your agents' requests reach your phone: you answer yes or no. One scan, no app.</span>
                <Button size="sm" onClick={() => setPairing(true)} data-testid="button-pair-phone">
                  Pair my phone
                </Button>
              </span>
            )}
          </Row>
          <Row icon={Eye} title="Agents started without Oathrion" state={!linux ? "Linux only, for now" : data.watch.on ? "Paused, and you are asked" : "Not watched"} on={data.watch.on}>
            {!linux ? (
              <>Not on this system yet. Here, your agents' actions go through Oathrion's approvals and receipts.</>
            ) : data.watch.on ? (
              <>An AI agent started without Oathrion's protection is paused until you decide. <InTerminal label="Stop watching" command="oathrion watch --always --undo" /></>
            ) : (
              <>Like an antivirus for AI agents: an agent started without Oathrion is paused until you decide. <InTerminal label="Turn it on" command="npx oathrion" /></>
            )}
          </Row>
          <Row icon={ShieldCheck} title="Secrets out of reach" state={!linux ? "Linux only, for now" : data.jail.agents.length > 0 ? data.jail.agents.join(", ") : "Off"} on={data.jail.agents.length > 0}>
            {!linux ? (
              <>Not on this system yet: it is built on a Linux sandbox (bubblewrap).</>
            ) : data.jail.agents.length > 0 ? (
              <>Started from a terminal, these agents run in a closed space: they cannot read your passwords and keys, nor go around Oathrion. <InTerminal label="Turn it off" command="oathrion jail --always --undo" /></>
            ) : (
              <>Your agents run in a closed space where they cannot read your passwords and keys. <InTerminal label="Turn it on" command="npx oathrion" /></>
            )}
          </Row>
          <Row icon={KeyRound} title="Fake secrets (traps)" state={data.decoys.count > 0 ? `${String(data.decoys.count)} in place` : "None"} on={data.decoys.count > 0}>
            {data.decoys.count > 0 ? (
              <>Fake passwords that no honest task reads: if an agent reads one, you are told at once. <InTerminal label="Take them away" command="oathrion decoys remove" /></>
            ) : (
              <>Fake passwords that no honest task reads: if an agent reads one, you are told at once. <InTerminal label="Put them in place" command="oathrion decoys plant" /></>
            )}
          </Row>
          <Row icon={Users} title="For a team" state="Available" on={false}>
            Someone else approves, from Slack or their phone; receipts for your auditor or bank. <Link href="/team" className="text-primary underline-offset-2 hover:underline">See what it adds</Link>
          </Row>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{settings.isError ? "The settings could not be read." : "Reading…"}</p>
      )}
      <PhonePairDialog open={pairing} onClose={() => setPairing(false)} />
    </div>
  );
}
